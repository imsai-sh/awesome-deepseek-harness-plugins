import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import Ajv, { type AnySchema, type ValidateFunction } from 'ajv'
import { describe, expect, it, vi } from 'vitest'
import { LIVE_STATS_API_PATH } from '../worker/api-paths'
import { createApp } from '../worker/app'
import { PUBLIC_API_PATHS, rewritePublicApiUrl } from '../worker/public-api'
import { accountsDatabase, sqliteD1 } from './d1-sqlite'
import { communityDatabase } from './community-fixtures'
import { testCatalogResult } from './fixtures'

interface SurfaceRoute {
  method: string
  path: string
  implementation: 'hono' | 'worker'
  transport: 'http' | 'websocket'
  version: string
  schema?: string
  test: string
}

interface SurfaceAlias {
  host: string
  path: string
  target: string
  test: string
}

interface ApiSurface {
  contractVersion: number
  policy: string
  routes: SurfaceRoute[]
  aliases: SurfaceAlias[]
}

interface BehaviorFixture {
  method: string
  path: string
  status: number
  body?: unknown
  location?: string
  environment?: 'community'
}

const contractsRoot = new URL('../contracts/', import.meta.url)
const appRoot = new URL('../', import.meta.url)

function json<T = unknown>(relative: string): T {
  return JSON.parse(readFileSync(new URL(relative, contractsRoot), 'utf8')) as T
}

function routeKey(route: Pick<SurfaceRoute, 'method' | 'path'>): string {
  return `${route.method.toUpperCase()} ${route.path}`
}

function contractApp() {
  return createApp({
    catalogLoader: vi.fn(async () => testCatalogResult()),
    clock: () => Date.parse('2026-08-16T08:00:30Z'),
  })
}

function searchEnv(database: DatabaseSync): Env {
  return {
    CATALOG_DB: sqliteD1(database),
    INSTALL_CLIENT_HASH_SECRET: 'contract-test-secret-0123456789abcdef',
  } as unknown as Env
}

function validationMessage(validate: ValidateFunction): string {
  return JSON.stringify(validate.errors, null, 2)
}

const surface = json<ApiSurface>('api-surface.json')
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: true })
ajv.addSchema(json<AnySchema>('schemas/catalog.schema.json'))

function expectSchema(relative: string, value: unknown): void {
  const validate = ajv.compile(json<AnySchema>(relative))
  expect(validate(value), validationMessage(validate)).toBe(true)
}

describe('published API surface', () => {
  it('keeps the manifest well-formed and every referenced artifact present', () => {
    expectSchema('api-surface.schema.json', surface)
    const keys = surface.routes.map(routeKey)
    expect(new Set(keys).size).toBe(keys.length)

    for (const route of surface.routes) {
      expect(() => readFileSync(new URL(route.test, appRoot), 'utf8')).not.toThrow()
      const schema = route.schema
      if (schema) expect(() => readFileSync(new URL(schema, contractsRoot), 'utf8')).not.toThrow()
    }
    for (const alias of surface.aliases) {
      expect(() => readFileSync(new URL(alias.test, appRoot), 'utf8')).not.toThrow()
    }
  })

  it('matches every API route registered by the real Hono application', () => {
    const actual = contractApp().routes
      .filter(route => route.path.startsWith('/api/') && route.method !== 'ALL')
      .map(route => `${route.method} ${route.path}`)
      .sort()
    const declared = surface.routes
      .filter(route => route.implementation === 'hono')
      .map(routeKey)
      .sort()
    expect(actual).toEqual(declared)
  })

  it('matches every API route handled outside Hono', () => {
    const actual = [`GET ${LIVE_STATS_API_PATH}`]
    const declared = surface.routes
      .filter(route => route.implementation === 'worker')
      .map(routeKey)
      .sort()
    expect(actual).toEqual(declared)
  })

  it('locks every dedicated API-host alias to its internal target', () => {
    const declared = Object.fromEntries(surface.aliases.map(alias => [alias.path, alias.target]))
    expect(PUBLIC_API_PATHS).toEqual(declared)
    for (const alias of surface.aliases) {
      const rewritten = rewritePublicApiUrl(new URL(`https://${alias.host}${alias.path}?contract=1`))
      expect(rewritten?.pathname, `${alias.host}${alias.path}`).toBe(alias.target)
      expect(rewritten?.searchParams.get('contract')).toBe('1')
    }
  })
})

