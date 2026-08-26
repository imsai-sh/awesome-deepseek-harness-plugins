import { normalizePluginId, pluginDetailPath } from '../lib/plugin-id'
import type { Post, PostPluginRef } from './contract'

/** Where a plugin card points. The catalog lives on the main site, not here. */
const SITE_ORIGIN = 'https://deepseek1024.com'

export const FEED_PAGE_SIZE = 20
export const MAX_REPLIES_PER_THREAD = 200

interface PostRow {
  id: number
  author_login: string
  author_name: string | null
  author_avatar: string | null
  author_id: number
  body: string
  created_at: string
  like_count: number
  reply_count: number
  reply_to_id: number | null
  deleted_at: string | null
  liked: number
}

const POST_COLUMNS = `
  p.id, p.body, p.created_at, p.like_count, p.reply_count, p.reply_to_id, p.deleted_at,
  p.author_id,
  u.github_login AS author_login, u.github_name AS author_name, u.avatar_url AS author_avatar,
  CASE WHEN ?1 IS NULL THEN 0
       ELSE EXISTS (SELECT 1 FROM community_likes l WHERE l.post_id = p.id AND l.user_id = ?1)
  END AS liked`

export interface ViewerContext {
  userId: number | null
  admin: boolean
}

function toPost(row: PostRow, plugins: PostPluginRef[], viewer: ViewerContext): Post {
  const deleted = row.deleted_at !== null
  return {
    id: row.id,
    author: {
      login: row.author_login,
      name: row.author_name,
      avatarUrl: row.author_avatar,
    },
    // A deleted row keeps its author and timestamp so the thread still reads as
    // a conversation, but the text never leaves D1 again.
    body: deleted ? null : row.body,
    createdAt: row.created_at,
    likeCount: row.like_count,
    replyCount: row.reply_count,
    liked: Number(row.liked) === 1,
    plugins: deleted ? [] : plugins,
    replyToId: row.reply_to_id,
    deletable: !deleted && viewer.userId !== null &&
      (viewer.admin || viewer.userId === row.author_id),
  }
}

interface PluginRow {
  post_id: number
  position: number
  plugin_id: string
  owner: string
  repository_name: string
  stars: number | null
  curated_name: string | null
  curated_category: string | null
  ai_category: string | null
}

/**
 * Resolve every mentioned plugin for a batch of posts in one query.
 *
 * Only plugins the catalog actually publishes come back — the same predicate the
 * catalog snapshot uses (a submission, or a topic-discovered repository that
 * passed validation). A mention of something that was never in the catalog, or
 * has since been dropped from it, renders as plain text rather than as a card
 * pointing at a 404.
 */
/**
 * D1 rejects a query with more than 100 bound parameters.
 *
 * 分片是给 getThread 用的：一个帖子页要显示根帖加最多 MAX_REPLIES_PER_THREAD
 * 条评论，201 个 id 是真实需要，不是设计缺陷。
 *
 * 时间线不需要它 —— listLatest / listByAuthor 一页 FEED_PAGE_SIZE 条，
 * listHot 先排序切片再 hydrate。曾经有过一版 listHot 是先 hydrate 全部 300
 * 条候选再排序，扔掉其中 280 条，那才是让这个上限变成问题的原因。
 *
 * node:sqlite 的上限是 32766，所以这条限制在本地测试里永远不会触发。
 */
const D1_MAX_BOUND_PARAMETERS = 90

async function loadPluginRefs(
  db: D1Database,
  postIds: readonly number[],
): Promise<Map<number, PostPluginRef[]>> {
  const byPost = new Map<number, PostPluginRef[]>()
  if (postIds.length === 0) return byPost

  const chunks: number[][] = []
  for (let index = 0; index < postIds.length; index += D1_MAX_BOUND_PARAMETERS) {
    chunks.push(postIds.slice(index, index + D1_MAX_BOUND_PARAMETERS))
  }

  const pages = await Promise.all(chunks.map((chunk) => db.prepare(
    `SELECT pp.post_id, pp.position,
            cp.plugin_id, cp.curated_name, cp.curated_category, cp.ai_category,
            r.owner, r.repository_name, r.stars
       FROM community_post_plugins pp
       JOIN catalog_plugins cp ON cp.normalized_plugin_id = pp.normalized_plugin_id
       JOIN catalog_repositories r ON r.id = cp.repository_id
      WHERE pp.post_id IN (${chunk.map(() => '?').join(', ')})
        AND (cp.from_pr = 1 OR (r.from_topic = 1 AND cp.validation_status = 'accepted'))
      ORDER BY pp.post_id, pp.position`,
  ).bind(...chunk).all<PluginRow>()))

  // A plugin identity can be held by more than one catalog row while a
  // repository rename settles (0013 dropped the UNIQUE constraint), so the
  // join can repeat a chip; the first row in join order wins.
  const seen = new Set<string>()
  for (const row of pages.flatMap((page) => page.results)) {
    const identity = `${row.post_id}:${row.plugin_id.toLowerCase()}`
    if (seen.has(identity)) continue
    seen.add(identity)
    const list = byPost.get(row.post_id) ?? []
    // Curated display name first. Failing that, the in-repo subdirectory, which
    // is what distinguishes siblings in a monorepo; a repository-level plugin
    // has none, and falls back to the repository name.
    const subdirectory = row.plugin_id.split('/').slice(2).join('/')
    list.push({
      id: row.plugin_id,
      name: row.curated_name ?? (subdirectory.length > 0 ? subdirectory : row.repository_name),
      owner: row.owner,
      category: row.curated_category ?? row.ai_category,
      stars: row.stars,
      url: `${SITE_ORIGIN}${pluginDetailPath(row.plugin_id)}`,
    })
    byPost.set(row.post_id, list)
  }
  return byPost
}

