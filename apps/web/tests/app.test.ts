import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../worker/app'

import type { CuratedCatalogEntry } from '../worker/lib/catalog-db'
import {
  emptyInstallMetrics,
  InstallationRateLimitError,
  type InstallationEvent,
} from '../worker/lib/install-metrics'
import { collectionQueryKind } from '../worker/seo'
import type { PackageDetail } from '../worker/types'
import { TEST_PLUGINS, testCatalogResult } from './fixtures'

function testApp() {
  const detail = {
    ...TEST_PLUGINS[0],
    github: null,
    manifest: null,
    readme: null,
    readmeBasePath: '',
    verification: { repositoryReachable: false, bundleDeclared: false },
  } satisfies PackageDetail

  return createApp({
    catalogLoader: vi.fn(async () => testCatalogResult()),
    detailLoader: vi.fn(async () => detail),
  })
}

const VALID_INSTALL_EVENT = {
  eventId: 'b8247a4e-3f87-4ebf-8a78-6a5a33f03648',
  clientId: 'd2b0d8a3-c636-4f34-b16f-2eb4f5f39965',
  pluginId: 'openma-ai/deepseek-harness-tui',
  profile: 'web',
  operation: 'install',
  status: 'success',
  clientStartedAt: '2026-08-14T12:00:00.000Z',
  clientCompletedAt: '2026-08-14T12:00:01.250Z',
  durationMs: 1250,
  beforeVersion: null,
  afterVersion: '1.2.3',
  requestedRef: 'github:openma-ai/deepseek-harness-tui',
  cliVersion: '0.1.0',
  dshVersion: '0.1.0-rc.5',
  platform: 'darwin',
  arch: 'arm64',
  isCi: false,
  errorCode: null,
  sourceChannel: 'dsh-1024store-cli',
}

const TELEMETRY_ENV = {
  CATALOG_DB: {},
  INSTALL_CLIENT_HASH_SECRET: 'test-install-secret-that-is-at-least-32-bytes',
} as unknown as Env

const SYNC_TOKEN = 'catalog-sync-token-that-is-long-enough'

const SYNC_ENV = {
  CATALOG_DB: {},
  CATALOG_SYNC_TOKEN: SYNC_TOKEN,
} as unknown as Env

const VALID_SYNC_ENTRY: CuratedCatalogEntry = {
  id: 'openma-ai/deepseek-harness-tui',
  name: 'deepseek-harness-tui',
  repository: 'https://github.com/openma-ai/deepseek-harness-tui',
  category: 'ui',
  description: { en: 'Terminal client.', zh: '终端客户端。' },
  added: '2026-08-14',
}

function telemetryApp(outcome: boolean | 'rate-limit' = false) {
  const eventRecorder = vi.fn(async (
    _db: D1Database,
    _secret: string,
    event: InstallationEvent,
    pluginId: string,
    receivedAt: number = Date.now(),
  ) => {
    if (outcome === 'rate-limit') throw new InstallationRateLimitError(30)
    return {
      duplicate: outcome,
      eventId: event.eventId,
      pluginId,
      serverReceivedAt: new Date(receivedAt).toISOString(),
    }
  })
  const app = createApp({
    catalogLoader: vi.fn(async () => testCatalogResult()),
    eventRecorder,
    clock: () => Date.parse('2026-08-14T12:05:00Z'),
  })
  return { app, eventRecorder }
}

function syncApp() {
  const curatedSyncer = vi.fn(async (
    _db: D1Database,
    entries: CuratedCatalogEntry[],
    _now?: string,
  ) => ({
    total: entries.length,
    removedSources: 2,
  }))
  const snapshotRefresher = vi.fn(async () => testCatalogResult('d1'))
  const app = createApp({
    catalogLoader: vi.fn(async () => testCatalogResult()),
    curatedSyncer,
    snapshotRefresher,
    clock: () => Date.parse('2026-08-14T12:05:00Z'),
  })
  return { app, curatedSyncer, snapshotRefresher }
}

function syncRequest(body: unknown, token: string | null = SYNC_TOKEN): RequestInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token !== null) headers.Authorization = `Bearer ${token}`
  return { method: 'POST', headers, body: JSON.stringify(body) }
}

