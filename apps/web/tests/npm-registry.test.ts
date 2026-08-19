import { describe, expect, it, vi } from 'vitest'

import { probeNpmPackage } from '../worker/lib/npm-registry'

function packument(version: string, repo: string, directory?: string) {
  return {
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        name: 'dsh-widget',
        version,
        main: './index.js',
        repository: directory ? { url: repo, directory } : { url: repo },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        dist: { tarball: 'https://registry.npmjs.org/x.tgz', integrity: 'sha512-abc' },
      },
    },
  }
}

describe('probeNpmPackage', () => {
  it('conditionally GETs the packument root (not /latest) and records the ETag', async () => {
    const captured: { url: string; init: RequestInit } = { url: '', init: {} }
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.url = String(input)
      captured.init = init ?? {}
      return new Response(JSON.stringify(packument('2.1.0', 'git+https://github.com/acme/dsh-widget.git')), {
        headers: { etag: '"v210"' },
      })
    }) as unknown as typeof fetch

    const result = await probeNpmPackage('acme/dsh-widget', 'dsh-widget', '"old"', fetcher)

    expect(captured.url).toBe('https://registry.npmjs.org/dsh-widget')
    const headers = captured.init.headers as Record<string, string>
    expect(headers['If-None-Match']).toBe('"old"')
    expect(headers.Accept).toBe('application/json')
    expect(result.status).toBe('found')
    expect(result.version).toBe('2.1.0')
    expect(result.binding).toBe('strict')
    expect(result.repositoryUrl).toBe('git+https://github.com/acme/dsh-widget.git')
    expect(result.etag).toBe('"v210"')
  })

  it('omits If-None-Match when there is no cached ETag', async () => {
    const captured: { init: RequestInit } = { init: {} }
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.init = init ?? {}
      return new Response(JSON.stringify(packument('1.0.0', 'https://github.com/acme/dsh-widget')), {
        headers: { etag: '"v100"' },
      })
    }) as unknown as typeof fetch

    await probeNpmPackage('acme/dsh-widget', 'dsh-widget', null, fetcher)

    expect((captured.init.headers as Record<string, string>)['If-None-Match']).toBeUndefined()
  })

  it('returns not_modified with no version on a 304', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 304, headers: { etag: '"v210"' } })) as unknown as typeof fetch

    const result = await probeNpmPackage('acme/dsh-widget', 'dsh-widget', '"v210"', fetcher)

    expect(result.status).toBe('not_modified')
    expect(result.version).toBeNull()
    expect(result.etag).toBe('"v210"')
  })

  it('carries the sent ETag through when a 304 omits its own', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 304 })) as unknown as typeof fetch

    const result = await probeNpmPackage('acme/dsh-widget', 'dsh-widget', '"sent"', fetcher)

    expect(result.status).toBe('not_modified')
    expect(result.etag).toBe('"sent"')
  })

  it('reports absent on 404 with no ETag', async () => {
    const fetcher = vi.fn(async () => new Response('not found', { status: 404 })) as unknown as typeof fetch

    const result = await probeNpmPackage('acme/dsh-widget', 'dsh-widget', null, fetcher)

    expect(result.status).toBe('absent')
    expect(result.etag).toBeNull()
  })

  it('degrades to error on a 5xx or a network failure without losing the binding', async () => {
    const failing = vi.fn(async () => new Response('boom', { status: 503 })) as unknown as typeof fetch
    expect((await probeNpmPackage('acme/dsh-widget', 'dsh-widget', '"e"', failing)).status).toBe('error')

    const throwing = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    const result = await probeNpmPackage('acme/dsh-widget', 'dsh-widget', '"e"', throwing)
    expect(result.status).toBe('error')
    expect(result.binding).toBe('unknown')
    expect(result.etag).toBeNull()
  })

  it('treats a packument with no latest version manifest as error', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ 'dist-tags': {}, versions: {} }), {
      headers: { etag: '"x"' },
    })) as unknown as typeof fetch

    expect((await probeNpmPackage('acme/dsh-widget', 'dsh-widget', null, fetcher)).status).toBe('error')
  })
})
