import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  loadCatalogSnapshotFromD1,
  loadPublishedPackageVersion,
  normalizeRepositoryName,
  syncCuratedEntries,
  type CuratedCatalogEntry,
} from '../worker/lib/catalog-db'

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new SqliteD1Statement(this.database, this.sql, params)
  }

  async all<T>() {
    return { results: this.database.prepare(this.sql).all(...this.params) as T[] }
  }

  async first<T>() {
    return (this.database.prepare(this.sql).get(...this.params) as T | undefined) ?? null
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.params)
    return { success: true, meta: { changes: Number(result.changes) } }
  }
}

function sqliteD1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new SqliteD1Statement(database, sql)
    },
    async batch(statements: SqliteD1Statement[]) {
      const results = []
      for (const statement of statements) results.push(await statement.run())
      return results
    },
  } as unknown as D1Database
}

/** The migrated production shape: a repository, and the plugins it publishes. */
function catalogDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  for (const migration of ['0002_plugin_catalog.sql', '0005_catalog_plugins.sql',
    '0006_ai_classification.sql', '0009_manifest_sweep.sql', '0010_npm_etag.sql',
    '0011_npm_downloads.sql', '0012_npm_download_ownership.sql',
    '0013_relax_plugin_id_uniqueness.sql']) {
    database.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'))
  }
  return database
}

function curatedEntry(overrides: Partial<CuratedCatalogEntry> = {}): CuratedCatalogEntry {
  return {
    id: 'Owner/curated-plugin',
    name: 'curated-plugin',
    repository: 'https://github.com/Owner/curated-plugin',
    category: 'tools',
    description: { en: 'English', zh: '中文' },
    added: '2026-08-15',
    ...overrides,
  }
}

const NOW = '2026-08-16T00:00:00.000Z'

