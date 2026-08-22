import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installedPluginIds,
  isTrustedSameOrigin,
  mountMarketRoutes,
  readProfilePnpmStoreDir,
} from '../lib/routes.js'
import { clearRegistryCache, loadRegistry } from '../lib/registry.js'

const baseConfig = {
  profile: 'market-test',
  registryUrl: 'https://deepseek1024.com/api/v1/registry',
  updateUrl: 'https://deepseek1024.com/api/v1/self/update',
}

const catalog = {
  name: 'dsh-1024store-catalog',
  updated: '2026-08-15T00:00:00Z',
  count: 2,
  categories: [{ id: 'tools', order: 1, label: { en: 'Tools', zh: '工具' } }],
  plugins: [
    {
      id: 'owner/mono/packages/child', name: 'child', owner: 'owner',
      url: 'https://github.com/owner/mono', category: 'tools', description: { en: 'child' },
      install: 'dsh plugin add github:owner/mono#path:packages/child',
      target: 'github:owner/mono#path:packages/child', added: '2026-01-01',
    },
    {
      id: 'owner/npm-plugin', name: 'npm-plugin', owner: 'owner',
      url: 'https://github.com/owner/npm-plugin', category: 'tools', description: { en: 'npm' },
      install: 'dsh plugin add published-plugin', target: 'published-plugin', added: '2026-01-01',
    },
  ],
}

function routeHarness(embedUrl, overrides = {}) {
  const routes = new Map()
  const dispose = mountMarketRoutes({
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }, { ...baseConfig, embedUrl, ...overrides })
  return { routes, dispose }
}

test('the shell exposes its validated embed URL without credentials', async () => {
  const { routes, dispose } = routeHarness('https://deepseek1024.com/embed/store?bridge=dsh1024-v1')
  let status = 0
  let body = ''
  await routes.get('/dsh1024/embed-config').handler(
    { method: 'GET' },
    {
      writeHead(value) { status = value },
      end(value = '') { body = String(value) },
    },
  )
  assert.equal(status, 200)
  assert.deepEqual(JSON.parse(body), {
    url: 'https://deepseek1024.com/embed/store?bridge=dsh1024-v1',
    origin: 'https://deepseek1024.com',
  })
  dispose()
  assert.equal(routes.size, 0)
})

test('the shell serves its packaged sidebar icon locally with immutable caching', async () => {
  const { routes, dispose } = routeHarness('https://deepseek1024.com/embed/store?bridge=dsh1024-v1')
  let status = 0
  let headers = {}
  let body = null
  await routes.get('/dsh1024/icon').handler(
    { method: 'GET' },
    {
      writeHead(value, valueHeaders = {}) { status = value; headers = valueHeaders },
      end(value = '') { body = value },
    },
  )
  assert.equal(status, 200)
  assert.equal(headers['content-type'], 'image/png')
  assert.match(headers['cache-control'], /immutable/)
  assert.equal(Buffer.isBuffer(body), true)
  assert.equal(body.subarray(1, 4).toString(), 'PNG')
  dispose()
})

test('loopback HTTP is accepted for local preview but remote HTTP is rejected', () => {
  const { dispose } = routeHarness('http://127.0.0.1:14568/embed/store?bridge=dsh1024-v1')
  dispose()
  assert.throws(
    () => routeHarness('http://store.example/embed/store'),
    /embed URL must use HTTPS/,
  )
  assert.throws(
    () => routeHarness('https://user:secret@store.example/embed/store'),
    /cannot contain credentials/,
  )
})

test('same-origin mutations work on private LAN addresses without trusting public hostnames', () => {
  assert.equal(isTrustedSameOrigin('http://127.0.0.1:14567', '127.0.0.1:14567'), true)
  assert.equal(isTrustedSameOrigin('http://192.168.1.42:14567', '192.168.1.42:14567'), true)
  assert.equal(isTrustedSameOrigin('http://172.20.0.3:14567', '172.20.0.3:14567'), true)
  assert.equal(isTrustedSameOrigin('http://harness.local:14567', 'harness.local:14567'), true)
  assert.equal(isTrustedSameOrigin('http://public.example:14567', 'public.example:14567'), false)
  assert.equal(isTrustedSameOrigin('http://192.168.1.42:14567', '127.0.0.1:14567'), false)
  assert.equal(isTrustedSameOrigin('https://evil.example', '192.168.1.42:14567'), false)
})

