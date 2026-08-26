import { describe, expect, it, vi } from 'vitest'
import { isStoredCatalogSnapshot, loadCatalogSnapshot, refreshCatalogSnapshot } from '../worker/lib/catalog-store'
import { TEST_REGISTRY, testCatalogResult } from './fixtures'

interface TestCatalogRow {
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
}

function catalogRow(overrides: Partial<TestCatalogRow> = {}): TestCatalogRow {
  return {
    full_name: 'openma-ai/deepseek-harness-tui',
    owner: 'openma-ai',
    repository_name: 'deepseek-harness-tui',
    html_url: 'https://github.com/openma-ai/deepseek-harness-tui',
    github_description: null,
    stars: null,
    forks: null,
    pushed_at: null,
    github_updated_at: '2026-08-14T00:00:00Z',
    plugin_path: '',
    plugin_id: 'openma-ai/deepseek-harness-tui',
    curated_name: 'deepseek-harness-tui',
    curated_category: 'ui',
    curated_description_en: 'Terminal client.',
    curated_description_zh: '终端客户端。',
    curated_added: '2026-08-14',
    ...overrides,
  }
}

interface HourlyRow {
  plugin_id: string
  install_count: number
  first_install_count: number
  reinstall_count: number
  update_count: number
  remove_count: number
  failure_count: number
  installs_24h: number
  installs_7d: number
  installs_30d: number
  latest_install_at: string | null
}

function snapshotDb(
  rows: TestCatalogRow[],
  hourlyRows: HourlyRow[] = [],
  installerRows: Array<{ plugin_id: string; installer_count: number }> = [],
): D1Database {
  const prepare = vi.fn((sql: string) => {
    const statement = {
      bind() {
        return statement
      },
      async all() {
        if (sql.includes('FROM catalog_plugins')) return { results: rows }
        if (sql.includes('github_star_snapshots')) return { results: [] }
        if (sql.includes('plugin_hourly_stats')) return { results: hourlyRows }
        return { results: installerRows }
      },
      async run() {
        return { success: true, meta: { changes: 0 } }
      },
    }
    return statement
  })
  return {
    prepare,
    batch: vi.fn(async (statements: unknown[]) => statements.map(() => ({ meta: { changes: 0 } }))),
  } as unknown as D1Database
}

