import type {
  CatalogPlugin,
  CatalogResponse,
  CatalogSnapshotResult,
  CatalogSort,
  CategoryResult,
  PluginsPageResponse,
  RankedPlugin,
  RankingBoards,
  RankingsResponse,
  RankingsResponseV3,
  RegistryPlugin,
  StoredCatalogSnapshot,
} from '../types'
import { normalizePluginId } from './plugin-id'

export interface CatalogQuery {
  q: string
  category: string
  sort: CatalogSort
}

export function parseCatalogQuery(query: Record<string, string>): CatalogQuery {
  const requestedSort = query.sort
  const sort: CatalogSort =
    requestedSort === 'installs' ||
    requestedSort === 'installs24h' ||
    requestedSort === 'installs7d' ||
    requestedSort === 'installs30d' ||
    requestedSort === 'npmDownloads7d' ||
    requestedSort === 'growth24h' ||
    requestedSort === 'growth7d' ||
    requestedSort === 'growth30d' ||
    requestedSort === 'newest' ||
    requestedSort === 'active' ||
    requestedSort === 'name'
      ? requestedSort
      : 'stars'
  return {
    q: (query.q ?? '').trim().slice(0, 120),
    category: (query.category ?? '').trim().slice(0, 40),
    sort,
  }
}

export function repositoryName(plugin: Pick<RegistryPlugin, 'name' | 'url'>): string {
  try {
    const segments = new URL(plugin.url).pathname.split('/').filter(Boolean)
    return (segments[1] ?? plugin.name.split('/').at(-1) ?? plugin.name).replace(/\.git$/, '')
  } catch {
    return plugin.name.split('/').at(-1) ?? plugin.name
  }
}

function categoryResults(snapshot: StoredCatalogSnapshot): CategoryResult[] {
  const counts = snapshot.plugins.reduce<Record<string, number>>((result, plugin) => {
    result[plugin.category] = (result[plugin.category] ?? 0) + 1
    return result
  }, {})

  return Object.entries(snapshot.categories)
    .map(([id, label]) => ({ id, ...label, count: counts[id] ?? 0 }))
    .filter((category) => category.count > 0)
    .sort((left, right) => right.count - left.count || left.en.localeCompare(right.en))
}

function searchableText(plugin: CatalogPlugin): string {
  return [
    plugin.name,
    plugin.owner,
    plugin.repository,
    // The id contributes the subdirectory path of a monorepo subpackage, which
    // usually carries the package name a searcher types.
    plugin.id,
    plugin.category,
    plugin.description.en,
    plugin.description.zh,
  ]
    .join(' ')
    .toLocaleLowerCase()
}

function compareNullableNumber(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return right - left
}

function compareNullableDate(left: string | null, right: string | null): number {
  if (!left && !right) return 0
  if (!left) return 1
  if (!right) return -1
  return right.localeCompare(left)
}

function publishedAt(plugin: CatalogPlugin): string {
  return plugin.latestReleaseAt ?? `${plugin.added}T00:00:00Z`
}

function growthForSort(plugin: CatalogPlugin, sort: CatalogSort): number | null {
  if (sort === 'growth24h') return plugin.growth24h
  if (sort === 'growth7d') return plugin.growth7d
  if (sort === 'growth30d') return plugin.growth30d
  return null
}

function installsForSort(plugin: CatalogPlugin, sort: CatalogSort): number | null {
  if (sort === 'installs') return plugin.installCount
  if (sort === 'installs24h') return plugin.installs24h
  if (sort === 'installs7d') return plugin.installs7d
  if (sort === 'installs30d') return plugin.installs30d
  return null
}

export function hasGrowthForSort(plugin: CatalogPlugin, sort: CatalogSort): boolean {
  return sort !== 'growth24h' && sort !== 'growth7d' && sort !== 'growth30d'
    ? true
    : growthForSort(plugin, sort) !== null
}

