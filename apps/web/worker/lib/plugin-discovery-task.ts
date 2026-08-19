import {
  claimScanLease,
  completeScanRun,
  getCatalogState,
  hydrateCuratedRepositories,
  loadPendingValidationRepositories,
  markMissingTopicRepositories,
  releaseScanLease,
  saveRepositoryInspections,
  setCatalogState,
  startScanRun,
  upsertDiscoveredRepositories,
  type ScanCounters,
} from './catalog-db'
import { refreshCatalogSnapshot } from './catalog-store'
import {
  createGitHubClient,
  DISCOVERY_STRATEGY_VERSION,
  discoverRepositories,
  incrementalStart,
  inspectRepository,
  selectDiscoveryMode,
} from './github-discovery'

const DEFAULT_TOPIC = 'dsh-plugin'
const DISCOVERY_CHUNK_SIZE = 40
const VALIDATION_CHUNK_SIZE = 20
// Every repository is re-swept at least this often even with no push behind it.
// It is the only clause that can bring back a repository rejected wholesale —
// a tree that 404'd while it was briefly private, a stale default branch — and
// it is what notices a topic added or removed without a commit. At catalog
// scale this is ~10 repositories per half-hour tick, which the reserve absorbs.
const VALIDATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const CORE_RATE_LIMIT_RESERVE = 500
const TASK_DEADLINE_MS = 12 * 60 * 1000
const LEASE_MS = 20 * 60 * 1000
const DISCOVERY_STRATEGY_STATE_KEY = 'discovery_strategy_version'

interface RateLimitResponse {
  resources: {
    core: {
      remaining: number
    }
  }
}

export interface PluginDiscoveryResult extends ScanCounters {
  mode: 'incremental' | 'full'
  skipped?: boolean
  pending?: boolean
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

async function withRetry<T>(callback: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await callback()
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1) await scheduler.wait(5_000 * 2 ** attempt)
    }
  }
  throw lastError
}

export async function runPluginDiscoveryTask(
  env: Env,
  requestedMode?: 'incremental' | 'full',
  scheduledTime = Date.now(),
): Promise<PluginDiscoveryResult> {
  const started = Date.now()
  const deadline = started + TASK_DEADLINE_MS
  const runAt = new Date(scheduledTime)
  const end = runAt.toISOString().replace(/\.\d{3}Z$/, 'Z')
  const runId = crypto.randomUUID()
  let leaseClaimed = false
  let mode: 'incremental' | 'full' = requestedMode ?? 'incremental'
  const counters: ScanCounters = { discovered: 0, changed: 0, accepted: 0, rejected: 0 }

  try {
    leaseClaimed = await claimScanLease(env.CATALOG_DB, runId, runAt, LEASE_MS)
    if (!leaseClaimed) return { ...counters, mode, skipped: true }
    const watermark = await getCatalogState(env.CATALOG_DB, 'discovery_watermark')
    const strategyVersion = await getCatalogState(env.CATALOG_DB, DISCOVERY_STRATEGY_STATE_KEY)
    mode = selectDiscoveryMode(requestedMode, watermark, strategyVersion)
    await startScanRun(env.CATALOG_DB, runId, mode, end)

    const client = createGitHubClient(env.GITHUB_TOKEN.trim())
    const repositories = await withRetry(() => discoverRepositories(
      client,
      DEFAULT_TOPIC,
      mode,
      mode === 'full' ? null : incrementalStart(watermark as string),
      end,
    ))
    counters.discovered = repositories.length
    for (const group of chunks(repositories, DISCOVERY_CHUNK_SIZE)) {
      const result = await upsertDiscoveredRepositories(env.CATALOG_DB, group, runId, end)
      counters.changed += result.changedCount
    }

    // Submissions arrive with a name only, so their repositories need their
    // GitHub facts before the validation queue (which keys on github_id) can
    // see them at all.
    try {
      counters.changed += await hydrateCuratedRepositories(env.CATALOG_DB, client, VALIDATION_CHUNK_SIZE, end)
    } catch (error) {
      console.error(JSON.stringify({
        message: 'curated_hydration_failed',
        error: error instanceof Error ? error.message : String(error),
      }))
    }

    let pending = false
    // The queue is push-driven, so a repository pushed *during* this run has a
    // pushed_at later than the watermark we stamp on it and would be handed
    // back on the very next query. Inspecting each repository at most once per
    // run keeps that from becoming a tight loop that burns the rate limit on a
    // single repository; the next tick picks it up normally.
    const inspectedThisRun = new Set<number>()
    while (Date.now() < deadline) {
      const queued = await loadPendingValidationRepositories(
        env.CATALOG_DB,
        VALIDATION_CHUNK_SIZE,
        new Date(Date.parse(end) - VALIDATION_MAX_AGE_MS).toISOString(),
      )
      const candidates = queued.filter((item) => !inspectedThisRun.has(item.repository.id))
      if (candidates.length === 0) {
        if (queued.length > 0) pending = true
        break
      }
      const rateLimit = await client.request<RateLimitResponse>('/rate_limit')
      if (rateLimit.resources.core.remaining <= CORE_RATE_LIMIT_RESERVE) {
        pending = true
        break
      }
      const inspections = []
      for (const candidate of candidates) {
        if (Date.now() >= deadline ||
          (client.getRateLimitRemaining() ?? Number.POSITIVE_INFINITY) <= CORE_RATE_LIMIT_RESERVE) {
          pending = true
          break
        }
        // No withRetry here any more: inspectRepository retries its own
        // requests, so one flaky blob costs one blob instead of re-fetching
        // the tree and every manifest read before it — an amplification that
        // grew with the number of packages a monorepo publishes.
        inspectedThisRun.add(candidate.repository.id)
        inspections.push(await inspectRepository(client, candidate.repository, candidate.manifestCursor))
      }
      if (inspections.length === 0) break
      await saveRepositoryInspections(env.CATALOG_DB, inspections, end)
      counters.accepted += inspections.reduce((total, item) => total + item.packages.length, 0)
      counters.rejected += inspections.filter((item) => item.status === 'rejected').length
      // A repository whose sweep ran out of blob budget resumes next tick.
      if (inspections.some((item) => item.nextManifestCursor !== null)) pending = true
      if (inspections.length < candidates.length) break
    }
    if (Date.now() >= deadline) pending = true

    // npm version probing is a separate concern on its own cron
    // (`npm-refresh-task`), so the crawl no longer waits on the registry.

    if (mode === 'full') await markMissingTopicRepositories(env.CATALOG_DB, runId, end)
    await setCatalogState(env.CATALOG_DB, 'discovery_watermark', end, end)
    if (mode === 'full') {
      await setCatalogState(
        env.CATALOG_DB,
        DISCOVERY_STRATEGY_STATE_KEY,
        DISCOVERY_STRATEGY_VERSION,
        end,
      )
    }
    const completedAt = new Date().toISOString()
    await completeScanRun(env.CATALOG_DB, runId, 'completed', counters, undefined, completedAt)
    await refreshCatalogSnapshot(env, fetch, new Date(completedAt).getTime())
    await releaseScanLease(env.CATALOG_DB, runId)
    leaseClaimed = false
    return { ...counters, mode, pending }
  } catch (error) {
    if (leaseClaimed) {
      const message = error instanceof Error ? error.message : String(error)
      await completeScanRun(
        env.CATALOG_DB,
        runId,
        'failed',
        counters,
        message,
        new Date().toISOString(),
      )
      await releaseScanLease(env.CATALOG_DB, runId)
    }
    throw error
  }
}