async function hydrate(
  db: D1Database,
  rows: PostRow[],
  viewer: ViewerContext,
): Promise<Post[]> {
  const plugins = await loadPluginRefs(db, rows.filter((row) => row.deleted_at === null).map((row) => row.id))
  return rows.map((row) => toPost(row, plugins.get(row.id) ?? [], viewer))
}

/** `id < cursor`, so pages cannot repeat or skip a row when new posts arrive. */
function parseCursor(value: string | null | undefined): number | null {
  if (!value) return null
  const cursor = Number(value)
  return Number.isSafeInteger(cursor) && cursor > 0 ? cursor : null
}

export interface FeedPage {
  posts: Post[]
  nextCursor: string | null
}

export async function listLatest(
  db: D1Database,
  viewer: ViewerContext,
  cursor: string | null,
  pageSize = FEED_PAGE_SIZE,
): Promise<FeedPage> {
  const before = parseCursor(cursor)
  const { results } = await db.prepare(
    `SELECT ${POST_COLUMNS}
       FROM community_posts p
       JOIN api_users u ON u.id = p.author_id
      WHERE p.reply_to_id IS NULL
        AND p.deleted_at IS NULL
        AND (?2 IS NULL OR p.id < ?2)
      ORDER BY p.id DESC
      LIMIT ?3`,
  ).bind(viewer.userId, before, pageSize + 1).all<PostRow>()

  const page = results.slice(0, pageSize)
  return {
    posts: await hydrate(db, page, viewer),
    nextCursor: results.length > pageSize ? String(page[page.length - 1]!.id) : null,
  }
}

/** Posts this old stop competing, however well they did. */
const HOT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const HOT_CANDIDATES = 300

/**
 * Time-decayed engagement, ranked in the Worker rather than in SQL.
 *
 * The window is small enough that ranking a few hundred rows in memory costs
 * less than the index it would take to do it in SQL, and it keeps the formula
 * out of the schema: changing how "hot" is scored is then an edit to one
 * function, not a migration plus a new index. A reply is weighted above a like
 * because writing one costs more than tapping one.
 */
/** 排序只看这三个字段，行里就有，不必先 hydrate。 */
function rowScore(row: PostRow): Pick<Post, 'likeCount' | 'replyCount' | 'createdAt'> {
  return {
    likeCount: Number(row.like_count),
    replyCount: Number(row.reply_count),
    createdAt: row.created_at,
  }
}

export function hotScore(
  post: Pick<Post, 'likeCount' | 'replyCount' | 'createdAt'>,
  nowMs: number,
): number {
  const ageHours = Math.max(0, (nowMs - Date.parse(post.createdAt)) / 3_600_000)
  return (post.likeCount + 2 * post.replyCount + 1) / Math.pow(ageHours + 2, 1.5)
}