export function comparePlugins(
  sort: CatalogSort,
): (left: CatalogPlugin, right: CatalogPlugin) => number {
  if (sort === 'name') return (left, right) => left.name.localeCompare(right.name)
  if (
    sort === 'installs' ||
    sort === 'installs24h' ||
    sort === 'installs7d' ||
    sort === 'installs30d'
  ) {
    return (left, right) =>
      compareNullableNumber(installsForSort(left, sort), installsForSort(right, sort)) ||
      compareNullableNumber(left.installerCount, right.installerCount) ||
      compareNullableNumber(left.stars, right.stars) ||
      left.name.localeCompare(right.name)
  }
  if (sort === 'npmDownloads7d') {
    return (left, right) =>
      compareNullableNumber(left.npmDownloads7d ?? null, right.npmDownloads7d ?? null) ||
      compareNullableNumber(left.stars, right.stars) ||
      left.name.localeCompare(right.name)
  }
  if (sort === 'growth24h' || sort === 'growth7d' || sort === 'growth30d') {
    return (left, right) =>
      compareNullableNumber(growthForSort(left, sort), growthForSort(right, sort)) ||
      compareNullableNumber(left.stars, right.stars) ||
      left.name.localeCompare(right.name)
  }
  if (sort === 'newest') {
    return (left, right) =>
      publishedAt(right).localeCompare(publishedAt(left)) || left.name.localeCompare(right.name)
  }
  if (sort === 'active') {
    return (left, right) => compareNullableDate(left.pushedAt, right.pushedAt) || left.name.localeCompare(right.name)
  }
  return (left, right) => compareNullableNumber(left.stars, right.stars) || left.name.localeCompare(right.name)
}

export function filterCatalogPackages(
  plugins: CatalogPlugin[],
  query: CatalogQuery,
): CatalogPlugin[] {
  const normalizedSearch = query.q.toLocaleLowerCase()
  return plugins
    .filter((plugin) => !query.category || plugin.category === query.category)
    .filter((plugin) => !normalizedSearch || searchableText(plugin).includes(normalizedSearch))
    .filter((plugin) => hasGrowthForSort(plugin, query.sort))
    .sort(comparePlugins(query.sort))
}

const RANKING_SIZE = 100

/** `owner/repository`, lowercased — the key repository facts are grouped by. */
export function repositoryKey(plugin: Pick<CatalogPlugin, 'owner' | 'repository'>): string {
  return `${plugin.owner}/${plugin.repository}`.toLocaleLowerCase('en-US')
}

/**
 * The one field a listing never needs. `installMethods` is the heaviest thing
 * on a plugin and only the detail page renders it, so the v2 list and rankings
 * ship without it while the frozen v1 response keeps it for its consumers.
 * Undefined rather than deleted: the field is optional and `JSON.stringify`
 * omits it either way, and the generic return keeps a RankedPlugin a
 * RankedPlugin.
 */
function withoutInstallMethods<T extends CatalogPlugin>(plugin: T): T {
  return plugin.installMethods === undefined ? plugin : { ...plugin, installMethods: undefined }
}

/** A ranking row for a board whose metric already tells siblings apart. */
function ranked(plugins: CatalogPlugin[]): RankedPlugin[] {
  return plugins.slice(0, RANKING_SIZE).map((plugin) => ({ ...plugin, repositorySiblings: 0 }))
}

/**
 * One seat per repository, for boards ranked by a repository-level metric.
 *
 * Stars, forks and `pushed_at` are repository facts (`metricKey` in
 * catalog-store.ts) and the star history is keyed the same way, so every
 * plugin a monorepo publishes carries byte-identical numbers. Ranked flat, they
 * sort adjacently and the board degenerates: one 24-package repository would
 * take 24 of the 100 star seats with 24 copies of the same star count, and the
 * reader learns nothing from 23 of them.
 *
 * Collapsing is deliberately confined to those boards. The install boards rank
 * by a per-plugin counter, so a repository holding many seats there earned each
 * one, and folding them away would hide a real result.
 *
 * The whole list is walked rather than just the first hundred, so the seat that
 * survives can report how many siblings it stands for.
 */
function collapseByRepository(plugins: CatalogPlugin[]): RankedPlugin[] {
  const seats = new Map<string, RankedPlugin>()
  for (const plugin of plugins) {
    const key = repositoryKey(plugin)
    const seat = seats.get(key)
    if (seat === undefined) {
      seats.set(key, { ...plugin, repositorySiblings: 0 })
    } else {
      seat.repositorySiblings += 1
    }
  }
  return [...seats.values()].slice(0, RANKING_SIZE)
}

