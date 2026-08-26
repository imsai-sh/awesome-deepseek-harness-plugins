import type { CatalogPlugin, LocalizedText, StoredCatalogSnapshot } from '../types'
import { categoryLabelMap, UNCLASSIFIED_CATEGORY } from './categories'
import { emptyInstallMetrics } from './install-metrics'
import { deriveInstallMethods } from './install-methods'
import type { GitInstallCode, NpmBinding } from './install-methods'
import { normalizePluginId, parsePluginId, pluginInstallCommand } from './plugin-id'

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
  curated_updated_at: string | null
  row_updated_at: string | null
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
  package_name: string | null
  npm_package_name: string | null
  npm_binding: string
  npm_bundle_declared: number
  npm_version: string | null
  npm_checked_at: string | null
  npm_downloads_7d: number | null
  npm_downloads_start: string | null
  npm_downloads_end: string | null
}

export interface PublishedPackageVersion {
  version: string | null
  checkedAt: string | null
}

/**
 * Reads one published package version directly from D1. Update manifests use
 * this narrow query so a package release does not wait for the much larger
 * catalog snapshot to be rebuilt and copied into KV.
 */
export async function loadPublishedPackageVersion(
  db: D1Database,
  pluginIds: readonly string[],
  packageName: string,
): Promise<PublishedPackageVersion | null> {
  const normalizedIds = [...new Set(pluginIds.map((id) => normalizePluginId(id)))]
  if (normalizedIds.length === 0) return null
  const placeholders = normalizedIds.map(() => '?').join(', ')
  const row = await db.prepare(
    `SELECT npm_version AS version, npm_checked_at AS checked_at
       FROM catalog_plugins
      WHERE normalized_plugin_id IN (${placeholders})
        AND npm_package_name = ?
        AND npm_status = 'found'
        AND npm_bundle_declared = 1
        AND npm_version IS NOT NULL
      ORDER BY CASE normalized_plugin_id WHEN ? THEN 0 ELSE 1 END,
               npm_checked_at DESC
      LIMIT 1`,
  ).bind(...normalizedIds, packageName, normalizedIds[0]).first<{
    version: string | null
    checked_at: string | null
  }>()
  return row ? { version: row.version, checkedAt: row.checked_at } : null
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

/** Splits a curated entry id into its repository prefix and in-repo path. */
function curatedEntryParts(id: string): { owner: string; name: string; path: string } {
  const parts = parsePluginId(id)
  if (parts === null) throw new Error(`Invalid plugin id: ${id}`)
  return { owner: parts.owner, name: parts.repository, path: parts.path }
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

  // Retired plugins are dropped BEFORE the upserts. A plugin the topic scan
  // also found keeps its row and simply loses its curated columns.
  //
  // Identity collisions no longer abort anything: normalized_plugin_id is not
  // UNIQUE (0013). A renamed GitHub repository can leave a stale row holding
  // the same id a curated entry re-introduces under the old name — both rows
  // are allowed to coexist, the snapshot picks a deterministic winner, and
  // rows whose repository no longer resolves are garbage-collected out of
  // band. Within ONE repository, though, a same-identity sibling at another
  // path (an entry that merely re-cased its path) is our own stale leftover,
  // not a rename artifact, so the upsert below clears it in the same batch.
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

  // 20 entries × 2 statements each keeps a batch at the 40-statement size D1
  // has been serving all along.
  for (const group of chunks(entries, 20)) {
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
        // The primary key (repository_id, plugin_path) is case-sensitive while
        // the identity is not: an entry that re-cases its path targets a new
        // PK slot and would leave the old row behind as a permanent duplicate
        // the out-of-band GC can never collect (its repository still
        // resolves). Same-repository siblings holding this identity at any
        // other path are stale by definition, so clear them first.
        `DELETE FROM catalog_plugins
          WHERE repository_id = ?
            AND normalized_plugin_id = ?
            AND plugin_path <> ?`,
      ).bind(id, normalizePluginId(entry.id), path))
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

/** ISO-8601 strings compare lexicographically; an absent timestamp loses. */
function fresherRow(candidate: CatalogRow, incumbent: CatalogRow): boolean {
  const candidateCurated = candidate.curated_updated_at ?? ''
  const incumbentCurated = incumbent.curated_updated_at ?? ''
  if (candidateCurated !== incumbentCurated) return candidateCurated > incumbentCurated
  return (candidate.row_updated_at ?? '') > (incumbent.row_updated_at ?? '')
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
            p.curated_updated_at, p.updated_at AS row_updated_at,
            p.curated_name, p.curated_category,
            p.curated_description_en, p.curated_description_zh, p.curated_added,
            p.ai_category, p.ai_description_en, p.ai_description_zh,
            p.git_code, p.git_has_prepare, p.git_head_sha, p.git_checked_at,
            p.package_name,
            p.npm_package_name, p.npm_binding, p.npm_bundle_declared,
            p.npm_version, p.npm_checked_at,
            p.npm_downloads_7d, p.npm_downloads_start, p.npm_downloads_end
       FROM catalog_plugins p
       JOIN catalog_repositories r ON r.id = p.repository_id
      WHERE p.from_pr = 1
         OR (r.from_topic = 1 AND p.validation_status = 'accepted')
      ORDER BY r.normalized_full_name, p.plugin_path`,
  ).all<CatalogRow>()
  if (result.results.length === 0) return null

  // A duplicated identity — rows a repository rename leaves behind now that
  // normalized_plugin_id is not UNIQUE (0013) — must not race for lookups
  // keyed by id: the row with the freshest curated write wins, then the
  // freshest row overall. D1 keeps every row for the out-of-band GC; the
  // projection carries exactly one per identity, so detail lookups, list
  // keys, and the sitemap never see the stale twin.
  const winners = new Map<string, CatalogRow>()
  for (const row of result.results) {
    const key = normalizePluginId(row.plugin_id)
    const incumbent = winners.get(key)
    if (incumbent === undefined || fresherRow(row, incumbent)) winners.set(key, row)
  }
  const rows = [...winners.values()]

  const categories = categoryLabelMap()
  // A plugin counts as unclassified only when neither a curator nor the
  // classifier has given it a category. The `?? null` mirrors the fallback used
  // to build each row below, so this stays true for a row whose ai_category is
  // absent rather than null.
  if (rows.some((row) => (row.curated_category ?? row.ai_category ?? null) === null)) {
    categories[UNCLASSIFIED_CATEGORY.id] = { ...UNCLASSIFIED_CATEGORY.label }
  }
  const plugins = rows.map<CatalogPlugin>((row) => {
    const description = row.github_description ?? `${row.full_name} discovered from GitHub.`
    // The plugin row owns its id: inspection moves a discovered plugin to its
    // manifest's directory, so a nested monorepo bundle yields the `#path:`
    // install spec pnpm needs instead of a broken repository-root one.
    const id = row.plugin_id
    const installMethods = deriveInstallMethods(
      id,
      {
        code: (row.git_code as GitInstallCode | null) ?? 'not_checked',
        hasPrepare: row.git_has_prepare === 1,
        packageName: row.package_name,
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
    )
    // Download counts belong to the published npm package, not to every fork
    // or vendored copy that happens to declare the same package name. A
    // repository mismatch remains useful for install diagnostics, but it must
    // never turn the original package's popularity into the fork's metric.
    const ownsNpmDownloads = row.npm_binding !== 'mismatch'
    return {
      ...emptyInstallMetrics(),
      npmDownloads7d: ownsNpmDownloads ? row.npm_downloads_7d : null,
      npmDownloadsStart: ownsNpmDownloads ? row.npm_downloads_start : null,
      npmDownloadsEnd: ownsNpmDownloads ? row.npm_downloads_end : null,
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
      // The frozen v1 surfaces require a non-empty official CLI command here.
      // A plugin with no npm package records its source-install command as the
      // value; user-facing surfaces offer only npm (offeredInstallCommand).
      install: installMethods[0]?.command ?? pluginInstallCommand(id),
      // Facts in, verdicts out: the badge is derived here rather than stored,
      // so changing how a fact is judged is a deploy, not a re-crawl.
      installMethods,
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