function seedRepository(
  database: DatabaseSync,
  overrides: Record<string, string | number | null> = {},
): void {
  const row = {
    github_id: 42 as number | null,
    full_name: 'Scan/Repo',
    normalized_full_name: 'scan/repo',
    owner: 'Scan',
    repository_name: 'Repo',
    from_topic: 1,
    ...overrides,
  }
  database.prepare(`
    INSERT INTO catalog_repositories (github_id, full_name, normalized_full_name, owner,
      repository_name, html_url, from_topic, first_seen_at, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.github_id, row.full_name, row.normalized_full_name, row.owner, row.repository_name,
    `https://github.com/${row.full_name}`, row.from_topic, NOW, NOW, NOW, NOW)
}

/** Adds a plugin to the most recently seeded repository. */
function seedPlugin(
  database: DatabaseSync,
  repositoryFullName: string,
  overrides: Record<string, string | number | null> = {},
): void {
  const id = database.prepare('SELECT id, full_name FROM catalog_repositories WHERE normalized_full_name = ?')
    .get(repositoryFullName.toLowerCase()) as { id: number; full_name: string }
  const row = {
    plugin_path: '',
    validation_status: 'pending',
    manifest_path: null as string | null,
    ...overrides,
  }
  const pluginId = row.plugin_path === ''
    ? id.full_name
    : `${id.full_name}/${row.plugin_path}`
  database.prepare(`
    INSERT INTO catalog_plugins (repository_id, plugin_id, normalized_plugin_id, plugin_path,
      manifest_path, validation_status, first_seen_at, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id.id, pluginId, pluginId.toLowerCase(), row.plugin_path, row.manifest_path,
    row.validation_status, NOW, NOW, NOW, NOW)
}

describe('curated catalog reconciliation', () => {
  it('writes the repository and the plugin for every entry', async () => {
    const database = catalogDatabase()

    const result = await syncCuratedEntries(sqliteD1(database), [curatedEntry()], NOW)

    expect(result).toEqual({ total: 1, removedSources: 0 })
    expect(database.prepare(
      'SELECT full_name, normalized_full_name, owner, repository_name, html_url FROM catalog_repositories',
    ).all()).toEqual([{
      full_name: 'Owner/curated-plugin',
      normalized_full_name: 'owner/curated-plugin',
      owner: 'Owner',
      repository_name: 'curated-plugin',
      html_url: 'https://github.com/Owner/curated-plugin',
    }])
    expect(database.prepare(`
      SELECT plugin_id, plugin_path, from_pr, curated_name, curated_category,
             curated_description_en, curated_description_zh, curated_added
        FROM catalog_plugins
    `).all()).toEqual([{
      plugin_id: 'Owner/curated-plugin',
      plugin_path: '',
      from_pr: 1,
      curated_name: 'curated-plugin',
      curated_category: 'tools',
      curated_description_en: 'English',
      curated_description_zh: '中文',
      curated_added: '2026-08-15',
    }])
    database.close()
  })

  it('stores several subpackage plugins of one repository against a single repository row', async () => {
    const database = catalogDatabase()

    const result = await syncCuratedEntries(sqliteD1(database), [
      curatedEntry({ id: 'Owner/monorepo/packages/foo', name: 'foo', repository: 'https://github.com/Owner/monorepo' }),
      curatedEntry({ id: 'Owner/monorepo/packages/bar', name: 'bar', repository: 'https://github.com/Owner/monorepo' }),
    ], NOW)

    expect(result).toEqual({ total: 2, removedSources: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM catalog_repositories').get())
      .toEqual({ count: 1 })
    expect(database.prepare(
      'SELECT plugin_path, plugin_id, curated_name FROM catalog_plugins ORDER BY plugin_path',
    ).all()).toEqual([
      { plugin_path: 'packages/bar', plugin_id: 'Owner/monorepo/packages/bar', curated_name: 'bar' },
      { plugin_path: 'packages/foo', plugin_id: 'Owner/monorepo/packages/foo', curated_name: 'foo' },
    ])
    database.close()
  })

  it('reconciles a dropped subpackage without evicting its surviving sibling', async () => {
    const database = catalogDatabase()
    const db = sqliteD1(database)
    const foo = curatedEntry({ id: 'Owner/monorepo/packages/foo', name: 'foo', repository: 'https://github.com/Owner/monorepo' })
    const bar = curatedEntry({ id: 'Owner/monorepo/packages/bar', name: 'bar', repository: 'https://github.com/Owner/monorepo' })

    await syncCuratedEntries(db, [foo, bar], NOW)
    await syncCuratedEntries(db, [foo], '2026-08-16T02:00:00.000Z')

    expect(database.prepare('SELECT plugin_id FROM catalog_plugins').all())
      .toEqual([{ plugin_id: 'Owner/monorepo/packages/foo' }])
    database.close()
  })

  it('re-cases a plugin path without tripping the case-insensitive id index', async () => {
    const database = catalogDatabase()
    const db = sqliteD1(database)

    await syncCuratedEntries(db, [curatedEntry({
      id: 'Owner/monorepo/packages/DshUi', name: 'DshUi', repository: 'https://github.com/Owner/monorepo',
    })], NOW)
    // Correcting the path's case keeps the same normalized id, so the stale row
    // has to go before the new one lands.
    await syncCuratedEntries(db, [curatedEntry({
      id: 'Owner/monorepo/packages/dsh-ui', name: 'dsh-ui', repository: 'https://github.com/Owner/monorepo',
    })], '2026-08-16T02:00:00.000Z')

    expect(database.prepare('SELECT plugin_path, plugin_id FROM catalog_plugins').all())
      .toEqual([{ plugin_path: 'packages/dsh-ui', plugin_id: 'Owner/monorepo/packages/dsh-ui' }])
    database.close()
  })

  it('is idempotent and applies curated updates without a revision gate', async () => {
    const database = catalogDatabase()
    const db = sqliteD1(database)

    await syncCuratedEntries(db, [curatedEntry()], NOW)
    const updated = await syncCuratedEntries(db, [
      curatedEntry({ category: 'dev', description: { en: 'Updated', zh: '更新' } }),
    ], '2026-08-16T02:00:00.000Z')

    expect(updated).toEqual({ total: 1, removedSources: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM catalog_repositories').get())
      .toEqual({ count: 1 })
    expect(database.prepare('SELECT curated_category, curated_description_en FROM catalog_plugins').get())
      .toEqual({ curated_category: 'dev', curated_description_en: 'Updated' })
    database.close()
  })

  it('retires a curated plugin without deleting one the topic scan also found', async () => {
    const database = catalogDatabase()
    const db = sqliteD1(database)
    // Discovered and accepted, then also curated.
    seedRepository(database, {
      github_id: 99, full_name: 'Owner/both', normalized_full_name: 'owner/both',
      owner: 'Owner', repository_name: 'both',
    })
    seedPlugin(database, 'owner/both', { validation_status: 'accepted' })
    await syncCuratedEntries(db, [
      curatedEntry({ id: 'Owner/both', name: 'both', repository: 'https://github.com/Owner/both' }),
      curatedEntry(),
    ], NOW)

    // Dropping both submissions leaves the accepted plugin in place, stripped of
    // its curated columns; the never-validated one goes away entirely.
    const result = await syncCuratedEntries(db, [], '2026-08-16T02:00:00.000Z')

    expect(result.total).toBe(0)
    expect(database.prepare(
      'SELECT plugin_id, from_pr, curated_name, validation_status FROM catalog_plugins',
    ).all()).toEqual([
      { plugin_id: 'Owner/both', from_pr: 0, curated_name: null, validation_status: 'accepted' },
    ])
    // Repository rows are never deleted: production data is preserved.
    expect(database.prepare('SELECT COUNT(*) AS count FROM catalog_repositories').get())
      .toEqual({ count: 2 })
    database.close()
  })

  it('survives a GitHub rename that leaves a stale row holding the same id', async () => {
    const database = catalogDatabase()
    const db = sqliteD1(database)
    const entry = curatedEntry({
      id: 'Owner/old-name',
      name: 'old-name',
      repository: 'https://github.com/Owner/old-name',
    })
    await syncCuratedEntries(db, [entry], NOW)

    // The crawler renames the repository row in place; the plugin row keeps
    // its pre-rename id. Exactly what a real GitHub rename leaves behind.
    database.prepare(
      `UPDATE catalog_repositories
          SET full_name = 'Owner/new-name', normalized_full_name = 'owner/new-name',
              repository_name = 'new-name'
        WHERE normalized_full_name = 'owner/old-name'`,
    ).run()

    // The curated catalog still lists the old name. This used to raise
    // UNIQUE constraint failed and roll back the whole batch (issue #90);
    // identity collisions are tolerated now, so the sync must succeed.
    const result = await syncCuratedEntries(db, [entry], '2026-08-17T00:00:00.000Z')
    expect(result.total).toBe(1)

    // Two rows hold the identity: the stale one under the renamed repository
    // and the fresh curated one under the re-created old name.
    const rows = database.prepare(
      `SELECT r.normalized_full_name AS repo, p.normalized_plugin_id AS id
         FROM catalog_plugins p JOIN catalog_repositories r ON r.id = p.repository_id
        ORDER BY r.normalized_full_name`,
    ).all()
    expect(rows).toEqual([
      { repo: 'owner/new-name', id: 'owner/old-name' },
      { repo: 'owner/old-name', id: 'owner/old-name' },
    ])

    // Both rows stay in D1 for the out-of-band GC, but the projection picks
    // one winner per identity — the row with the freshest curated write, here
    // the re-synced entry under the re-created old-name repository.
    const snapshot = await loadCatalogSnapshotFromD1(db, '2026-08-17T00:00:00.000Z')
    const published = snapshot?.plugins.filter((plugin) => plugin.id.toLowerCase() === 'owner/old-name')
    expect(published).toHaveLength(1)
    expect(published?.[0]?.url).toBe('https://github.com/Owner/old-name')

    // Idempotent: re-running the same sync does not mint a third row.
    await syncCuratedEntries(db, [entry], '2026-08-18T00:00:00.000Z')
    expect(database.prepare('SELECT COUNT(*) AS count FROM catalog_plugins').get())
      .toEqual({ count: 2 })
    database.close()
  })

  it('replaces, not duplicates, an entry whose path only changed case', async () => {
    const database = catalogDatabase()
    const db = sqliteD1(database)

    await syncCuratedEntries(db, [curatedEntry({
      id: 'Owner/monorepo/packages/Foo', name: 'Foo', repository: 'https://github.com/Owner/monorepo',
    })], NOW)
    // 'Foo' -> 'foo' keeps the same normalized id, so the retire step cannot
    // catch the old row; the per-entry same-repository cleanup must. Without
    // it this left a permanent duplicate no out-of-band GC could collect,
    // because the repository still resolves.
    await syncCuratedEntries(db, [curatedEntry({
      id: 'Owner/monorepo/packages/foo', name: 'foo', repository: 'https://github.com/Owner/monorepo',
    })], '2026-08-16T02:00:00.000Z')

    expect(database.prepare('SELECT plugin_path, plugin_id, curated_name FROM catalog_plugins').all())
      .toEqual([{ plugin_path: 'packages/foo', plugin_id: 'Owner/monorepo/packages/foo', curated_name: 'foo' }])
    database.close()
  })
})

describe('repository name normalization', () => {
  it('normalizes repository names independently of GitHub casing', () => {
    expect(normalizeRepositoryName(' Owner/Plugin ')).toBe('owner/plugin')
  })
})

describe('catalog snapshot', () => {
  it('loads a published package version directly without rebuilding the snapshot', async () => {
    const database = catalogDatabase()
    seedRepository(database, {
      github_id: 1024,
      full_name: 'imsai-sh/awesome-deepseek-harness-plugins',
      normalized_full_name: 'imsai-sh/awesome-deepseek-harness-plugins',
      repository_name: 'awesome-deepseek-harness-plugins',
    })
    seedPlugin(database, 'imsai-sh/awesome-deepseek-harness-plugins', {
      plugin_path: 'packages/dsh1024',
      validation_status: 'accepted',
    })
    database.prepare(`
      UPDATE catalog_plugins
         SET package_name = 'dsh1024', npm_package_name = 'dsh1024',
             npm_status = 'found', npm_bundle_declared = 1,
             npm_version = '0.4.1', npm_checked_at = '2026-08-20T18:27:33.576Z'
       WHERE normalized_plugin_id =
             'imsai-sh/awesome-deepseek-harness-plugins/packages/dsh1024'
    `).run()

    const published = await loadPublishedPackageVersion(
      sqliteD1(database),
      [
        'imsai-sh/awesome-deepseek-harness-plugins',
        'imsai-sh/awesome-deepseek-harness-plugins/packages/dsh1024',
      ],
      'dsh1024',
    )

    expect(published).toEqual({
      version: '0.4.1',
      checkedAt: '2026-08-20T18:27:33.576Z',
    })
    database.close()
  })

  it('publishes curated plugins and accepted discoveries alike', async () => {
    const database = catalogDatabase()
    seedRepository(database, {
      github_id: 7, full_name: 'Scan/Nested', normalized_full_name: 'scan/nested', repository_name: 'Nested',
    })
    seedPlugin(database, 'scan/nested', {
      plugin_path: 'packages/deep', manifest_path: 'packages/deep/package.json', validation_status: 'accepted',
    })
    seedRepository(database, {
      github_id: 8, full_name: 'Scan/Rejected', normalized_full_name: 'scan/rejected', repository_name: 'Rejected',
    })
    seedPlugin(database, 'scan/rejected', { validation_status: 'rejected' })
    await syncCuratedEntries(sqliteD1(database), [
      curatedEntry({ id: 'Owner/mono/packages/foo', name: 'foo', repository: 'https://github.com/Owner/mono' }),
    ], NOW)

    const snapshot = await loadCatalogSnapshotFromD1(sqliteD1(database), NOW)

    // The rejected discovery is absent; the nested one installs from its own
    // directory instead of a repository root that has no bundle.
    expect(snapshot?.plugins.map((plugin) => plugin.id).sort()).toEqual([
      'Owner/mono/packages/foo',
      'Scan/Nested/packages/deep',
    ])
    expect(snapshot?.plugins.map((plugin) => plugin.install).sort()).toEqual([
      'dsh plugin --profile web add github:Owner/mono#path:packages/foo',
      'dsh plugin --profile web add github:Scan/Nested#path:packages/deep',
    ])
    database.close()
  })

  it('prefers curated copy over the GitHub blurb', async () => {
    const database = catalogDatabase()
    seedRepository(database, {
      github_id: 11, full_name: 'Owner/both', normalized_full_name: 'owner/both', repository_name: 'both',
    })
    seedPlugin(database, 'owner/both', { validation_status: 'accepted' })
    database.prepare("UPDATE catalog_repositories SET github_description = ? WHERE normalized_full_name = 'owner/both'")
      .run('GitHub blurb')
    await syncCuratedEntries(sqliteD1(database), [
      curatedEntry({ id: 'Owner/both', name: '人工命名', repository: 'https://github.com/Owner/both' }),
    ], NOW)

    const snapshot = await loadCatalogSnapshotFromD1(sqliteD1(database), NOW)

    expect(snapshot?.plugins[0]).toMatchObject({
      name: '人工命名',
      description: { en: 'English', zh: '中文' },
    })
    database.close()
  })

  it('falls back to the GitHub blurb when nobody curated the plugin', async () => {
    const database = catalogDatabase()
    seedRepository(database, { github_id: 12 })
    seedPlugin(database, 'scan/repo', { validation_status: 'accepted' })
    database.prepare("UPDATE catalog_repositories SET github_description = ? WHERE normalized_full_name = 'scan/repo'")
      .run('GitHub blurb')

    const snapshot = await loadCatalogSnapshotFromD1(sqliteD1(database), NOW)

    expect(snapshot?.plugins[0]).toMatchObject({
      id: 'Scan/Repo',
      name: 'Repo',
      category: 'unclassified',
      description: { en: 'GitHub blurb', zh: 'GitHub blurb' },
      install: 'dsh plugin --profile web add github:Scan/Repo',
    })
    database.close()
  })

  it('publishes npm as preferred and keeps the source method as a record', async () => {
    const database = catalogDatabase()
    seedRepository(database, { github_id: 13 })
    seedPlugin(database, 'scan/repo', { validation_status: 'accepted' })
    database.prepare(`
      UPDATE catalog_plugins
         SET package_name = '@scope/source-plugin',
             git_code = 'prepare_builds_entry', git_has_prepare = 1,
             npm_package_name = '@scope/published-plugin',
             npm_bundle_declared = 1, npm_binding = 'mismatch', npm_version = '2.0.0',
             npm_downloads_7d = 633545, npm_downloads_start = '2026-08-12',
             npm_downloads_end = '2026-08-18', npm_downloads_status = 'found'
       WHERE normalized_plugin_id = 'scan/repo'
    `).run()

    const plugin = (await loadCatalogSnapshotFromD1(sqliteD1(database), NOW))?.plugins[0]

    expect(plugin?.install).toBe('dsh plugin --profile web add @scope/published-plugin')
    // The github method stays derived and recorded; only npm is offered to
    // user-facing surfaces (issue #159).
    expect(plugin?.installMethods?.map((method) => method.kind)).toEqual(['npm', 'github'])
    expect(plugin?.installMethods?.[0]).toMatchObject({
      verification: 'verified',
      code: 'published_package',
    })
    expect(plugin?.installMethods?.[1]?.command).toBe(
      'dsh plugin --profile web add --allow-build=@scope/source-plugin github:Scan/Repo',
    )
    expect(plugin?.npmDownloads7d).toBeNull()
    expect(plugin?.npmDownloadsStart).toBeNull()
    expect(plugin?.npmDownloadsEnd).toBeNull()
    database.close()
  })
})