test('installed dependencies map to catalog ids without exposing their specs', () => {
  const plugins = [
    {
      id: 'owner/mono', name: 'mono-root', owner: 'owner',
      url: 'https://github.com/owner/mono', category: 'tools', description: { en: 'root' },
      install: 'dsh plugin add github:owner/mono', added: '2026-01-01',
    },
    {
      id: 'owner/mono/packages/child', name: 'child', owner: 'owner',
      url: 'https://github.com/owner/mono', category: 'tools', description: { en: 'child' },
      install: 'dsh plugin add github:owner/mono#path:packages/child', added: '2026-01-01',
    },
    {
      id: 'owner/npm-plugin', name: 'npm-plugin', owner: 'owner',
      url: 'https://github.com/owner/npm-plugin', category: 'tools', description: { en: 'npm' },
      install: 'dsh plugin add published-plugin', target: 'published-plugin', added: '2026-01-01',
    },
  ]
  const installed = {
    child: 'github:owner/mono#path:packages/child&commit=abc123',
    'published-plugin': '^1.2.3',
  }

  assert.deepEqual(installedPluginIds(installed, plugins), [
    'owner/mono/packages/child',
    'owner/npm-plugin',
  ])
})

test('plugin installs reuse the pnpm store already linked to the profile', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'dsh1024-store-dir-'))
  const modules = join(profile, 'node_modules')
  await mkdir(modules)
  await writeFile(join(modules, '.modules.yaml'), JSON.stringify({
    storeDir: '/private/tmp/.pnpm-store/v10',
  }))
  assert.equal(readProfilePnpmStoreDir(profile), '/private/tmp/.pnpm-store/v10')

  await writeFile(join(modules, '.modules.yaml'), "storeDir: '/tmp/yaml-pnpm-store/v10'\n")
  assert.equal(readProfilePnpmStoreDir(profile), '/tmp/yaml-pnpm-store/v10')

  await writeFile(join(modules, '.modules.yaml'), JSON.stringify({ storeDir: '../unsafe' }))
  assert.equal(readProfilePnpmStoreDir(profile), undefined)
})

test('/dsh1024/installed maps profile dependencies against the catalog', async () => {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh1024-installed-route-'))
  const profile = join(dshHome, 'profiles', 'market-test')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    dependencies: {
      child: 'github:owner/mono#path:packages/child&commit=abc123',
      'published-plugin': '^1.2.3',
    },
  }))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    // Seed the process cache through the shared loader so the route never
    // touches the network.
    clearRegistryCache()
    await loadRegistry(baseConfig.registryUrl, async () => new Response(JSON.stringify(catalog), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const { routes, dispose } = routeHarness('https://deepseek1024.com/embed/store?bridge=dsh1024-v1')
    let status = 0
    let body = null
    await routes.get('/dsh1024/installed').handler(
      { method: 'GET' },
      {
        writeHead(value) { status = value },
        end(value = '') { body = JSON.parse(value) },
      },
    )
    assert.equal(status, 200)
    assert.equal(body.profile, 'market-test')
    assert.deepEqual(body.pluginIds, ['owner/mono/packages/child', 'owner/npm-plugin'])
    assert.equal(body.plugins.length, 2)
    assert.equal(body.registryError, undefined)
    dispose()
  } finally {
    clearRegistryCache()
    delete process.env.DSH_HOME
    if (previous !== undefined) process.env.DSH_HOME = previous
    await rm(dshHome, { recursive: true, force: true })
  }
})

test('/dsh1024/installed degrades to the local install state when the registry is unreachable', async () => {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh1024-installed-route-offline-'))
  const profile = join(dshHome, 'profiles', 'market-test')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    dependencies: { 'published-plugin': '^1.2.3' },
  }))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    clearRegistryCache()
    // `.invalid` is guaranteed not to resolve, so the registry fetch fails and
    // no cache exists: the route must answer 200 with the local install state
    // instead of failing the whole panel with 503.
    const { routes, dispose } = routeHarness(
      'https://deepseek1024.com/embed/store?bridge=dsh1024-v1',
      { registryUrl: 'https://store.invalid/api/v1/registry' },
    )
    let status = 0
    let body = null
    await routes.get('/dsh1024/installed').handler(
      { method: 'GET' },
      {
        writeHead(value) { status = value },
        end(value = '') { body = JSON.parse(value) },
      },
    )
    assert.equal(status, 200)
    assert.deepEqual(body.pluginIds, [])
    assert.deepEqual(body.plugins, [])
    assert.equal(typeof body.registryError, 'string')
    assert.equal(body.installed['published-plugin'], '^1.2.3')
    dispose()
  } finally {
    clearRegistryCache()
    delete process.env.DSH_HOME
    if (previous !== undefined) process.env.DSH_HOME = previous
    await rm(dshHome, { recursive: true, force: true })
  }
})
