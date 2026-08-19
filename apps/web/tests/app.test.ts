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
    expect(body).toContain('dsh plugin --profile web add github:')
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
      categories: Array<{ id: string; order: number; label: { en: string; zh: string } }>
      plugins: Array<Record<string, unknown>>
    }
    expect(body.name).toBe('dsh-1024store-catalog')
    expect(body.updated).toBe(testCatalogResult().snapshot.generatedAt)
    expect(body.count).toBe(TEST_PLUGINS.length)
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
      install: 'dsh plugin --profile web add github:openma-ai/deepseek-harness-tui',
      added: '2026-08-14',
      stars: 42,
    })
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
