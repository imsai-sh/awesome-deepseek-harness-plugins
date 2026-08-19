import { isPublicApiHost, rewritePublicApiUrl } from '../public-api'

// The only `/api/` paths a POP may answer from its own cache, each mapped to
// the query parameters that actually shape its body. An allowlist rather than a
// denylist: `/api/live` is a WebSocket, the community and auth routes are
// per-user, and search is deliberately `no-store` — none may ever be served to
// the wrong caller because a path was forgotten here. The parameter lists also
// harden the key: anything not listed is dropped, so `?utm=…` or a cache-buster
// cannot fragment the cache into a cold miss per request.
const CACHEABLE_API_PATHS: Record<string, readonly string[]> = {
  '/api/v1/plugins': ['q', 'category', 'sort'],
  '/api/v1/registry': [],
  '/api/v2/plugins': ['q', 'category', 'sort', 'page', 'limit'],
  '/api/v2/rankings': [],
}

export function edgeCacheablePath(pathname: string): boolean {
  if (pathname.startsWith('/api/')) return Object.prototype.hasOwnProperty.call(CACHEABLE_API_PATHS, pathname)
  // Hashed bundles are already immutable to the browser, and a miss here is the
  // SPA fallback document rather than an asset.
  if (pathname.startsWith('/assets/')) return false
  return true
}

/**
 * A POP-local cache in front of the Worker.
 *
 * A Worker's response to the eyeball is not cached by Cloudflare on its own —
 * `Cache-Control: s-maxage` on the way out is a statement about the response,
 * not an instruction anyone executes, and a Cache Rule in the dashboard cannot
 * step in either because `run_worker_first` puts this Worker ahead of the cache.
 * So the entire catalog was being read out of KV and re-serialized once per
 * request. Filling `caches.default` explicitly collapses that to once per POP
 * per `s-maxage`.
 *
 * The key is the request URL. Every cacheable response here is a function of
 * the URL alone: the catalog endpoints take no credentials, and the HTML is the
 * SPA shell with SEO metadata rewritten into it — sign-in state arrives later
 * from `/api/v1/auth/me`, so no cookie can change what is stored.
 */
export function edgeCacheKey(url: URL): Request | null {
  const pathname = isPublicApiHost(url) ? rewritePublicApiUrl(url)?.pathname : url.pathname
  if (pathname === undefined || !edgeCacheablePath(pathname)) return null
  const significant = pathname.startsWith('/api/') ? CACHEABLE_API_PATHS[pathname] : undefined
  if (!significant) {
    // HTML routes: the whole URL matters — a filtered permutation carries
    // different SEO metadata (noindex, canonical) than the bare page.
    return new Request(url.toString(), { method: 'GET' })
  }
  // Keep only the params that change the body, in a fixed order, so equivalent
  // requests share one cached entry regardless of extra or reordered params.
  const canonical = new URL(url.origin + pathname)
  for (const name of [...significant].sort()) {
    const value = url.searchParams.get(name)
    if (value !== null && value !== '') canonical.searchParams.set(name, value)
  }
  return new Request(canonical.toString(), { method: 'GET' })
}

// A redirect, a 404 or anything carrying a cookie stays out; `cache.put` honours
// the response's own Cache-Control for how long the copy lives.
export function isStorable(response: Response): boolean {
  return response.status === 200 && !response.headers.has('Set-Cookie')
}

/** Makes hit rate observable without reaching for analytics. */
export function tagged(response: Response, state: 'hit' | 'miss'): Response {
  const headers = new Headers(response.headers)
  headers.set('X-Edge-Cache', state)
  return new Response(response.body, { status: response.status, headers })
}

/**
 * A catalog response is fully identified by the snapshot it was built from and
 * the query that shaped it, so its validator can be assembled from those rather
 * than by hashing a megabyte of JSON on every request.
 *
 * Weak, because `Content-Encoding` may differ between two responses carrying
 * the same bytes — a weak validator is exactly what a `304` needs.
 */
/**
 * A validator for the actual bytes of a response, the way RFC 9110 means an
 * ETag: hash the serialized body, so any change to it — a restored field, a
 * different page — moves the tag, and a `304` is only ever sent when the caller
 * genuinely holds the current bytes. The v2 endpoints use this; hashing happens
 * once on a cache miss, and the tag then rides the stored response.
 */
export function contentEtag(body: string): string {
  return weakEtag([body])
}

export function weakEtag(parts: readonly string[]): string {
  // FNV-1a over the joined parts. Not a security boundary: this only has to
  // change whenever any part changes.
  let hash = 0x811c9dc5
  const joined = parts.join('\u0000')
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `W/"${hash.toString(16)}-${joined.length.toString(16)}"`
}

function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false
  if (ifNoneMatch.trim() === '*') return true
  const normalize = (value: string) => value.trim().replace(/^W\//, '')
  const wanted = normalize(etag)
  return ifNoneMatch.split(',').some((candidate) => normalize(candidate) === wanted)
}

/**
 * Answers a conditional request with `304` when the validator still holds.
 *
 * A client polling the catalog otherwise re-downloads about a megabyte to
 * learn that nothing changed. The snapshot only moves when a cron rebuilds it,
 * so most of those polls can be a few bytes of headers instead. Runs after the
 * cache lookup so a cached copy can satisfy the condition too.
 */
export function notModifiedFor(request: Request, response: Response): Response | null {
  const etag = response.headers.get('ETag')
  if (!etag || !matchesEtag(request.headers.get('If-None-Match'), etag)) return null
  const headers = new Headers()
  for (const name of ['ETag', 'Cache-Control', 'X-Catalog-Source', 'X-Robots-Tag', 'Vary']) {
    const value = response.headers.get(name)
    if (value) headers.set(name, value)
  }
  return new Response(null, { status: 304, headers })
}

