import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { registerCommunityRoutes } from './community/routes'
import { registerAuthRoutes } from './auth-api'
import {
  ANONYMOUS_QUOTA,
  AUTHENTICATED_QUOTA,
  AUTHENTICATED_REGISTRY_QUOTA,
  REGISTRY_QUOTA,
  consumeQuota,
  type QuotaDecision,
  type QuotaLimits,
} from './lib/api-quota'
import { authenticateApiKey, sha256Hex, timingSafeEqualStrings } from './lib/auth'
import {
  buildCatalog,
  buildPluginsPage,
  buildRankingsResponse,
  clampLimit,
  filterCatalogPackages,
  findPluginById,
  findPluginsUnder,
  parseCatalogQuery,
} from './lib/catalog'
import { contentEtag } from './lib/edge-cache'
import {
  isPluginId,
  normalizePluginId,
  pluginInstallCommand,
  pluginRepositoryFullName,
  PLUGIN_ID_MAX_LENGTH,
} from './lib/plugin-id'
import { syncCuratedEntries, type CuratedCatalogEntry } from './lib/catalog-db'
import { loadCatalogSnapshot, refreshCatalogSnapshot } from './lib/catalog-store'
import { categoryDescriptor, isKnownCategoryId, projectCategories } from './lib/categories'
import { fetchPackageDetail } from './lib/github'
import {
  emptyInstallMetrics,
  hashInstallationClient,
  InstallationRateLimitError,
  loadPluginInstallStats,
  parseInstallationEvent,
  recordInstallationEvent,
} from './lib/install-metrics'
import { buildLlmsFullTxt, buildRobotsTxt, buildSitemap, seoCatalog } from './seo'
import type {
  BackgroundContext,
  CatalogSnapshotResult,
  PackageDetail,
  RegistryPlugin,
  RegistryProjection,
} from './types'

interface AppDependencies {
  catalogLoader: (env: Env, ctx?: BackgroundContext) => Promise<CatalogSnapshotResult>
  detailLoader: (plugin: RegistryPlugin, token?: string) => Promise<PackageDetail>
  eventRecorder: typeof recordInstallationEvent
  installStatsLoader: typeof loadPluginInstallStats
  curatedSyncer: typeof syncCuratedEntries
  snapshotRefresher: (env: Env, fetcher?: typeof fetch, capturedAt?: number) => Promise<CatalogSnapshotResult>
  clock: () => number
  oauthFetcher: typeof fetch
}

const CACHE_HEADER = 'public, max-age=30, s-maxage=300, stale-while-revalidate=3600'
const SELF_PLUGIN_ID = 'imsai-sh/awesome-deepseek-harness-plugins'
// The catalog listing is a snapshot projection that only moves when the KV
// snapshot does; the detail endpoint carries live install counters and keeps
// the shorter TTL above.
const LIST_CACHE_HEADER = 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600'
// The registry feeds the in-app store's plugin list, so a newly listed plugin
// should reach it without waiting out a full edge TTL. Serving stale while the
// edge refreshes in the background keeps every response instant and bounds the
// staleness to one revalidation instead of an hour.
const REGISTRY_CACHE_HEADER = 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600'
// robots.txt is static, but the catalog-derived crawler documents below are
// not: without revalidation they can sit a whole day behind the catalog.
const CRAWLER_CACHE_HEADER = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400'
const DEFAULT_SEARCH_LIMIT = 20
const MAX_SEARCH_LIMIT = 100
const MAX_SEARCH_PAGE = 1_000_000
const MAX_INSTALL_EVENT_BYTES = 8 * 1024
const MAX_CATALOG_SYNC_BYTES = 2 * 1024 * 1024
const SLUG_PART = /^[A-Za-z0-9_.-]+$/
// owner/repository, optionally extended with a monorepo subdirectory path.
// isPluginId additionally rejects `.`/`..` segments (see lib/plugin-id.ts).
const ENTRY_ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/
const ENTRY_DATE = /^\d{4}-\d{2}-\d{2}$/
const ENTRY_KEYS = new Set(['id', 'name', 'repository', 'category', 'description', 'added'])