describe('catalog snapshot storage', () => {
  it('accepts generated snapshots and rejects incomplete values', () => {
    expect(isStoredCatalogSnapshot(testCatalogResult().snapshot)).toBe(true)
    expect(isStoredCatalogSnapshot({ generatedAt: '2026-08-14T00:00:00Z' })).toBe(false)
  })

  it('returns a fresh KV snapshot without outbound requests', async () => {
    const snapshot = { ...testCatalogResult().snapshot, generatedAt: new Date().toISOString() }
    const get = vi.fn(async () => snapshot)
    const env = { CATALOG_CACHE: { get }, GITHUB_TOKEN: '' } as unknown as Env
    const fetcher = vi.fn() as unknown as typeof fetch

    const result = await loadCatalogSnapshot(env, undefined, fetcher)
    expect(result.source).toBe('kv')
    expect(result.snapshot.plugins).toHaveLength(TEST_REGISTRY.plugins.length)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('accepts a fresh KV snapshot with a D1-generated catalog revision', async () => {
    const snapshot = {
      ...testCatalogResult().snapshot,
      generatedAt: new Date().toISOString(),
      registryRevision: `sha256:${'0'.repeat(64)}`,
    }
    const env = {
      CATALOG_CACHE: { get: vi.fn(async () => snapshot) },
      GITHUB_TOKEN: '',
    } as unknown as Env
    const fetcher = vi.fn(async () => Response.json({ items: [] })) as unknown as typeof fetch

    const result = await loadCatalogSnapshot(env, undefined, fetcher)
    expect(result.source).toBe('kv')
    expect(result.snapshot.registryRevision).toBe(`sha256:${'0'.repeat(64)}`)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('builds the snapshot from D1 with categories sourced from catalog/categories.json', async () => {
    const put = vi.fn(async () => undefined)
    const env = {
      CATALOG_CACHE: { get: vi.fn(async () => null), put },
      CATALOG_DB: snapshotDb([
        catalogRow(),
        catalogRow({
          full_name: 'scanner/discovered-plugin',
          owner: 'scanner',
          repository_name: 'discovered-plugin',
          html_url: 'https://github.com/scanner/discovered-plugin',
          github_description: 'Discovered from the topic scan.',
          plugin_id: 'scanner/discovered-plugin',
          curated_name: null,
          curated_category: null,
          curated_description_en: null,
          curated_description_zh: null,
          curated_added: null,
        }),
      ]),
      GITHUB_TOKEN: '',
    } as unknown as Env
    const fetcher = vi.fn(async () => Response.json({ items: [] })) as unknown as typeof fetch

    const result = await refreshCatalogSnapshot(env, fetcher, Date.parse('2026-08-14T13:00:00Z'))
    expect(result.source).toBe('d1')
    expect(result.snapshot.plugins).toHaveLength(2)
    expect(result.snapshot.categories.ui).toEqual({ en: 'UI Enhancements', zh: 'UI 增强' })
    expect(result.snapshot.categories.model).toEqual({ en: 'Models & Providers', zh: '模型与账号接入' })
    expect(result.snapshot.categories.unclassified).toEqual({ en: 'Unclassified', zh: '待分类' })

    const discovered = result.snapshot.plugins.find((plugin) => plugin.owner === 'scanner')
    expect(discovered).toMatchObject({
      category: 'unclassified',
      install: 'dsh plugin --profile web add github:scanner/discovered-plugin',
    })
    expect(put).toHaveBeenCalledOnce()
  })

  it('falls back to the stale KV snapshot when D1 is unavailable', async () => {
    const stale = {
      ...testCatalogResult().snapshot,
      generatedAt: '2026-08-14T00:00:00.000Z',
    }
    const put = vi.fn(async () => undefined)
    const env = {
      CATALOG_CACHE: { get: vi.fn(async () => stale), put },
      GITHUB_TOKEN: '',
    } as unknown as Env
    const fetcher = vi.fn() as unknown as typeof fetch

    const refreshed = await refreshCatalogSnapshot(env, fetcher)
    expect(refreshed.source).toBe('stale')
    expect(refreshed.snapshot).toEqual(stale)

    const loaded = await loadCatalogSnapshot(env, undefined, fetcher)
    expect(loaded.source).toBe('stale')
    expect(put).not.toHaveBeenCalled()
  })

  it('serves a stale snapshot without touching D1 or GitHub', async () => {
    // The rebuild a read used to schedule was per request and undeduplicated, so
    // a traffic spike arriving on a stale snapshot turned every request into a
    // full catalog rebuild until D1 reported itself overloaded. A read answers
    // from KV now; the catalog-sync endpoint owns the rebuild.
    const stale = {
      ...testCatalogResult().snapshot,
      generatedAt: '2026-08-14T00:00:00.000Z',
    }
    const put = vi.fn(async () => undefined)
    const prepare = vi.fn()
    const env = {
      CATALOG_CACHE: { get: vi.fn(async () => stale), put },
      CATALOG_DB: { prepare, batch: vi.fn() },
      GITHUB_TOKEN: 'test-token',
    } as unknown as Env
    const fetcher = vi.fn() as unknown as typeof fetch
    const waitUntil = vi.fn()

    const loaded = await loadCatalogSnapshot(env, { waitUntil }, fetcher)

    expect(loaded.source).toBe('stale')
    expect(loaded.snapshot).toEqual(stale)
    expect(prepare).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    expect(waitUntil).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it('rebuilds once for concurrent readers when KV holds no snapshot', async () => {
    const put = vi.fn(async () => undefined)
    const env = {
      CATALOG_CACHE: { get: vi.fn(async () => null), put },
      CATALOG_DB: snapshotDb([catalogRow()]),
      GITHUB_TOKEN: '',
    } as unknown as Env
    const fetcher = vi.fn(async () => Response.json({ items: [] })) as unknown as typeof fetch

    const [first, second, third] = await Promise.all([
      loadCatalogSnapshot(env, undefined, fetcher),
      loadCatalogSnapshot(env, undefined, fetcher),
      loadCatalogSnapshot(env, undefined, fetcher),
    ])

    expect(first.source).toBe('d1')
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(put).toHaveBeenCalledOnce()
  })

  it('serves an explicitly empty snapshot when both D1 and KV are unavailable', async () => {
    const put = vi.fn(async () => undefined)
    const env = {
      CATALOG_CACHE: { get: vi.fn(async () => null), put },
      GITHUB_TOKEN: '',
    } as unknown as Env
    const fetcher = vi.fn() as unknown as typeof fetch

    const result = await refreshCatalogSnapshot(env, fetcher, Date.parse('2026-08-14T13:00:00Z'))
    expect(result.source).toBe('empty')
    expect(result.snapshot.plugins).toEqual([])
    expect(result.snapshot.registryRevision).toBe('empty')
    expect(result.snapshot.categories.ui).toEqual({ en: 'UI Enhancements', zh: 'UI 增强' })
    expect(put).not.toHaveBeenCalled()
  })

  it('retains the previous metrics when the GitHub refresh fails', async () => {
    const previous = testCatalogResult('kv').snapshot
    const put = vi.fn(async () => undefined)
    const env = {
      CATALOG_CACHE: { get: vi.fn(async () => previous), put },
      CATALOG_DB: snapshotDb([catalogRow()]),
      GITHUB_TOKEN: 'token',
    } as unknown as Env
    const fetcher = vi.fn(async () => {
      return Response.json({ errors: [{ message: 'temporary failure' }] })
    }) as unknown as typeof fetch

    const result = await refreshCatalogSnapshot(env, fetcher)
    expect(result.source).toBe('d1')
    const retained = result.snapshot.plugins.find(
      (plugin) => plugin.url === 'https://github.com/openma-ai/deepseek-harness-tui',
    )
    expect(retained?.stars).toBe(previous.plugins[0]?.stars)
    expect(put).toHaveBeenCalledOnce()
  })

  it('merges D1 installation aggregates into every refreshed catalog entry', async () => {
    const pluginId = 'openma-ai/deepseek-harness-tui'
    const env = {
      CATALOG_CACHE: {
        get: vi.fn(async () => null),
        put: vi.fn(async () => undefined),
      },
      CATALOG_DB: snapshotDb(
        [
          catalogRow(),
          catalogRow({
            full_name: 'omdsh-dev/fabric',
            owner: 'omdsh-dev',
            repository_name: 'fabric',
            html_url: 'https://github.com/omdsh-dev/fabric',
            // Its own id: install metrics are keyed per plugin, so sharing one
            // would credit this plugin with the other's installs.
            plugin_id: 'omdsh-dev/fabric',
            curated_category: 'dev',
          }),
        ],
        [{
          plugin_id: pluginId,
          install_count: 9,
          first_install_count: 7,
          reinstall_count: 2,
          update_count: 1,
          remove_count: 1,
          failure_count: 3,
          installs_24h: 2,
          installs_7d: 5,
          installs_30d: 9,
          latest_install_at: '2026-08-14T12:00:00.000Z',
        }],
        [{ plugin_id: pluginId, installer_count: 6 }],
      ),
      GITHUB_TOKEN: '',
    } as unknown as Env
    const fetcher = vi.fn(async () => Response.json({ items: [] })) as unknown as typeof fetch

    const result = await refreshCatalogSnapshot(env, fetcher, Date.parse('2026-08-14T13:00:00Z'))
    const tracked = result.snapshot.plugins.find((plugin) => plugin.repository === 'deepseek-harness-tui')
    const untracked = result.snapshot.plugins.find((plugin) => plugin.repository === 'fabric')

    expect(tracked).toMatchObject({
      installCount: 9,
      installerCount: 6,
      firstInstallCount: 7,
      reinstallCount: 2,
      installs24h: 2,
      installs7d: 5,
      installs30d: 9,
      latestInstallAt: '2026-08-14T12:00:00.000Z',
    })
    expect(untracked).toMatchObject({ installCount: 0, installerCount: 0, latestInstallAt: null })
  })
})
