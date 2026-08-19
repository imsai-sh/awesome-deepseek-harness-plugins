import type { GitHubRepository, RepositoryInspection } from './github-discovery'
import type { CatalogPlugin, LocalizedText, StoredCatalogSnapshot } from '../types'
import { categoryLabelMap, UNCLASSIFIED_CATEGORY } from './categories'
import { emptyInstallMetrics } from './install-metrics'
import { deriveInstallMethods } from './install-methods'
import type { GitInstallCode, NpmBinding } from './install-methods'
import {
  normalizePluginId,
  parsePluginId,
  pluginInstallCommand,
  pluginPathFromPackagePath,
} from './plugin-id'

interface RepositoryIdentityRow {
  id: number
  github_id: number | null
  normalized_full_name: string
  default_branch: string | null
  pushed_at: string | null
  /** 1 when any of the repository's plugins still needs inspecting. */
  needs_validation: number
}

interface PendingRepositoryRow {
  github_id: number
  full_name: string
  repository_name: string
  html_url: string
  github_description: string | null
  default_branch: string
  stars: number
  forks: number
  language: string | null
  license: string | null
  github_updated_at: string
  pushed_at: string | null
  manifest_cursor: string | null
}

interface CatalogRow {
  full_name: string
  owner: string
  repository_name: string
  html_url: string
  github_description: string | null
  stars: number | null
  forks: number | null
  pushed_at: string | null
  github_updated_at: string | null
  plugin_path: string
  plugin_id: string
  curated_name: string | null
  curated_category: string | null
  curated_description_en: string | null
  curated_description_zh: string | null
  curated_added: string | null
  ai_category: string | null
  ai_description_en: string | null
  ai_description_zh: string | null
  git_code: string | null
  git_has_prepare: number
  git_head_sha: string | null
  git_checked_at: string | null
  npm_package_name: string | null
  npm_binding: string
  npm_bundle_declared: number
  npm_version: string | null
  npm_checked_at: string | null
}

export interface ScanCounters {
  discovered: number
  changed: number
  accepted: number
  rejected: number
}

export interface RepositoryUpsertResult {
  changedCount: number
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

export function normalizeRepositoryName(fullName: string): string {
  return fullName.trim().toLocaleLowerCase('en-US')
}

function repositoryParts(fullName: string): { owner: string; name: string } {
  const [owner, name, ...rest] = fullName.split('/')
  if (!owner || !name || rest.length > 0) throw new Error(`Invalid GitHub repository: ${fullName}`)
  return { owner, name }
}

/** Splits a curated entry id into its repository prefix and in-repo path. */
function curatedEntryParts(id: string): { owner: string; name: string; path: string } {
  const parts = parsePluginId(id)
  if (parts === null) throw new Error(`Invalid plugin id: ${id}`)
  return { owner: parts.owner, name: parts.repository, path: parts.path }
}

async function queryRepositoryIdentities(
  db: D1Database,
  repositories: GitHubRepository[],
): Promise<Map<string, RepositoryIdentityRow>> {
  if (repositories.length === 0) return new Map()
  const ids = repositories.map((repository) => repository.id)
  const names = repositories.map((repository) => normalizeRepositoryName(repository.full_name))
  const placeholders = (values: unknown[]) => values.map(() => '?').join(', ')
  const result = await db.prepare(
    `SELECT r.id, r.github_id, r.normalized_full_name, r.default_branch, r.pushed_at,
            EXISTS (
              SELECT 1 FROM catalog_plugins p
               WHERE p.repository_id = r.id
                 AND p.validation_status IN ('pending', 'error')
            ) AS needs_validation
       FROM catalog_repositories r
      WHERE r.github_id IN (${placeholders(ids)})
         OR r.normalized_full_name IN (${placeholders(names)})`,
  ).bind(...ids, ...names).all<RepositoryIdentityRow>()
  const byKey = new Map<string, RepositoryIdentityRow>()
  for (const row of result.results) {
    if (row.github_id !== null) byKey.set(`id:${row.github_id}`, row)
    byKey.set(`name:${row.normalized_full_name}`, row)
  }
  return byKey
}

export interface CuratedCatalogEntry {
  /**
   * Plugin id — `owner/repository`, or `owner/repository/sub/dir` for a
   * monorepo subpackage — matching the curated file name.
   */
  id: string
  name: string
  /** GitHub repository URL. */
  repository: string
  category: string
  description: LocalizedText
  added: string
}

export interface CuratedSyncResult {
  total: number
  removedSources: number
}

/**
 * Full reconciliation of the curated catalog (catalog/plugins/*.json) into D1.
 *
 * Upserts `catalog_repositories` and the curated columns of `catalog_plugins`.
 * A plugin row is per plugin, so several entries may share one repository row
 * (a monorepo contributing more than one subpackage plugin). Entries missing
 * from `entries` lose their curated columns, and a plugin nothing else knows
 * about is removed; repository rows are never deleted, so production data is
 * preserved. Idempotent: re-running with the same input is a no-op apart from
 * `last_seen_at`/`updated_at` bumps.
 */
export async function syncCuratedEntries(
  db: D1Database,
  entries: CuratedCatalogEntry[],
  now = new Date().toISOString(),
): Promise<CuratedSyncResult> {
  // Several entries can share one repository; the repository row is upserted
  // once per distinct owner/repository. Only repository-level facts are touched
  // here — the crawler owns the GitHub columns and this must not disturb them.
  const repositories = new Map<string, { fullName: string; owner: string; name: string; url: string }>()
  for (const entry of entries) {
    const { owner, name } = curatedEntryParts(entry.id)
    const fullName = `${owner}/${name}`
    if (!repositories.has(normalizeRepositoryName(fullName))) {
      repositories.set(normalizeRepositoryName(fullName), { fullName, owner, name, url: entry.repository })
    }
  }

  for (const group of chunks([...repositories.values()], 50)) {
    await db.batch(group.map(({ fullName, owner, name, url }) => db.prepare(
      `INSERT INTO catalog_repositories (
         full_name, normalized_full_name, owner, repository_name, html_url,
         first_seen_at, last_seen_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(normalized_full_name) DO UPDATE SET
         full_name = excluded.full_name,
         owner = excluded.owner,
         repository_name = excluded.repository_name,
         html_url = excluded.html_url,
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at`,
    ).bind(fullName, normalizeRepositoryName(fullName), owner, name, url, now, now, now, now)))
  }

  // Retired plugins are dropped BEFORE the upserts. The primary key
  // (repository_id, plugin_path) is case-sensitive while normalized_plugin_id
  // is not, so an entry that only changes the case of its path would insert a
  // second row and trip UNIQUE(normalized_plugin_id) if the stale row were
  // still present. A plugin the topic scan also found keeps its row and simply
  // loses its curated columns.
  const currentPluginIds = JSON.stringify(entries.map((entry) => normalizePluginId(entry.id)))
  const retired = await db.batch([
    db.prepare(
      `DELETE FROM catalog_plugins
        WHERE from_pr = 1
          AND validation_status = 'pending'
          AND normalized_plugin_id NOT IN (SELECT value FROM json_each(?))`,
    ).bind(currentPluginIds),
    db.prepare(
      `UPDATE catalog_plugins
          SET from_pr = 0, pr_reference = NULL,
              curated_name = NULL, curated_category = NULL,
              curated_description_en = NULL, curated_description_zh = NULL,
              curated_added = NULL, curated_updated_at = NULL,
              updated_at = ?
        WHERE from_pr = 1
          AND normalized_plugin_id NOT IN (SELECT value FROM json_each(?))`,
    ).bind(now, currentPluginIds),
  ])

  for (const group of chunks(entries, 40)) {
    const normalizedNames = [...new Set(group.map((entry) => {
      const { owner, name } = curatedEntryParts(entry.id)
      return normalizeRepositoryName(`${owner}/${name}`)
    }))]
    const result = await db.prepare(
      `SELECT id, normalized_full_name
         FROM catalog_repositories
        WHERE normalized_full_name IN (${normalizedNames.map(() => '?').join(', ')})`,
    ).bind(...normalizedNames).all<{ id: number; normalized_full_name: string }>()
    const ids = new Map(result.results.map((row) => [row.normalized_full_name, row.id]))
    const statements: D1PreparedStatement[] = []
    for (const entry of group) {
      const { owner, name, path } = curatedEntryParts(entry.id)
      const id = ids.get(normalizeRepositoryName(`${owner}/${name}`))
      if (id === undefined) throw new Error(`Curated repository was not inserted: ${entry.id}`)
      statements.push(db.prepare(
        // Only curated_* and the provenance flag are written. The crawler's
        // columns are absent from both the insert and the update, so a sync
        // never overwrites install facts it did not produce.
        `INSERT INTO catalog_plugins (
           repository_id, plugin_id, normalized_plugin_id, plugin_path,
           from_pr, pr_reference,
           curated_name, curated_category, curated_description_en, curated_description_zh,
           curated_added, curated_updated_at,
           first_seen_at, last_seen_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repository_id, plugin_path) DO UPDATE SET
           plugin_id = excluded.plugin_id,
           normalized_plugin_id = excluded.normalized_plugin_id,
           from_pr = 1,
           pr_reference = excluded.pr_reference,
           curated_name = excluded.curated_name,
           curated_category = excluded.curated_category,
           curated_description_en = excluded.curated_description_en,
           curated_description_zh = excluded.curated_description_zh,
           curated_added = excluded.curated_added,
           curated_updated_at = excluded.curated_updated_at,
           last_seen_at = excluded.last_seen_at,
           updated_at = excluded.updated_at`,
      ).bind(
        id, entry.id, normalizePluginId(entry.id), path,
        entry.repository,
        entry.name, entry.category, entry.description.en, entry.description.zh,
        entry.added, now,
        now, now, now, now,
      ))
    }
    await db.batch(statements)
  }

  return {
    total: entries.length,
    removedSources: Number(retired[0]?.meta.changes ?? 0) + Number(retired[1]?.meta.changes ?? 0),
  }
}

export async function getCatalogState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM catalog_state WHERE key = ?')
    .bind(key)
    .first<{ value: string }>()
  return row?.value ?? null
}

