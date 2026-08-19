import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../worker/app'
import { createApiKey, upsertGitHubUser } from '../worker/lib/auth'
import { accountsDatabase, sqliteD1 } from './d1-sqlite'
import { testCatalogResult } from './fixtures'

const NOW = Date.parse('2026-08-16T08:00:30Z')
const PUBLIC_ORIGIN = 'https://api.deepseek1024.com'
const SITE_ORIGIN = 'https://deepseek1024.com'
const SECRET = 'registry-test-secret-0123456789abcdef!'

// The Hono app under test is reached directly, so the tests call the internal
// route path (`/api/v1/registry`). The /v1 → /api/v1 rewrite is the Worker
// router's job and is covered by public-api.test.ts; metering lives on the
// handler (not the host), so the main-domain path behaves identically.
const REGISTRY_PATH = '/api/v1/registry'

function registryEnv(database: DatabaseSync): Env {
  return {
    CATALOG_DB: sqliteD1(database),
    INSTALL_CLIENT_HASH_SECRET: SECRET,
  } as unknown as Env
}

function registryApp(clock: () => number = () => NOW) {
  return createApp({
    catalogLoader: vi.fn(async () => testCatalogResult()),
    clock,
  })
}

async function issueKey(database: DatabaseSync): Promise<string> {
  const db = sqliteD1(database)
  const user = await upsertGitHubUser(
    db,
    { id: 7, login: 'octocat', name: null, avatarUrl: null },
    new Date(NOW).toISOString(),
  )
  const created = await createApiKey(db, user.id, 'registry key', new Date(NOW).toISOString())
  return created.key
}

describe('public catalog registry API', () => {
  it('serves the registry on the public host with anonymous quota headers', async () => {
    const database = accountsDatabase()
    const response = await registryApp().request(
      `${PUBLIC_ORIGIN}${REGISTRY_PATH}`,
      { headers: { 'CF-Connecting-IP': '203.0.113.7' } },
      registryEnv(database),
    )
    expect(response.status).toBe(200)
    // The registry has its own looser anonymous windows, distinct from search.
    expect(response.headers.get('X-RateLimit-Daily-Limit')).toBe('500')
    expect(response.headers.get('X-RateLimit-Daily-Remaining')).toBe('499')
    const payload = (await response.json()) as { name: string; count: number; plugins: unknown[] }
    expect(payload.name).toBe('dsh-1024store-catalog')
    expect(payload.count).toBe(testCatalogResult().snapshot.plugins.length)
    expect(payload.plugins).toHaveLength(payload.count)
    database.close()
  })

  it('meters the main-domain path exactly like the public host', async () => {
    const database = accountsDatabase()
    const response = await registryApp().request(
      `${SITE_ORIGIN}${REGISTRY_PATH}`,
      { headers: { 'CF-Connecting-IP': '203.0.113.11' } },
      registryEnv(database),
    )
    expect(response.status).toBe(200)
    // Metering lives on the handler, not the host: the main-domain alias draws
    // down the same registry counter as the public developer host.
    expect(response.headers.get('X-RateLimit-Daily-Limit')).toBe('500')
    expect(response.headers.get('X-RateLimit-Daily-Remaining')).toBe('499')
    database.close()
  })

  it('answers conditional revalidation with 304 without consuming quota', async () => {
    const database = accountsDatabase()
    const env = registryEnv(database)
    const app = registryApp()

    const first = await app.request(
      `${PUBLIC_ORIGIN}${REGISTRY_PATH}`,
      { headers: { 'CF-Connecting-IP': '203.0.113.8' } },
      env,
    )
    expect(first.status).toBe(200)
    expect(first.headers.get('X-RateLimit-Daily-Remaining')).toBe('499')
    const etag = first.headers.get('ETag')
    expect(etag).toMatch(/^W\/"/)

    // Polling with the validator gets a 304 and must NOT burn the quota: the
    // remaining counter stays at 499, not 498.
    const revalidated = await app.request(
      `${PUBLIC_ORIGIN}${REGISTRY_PATH}`,
      { headers: { 'CF-Connecting-IP': '203.0.113.8', 'If-None-Match': etag! } },
      env,
    )
    expect(revalidated.status).toBe(304)
    expect(revalidated.headers.get('X-RateLimit-Daily-Remaining')).toBeNull()
    database.close()
  })

  it('answers HEAD with headers and no body, without consuming quota', async () => {
    const database = accountsDatabase()
    const env = registryEnv(database)
    const app = registryApp()

    const response = await app.request(
      `${PUBLIC_ORIGIN}${REGISTRY_PATH}`,
      { method: 'HEAD', headers: { 'CF-Connecting-IP': '203.0.113.12' } },
      env,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('ETag')).toMatch(/^W\/"/)
    expect(response.headers.get('X-RateLimit-Daily-Remaining')).toBeNull()
    expect(await response.text()).toBe('')
    database.close()
  })

  it('is metered independently from the search endpoint', async () => {
    const database = accountsDatabase()
    const env = registryEnv(database)
    const app = registryApp()

    // One search call consumes the search counter (anonymous search quota: 50/day).
    await app.request(
      `${PUBLIC_ORIGIN}/api/v1/plugins/search?q=dsh`,
      { headers: { 'CF-Connecting-IP': '203.0.113.9' } },
      env,
    )
    // The registry call must still report a fresh registry window.
    const response = await app.request(
      `${PUBLIC_ORIGIN}${REGISTRY_PATH}`,
      { headers: { 'CF-Connecting-IP': '203.0.113.9' } },
      env,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('X-RateLimit-Daily-Limit')).toBe('500')
    expect(response.headers.get('X-RateLimit-Daily-Remaining')).toBe('499')
    database.close()
  })

  it('grants API keys the authenticated registry quota', async () => {
    const database = accountsDatabase()
    const key = await issueKey(database)
    const response = await registryApp().request(
      `${PUBLIC_ORIGIN}${REGISTRY_PATH}`,
      { headers: { Authorization: `Bearer ${key}` } },
      registryEnv(database),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('X-RateLimit-Daily-Limit')).toBe('5000')
    expect(response.headers.get('X-RateLimit-Daily-Remaining')).toBe('4999')
    database.close()
  })

  it('rejects invalid API keys', async () => {
    const database = accountsDatabase()
    const response = await registryApp().request(
      `${PUBLIC_ORIGIN}${REGISTRY_PATH}`,
      { headers: { Authorization: 'Bearer dsh_live_not_a_real_key' } },
      registryEnv(database),
    )
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_API_KEY' })
    database.close()
  })

  it('enforces the per-minute registry window', async () => {
    const database = accountsDatabase()
    let now = NOW
    const app = registryApp(() => now)
    const env = registryEnv(database)

    for (let index = 0; index < 20; index += 1) {
      const response = await app.request(
        `${PUBLIC_ORIGIN}${REGISTRY_PATH}`,
        { headers: { 'CF-Connecting-IP': '203.0.113.10' } },
        env,
      )
      expect(response.status).toBe(200)
    }
    const blocked = await app.request(
      `${PUBLIC_ORIGIN}${REGISTRY_PATH}`,
      { headers: { 'CF-Connecting-IP': '203.0.113.10' } },
      env,
    )
    expect(blocked.status).toBe(429)
    await expect(blocked.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' })
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0)
    database.close()
  })

  it('returns 503 when the database is unavailable', async () => {
    const response = await registryApp().request(`${PUBLIC_ORIGIN}${REGISTRY_PATH}`, {}, {} as Env)
    expect(response.status).toBe(503)
  })
})
