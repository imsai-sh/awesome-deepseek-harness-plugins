import { describe, expect, it } from 'vitest'
import { contentEtag, edgeCacheKey, edgeCacheablePath, notModifiedFor } from '../worker/lib/edge-cache'
import {
  buildCatalog,
  buildPluginsPage,
  buildRankingsResponse,
  clampLimit,
  deriveCatalogResponse,
  findPlugin,
  parseCatalogQuery,
  repositoryName,
} from '../worker/lib/catalog'
import type { CatalogPlugin, CatalogSnapshotResult } from '../worker/types'
import { TEST_PLUGINS, TEST_REGISTRY, testCatalogResult } from './fixtures'

describe('catalog queries', () => {
  it('normalizes search text and invalid sort values', () => {
    expect(parseCatalogQuery({ q: '  terminal  ', sort: 'downloads' })).toEqual({
      q: 'terminal',
      category: '',
      sort: 'stars',
    })
    expect(parseCatalogQuery({ sort: 'growth7d' }).sort).toBe('growth7d')
    expect(parseCatalogQuery({ sort: 'installs24h' }).sort).toBe('installs24h')
  })

  it('searches localized descriptions, filters categories, and does not paginate', () => {
    const result = buildCatalog(testCatalogResult(), {
      q: '终端',
      category: 'tools',
      sort: 'newest',
    })

    expect(result.packages.map((plugin) => plugin.name)).toEqual(['dsh-bash-terminal'])
    expect(result.meta).toMatchObject({ total: 1, catalogTotal: TEST_PLUGINS.length })
    expect(result.categories).toHaveLength(7)
    expect(result.meta).not.toHaveProperty('page')
  })

  it('sorts all packages and builds stable ranking groups', () => {
    const result = buildCatalog(testCatalogResult(), { q: '', category: '', sort: 'name' })

    expect(result.packages).toHaveLength(TEST_PLUGINS.length)
    expect(result.packages[0]?.name).toBe('deepseek-harness-tui')
    expect(result.rankings.stars[0]?.name).toBe('dsh-crosstalk')
    expect(result.rankings.installs[0]?.name).toBe('dsh-crosstalk')
    expect(result.rankings.installs24h[0]?.name).toBe('dsh-agent-teams')
    expect(result.rankings.installs7d[0]?.name).toBe('dsh-agent-teams')
    expect(result.rankings.installs30d[0]?.name).toBe('dsh-crosstalk')
    expect(result.rankings.growth24h[0]?.name).toBe('dsh-agent-teams')
    expect(result.rankings.growth7d[0]?.name).toBe('dsh-agent-teams')
    expect(result.rankings.growth30d[0]?.name).toBe('dsh-crosstalk')
    expect(result.rankings.newest[0]?.name).toBe('dsh-agent-teams')
    expect(result.rankings.active[0]?.name).toBe('deepseek-harness-tui')
    // The fixture's two omdsh-dev/dsh-suite plugins share a repository, and
    // therefore share their stars, growth and pushed_at. The boards ranked by
    // those numbers seat the repository once; the install boards, ranked per
    // plugin, still seat both.
    const distinctRepositories = new Set(
      TEST_PLUGINS.map((plugin) => `${plugin.owner}/${plugin.repository}`.toLowerCase()),
    ).size
    expect(distinctRepositories).toBe(TEST_PLUGINS.length - 1)
    expect(result.rankings.stars).toHaveLength(distinctRepositories)
    expect(result.rankings.newest).toHaveLength(distinctRepositories)
    expect(result.rankings.active).toHaveLength(distinctRepositories)
    expect(result.rankings.growth24h).toHaveLength(distinctRepositories - 1)
    expect(result.rankings.installs).toHaveLength(TEST_PLUGINS.length - 1)
    expect(result.rankings.installs24h).toHaveLength(4)
  })

  it('keeps installation rankings empty while no tracked installs have arrived', () => {
    const base = testCatalogResult()
    const result = buildCatalog({
      ...base,
      snapshot: {
        ...base.snapshot,
        plugins: base.snapshot.plugins.map((plugin) => ({
          ...plugin,
          installCount: 0,
          installs24h: 0,
          installs7d: 0,
          installs30d: 0,
        })),
      },
    }, { q: '', category: '', sort: 'installs' })

    expect(result.packages).toHaveLength(TEST_PLUGINS.length)
    expect(result.rankings.installs).toEqual([])
    expect(result.rankings.installs24h).toEqual([])
    expect(result.rankings.installs7d).toEqual([])
    expect(result.rankings.installs30d).toEqual([])
  })

  it('sorts growth queries and excludes repositories without a complete baseline', () => {
    const result = buildCatalog(testCatalogResult(), {
      q: '',
      category: '',
      sort: 'growth24h',
    })

    expect(result.packages[0]?.name).toBe('dsh-agent-teams')
    expect(result.packages.map((plugin) => plugin.name)).not.toContain('dsh-bash-terminal')
  })

  it('derives any filtered view from the unfiltered response exactly like the server', () => {
    const snapshot = testCatalogResult()
    const full = buildCatalog(snapshot, { q: '', category: '', sort: 'stars' })
    const queries = [
      { q: '', category: 'tools', sort: 'stars' },
      { q: '终端', category: '', sort: 'newest' },
      { q: 'harness', category: '', sort: 'active' },
      { q: '', category: '', sort: 'growth24h' },
      { q: '', category: 'tools', sort: 'installs24h' },
    ] as const

    for (const query of queries) {
      const derived = deriveCatalogResponse(full, query)
      const direct = buildCatalog(snapshot, query)
      expect(derived.packages).toEqual(direct.packages)
      expect(derived.meta.total).toBe(direct.meta.total)
      expect(derived.rankings).toEqual(direct.rankings)
      expect(derived.categories).toEqual(direct.categories)
      expect(derived.meta.catalogTotal).toBe(direct.meta.catalogTotal)
    }
  })

  it('finds owners and repositories case-insensitively', () => {
    expect(findPlugin(TEST_REGISTRY.plugins, 'OPENMA-AI', 'deepseek-harness-tui')?.owner).toBe('openma-ai')
    expect(findPlugin(TEST_REGISTRY.plugins, 'openma-ai', 'DeepSeek-Harness-TUI')?.name).toBe('deepseek-harness-tui')
  })

  it('uses the repository URL for scoped package identifiers', () => {
    const scoped = {
      ...TEST_REGISTRY.plugins[0],
      name: '@scope/package-name',
      owner: 'example',
      url: 'https://github.com/example/repository-name',
    }
    expect(repositoryName(scoped)).toBe('repository-name')
    expect(findPlugin([scoped], 'example', 'repository-name')?.name).toBe('@scope/package-name')
  })
})