interface MeteredRequest {
  decision: QuotaDecision
  counterKey: string
}

/**
 * Shared metering for the public read endpoints (search, registry).
 *
 * Resolves the caller the same way for both: a Bearer API key grants the
 * authenticated quota keyed to the account, anything else counts as an
 * anonymous caller keyed by HMAC-hashed client IP. `namespace` separates the
 * counter keys of each endpoint (`ip:reg:` vs `ip:`), so hitting one endpoint
 * never draws down the other's quota window.
 *
 * Returns the quota decision plus the counter key that produced it; the caller
 * is responsible for applying the `X-RateLimit-*` response headers and turning
 * a rejection into a 429. Conditional (304) revalidations must not reach this
 * helper — a 304 costs almost nothing and must not consume quota.
 */
async function meterPublicRequest(
  context: { env?: Env; req: { raw: Request } },
  namespace: string,
  anonymousLimits: QuotaLimits,
  authenticatedLimits: QuotaLimits,
  clock: () => number,
): Promise<{ ok: true; metered: MeteredRequest } | { ok: false; error: 'no-db' | 'bad-key'; limits: QuotaLimits }> {
  const db = context.env?.CATALOG_DB
  if (!db) return { ok: false, error: 'no-db', limits: anonymousLimits }

  const authorization = context.req.raw.headers.get('Authorization') ?? ''
  let limits = anonymousLimits
  let counterKey: string
  if (authorization) {
    const presented = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : ''
    const keyAuth = presented
      ? await authenticateApiKey(db, presented, clock())
      : null
    if (!keyAuth) {
      return { ok: false, error: 'bad-key', limits: authenticatedLimits }
    }
    limits = authenticatedLimits
    // Keyed by account, not key id: rotating or multiplying keys must not
    // mint fresh quota windows.
    counterKey = `user:${namespace}${keyAuth.userId}`
  } else {
    // The raw client IP never reaches D1: it is keyed through the same HMAC
    // secret the install telemetry uses (plain SHA-256 as a fallback when
    // the secret is not configured, e.g. bare local dev).
    const ip = context.req.raw.headers.get('CF-Connecting-IP')?.trim() || 'unknown'
    const secret = context.env?.INSTALL_CLIENT_HASH_SECRET?.trim()
    counterKey = `ip:${namespace}${secret ? await hashInstallationClient(secret, ip) : await sha256Hex(ip)}`
  }

  const decision = await consumeQuota(db, counterKey, limits, clock())
  return { ok: true, metered: { decision, counterKey } }
}