export async function setCatalogState(
  db: D1Database,
  key: string,
  value: string,
  now = new Date().toISOString(),
): Promise<void> {
  await db.prepare(
    `INSERT INTO catalog_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(key, value, now).run()
}

export async function claimScanLease(
  db: D1Database,
  runId: string,
  now: Date,
  leaseMilliseconds = 6 * 60 * 60 * 1000,
): Promise<boolean> {
  const nowIso = now.toISOString()
  const value = `${new Date(now.getTime() + leaseMilliseconds).toISOString()}|${runId}`
  const claimed = await db.prepare(
    `INSERT INTO catalog_state (key, value, updated_at)
     VALUES ('discovery_lease', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE catalog_state.value < ? OR catalog_state.value LIKE ?
     RETURNING value`,
  ).bind(value, nowIso, `${nowIso}|`, `%|${runId}`).first<{ value: string }>()
  return claimed?.value === value
}

export async function releaseScanLease(db: D1Database, runId: string): Promise<void> {
  await db.prepare(
    `DELETE FROM catalog_state WHERE key = 'discovery_lease' AND value LIKE ?`,
  ).bind(`%|${runId}`).run()
}

export async function startScanRun(
  db: D1Database,
  runId: string,
  mode: 'incremental' | 'full',
  startedAt: string,
): Promise<void> {
  await db.prepare(
    `INSERT INTO catalog_scan_runs (run_id, mode, status, started_at)
     VALUES (?, ?, 'running', ?)
     ON CONFLICT(run_id) DO NOTHING`,
  ).bind(runId, mode, startedAt).run()
}

export async function completeScanRun(
  db: D1Database,
  runId: string,
  status: 'completed' | 'failed',
  counters: ScanCounters,
  error?: string,
  now = new Date().toISOString(),
): Promise<void> {
  await db.prepare(
    `UPDATE catalog_scan_runs
        SET status = ?, completed_at = ?, discovered_count = ?, changed_count = ?,
            accepted_count = ?, rejected_count = ?, error = ?
      WHERE run_id = ?`,
  ).bind(
    status,
    now,
    counters.discovered,
    counters.changed,
    counters.accepted,
    counters.rejected,
    error ?? null,
    runId,
  ).run()
}

export async function upsertDiscoveredRepositories(
  db: D1Database,
  repositories: GitHubRepository[],
  runId: string,
  now = new Date().toISOString(),
): Promise<RepositoryUpsertResult> {
  if (repositories.length > 40) throw new Error('Repository upsert chunks cannot exceed 40 items')
  const identities = await queryRepositoryIdentities(db, repositories)
  let changedCount = 0
  for (const repository of repositories) {
    const normalizedName = normalizeRepositoryName(repository.full_name)
    const byGithubId = identities.get(`id:${repository.id}`)
    const byName = identities.get(`name:${normalizedName}`)
    if (!byGithubId || !byName || byGithubId.id === byName.id) continue
    if (byName.github_id !== null && byName.github_id !== repository.id) {
      throw new Error(`Repository identity collision for ${repository.full_name}`)
    }
    await db.batch([
      db.prepare(
        `UPDATE catalog_repositories
            SET from_topic = MAX(from_topic, (SELECT from_topic FROM catalog_repositories WHERE id = ?)),
                topic_last_run_id = COALESCE(
                  (SELECT topic_last_run_id FROM catalog_repositories WHERE id = ?), topic_last_run_id),
                topic_last_seen_at = COALESCE(
                  (SELECT topic_last_seen_at FROM catalog_repositories WHERE id = ?), topic_last_seen_at)
          WHERE id = ?`,
      ).bind(byGithubId.id, byGithubId.id, byGithubId.id, byName.id),
      // Plugin ids are globally unique, so the losing rows go before the copy
      // lands. Ids are rebuilt around the surviving repository's name.
      db.prepare(
        `DELETE FROM catalog_plugins
          WHERE repository_id = ?
            AND plugin_path IN (SELECT plugin_path FROM catalog_plugins WHERE repository_id = ?)`,
      ).bind(byName.id, byGithubId.id),
      db.prepare(
        `INSERT INTO catalog_plugins (
           repository_id, plugin_id, normalized_plugin_id, plugin_path,
           from_pr, pr_reference,
           curated_name, curated_category, curated_description_en, curated_description_zh,
           curated_added, curated_updated_at,
           manifest_path, package_name, package_version, bundle_patch,
           validation_status, validation_code, validation_reason,
           first_seen_at, last_seen_at, created_at, updated_at
         )
         SELECT ?, r.full_name || CASE WHEN p.plugin_path = '' THEN '' ELSE '/' || p.plugin_path END,
                lower(r.normalized_full_name || CASE WHEN p.plugin_path = '' THEN '' ELSE '/' || p.plugin_path END),
                p.plugin_path,
                p.from_pr, p.pr_reference,
                p.curated_name, p.curated_category, p.curated_description_en, p.curated_description_zh,
                p.curated_added, p.curated_updated_at,
                p.manifest_path, p.package_name, p.package_version, p.bundle_patch,
                p.validation_status, p.validation_code, p.validation_reason,
                p.first_seen_at, p.last_seen_at, p.created_at, p.updated_at
           FROM catalog_plugins p
           JOIN catalog_repositories r ON r.id = ?
          WHERE p.repository_id = ?
         ON CONFLICT(repository_id, plugin_path) DO NOTHING`,
      ).bind(byName.id, byName.id, byGithubId.id),
      // Cascades the losing repository's remaining plugin rows away.
      db.prepare('DELETE FROM catalog_repositories WHERE id = ?').bind(byGithubId.id),
    ])
    identities.set(`id:${repository.id}`, byName)
  }
  const incoming = repositories.map((repository) => {
    const normalizedName = normalizeRepositoryName(repository.full_name)
    const existing = identities.get(`id:${repository.id}`) ?? identities.get(`name:${normalizedName}`)
    const changed = existing === undefined ||
      existing.pushed_at !== repository.pushed_at ||
      existing.default_branch !== repository.default_branch ||
      existing.needs_validation === 1
    if (changed) {
      changedCount += 1
    }
    const { owner, name } = repositoryParts(repository.full_name)
    return {
      internalId: existing?.id ?? null,
      githubId: repository.id,
      fullName: repository.full_name,
      normalizedName,
      owner,
      name,
      htmlUrl: repository.html_url,
      description: repository.description,
      defaultBranch: repository.default_branch,
      stars: repository.stargazers_count,
      forks: repository.forks_count,
      language: repository.language,
      license: repository.license?.spdx_id ?? null,
      githubUpdatedAt: repository.updated_at,
      pushedAt: repository.pushed_at,
      needsValidation: changed ? 1 : 0,
    }
  })
  const serialized = JSON.stringify(incoming)
  const existingCount = incoming.filter((repository) => repository.internalId !== null).length
  const newCount = incoming.length - existingCount

  if (existingCount > 0) {
    await db.prepare(
      `WITH incoming AS (
         SELECT
           CAST(json_extract(value, '$.internalId') AS INTEGER) AS internal_id,
           CAST(json_extract(value, '$.githubId') AS INTEGER) AS github_id,
           json_extract(value, '$.fullName') AS full_name,
           json_extract(value, '$.normalizedName') AS normalized_full_name,
           json_extract(value, '$.owner') AS owner,
           json_extract(value, '$.name') AS repository_name,
           json_extract(value, '$.htmlUrl') AS html_url,
           json_extract(value, '$.description') AS description,
           json_extract(value, '$.defaultBranch') AS default_branch,
           CAST(json_extract(value, '$.stars') AS INTEGER) AS stars,
           CAST(json_extract(value, '$.forks') AS INTEGER) AS forks,
           json_extract(value, '$.language') AS language,
           json_extract(value, '$.license') AS license,
           json_extract(value, '$.githubUpdatedAt') AS github_updated_at,
           json_extract(value, '$.pushedAt') AS pushed_at
         FROM json_each(?)
         WHERE json_extract(value, '$.internalId') IS NOT NULL
       )
       UPDATE catalog_repositories
          SET (github_id, full_name, normalized_full_name, owner, repository_name,
               html_url, github_description, default_branch, stars, forks, language, license,
               github_updated_at, pushed_at, from_topic,
               last_seen_at, updated_at) =
              (SELECT github_id, full_name, normalized_full_name, owner, repository_name,
                      html_url, description, default_branch, stars, forks, language, license,
                      github_updated_at, pushed_at, 1, ?, ?
                 FROM incoming WHERE internal_id = catalog_repositories.id)
        WHERE id IN (SELECT internal_id FROM incoming)`,
    ).bind(serialized, now, now).run()
  }

  if (newCount > 0) {
    await db.prepare(
      `INSERT INTO catalog_repositories (
         github_id, full_name, normalized_full_name, owner, repository_name, html_url,
         github_description, default_branch, stars, forks, language, license, github_updated_at,
         pushed_at, from_topic, first_seen_at, last_seen_at,
         created_at, updated_at
       )
       SELECT
         CAST(json_extract(value, '$.githubId') AS INTEGER),
         json_extract(value, '$.fullName'), json_extract(value, '$.normalizedName'),
         json_extract(value, '$.owner'), json_extract(value, '$.name'),
         json_extract(value, '$.htmlUrl'), json_extract(value, '$.description'),
         json_extract(value, '$.defaultBranch'), CAST(json_extract(value, '$.stars') AS INTEGER),
         CAST(json_extract(value, '$.forks') AS INTEGER), json_extract(value, '$.language'),
         json_extract(value, '$.license'), json_extract(value, '$.githubUpdatedAt'),
         json_extract(value, '$.pushedAt'), 1, ?, ?, ?, ?
       FROM json_each(?)
       WHERE json_extract(value, '$.internalId') IS NULL`,
    ).bind(now, now, now, now, serialized).run()
  }

  // The topic provenance is a column now, and every discovered repository needs
  // a plugin row for the validation queue to have something to inspect. The
  // plugin sits at the repository root until inspection finds a nested manifest;
  // an existing row (curated, or from an earlier scan) is left alone.
  await db.batch([
    db.prepare(
      `UPDATE catalog_repositories
          SET from_topic = 1, topic_last_run_id = ?, topic_last_seen_at = ?, updated_at = ?
        WHERE normalized_full_name IN (
          SELECT json_extract(value, '$.normalizedName') FROM json_each(?)
        )`,
    ).bind(runId, now, now, serialized),
    db.prepare(
      // Only a repository nothing knows a plugin for gets a placeholder. The
      // guard is what stops the row from coming back: inspection removes the
      // placeholder once it has resolved the repository's real plugins, and
      // without `NOT EXISTS` the next discovery pass would seed another one —
      // pending, unresolvable, and enough to keep the repository in the
      // validation queue for good.
      `INSERT INTO catalog_plugins (
         repository_id, plugin_id, normalized_plugin_id, plugin_path,
         first_seen_at, last_seen_at, created_at, updated_at
       )
       SELECT r.id, r.full_name, r.normalized_full_name, '', ?, ?, ?, ?
         FROM json_each(?) j
         JOIN catalog_repositories r
           ON r.normalized_full_name = json_extract(j.value, '$.normalizedName')
        WHERE NOT EXISTS (
          SELECT 1 FROM catalog_plugins existing WHERE existing.repository_id = r.id
        )
       ON CONFLICT(repository_id, plugin_path) DO NOTHING`,
    ).bind(now, now, now, now, serialized),
  ])

  return { changedCount }
}

export interface PendingRepository {
  repository: GitHubRepository
  /** Manifest path the next inspection pass resumes after, `null` to restart. */
  manifestCursor: string | null
}

/**
 * Repositories the crawler still owes an answer on, oldest scan first.
 *
 * Membership used to be "some plugin row says pending", which had two holes.
 * A curated repository the topic scan had never seen was excluded outright by
 * `from_topic = 1`, so it published with no install facts at all. And nothing
 * ever put an inspected repository *back* into the queue — re-inspection only
 * happened by accident, because the phantom root row 0009 deletes was
 * permanently pending. With that row gone the queue has to say plainly when a
 * repository is due: it was pushed since the last scan, or a sweep is still
 * mid-flight. Neither has to disturb `validation_status`, so plugins stay
 * published while they wait rather than blinking out of the catalog.
 */
export async function loadPendingValidationRepositories(
  db: D1Database,
  limit = 20,
  staleBefore: string | null = null,
): Promise<PendingRepository[]> {
  const result = await db.prepare(
    `SELECT github_id, full_name, repository_name, html_url, github_description, default_branch,
            stars, forks, language, license, github_updated_at, pushed_at, manifest_cursor
       FROM catalog_repositories
      WHERE github_id IS NOT NULL
        AND (
          from_topic = 1
          OR EXISTS (
            SELECT 1 FROM catalog_plugins p
             WHERE p.repository_id = catalog_repositories.id AND p.from_pr = 1
          )
        )
        AND (
          last_scanned_at IS NULL
          OR manifest_cursor IS NOT NULL
          OR (pushed_at IS NOT NULL AND last_scanned_at < pushed_at)
          -- The floor under everything else. Without it a repository that was
          -- rejected wholesale — a tree 404 while it was briefly private, a
          -- default_branch gone stale after a rename — leaves the queue for
          -- good: its plugins are all retired rather than pending, its cursor
          -- is cleared, and its last scan is newer than its last push, so no
          -- other clause can ever fire again. It also catches a repository that
          -- gained or lost the topic with no push behind it.
          OR (? IS NOT NULL AND last_scanned_at < ?)
          OR EXISTS (
            SELECT 1 FROM catalog_plugins p
             WHERE p.repository_id = catalog_repositories.id
               AND p.validation_status = 'pending'
          )
        )
      ORDER BY last_scanned_at IS NOT NULL, last_scanned_at, id
      LIMIT ?`,
  ).bind(staleBefore, staleBefore, limit).all<PendingRepositoryRow>()
  return result.results.map((row) => ({
    manifestCursor: row.manifest_cursor,
    repository: {
      id: row.github_id,
      name: row.repository_name,
      full_name: row.full_name,
      html_url: row.html_url,
      description: row.github_description,
      fork: false,
      archived: false,
      disabled: false,
      default_branch: row.default_branch,
      stargazers_count: row.stars,
      forks_count: row.forks,
      language: row.language,
      license: row.license === null ? null : { spdx_id: row.license },
      updated_at: row.github_updated_at,
      pushed_at: row.pushed_at,
    },
  }))
}

/**
 * Records one inspection pass.
 *
 * The write path used to be three UPDATEs against a single plugin row — it
 * relocated that row to wherever the bundle turned out to live and wrote the
 * verdict there. With one row per repository to work with, a monorepo could
 * never publish more than one of its packages, and the relocation left the
 * `(repository_id, '')` slot free for the next scan to refill with a row
 * nothing could ever resolve.
 *
 * Every accepted manifest is upserted as its own plugin now, and the plugins a
 * finished sweep did not re-confirm are retired. Sweep membership is decided by
 * `git_checked_at` against the repository's `sweep_started_at`, not by
 * `last_seen_at`: `git_checked_at` is written here and nowhere else, so a
 * catalog sync landing mid-sweep cannot make a vanished plugin look alive, and
 * a placeholder that was never inspected (NULL) retires on the first sweep
 * rather than surviving a timestamp tie.
 */
export async function saveRepositoryInspections(
  db: D1Database,
  inspections: RepositoryInspection[],
  now = new Date().toISOString(),
  headSha: string | null = null,
): Promise<void> {
  if (inspections.length === 0) return
  for (const inspection of inspections) {
    const statements: D1PreparedStatement[] = []
    const sweepComplete = inspection.nextManifestCursor === null

    // A pass that starts at offset 0 starts a sweep. Stamping before the
    // upserts is what makes `git_checked_at < sweep_started_at` mean "this
    // sweep never saw you".
    if (inspection.sweepRestarted) {
      statements.push(db.prepare(
        'UPDATE catalog_repositories SET sweep_started_at = ?, updated_at = ? WHERE github_id = ?',
      ).bind(now, now, inspection.githubId))
    }

    for (const packageInfo of inspection.packages) {
      const pluginPath = pluginPathFromPackagePath(packageInfo.path)
      statements.push(
        // `normalized_plugin_id` is UNIQUE across the whole table while the
        // conflict target below is the case-SENSITIVE primary key, so a stale
        // row differing only in case — `packages/app` renamed to `packages/App`,
        // or the same package copied under a second directory — is invisible to
        // ON CONFLICT and the INSERT raises a constraint error instead. A D1
        // batch is one transaction: that error rolls the pass back, leaves the
        // cursor where it was, and every later run collides identically, so the
        // whole catalog stops updating. Clearing the crawler's own stale row
        // first is what keeps a rename from wedging the crawler.
        db.prepare(
          `DELETE FROM catalog_plugins
            WHERE repository_id = (SELECT id FROM catalog_repositories WHERE github_id = ?)
              AND from_pr = 0
              AND plugin_path <> ?
              AND (
                normalized_plugin_id = lower(
                  (SELECT r.normalized_full_name FROM catalog_repositories r
                    WHERE r.github_id = ?)
                  || CASE WHEN ? = '' THEN '' ELSE '/' || ? END
                )
                OR package_name = ?
              )
              AND (git_checked_at IS NULL OR git_checked_at < COALESCE(
                (SELECT sweep_started_at FROM catalog_repositories WHERE github_id = ?), ?
              ))`,
        ).bind(
          inspection.githubId, pluginPath, inspection.githubId, pluginPath, pluginPath,
          packageInfo.name, inspection.githubId, now,
        ),
      )
      statements.push(db.prepare(
        // The conflict clause lists crawler-owned columns only. curated_*,
        // from_pr and pr_reference are absent on purpose — 0005 gives them to
        // the submission, and a re-crawl that overwrote a reviewed description
        // with a GitHub blurb is exactly what that split exists to prevent.
        // plugin_id is left alone for the same reason it always was: it is
        // covered by UNIQUE(normalized_plugin_id), and rebuilding it on every
        // pass would turn a repository rename into a failed batch.
        `INSERT INTO catalog_plugins (
           repository_id, plugin_id, normalized_plugin_id, plugin_path,
           manifest_path, package_name, package_version, bundle_patch,
           git_entry_point, git_entry_committed, git_has_prepare,
           git_status, git_code, git_head_sha, git_checked_at,
           validation_status, validation_code, validation_reason,
           first_seen_at, last_seen_at, created_at, updated_at
         )
         SELECT r.id,
                r.full_name || CASE WHEN ? = '' THEN '' ELSE '/' || ? END,
                lower(r.normalized_full_name || CASE WHEN ? = '' THEN '' ELSE '/' || ? END),
                ?,
                ?, ?, ?, ?,
                ?, ?, ?,
                'ok', ?, ?, ?,
                'accepted', NULL, NULL,
                ?, ?, ?, ?
           FROM catalog_repositories r
          WHERE r.github_id = ?
            -- Whatever survived the DELETE above owns this identity: either a
            -- curated row, which only a submission may move, or a sibling this
            -- same sweep already confirmed. Standing down keeps the first path
            -- in sweep order winning, exactly as the in-pass de-duplication
            -- decides it, instead of the last pass to run.
            AND NOT EXISTS (
              SELECT 1 FROM catalog_plugins other
               WHERE other.repository_id = r.id
                 AND other.plugin_path <> ?
                 AND (
                   other.normalized_plugin_id = lower(
                     r.normalized_full_name || CASE WHEN ? = '' THEN '' ELSE '/' || ? END
                   )
                   OR other.package_name = ?
                 )
            )
         ON CONFLICT(repository_id, plugin_path) DO UPDATE SET
           manifest_path = excluded.manifest_path,
           package_name = excluded.package_name,
           package_version = excluded.package_version,
           bundle_patch = excluded.bundle_patch,
           git_entry_point = excluded.git_entry_point,
           git_entry_committed = excluded.git_entry_committed,
           git_has_prepare = excluded.git_has_prepare,
           git_status = excluded.git_status,
           git_code = excluded.git_code,
           git_head_sha = excluded.git_head_sha,
           git_checked_at = excluded.git_checked_at,
           validation_status = excluded.validation_status,
           validation_code = excluded.validation_code,
           validation_reason = excluded.validation_reason,
           last_seen_at = excluded.last_seen_at,
           updated_at = excluded.updated_at`,
      ).bind(
        pluginPath, pluginPath, pluginPath, pluginPath, pluginPath,
        packageInfo.path, packageInfo.name, packageInfo.version, packageInfo.patch,
        packageInfo.entryPoint, packageInfo.entryCommitted ? 1 : 0, packageInfo.hasPrepare ? 1 : 0,
        packageInfo.gitCode, headSha ?? null, now,
        now, now, now, now,
        inspection.githubId,
        pluginPath, pluginPath, pluginPath, packageInfo.name,
      ))
    }

    if (sweepComplete) {
      statements.push(
        // Retiring rather than deleting: a plugin that once published is worth
        // a reason. A crawler row loses its publication here (the snapshot
        // needs 'accepted'); a curated row keeps its own (from_pr = 1) because
        // only a catalog submission may retract one — but it still gets a
        // verdict, which is what finally drains it out of the queue.
        db.prepare(
          `UPDATE catalog_plugins
              SET validation_status = 'rejected',
                  validation_code = ?,
                  validation_reason = ?,
                  git_status = 'absent',
                  git_code = 'manifest_missing',
                  git_checked_at = ?,
                  updated_at = ?
            WHERE repository_id = (SELECT id FROM catalog_repositories WHERE github_id = ?)
              AND (
                git_checked_at IS NULL
                OR git_checked_at < (
                  SELECT COALESCE(sweep_started_at, ?)
                    FROM catalog_repositories WHERE github_id = ?
                )
              )
              AND NOT (validation_status = 'rejected' AND git_status = 'absent')`,
        ).bind(
          inspection.code ?? 'bundle_absent',
          inspection.reason ?? 'No manifest at this path declares dsh.bundle',
          now, now, inspection.githubId, now, inspection.githubId,
        ),
        // The placeholder `upsertDiscoveredRepositories` seeds so the queue has
        // something to inspect. Once the sweep has spoken it is either a real
        // root plugin (upserted above, so package_name is set) or bookkeeping
        // that would otherwise sit in the catalog as a rejected phantom.
        //
        // The sibling requirement is load-bearing, not tidiness. A repository
        // that declares no bundle anywhere ends the sweep with this row as its
        // ONLY row, carrying the verdict. Delete it and the repository has no
        // plugin rows at all, so the next discovery pass satisfies the
        // `NOT EXISTS` guard and seeds a fresh pending placeholder — which puts
        // the repository straight back in the queue. That is the phantom-row
        // churn this whole change exists to end, and thousands of topic-tagged
        // repositories declare no bundle, so it would be the common case rather
        // than the corner one.
        db.prepare(
          `DELETE FROM catalog_plugins
            WHERE repository_id = (SELECT id FROM catalog_repositories WHERE github_id = ?)
              AND plugin_path = ''
              AND from_pr = 0
              AND package_name IS NULL
              AND EXISTS (
                SELECT 1 FROM catalog_plugins sibling
                 WHERE sibling.repository_id = catalog_plugins.repository_id
                   AND sibling.plugin_path <> ''
              )`,
        ).bind(inspection.githubId),
      )
    }

    statements.push(
      // last_scanned_at stays a repository fact: it paces the crawler, and the
      // queue reads it against pushed_at to decide who needs re-checking.
      sweepComplete
        ? db.prepare(
            `UPDATE catalog_repositories
                SET manifest_cursor = NULL, sweep_started_at = NULL,
                    last_scanned_at = ?, updated_at = ?
              WHERE github_id = ?`,
          ).bind(now, now, inspection.githubId)
        : db.prepare(
            `UPDATE catalog_repositories
                SET manifest_cursor = ?, last_scanned_at = ?, updated_at = ?
              WHERE github_id = ?`,
          ).bind(inspection.nextManifestCursor, now, now, inspection.githubId),
    )

    // One batch per repository: a monorepo can contribute more statements than
    // D1 accepts in a single batch when several are inspected in one chunk.
    await db.batch(statements)
  }
}

export async function saveCatalogMetrics(
  db: D1Database,
  plugins: CatalogPlugin[],
  now = new Date().toISOString(),
): Promise<void> {
  if (plugins.length === 0) return
  // Stars and forks are repository facts: sibling plugins of one monorepo would
  // otherwise issue identical UPDATEs in the same batch.
  const byRepository = new Map<string, CatalogPlugin>()
  for (const plugin of plugins) {
    const key = normalizeRepositoryName(`${plugin.owner}/${plugin.repository}`)
    if (!byRepository.has(key)) byRepository.set(key, plugin)
  }
  for (const group of chunks([...byRepository.values()], 50)) {
    await db.batch(group.map((plugin) => db.prepare(
      `UPDATE catalog_repositories
          SET stars = ?, forks = ?, pushed_at = ?, github_updated_at = ?, updated_at = ?
        WHERE normalized_full_name = ?
          AND (stars IS NOT ? OR forks IS NOT ? OR pushed_at IS NOT ? OR github_updated_at IS NOT ?)`,
    ).bind(
      plugin.stars,
      plugin.forks,
      plugin.pushedAt,
      plugin.updatedAt,
      now,
      normalizeRepositoryName(`${plugin.owner}/${plugin.repository}`),
      plugin.stars,
      plugin.forks,
      plugin.pushedAt,
      plugin.updatedAt,
    )))
  }
}

export async function markMissingTopicRepositories(
  db: D1Database,
  runId: string,
  now = new Date().toISOString(),
): Promise<void> {
  await db.prepare(
    `UPDATE catalog_repositories
        SET from_topic = 0, updated_at = ?
      WHERE from_topic = 1
        AND (topic_last_run_id IS NULL OR topic_last_run_id <> ?)`,
  ).bind(now, runId).run()
}

/**
 * The leaf directory of a monorepo subpackage, or null for a root plugin.
 *
 * Deliberately not the manifest's `name`: catalog names are compared and
 * sorted against repository names everywhere else, and `@scope/thing` sorts
 * and reads badly next to them. The frontend reaches the same answer from the
 * id alone (`pluginListIdentity`), so the two agree.
 */
function subpackageName(pluginPath: string): string | null {
  const leaf = pluginPath.split('/').filter(Boolean).at(-1)
  return leaf === undefined || leaf.length === 0 ? null : leaf
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export async function loadCatalogSnapshotFromD1(
  db: D1Database,
  now = new Date().toISOString(),
): Promise<StoredCatalogSnapshot | null> {
  // A repository with curated metadata contributes one plugin per metadata row
  // (a monorepo may contribute several); a topic-only repository contributes
  // exactly one plugin, located at its accepted manifest's directory.
  const result = await db.prepare(
    `SELECT r.full_name, r.owner, r.repository_name, r.html_url, r.github_description,
            r.stars, r.forks, r.pushed_at, r.github_updated_at,
            p.plugin_path, p.plugin_id,
            p.curated_name, p.curated_category,
            p.curated_description_en, p.curated_description_zh, p.curated_added,
            p.ai_category, p.ai_description_en, p.ai_description_zh,
            p.git_code, p.git_has_prepare, p.git_head_sha, p.git_checked_at,
            p.npm_package_name, p.npm_binding, p.npm_bundle_declared,
            p.npm_version, p.npm_checked_at
       FROM catalog_plugins p
       JOIN catalog_repositories r ON r.id = p.repository_id
      WHERE p.from_pr = 1
         OR (r.from_topic = 1 AND p.validation_status = 'accepted')
      ORDER BY r.normalized_full_name, p.plugin_path`,
  ).all<CatalogRow>()
  if (result.results.length === 0) return null

  const categories = categoryLabelMap()
  // A plugin counts as unclassified only when neither a curator nor the
  // classifier has given it a category. The `?? null` mirrors the fallback used
  // to build each row below, so this stays true for a row whose ai_category is
  // absent rather than null.
  if (result.results.some((row) => (row.curated_category ?? row.ai_category ?? null) === null)) {
    categories[UNCLASSIFIED_CATEGORY.id] = { ...UNCLASSIFIED_CATEGORY.label }
  }
  const plugins = result.results.map<CatalogPlugin>((row) => {
    const description = row.github_description ?? `${row.full_name} discovered from GitHub.`
    // The plugin row owns its id: inspection moves a discovered plugin to its
    // manifest's directory, so a nested monorepo bundle yields the `#path:`
    // install spec pnpm needs instead of a broken repository-root one.
    const id = row.plugin_id
    return {
      ...emptyInstallMetrics(),
      id,
      // A monorepo's packages share one repository name, so falling back to it
      // published a dozen identically-named plugins whose only difference was
      // a URL fragment. The directory a package lives in is the name its
      // author gave it, and it is what `#path:` installs.
      name: row.curated_name ?? subpackageName(row.plugin_path) ?? row.repository_name,
      owner: row.owner,
      url: row.html_url,
      repository: row.repository_name,
      // curated → ai → GitHub blurb. A curator always outranks the classifier,
      // and dropping a curated entry lets the AI value take over on its own.
      category: row.curated_category ?? row.ai_category ?? UNCLASSIFIED_CATEGORY.id,
      description: {
        en: row.curated_description_en ?? row.ai_description_en ?? description,
        zh: row.curated_description_zh ?? row.ai_description_zh ?? description,
      },
      install: pluginInstallCommand(id),
      // Facts in, verdicts out: the badge is derived here rather than stored,
      // so changing how a fact is judged is a deploy, not a re-crawl.
      installMethods: deriveInstallMethods(
        id,
        {
          code: (row.git_code as GitInstallCode | null) ?? 'not_checked',
          hasPrepare: row.git_has_prepare === 1,
          headSha: row.git_head_sha,
          checkedAt: row.git_checked_at,
        },
        row.npm_package_name === null ? null : {
          packageName: row.npm_package_name,
          binding: row.npm_binding as NpmBinding,
          bundleDeclared: row.npm_bundle_declared === 1,
          version: row.npm_version,
          checkedAt: row.npm_checked_at,
        },
      ),
      added: row.curated_added ?? (row.github_updated_at ?? now).slice(0, 10),
      stars: row.stars,
      forks: row.forks,
      pushedAt: row.pushed_at,
      updatedAt: row.github_updated_at,
      latestReleaseAt: null,
      growth24h: null,
      growth7d: null,
      growth30d: null,
    }
  })
  const revision = await sha256(JSON.stringify({ categories, plugins }))
  return {
    generatedAt: now,
    registryUpdated: now.slice(0, 10),
    registryRevision: revision,
    metricCoverage: plugins.filter((plugin) => plugin.stars !== null).length,
    categories,
    plugins,
  }
}