describe('ranking seats', () => {
  /** A monorepo: four plugins that share one repository, and one outsider. */
  function monorepoResult(overrides: Partial<CatalogPlugin> = {}) {
    const base = TEST_PLUGINS[0]
    const sibling = (path: string, extra: Partial<CatalogPlugin> = {}): CatalogPlugin => ({
      ...base,
      id: `mono/repo/packages/${path}`,
      name: path,
      owner: 'mono',
      repository: 'repo',
      url: 'https://github.com/mono/repo',
      // Every repository-level number is identical, which is the whole problem.
      stars: 3374,
      forks: 191,
      pushedAt: '2026-08-16T12:00:00Z',
      updatedAt: '2026-08-16T12:00:00Z',
      growth24h: 120,
      growth7d: 400,
      growth30d: 900,
      added: '2026-08-16',
      latestReleaseAt: null,
      installCount: 0,
      installs24h: 0,
      installs7d: 0,
      installs30d: 0,
      ...overrides,
      ...extra,
    })
    const outsider: CatalogPlugin = {
      ...base,
      id: 'solo/plugin',
      name: 'solo-plugin',
      owner: 'solo',
      repository: 'plugin',
      url: 'https://github.com/solo/plugin',
      stars: 10,
      forks: 1,
      pushedAt: '2026-08-15T12:00:00Z',
      updatedAt: '2026-08-15T12:00:00Z',
      growth24h: 5,
      growth7d: 5,
      growth30d: 5,
      added: '2026-08-15',
      latestReleaseAt: null,
      installCount: 0,
      installs24h: 0,
      installs7d: 0,
      installs30d: 0,
    }
    const result = testCatalogResult()
    return {
      ...result,
      snapshot: {
        ...result.snapshot,
        plugins: [sibling('alpha'), sibling('beta'), sibling('gamma'), sibling('delta'), outsider],
      },
    }
  }

  const query = { q: '', category: '', sort: 'stars' as const }

  it('gives a repository one seat on every board ranked by a repository metric', () => {
    const { rankings } = buildCatalog(monorepoResult(), query)

    for (const board of ['stars', 'growth24h', 'growth7d', 'growth30d', 'newest', 'active'] as const) {
      // Four identical star counts used to take four seats and tell the reader
      // nothing with three of them.
      expect(rankings[board].map((plugin) => plugin.id))
        .toEqual(['mono/repo/packages/alpha', 'solo/plugin'])
      expect(rankings[board][0]?.repositorySiblings).toBe(3)
      expect(rankings[board][1]?.repositorySiblings).toBe(0)
    }
  })

  it('leaves the install boards alone, because installs tell siblings apart', () => {
    const result = monorepoResult()
    result.snapshot.plugins = result.snapshot.plugins.map((plugin, index) => ({
      ...plugin,
      installCount: (index + 1) * 10,
      installs24h: (index + 1) * 10,
      installs7d: (index + 1) * 10,
      installs30d: (index + 1) * 10,
    }))

    const { rankings } = buildCatalog(result, query)

    for (const board of ['installs', 'installs24h', 'installs7d', 'installs30d'] as const) {
      // A repository that earned four seats here earned each of them.
      expect(rankings[board]).toHaveLength(5)
      expect(rankings[board].every((plugin) => plugin.repositorySiblings === 0)).toBe(true)
    }
  })

  it('keeps the best-ranked sibling as the seat', () => {
    const result = monorepoResult()
    result.snapshot.plugins = result.snapshot.plugins.map((plugin) => (
      plugin.id === 'mono/repo/packages/gamma'
        ? { ...plugin, pushedAt: '2026-08-20T12:00:00Z' }
        : plugin
    ))

    const { rankings } = buildCatalog(result, query)

    expect(rankings.active[0]?.id).toBe('mono/repo/packages/gamma')
    expect(rankings.active[0]?.repositorySiblings).toBe(3)
  })

  it('does not collapse the catalog listing itself', () => {
    // Searching for a package must find that package, not its repository.
    const { packages } = buildCatalog(monorepoResult(), query)

    expect(packages).toHaveLength(5)
  })
})