describe('historical response contracts', () => {
  it('replays historical defaults and errors for every non-catalog v1 route', async () => {
    const database = communityDatabase()
    const communityEnv = { CATALOG_DB: sqliteD1(database) } as unknown as Env
    try {
      for (const fixture of json<BehaviorFixture[]>('fixtures/v1/default-behavior.golden.json')) {
        const response = await contractApp().request(
          `https://deepseek1024.com${fixture.path}`,
          { method: fixture.method },
          fixture.environment === 'community' ? communityEnv : undefined,
        )
        expect(response.status, `${fixture.method} ${fixture.path}`).toBe(fixture.status)
        if (fixture.body !== undefined) {
          await expect(response.json(), `${fixture.method} ${fixture.path}`).resolves.toEqual(fixture.body)
        }
        if (fixture.location !== undefined) {
          expect(response.headers.get('Location'), `${fixture.method} ${fixture.path}`).toBe(fixture.location)
        }
      }
    } finally {
      database.close()
    }
  })

  it('keeps the v1 registry schema and golden projection compatible', async () => {
    const response = await contractApp().request('/api/v1/registry')
    const body = await response.json() as Record<string, any>
    expectSchema('schemas/v1/registry.response.schema.json', body)

    expect({
      name: body.name,
      updated: body.updated,
      count: body.count,
      total: body.total,
      firstCategory: body.categories[0],
      firstPlugin: {
        id: body.plugins[0].id,
        name: body.plugins[0].name,
        owner: body.plugins[0].owner,
        url: body.plugins[0].url,
        category: body.plugins[0].category,
        install: body.plugins[0].install,
        target: body.plugins[0].target,
        allowBuild: body.plugins[0].allowBuild,
        added: body.plugins[0].added,
        stars: body.plugins[0].stars,
      },
    }).toEqual(json('fixtures/v1/registry.golden.json'))
  })

  it('keeps the v1 listing schema, defaults and ranking semantics compatible', async () => {
    const response = await contractApp().request('/api/v1/plugins')
    const body = await response.json() as Record<string, any>
    expectSchema('schemas/v1/plugins.response.schema.json', body)

    expect({
      packageCount: body.packages.length,
      firstPackageId: body.packages[0].id,
      starsLeaderId: body.rankings.stars[0].id,
      categoryIds: body.categories.map((category: { id: string }) => category.id),
      meta: body.meta,
    }).toEqual(json('fixtures/v1/plugins-default.golden.json'))
  })

  it('keeps the v1 search schema, defaults, quota headers and result projection compatible', async () => {
    const database = accountsDatabase()
    try {
      const response = await contractApp().request(
        'https://deepseek1024.com/api/v1/plugins/search?q=gomoku',
        {},
        searchEnv(database),
      )
      const body = await response.json() as Record<string, any>
      expectSchema('schemas/v1/plugin-search.response.schema.json', body)
      expect({
        query: body.query,
        page: body.page,
        limit: body.limit,
        sortBy: body.sortBy,
        total: body.total,
        totalPages: body.totalPages,
        firstResultId: body.results[0].id,
        dailyLimit: response.headers.get('X-RateLimit-Daily-Limit'),
        dailyRemaining: response.headers.get('X-RateLimit-Daily-Remaining'),
        cacheControl: response.headers.get('Cache-Control'),
      }).toEqual(json('fixtures/v1/plugin-search-default.golden.json'))
    } finally {
      database.close()
    }
  })

  it('keeps v2 pagination schema and defaults compatible', async () => {
    const response = await contractApp().request('/api/v2/plugins')
    const body = await response.json() as Record<string, any>
    expectSchema('schemas/v2/plugins.response.schema.json', body)
    expect({
      page: body.page,
      limit: body.limit,
      total: body.total,
      totalPages: body.totalPages,
      catalogTotal: body.catalogTotal,
      firstPluginId: body.plugins[0].id,
      categoryIds: body.categories.map((category: { id: string }) => category.id),
      generatedAt: body.generatedAt,
      source: body.source,
    }).toEqual(json('fixtures/v2/plugins-default.golden.json'))
  })

  it('keeps v2 ranking schema and repository collapsing compatible', async () => {
    const response = await contractApp().request('/api/v2/rankings')
    const body = await response.json() as Record<string, any>
    expectSchema('schemas/v2/rankings.response.schema.json', body)
    expect({
      catalogTotal: body.catalogTotal,
      starsLeaderId: body.rankings.stars[0].id,
      rankingNames: Object.keys(body.rankings).sort(),
      siblingRepositories: Object.keys(body.siblingsByRepository).sort(),
      generatedAt: body.generatedAt,
      source: body.source,
    }).toEqual(json('fixtures/v2/rankings-default.golden.json'))
  })

  it('publishes npm downloads only on the v3 ranking contract', async () => {
    const response = await contractApp().request('/api/v3/rankings')
    const body = await response.json() as Record<string, any>
    expectSchema('schemas/v3/rankings.response.schema.json', body)
    expect(body.rankings).toHaveProperty('npmDownloads7d')
    expect(Object.keys(body.rankings)).toHaveLength(11)
  })
})
