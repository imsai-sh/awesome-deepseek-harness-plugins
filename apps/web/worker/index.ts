import { createApp } from './app'
import { edgeCacheKey, isStorable, notModifiedFor, tagged } from './lib/edge-cache'
import { communityPostMetadata } from './community/metadata'
import { cleanupExpiredAuthRows } from './lib/auth'
import { loadCatalogSnapshot, runScheduledCatalogRefresh } from './lib/catalog-store'
import { runNpmRefreshTask } from './lib/npm-refresh-task'
import { runPluginClassifyTask } from './lib/plugin-classify-task'
import { runPluginDiscoveryTask } from './lib/plugin-discovery-task'
import { isPublicApiHost, publicApiNotFound, rewritePublicApiUrl, wwwRedirect } from './public-api'
import {
  collectionQueryKind,
  detailRedirectForPath,
  metadataForPath,
  rewriteHtmlResponse,
  seoCatalog,
} from './seo'

const STATS_OBJECT_NAME = 'global'
const INCREMENTAL_DISCOVERY_CRONS = new Set(['7 * * * *', '37 * * * *'])
const FULL_DISCOVERY_CRON = '17 3 * * SUN'
const CLASSIFY_CRON = '2,12,22,32,42,52 * * * *'
const NPM_REFRESH_CRON = '*/5 * * * *'
const app = createApp()

function isWorkerRoute(pathname: string): boolean {
  return pathname === '/robots.txt' ||
    pathname === '/sitemap.xml' ||
    pathname === '/llms-full.txt' ||
    pathname === '/rankings' ||
    pathname === '/plugin' ||
    pathname.startsWith('/plugin/') ||
    pathname === '/packages' ||
    pathname.startsWith('/packages/') ||
    pathname.startsWith('/api/')
}

function canonicalTrailingSlashRedirect(url: URL): Response | null {
  if (url.pathname === '/' || !url.pathname.endsWith('/')) return null
  // This runs before isWorkerRoute, so API paths have to be excluded or a POST
  // to /api/v1/install-events/ would be answered with a redirect.
  if (url.pathname.startsWith('/api/')) return null
  if (url.pathname.startsWith('/plugin/') || url.pathname.startsWith('/packages/')) return null
  const canonical = new URL(url)
  canonical.pathname = canonical.pathname.slice(0, -1)
  return Response.redirect(canonical.toString(), 301)
}

async function handleLiveStats(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed.' }, { status: 405 })
  }
  if (request.headers.get('Upgrade')?.toLocaleLowerCase() !== 'websocket') {
    return Response.json({ error: 'Expected a WebSocket upgrade.' }, { status: 426 })
  }
  return env.LIVE_STATS.getByName(STATS_OBJECT_NAME).fetch(request)
}

function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Response | Promise<Response> {
  const url = new URL(request.url)
  const canonicalHostRedirect = wwwRedirect(url)
  if (canonicalHostRedirect) return canonicalHostRedirect
  if (isPublicApiHost(url)) {
    const rewritten = rewritePublicApiUrl(url)
    if (!rewritten) return publicApiNotFound(url.pathname)
    return app.fetch(new Request(rewritten.toString(), request), env, ctx)
  }
  if (url.pathname === '/api/live') return handleLiveStats(request, env)
  const trailingSlashRedirect = canonicalTrailingSlashRedirect(url)
  if (trailingSlashRedirect) return trailingSlashRedirect
  if (isWorkerRoute(url.pathname)) return app.fetch(request, env, ctx)

  return env.ASSETS.fetch(request).then(async (response) => {
    const isHtml = Boolean(response.headers.get('Content-Type')?.includes('text/html'))
    // Vite fingerprints everything under /assets/, so revalidating it on every
    // navigation is pure latency. Unhashed files in public/ keep the short TTL.
    // A miss under /assets/ is the SPA fallback document, not an asset:
    // marking that immutable would pin a text/html body at a hashed chunk URL
    // for a year, and content hashing can re-mint that exact filename later.
    if (url.pathname.startsWith('/assets/')) {
      if (response.status === 200 && !isHtml) {
        const headers = new Headers(response.headers)
        headers.set('Cache-Control', 'public, max-age=31536000, immutable')
        return new Response(response.body, { status: response.status, headers })
      }
      return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    }
    if (!isHtml) return response
    // A KV read, fresh or stale — the cron triggers own the rebuild, so SSR
    // metadata never starts one and never blocks on one.
    const catalog = await loadCatalogSnapshot(env, ctx)
    const seo = seoCatalog(catalog.snapshot, catalog.source === 'empty')
    // A repository-level address whose plugin now lives in a subdirectory
    // redirects to its successor rather than 404ing an indexed URL.
    const redirect = detailRedirectForPath(url.pathname, seo)
    if (redirect !== null) {
      const target = new URL(url)
      const [pathname, search = ''] = redirect.split('?')
      target.pathname = pathname!
      if (search) target.search = search
      return Response.redirect(target.toString(), 301)
    }
    const metadata = metadataForPath(url.pathname, seo)
    // A post's own title comes from D1, not from the static templates.
    const post = await communityPostMetadata(url, env).catch(() => null)
    if (post) {
      metadata.title = post.title
      metadata.description = post.description
    }
    if (collectionQueryKind(url) === 'filtered') {
      metadata.robots = 'noindex,follow'
      // A noindexed permutation pointing its canonical at the unfiltered page
      // is a conflicting pair of signals; no canonical is the cleaner one.
      metadata.canonical = null
    }
    return rewriteHtmlResponse(response, metadata)
  })
}

