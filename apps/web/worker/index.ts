import { createApp } from './app'
import { LIVE_STATS_API_PATH } from './api-paths'
import { browserRevalidated, edgeCacheKey, isStorable, notModifiedFor, tagged } from './lib/edge-cache'
import { communityPostMetadata } from './community/metadata'
import { loadCatalogSnapshot } from './lib/catalog-store'
import { isPublicApiHost, publicApiNotFound, rewritePublicApiUrl, wwwRedirect } from './public-api'
import {
  collectionQueryKind,
  detailRedirectForPath,
  metadataForPath,
  rewriteHtmlResponse,
  seoCatalog,
} from './seo'

const STATS_OBJECT_NAME = 'global'
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
  if (url.pathname === LIVE_STATS_API_PATH) return handleLiveStats(request, env)
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
    // A KV read, fresh or stale — the catalog-sync endpoint owns the rebuild,
    // so SSR metadata never starts one and never blocks on one.
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
    const cacheKey = request.method === 'GET'
      ? edgeCacheKey(url, env.CF_VERSION_METADATA.id)
      : null
    if (!cacheKey) return browserRevalidated(await route(request, env, ctx))

    const hit = await caches.default.match(cacheKey)
    if (hit) return browserRevalidated(notModifiedFor(request, hit) ?? tagged(hit, 'hit'))

    const response = await route(request, env, ctx)
    if (isStorable(response)) ctx.waitUntil(caches.default.put(cacheKey, response.clone()))
    // Checked after the store so the cache always holds the full response, not
    // the 304 this particular caller happens to be entitled to.
    return browserRevalidated(notModifiedFor(request, response) ?? tagged(response, 'miss'))
  },
} satisfies ExportedHandler<Env>

export { createApp } from './app'
export { LiveStats } from './live-stats'
export default worker
