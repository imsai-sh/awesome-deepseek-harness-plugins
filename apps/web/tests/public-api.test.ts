import { describe, expect, it } from 'vitest'
import { isPublicApiHost, publicApiNotFound, rewritePublicApiUrl, wwwRedirect } from '../worker/public-api'

describe('public API host mapping', () => {
  it('recognises only the dedicated API host', () => {
    expect(isPublicApiHost(new URL('https://api.deepseek1024.com/v1/plugins/search'))).toBe(true)
    expect(isPublicApiHost(new URL('https://deepseek1024.com/api/v1/plugins/search'))).toBe(false)
    expect(isPublicApiHost(new URL('http://localhost:5641/v1/plugins/search'))).toBe(false)
  })

  it('rewrites the public /v1 paths onto internal routes and keeps the query', () => {
    const search = rewritePublicApiUrl(new URL('https://api.deepseek1024.com/v1/plugins/search?q=telegram&limit=5'))
    expect(search?.pathname).toBe('/api/v1/plugins/search')
    expect(search?.searchParams.get('q')).toBe('telegram')
    expect(search?.searchParams.get('limit')).toBe('5')

    const registry = rewritePublicApiUrl(new URL('https://api.deepseek1024.com/v1/registry'))
    expect(registry?.pathname).toBe('/api/v1/registry')

    const health = rewritePublicApiUrl(new URL('https://api.deepseek1024.com/v1/health'))
    expect(health?.pathname).toBe('/api/v1/health')
  })

  it('exposes nothing else on the public host', () => {
    for (const path of ['/api/v1/plugins/search', '/v1/plugins', '/v1/api-keys', '/api/v1/registry', '/docs/api']) {
      expect(rewritePublicApiUrl(new URL(`https://api.deepseek1024.com${path}`))).toBeNull()
    }
  })

  it('permanently redirects www to the apex host with path and query intact', () => {
    const redirect = wwwRedirect(new URL('https://www.deepseek1024.com/plugins?q=x'))
    expect(redirect?.status).toBe(301)
    expect(redirect?.headers.get('Location')).toBe('https://deepseek1024.com/plugins?q=x')
    expect(wwwRedirect(new URL('https://deepseek1024.com/'))).toBeNull()
    expect(wwwRedirect(new URL('https://api.deepseek1024.com/v1/health'))).toBeNull()
  })

  it('redirects the bare host to the docs and 404s unknown paths', async () => {
    const root = publicApiNotFound('/')
    expect(root.status).toBe(302)
    expect(root.headers.get('Location')).toBe('https://deepseek1024.com/docs/api')

    const robots = publicApiNotFound('/robots.txt')
    expect(robots.status).toBe(200)
    await expect(robots.text()).resolves.toBe('User-agent: *\nDisallow: /\n')

    const missing = publicApiNotFound('/v1/api-keys')
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toMatchObject({ code: 'NOT_FOUND' })
  })
})