export interface NpmProbeCandidate {
  pluginId: string
  packageName: string
  // The validator to send as `If-None-Match`; null when never probed.
  etag: string | null
  // Stable unique key the refresh sweep uses as its cursor.
  normalizedId: string
  // The stored status, so the caller can skip re-writing an unchanged result
  // (an `absent` package that is still absent has no ETag to answer 304, so it
  // would otherwise be rewritten every sweep).
  currentStatus: string
}

// A package is probed only when it is published here AND its own manifest named
// the package — the name comes from the repository, never from a guess.
const NPM_PROBE_ELIGIBLE = `p.package_name IS NOT NULL
        AND (p.from_pr = 1 OR (r.from_topic = 1 AND p.validation_status = 'accepted'))`

interface NpmProbeCandidateRow {
  plugin_id: string
  package_name: string
  npm_etag: string | null
  npm_status: string
  normalized_plugin_id: string
}

function toNpmProbeCandidate(row: NpmProbeCandidateRow): NpmProbeCandidate {
  return {
    pluginId: row.plugin_id,
    packageName: row.package_name,
    etag: row.npm_etag ?? null,
    normalizedId: row.normalized_plugin_id,
    currentStatus: row.npm_status,
  }
}

/**
 * Newly discovered packages that have never been probed.
 *
 * These are drained first each tick so a freshly submitted plugin earns its npm
 * badge within one cron rather than waiting for the rolling sweep to reach it.
 */
