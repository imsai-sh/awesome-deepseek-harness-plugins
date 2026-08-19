/**
 * npm side of install verification.
 *
 * The catalog only recommends an npm package when it can be tied back to the
 * plugin's own source. A name that merely exists on the registry is not
 * evidence — anyone can publish `dsh-foo` — so the binding is checked against
 * the package's own `repository` field, which is the only claim the publisher
 * makes about where the code came from.
 */

import { classifyNpmBinding, type NpmBinding } from './install-methods'

const REGISTRY_ORIGIN = 'https://registry.npmjs.org'
const REQUEST_TIMEOUT_MS = 10_000
const USER_AGENT = 'dsh-1024store-catalog-verification (+https://deepseek1024.com)'

export interface NpmProbeResult {
  // `not_modified` is the conditional-request answer: the package has not
  // published since `etag`, so version and binding are unchanged and the caller
  // writes nothing at all.
  status: 'found' | 'absent' | 'error' | 'not_modified'
  httpStatus: number | null
  version: string | null
  repositoryUrl: string | null
  repositoryDirectory: string | null
  bundleDeclared: boolean
  entryPoint: string | null
  tarballUrl: string | null
  integrity: string | null
  binding: NpmBinding
  // The validator to send as `If-None-Match` next time. Present on `found` and
  // carried through on `not_modified`; null on `absent`/`error`.
  etag: string | null
}

function unresolved(status: 'absent' | 'error', httpStatus: number | null): NpmProbeResult {
  return {
    status,
    httpStatus,
    version: null,
    repositoryUrl: null,
    repositoryDirectory: null,
    bundleDeclared: false,
    entryPoint: null,
    tarballUrl: null,
    integrity: null,
    // 'absent' is a fact (nobody published it); 'error' is ignorance, and the
    // caller must not overwrite a good binding with it.
    binding: status === 'absent' ? 'absent' : 'unknown',
    etag: null,
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Reads a package's latest published manifest, conditionally.
 *
 * The request targets the packument root `/<name>` rather than `/<name>/latest`:
 * `/latest` is a computed sub-document with no ETag, so it can never be answered
 * `304` and every poll pays for the full body. The root carries an ETag, so
 * passing the previous one as `If-None-Match` means npm returns `304` with an
 * empty body whenever nothing has published — which is almost always. The
 * abbreviated media type would be smaller still, but it drops `repository` from
 * each version, and `repository` is the whole basis of the binding check, so we
 * take the full packument and pay its (rare) 200 body. Scoped names must keep
 * their slash encoded.
 *
 * @param id - the plugin id the package claims to belong to.
 * @param packageName - the name declared by the plugin's own manifest.
 * @param etag - the validator from the previous probe, or null to fetch fresh.
 */
export async function probeNpmPackage(
  id: string,
  packageName: string,
  etag: string | null = null,
  fetcher: typeof fetch = fetch,
): Promise<NpmProbeResult> {
  const encoded = packageName.startsWith('@')
    ? `@${encodeURIComponent(packageName.slice(1)).replace('%2F', '/')}`.replace('/', '%2f')
    : encodeURIComponent(packageName)
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  }
  if (etag) headers['If-None-Match'] = etag

  let response: Response
  try {
    response = await fetcher(`${REGISTRY_ORIGIN}/${encoded}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    return unresolved('error', null)
  }

  if (response.status === 304) {
    return {
      status: 'not_modified',
      httpStatus: 304,
      version: null,
      repositoryUrl: null,
      repositoryDirectory: null,
      bundleDeclared: false,
      entryPoint: null,
      tarballUrl: null,
      integrity: null,
      binding: 'unknown',
      // A 304 still carries the ETag; fall back to the one we sent.
      etag: response.headers.get('etag') ?? etag,
    }
  }
  if (response.status === 404) return unresolved('absent', 404)
  if (!response.ok) return unresolved('error', response.status)

  let packument: { 'dist-tags'?: Record<string, unknown>; versions?: Record<string, unknown> }
  try {
    packument = (await response.json()) as typeof packument
  } catch {
    return unresolved('error', response.status)
  }

  const latest = text(packument['dist-tags']?.latest)
  const manifest = latest ? (packument.versions?.[latest] as Record<string, unknown> | undefined) : undefined
  // A packument with no `latest` tag or no matching version manifest is
  // malformed; treat it as ignorance rather than overwrite a good binding.
  if (latest === null || manifest === undefined) return unresolved('error', response.status)

  const { binding, bundleDeclared } = classifyNpmBinding(id, manifest)
  const repositoryField = manifest.repository
  const repository = typeof repositoryField === 'string'
    ? { url: repositoryField, directory: undefined as unknown }
    : (repositoryField as { url?: unknown; directory?: unknown } | null) ?? {}
  const dist = (manifest.dist as { tarball?: unknown; integrity?: unknown } | null) ?? {}

  return {
    status: 'found',
    httpStatus: response.status,
    version: text(manifest.version) ?? latest,
    repositoryUrl: text(repository.url),
    repositoryDirectory: text(repository.directory),
    bundleDeclared,
    entryPoint: text(manifest.main),
    tarballUrl: text(dist.tarball),
    integrity: text(dist.integrity),
    binding,
    etag: response.headers.get('etag'),
  }
}
