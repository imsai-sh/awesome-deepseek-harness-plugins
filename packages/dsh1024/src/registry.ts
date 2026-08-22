/** Fetch and validate the public 1024 Store registry API. */

import { readJson, storePaths, writeJsonAtomic } from './shared/files.ts'

export interface RegistryCategory {
  id: string
  order: number
  label: Record<string, string>
}

export interface RegistryPlugin {
  id: string
  name: string
  owner: string
  url: string
  category: string
  description: Record<string, string>
  install: string
  /** Server-derived preferred package spec; absent on older registry responses. */
  target?: string
  /** Package allowed to run a source-install build script. */
  allowBuild?: string | null
  added: string
  stars?: number | null
}

export interface Registry {
  name: string
  updated: string
  count: number
  categories: RegistryCategory[]
  plugins: RegistryPlugin[]
}

export type RegistrySource = 'api' | 'cache'

export const DEFAULT_REGISTRY_URL = 'https://deepseek1024.com/api/v1/registry'
const CACHE_TTL_MS = 5 * 60 * 1000
const PERSISTED_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 8_000
// Revalidation URLs carry a coarse timestamp so a stale CDN copy cannot answer
// them, while a whole minute of revalidations still collapses onto one URL.
const REVALIDATE_WINDOW_MS = 60_000

let cache: { url: string; at: number; registry: Registry; persisted: boolean } | null = null
// One network refresh at a time: opening the panel twice, or opening it while a
// visibility-triggered refresh is still running, must not stack up requests.
let inFlight: { url: string; promise: Promise<Registry> } | null = null
let hydration: { path: string; promise: Promise<void> } | null = null

interface PersistedRegistryCache {
  version: 1
  url: string
  fetchedAt: number
  registry: unknown
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every(item => typeof item === 'string')
}

function isCategory(value: unknown): value is RegistryCategory {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const category = value as Record<string, unknown>
  return typeof category.id === 'string'
    && typeof category.order === 'number'
    && isStringMap(category.label)
}

function isPlugin(value: unknown, categoryIds: Set<string>): value is RegistryPlugin {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const plugin = value as Record<string, unknown>
  if (!(typeof plugin.id === 'string'
    && typeof plugin.name === 'string'
    && typeof plugin.owner === 'string'
    && typeof plugin.url === 'string'
    && parseGitHubSource(plugin.url) !== null
    && typeof plugin.category === 'string'
    && categoryIds.has(plugin.category)
    && isStringMap(plugin.description)
    && typeof plugin.install === 'string'
    && typeof plugin.added === 'string'
    && (plugin.stars === undefined || plugin.stars === null || typeof plugin.stars === 'number'))) return false
  try {
    validatedInstallTarget(plugin as unknown as RegistryPlugin)
    installExtraArgs(plugin as unknown as RegistryPlugin)
    return true
  } catch {
    return false
  }
}

/**
 * Validate untrusted registry JSON before it can become an installation allowlist.
 * @param value - parsed `/api/v1/registry` response.
 * @returns the validated registry.
 */
export function validateRegistry(value: unknown): Registry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('registry must be an object')
  }
  const registry = value as Record<string, unknown>
  if (typeof registry.name !== 'string' || typeof registry.updated !== 'string' || typeof registry.count !== 'number') {
    throw new Error('registry metadata is invalid')
  }
  if (!Array.isArray(registry.categories) || !registry.categories.every(isCategory)) {
    throw new Error('registry categories are invalid')
  }
  const categoryIds = new Set(registry.categories.map(category => category.id))
  const rawPlugins = registry.plugins
  if (!Array.isArray(rawPlugins) || rawPlugins.length === 0) {
    throw new Error('registry plugins are empty')
  }
  if (registry.count !== rawPlugins.length) throw new Error('registry count does not match plugins')
  // One malformed catalog entry must not take the whole store down: skip
  // entries that fail strict validation instead of rejecting the entire
  // registry, which previously surfaced as HTTP 503 on /dsh1024/installed and
  // made every installed plugin unrecognizable (issue #159). Valid entries are
  // unaffected and invalid ones are never installable.
  const validPlugins = rawPlugins.filter(plugin => isPlugin(plugin, categoryIds))
  // `count` is the server's raw plugin count and no longer matches the filtered
  // array above. The persisted cache stores this exact registry object, so
  // re-hydrating it later re-ran the strict count check against the
  // already-filtered array, threw, and forced a network round-trip on every
  // request — the whole store went 503 whenever the API was slow or
  // unreachable. Normalize count to the filtered length so the cached registry
  // round-trips through the same validation.
  registry.plugins = validPlugins
  registry.count = validPlugins.length
  return registry as unknown as Registry
}