/** The ten leaderboards. Shared so v1 and v2 rank identically. */
function rankingBoards(plugins: CatalogPlugin[]): RankingBoards {
  // Growth comes from the repository's star history, so this collapses too.
  const growthRanking = (sort: 'growth24h' | 'growth7d' | 'growth30d') =>
    collapseByRepository(
      [...plugins].filter((plugin) => hasGrowthForSort(plugin, sort)).sort(comparePlugins(sort)),
    )

  const installRanking = (sort: 'installs' | 'installs24h' | 'installs7d' | 'installs30d') =>
    ranked([...plugins].filter((plugin) => (installsForSort(plugin, sort) ?? 0) > 0).sort(comparePlugins(sort)))

  return {
    stars: collapseByRepository([...plugins].sort(comparePlugins('stars'))),
    installs: installRanking('installs'),
    installs24h: installRanking('installs24h'),
    installs7d: installRanking('installs7d'),
    installs30d: installRanking('installs30d'),
    growth24h: growthRanking('growth24h'),
    growth7d: growthRanking('growth7d'),
    growth30d: growthRanking('growth30d'),
    // `added` falls back to the repository's updated_at and `pushedAt` is a
    // repository column, so siblings tie on both of these boards as well.
    newest: collapseByRepository([...plugins].sort(comparePlugins('newest'))),
    active: collapseByRepository([...plugins].sort(comparePlugins('active'))),
  }
}

export function buildCatalog(result: CatalogSnapshotResult, query: CatalogQuery): CatalogResponse {
  const { snapshot, source } = result
  const filtered = filterCatalogPackages(snapshot.plugins, query)

  return {
    packages: filtered,
    rankings: rankingBoards(snapshot.plugins),
    categories: categoryResults(snapshot),
    meta: {
      total: filtered.length,
      catalogTotal: snapshot.plugins.length,
      updated: snapshot.registryUpdated,
      generatedAt: snapshot.generatedAt,
      revision: snapshot.registryRevision,
      source,
      metricCoverage: snapshot.metricCoverage,
    },
  }
}

/** Clamp a requested page size to a sane band; the client asks, the server decides. */
export const DEFAULT_PAGE_LIMIT = 100
export const MAX_PAGE_LIMIT = 200

export function clampLimit(requested: number | undefined): number {
  if (!requested || !Number.isFinite(requested)) return DEFAULT_PAGE_LIMIT
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(requested)))
}

/**
 * One page of the filtered directory. The heavy field is dropped and only the
 * slice is projected, so a browse ships kilobytes where v1 ships megabytes.
 * The page is clamped into range rather than 404'd, so a stale "page 40" from a
 * catalog that just shrank lands on the last real page instead of an error.
 */
export function buildPluginsPage(
  result: CatalogSnapshotResult,
  query: CatalogQuery,
  page: number,
  limit: number,
): PluginsPageResponse {
  const { snapshot, source } = result
  const filtered = filterCatalogPackages(snapshot.plugins, query)
  const total = filtered.length
  const totalPages = Math.max(1, Math.ceil(total / limit))
  const safePage = Math.min(Math.max(1, Math.floor(page) || 1), totalPages)
  const start = (safePage - 1) * limit
  return {
    plugins: filtered.slice(start, start + limit).map(withoutInstallMethods),
    page: safePage,
    limit,
    total,
    totalPages,
    catalogTotal: snapshot.plugins.length,
    // Whole-catalog counts, not this page's — the sidebar shows the full tally.
    categories: categoryResults(snapshot),
    generatedAt: snapshot.generatedAt,
    source,
  }
}

/**
 * The leaderboards plus the sibling groups they need to expand in place.
 *
 * Only repositories that actually appear on a board carry a sibling entry, and
 * only when they published more than one plugin — a lone-plugin repository has
 * nothing to expand, so the client's lookup returning nothing for it is
 * correct. That keeps the map to the handful of monorepos on the boards rather
 * than the whole catalog.
 */