export async function listHot(
  db: D1Database,
  viewer: ViewerContext,
  nowMs: number,
  pageSize = FEED_PAGE_SIZE,
): Promise<FeedPage> {
  const since = new Date(nowMs - HOT_WINDOW_MS).toISOString()
  const { results } = await db.prepare(
    `SELECT ${POST_COLUMNS}
       FROM community_posts p
       JOIN api_users u ON u.id = p.author_id
      WHERE p.reply_to_id IS NULL
        AND p.deleted_at IS NULL
        AND p.created_at >= ?2
      ORDER BY p.id DESC
      LIMIT ?3`,
  ).bind(viewer.userId, since, HOT_CANDIDATES).all<PostRow>()

  // 先排序、切片，再 hydrate。排序只需要 like_count / reply_count /
  // created_at，这三个字段行里就有，不必先把插件卡片查出来。
  //
  // 反过来做（先 hydrate 全部候选再排序）意味着查 300 条帖子的插件引用、
  // 扔掉其中 280 条 —— 而且那个 IN 列表会撑到 300 个绑定参数，超过 D1
  // 单条查询 100 个的上限，只能靠分片绕过。切完再 hydrate 之后列表最多
  // pageSize 条，一条查询就够了。
  const ranked = [...results].sort((left, right) =>
    hotScore(rowScore(right), nowMs) - hotScore(rowScore(left), nowMs) || right.id - left.id)
  const posts = await hydrate(db, ranked.slice(0, pageSize), viewer)
  // Hot is a single ranked page: a cursor over a score that moves with every
  // like would hand out duplicates and gaps.
  return { posts, nextCursor: null }
}

export async function listByAuthor(
  db: D1Database,
  login: string,
  viewer: ViewerContext,
  cursor: string | null,
  pageSize = FEED_PAGE_SIZE,
): Promise<FeedPage> {
  const before = parseCursor(cursor)
  const { results } = await db.prepare(
    `SELECT ${POST_COLUMNS}
       FROM community_posts p
       JOIN api_users u ON u.id = p.author_id
      WHERE p.reply_to_id IS NULL
        AND p.deleted_at IS NULL
        AND u.github_login = ?2 COLLATE NOCASE
        AND (?3 IS NULL OR p.id < ?3)
      ORDER BY p.id DESC
      LIMIT ?4`,
  ).bind(viewer.userId, login, before, pageSize + 1).all<PostRow>()

  const page = results.slice(0, pageSize)
  return {
    posts: await hydrate(db, page, viewer),
    nextCursor: results.length > pageSize ? String(page[page.length - 1]!.id) : null,
  }
}

/**
 * A post and its replies.
 *
 * The root survives deletion as a tombstone — someone following a link deserves
 * to learn the post existed rather than meet a 404, and its replies are other
 * people's writing and stay readable. A deleted *reply* has nothing hanging off
 * it, so it goes entirely: leaving it as a tombstone would contradict the reply
 * count, which the delete already decremented.
 */
export async function getThread(
  db: D1Database,
  postId: number,
  viewer: ViewerContext,
): Promise<{ post: Post; replies: Post[] } | null> {
  const root = await db.prepare(
    `SELECT ${POST_COLUMNS}
       FROM community_posts p
       JOIN api_users u ON u.id = p.author_id
      WHERE p.id = ?2 AND p.reply_to_id IS NULL`,
  ).bind(viewer.userId, postId).first<PostRow>()
  if (!root) return null

  const { results } = await db.prepare(
    `SELECT ${POST_COLUMNS}
       FROM community_posts p
       JOIN api_users u ON u.id = p.author_id
      WHERE p.reply_to_id = ?2
        AND p.deleted_at IS NULL
      ORDER BY p.id ASC
      LIMIT ?3`,
  ).bind(viewer.userId, postId, MAX_REPLIES_PER_THREAD).all<PostRow>()

  const [post, ...replies] = await hydrate(db, [root, ...results], viewer)
  return { post: post!, replies }
}

export interface CreatePostInput {
  authorId: number
  body: string
  replyToId: number | null
  pluginIds: readonly string[]
  now: string
}

export class ParentNotFoundError extends Error {
  constructor() {
    super('The post being replied to does not exist.')
    this.name = 'ParentNotFoundError'
  }
}

export class ThreadFullError extends Error {
  constructor() {
    super('This thread has reached its reply limit.')
    this.name = 'ThreadFullError'
  }
}

/**
 * Insert a post or a reply.
 *
 * Replies are one level deep: the parent must itself be a root post. Allowing a
 * reply to a reply would turn the flat thread the UI renders into a tree it
 * cannot show, and the rows would be unreachable rather than merely ugly.
 */