const worker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const cacheKey = request.method === 'GET' ? edgeCacheKey(url) : null
    if (!cacheKey) return route(request, env, ctx)

    const hit = await caches.default.match(cacheKey)
    if (hit) return notModifiedFor(request, hit) ?? tagged(hit, 'hit')

    const response = await route(request, env, ctx)
    if (isStorable(response)) ctx.waitUntil(caches.default.put(cacheKey, response.clone()))
    // Checked after the store so the cache always holds the full response, not
    // the 304 this particular caller happens to be entitled to.
    return notModifiedFor(request, response) ?? tagged(response, 'miss')
  },
  scheduled(controller, env, ctx) {
    if (controller.cron === FULL_DISCOVERY_CRON) {
      ctx.waitUntil(runPluginDiscoveryTask(env, 'full', controller.scheduledTime).then(logDiscovery))
      ctx.waitUntil(cleanupExpiredAuthRows(env.CATALOG_DB, controller.scheduledTime).catch((error) => {
        console.error(JSON.stringify({
          message: 'auth_cleanup_failed',
          error: error instanceof Error ? error.message : String(error),
        }))
      }))
      return
    }
    if (INCREMENTAL_DISCOVERY_CRONS.has(controller.cron)) {
      ctx.waitUntil(runPluginDiscoveryTask(env, undefined, controller.scheduledTime).then(logDiscovery))
      return
    }
    if (controller.cron === CLASSIFY_CRON) {
      ctx.waitUntil(runPluginClassifyTask(env, controller.scheduledTime)
        .then(logClassify)
        .catch((error) => {
          console.error(JSON.stringify({
            message: 'plugin_classify_failed',
            error: error instanceof Error ? error.message : String(error),
          }))
        }))
      return
    }
    if (controller.cron === NPM_REFRESH_CRON) {
      ctx.waitUntil(runNpmRefreshTask(env, controller.scheduledTime)
        .then(logNpmRefresh)
        .catch((error) => {
          console.error(JSON.stringify({
            message: 'npm_refresh_failed',
            error: error instanceof Error ? error.message : String(error),
          }))
        }))
      return
    }
    ctx.waitUntil(runScheduledCatalogRefresh(env, controller.scheduledTime))
  },
} satisfies ExportedHandler<Env>

export { createApp } from './app'
export { LiveStats } from './live-stats'
export default worker

function logClassify(result: Awaited<ReturnType<typeof runPluginClassifyTask>>): void {
  if (result.processed === 0 && !result.budgetExhausted) return
  console.log(JSON.stringify({ message: 'plugin_classify', ...result }))
}

function logDiscovery(result: Awaited<ReturnType<typeof runPluginDiscoveryTask>>): void {
  console.log(JSON.stringify({ message: 'plugin_discovery_completed', ...result }))
}

function logNpmRefresh(result: Awaited<ReturnType<typeof runNpmRefreshTask>>): void {
  // A tick that only saw 304s changed nothing; keep the log for the ones that did.
  if (result.found + result.absent + result.errors === 0) return
  console.log(JSON.stringify({ message: 'npm_refresh', ...result }))
}