function applyRateLimitHeaders(
  context: { header(name: string, value: string): void },
  decision: QuotaDecision,
): void {
  context.header('X-RateLimit-Daily-Limit', String(decision.dailyLimit))
  context.header('X-RateLimit-Daily-Remaining', String(decision.dailyRemaining))
  if (decision.retryAfterSeconds !== undefined) {
    context.header('Retry-After', String(decision.retryAfterSeconds))
  }
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<string | null> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  while (true) {
    const result = await reader.read()
    if (result.done) break
    total += result.value.byteLength
    if (total > maximumBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(result.value)
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

function executionContext(context: { executionCtx: BackgroundContext }): BackgroundContext | undefined {
  try {
    return context.executionCtx
  } catch {
    return undefined
  }
}

function boundedPositiveInt(value: string | undefined, fallback: number, maximum: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback
  return Math.min(parsed, maximum)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

/**
 * The entry's repository URL must be the repository root. A subdirectory id
 * carries its in-repo path in the id itself, so only the `owner/repository`
 * prefix is compared here.
 */
function isCanonicalGitHubRepositoryUrl(repositoryId: string, value: string): boolean {
  try {
    const url = new URL(value)
    const pathname = url.pathname.replace(/\/$/, '')
    return url.protocol === 'https:' &&
      url.hostname.toLocaleLowerCase('en-US') === 'github.com' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      pathname.toLocaleLowerCase('en-US')
        === `/${pluginRepositoryFullName(repositoryId).toLocaleLowerCase('en-US')}`
  } catch {
    return false
  }
}

/**
 * Reads a plugin id out of a request path: decodes each segment, validates it
 * with the same character rules as the catalog, and rejects `.`/`..`.
 * Returns null when the remainder is not a well-formed plugin id.
 */
function decodePluginIdPath(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length).replace(/\/+$/, '')
  if (rest.length === 0) return null
  let segments: string[]
  try {
    segments = rest.split('/').map(decodeURIComponent)
  } catch {
    return null
  }
  if (segments.some((segment) => !SLUG_PART.test(segment))) return null
  const id = segments.join('/')
  return isPluginId(id) ? id : null
}

/**
 * Redirects a legacy detail path to its `/plugins/...` equivalent, preserving
 * every path segment so monorepo subdirectory URLs keep working. The pathname
 * is already percent-encoded, so it is sliced rather than re-encoded.
 */
function legacyDetailRedirect(prefix: string) {
  return (context: { req: { url: string }; redirect: (url: string, status: 301) => Response }) => {
    const canonicalUrl = new URL(context.req.url)
    const rest = canonicalUrl.pathname.slice(prefix.length).replace(/\/+$/, '')
    canonicalUrl.pathname = rest.length === 0 ? '/plugins' : `/plugins${rest}`
    return context.redirect(canonicalUrl.toString(), 301)
  }
}

type CatalogSyncParseResult =
  | { ok: true; entries: CuratedCatalogEntry[] }
  | { ok: false; error: string }

function parseCuratedEntry(value: unknown, index: number): CuratedCatalogEntry | string {
  if (!isObject(value)) return `Entry ${index} must be a JSON object.`
  const unexpected = Object.keys(value).find((key) => !ENTRY_KEYS.has(key))
  if (unexpected) return `Entry ${index} has an unexpected field: ${unexpected}.`
  if (!boundedString(value.id, PLUGIN_ID_MAX_LENGTH) || !ENTRY_ID.test(value.id) || !isPluginId(value.id)) {
    return `Entry ${index} has an invalid id.`
  }
  if (!boundedString(value.name, 200)) return `Entry ${index} has an invalid name.`
  if (!boundedString(value.repository, 300) ||
    !isCanonicalGitHubRepositoryUrl(value.id, value.repository)) {
    return `Entry ${index} has an invalid repository URL.`
  }
  if (!boundedString(value.category, 40) || !isKnownCategoryId(value.category)) {
    return `Entry ${index} has an unknown category.`
  }
  const description = value.description
  if (!isObject(description) || !boundedString(description.en, 2000) || !boundedString(description.zh, 2000)) {
    return `Entry ${index} has an invalid description.`
  }
  if (!boundedString(value.added, 10) || !ENTRY_DATE.test(value.added)) {
    return `Entry ${index} has an invalid added date.`
  }
  return {
    id: value.id,
    name: value.name,
    repository: value.repository,
    category: value.category,
    description: { en: description.en, zh: description.zh },
    added: value.added,
  }
}

function parseCatalogSyncRequest(value: unknown): CatalogSyncParseResult {
  if (!isObject(value)) return { ok: false, error: 'Request body must be a JSON object.' }
  if (value.source !== 'github_ci') return { ok: false, error: 'Invalid source.' }
  const unexpected = Object.keys(value).find((key) => key !== 'source' && key !== 'entries')
  if (unexpected) return { ok: false, error: `Unexpected field: ${unexpected}.` }
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    return { ok: false, error: 'entries must be a non-empty array.' }
  }
  const entries: CuratedCatalogEntry[] = []
  const seen = new Set<string>()
  for (const [index, item] of value.entries.entries()) {
    const parsed = parseCuratedEntry(item, index)
    if (typeof parsed === 'string') return { ok: false, error: parsed }
    const normalizedId = parsed.id.toLocaleLowerCase('en-US')
    if (seen.has(normalizedId)) return { ok: false, error: `Entry ${index} duplicates id ${parsed.id}.` }
    seen.add(normalizedId)
    entries.push(parsed)
  }
  return { ok: true, entries }
}

export function createApp(overrides: Partial<AppDependencies> = {}) {
  const dependencies: AppDependencies = {
    catalogLoader: loadCatalogSnapshot,
    detailLoader: fetchPackageDetail,
    eventRecorder: recordInstallationEvent,
    installStatsLoader: loadPluginInstallStats,
    curatedSyncer: syncCuratedEntries,
    snapshotRefresher: refreshCatalogSnapshot,
    clock: Date.now,
    oauthFetcher: (input, init) => fetch(input, init),
    ...overrides,
  }
  const app = new Hono<{ Bindings: Env }>()

  app.use('*', secureHeaders())
  app.use('/api/*', cors({
    origin: '*',
    allowMethods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  }))

  app.get('/robots.txt', (context) => {
    context.header('Cache-Control', 'public, max-age=3600, s-maxage=86400')
    return context.text(buildRobotsTxt())
  })

  app.get('/sitemap.xml', async (context) => {
    const result = await dependencies.catalogLoader(
      context.env,
      executionContext(context),
    )
    if (result.source === 'empty') {
      // Publishing a 3-URL sitemap during an outage would tell crawlers the
      // catalog shrank by 2,900 pages, and the edge would cache that for a day.
      context.header('Cache-Control', 'no-store')
      return context.text('Catalog temporarily unavailable.', 503)
    }
    context.header('Cache-Control', CRAWLER_CACHE_HEADER)
    context.header('Content-Type', 'application/xml; charset=UTF-8')
    return context.body(buildSitemap(seoCatalog(result.snapshot)))
  })

  app.get('/llms-full.txt', async (context) => {
    const result = await dependencies.catalogLoader(
      context.env,
      executionContext(context),
    )
    if (result.source === 'empty') {
      context.header('Cache-Control', 'no-store')
      return context.text('Catalog temporarily unavailable.', 503)
    }
    context.header('Cache-Control', CRAWLER_CACHE_HEADER)
    context.header('Content-Type', 'text/plain; charset=UTF-8')
    return context.body(buildLlmsFullTxt(seoCatalog(result.snapshot)))
  })

  app.get('/rankings', (context) => {
    // Nothing links to /rankings and it renders the same view as `/`; a 301
    // keeps the duplicate out of the index instead of relying on a canonical.
    const canonicalUrl = new URL(context.req.url)
    canonicalUrl.pathname = '/'
    return context.redirect(canonicalUrl.toString(), 301)
  })

  app.get('/plugin', (context) => {
    const canonicalUrl = new URL(context.req.url)
    canonicalUrl.pathname = '/plugins'
    return context.redirect(canonicalUrl.toString(), 301)
  })

  app.get('/plugin/', (context) => {
    const canonicalUrl = new URL(context.req.url)
    canonicalUrl.pathname = '/plugins'
    return context.redirect(canonicalUrl.toString(), 301)
  })

  // Wildcards, so a monorepo subdirectory path survives the redirect. The
  // already-encoded pathname is sliced rather than decoded and re-encoded.
  app.get('/plugin/*', legacyDetailRedirect('/plugin'))

  app.get('/packages', (context) => {
    const canonicalUrl = new URL(context.req.url)
    canonicalUrl.pathname = '/plugins'
    return context.redirect(canonicalUrl.toString(), 301)
  })

  app.get('/packages/', (context) => {
    const canonicalUrl = new URL(context.req.url)
    canonicalUrl.pathname = '/plugins'
    return context.redirect(canonicalUrl.toString(), 301)
  })

  app.get('/packages/*', legacyDetailRedirect('/packages'))

  app.get('/api/v1/health', (context) => context.json({ status: 'ok' }))

  app.get('/api/v1/plugins', async (context) => {
    const snapshot = await dependencies.catalogLoader(
      context.env,
      executionContext(context),
    )
    const query = parseCatalogQuery(context.req.query())
    const payload = JSON.stringify(buildCatalog(snapshot, query))
    context.header('Cache-Control', LIST_CACHE_HEADER)
    // Validator over the actual bytes, so a caller polling for changes is told
    // 304 only when the body it holds is genuinely the body we would send — a
    // field-set change across a deploy moves the tag, unlike a snapshot-keyed one.
    context.header('ETag', contentEtag(payload))
    context.header('X-Catalog-Source', snapshot.source)
    // Crawlable so the SPA can be rendered, but the JSON itself must never be
    // indexed as a page in its own right.
    context.header('X-Robots-Tag', 'noindex')
    context.header('Content-Type', 'application/json; charset=UTF-8')
    return context.body(payload)
  })

  app.get('/api/v1/plugins/search', async (context) => {
    context.header('Cache-Control', 'no-store')
    if (!context.env?.CATALOG_DB) {
      return context.json({ error: 'Search is temporarily unavailable.', code: 'SERVICE_UNAVAILABLE' }, 503)
    }

    const q = (context.req.query('q') ?? '').trim().slice(0, 120)
    if (!q) {
      return context.json({ error: 'Missing required query parameter "q".', code: 'MISSING_QUERY' }, 400)
    }
    const category = (context.req.query('category') ?? '').trim().slice(0, 40)
    if (category && !isKnownCategoryId(category)) {
      return context.json({ error: `Unknown category "${category}".`, code: 'INVALID_CATEGORY' }, 400)
    }
    const requestedSort = context.req.query('sortBy') ?? ''
    const sort = parseCatalogQuery({ sort: requestedSort === 'recent' ? 'newest' : requestedSort }).sort
    const page = boundedPositiveInt(context.req.query('page'), 1, MAX_SEARCH_PAGE)
    const limit = boundedPositiveInt(context.req.query('limit'), DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)

    const metered = await meterPublicRequest(
      context,
      '',
      ANONYMOUS_QUOTA,
      AUTHENTICATED_QUOTA,
      dependencies.clock,
    )
    if (!metered.ok) {
      if (metered.error === 'bad-key') {
        return context.json({ error: 'Invalid API key.', code: 'INVALID_API_KEY' }, 401)
      }
      return context.json({ error: 'Search is temporarily unavailable.', code: 'SERVICE_UNAVAILABLE' }, 503)
    }
    const { decision } = metered.metered
    applyRateLimitHeaders(context, decision)
    if (!decision.allowed) {
      if (decision.reason === 'day') {
        return context.json({ error: 'Daily API quota exceeded.', code: 'DAILY_QUOTA_EXCEEDED' }, 429)
      }
      return context.json({ error: 'Too many requests.', code: 'RATE_LIMITED' }, 429)
    }

    const snapshotResult = await dependencies.catalogLoader(
      context.env,
      executionContext(context),
    )
    const filtered = filterCatalogPackages(snapshotResult.snapshot.plugins, { q, category, sort })
    const total = filtered.length
    const start = (page - 1) * limit
    const results = filtered.slice(start, start + limit).map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      owner: plugin.owner,
      url: plugin.url,
      category: plugin.category,
      description: plugin.description,
      stars: plugin.stars,
      installCount: plugin.installCount ?? 0,
      growth24h: plugin.growth24h,
      added: plugin.added,
      pushedAt: plugin.pushedAt,
      install: plugin.install,
    }))
    context.header('X-Catalog-Source', snapshotResult.source)
    context.header('X-Robots-Tag', 'noindex')
    return context.json({
      query: q,
      page,
      limit,
      sortBy: sort,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      results,
    })
  })

  // Wildcard: Hono route params never span '/', but a monorepo plugin id does
  // (owner/repository/packages/foo). Every segment is validated individually.
  app.get('/api/v1/plugins/:owner/*', async (context) => {
    const requestedId = decodePluginIdPath(
      new URL(context.req.url).pathname,
      '/api/v1/plugins/',
    )
    if (requestedId === null) {
      return context.json({ error: 'Invalid package identifier.' }, 400)
    }

    const snapshot = await dependencies.catalogLoader(
      context.env,
      executionContext(context),
    )
    const plugin = findPluginById(snapshot.snapshot.plugins, requestedId)
    if (!plugin) {
      context.header('X-Catalog-Source', snapshot.source)
      if (snapshot.source === 'empty') {
        // Without this the client cannot tell an outage from a deleted plugin,
        // and would noindex every real page for the duration of the outage.
        context.header('Cache-Control', 'no-store')
        return context.json(
          { error: 'The package catalog is temporarily unavailable.', code: 'CATALOG_UNAVAILABLE' },
          503,
        )
      }
      // A repository-level id whose only plugin moved into a subdirectory
      // redirects, so existing API consumers follow the rename instead of
      // seeing the plugin disappear. Several successors stay a 404: the
      // request named a repository, not a plugin.
      const successors = findPluginsUnder(snapshot.snapshot.plugins, requestedId)
      if (successors.length === 1) {
        const canonical = new URL(context.req.url)
        canonical.pathname = `/api/v1/plugins/${successors[0]!.id.split('/').map(encodeURIComponent).join('/')}`
        return context.redirect(canonical.toString(), 301)
      }
      return context.json({ error: 'Package not found.', code: 'NOT_FOUND' }, 404)
    }

    const token = context.env?.GITHUB_TOKEN?.trim() || undefined
    const canonicalPluginId = plugin.id
    const [detail, installMetrics] = await Promise.all([
      dependencies.detailLoader(plugin, token),
      context.env?.CATALOG_DB
        ? dependencies.installStatsLoader(
            context.env.CATALOG_DB,
            canonicalPluginId,
            dependencies.clock(),
          ).catch((error) => {
            console.error(JSON.stringify({
              message: 'package_install_metrics_failed',
              pluginId: canonicalPluginId,
              error: error instanceof Error ? error.message : String(error),
            }))
            return emptyInstallMetrics()
          })
        : Promise.resolve(emptyInstallMetrics()),
    ])
    context.header('Cache-Control', CACHE_HEADER)
    context.header('X-Catalog-Source', snapshot.source)
    context.header('X-Robots-Tag', 'noindex')
    return context.json({
      ...detail,
      ...installMetrics,
      category: categoryDescriptor(plugin.category),
    })
  })

  app.get('/api/v1/self/install-stats', async (context) => {
    const db = context.env?.CATALOG_DB
    const metrics = db
      ? await dependencies.installStatsLoader(db, SELF_PLUGIN_ID, dependencies.clock())
      : emptyInstallMetrics()
    context.header('Cache-Control', CACHE_HEADER)
    context.header('X-Robots-Tag', 'noindex')
    return context.json(metrics)
  })

  app.get('/api/v1/registry', async (context) => {
    const result = await dependencies.catalogLoader(
      context.env,
      executionContext(context),
    )
    const { snapshot } = result
    const registry: RegistryProjection = {
      name: 'dsh-1024store-catalog',
      updated: snapshot.generatedAt,
      count: snapshot.plugins.length,
      categories: projectCategories(snapshot.categories),
      plugins: snapshot.plugins.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        owner: plugin.owner,
        url: plugin.url,
        category: plugin.category,
        description: plugin.description,
        install: pluginInstallCommand(plugin.id),
        added: plugin.added,
        stars: plugin.stars,
      })),
    }
    const payload = JSON.stringify(registry)
    const etag = contentEtag(payload)
    context.header('Cache-Control', REGISTRY_CACHE_HEADER)
    context.header('ETag', etag)
    context.header('X-Catalog-Source', result.source)
    context.header('X-Robots-Tag', 'noindex')
    context.header('Content-Type', 'application/json; charset=UTF-8')

    // A 304 costs a snapshot read and a few header bytes, so a client polling
    // with If-None-Match is answered before metering — it must not draw down
    // the quota, or correct cache use would be punished and the quota would
    // measure "how often asked" instead of "how much data shipped".
    const ifNoneMatch = context.req.header('If-None-Match')
    if (ifNoneMatch && ifNoneMatch.trim().split(',').some((candidate) => candidate.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''))) {
      return new Response(null, { status: 304, headers: {
        'ETag': etag,
        'Cache-Control': REGISTRY_CACHE_HEADER,
        'X-Catalog-Source': result.source,
      } })
    }

    // HEAD is a zero-body probe for "has anything changed?"; like 304 it must
    // not consume quota. Hono runs GET handlers for HEAD and strips the body,
    // so this returns the same headers a GET would without the payload.
    if (context.req.method === 'HEAD') {
      return new Response(null, { status: 200, headers: {
        'ETag': etag,
        'Cache-Control': REGISTRY_CACHE_HEADER,
        'X-Catalog-Source': result.source,
      } })
    }

    // Metering mirrors the search endpoint exactly: it lives on the handler, not
    // on the host check, so the main-domain path (deepseek1024.com/api/v1/registry)
    // draws down the same counters as the public developer host
    // (api.deepseek1024.com/v1/registry). The two endpoints keep their own
    // namespaced counters, but neither host escapes the quota.
    const metered = await meterPublicRequest(
      context,
      'reg:',
      REGISTRY_QUOTA,
      AUTHENTICATED_REGISTRY_QUOTA,
      dependencies.clock,
    )
    if (!metered.ok) {
      if (metered.error === 'bad-key') {
        return context.json({ error: 'Invalid API key.', code: 'INVALID_API_KEY' }, 401)
      }
      return context.json({ error: 'The registry is temporarily unavailable.', code: 'SERVICE_UNAVAILABLE' }, 503)
    }
    const { decision } = metered.metered
    applyRateLimitHeaders(context, decision)
    if (!decision.allowed) {
      if (decision.reason === 'day') {
        return context.json({ error: 'Daily API quota exceeded.', code: 'DAILY_QUOTA_EXCEEDED' }, 429)
      }
      return context.json({ error: 'Too many requests.', code: 'RATE_LIMITED' }, 429)
    }

    return context.body(payload)
  })

  // The site's own catalog API. Unlike the frozen `/api/v1/plugins`, which
  // returns the whole catalog for external consumers, v2 paginates so a browse
  // ships one page. Both read the same KV snapshot; neither touches D1 on the
  // read path. ETags are derived from the body (see edge-cache), so a caller
  // polling for changes is answered 304 only when its bytes still match.
  app.get('/api/v2/plugins', async (context) => {
    const snapshot = await dependencies.catalogLoader(
      context.env,
      executionContext(context),
    )
    const query = parseCatalogQuery(context.req.query())
    const page = boundedPositiveInt(context.req.query('page'), 1, MAX_SEARCH_PAGE)
    const limit = clampLimit(Number(context.req.query('limit')) || undefined)
    const payload = JSON.stringify(buildPluginsPage(snapshot, query, page, limit))
    context.header('Cache-Control', LIST_CACHE_HEADER)
    context.header('ETag', contentEtag(payload))
    context.header('X-Catalog-Source', snapshot.source)
    context.header('X-Robots-Tag', 'noindex')
    context.header('Content-Type', 'application/json; charset=UTF-8')
    return context.body(payload)
  })

  app.get('/api/v2/rankings', async (context) => {
    const snapshot = await dependencies.catalogLoader(
      context.env,
      executionContext(context),
    )
    const payload = JSON.stringify(buildRankingsResponse(snapshot))
    context.header('Cache-Control', LIST_CACHE_HEADER)
    context.header('ETag', contentEtag(payload))
    context.header('X-Catalog-Source', snapshot.source)
    context.header('X-Robots-Tag', 'noindex')
    context.header('Content-Type', 'application/json; charset=UTF-8')
    return context.body(payload)
  })

  app.post('/api/v1/catalog/sync', async (context) => {
    const configuredToken = context.env?.CATALOG_SYNC_TOKEN?.trim()
    if (!configuredToken || configuredToken.length < 32 || !context.env?.CATALOG_DB) {
      return context.json({ error: 'Catalog sync is not configured.' }, 503)
    }

    const authorization = context.req.header('Authorization') ?? ''
    const presentedToken = authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : ''
    if (!timingSafeEqualStrings(configuredToken, presentedToken)) {
      return context.json({ error: 'Invalid catalog sync token.' }, 401)
    }

    const contentType = context.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLocaleLowerCase()
    if (contentType !== 'application/json') {
      return context.json({ error: 'Content-Type must be application/json.' }, 415)
    }
    const rawBody = await readBoundedBody(context.req.raw, MAX_CATALOG_SYNC_BYTES)
    if (rawBody === null) {
      return context.json({ error: 'Request body is too large.' }, 413)
    }
    let value: unknown
    try {
      value = JSON.parse(rawBody)
    } catch {
      return context.json({ error: 'Request body must be valid JSON.' }, 400)
    }
    const parsed = parseCatalogSyncRequest(value)
    if (!parsed.ok) return context.json({ error: parsed.error }, 400)

    const capturedAt = dependencies.clock()
    const result = await dependencies.curatedSyncer(
      context.env.CATALOG_DB,
      parsed.entries,
      new Date(capturedAt).toISOString(),
    )
    await dependencies.snapshotRefresher(context.env, fetch, capturedAt)
    return context.json({
      ok: true,
      total: result.total,
      removedSources: result.removedSources,
    })
  })

  app.post('/api/v1/install-events', async (context) => {
    const contentType = context.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLocaleLowerCase()
    if (contentType !== 'application/json') {
      return context.json({ error: 'Content-Type must be application/json.' }, 415)
    }

    const declaredLength = context.req.header('Content-Length')
    if (declaredLength) {
      if (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_INSTALL_EVENT_BYTES) {
        return context.json({ error: 'Request body is too large.' }, 413)
      }
    }

    const rawBody = await readBoundedBody(context.req.raw, MAX_INSTALL_EVENT_BYTES)
    if (rawBody === null) {
      return context.json({ error: 'Request body is too large.' }, 413)
    }

    let value: unknown
    try {
      value = JSON.parse(rawBody)
    } catch {
      return context.json({ error: 'Request body must be valid JSON.' }, 400)
    }
    const parsed = parseInstallationEvent(value)
    if (!parsed.ok) return context.json({ error: parsed.error }, 400)

    const secret = context.env?.INSTALL_CLIENT_HASH_SECRET?.trim()
    if (!secret || secret.length < 32 || !context.env?.CATALOG_DB) {
      return context.json({ error: 'Installation telemetry is temporarily unavailable.' }, 503)
    }

    // Any well-formed event is recorded; the stored plugin id is lowercased in
    // both branches so aggregates recorded before a plugin enters the catalog
    // merge with post-catalog events regardless of the repository's GitHub
    // casing (reads also compare COLLATE NOCASE in install-metrics.ts).
    // Matched against full catalog ids, so a subdirectory plugin's installs are
    // never folded onto its repository or a sibling subpackage.
    const catalog = await dependencies.catalogLoader(
      context.env,
      executionContext(context),
    )
    const plugin = findPluginById(catalog.snapshot.plugins, parsed.event.pluginId)
    const canonicalPluginId = normalizePluginId(plugin?.id ?? parsed.event.pluginId)

    try {
      const recorded = await dependencies.eventRecorder(
        context.env.CATALOG_DB,
        secret,
        parsed.event,
        canonicalPluginId,
        dependencies.clock(),
      )
      return context.json({
        accepted: true,
        duplicate: recorded.duplicate,
        eventId: recorded.eventId,
        pluginId: recorded.pluginId,
        serverReceivedAt: recorded.serverReceivedAt,
      }, recorded.duplicate ? 200 : 202)
    } catch (error) {
      if (error instanceof InstallationRateLimitError) {
        context.header('Retry-After', String(error.retryAfterSeconds))
        return context.json({ error: 'Too many installation events.' }, 429)
      }
      throw error
    }
  })

  registerAuthRoutes(app, {
    clock: dependencies.clock,
    oauthFetcher: dependencies.oauthFetcher,
  })

  // The community front-end lives in apps/community, but its API is part of
  // this Worker on this hostname: same session cookie, same D1, no cross-origin
  // handoff to arrange. See apps/community/README.md.
  registerCommunityRoutes(app, { clock: dependencies.clock })

  app.notFound((context) => context.json({ error: 'API route not found.' }, 404))
  app.onError((error, context) => {
    console.error(
      JSON.stringify({
        message: 'request_failed',
        path: context.req.path,
        error: error.message,
      }),
    )
    return context.json({ error: 'The package catalog is temporarily unavailable.', code: 'INTERNAL_ERROR' }, 500)
  })

  return app
}