describe('listing payload', () => {
  it('keeps install and installMethods in packages and rankings', () => {
    const result = testCatalogResult()
    const withMethods = {
      ...result,
      snapshot: {
        ...result.snapshot,
        plugins: result.snapshot.plugins.map((plugin) => ({
          ...plugin,
          installMethods: [{
            kind: 'github' as const,
            spec: `github:${plugin.id}`,
            command: `dsh plugin add github:${plugin.id}`,
            verification: 'verified' as const,
            code: 'entry_committed' as const,
            requiresBuildAllowance: false,
            revision: 'abc1234',
            checkedAt: '2026-08-18T00:00:00.000Z',
          }],
        })),
      },
    }

    const catalog = buildCatalog(withMethods, parseCatalogQuery({}))

    expect(catalog.packages.length).toBeGreaterThan(0)
    expect(catalog.rankings.stars.length).toBeGreaterThan(0)
    for (const plugin of [...catalog.packages, ...catalog.rankings.stars]) {
      expect(plugin.install).toEqual(expect.any(String))
      expect(plugin.installMethods).toHaveLength(1)
    }
    expect(JSON.parse(JSON.stringify(catalog)).packages[0]).toMatchObject({
      install: expect.any(String),
      installMethods: expect.any(Array),
    })
  })

  it('keeps the fields the listing actually renders', () => {
    const catalog = buildCatalog(testCatalogResult(), parseCatalogQuery({}))
    expect(catalog.packages[0]).toMatchObject({
      id: expect.any(String),
      description: expect.objectContaining({ en: expect.any(String), zh: expect.any(String) }),
      install: expect.any(String),
    })
  })
})

describe('edge cache allowlist', () => {
  it('never caches a per-caller or streaming route', () => {
    // A path forgotten here is a user's response handed to the next caller, so
    // the guard is an allowlist and this test is the list.
    for (const pathname of [
      '/api/live',
      '/api/v1/plugins/search',
      '/api/v1/auth/me',
      '/api/v1/auth/github/callback',
      '/api/v1/api-keys',
      '/api/v1/community/posts',
      '/api/v1/self/install-stats',
      '/api/v1/health',
      '/api/v1/install-events',
      '/assets/index-abc123.js',
    ]) {
      expect(edgeCacheablePath(pathname), pathname).toBe(false)
    }
  })

  it('caches the catalog endpoints and the document routes', () => {
    for (const pathname of [
      '/api/v1/plugins',
      '/api/v1/registry',
      '/api/v2/plugins',
      '/api/v2/rankings',
      '/',
      '/plugins',
      '/rankings',
      '/robots.txt',
      '/sitemap.xml',
    ]) {
      expect(edgeCacheablePath(pathname), pathname).toBe(true)
    }
  })
})