describe('market API', () => {
  it('publishes crawl controls without intercepting the asset-served site root', async () => {
    const app = testApp()
    const root = await app.request('https://store.example/')
    const robots = await app.request('https://store.example/robots.txt')
    const sitemap = await app.request('https://store.example/sitemap.xml')

    expect(root.status).toBe(404)
    expect(root.headers.get('Location')).toBeNull()
    expect(await robots.text()).toContain('Sitemap: https://deepseek1024.com/sitemap.xml')
    expect(sitemap.headers.get('Content-Type')).toContain('application/xml')
    // Catalog-derived, so it must revalidate rather than sit a day behind.
    expect(sitemap.headers.get('Cache-Control')).toContain('stale-while-revalidate=')
    const sitemapBody = await sitemap.text()
    expect(sitemapBody).toContain('<loc>https://deepseek1024.com/plugins</loc>')
    expect((sitemapBody.match(/<url>/g) ?? []).length).toBe(TEST_PLUGINS.length + 3)
  })

  it('serves the catalog as plain text for crawlers that will not run JavaScript', async () => {
    const response = await testApp().request('https://store.example/llms-full.txt')

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/plain')
    expect(response.headers.get('Cache-Control')).toContain('stale-while-revalidate=')
    const body = await response.text()
    expect(body).toContain(TEST_PLUGINS[0]!.name)
    // Source installs are no longer offered anywhere: a plugin without a
    // published npm package points crawlers at its repository instead.
    expect(body).toContain('— source: https://github.com/')
    expect(body).not.toContain('dsh plugin --profile web add github:')
  })

  it('withholds the sitemap during a catalog outage instead of shrinking it', async () => {
    const app = createApp({
      catalogLoader: vi.fn(async () => ({ ...testCatalogResult('empty'), source: 'empty' as const })),
    })
    const sitemap = await app.request('https://store.example/sitemap.xml')
    const llms = await app.request('https://store.example/llms-full.txt')

    expect(sitemap.status).toBe(503)
    expect(sitemap.headers.get('Cache-Control')).toBe('no-store')
    expect(llms.status).toBe(503)
  })

  it('reports a catalog outage as unavailable, never as a missing plugin', async () => {
    const outage = testCatalogResult('empty')
    const app = createApp({
      catalogLoader: vi.fn(async () => ({
        source: 'empty' as const,
        snapshot: { ...outage.snapshot, plugins: [], metricCoverage: 0 },
      })),
    })
    const response = await app.request('/api/v1/plugins/openma-ai/deepseek-harness-tui')

    // A 404 here tells the client the plugin was deleted, and the client
    // answers by noindexing the page — during an outage that would deindex the
    // whole catalog, which is exactly what the Worker fails open to prevent.
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ code: 'CATALOG_UNAVAILABLE' })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('still reports a genuinely unknown plugin as not found', async () => {
    const response = await testApp().request('/api/v1/plugins/nobody/nothing')

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('redirects the duplicate rankings route to the canonical home page', async () => {
    const response = await testApp().request('https://store.example/rankings')

    expect(response.status).toBe(301)
    expect(response.headers.get('Location')).toBe('https://store.example/')
  })

  it('keeps the catalog JSON crawlable but unindexable', async () => {
    const response = await testApp().request('/api/v1/plugins')

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex')
    expect(response.headers.get('Cache-Control')).toContain('max-age=300')
  })

  it('reports service health without exposing internals', async () => {
    const response = await testApp().request('/api/v1/health')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('no longer serves the legacy API routes', async () => {
    const app = testApp()
    for (const path of [
      '/api/health',
      '/api/dsh-1024store',
      '/api/plugin',
      '/api/plugin/openma-ai/deepseek-harness-tui',
      '/api/install-stats/openma-ai/deepseek-harness-tui',
      '/api/packages',
      '/api/packages/openma-ai/deepseek-harness-tui',
      '/plugins.json',
    ]) {
      const response = await app.request(path)
      expect(response.status, path).toBe(404)
    }
  })

  it('permanently redirects singular and legacy package pages to canonical plugins paths', async () => {
    const app = testApp()
    const singularCatalog = await app.request('https://store.example/plugin?q=terminal')
    const singularDetail = await app.request(
      'https://store.example/plugin/openma-ai/deepseek-harness-tui?source=singular',
    )
    const trailingSingularDetail = await app.request(
      'https://store.example/plugin/openma-ai/deepseek-harness-tui/?source=singular-trailing',
    )
    const catalog = await app.request('https://store.example/packages?q=terminal')
    const trailingCatalog = await app.request('https://store.example/packages/?q=terminal')
    const detail = await app.request(
      'https://store.example/packages/openma-ai/deepseek-harness-tui?source=legacy',
    )
    const trailingDetail = await app.request(
      'https://store.example/packages/openma-ai/deepseek-harness-tui/?source=legacy-trailing',
    )

    expect(singularCatalog.status).toBe(301)
    expect(singularCatalog.headers.get('Location')).toBe('https://store.example/plugins?q=terminal')
    expect(singularDetail.status).toBe(301)
    expect(singularDetail.headers.get('Location')).toBe(
      'https://store.example/plugins/openma-ai/deepseek-harness-tui?source=singular',
    )
    expect(trailingSingularDetail.status).toBe(301)
    expect(trailingSingularDetail.headers.get('Location')).toBe(
      'https://store.example/plugins/openma-ai/deepseek-harness-tui?source=singular-trailing',
    )
    expect(catalog.status).toBe(301)
    expect(catalog.headers.get('Location')).toBe('https://store.example/plugins?q=terminal')
    expect(trailingCatalog.status).toBe(301)
    expect(trailingCatalog.headers.get('Location')).toBe('https://store.example/plugins?q=terminal')
    expect(detail.status).toBe(301)
    expect(detail.headers.get('Location')).toBe(
      'https://store.example/plugins/openma-ai/deepseek-harness-tui?source=legacy',
    )
    expect(trailingDetail.status).toBe(301)
    expect(trailingDetail.headers.get('Location')).toBe(
      'https://store.example/plugins/openma-ai/deepseek-harness-tui?source=legacy-trailing',
    )
  })

  it('returns every filtered result with rankings and cache metadata', async () => {
    const response = await testApp().request('/api/v1/plugins?category=fun&q=gomoku')
    expect(response.status).toBe(200)
    expect(response.headers.get('X-Catalog-Source')).toBe('kv')
    const body = (await response.json()) as {
      packages: Array<{ name: string }>
      rankings: { stars: Array<{ name: string }> }
      meta: { total: number; catalogTotal: number }
    }
    expect(body.packages.map((plugin) => plugin.name)).toEqual(['dsh-gomoku'])
    expect(body.rankings.stars[0]?.name).toBe('dsh-crosstalk')
    expect(body.meta).toMatchObject({ total: 1, catalogTotal: TEST_PLUGINS.length })
  })

  it('caps the compatibility catalog listing at 500 plugins while retaining full totals', async () => {
    const result = testCatalogResult()
    // TEST_PLUGINS[0] is npm-published, so every clone stays in the
    // installable v1 listing and only the cap trims the response.
    const plugins = Array.from({ length: 505 }, (_, index) => {
      const suffix = String(index).padStart(3, '0')
      return {
        ...TEST_PLUGINS[0]!,
        id: `partner/plugin-${suffix}`,
        name: `plugin-${suffix}`,
        owner: 'partner',
        repository: `plugin-${suffix}`,
        url: `https://github.com/partner/plugin-${suffix}`,
      }
    })
    const app = createApp({
      catalogLoader: vi.fn(async () => ({
        ...result,
        snapshot: { ...result.snapshot, plugins },
      })),
    })

    const response = await app.request('/api/v1/plugins?sort=name')
    const body = await response.json() as {
      packages: Array<{ name: string }>
      meta: { total: number; catalogTotal: number }
    }

    expect(response.status).toBe(200)
    expect(body.packages).toHaveLength(500)
    expect(body.packages[0]?.name).toBe('plugin-000')
    expect(body.packages.at(-1)?.name).toBe('plugin-499')
    expect(body.meta).toMatchObject({ total: 505, catalogTotal: 505 })
  })

  it('keeps browse-only plugins out of the v1 partner listing', async () => {
    // The partner surface lists only installable plugins; the site keeps
    // showing everything. TEST_PLUGINS mixes npm-published and source-only
    // fixtures, so the split falls out of the default catalog.
    const response = await testApp().request('/api/v1/plugins')
    const body = await response.json() as {
      packages: Array<{ id: string; install: string }>
      meta: { total: number; catalogTotal: number }
    }

    expect(body.packages.map((plugin) => plugin.id).sort()).toEqual([
      'Jesse-njx/dsh-crosstalk',
      'omdsh-dev/dsh-gomoku',
      'openma-ai/deepseek-harness-tui',
    ])
    for (const plugin of body.packages) {
      expect(plugin.install).not.toContain('github:')
    }
    expect(body.meta).toMatchObject({ total: 3, catalogTotal: TEST_PLUGINS.length })
  })

  it('keeps published_package and repository_backlink together for old v1 installers', async () => {
    const result = testCatalogResult()
    const plugins = [...result.snapshot.plugins]
    plugins[0] = {
      ...result.snapshot.plugins[0]!,
      install: 'dsh plugin --profile web add @scope/published-plugin',
      installMethods: [{
        kind: 'npm',
        spec: '@scope/published-plugin',
        command: 'dsh plugin --profile web add @scope/published-plugin',
        verification: 'verified',
        code: 'published_package',
        requiresBuildAllowance: false,
        buildPackage: null,
        revision: '1.2.3',
        checkedAt: '2026-08-20T00:00:00.000Z',
      }],
    }
    result.snapshot = { ...result.snapshot, plugins }
    const app = createApp({ catalogLoader: vi.fn(async () => result) })

    const response = await app.request('/api/v1/plugins')
    const body = await response.json() as {
      packages: Array<{
        id: string
        installMethods?: Array<{
          kind: string
          spec: string
          revision: string | null
          verification: string
          code: string
          requiresBuildAllowance: boolean
        }>
      }>
    }
    const plugin = body.packages.find((candidate) => candidate.id === result.snapshot.plugins[0]!.id)!
    expect(plugin.installMethods?.map((method) => method.code)).toEqual([
      'published_package',
      'repository_backlink',
    ])

    // Mirrors the partner's old adapter: it ignores the new code and accepts
    // one exact, verified repository_backlink target.
    const partnerTargets = new Set(
      plugin.installMethods
        ?.filter((method) =>
          method.kind === 'npm' &&
          method.code === 'repository_backlink' &&
          method.verification === 'verified' &&
          method.requiresBuildAllowance === false &&
          /^\d+\.\d+\.\d+$/.test(method.revision ?? ''),
        )
        .map((method) => `${method.spec}@${method.revision}`),
    )
    expect([...partnerTargets]).toEqual(['@scope/published-plugin@1.2.3'])

    expect(result.snapshot.plugins[0]?.installMethods?.map((method) => method.code))
      .toEqual(['published_package'])
  })

  it('serves package details with the resolved category and rejects invalid identifiers', async () => {
    const app = testApp()
    const detail = await app.request('/api/v1/plugins/openma-ai/deepseek-harness-tui')
    expect(detail.status).toBe(200)
    await expect(detail.json()).resolves.toMatchObject({
      name: 'deepseek-harness-tui',
      category: {
        id: 'ui',
        order: 10,
        label: { en: 'UI Enhancements', zh: 'UI 增强' },
      },
    })

    const invalid = await app.request('/api/v1/plugins/openma-ai/not%20valid')
    expect(invalid.status).toBe(400)

    const missing = await app.request('/api/v1/plugins/openma-ai/missing')
    expect(missing.status).toBe(404)
  })

  it('serves a first-party package summary without waiting for the GitHub detail loader', async () => {
    const detailLoader = vi.fn(async () => {
      throw new Error('the summary route must never reach GitHub')
    })
    const app = createApp({
      catalogLoader: vi.fn(async () => testCatalogResult()),
      detailLoader,
    })

    const summary = await app.request('/api/v2/plugins/openma-ai/deepseek-harness-tui')
    expect(summary.status).toBe(200)
    expect(summary.headers.get('X-Catalog-Source')).toBe('kv')
    expect(summary.headers.get('Cache-Control')).toContain('max-age=300')
    await expect(summary.json()).resolves.toMatchObject({
      id: 'openma-ai/deepseek-harness-tui',
      name: 'deepseek-harness-tui',
      description: expect.objectContaining({ en: expect.any(String), zh: expect.any(String) }),
      installCount: expect.any(Number),
      category: {
        id: 'ui',
        order: 10,
        label: { en: 'UI Enhancements', zh: 'UI 增强' },
      },
    })
    expect(detailLoader).not.toHaveBeenCalled()

    expect((await app.request('/api/v2/plugins/openma-ai/not%20valid')).status).toBe(400)
    expect((await app.request('/api/v2/plugins/openma-ai/missing')).status).toBe(404)
  })

  it('serves a monorepo subpackage plugin at its subdirectory path', async () => {
    // Echoes back whichever plugin the route resolved, so the assertions prove
    // the id lookup rather than the stub's fixed payload.
    const app = createApp({
      catalogLoader: vi.fn(async () => testCatalogResult()),
      detailLoader: vi.fn(async (plugin) => ({
        ...plugin,
        github: null,
        manifest: null,
        readme: null,
      readmeBasePath: '',
        verification: { repositoryReachable: false, bundleDeclared: false },
      } satisfies PackageDetail)),
    })

    const detail = await app.request('/api/v1/plugins/omdsh-dev/dsh-suite/packages/dsh-inspector')
    expect(detail.status).toBe(200)
    await expect(detail.json()).resolves.toMatchObject({
      id: 'omdsh-dev/dsh-suite/packages/dsh-inspector',
      name: 'dsh-inspector',
      install: 'dsh plugin --profile web add github:omdsh-dev/dsh-suite#path:packages/dsh-inspector',
    })

    // The sibling resolves independently rather than colliding on the repository.
    const sibling = await app.request('/api/v1/plugins/omdsh-dev/dsh-suite/packages/dsh-timeline')
    await expect(sibling.json()).resolves.toMatchObject({ name: 'dsh-timeline' })

    // The repository hosts two plugins, so it cannot pick a successor.
    expect((await app.request('/api/v1/plugins/omdsh-dev/dsh-suite')).status).toBe(404)
    // Plain and percent-encoded dot-dot segments are collapsed by URL parsing
    // before routing, so they resolve to a different (absent) id.
    expect((await app.request('/api/v1/plugins/omdsh-dev/dsh-suite/../secret')).status).toBe(404)
    expect((await app.request('/api/v1/plugins/omdsh-dev/dsh-suite/%2e%2e/secret')).status).toBe(404)
    // An encoded slash survives parsing and must be rejected, not smuggled into
    // a segment.
    expect((await app.request('/api/v1/plugins/omdsh-dev/dsh-suite/..%2Fsecret')).status).toBe(400)
  })

  it('redirects a repository id whose only plugin moved into a subdirectory', async () => {
    const base = testCatalogResult()
    // One survivor under omdsh-dev/dsh-suite, mirroring a discovered repository
    // whose bundle lives in a nested package.
    const app = createApp({
      catalogLoader: vi.fn(async () => ({
        ...base,
        snapshot: {
          ...base.snapshot,
          plugins: base.snapshot.plugins.filter(
            (plugin) => plugin.id !== 'omdsh-dev/dsh-suite/packages/dsh-timeline',
          ),
        },
      })),
    })

    const response = await app.request('https://store.example/api/v1/plugins/omdsh-dev/dsh-suite')
    expect(response.status).toBe(301)
    expect(response.headers.get('Location')).toBe(
      'https://store.example/api/v1/plugins/omdsh-dev/dsh-suite/packages/dsh-inspector',
    )
  })

  it('serves the built-in unclassified descriptor for scan-discovered plugins', async () => {
    const base = testCatalogResult()
    const detail = {
      ...TEST_PLUGINS[0],
      github: null,
      manifest: null,
      readme: null,
      readmeBasePath: '',
      verification: { repositoryReachable: false, bundleDeclared: false },
    } satisfies PackageDetail
    const app = createApp({
      catalogLoader: vi.fn(async () => ({
        ...base,
        snapshot: {
          ...base.snapshot,
          plugins: base.snapshot.plugins.map((plugin, index) =>
            index === 0 ? { ...plugin, category: 'unclassified' } : plugin),
        },
      })),
      detailLoader: vi.fn(async () => detail),
    })

    const response = await app.request('/api/v1/plugins/openma-ai/deepseek-harness-tui')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      category: {
        id: 'unclassified',
        order: 1000,
        label: { en: 'Unclassified', zh: '待分类' },
      },
    })
  })

  it('projects the compact registry with categories and install commands', async () => {
    const response = await testApp().request('/api/v1/registry', {
      headers: { Origin: 'https://registry-consumer.example' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    // The in-app store reads this endpoint; without revalidation a newly listed
    // plugin waits out the full edge TTL before it can appear there.
    expect(response.headers.get('Cache-Control')).toContain('stale-while-revalidate=')
    const body = (await response.json()) as {
      name: string
      updated: string
      count: number
      total: number
      categories: Array<{ id: string; order: number; label: { en: string; zh: string } }>
      plugins: Array<Record<string, unknown>>
    }
    expect(body.name).toBe('dsh-1024store-catalog')
    expect(body.updated).toBe(testCatalogResult().snapshot.generatedAt)
    expect(body.count).toBe(TEST_PLUGINS.length)
    expect(body.total).toBe(TEST_PLUGINS.length)
    expect(body.plugins).toHaveLength(body.count)
    expect(body.categories[0]).toEqual({
      id: 'ui',
      order: 10,
      label: { en: 'UI Enhancements', zh: 'UI 增强' },
    })
    expect(body.categories.map((category) => category.order))
      .toEqual([...body.categories.map((category) => category.order)].sort((a, b) => a - b))
    expect(body.plugins[0]).toEqual({
      id: 'openma-ai/deepseek-harness-tui',
      name: 'deepseek-harness-tui',
      owner: 'openma-ai',
      url: 'https://github.com/openma-ai/deepseek-harness-tui',
      category: 'ui',
      description: TEST_PLUGINS[0]!.description,
      install: 'dsh plugin --profile web add @openma/deepseek-harness-tui',
      target: '@openma/deepseek-harness-tui',
      allowBuild: null,
      added: '2026-08-14',
      stars: 42,
    })
    // Registry entries keep browse-only plugins (installed-plugin recognition
    // depends on them), with the source spec as target and never a build
    // allowance (issue #159).
    const browseOnly = body.plugins.find((plugin) => plugin.id === 'MAXeaglet/dsh-bash-terminal')
    expect(browseOnly).toMatchObject({
      target: 'github:MAXeaglet/dsh-bash-terminal',
      allowBuild: null,
    })
  })

  it('caps the registry at its install-ranked head while reporting the full catalog size', async () => {
    // 600 plugins: the first 300 were never installed (their stars ascend with
    // the index), the last 300 all have recorded installs but zero stars. The
    // cap must keep every installed entry — even though they are the
    // lowest-star plugins in the catalog — and backfill the remaining 200
    // seats with the highest-star never-installed entries, all in snapshot
    // order rather than a sorted one.
    const template = TEST_PLUGINS[0]!
    const result = testCatalogResult()
    result.snapshot.plugins = Array.from({ length: 600 }, (_, index) => ({
      ...template,
      id: `capowner/plugin-${String(index).padStart(3, '0')}`,
      name: `plugin-${String(index).padStart(3, '0')}`,
      owner: 'capowner',
      url: `https://github.com/capowner/plugin-${String(index).padStart(3, '0')}`,
      installCount: index < 300 ? 0 : index,
      installerCount: 0,
      stars: index < 300 ? index : 0,
    }))
    const app = createApp({ catalogLoader: vi.fn(async () => result) })

    const response = await app.request('/api/v1/registry')
    const body = (await response.json()) as {
      count: number
      total: number
      plugins: Array<{ id: string; stars: number }>
    }

    expect(body.count).toBe(500)
    expect(body.total).toBe(600)
    expect(body.plugins).toHaveLength(500)
    // The frozen dsh1024 validator requires count === plugins.length.
    expect(body.count).toBe(body.plugins.length)
    // Installed entries 300–599 all survive; the 200 backfill seats go to the
    // highest-star never-installed entries 100–299; snapshot order throughout.
    expect(body.plugins.map((plugin) => plugin.id)).toEqual(
      result.snapshot.plugins.slice(100).map((plugin) => plugin.id),
    )
  })

  it('projects a structured npm preference for the in-app installer', async () => {
    const result = testCatalogResult()
    result.snapshot.plugins[0] = {
      ...result.snapshot.plugins[0]!,
      install: 'dsh plugin --profile web add @scope/published-plugin',
      installMethods: [{
        kind: 'npm',
        spec: '@scope/published-plugin',
        command: 'dsh plugin --profile web add @scope/published-plugin',
        verification: 'verified',
        code: 'published_package',
        requiresBuildAllowance: false,
        buildPackage: null,
        revision: '1.0.0',
        checkedAt: null,
      }],
    }
    const app = createApp({ catalogLoader: vi.fn(async () => result) })

    const response = await app.request('/api/v1/registry')
    const body = (await response.json()) as { plugins: Array<Record<string, unknown>> }

    expect(body.plugins[0]).toMatchObject({
      install: 'dsh plugin --profile web add @scope/published-plugin',
      target: '@scope/published-plugin',
      allowBuild: null,
    })
  })

  it('serves the store client update manifest from D1 without consulting the catalog snapshot', async () => {
    const catalogLoader = vi.fn(async () => testCatalogResult())
    const selfUpdateLoader = vi.fn(async () => ({
      version: '4.5.6',
      checkedAt: '2026-08-20T08:00:00Z',
    }))
    const app = createApp({ catalogLoader, selfUpdateLoader })

    const database = {} as D1Database
    const response = await app.request(
      '/api/v1/self/update',
      undefined,
      { CATALOG_DB: database } as unknown as Env,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(catalogLoader).not.toHaveBeenCalled()
    expect(selfUpdateLoader).toHaveBeenCalledWith(database, [
      'imsai-sh/awesome-deepseek-harness-plugins/packages/dsh1024',
      'imsai-sh/awesome-deepseek-harness-plugins',
    ], 'dsh1024')
    await expect(response.json()).resolves.toEqual({
      package: 'dsh1024',
      version: '4.5.6',
      releaseUrl: 'https://deepseek1024.com/plugins/imsai-sh/awesome-deepseek-harness-plugins/packages/dsh1024',
      checkedAt: '2026-08-20T08:00:00Z',
    })
  })

  it('retains the cached catalog fallback when D1 is unavailable locally', async () => {
    const result = testCatalogResult()
    result.snapshot.plugins = [...result.snapshot.plugins, {
      ...result.snapshot.plugins[0]!,
      id: 'imsai-sh/awesome-deepseek-harness-plugins/packages/dsh1024',
      name: 'dsh1024',
      owner: 'imsai-sh',
      repository: 'awesome-deepseek-harness-plugins',
      url: 'https://github.com/imsai-sh/awesome-deepseek-harness-plugins',
      install: 'dsh plugin --profile web add dsh1024',
      installMethods: [{
        kind: 'npm',
        spec: 'dsh1024',
        command: 'dsh plugin --profile web add dsh1024',
        verification: 'verified',
        code: 'published_package',
        requiresBuildAllowance: false,
        buildPackage: null,
        revision: '4.5.6',
        checkedAt: '2026-08-20T08:00:00Z',
      }],
    }]
    const app = createApp({ catalogLoader: vi.fn(async () => result) })

    const response = await app.request('/api/v1/self/update')

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      package: 'dsh1024',
      version: '4.5.6',
      releaseUrl: 'https://deepseek1024.com/plugins/imsai-sh/awesome-deepseek-harness-plugins/packages/dsh1024',
      checkedAt: '2026-08-20T08:00:00Z',
    })
  })

  it('fails closed when the store client version is absent from the snapshot', async () => {
    const response = await testApp().request('/api/v1/self/update')

    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('rejects catalog sync when the token is missing or wrong', async () => {
    const { app, curatedSyncer } = syncApp()

    const unconfigured = await app.request(
      '/api/v1/catalog/sync',
      syncRequest({ source: 'github_ci', entries: [VALID_SYNC_ENTRY] }),
      { CATALOG_DB: {} } as unknown as Env,
    )
    expect(unconfigured.status).toBe(503)

    const missing = await app.request(
      '/api/v1/catalog/sync',
      syncRequest({ source: 'github_ci', entries: [VALID_SYNC_ENTRY] }, null),
      SYNC_ENV,
    )
    expect(missing.status).toBe(401)

    const wrong = await app.request(
      '/api/v1/catalog/sync',
      syncRequest({ source: 'github_ci', entries: [VALID_SYNC_ENTRY] }, 'not-the-token'),
      SYNC_ENV,
    )
    expect(wrong.status).toBe(401)
    expect(curatedSyncer).not.toHaveBeenCalled()
  })

  it('fails closed when the configured catalog sync token is too short', async () => {
    const { app, curatedSyncer } = syncApp()
    const response = await app.request(
      '/api/v1/catalog/sync',
      syncRequest({ source: 'github_ci', entries: [VALID_SYNC_ENTRY] }, 'short-token'),
      {
        CATALOG_DB: {},
        CATALOG_SYNC_TOKEN: 'short-token',
      } as unknown as Env,
    )

    expect(response.status).toBe(503)
    expect(curatedSyncer).not.toHaveBeenCalled()
  })

  it('validates the catalog sync payload', async () => {
    const { app, curatedSyncer } = syncApp()

    const badSource = await app.request(
      '/api/v1/catalog/sync',
      syncRequest({ source: 'manual', entries: [VALID_SYNC_ENTRY] }),
      SYNC_ENV,
    )
    expect(badSource.status).toBe(400)

    const emptyEntries = await app.request(
      '/api/v1/catalog/sync',
      syncRequest({ source: 'github_ci', entries: [] }),
      SYNC_ENV,
    )
    expect(emptyEntries.status).toBe(400)

    const unknownCategory = await app.request(
      '/api/v1/catalog/sync',
      syncRequest({
        source: 'github_ci',
        entries: [{ ...VALID_SYNC_ENTRY, category: 'not-a-category' }],
      }),
      SYNC_ENV,
    )
    expect(unknownCategory.status).toBe(400)

    const extraField = await app.request(
      '/api/v1/catalog/sync',
      syncRequest({
        source: 'github_ci',
        entries: [{ ...VALID_SYNC_ENTRY, $schema: '../schema/plugin.schema.json' }],
      }),
      SYNC_ENV,
    )
    expect(extraField.status).toBe(400)

    const nonGitHubRepository = await app.request(
      '/api/v1/catalog/sync',
      syncRequest({
        source: 'github_ci',
        entries: [{ ...VALID_SYNC_ENTRY, repository: 'https://example.com/openma-ai/deepseek-harness-tui' }],
      }),
      SYNC_ENV,
    )
    expect(nonGitHubRepository.status).toBe(400)

    const mismatchedRepository = await app.request(
      '/api/v1/catalog/sync',
      syncRequest({
        source: 'github_ci',
        entries: [{ ...VALID_SYNC_ENTRY, repository: 'https://github.com/attacker/other-repository' }],
      }),
      SYNC_ENV,
    )
    expect(mismatchedRepository.status).toBe(400)

    // A subdirectory id keeps the repository-root URL; traversal is rejected.
    const traversalId = await app.request(
      '/api/v1/catalog/sync',
      syncRequest({
        source: 'github_ci',
        entries: [{
          ...VALID_SYNC_ENTRY,
          id: 'openma-ai/deepseek-harness-tui/../secret',
        }],
      }),
      SYNC_ENV,
    )
    expect(traversalId.status).toBe(400)

    const subdirectoryWithNestedUrl = await app.request(
      '/api/v1/catalog/sync',
      syncRequest({
        source: 'github_ci',
        entries: [{
          ...VALID_SYNC_ENTRY,
          id: 'openma-ai/deepseek-harness-tui/packages/foo',
          repository: 'https://github.com/openma-ai/deepseek-harness-tui/packages/foo',
        }],
      }),
      SYNC_ENV,
    )
    expect(subdirectoryWithNestedUrl.status).toBe(400)
    expect(curatedSyncer).not.toHaveBeenCalled()

    const subdirectory = await app.request(
      '/api/v1/catalog/sync',
      syncRequest({
        source: 'github_ci',
        entries: [{ ...VALID_SYNC_ENTRY, id: 'openma-ai/deepseek-harness-tui/packages/foo' }],
      }),
      SYNC_ENV,
    )
    expect(subdirectory.status).toBe(200)
    expect(curatedSyncer.mock.calls[0]?.[1])
      .toEqual([expect.objectContaining({ id: 'openma-ai/deepseek-harness-tui/packages/foo' })])
  })

  it('reconciles curated entries and refreshes the snapshot synchronously', async () => {
    const { app, curatedSyncer, snapshotRefresher } = syncApp()
    const response = await app.request(
      '/api/v1/catalog/sync',
      syncRequest({ source: 'github_ci', entries: [VALID_SYNC_ENTRY] }),
      SYNC_ENV,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      total: 1,
      removedSources: 2,
    })
    expect(curatedSyncer).toHaveBeenCalledOnce()
    expect(curatedSyncer.mock.calls[0]?.[1]).toEqual([VALID_SYNC_ENTRY])
    expect(curatedSyncer.mock.calls[0]?.[2]).toBe('2026-08-14T12:05:00.000Z')
    expect(snapshotRefresher).toHaveBeenCalledOnce()
  })

  it('accepts a well-formed installation event without exposing client identity', async () => {
    const { app, eventRecorder } = telemetryApp()
    const response = await app.request('/api/v1/install-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://cli.example' },
      body: JSON.stringify(VALID_INSTALL_EVENT),
    }, TELEMETRY_ENV)

    expect(response.status).toBe(202)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      eventId: VALID_INSTALL_EVENT.eventId,
      pluginId: VALID_INSTALL_EVENT.pluginId,
      serverReceivedAt: '2026-08-14T12:05:00.000Z',
    })
    expect(eventRecorder).toHaveBeenCalledOnce()
  })

  it('records events for plugins outside the catalog with their submitted id', async () => {
    const { app, eventRecorder } = telemetryApp()
    const response = await app.request('/api/v1/install-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_INSTALL_EVENT, pluginId: 'unknown/not-in-catalog' }),
    }, TELEMETRY_ENV)

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      pluginId: 'unknown/not-in-catalog',
    })
    expect(eventRecorder).toHaveBeenCalledOnce()
    expect(eventRecorder.mock.calls[0]?.[3]).toBe('unknown/not-in-catalog')
  })

  it('lowercases plugin ids for events outside the catalog so aggregates merge after cataloging', async () => {
    const { app, eventRecorder } = telemetryApp()
    const response = await app.request('/api/v1/install-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_INSTALL_EVENT, pluginId: 'DeepSeek-AI/Not-In-Catalog' }),
    }, TELEMETRY_ENV)

    expect(response.status).toBe(202)
    expect(eventRecorder.mock.calls[0]?.[3]).toBe('deepseek-ai/not-in-catalog')
  })

  it('canonicalizes the plugin id casing for catalog-backed events', async () => {
    const { app, eventRecorder } = telemetryApp()
    const response = await app.request('/api/v1/install-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_INSTALL_EVENT, pluginId: 'OPENMA-AI/DeepSeek-Harness-TUI' }),
    }, TELEMETRY_ENV)

    expect(response.status).toBe(202)
    expect(eventRecorder.mock.calls[0]?.[3]).toBe('openma-ai/deepseek-harness-tui')
  })

  it('returns duplicate eventIds idempotently', async () => {
    const { app } = telemetryApp(true)
    const response = await app.request('/api/v1/install-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_INSTALL_EVENT),
    }, TELEMETRY_ENV)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ accepted: true, duplicate: true })
  })

  it('fails closed when the hashing secret is missing and returns client rate limits', async () => {
    const missingSecret = telemetryApp()
    const unavailable = await missingSecret.app.request('/api/v1/install-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_INSTALL_EVENT),
    }, { CATALOG_DB: {} } as unknown as Env)
    expect(unavailable.status).toBe(503)
    expect(missingSecret.eventRecorder).not.toHaveBeenCalled()

    const limited = telemetryApp('rate-limit')
    const response = await limited.app.request('/api/v1/install-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_INSTALL_EVENT),
    }, TELEMETRY_ENV)
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('30')
    await expect(response.json()).resolves.toEqual({ error: 'Too many installation events.' })
  })

  it('rejects oversized bodies and unexpected fields', async () => {
    const { app, eventRecorder } = telemetryApp()
    const oversized = await app.request('/api/v1/install-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_INSTALL_EVENT, requestedRef: 'x'.repeat(9_000) }),
    }, TELEMETRY_ENV)
    expect(oversized.status).toBe(413)

    const extra = await app.request('/api/v1/install-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_INSTALL_EVENT, command: 'private command' }),
    }, TELEMETRY_ENV)
    expect(extra.status).toBe(400)
    await expect(extra.json()).resolves.toMatchObject({ error: 'Unexpected field: command.' })
    expect(eventRecorder).not.toHaveBeenCalled()
  })

  it('serves the store plugin install stats with cache metadata', async () => {
    const metrics = {
      ...emptyInstallMetrics(),
      installCount: 21,
      installerCount: 13,
      installs7d: 5,
      latestInstallAt: '2026-08-14T12:05:00.000Z',
    }
    const installStatsLoader = vi.fn(async () => metrics)
    const app = createApp({
      catalogLoader: vi.fn(async () => testCatalogResult()),
      installStatsLoader,
      clock: () => Date.parse('2026-08-14T12:06:00Z'),
    })

    const response = await app.request('/api/v1/self/install-stats', undefined, TELEMETRY_ENV)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=30, s-maxage=300, stale-while-revalidate=3600',
    )
    await expect(response.json()).resolves.toEqual(metrics)
    expect(installStatsLoader).toHaveBeenCalledOnce()
    expect(installStatsLoader).toHaveBeenCalledWith(
      TELEMETRY_ENV.CATALOG_DB,
      'imsai-sh/awesome-deepseek-harness-plugins',
      Date.parse('2026-08-14T12:06:00Z'),
    )
  })

  it('returns empty store plugin install stats when the database is unavailable', async () => {
    const installStatsLoader = vi.fn(async () => {
      throw new Error('must not query a missing database')
    })
    const app = createApp({
      catalogLoader: vi.fn(async () => testCatalogResult()),
      installStatsLoader,
    })

    const response = await app.request('/api/v1/self/install-stats')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(emptyInstallMetrics())
    expect(installStatsLoader).not.toHaveBeenCalled()
    // Every other read endpoint is noindex; this one must not be the exception
    // that ends up as the only indexable JSON on the domain.
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex')
  })

  it('merges aggregate installation metrics into package details', async () => {
    const metrics = {
      ...emptyInstallMetrics(),
      installCount: 12,
      installerCount: 8,
      installs24h: 3,
      latestInstallAt: '2026-08-14T12:05:00.000Z',
    }
    const app = createApp({
      catalogLoader: vi.fn(async () => testCatalogResult()),
      detailLoader: vi.fn(async () => ({
        ...TEST_PLUGINS[0],
        github: null,
        manifest: null,
        readme: null,
      readmeBasePath: '',
        verification: { repositoryReachable: false, bundleDeclared: false },
      })),
      installStatsLoader: vi.fn(async () => metrics),
      clock: () => Date.parse('2026-08-14T12:06:00Z'),
    })
    const detail = await app.request(
      '/api/v1/plugins/openma-ai/deepseek-harness-tui',
      undefined,
      TELEMETRY_ENV,
    )
    expect(detail.status).toBe(200)
    await expect(detail.json()).resolves.toMatchObject(metrics)
  })
})

