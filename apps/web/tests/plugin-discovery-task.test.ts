import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The snapshot refresh is a separate external dependency with its own tests;
// stubbing it keeps this file about the crawl loop. npm probing no longer runs
// here — it moved to npm-refresh-task.
vi.mock('../worker/lib/catalog-store', () => ({
  refreshCatalogSnapshot: vi.fn(async () => ({ snapshot: null, source: 'd1' })),
}))

const { runPluginDiscoveryTask } = await import('../worker/lib/plugin-discovery-task')

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

function catalogDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  for (const migration of [
    '0002_plugin_catalog.sql',
    '0005_catalog_plugins.sql',
    '0006_ai_classification.sql',
    '0009_manifest_sweep.sql',
  ]) {
    database.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'))
  }
  return database
}

const SCHEDULED_AT = Date.parse('2026-08-16T00:00:00Z')

/**
 * A monorepo with three packages, pushed *after* the run's own watermark.
 *
 * That combination is what the queue's push-driven predicate makes tricky: the
 * repository stays due the moment it has been scanned, so a run that did not
 * remember inspecting it would hand it straight back and loop on it.
 */
function githubFixture(packages: string[]) {
  const treeCalls: string[] = []
  const blobCalls: string[] = []
  const repository = {
    id: 42,
    name: 'monorepo',
    full_name: 'owner/monorepo',
    html_url: 'https://github.com/owner/monorepo',
    description: 'A monorepo',
    fork: false,
    archived: false,
    disabled: false,
    default_branch: 'main',
    stargazers_count: 10,
    forks_count: 1,
    language: 'TypeScript',
    license: { spdx_id: 'MIT' },
    updated_at: '2026-08-16T12:00:00Z',
    pushed_at: '2026-08-16T12:00:00Z',
  }

  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/search/repositories')) {
      return Response.json({ total_count: 1, incomplete_results: false, items: [repository] })
    }
    if (url.endsWith('/rate_limit')) {
      return Response.json({ resources: { core: { remaining: 5000 } } })
    }
    if (url.includes('/git/trees/')) {
      treeCalls.push(url)
      return Response.json({
        truncated: false,
        tree: packages.flatMap((name) => [
          { path: `packages/${name}/package.json`, mode: '100644', type: 'blob', sha: name },
          { path: `packages/${name}/cordis.patch.yml`, mode: '100644', type: 'blob', sha: `${name}-p` },
        ]),
      })
    }
    if (url.includes('/git/blobs/')) {
      const sha = url.split('/').at(-1) ?? ''
      blobCalls.push(sha)
      return Response.json({
        encoding: 'base64',
        content: Buffer.from(JSON.stringify({
          name: `@owner/${sha}`,
          version: '1.0.0',
          main: './index.js',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        })).toString('base64'),
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as unknown as typeof fetch

  return { fetcher, treeCalls, blobCalls }
}

describe('plugin discovery task', () => {
  beforeEach(() => {
    vi.stubGlobal('scheduler', { wait: async () => undefined })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('writes every package of a discovered monorepo and inspects it only once', async () => {
    const database = catalogDatabase()
    const { fetcher, treeCalls } = githubFixture(['dsh-pet', 'dsh-ssh', 'dsh-task-board'])
    vi.stubGlobal('fetch', fetcher)
    const env = {
      CATALOG_DB: sqliteD1(database),
      GITHUB_TOKEN: 'token',
    } as unknown as Env

    const result = await runPluginDiscoveryTask(env, 'full', SCHEDULED_AT)

    expect(result.discovered).toBe(1)
    // Three plugins from one repository — the whole point of the sweep.
    expect(result.accepted).toBe(3)
    expect(database.prepare(
      'SELECT plugin_id, validation_status FROM catalog_plugins ORDER BY plugin_path',
    ).all()).toEqual([
      { plugin_id: 'owner/monorepo/packages/dsh-pet', validation_status: 'accepted' },
      { plugin_id: 'owner/monorepo/packages/dsh-ssh', validation_status: 'accepted' },
      { plugin_id: 'owner/monorepo/packages/dsh-task-board', validation_status: 'accepted' },
    ])
    // The repository was pushed after the run's watermark, so the queue keeps
    // offering it. One tree fetch proves the run refuses to re-inspect it.
    expect(treeCalls).toHaveLength(1)
    expect(result.pending).toBe(true)
    database.close()
  })

  it('resumes a repository whose manifest sweep exceeded one pass', async () => {
    const database = catalogDatabase()
    // One more package than a single pass may read.
    const names = Array.from({ length: 61 }, (_, index) => `pkg-${String(index).padStart(3, '0')}`)
    const { fetcher, blobCalls } = githubFixture(names)
    vi.stubGlobal('fetch', fetcher)
    const env = {
      CATALOG_DB: sqliteD1(database),
      GITHUB_TOKEN: 'token',
    } as unknown as Env

    const first = await runPluginDiscoveryTask(env, 'full', SCHEDULED_AT)

    expect(first.accepted).toBe(60)
    expect(first.pending).toBe(true)
    expect(blobCalls).toHaveLength(60)
    expect(database.prepare('SELECT manifest_cursor FROM catalog_repositories').get())
      .toEqual({ manifest_cursor: 'packages/pkg-059/package.json' })

    blobCalls.length = 0
    const second = await runPluginDiscoveryTask(env, 'incremental', SCHEDULED_AT + 60_000)

    // The 61st manifest is read on the next tick rather than discarded, which
    // is what the old `.slice(0, 25)` did without leaving a trace.
    expect(blobCalls).toEqual(['pkg-060'])
    expect(second.accepted).toBe(1)
    expect(database.prepare('SELECT COUNT(*) AS total FROM catalog_plugins').get())
      .toEqual({ total: 61 })
    expect(database.prepare('SELECT manifest_cursor FROM catalog_repositories').get())
      .toEqual({ manifest_cursor: null })
    database.close()
  })
})