/**
 * Parse the only repository URL form accepted by the installer.
 * @param url - curated plugin repository URL.
 * @returns the GitHub owner/repository pair, or null for an unsupported URL.
 */
export function parseGitHubSource(url: string): string | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/?$/.exec(url)
  return match?.[1] ?? null
}

const ID_SEGMENT = /^[A-Za-z0-9_.-]+$/
const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[A-Za-z0-9._-]+$/

/**
 * The plugin's in-repo directory, taken from its id and cross-checked against
 * the repository URL. A monorepo subpackage's id extends its repository with
 * the directory the plugin lives in.
 * @param id - curated plugin id.
 * @param repository - owner/repository parsed from the plugin's URL.
 * @returns the subdirectory, or `''` for a repository-level plugin.
 */
export function pluginSubPath(id: string, repository: string): string {
  const segments = id.split('/')
  if (segments.length < 2) throw new Error('unsupported plugin id')
  if (segments.slice(0, 2).join('/').toLowerCase() !== repository.toLowerCase()) {
    throw new Error('plugin id does not match its repository URL')
  }
  const rest = segments.slice(2)
  if (!rest.every(segment => ID_SEGMENT.test(segment) && segment !== '.' && segment !== '..')) {
    throw new Error('unsupported plugin subdirectory')
  }
  return rest.join('/')
}

/** Derive the immutable GitHub fallback without trusting display copy. */
function githubInstallTarget(plugin: RegistryPlugin): string {
  const repository = parseGitHubSource(plugin.url)
  if (repository === null) throw new Error('unsupported plugin repository URL')
  const subPath = pluginSubPath(plugin.id, repository)
  return subPath === '' ? `github:${repository}` : `github:${repository}#path:${subPath}`
}

/** Derive a structured GitHub target from the catalog id itself. */
function githubInstallTargetFromId(id: string): string {
  const segments = id.split('/')
  if (segments.length < 2 || !segments.every(segment =>
    ID_SEGMENT.test(segment) && segment !== '.' && segment !== '..')) {
    throw new Error('unsupported plugin id')
  }
  const repository = segments.slice(0, 2).join('/')
  const subPath = segments.slice(2).join('/')
  return subPath === '' ? `github:${repository}` : `github:${repository}#path:${subPath}`
}

function validatedInstallTarget(plugin: RegistryPlugin): string {
  if (plugin.target !== undefined && typeof plugin.target !== 'string') {
    throw new Error('install target must be a string')
  }
  // Older registry responses have no structured target, so their safe
  // fallback still comes from the repository URL cross-checked against id.
  if (plugin.target === undefined) return githubInstallTarget(plugin)
  const target = plugin.target
  if (target.startsWith('github:')) {
    const expected = githubInstallTargetFromId(plugin.id)
    const [targetRepository, targetPath = ''] = target.slice('github:'.length).split('#path:')
    const [expectedRepository, expectedPath = ''] = expected.slice('github:'.length).split('#path:')
    if (targetRepository?.toLowerCase() !== expectedRepository?.toLowerCase() || targetPath !== expectedPath) {
      throw new Error('install target does not match plugin id')
    }
    return target
  }
  if (!PACKAGE_NAME.test(target)) throw new Error('unsupported npm install target')
  return target
}

/** Return the server-derived preferred target after constraining its grammar. */
export function installTarget(plugin: RegistryPlugin): string {
  return validatedInstallTarget(plugin)
}

/** Extra official CLI arguments needed by the preferred install method. */
export function installExtraArgs(plugin: RegistryPlugin): string[] {
  const allowance = plugin.allowBuild
  if (allowance === undefined || allowance === null) return []
  if (typeof allowance !== 'string') throw new Error('build allowance must be a string')
  if (!PACKAGE_NAME.test(allowance)) throw new Error('unsupported build allowance')
  if (!installTarget(plugin).startsWith('github:')) throw new Error('npm installs cannot request a source build allowance')
  return [`--allow-build=${allowance}`]
}

/** Clear process-local registry state for deterministic tests. */
export function clearRegistryCache(): void {
  cache = null
  inFlight = null
  hydration = null
}

export interface LoadRegistryOptions {
  /**
   * Go to the network even when the process cache is still fresh, and answer
   * with what comes back. Used when the store panel opens or becomes visible
   * again, so a newly listed plugin shows up without waiting out any TTL.
   */
  revalidate?: boolean
  /** Return any validated disk snapshot immediately so the client can revalidate separately. */
  preferCache?: boolean
  /** Enable the plugin-owned on-disk cache under this DSH home directory. */
  dshHome?: string
}

