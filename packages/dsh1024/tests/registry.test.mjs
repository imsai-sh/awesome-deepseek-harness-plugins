import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearRegistryCache,
  installExtraArgs,
  installTarget,
  loadRegistry,
  parseGitHubSource,
  validateRegistry,
} from '../lib/registry.js'

const registry = {
  name: 'dsh-1024store-catalog',
  updated: '2026-08-15T00:00:00Z',
  count: 1,
  categories: [{ id: 'tools', order: 1, label: { en: 'Tools', zh: '工具' } }],
  plugins: [{
    id: 'owner/repo',
    name: 'plugin',
    owner: 'owner',
    url: 'https://github.com/owner/repo',
    category: 'tools',
    description: { en: 'Plugin', zh: '插件' },
    install: 'dsh plugin --profile web add github:owner/repo',
    target: 'github:owner/repo',
    allowBuild: null,
    added: '2026-08-15',
    stars: 42,
  }],
}

test('compact v1 registry response is accepted as the installation allowlist', () => {
  const validated = validateRegistry(registry)
  assert.equal(validated.count, 1)
  assert.deepEqual(validated.categories[0], { id: 'tools', order: 1, label: { en: 'Tools', zh: '工具' } })
  assert.equal(validated.plugins[0]?.stars, 42)
  assert.equal(validated.plugins[0]?.id, 'owner/repo')
})