describe('edge cache key normalization', () => {
  function key(url: string): string | null {
    return edgeCacheKey(new URL(url))?.url ?? null
  }

  it('keeps only the params that shape the body, in a fixed order', () => {
    // A cache-buster or reordered params must land on the same entry, or a
    // busy caller shatters the cache into a cold miss per request.
    const canonical = key('https://deepseek1024.com/api/v2/plugins?category=ui&page=2&sort=newest')
    expect(key('https://deepseek1024.com/api/v2/plugins?page=2&category=ui&sort=newest&utm=x&_=99'))
      .toBe(canonical)
    expect(key('https://deepseek1024.com/api/v2/plugins?sort=newest&category=ui&page=2'))
      .toBe(canonical)
  })

  it('drops every param on a no-param endpoint', () => {
    const bare = key('https://deepseek1024.com/api/v2/rankings')
    expect(key('https://deepseek1024.com/api/v2/rankings?bust=123')).toBe(bare)
    expect(bare).toBe('https://deepseek1024.com/api/v2/rankings')
  })

  it('leaves HTML routes keyed by their whole URL', () => {
    // A filtered permutation carries different SEO metadata than the bare page,
    // so its query must stay in the key.
    expect(key('https://deepseek1024.com/plugins?category=ui'))
      .toBe('https://deepseek1024.com/plugins?category=ui')
  })

  it('does not cache an off-allowlist api path', () => {
    expect(key('https://deepseek1024.com/api/v1/plugins/search?q=x')).toBeNull()
  })
})

