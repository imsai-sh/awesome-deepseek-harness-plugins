import type {
  BackgroundContext,
  CatalogPlugin,
  CatalogSnapshotResult,
  InstallMetrics,
  StoredCatalogSnapshot,
} from '../types'
import { categoryLabelMap } from './categories'
import { repositoryName } from './catalog'
import { loadCatalogSnapshotFromD1 } from './catalog-db'
import { normalizePluginId } from './plugin-id'
import { emptyInstallMetrics, loadInstallMetrics } from './install-metrics'
import { loadStarGrowth } from './star-history'

// v10 drops npm download metrics from repositories that do not own the
// published package. Starting with a fresh key prevents an old v9 snapshot
// from keeping duplicated package-level counts visible after deployment.
const SNAPSHOT_KEY = 'catalog:snapshot:v10'
const SNAPSHOT_TTL_MS = 15 * 60 * 1000

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isCatalogPlugin(value: unknown): value is CatalogPlugin {
  if (!isObject(value) || !isObject(value.description)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.owner === 'string' &&
    typeof value.url === 'string' &&
    typeof value.repository === 'string' &&
    typeof value.category === 'string' &&
    typeof value.description.en === 'string' &&
    typeof value.description.zh === 'string' &&
    typeof value.install === 'string' &&
    typeof value.added === 'string' &&
    (typeof value.stars === 'number' || value.stars === null) &&
    (typeof value.forks === 'number' || value.forks === null) &&
    (typeof value.pushedAt === 'string' || value.pushedAt === null) &&
    (typeof value.updatedAt === 'string' || value.updatedAt === null) &&
    (typeof value.latestReleaseAt === 'string' || value.latestReleaseAt === null) &&
    (typeof value.growth24h === 'number' || value.growth24h === null) &&
    (typeof value.growth7d === 'number' || value.growth7d === null) &&
    (typeof value.growth30d === 'number' || value.growth30d === null) &&
    typeof value.installCount === 'number' &&
    typeof value.installerCount === 'number' &&
    typeof value.firstInstallCount === 'number' &&
    typeof value.reinstallCount === 'number' &&
    typeof value.updateCount === 'number' &&
    typeof value.removeCount === 'number' &&
    typeof value.failureCount === 'number' &&
    typeof value.installs24h === 'number' &&
    typeof value.installs7d === 'number' &&
    typeof value.installs30d === 'number' &&
    (typeof value.latestInstallAt === 'string' || value.latestInstallAt === null) &&
    (value.npmDownloads7d === undefined || typeof value.npmDownloads7d === 'number' || value.npmDownloads7d === null) &&
    (value.npmDownloadsStart === undefined || typeof value.npmDownloadsStart === 'string' || value.npmDownloadsStart === null) &&
    (value.npmDownloadsEnd === undefined || typeof value.npmDownloadsEnd === 'string' || value.npmDownloadsEnd === null)
  )
}

function isLocalizedCategory(value: unknown): boolean {
  return isObject(value) && typeof value.en === 'string' && typeof value.zh === 'string'
}

export function isStoredCatalogSnapshot(value: unknown): value is StoredCatalogSnapshot {
  if (!isObject(value)) return false
  return (
    typeof value.generatedAt === 'string' &&
    typeof value.registryUpdated === 'string' &&
    typeof value.registryRevision === 'string' &&
    typeof value.metricCoverage === 'number' &&
    isObject(value.categories) &&
    Object.values(value.categories).every(isLocalizedCategory) &&
    Array.isArray(value.plugins) &&
    value.plugins.length > 0 &&
    value.plugins.every(isCatalogPlugin)
  )
}

function logRefreshError(error: unknown): void {
  console.error(
    JSON.stringify({
      message: 'catalog_refresh_failed',
      error: error instanceof Error ? error.message : String(error),
    }),
  )
}

function logInstallMetricsError(error: unknown): void {
  console.error(
    JSON.stringify({
      message: 'install_metrics_refresh_failed',
      error: error instanceof Error ? error.message : String(error),
    }),
  )
}