export function buildRankingsResponse(result: CatalogSnapshotResult): RankingsResponse {
  const { snapshot, source } = result
  const boards = rankingBoards(snapshot.plugins)

  const seatedRepositories = new Set<string>()
  for (const board of Object.values(boards)) {
    for (const seat of board) seatedRepositories.add(repositoryKey(seat))
  }

  const groups = new Map<string, CatalogPlugin[]>()
  for (const plugin of snapshot.plugins) {
    const key = repositoryKey(plugin)
    if (!seatedRepositories.has(key)) continue
    const group = groups.get(key)
    if (group) group.push(plugin)
    else groups.set(key, [plugin])
  }

  const siblingsByRepository: Record<string, CatalogPlugin[]> = {}
  for (const [key, group] of groups) {
    if (group.length < 2) continue
    siblingsByRepository[key] = group
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(withoutInstallMethods)
  }

  const strippedBoards = Object.fromEntries(
    Object.entries(boards).map(([board, rows]) => [board, rows.map(withoutInstallMethods)]),
  ) as RankingBoards

  return {
    rankings: strippedBoards,
    siblingsByRepository,
    catalogTotal: snapshot.plugins.length,
    categories: categoryResults(snapshot),
    generatedAt: snapshot.generatedAt,
    source,
  }
}

/**
 * v3 adds npm downloads as a separate board. Keeping this outside
 * `rankingBoards` is deliberate: v1 and v2 have a published, fixed board set.
 */
export function buildRankingsV3Response(result: CatalogSnapshotResult): RankingsResponseV3 {
  const response = buildRankingsResponse(result)
  const seenPackages = new Set<string>()
  const npmDownloads7d = ranked(
    [...result.snapshot.plugins]
      .filter((plugin) => (plugin.npmDownloads7d ?? 0) > 0)
      .sort(comparePlugins('npmDownloads7d'))
      .filter((plugin) => {
        const npmMethod = plugin.installMethods?.find((method) => (
          method.kind === 'npm' && method.verification === 'verified'
        ))
        if (!npmMethod) return false
        const packageKey = npmMethod.spec.trim().toLocaleLowerCase('en-US')
        if (!packageKey || seenPackages.has(packageKey)) return false
        seenPackages.add(packageKey)
        return true
      }),
  ).map(withoutInstallMethods)

  return {
    ...response,
    rankings: { ...response.rankings, npmDownloads7d },
  }
}

// Re-applies a catalog query on the client from one unfiltered response
// (packages must hold the complete plugin list). Rankings and categories are
// query-independent, so only packages/meta.total need recomputing; the filter
// helpers are shared with buildCatalog to keep both sides byte-identical.
export function deriveCatalogResponse(
  full: CatalogResponse,
  query: CatalogQuery,
): CatalogResponse {
  const filtered = filterCatalogPackages(full.packages, query)
  return {
    ...full,
    packages: filtered,
    meta: { ...full.meta, total: filtered.length },
  }
}

/** Generic so callers holding full catalog rows keep their metrics fields. */
export function findPlugin<T extends RegistryPlugin>(
  plugins: T[],
  owner: string,
  repository: string,
): T | undefined {
  return plugins.find(
    (plugin) =>
      plugin.owner.toLocaleLowerCase() === owner.toLocaleLowerCase() &&
      repositoryName(plugin).toLocaleLowerCase() === repository.toLocaleLowerCase(),
  )
}

/**
 * Resolves a plugin by its full id. Repository-level lookup is ambiguous once
 * one repository hosts several subpackage plugins, so anything addressing a
 * single plugin (detail page, telemetry canonicalization) resolves by id.
 */
export function findPluginById<T extends { id: string }>(plugins: T[], id: string): T | undefined {
  const wanted = normalizePluginId(id)
  return plugins.find((plugin) => normalizePluginId(plugin.id) === wanted)
}

/**
 * Plugins living under `id` — the monorepo subpackages a repository-level
 * address should lead to.
 *
 * A repository that publishes only a nested bundle used to be catalogued at its
 * repository id and is now catalogued at the subpackage's id, so previously
 * published `owner/repository` links have to find their way to the successor
 * instead of dead-ending.
 */
export function findPluginsUnder<T extends { id: string }>(plugins: T[], id: string): T[] {
  const prefix = `${normalizePluginId(id)}/`
  return plugins.filter((plugin) => normalizePluginId(plugin.id).startsWith(prefix))
}