describe('conditional catalog requests', () => {
  const body = '{"packages":[{"id":"a/b"}]}'
  const etag = contentEtag(body)

  function responseWith(tag: string | null): Response {
    const headers = new Headers({ 'Cache-Control': 'public, max-age=300', 'X-Catalog-Source': 'kv' })
    if (tag) headers.set('ETag', tag)
    return new Response(body, { headers })
  }

  function conditional(ifNoneMatch: string | null): Request {
    return new Request('https://deepseek1024.com/api/v1/plugins', {
      headers: ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : {},
    })
  }

  it('is stable for identical bytes and moves for any change', () => {
    expect(contentEtag(body)).toBe(contentEtag(body))
    expect(contentEtag(body)).toMatch(/^W\//)
    for (const other of [
      '{"packages":[{"id":"a/b"},{"id":"c/d"}]}',
      '{"packages":[{"id":"a/b","stars":1}]}',
      '{"packages":[]}',
    ]) {
      expect(contentEtag(other)).not.toBe(etag)
    }
  })

  it('moves when the body changes even though the snapshot did not', () => {
    // The bug this replaces: keyed on snapshot identity, the validator kept the
    // old tag when a deploy restored a field, and a poller was answered 304
    // against a body that no longer matched. Same snapshot, one extra field —
    // the tag must differ.
    const withoutField = '{"packages":[{"id":"a/b"}]}'
    const withField = '{"packages":[{"id":"a/b","installMethods":[{"kind":"github"}]}]}'
    expect(contentEtag(withField)).not.toBe(contentEtag(withoutField))
  })

  it('answers a matching validator with an empty 304', async () => {
    const notModified = notModifiedFor(conditional(etag), responseWith(etag))
    expect(notModified?.status).toBe(304)
    expect(await notModified?.text()).toBe('')
    expect(notModified?.headers.get('ETag')).toBe(etag)
    expect(notModified?.headers.get('Cache-Control')).toBe('public, max-age=300')
  })

  it('tolerates the forms a client may send the validator in', () => {
    expect(notModifiedFor(conditional(etag.replace('W/', '')), responseWith(etag))).not.toBeNull()
    expect(notModifiedFor(conditional(`"stale", ${etag}`), responseWith(etag))).not.toBeNull()
    expect(notModifiedFor(conditional('*'), responseWith(etag))).not.toBeNull()
  })

  it('serves the body when the validator is stale, absent, or unmatchable', () => {
    expect(notModifiedFor(conditional(contentEtag('{"x":1}')), responseWith(etag))).toBeNull()
    expect(notModifiedFor(conditional(null), responseWith(etag))).toBeNull()
    expect(notModifiedFor(conditional(etag), responseWith(null))).toBeNull()
  })
})

describe('v2 paginated directory', () => {
  // A snapshot with enough plugins to page. The fixture repeats one plugin's
  // shape under distinct ids so pagination and filtering have something to bite.
  function snapshotOf(count: number, category = 'ui'): CatalogSnapshotResult {
    const base = testCatalogResult().snapshot.plugins[0]!
    const plugins = Array.from({ length: count }, (_unused, index) => ({
      ...base,
      id: `owner${index}/repo${index}`,
      name: `repo${index}`,
      owner: `owner${index}`,
      repository: `repo${index}`,
      url: `https://github.com/owner${index}/repo${index}`,
      category,
      installMethods: [{
        kind: 'github' as const,
        spec: `github:owner${index}/repo${index}`,
        command: 'dsh plugin add …',
        verification: 'verified' as const,
        code: 'entry_committed' as const,
        requiresBuildAllowance: false,
        revision: null,
        checkedAt: null,
      }],
    }))
    return { snapshot: { ...testCatalogResult().snapshot, plugins }, source: 'kv' }
  }

  it('returns one page and the totals a pager needs', () => {
    const result = buildPluginsPage(snapshotOf(250), parseCatalogQuery({}), 2, 100)
    expect(result.plugins).toHaveLength(100)
    expect(result).toMatchObject({ page: 2, limit: 100, total: 250, totalPages: 3, catalogTotal: 250 })
    // Page 2 is the second slice, not the first.
    expect(result.plugins[0]!.id).not.toBe(buildPluginsPage(snapshotOf(250), parseCatalogQuery({}), 1, 100).plugins[0]!.id)
  })

  it('drops installMethods from list rows but keeps them derivable elsewhere', () => {
    const page = buildPluginsPage(snapshotOf(3), parseCatalogQuery({}), 1, 100)
    for (const plugin of page.plugins) expect(plugin.installMethods).toBeUndefined()
    expect(JSON.parse(JSON.stringify(page)).plugins[0]).not.toHaveProperty('installMethods')
  })

  it('clamps a page past the end onto the last real page instead of 404ing', () => {
    const page = buildPluginsPage(snapshotOf(120), parseCatalogQuery({}), 999, 100)
    expect(page.page).toBe(2)
    expect(page.plugins).toHaveLength(20)
  })

  it('clamps the limit into a sane band', () => {
    expect(clampLimit(undefined)).toBe(100)
    expect(clampLimit(0)).toBe(100)
    expect(clampLimit(5000)).toBe(200)
    expect(clampLimit(37)).toBe(37)
  })

  it('carries whole-catalog category counts, not the page', () => {
    const page = buildPluginsPage(snapshotOf(250, 'ui'), parseCatalogQuery({ category: 'ui' }), 1, 10)
    expect(page.plugins).toHaveLength(10)
    const ui = page.categories.find((c) => c.id === 'ui')
    expect(ui?.count).toBe(250)
  })
})

describe('v2 rankings', () => {
  it('bundles the siblings a collapsed seat needs, and only those', () => {
    // Two plugins share a repository; a third is alone. Only the shared repo
    // earns a sibling entry, and it carries both of its plugins.
    const base = testCatalogResult().snapshot.plugins[0]!
    const plugins: CatalogPlugin[] = [
      { ...base, id: 'mono/repo/a', owner: 'mono', repository: 'repo', name: 'a', url: 'https://github.com/mono/repo', stars: 50 },
      { ...base, id: 'mono/repo/b', owner: 'mono', repository: 'repo', name: 'b', url: 'https://github.com/mono/repo', stars: 50 },
      { ...base, id: 'solo/one', owner: 'solo', repository: 'one', name: 'one', url: 'https://github.com/solo/one', stars: 10 },
    ]
    const response = buildRankingsResponse({ snapshot: { ...testCatalogResult().snapshot, plugins }, source: 'kv' })

    expect(response.siblingsByRepository['mono/repo']).toHaveLength(2)
    expect(response.siblingsByRepository['solo/one']).toBeUndefined()
    // The bundled siblings are list rows: no installMethods.
    for (const sibling of response.siblingsByRepository['mono/repo']!) {
      expect(sibling.installMethods).toBeUndefined()
    }
    // The stars board seats the monorepo once and records the sibling it hid.
    const seat = response.rankings.stars.find((row) => row.owner === 'mono')
    expect(seat?.repositorySiblings).toBe(1)
  })
})