export async function loadNpmPendingProbes(
  db: D1Database,
  limit = 200,
): Promise<NpmProbeCandidate[]> {
  const result = await db.prepare(
    `SELECT p.plugin_id, p.package_name, p.npm_etag, p.npm_status, p.normalized_plugin_id
       FROM catalog_plugins p
       JOIN catalog_repositories r ON r.id = p.repository_id
      WHERE ${NPM_PROBE_ELIGIBLE}
        AND p.npm_status = 'pending'
      ORDER BY p.normalized_plugin_id
      LIMIT ?`,
  ).bind(limit).all<NpmProbeCandidateRow>()
  return result.results.map(toNpmProbeCandidate)
}

/**
 * The rolling re-check sweep over every eligible package, ordered by the stable
 * unique id and resumed from a cursor.
 *
 * Conditional requests make re-probing nearly free (a `304` is a header round
 * trip), so there is no freshness window: the sweep simply cycles through all
 * packages, and the caller persists the last id as the cursor. An empty cursor
 * starts from the beginning, which is also where a completed cycle wraps back
 * to. `npm_checked_at` is deliberately not consulted — it is not written on a
 * `304`, so ordering by it would stall on the same rows forever.
 */
export async function loadNpmSweepBatch(
  db: D1Database,
  limit: number,
  cursor = '',
): Promise<NpmProbeCandidate[]> {
  const result = await db.prepare(
    `SELECT p.plugin_id, p.package_name, p.npm_etag, p.npm_status, p.normalized_plugin_id
       FROM catalog_plugins p
       JOIN catalog_repositories r ON r.id = p.repository_id
      WHERE ${NPM_PROBE_ELIGIBLE}
        AND p.normalized_plugin_id > ?
      ORDER BY p.normalized_plugin_id
      LIMIT ?`,
  ).bind(cursor, limit).all<NpmProbeCandidateRow>()
  return result.results.map(toNpmProbeCandidate)
}

