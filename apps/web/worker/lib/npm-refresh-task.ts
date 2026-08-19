/**
 * Fast npm version refresh.
 *
 * Split out of the discovery crawl on purpose: inside it, npm probing ran last,
 * after GitHub discovery and inspection had already spent the tick's deadline,
 * so a busy tick refreshed nothing. Here it owns its own frequent cron and does
 * one thing.
 *
 * Two levers make a tight cadence affordable against a public registry:
 *   1. Conditional requests — every probe sends the package's last ETag, so npm
 *      answers `304` (no body) unless something published. Nothing is written to
 *      D1 on a `304`, so the daily write volume is the number of real publishes,
 *      not the number of packages times the number of ticks.
 *   2. A rolling cursor over the stable unique id, instead of a 7-day window.
 *      New arrivals (`npm_status = 'pending'`) are drained first; the rest of the
 *      budget continues the sweep from where the last tick stopped and wraps at
 *      the end. With conditional requests a full cycle is cheap, so freshness is
 *      bounded by cycle length rather than a fixed staleness window.
 */

import {
  getCatalogState,
  loadNpmPendingProbes,
  loadNpmSweepBatch,
  saveNpmProbes,
  setCatalogState,
  type NpmProbeCandidate,
  type NpmProbeRecord,
} from './catalog-db'
import { refreshCatalogSnapshot } from './catalog-store'
import { probeNpmPackage } from './npm-registry'

const CURSOR_KEY = 'npm_refresh_cursor'
// npm sits behind Cloudflare with a 5-minute edge TTL, so a published version is
// not visible faster than that anyway; the cron matches it. The budget is the
// politeness knob (a 304 is light, so it can go up); at low-thousands of
// packages a full cycle takes a few ticks.
const NPM_REFRESH_BUDGET = 800
const NPM_REFRESH_CONCURRENCY = 8
const NPM_REFRESH_PENDING_CAP = 200

export interface NpmRefreshResult {
  probed: number
  found: number
  absent: number
  notModified: number
  errors: number
  // Probes whose result repeats the stored status (absent→absent, error→error)
  // and so were not written — the sweep's steady-state majority for packages
  // that 404 (they have no ETag to earn a 304 with).
  skippedUnchanged: number
  wrapped: boolean
}

function concurrencyBatches<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
}

export async function runNpmRefreshTask(
  env: Env,
  scheduledTime: number = Date.now(),
): Promise<NpmRefreshResult> {
  const now = new Date(scheduledTime).toISOString()
  const cursor = (await getCatalogState(env.CATALOG_DB, CURSOR_KEY)) ?? ''

  const pending = await loadNpmPendingProbes(
    env.CATALOG_DB,
    Math.min(NPM_REFRESH_PENDING_CAP, NPM_REFRESH_BUDGET),
  )
  const sweepLimit = Math.max(0, NPM_REFRESH_BUDGET - pending.length)
  const sweep = sweepLimit > 0
    ? await loadNpmSweepBatch(env.CATALOG_DB, sweepLimit, cursor)
    : []

  // A pending row can also fall inside the sweep range; probe each once.
  const seen = new Set<string>()
  const candidates: NpmProbeCandidate[] = []
  for (const candidate of [...pending, ...sweep]) {
    if (seen.has(candidate.normalizedId)) continue
    seen.add(candidate.normalizedId)
    candidates.push(candidate)
  }

  const result: NpmRefreshResult = {
    probed: 0, found: 0, absent: 0, notModified: 0, errors: 0, skippedUnchanged: 0, wrapped: false,
  }
  const writes: NpmProbeRecord[] = []

  for (const batch of concurrencyBatches(candidates, NPM_REFRESH_CONCURRENCY)) {
    const probes = await Promise.all(batch.map(async (candidate) => ({
      candidate,
      probe: await probeNpmPackage(candidate.pluginId, candidate.packageName, candidate.etag),
    })))
    for (const { candidate, probe } of probes) {
      result.probed += 1
      // 304: nothing published since last ETag — record nothing.
      if (probe.status === 'not_modified') {
        result.notModified += 1
        continue
      }
      // A repeated absent/error has no ETag to earn a 304, but nothing changed
      // either — writing it would churn the row every sweep (thousands of 404s
      // rewritten each cycle for no reason). Only a *transition* is persisted.
      if (probe.status === candidate.currentStatus && (probe.status === 'absent' || probe.status === 'error')) {
        result.skippedUnchanged += 1
        continue
      }
      if (probe.status === 'found') result.found += 1
      else if (probe.status === 'absent') result.absent += 1
      else result.errors += 1
      writes.push({
        pluginId: candidate.pluginId,
        packageName: candidate.packageName,
        status: probe.status,
        httpStatus: probe.httpStatus,
        version: probe.version,
        repositoryUrl: probe.repositoryUrl,
        repositoryDirectory: probe.repositoryDirectory,
        bundleDeclared: probe.bundleDeclared,
        entryPoint: probe.entryPoint,
        tarballUrl: probe.tarballUrl,
        integrity: probe.integrity,
        binding: probe.binding,
        etag: probe.etag,
      })
    }
  }

  if (writes.length > 0) await saveNpmProbes(env.CATALOG_DB, writes, now)

  // Advance the cursor. When the sweep came back short it reached the end, so
  // wrap to the beginning; when pending ate the whole budget, keep the cursor
  // where it was so no package is skipped.
  let nextCursor = cursor
  if (sweepLimit > 0) {
    if (sweep.length < sweepLimit) {
      nextCursor = ''
      result.wrapped = true
    } else {
      nextCursor = sweep[sweep.length - 1]!.normalizedId
    }
  }
  await setCatalogState(env.CATALOG_DB, CURSOR_KEY, nextCursor, now)

  // A `found`/`absent` may have changed a version or badge; rebuild the snapshot
  // so the site does not wait for the next 15-minute catalog refresh. A tick of
  // only 304s changes nothing and skips this.
  if (result.found + result.absent > 0) {
    await refreshCatalogSnapshot(env, fetch, scheduledTime)
  }

  return result
}