export async function createPost(
  db: D1Database,
  input: CreatePostInput,
  viewer: ViewerContext,
): Promise<Post> {
  if (input.replyToId !== null) {
    const parent = await db.prepare(
      'SELECT id, reply_count FROM community_posts WHERE id = ? AND reply_to_id IS NULL AND deleted_at IS NULL',
    ).bind(input.replyToId).first<{ id: number; reply_count: number }>()
    if (!parent) throw new ParentNotFoundError()
    // getThread reads at most MAX_REPLIES_PER_THREAD, so accepting more would
    // take someone's comment, count it, and never show it to anyone.
    if (Number(parent.reply_count) >= MAX_REPLIES_PER_THREAD) throw new ThreadFullError()
  }

  const inserted = await db.prepare(
    `INSERT INTO community_posts (author_id, body, reply_to_id, created_at)
     VALUES (?, ?, ?, ?)
     RETURNING id`,
  ).bind(input.authorId, input.body, input.replyToId, input.now).first<{ id: number }>()
  if (!inserted) throw new Error('Post insert returned no row.')

  const statements: D1PreparedStatement[] = input.pluginIds.map((id, position) =>
    db.prepare(
      `INSERT OR IGNORE INTO community_post_plugins (post_id, normalized_plugin_id, position)
       VALUES (?, ?, ?)`,
    ).bind(inserted.id, normalizePluginId(id), position))

  if (input.replyToId !== null) {
    statements.push(db.prepare(
      'UPDATE community_posts SET reply_count = reply_count + 1 WHERE id = ?',
    ).bind(input.replyToId))
  }
  if (statements.length > 0) await db.batch(statements)

  const row = await db.prepare(
    `SELECT ${POST_COLUMNS}
       FROM community_posts p
       JOIN api_users u ON u.id = p.author_id
      WHERE p.id = ?2`,
  ).bind(viewer.userId, inserted.id).first<PostRow>()
  const [post] = await hydrate(db, [row!], viewer)
  return post!
}

/**
 * Soft delete. Returns false when the row is missing, already deleted, or not
 * the caller's to remove — the caller cannot tell those apart, so a probe
 * cannot enumerate which post ids exist.
 */
export async function deletePost(
  db: D1Database,
  postId: number,
  viewer: ViewerContext,
  now: string,
): Promise<boolean> {
  if (viewer.userId === null) return false
  const result = viewer.admin
    ? await db.prepare(
        'UPDATE community_posts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
      ).bind(now, postId).run()
    : await db.prepare(
        'UPDATE community_posts SET deleted_at = ? WHERE id = ? AND author_id = ? AND deleted_at IS NULL',
      ).bind(now, postId, viewer.userId).run()
  if ((result.meta.changes ?? 0) === 0) return false

  // The thread's reply count has to follow, or a deleted comment keeps
  // inflating the number shown on its parent.
  await db.prepare(
    `UPDATE community_posts
        SET reply_count = MAX(0, reply_count - 1)
      WHERE id = (SELECT reply_to_id FROM community_posts WHERE id = ?)`,
  ).bind(postId).run()
  return true
}

/**
 * Like or unlike. The composite primary key makes a repeat request a no-op, and
 * the denormalised counter only moves when a row actually appeared or vanished,
 * so a double-tap cannot drift it.
 */
export async function setLike(
  db: D1Database,
  postId: number,
  userId: number,
  liked: boolean,
  now: string,
): Promise<number | null> {
  const exists = await db.prepare(
    'SELECT id FROM community_posts WHERE id = ? AND deleted_at IS NULL',
  ).bind(postId).first<{ id: number }>()
  if (!exists) return null

  if (liked) {
    await db.prepare(
      'INSERT OR IGNORE INTO community_likes (post_id, user_id, created_at) VALUES (?, ?, ?)',
    ).bind(postId, userId, now).run()
  } else {
    await db.prepare('DELETE FROM community_likes WHERE post_id = ? AND user_id = ?')
      .bind(postId, userId).run()
  }

  // Recount rather than increment. An increment is a read the caller did not
  // take part in, so two requests that interleave can both add one for the same
  // row; deriving the value from community_likes cannot drift, because that
  // table's composite primary key is the thing being counted.
  const row = await db.prepare(
    `UPDATE community_posts
        SET like_count = (SELECT COUNT(*) FROM community_likes WHERE post_id = ?1)
      WHERE id = ?1
      RETURNING like_count`,
  ).bind(postId).first<{ like_count: number }>()
  return row ? Number(row.like_count) : null
}

export async function communityStats(db: D1Database, nowMs: number): Promise<{
  posts: number
  authors: number
  postsToday: number
}> {
  const since = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString()
  // Root posts only. Counting replies here would make the number on the rail
  // disagree with the number of entries a reader can actually count in the
  // feed, by a factor that grows with how well a thread went.
  const row = await db.prepare(
    `SELECT COUNT(*) AS posts,
            COUNT(DISTINCT author_id) AS authors,
            SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS posts_today
       FROM community_posts
      WHERE deleted_at IS NULL
        AND reply_to_id IS NULL`,
  ).bind(since).first<{ posts: number; authors: number; posts_today: number | null }>()
  return {
    posts: Number(row?.posts ?? 0),
    authors: Number(row?.authors ?? 0),
    postsToday: Number(row?.posts_today ?? 0),
  }
}