/** Install metrics are per plugin, so monorepo siblings never share a counter. */
function installMetricKey(plugin: Pick<CatalogPlugin, 'id'>): string {
  return normalizePluginId(plugin.id)
}

/** Repository facts are shared by monorepo siblings, so carry-over and growth key by repository. */
function metricKey(plugin: Pick<CatalogPlugin, 'owner' | 'name' | 'url'>): string {
  return `${plugin.owner}/${repositoryName(plugin)}`.toLocaleLowerCase()
}

function installMetricsFrom(plugin: CatalogPlugin): InstallMetrics {
  return {
    installCount: plugin.installCount,
    installerCount: plugin.installerCount,
    firstInstallCount: plugin.firstInstallCount,
    reinstallCount: plugin.reinstallCount,
    updateCount: plugin.updateCount,
    removeCount: plugin.removeCount,
    failureCount: plugin.failureCount,
    installs24h: plugin.installs24h,
    installs7d: plugin.installs7d,
    installs30d: plugin.installs30d,
    latestInstallAt: plugin.latestInstallAt,
  }
}

async function readStoredSnapshot(env: Env): Promise<StoredCatalogSnapshot | null> {
  try {
    const value: unknown = await env.CATALOG_CACHE.get(SNAPSHOT_KEY, 'json')
    return isStoredCatalogSnapshot(value) ? value : null
  } catch (error) {
    logRefreshError(error)
    return null
  }
}

function emptyCatalogSnapshot(capturedAt: number): StoredCatalogSnapshot {
  const generatedAt = new Date(capturedAt).toISOString()
  return {
    generatedAt,
    registryUpdated: generatedAt.slice(0, 10),
    registryRevision: 'empty',
    metricCoverage: 0,
    categories: categoryLabelMap(),
    plugins: [],
  }
}

export async function refreshCatalogSnapshot(
  env: Env,
  _fetcher: typeof fetch = fetch,
  capturedAt: number = Date.now(),
): Promise<CatalogSnapshotResult> {
  const previousSnapshot = await readStoredSnapshot(env)
  if (env.CATALOG_DB) {
    try {
      const generatedAt = new Date(capturedAt).toISOString()
      const d1Snapshot = await loadCatalogSnapshotFromD1(env.CATALOG_DB, generatedAt)
      if (d1Snapshot) {
        // The rebuild never talks to GitHub. Stars, forks and push dates are
        // collector-owned D1 columns, and growth comes from the
        // collector-maintained star history — a request-sized amount of work.
        // The GraphQL sweep this used to run grew with the catalog until a
        // synchronous rebuild could no longer finish inside a request.
        //
        // Two maps, because the two kinds of carry-over have different keys:
        // repository facts are shared by monorepo siblings, install metrics are
        // per plugin and would otherwise be inherited from whichever sibling
        // happened to be last.
        const previousByRepository = new Map(
          previousSnapshot?.plugins.map((plugin) => [metricKey(plugin), plugin]) ?? [],
        )
        const previousByPlugin = new Map(
          previousSnapshot?.plugins.map((plugin) => [installMetricKey(plugin), plugin]) ?? [],
        )
        let plugins = d1Snapshot.plugins.map((plugin) => {
          const previous = previousByRepository.get(metricKey(plugin))
          const previousPlugin = previousByPlugin.get(installMetricKey(plugin))
          return {
            ...plugin,
            ...(previousPlugin ? installMetricsFrom(previousPlugin) : emptyInstallMetrics()),
            stars: plugin.stars ?? previous?.stars ?? null,
            forks: plugin.forks ?? previous?.forks ?? null,
            pushedAt: plugin.pushedAt ?? previous?.pushedAt ?? null,
            updatedAt: plugin.updatedAt ?? previous?.updatedAt ?? null,
            latestReleaseAt: previous?.latestReleaseAt ?? null,
            growth24h: previous?.growth24h ?? null,
            growth7d: previous?.growth7d ?? null,
            growth30d: previous?.growth30d ?? null,
          }
        })
        const tracked = plugins.filter((plugin) => plugin.stars !== null)
        if (tracked.length > 0 && env.CATALOG_DB) {
          const growth = await loadStarGrowth(env.CATALOG_DB, tracked, capturedAt)
          plugins = plugins.map((plugin) => ({
            ...plugin,
            ...(growth.get(metricKey(plugin)) ?? {}),
          }))
        }
        try {
          const installMetrics = await loadInstallMetrics(
            env.CATALOG_DB,
            plugins.map((plugin) => plugin.id),
            capturedAt,
          )
          plugins = plugins.map((plugin) => ({
            ...plugin,
            ...(installMetrics.get(installMetricKey(plugin)) ?? emptyInstallMetrics()),
          }))
        } catch (error) {
          logInstallMetricsError(error)
        }
        const snapshot = {
          ...d1Snapshot,
          metricCoverage: plugins.filter((plugin) => plugin.stars !== null).length,
          plugins,
        }
        try {
          await env.CATALOG_CACHE.put(SNAPSHOT_KEY, JSON.stringify(snapshot))
        } catch (error) {
          logRefreshError(error)
        }
        return { snapshot, source: 'd1' }
      }
    } catch (error) {
      logRefreshError(error)
    }
  }

  // D1 is the only source of truth. When it is unavailable (or still empty)
  // the stale KV snapshot is the only degradation layer; past that, serve an
  // explicitly empty snapshot so callers can surface the condition via meta.
  if (previousSnapshot) {
    return { snapshot: previousSnapshot, source: 'stale' }
  }
  return { snapshot: emptyCatalogSnapshot(capturedAt), source: 'empty' }
}