export interface NpmProbeRecord {
  pluginId: string
  packageName: string
  status: 'found' | 'absent' | 'error'
  httpStatus: number | null
  version: string | null
  repositoryUrl: string | null
  repositoryDirectory: string | null
  bundleDeclared: boolean
  entryPoint: string | null
  tarballUrl: string | null
  integrity: string | null
  binding: string
  // The validator to store for the next conditional request. `found` carries
  // npm's ETag; `absent` clears it (a 404 has none); `error` never reaches the
  // column at all.
  etag: string | null
}

/**
 * Records npm probe results.
 *
 * An `error` result updates only the bookkeeping columns: one registry outage
 * must not flip thousands of badges from verified to unverified. A `found` or
 * `absent` result is a real observation and replaces the previous one.
 */
export async function saveNpmProbes(
  db: D1Database,
  probes: NpmProbeRecord[],
  now = new Date().toISOString(),
): Promise<void> {
  if (probes.length === 0) return
  for (const group of chunks(probes, 40)) {
    await db.batch(group.map((probe) => (probe.status === 'error'
      ? db.prepare(
        `UPDATE catalog_plugins
            SET npm_status = 'error', npm_http_status = ?, npm_checked_at = ?, updated_at = ?
          WHERE normalized_plugin_id = ?`,
      ).bind(probe.httpStatus, now, now, normalizePluginId(probe.pluginId))
      : db.prepare(
        `UPDATE catalog_plugins
            SET npm_package_name = ?, npm_status = ?, npm_http_status = ?,
                npm_version = ?, npm_repository_url = ?, npm_repository_directory = ?,
                npm_bundle_declared = ?, npm_binding = ?, npm_etag = ?,
                npm_checked_at = ?, updated_at = ?
          WHERE normalized_plugin_id = ?`,
      ).bind(
        probe.packageName, probe.status, probe.httpStatus,
        probe.version, probe.repositoryUrl, probe.repositoryDirectory,
        probe.bundleDeclared ? 1 : 0, probe.binding, probe.etag,
        now, now, normalizePluginId(probe.pluginId),
      ))))
  }
}