function hydrateRegistryCache(path: string, registryUrl: string): Promise<void> {
  if (hydration?.path === path) return hydration.promise
  const promise = (async () => {
    try {
      const persisted = await readJson<PersistedRegistryCache>(path, null)
      if (persisted === null || persisted.version !== 1 || persisted.url !== registryUrl
        || typeof persisted.fetchedAt !== 'number' || !Number.isFinite(persisted.fetchedAt)
        || persisted.fetchedAt > Date.now() + CACHE_TTL_MS
        || Date.now() - persisted.fetchedAt > PERSISTED_CACHE_MAX_AGE_MS) return
      let registry: Registry | null = null
      try {
        registry = validateRegistry(persisted.registry)
      } catch {
        // Self-heal a cache written before the count normalization fix: its
        // `count` reflects the raw upstream total while `plugins` was already
        // filtered, so strict validation rejects it. The payload is the
        // plugin's own last-good output — re-validate it with the count
        // reconciled to the filtered length.
        const cached = persisted.registry as Record<string, unknown> | null | undefined
        if (cached !== null && typeof cached === 'object' && !Array.isArray(cached)) {
          try {
            registry = validateRegistry({
              ...cached,
              count: Array.isArray(cached.plugins) ? cached.plugins.length : 0,
            })
          } catch {
            registry = null
          }
        }
      }
      if (registry === null) return
      cache = {
        url: registryUrl,
        at: persisted.fetchedAt,
        registry,
        persisted: true,
      }
    } catch {
      // A missing, partial, old, or manually edited cache is non-fatal. The
      // validated network response remains the only source that can replace it.
    }
  })()
  hydration = { path, promise }
  return promise
}

async function fetchRegistry(
  registryUrl: string,
  fetcher: typeof fetch,
  bustEdgeCache: boolean,
  cachePath: string | null,
): Promise<Registry> {
  const url = new URL(registryUrl)
  if (url.protocol !== 'https:') throw new Error('registry API URL must use HTTPS')
  if (bustEdgeCache) url.searchParams.set('t', String(Math.floor(Date.now() / REVALIDATE_WINDOW_MS)))
  const response = await fetcher(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`registry API HTTP ${response.status}`)
  const registry = validateRegistry(await response.json() as unknown)
  const fetchedAt = Date.now()
  cache = { url: registryUrl, at: fetchedAt, registry, persisted: false }
  if (cachePath !== null) {
    await writeJsonAtomic(cachePath, {
      version: 1,
      url: registryUrl,
      fetchedAt,
      registry,
    } satisfies PersistedRegistryCache).catch(() => {})
  }
  return registry
}

function refresh(
  registryUrl: string,
  fetcher: typeof fetch,
  bustEdgeCache: boolean,
  cachePath: string | null,
): Promise<Registry> {
  if (inFlight !== null && inFlight.url === registryUrl) return inFlight.promise
  const promise = fetchRegistry(registryUrl, fetcher, bustEdgeCache, cachePath).finally(() => {
    if (inFlight?.promise === promise) inFlight = null
  })
  inFlight = { url: registryUrl, promise }
  return promise
}

/**
 * Load the registry from the configured HTTPS API, with a last-good response cache.
 *
 * The default path stays cache-first so rendering the panel never waits on the
 * network. `revalidate` is the stale-while-revalidate half: the caller already
 * has something on screen and wants the current catalog behind it.
 * @param registryUrl - public 1024 Store registry API endpoint.
 * @param fetcher - injectable fetch implementation for deterministic tests.
 * @param options - set `revalidate` to force a network read.
 * @returns the registry and whether it is fresh API data or a stale fallback cache.
 */
export async function loadRegistry(
  registryUrl: string = DEFAULT_REGISTRY_URL,
  fetcher: typeof fetch = fetch,
  options: LoadRegistryOptions = {},
): Promise<{ registry: Registry; source: RegistrySource }> {
  const cachePath = options.dshHome === undefined ? null : storePaths(options.dshHome).registryCache
  if (cachePath !== null) await hydrateRegistryCache(cachePath, registryUrl)
  const cached = cache !== null && cache.url === registryUrl ? cache : null
  if (options.revalidate !== true && cached !== null
    && (options.preferCache === true || Date.now() - cached.at < CACHE_TTL_MS)) {
    return { registry: cached.registry, source: cached.persisted ? 'cache' : 'api' }
  }
  try {
    const registry = await refresh(registryUrl, fetcher, options.revalidate === true, cachePath)
    return { registry, source: 'api' }
  } catch (error) {
    // Last-good fallback: an offline machine keeps browsing what it already has.
    if (cached !== null) return { registry: cached.registry, source: 'cache' }
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`registry API unavailable: ${detail}`)
  }
}