// KV holds nothing servable, so this path has to build one. Shared across every
// request the isolate is handling, so an empty namespace costs one rebuild
// instead of one per concurrent request.
let coldStart: Promise<CatalogSnapshotResult> | null = null

function coldStartSnapshot(env: Env, fetcher: typeof fetch): Promise<CatalogSnapshotResult> {
  coldStart ??= refreshCatalogSnapshot(env, fetcher).finally(() => {
    coldStart = null
  })
  return coldStart
}

/**
 * Read the snapshot. Reading never rebuilds it.
 *
 * POST /api/v1/catalog/sync owns the rebuild (plus the cold-start path above
 * for an empty namespace). A read used to start one too — inline when
 * the snapshot was missing, via `ctx.waitUntil` when it was merely stale — and
 * nothing deduplicated those: one per request, each a full catalog read out of
 * D1, a GitHub GraphQL sweep, then batched writes back. That is affordable at
 * one request and ruinous at a thousand. Under a traffic spike on 2026-08-18 the
 * snapshot aged past the TTL, every in-flight request began its own rebuild, D1
 * answered `D1_ERROR: D1 DB is overloaded. Requests queued for too long.`, and
 * each rebuild threw before reaching the `CATALOG_CACHE.put` that would have
 * marked the snapshot fresh. So the snapshot stayed stale, and the next second's
 * requests rebuilt too. Load did not break the catalog; reading it did.
 *
 * Serving a stale snapshot is the degradation. Rebuilding on read is the outage.
 * `SNAPSHOT_TTL_MS` still separates 'kv' from 'stale' so callers can surface the
 * age, but neither answer costs a query.
 */
export async function loadCatalogSnapshot(
  env: Env,
  _ctx?: BackgroundContext,
  fetcher: typeof fetch = fetch,
): Promise<CatalogSnapshotResult> {
  const cached = await readStoredSnapshot(env)
  if (cached) {
    const age = Date.now() - new Date(cached.generatedAt).getTime()
    const fresh = Number.isFinite(age) && age <= SNAPSHOT_TTL_MS
    return { snapshot: cached, source: fresh ? 'kv' : 'stale' }
  }

  return coldStartSnapshot(env, fetcher)
}