/**
 * Fills in the GitHub facts for repositories that arrived through a submission.
 *
 * A submission gives us a name and nothing else, so those rows land with
 * `github_id` NULL — and the validation queue keys on `github_id`. Until this
 * runs, a curated plugin is published without anything ever inspecting it,
 * which is exactly how the catalog came to serve install commands that cannot
 * work. One request per repository, once.
 *
 * @returns how many repositories were hydrated.
 */
export async function hydrateCuratedRepositories(
  db: D1Database,
  client: { request: <T>(path: string) => Promise<T> },
  limit = 20,
  now = new Date().toISOString(),
): Promise<number> {
  const pending = await db.prepare(
    `SELECT r.id, r.full_name
       FROM catalog_repositories r
      WHERE r.github_id IS NULL
        AND EXISTS (SELECT 1 FROM catalog_plugins p WHERE p.repository_id = r.id AND p.from_pr = 1)
      ORDER BY r.id
      LIMIT ?`,
  ).bind(limit).all<{ id: number; full_name: string }>()
  if (pending.results.length === 0) return 0

  let hydrated = 0
  for (const row of pending.results) {
    const encoded = row.full_name.split('/').map(encodeURIComponent).join('/')
    let repository: GitHubRepository
    try {
      repository = await client.request<GitHubRepository>(`/repos/${encoded}`)
    } catch {
      // A deleted or private repository must not stall the queue behind it; the
      // next run tries again, and the plugin stays published meanwhile.
      continue
    }

    // GitHub redirects a renamed repository to its current name, so the id we
    // just fetched may already belong to another row — the same repository the
    // topic scan found under its new name. The two rows are one repository:
    // move this row's plugins onto the surviving one and drop the duplicate,
    // rather than failing on UNIQUE(github_id) forever.
    const clash = await db.prepare(
      'SELECT id, full_name, normalized_full_name FROM catalog_repositories WHERE github_id = ? AND id <> ?',
    ).bind(repository.id, row.id).first<{ id: number; full_name: string; normalized_full_name: string }>()

    if (clash !== null) {
      await db.batch([
        db.prepare(
          `INSERT INTO catalog_plugins (
             repository_id, plugin_id, normalized_plugin_id, plugin_path,
             from_pr, pr_reference,
             curated_name, curated_category, curated_description_en, curated_description_zh,
             curated_added, curated_updated_at,
             manifest_path, package_name, package_version, bundle_patch,
             validation_status, validation_code, validation_reason,
             first_seen_at, last_seen_at, created_at, updated_at
           )
           SELECT ?, ? || CASE WHEN p.plugin_path = '' THEN '' ELSE '/' || p.plugin_path END,
                  lower(? || CASE WHEN p.plugin_path = '' THEN '' ELSE '/' || p.plugin_path END),
                  p.plugin_path, p.from_pr, p.pr_reference,
                  p.curated_name, p.curated_category, p.curated_description_en, p.curated_description_zh,
                  p.curated_added, p.curated_updated_at,
                  p.manifest_path, p.package_name, p.package_version, p.bundle_patch,
                  p.validation_status, p.validation_code, p.validation_reason,
                  p.first_seen_at, p.last_seen_at, p.created_at, ?
             FROM catalog_plugins p
            WHERE p.repository_id = ?
           ON CONFLICT(repository_id, plugin_path) DO UPDATE SET
             from_pr = MAX(catalog_plugins.from_pr, excluded.from_pr),
             pr_reference = COALESCE(excluded.pr_reference, catalog_plugins.pr_reference),
             curated_name = COALESCE(excluded.curated_name, catalog_plugins.curated_name),
             curated_category = COALESCE(excluded.curated_category, catalog_plugins.curated_category),
             curated_description_en = COALESCE(excluded.curated_description_en, catalog_plugins.curated_description_en),
             curated_description_zh = COALESCE(excluded.curated_description_zh, catalog_plugins.curated_description_zh),
             curated_added = COALESCE(excluded.curated_added, catalog_plugins.curated_added),
             updated_at = excluded.updated_at`,
        ).bind(clash.id, clash.full_name, clash.normalized_full_name, now, row.id),
        // Cascades this row's remaining plugins away.
        db.prepare('DELETE FROM catalog_repositories WHERE id = ?').bind(row.id),
      ])
      hydrated += 1
      continue
    }

    await db.prepare(
      `UPDATE catalog_repositories
          SET github_id = ?, full_name = ?, normalized_full_name = ?, owner = ?, repository_name = ?,
              github_description = ?, default_branch = ?, stars = ?, forks = ?,
              language = ?, license = ?, github_updated_at = ?, pushed_at = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(
      repository.id, repository.full_name, normalizeRepositoryName(repository.full_name),
      repository.full_name.split('/')[0] ?? '', repository.name,
      repository.description, repository.default_branch,
      repository.stargazers_count, repository.forks_count, repository.language,
      repository.license?.spdx_id ?? null, repository.updated_at, repository.pushed_at,
      now, row.id,
    ).run()
    hydrated += 1
  }
  return hydrated
}

/** A plugin awaiting AI classification, with the only signals the classifier gets. */
export interface ClassificationCandidate {
  repositoryId: number
  pluginPath: string
  pluginId: string
  /** Manifest package name when known — the sharpest signal for a monorepo subpackage. */
  packageName: string | null
  repositoryName: string
  description: string | null
  stars: number | null
}

/** One classifier verdict, ready to be written onto the plugin's `ai_*` columns. */
export interface ClassificationResult {
  repositoryId: number
  pluginPath: string
  category: string
  descriptionEn: string
  descriptionZh: string
  descriptionOrigin: 'author_en' | 'author_zh' | 'generated'
}

/**
 * Plugins that still need an AI verdict, highest-starred first.
 *
 * Curated plugins are skipped on `curated_category IS NULL` alone: the column
 * ownership set up by 0005 means a curator's columns and the classifier's
 * columns cannot collide, so no source-table bookkeeping is needed.
 *
 * The published predicate matches `loadCatalogSnapshotFromD1`, so the queue can
 * never classify something the catalog does not show, nor skip something it does.
 *
 * Bumping `classifierVersion` re-enqueues every AI-owned row.
 */
export async function loadClassificationQueue(
  db: D1Database,
  classifierVersion: string,
  limit: number,
): Promise<ClassificationCandidate[]> {
  const result = await db.prepare(
    `SELECT p.repository_id, p.plugin_path, p.plugin_id, p.package_name,
            r.repository_name, r.github_description, r.stars
       FROM catalog_plugins p
       JOIN catalog_repositories r ON r.id = p.repository_id
      WHERE (p.from_pr = 1 OR (r.from_topic = 1 AND p.validation_status = 'accepted'))
        AND p.curated_category IS NULL
        AND (p.ai_classifier_version IS NULL OR p.ai_classifier_version <> ?)
      ORDER BY r.stars DESC, p.plugin_id
      LIMIT ?`,
  ).bind(classifierVersion, limit).all<{
    repository_id: number
    plugin_path: string
    plugin_id: string
    package_name: string | null
    repository_name: string
    github_description: string | null
    stars: number | null
  }>()
  return result.results.map((row) => ({
    repositoryId: row.repository_id,
    pluginPath: row.plugin_path,
    pluginId: row.plugin_id,
    packageName: row.package_name,
    repositoryName: row.repository_name,
    description: row.github_description,
    stars: row.stars,
  }))
}

/**
 * Write verdicts onto the plugin rows.
 *
 * An UPDATE rather than an upsert: the plugin row is created by the crawler or
 * by a catalog submission, and the classifier has no business inventing one.
 * `curated_category IS NULL` is repeated here so that a submission landing
 * between the queue read and this write cannot be overwritten.
 */
export async function saveClassifications(
  db: D1Database,
  entries: ClassificationResult[],
  classifierVersion: string,
  now = new Date().toISOString(),
): Promise<number> {
  let written = 0
  for (const group of chunks(entries, 40)) {
    const results = await db.batch(group.map((entry) => db.prepare(
      `UPDATE catalog_plugins
          SET ai_category = ?, ai_description_en = ?, ai_description_zh = ?,
              ai_description_origin = ?, ai_classifier_version = ?, ai_classified_at = ?,
              updated_at = ?
        WHERE repository_id = ? AND plugin_path = ? AND curated_category IS NULL`,
    ).bind(
      entry.category,
      entry.descriptionEn,
      entry.descriptionZh,
      entry.descriptionOrigin,
      classifierVersion,
      now,
      now,
      entry.repositoryId,
      entry.pluginPath,
    )))
    written += results.reduce((sum, item) => sum + Number(item.meta?.changes ?? 0), 0)
  }
  return written
}

/** Neurons already spent on classification during the UTC day containing `now`. */
export async function neuronsSpentToday(
  db: D1Database,
  now = new Date().toISOString(),
): Promise<number> {
  const value = await getCatalogState(db, `classify_neurons_${now.slice(0, 10)}`)
  return value === null ? 0 : Number(value) || 0
}

/** Add this round's neuron spend to the running UTC-day total. */
export async function recordNeuronSpend(
  db: D1Database,
  neurons: number,
  now = new Date().toISOString(),
): Promise<number> {
  const total = (await neuronsSpentToday(db, now)) + neurons
  await setCatalogState(db, `classify_neurons_${now.slice(0, 10)}`, String(Math.round(total)), now)
  return total
}