test('registry loading reuses fresh API data without reporting an outage', async () => {
  clearRegistryCache()
  let calls = 0
  const fetcher = async () => {
    calls += 1
    return new Response(JSON.stringify(registry), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const first = await loadRegistry('https://store.example/api/v1/registry', fetcher)
  const second = await loadRegistry('https://store.example/api/v1/registry', fetcher)
  assert.equal(first.source, 'api')
  assert.equal(second.source, 'api')
  assert.equal(calls, 1)
})

test('the plugin persists a validated registry under DSH_HOME and restores it without a request', async () => {
  clearRegistryCache()
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh1024-registry-cache-'))
  const registryUrl = 'https://store.example/api/v1/registry'
  let calls = 0
  const fetcher = async () => {
    calls += 1
    return new Response(JSON.stringify(registry), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const first = await loadRegistry(registryUrl, fetcher, { dshHome })
    assert.equal(first.source, 'api')
    assert.equal(calls, 1)

    const cachePath = join(dshHome, '.dsh-1024store', 'registry-cache.json')
    const persisted = JSON.parse(await readFile(cachePath, 'utf8'))
    assert.equal(persisted.version, 1)
    assert.equal(persisted.url, registryUrl)
    assert.deepEqual(persisted.registry, registry)

    clearRegistryCache()
    const restored = await loadRegistry(registryUrl, async () => {
      calls += 1
      throw new Error('the network must not run for a fresh plugin cache')
    }, { dshHome })
    assert.equal(restored.source, 'cache')
    assert.deepEqual(restored.registry, registry)
    assert.equal(calls, 1)
  } finally {
    clearRegistryCache()
    await rm(dshHome, { recursive: true, force: true })
  }
})

test('registry loading reports cache only when an expired API refresh fails', async () => {
  clearRegistryCache()
  const originalNow = Date.now
  let now = 0
  Date.now = () => now
  try {
    const successfulFetcher = async () => new Response(JSON.stringify(registry), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    const first = await loadRegistry('https://store.example/api/v1/registry', successfulFetcher)
    assert.equal(first.source, 'api')

    now = 6 * 60 * 1000
    const failedFetcher = async () => new Response('unavailable', { status: 503 })
    const fallback = await loadRegistry('https://store.example/api/v1/registry', failedFetcher)
    assert.equal(fallback.source, 'cache')
    assert.deepEqual(fallback.registry, first.registry)
  } finally {
    Date.now = originalNow
    clearRegistryCache()
  }
})

test('registry API failure does not fall back to a fixed bundled plugin list', async () => {
  clearRegistryCache()
  const fetcher = async () => new Response('unavailable', { status: 503 })
  await assert.rejects(
    loadRegistry('https://store.example/api/v1/registry', fetcher),
    /registry API unavailable: registry API HTTP 503/,
  )
})

test('install targets are derived from validated GitHub URLs', () => {
  assert.equal(parseGitHubSource('https://github.com/owner/repo'), 'owner/repo')
  assert.equal(parseGitHubSource('https://github.com/owner/repo/'), 'owner/repo')
  assert.equal(parseGitHubSource('https://example.com/owner/repo'), null)
  assert.equal(parseGitHubSource('https://github.com/owner/repo/tree/main/pkg'), null)
  assert.equal(installTarget(registry.plugins[0]), 'github:owner/repo')
})

test('a structured npm target is preferred without requiring a repository backlink', () => {
  const plugin = {
    ...registry.plugins[0],
    install: 'dsh plugin --profile web add @scope/published-plugin',
    target: '@scope/published-plugin',
  }
  assert.equal(installTarget(plugin), '@scope/published-plugin')
  assert.deepEqual(installExtraArgs(plugin), [])
})

test('structured targets survive repository renames without becoming arbitrary commands', () => {
  const renamedNpm = {
    ...registry.plugins[0],
    url: 'https://github.com/new-owner/new-repository',
    target: '@scope/published-plugin',
  }
  assert.equal(installTarget(renamedNpm), '@scope/published-plugin')

  const renamedSource = {
    ...registry.plugins[0],
    url: 'https://github.com/new-owner/new-repository',
    target: 'github:owner/repo',
  }
  assert.equal(installTarget(renamedSource), 'github:owner/repo')
  assert.throws(
    () => installTarget({ ...renamedSource, target: 'github:attacker/other' }),
    /does not match plugin id/,
  )

  const { target: _target, ...legacy } = renamedSource
  assert.throws(() => installTarget(legacy), /does not match its repository URL/)
})

test('a source build grant is passed as a separate safe CLI argument', () => {
  const plugin = { ...registry.plugins[0], allowBuild: '@scope/source-plugin' }
  assert.equal(installTarget(plugin), 'github:owner/repo')
  assert.deepEqual(installExtraArgs(plugin), ['--allow-build=@scope/source-plugin'])
})

test('a monorepo subpackage installs its own directory, not the repository root', () => {
  // Simulate an older compact response with no structured target: the client
  // must still derive the path-aware GitHub fallback from id + URL.
  const { target: _target, ...base } = registry.plugins[0]
  assert.equal(
    installTarget({ ...base, id: 'owner/repo/packages/foo' }),
    'github:owner/repo#path:packages/foo',
  )
  // Siblings stay distinct rather than both resolving to the repository.
  assert.equal(
    installTarget({ ...base, id: 'owner/repo/packages/bar' }),
    'github:owner/repo#path:packages/bar',
  )
  // The id must still agree with the validated URL, and traversal is rejected.
  assert.throws(() => installTarget({ ...base, id: 'attacker/other/packages/foo' }), /does not match/)
  assert.throws(() => installTarget({ ...base, id: 'owner/repo/../secret' }), /unsupported plugin subdirectory/)
})

test('invalid API data cannot extend the installation allowlist', () => {
  // Malformed entries are skipped rather than poisoning the whole registry:
  // they must never become installable, but they also must not take the store
  // down with a wholesale rejection (issue #159).
  const invalid = { ...registry.plugins[0], target: 'github:attacker/other' }
  const validated = validateRegistry({
    ...registry,
    count: 2,
    plugins: [registry.plugins[0], invalid],
  })
  assert.deepEqual(validated.plugins, [registry.plugins[0]])
  assert.equal(validated.count, 1)
  // An unsafe build allowance is likewise filtered, never installable.
  const unsafeAllowance = validateRegistry({
    ...registry,
    plugins: [{ ...registry.plugins[0], allowBuild: 'plugin;unsafe' }],
  })
  assert.equal(unsafeAllowance.count, 0)
  assert.deepEqual(unsafeAllowance.plugins, [])
  // Structural corruption is still fatal.
  assert.throws(() => validateRegistry({ ...registry, count: 2 }), /count does not match/)
  assert.throws(
    () => validateRegistry({ ...registry, categories: { tools: { en: 'Tools' } } }),
    /categories are invalid/,
  )
  assert.throws(() => validateRegistry({ ...registry, plugins: [] }), /plugins are empty/)
})

test('a single invalid entry is filtered and the count is normalized to match', () => {
  const valid = registry.plugins[0]
  const invalid = { ...registry.plugins[0], id: 'owner/bad', target: 'github:attacker/other' }
  const validated = validateRegistry({ ...registry, count: 2, plugins: [valid, invalid] })
  assert.equal(validated.count, 1)
  assert.deepEqual(validated.plugins, [valid])
  // An all-invalid response degrades to an empty allowlist instead of 503.
  const empty = validateRegistry({ ...registry, count: 1, plugins: [invalid] })
  assert.equal(empty.count, 0)
  assert.deepEqual(empty.plugins, [])
})

test('the persisted cache round-trips after invalid entries are filtered', async () => {
  clearRegistryCache()
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh1024-registry-filter-'))
  const registryUrl = 'https://store.example/api/v1/registry'
  const valid = registry.plugins[0]
  const invalid = { ...registry.plugins[0], id: 'owner/bad', target: 'github:attacker/other' }
  const payload = { ...registry, count: 2, plugins: [valid, invalid] }
  const fetcher = async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  try {
    const first = await loadRegistry(registryUrl, fetcher, { dshHome })
    assert.equal(first.source, 'api')
    assert.equal(first.registry.count, 1)
    assert.deepEqual(first.registry.plugins, [valid])

    // The persisted snapshot must re-hydrate cleanly: its count now matches the
    // filtered plugins, so the next load never needs the network.
    const cachePath = join(dshHome, '.dsh-1024store', 'registry-cache.json')
    const persisted = JSON.parse(await readFile(cachePath, 'utf8'))
    assert.equal(persisted.registry.count, persisted.registry.plugins.length)

    clearRegistryCache()
    const restored = await loadRegistry(registryUrl, async () => { throw new Error('offline') }, { dshHome })
    assert.equal(restored.source, 'cache')
    assert.equal(restored.registry.count, 1)
    assert.deepEqual(restored.registry.plugins, [valid])
  } finally {
    clearRegistryCache()
    await rm(dshHome, { recursive: true, force: true })
  }
})

test('a stale poisoned cache self-heals without the network', async () => {
  clearRegistryCache()
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh1024-registry-poison-'))
  const registryUrl = 'https://store.example/api/v1/registry'
  // Reproduce a cache written before the count normalization fix: the server's
  // raw `count` while `plugins` was already filtered down.
  const cacheDir = join(dshHome, '.dsh-1024store')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, 'registry-cache.json'), JSON.stringify({
    version: 1,
    url: registryUrl,
    fetchedAt: Date.now(),
    registry: { ...registry, count: registry.plugins.length + 1 },
  }))
  try {
    const restored = await loadRegistry(registryUrl, async () => { throw new Error('offline') }, { dshHome })
    assert.equal(restored.source, 'cache')
    assert.deepEqual(restored.registry, registry)
  } finally {
    clearRegistryCache()
    await rm(dshHome, { recursive: true, force: true })
  }
})

test('revalidation goes to the network even when the cache is still fresh', async () => {
  clearRegistryCache()
  const requested = []
  const fetcher = async (url) => {
    requested.push(String(url))
    return new Response(JSON.stringify(registry), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    await loadRegistry('https://store.example/api/v1/registry', fetcher)
    // Cache-first path: no second request.
    await loadRegistry('https://store.example/api/v1/registry', fetcher)
    assert.equal(requested.length, 1)

    const revalidated = await loadRegistry('https://store.example/api/v1/registry', fetcher, { revalidate: true })
    assert.equal(revalidated.source, 'api')
    assert.equal(requested.length, 2)
    // The refresh must not be answerable by a stale edge copy.
    assert.match(requested[1], /[?&]t=\d+/)
    assert.doesNotMatch(requested[0], /[?&]t=/)
  } finally {
    clearRegistryCache()
  }
})

test('concurrent revalidations collapse onto one request', async () => {
  clearRegistryCache()
  let calls = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const fetcher = async () => {
    calls += 1
    await gate
    return new Response(JSON.stringify(registry), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const all = Promise.all([
      loadRegistry('https://store.example/api/v1/registry', fetcher, { revalidate: true }),
      loadRegistry('https://store.example/api/v1/registry', fetcher, { revalidate: true }),
      loadRegistry('https://store.example/api/v1/registry', fetcher, { revalidate: true }),
    ])
    release()
    const results = await all
    assert.equal(calls, 1)
    for (const result of results) assert.equal(result.source, 'api')
  } finally {
    clearRegistryCache()
  }
})

test('a failed revalidation silently keeps the catalog already on screen', async () => {
  clearRegistryCache()
  const successfulFetcher = async () => new Response(JSON.stringify(registry), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  try {
    const first = await loadRegistry('https://store.example/api/v1/registry', successfulFetcher)
    const failedFetcher = async () => { throw new Error('offline') }
    const fallback = await loadRegistry('https://store.example/api/v1/registry', failedFetcher, { revalidate: true })
    assert.equal(fallback.source, 'cache')
    assert.deepEqual(fallback.registry, first.registry)
  } finally {
    clearRegistryCache()
  }
})