describe('collection query classification', () => {
  it('separates filters, which change the page, from tags, which do not', () => {
    const kind = (href: string) => collectionQueryKind(new URL(href))

    expect(kind('https://deepseek1024.com/')).toBe('clean')
    // An empty filter renders the unfiltered page, so it canonicalises to it
    // rather than being noindexed as a permutation.
    expect(kind('https://deepseek1024.com/plugins?q=')).not.toBe('filtered')
    expect(kind('https://deepseek1024.com/plugins?q=theme')).toBe('filtered')
    expect(kind('https://deepseek1024.com/plugins?category=ui')).toBe('filtered')
    // A campaign tag serves the same page: noindexing it would throw away every
    // shared link instead of consolidating it onto the clean URL.
    expect(kind('https://deepseek1024.com/?utm_source=newsletter')).toBe('tagged')
    expect(kind('https://deepseek1024.com/?fbclid=abc')).toBe('tagged')
    expect(kind('https://deepseek1024.com/plugins/acme/widget?utm_source=x')).toBe('clean')
  })

})

describe('catalog listing validator', () => {
  it('lets a poller be answered with 304 instead of another megabyte', async () => {
    const app = testApp()
    const first = await app.request('https://deepseek1024.com/api/v1/plugins')
    const etag = first.headers.get('ETag')
    expect(etag).toMatch(/^W\/"/)

    // The same snapshot and the same query have to produce the same validator,
    // or every poll looks like a change and the 304 never fires.
    const second = await app.request('https://deepseek1024.com/api/v1/plugins')
    expect(second.headers.get('ETag')).toBe(etag)

    // A different query is a different body and must not reuse it.
    const filtered = await app.request('https://deepseek1024.com/api/v1/plugins?sort=newest')
    expect(filtered.headers.get('ETag')).not.toBe(etag)
  })

  it('gives the registry projection its own validator', async () => {
    const registry = await testApp().request('https://deepseek1024.com/api/v1/registry')
    expect(registry.headers.get('ETag')).toMatch(/^W\/"/)
  })
})

describe('v2 endpoints', () => {
  it('serves a directory page with pagination metadata and a content validator', async () => {
    const response = await testApp().request('https://deepseek1024.com/api/v2/plugins?limit=1')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('application/json')
    expect(response.headers.get('ETag')).toMatch(/^W\/"/)
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex')
    const body = await response.json() as { plugins: unknown[]; page: number; limit: number; total: number; totalPages: number; catalogTotal: number }
    expect(body.plugins).toHaveLength(1)
    expect(body).toMatchObject({ page: 1, limit: 1 })
    expect(body.total).toBeGreaterThan(0)
    expect(body.catalogTotal).toBeGreaterThan(0)
  })

  it('gives a different page a different validator', async () => {
    const app = testApp()
    const p1 = await app.request('https://deepseek1024.com/api/v2/plugins?limit=1&page=1')
    const p2 = await app.request('https://deepseek1024.com/api/v2/plugins?limit=1&page=2')
    expect(p1.headers.get('ETag')).not.toBe(p2.headers.get('ETag'))
  })

  it('serves the rankings boards with their sibling groups', async () => {
    const response = await testApp().request('https://deepseek1024.com/api/v2/rankings')
    expect(response.status).toBe(200)
    expect(response.headers.get('ETag')).toMatch(/^W\/"/)
    const body = await response.json() as { rankings: Record<string, unknown[]>; siblingsByRepository: Record<string, unknown> }
    expect(Object.keys(body.rankings)).toContain('stars')
    expect(body.siblingsByRepository).toBeTypeOf('object')
  })
})

describe('v3 endpoints', () => {
  it('serves npm downloads separately from the compatible v2 boards', async () => {
    const app = testApp()
    const v2 = await app.request('https://deepseek1024.com/api/v2/rankings')
    const v3 = await app.request('https://deepseek1024.com/api/v3/rankings')
    const v2Body = await v2.json() as { rankings: Record<string, unknown[]> }
    const v3Body = await v3.json() as { rankings: Record<string, unknown[]> }

    expect(v2Body.rankings).not.toHaveProperty('npmDownloads7d')
    expect(v3.status).toBe(200)
    expect(v3Body.rankings).toHaveProperty('npmDownloads7d')
  })
})
