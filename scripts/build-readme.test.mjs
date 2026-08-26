import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  adaptLegacyRegistry,
  buildReadmeFiles,
  catalogRevision,
  githubRenderLimit,
  groupPlugins,
  loadRegistry,
  normalizeRegistry,
  screenshotBranch,
  screenshotPaths,
} from './build-readme.mjs'

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build-readme.mjs')

// Entries whose descriptions can be made arbitrarily long: `padding` adds that many
// characters to each locale, costing one byte each in English and three in Chinese —
// the asymmetry the byte budget has to price separately.
function bucketPlugins(category, count, padding, prefix = 'scanned') {
  return Array.from({ length: count }, (_, index) => {
    const suffix = String(index).padStart(4, '0')
    return {
      id: `scanner/${prefix}-${suffix}`,
      name: `${prefix}-${suffix}`,
      owner: 'scanner',
      url: `https://github.com/scanner/${prefix}-${suffix}`,
      category,
      description: {
        en: `Discovered by the topic scan.${'x'.repeat(padding)}`,
        zh: `由 topic 扫描发现。${'描'.repeat(padding)}`,
      },
      added: '2026-08-15',
      stars: null,
    }
  })
}

function unclassifiedPlugins(count, padding) {
  return bucketPlugins('unclassified', count, padding)
}

function listedEntries(content, prefix = 'scanned') {
  return (content.match(new RegExp(`^- \\[${prefix}-\\d{4}\\]`, 'gm')) ?? []).length
}

const categories = [
  { id: 'tools', order: 50, label: { en: 'Tools & Capabilities', zh: '工具与能力' } },
  { id: 'ui', order: 10, label: { en: 'UI Enhancements', zh: 'UI 增强' } },
  { id: 'fun', order: 110, label: { en: 'Just for Fun', zh: '娱乐' } },
]

const registryFixture = {
  name: 'dsh-1024store-catalog',
  updated: '2026-08-15T04:05:06.000Z',
  count: 5,
  categories: categories.map(category => ({ ...category })),
  plugins: [
    {
      id: 'owner/zeta',
      name: 'Zeta-Tool',
      owner: 'owner',
      url: 'https://github.com/owner/zeta',
      category: 'tools',
      description: { en: 'Zeta tool.', zh: 'Zeta 工具。' },
      install: 'dsh plugin --profile web add github:owner/zeta',
      added: '2026-08-01',
      stars: 12,
    },
    {
      id: 'owner/alpha',
      name: 'alpha-tool',
      owner: 'owner',
      url: 'https://github.com/owner/alpha',
      category: 'tools',
      description: { en: 'Alpha tool.', zh: '' },
      install: 'dsh plugin --profile web add github:owner/alpha',
      added: '2026-08-02',
      stars: null,
    },
    {
      id: 'someone/scanned',
      name: 'scanned-plugin',
      owner: 'someone',
      url: 'https://github.com/someone/scanned',
      category: 'unclassified',
      description: { en: 'Discovered by the topic scan.', zh: 'Discovered by the topic scan.' },
      install: 'dsh plugin --profile web add github:someone/scanned',
      added: '2026-08-10',
      stars: 3,
    },
    {
      id: 'owner/ui-thing',
      name: 'ui-thing',
      owner: 'owner',
      url: 'https://github.com/owner/ui-thing',
      category: 'ui',
      description: { en: '', zh: '界面\n增强。' },
      install: 'dsh plugin --profile web add github:owner/ui-thing',
      added: '2026-08-03',
      stars: 0,
    },
    {
      id: 'owner/monorepo/packages/nested',
      name: 'nested-plugin',
      owner: 'owner',
      url: 'https://github.com/owner/monorepo',
      category: 'tools',
      description: { en: 'A monorepo subpackage plugin.', zh: 'monorepo 子包插件。' },
      install: 'dsh plugin --profile web add github:owner/monorepo#path:packages/nested',
      added: '2026-08-16',
      stars: 1,
    },
  ],
}

async function fixtureRoot() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'build-readme-'))
  await mkdir(path.join(directory, 'catalog'), { recursive: true })
  await writeFile(
    path.join(directory, 'catalog/categories.json'),
    `${JSON.stringify({ version: 1, categories })}\n`,
  )
  const registryFile = path.join(directory, 'registry.json')
  await writeFile(registryFile, `${JSON.stringify(registryFixture)}\n`)
  return { directory, registryFile }
}

test('groups by category order with unclassified last and stable name sorting', () => {
  const groups = groupPlugins(normalizeRegistry(registryFixture), categories)
  assert.deepEqual(groups.map(group => group.id), ['ui', 'tools', 'unclassified'])
  assert.deepEqual(groups[1].plugins.map(plugin => plugin.name), ['alpha-tool', 'nested-plugin', 'Zeta-Tool'])
  assert.deepEqual(groups.at(-1).label, { en: 'Unclassified', zh: '待分类' })
})

test('renders bilingual lists with language fallback and no volatile metrics', async () => {
  const files = await buildReadmeFiles(normalizeRegistry(registryFixture), categories)
  const zh = files['README.md']
  const en = files['catalog/README.md']

  assert.match(zh, /# DSH 1024Store/)
  assert.match(zh, /共收录 \*\*5\*\* 个插件/)
  assert.match(zh, /2026-08-15/)
  // The store installs from npm only; the generated README must not teach the
  // github: source form anywhere.
  assert.match(zh, /dsh1024 plugin --profile web add <npm-package>/)
  assert.doesNotMatch(zh, /add github:/)
  assert.doesNotMatch(zh, /npx @dsh-1024store\/cli add/)
  // A subdirectory plugin links to its own directory, not the repository root.
  // Once the crawler collects every package a monorepo publishes, one repository
  // contributes a whole run of entries, and pointing them all at the same root
  // would leave the reader with no way to reach any of them but the first.
  assert.match(zh, /- \[nested-plugin\]\(https:\/\/github\.com\/owner\/monorepo\/tree\/HEAD\/packages\/nested\) — monorepo 子包插件。/)
  assert.match(zh, /自动合并/)
  assert.match(zh, /自动同步/)
  // zh line falls back to English when the Chinese description is missing.
  assert.match(zh, /- \[alpha-tool\]\(https:\/\/github\.com\/owner\/alpha\) — Alpha tool\./)
  // multi-line descriptions collapse into a single line.
  assert.match(zh, /- \[ui-thing\]\(https:\/\/github\.com\/owner\/ui-thing\) — 界面 增强。/)
  assert.match(zh, /<summary><strong>待分类<\/strong> · 1 个插件<\/summary>/)
  assert.doesNotMatch(zh, /stars?:? \d/i)
  assert.match(zh, /<strong>DSH插件社区<\/strong>/)
  assert.match(zh, /<img src="apps\/web\/public\/wechat-group\.jpg" alt="DSH插件社区微信二维码" width="280">/)
  assert.ok(zh.indexOf('DSH插件社区') < zh.indexOf('## 项目亮点'), 'community QR must be visible before the project details')

  assert.match(en, /DSH 1024Store/)
  assert.match(en, /\*\*5\*\* plugins, updated 2026-08-15/)
  assert.match(en, /- \[Zeta-Tool\]\(https:\/\/github\.com\/owner\/zeta\) — Zeta tool\./)
  // en line falls back to Chinese when the English description is missing.
  assert.match(en, /- \[ui-thing\]\(https:\/\/github\.com\/owner\/ui-thing\) — 界面 增强。/)
  assert.match(en, /<summary><strong>Unclassified<\/strong> · 1 plugins<\/summary>/)
  assert.match(en, /merged submissions are synced/i)

  // Category index order and counts.
  const zhIndex = zh.slice(zh.indexOf('## 插件分类'))
  assert.match(zhIndex, /- \[UI 增强\]\(#ui\) \(1\)\n- \[工具与能力\]\(#tools\) \(3\)\n- \[待分类\]\(#unclassified\) \(1\)/)
})

test('collapses every category into a default-closed details block', async () => {
  const files = await buildReadmeFiles(normalizeRegistry(registryFixture), categories)

  for (const [name, content] of Object.entries(files)) {
    // Default-collapsed: an `open` attribute would defeat the whole point.
    assert.doesNotMatch(content, /<details[^>]/, `${name} must not open any group by default`)
    assert.equal((content.match(/<details>/g) ?? []).length, 3, `${name} must wrap all three groups`)
    assert.equal((content.match(/<\/details>/g) ?? []).length, 3, `${name} must close all three groups`)
    // GitHub only renders Markdown inside <details> when the summary is followed by a
    // blank line and the block is not indented.
    assert.doesNotMatch(content, /^[ \t]+<(details|summary|\/details)/m, `${name} must not indent the HTML`)
    assert.match(content, /<\/summary>\n\n- \[/, `${name} needs a blank line before the list`)
    assert.match(content, /\n\n<\/details>/, `${name} needs a blank line before the closing tag`)
    // The anchor stays outside so the category index can still jump to a closed group.
    assert.match(content, /<a id="ui"><\/a>\n\n<details>/, `${name} must keep anchors outside the block`)
  }

  // Category labels contain "&", which must be escaped inside the raw HTML summary.
  assert.match(files['catalog/README.md'], /<summary><strong>Tools &amp; Capabilities<\/strong> · 3 plugins<\/summary>/)
  for (const summary of files['catalog/README.md'].match(/<summary>.*<\/summary>/g) ?? []) {
    assert.doesNotMatch(summary, /&(?!amp;|lt;|gt;)/, `unescaped & in ${summary}`)
  }
  assert.match(files['README.md'], /<summary><strong>工具与能力<\/strong> · 3 个插件<\/summary>/)
})

test('leads with the marketplace, in-app plugin, scheduled validation, API and contribution calls', async () => {
  const files = await buildReadmeFiles(normalizeRegistry(registryFixture), categories)
  const zh = files['README.md']
  const en = files['catalog/README.md']

  // The four things this repository ships beyond the list itself.
  assert.match(zh, /deepseek1024\.com/)
  assert.match(zh, /CLOUDFLARE_API_TOKEN/)
  assert.match(zh, /dsh plugin --profile web add dsh1024@latest/)
  assert.match(zh, /定时收集/)
  assert.match(zh, /格式校验/)
  assert.match(zh, /绝不执行仓库代码/)
  assert.match(zh, /api\.deepseek1024\.com\/v1\/plugins\/search/)

  // Star / issue / PR / fork calls to action.
  assert.match(zh, /\/stargazers\)/)
  assert.match(zh, /\/issues\/new\)/)
  assert.match(zh, /\/pulls\)/)
  assert.match(zh, /\/fork\)/)

  assert.match(en, /CLOUDFLARE_API_TOKEN/)
  assert.match(en, /dsh plugin --profile web add dsh1024@latest/)
  assert.match(en, /never installing dependencies or executing repository code/)
  assert.match(en, /api\.deepseek1024\.com\/v1\/plugins\/search/)
  for (const suffix of ['/stargazers)', '/issues/new)', '/pulls)', '/fork)']) {
    assert.ok(en.includes(suffix), `English README is missing the ${suffix} call to action`)
  }
  // The review gate has three verdicts; the README must not promise that every
  // passing pull request merges itself. Kept in sync with CONTRIBUTING.md,
  // the PR template, SKILL.md and submission-reference.md.
  assert.match(zh, /维护者人工审核/)
  assert.match(en, /waits for maintainer approval/)

  // Links in catalog/README.md resolve one directory up.
  assert.match(en, /\]\(\.\.\/CONTRIBUTING\.md\)/)
  assert.match(en, /\]\(\.\.\/docs\/api\.md\)/)
})

test('lists every category that fits and caps only the bucket that overflows', async () => {
  // Entries are priced in bytes, so the bucket has to be heavy enough to threaten the
  // limit before anything is dropped; 620 padded entries do that without depending on
  // the production catalog.
  const big = { ...registryFixture, plugins: [...registryFixture.plugins, ...unclassifiedPlugins(620, 1200)] }
  const files = await buildReadmeFiles(normalizeRegistry(big), categories)
  const zh = files['README.md']
  const en = files['catalog/README.md']

  // Curated categories keep every entry, however tight the budget gets.
  assert.match(zh, /<summary><strong>工具与能力<\/strong> · 3 个插件<\/summary>/)
  assert.match(en, /<summary><strong>Tools &amp; Capabilities<\/strong> · 3 plugins<\/summary>/)
  assert.match(zh, /<summary><strong>UI 增强<\/strong> · 1 个插件<\/summary>/)
  assert.match(en, /<summary><strong>UI Enhancements<\/strong> · 1 plugin/)
  for (const [name, content] of Object.entries(files)) {
    assert.ok(content.includes('alpha-tool') && content.includes('Zeta-Tool') && content.includes('ui-thing'), `${name} dropped a curated entry`)
  }

  // The unclassified bucket is the only one that could not fit, and says so instead of
  // pretending to be whole.
  const zhListed = listedEntries(zh)
  const enListed = listedEntries(en)
  assert.ok(zhListed > 0 && zhListed < 620, `zh listed ${zhListed} of 620`)
  assert.ok(enListed > 0 && enListed < 620, `en listed ${enListed} of 620`)
  assert.ok(zh.includes(`<summary><strong>待分类</strong> · 显示 ${zhListed} / 共 621 个</summary>`), 'zh summary must report what it listed')
  assert.ok(en.includes(`<summary><strong>Unclassified</strong> · showing ${enListed} of 621</summary>`), 'en summary must report what it listed')
  assert.ok(zh.includes(`本分类还有 ${621 - zhListed} 个插件没能列在这里`), 'zh must say how many are missing')
  assert.ok(en.includes(`so ${621 - enListed} more plugins in this category did not fit here`), 'en must say how many are missing')
  // Only the overflowing bucket carries a notice.
  assert.equal((zh.match(/本分类还有 /g) ?? []).length, 1, 'no category that fits may claim to be truncated')
  assert.equal((en.match(/more plugins in this category did not fit here/g) ?? []).length, 1)
  // Both notices point readers at the full catalog.
  assert.match(zh, /完整目录请在\[在线网站\]\(https:\/\/deepseek1024\.com\/\)搜索浏览。\*/)
  assert.match(en, /search or browse the full catalog on the \[live website\]\(https:\/\/deepseek1024\.com\/\)\.\*/)

  // Each projection gets its own budget: a Chinese entry costs about three bytes per
  // character, so a shared entry count would either truncate English needlessly or
  // overshoot Chinese.
  assert.ok(enListed > zhListed, `English (${enListed}) must fit more entries than Chinese (${zhListed})`)

  // The category index still reports the true total, not the truncated one.
  assert.match(zh, /- \[待分类\]\(#unclassified\) \(621\)/)
  assert.match(en, /- \[Unclassified\]\(#unclassified\) \(621\)/)
})

test('caps by rendered bytes rather than by a fixed entry count', async () => {
  const withBucket = plugins => ({ ...registryFixture, plugins: [...registryFixture.plugins, ...plugins] })
  const short = await buildReadmeFiles(normalizeRegistry(withBucket(unclassifiedPlugins(620, 0))), categories)
  const long = await buildReadmeFiles(normalizeRegistry(withBucket(unclassifiedPlugins(620, 1200))), categories)

  // Short entries are cheap, so all 620 fit — the retired 500-entry cap would have
  // hidden 120 of them for no reason.
  assert.equal(listedEntries(short['README.md']), 620, 'a cheap bucket must not be truncated')
  assert.match(short['README.md'], /<summary><strong>待分类<\/strong> · 621 个插件<\/summary>/)

  // The same 620 entries with long bilingual descriptions run out of budget well before
  // entry 500: exactly the case a fixed count cannot see, and the one that shipped a
  // silently truncated README.
  const capped = listedEntries(long['README.md'])
  assert.ok(capped > 0 && capped < 500, `a heavy bucket must cap below the retired 500 limit, listed ${capped}`)
})

test('keeps both projections inside the GitHub render limit and spends the budget it has', async () => {
  // Descriptions far past anything the catalog holds today: the fitted list has to
  // absorb this without the guard ever firing.
  const registry = { ...registryFixture, plugins: [...registryFixture.plugins, ...unclassifiedPlugins(2000, 3000)] }
  const files = await buildReadmeFiles(normalizeRegistry(registry), categories)
  for (const [name, content] of Object.entries(files)) {
    const bytes = Buffer.byteLength(content, 'utf8')
    assert.ok(bytes <= githubRenderLimit, `${name} is ${bytes} bytes, over the ${githubRenderLimit} render limit`)
    // The budget must be a fit, not a panic: leaving a fifth of the limit unused would
    // mean hiding entries that had room.
    assert.ok(bytes > githubRenderLimit * 0.8, `${name} is only ${bytes} bytes and wastes its budget`)
    assert.ok(listedEntries(content) > 0, `${name} must still list some of the bucket`)
  }
})

test('generates byte-identical projections for the same input', async () => {
  const build = order => buildReadmeFiles(
    normalizeRegistry({ ...registryFixture, plugins: [...registryFixture.plugins, ...unclassifiedPlugins(620, 1200)] }),
    order,
  )
  const first = await build(categories)
  // Category input order must not leak into the output either: groups are sorted, and
  // the fit reads a sorted array rather than any map iteration order.
  const second = await build([...categories].reverse())

  assert.deepEqual(Object.keys(first), Object.keys(second), 'the same files must be emitted in the same order')
  for (const name of Object.keys(first)) {
    assert.ok(
      Buffer.from(first[name], 'utf8').equals(Buffer.from(second[name], 'utf8')),
      `${name} must be byte-identical across builds`,
    )
  }
})

test('refuses to emit a projection GitHub would silently truncate', async () => {
  // The byte budget only governs the entries; it cannot shrink the frame around them.
  // 2000 categories put the index and the per-category summaries alone past the limit,
  // and the guard must throw rather than ship a file whose tail is invisible on GitHub.
  const many = Array.from({ length: 2000 }, (_, index) => ({
    id: `bucket-${String(index).padStart(4, '0')}`,
    order: index,
    label: { en: `Bucket ${index}`, zh: `分类 ${index}` },
  }))
  const spread = {
    ...registryFixture,
    plugins: many.flatMap((category, index) => bucketPlugins(category.id, 2, 0, `spread${String(index).padStart(4, '0')}`)),
  }
  await assert.rejects(
    buildReadmeFiles(normalizeRegistry(spread), many),
    /GitHub renders at most \d+ and silently drops everything past that offset/,
  )
})

test('splits a tight budget fairly instead of starving the last categories', async () => {
  // Two oversized categories and one small one, all curated: the old rule (curated
  // always whole) cannot hold here, so the budget has to be shared. A first-come split
  // would list the first category in full and leave the second empty.
  const registry = {
    ...registryFixture,
    plugins: [
      ...bucketPlugins('tools', 700, 1200, 'tooled'),
      ...bucketPlugins('ui', 700, 1200, 'skinned'),
      ...bucketPlugins('fun', 4, 1200, 'played'),
    ],
  }
  const files = await buildReadmeFiles(normalizeRegistry(registry), categories)
  for (const [name, content] of Object.entries(files)) {
    const tools = listedEntries(content, 'tooled')
    const ui = listedEntries(content, 'skinned')
    // The small category needs far less than an equal share, so it stays whole.
    assert.equal(listedEntries(content, 'played'), 4, `${name} truncated a category that fits`)
    // Both oversized categories are cut, and neither is starved for the other.
    assert.ok(tools > 0 && tools < 700, `${name} listed ${tools} of 700 tools entries`)
    assert.ok(ui > 0 && ui < 700, `${name} listed ${ui} of 700 ui entries`)
    assert.ok(Math.abs(tools - ui) <= 1, `${name} split unevenly: ${tools} vs ${ui}`)
    assert.ok(Buffer.byteLength(content, 'utf8') <= githubRenderLimit, `${name} is over the render limit`)
  }
})

test('leads both projections with the homepage screenshot from the assets branch', async () => {
  const files = await buildReadmeFiles(normalizeRegistry(registryFixture), categories)
  const revision = catalogRevision(normalizeRegistry(registryFixture))
  const sourceFor = locale => `https://raw.githubusercontent.com/imsai-sh/awesome-deepseek-harness-plugins/${screenshotBranch}/${screenshotPaths[locale]}?v=${revision}`

  // Each projection shows the store in its own language.
  assert.ok(files['README.md'].includes(sourceFor('zh')), 'zh README must use the Chinese capture')
  assert.ok(files['catalog/README.md'].includes(sourceFor('en')), 'en README must use the English capture')
  assert.ok(!files['README.md'].includes(screenshotPaths.en), 'zh README must not use the English capture')
  assert.ok(!files['catalog/README.md'].includes(screenshotPaths.zh), 'en README must not use the Chinese capture')

  for (const [name, content] of Object.entries(files)) {
    const source = sourceFor(name === 'README.md' ? 'zh' : 'en')
    assert.ok(content.includes(source), `${name} must embed the versioned screenshot URL`)
    // The hero links to the live site and sits above the fold, before the nav links.
    assert.ok(content.indexOf(source) < content.indexOf('Submit a plugin') || name === 'README.md')
    assert.match(content, /\]\(https:\/\/deepseek1024\.com\/\)/)
  }
  assert.match(files['README.md'], /\[!\[DSH 1024Store 插件市场首页\]/)
  assert.match(files['catalog/README.md'], /\[!\[The DSH 1024Store plugin marketplace homepage\]/)
})

test('ties the screenshot URL to catalog contents, not to the clock', () => {
  const base = normalizeRegistry(registryFixture)
  // Same catalog → same URL, so an unchanged sync produces no README commit at all.
  assert.equal(catalogRevision(base), catalogRevision(normalizeRegistry(registryFixture)))

  // A new plugin changes the revision, so readers get a fresh screenshot past camo.
  const grown = normalizeRegistry({
    ...registryFixture,
    plugins: [...registryFixture.plugins, {
      ...registryFixture.plugins[0],
      id: 'owner/brand-new',
      url: 'https://github.com/owner/brand-new',
      name: 'brand-new',
    }],
  })
  assert.notEqual(catalogRevision(base), catalogRevision(grown))

  // Recategorising an existing plugin also moves it in the list, so it counts too.
  const recategorised = normalizeRegistry({
    ...registryFixture,
    plugins: registryFixture.plugins.map((plugin, index) => (index === 0 ? { ...plugin, category: 'ui' } : plugin)),
  })
  assert.notEqual(catalogRevision(base), catalogRevision(recategorised))

  assert.match(catalogRevision(base), /^[0-9a-f]{12}$/)
})

test('adapts the legacy /plugins.json shape', () => {
  const legacy = {
    updated: '2026-08-15',
    count: 1,
    revision: 'abc',
    categories: { tools: { en: 'Tools & Capabilities', zh: '工具与能力' } },
    plugins: [{
      name: 'display-name',
      owner: 'Owner',
      url: 'https://github.com/Owner/Repo-Name',
      category: 'tools',
      description: { en: 'A tool.', zh: '一个工具。' },
      install: 'dsh plugin --profile web add github:Owner/Repo-Name',
      added: '2026-08-01',
    }],
  }
  const adapted = adaptLegacyRegistry(legacy)
  assert.equal(adapted.updated, '2026-08-15')
  assert.deepEqual(adapted.plugins[0].id, 'Owner/Repo-Name')
  assert.equal(adapted.plugins[0].stars, null)
})

function jsonResponse(body) {
  return { ok: true, status: 200, async text() { return JSON.stringify(body) } }
}

function notFoundResponse() {
  return { ok: false, status: 404, async text() { return 'not found' } }
}

test('pages through /api/v2/plugins and stitches the sweep into one registry', async () => {
  const entries = bucketPlugins('tools', 3, 0, 'paged')
  const requested = []
  const registry = await loadRegistry({
    base: 'https://example.test/',
    retryDelayMs: 0,
    async fetchImplementation(url) {
      requested.push(url)
      const page = Number(new URL(url).searchParams.get('page'))
      const slice = entries.slice((page - 1) * 2, page * 2)
      return jsonResponse({
        plugins: slice,
        page,
        limit: 2,
        total: entries.length,
        totalPages: 2,
        generatedAt: '2026-08-15T12:00:00Z',
      })
    },
  })
  assert.deepEqual(requested, [
    'https://example.test/api/v2/plugins?sort=name&limit=200&page=1',
    'https://example.test/api/v2/plugins?sort=name&limit=200&page=2',
  ])
  assert.equal(registry.updated, '2026-08-15')
  assert.deepEqual(registry.plugins.map(plugin => plugin.id), entries.map(plugin => plugin.id))
})

test('rejects a sweep whose pages come from different catalog snapshots', async () => {
  const entries = bucketPlugins('tools', 3, 0, 'rotated')
  const requested = []
  await assert.rejects(loadRegistry({
    base: 'https://example.test',
    retryDelayMs: 0,
    async fetchImplementation(url) {
      requested.push(url)
      const page = Number(new URL(url).searchParams.get('page'))
      return jsonResponse({
        plugins: entries.slice((page - 1) * 2, page * 2),
        page,
        limit: 2,
        total: entries.length,
        totalPages: 2,
        // Every page reports a fresh snapshot: the sweep can never settle.
        generatedAt: `2026-08-15T12:00:0${requested.length}Z`,
      })
    },
  }), /snapshot rotated/)
  // Three attempts of two pages each — and each retry moved to the next sort
  // value so it keys past whatever edge-cached pages just failed the check.
  assert.deepEqual(requested.map(url => new URL(url).searchParams.get('sort')), [
    'name', 'name', 'active', 'active', 'newest', 'newest',
  ])
})

test('a transient page failure retries under the next sort instead of aborting the rebuild', async () => {
  const entries = bucketPlugins('tools', 3, 0, 'transient')
  const requested = []
  const registry = await loadRegistry({
    base: 'https://example.test',
    retryDelayMs: 0,
    async fetchImplementation(url) {
      requested.push(url)
      const params = new URL(url).searchParams
      if (params.get('sort') === 'name' && params.get('page') === '2') {
        return { ok: false, status: 502, async text() { return 'bad gateway' } }
      }
      const page = Number(params.get('page'))
      return jsonResponse({
        plugins: entries.slice((page - 1) * 2, page * 2),
        page,
        limit: 2,
        total: entries.length,
        totalPages: 2,
        generatedAt: '2026-08-15T12:00:00Z',
      })
    },
  })
  assert.deepEqual(registry.plugins.map(plugin => plugin.id), entries.map(plugin => plugin.id))
  assert.deepEqual(requested.map(url => new URL(url).searchParams.get('sort')), [
    'name', 'name', 'active', 'active',
  ])
})

test('falls back to the legacy endpoint when neither v2 nor the v1 registry is deployed', async () => {
  const requested = []
  const registry = await loadRegistry({
    base: 'https://example.test/',
    retryDelayMs: 0,
    async fetchImplementation(url) {
      requested.push(url)
      if (url.includes('/api/v2/plugins') || url.endsWith('/api/v1/registry')) {
        return notFoundResponse()
      }
      return jsonResponse({
        updated: '2026-08-15',
        count: 0,
        categories: {},
        plugins: [],
      })
    },
  })
  assert.deepEqual(requested, [
    'https://example.test/api/v2/plugins?sort=name&limit=200&page=1',
    'https://example.test/api/v1/registry',
    'https://example.test/plugins.json',
  ])
  assert.deepEqual(registry, { updated: '2026-08-15', plugins: [] })
})

test('a capped registry file is refused by --from-file instead of shrinking the README', async t => {
  const { directory } = await fixtureRoot()
  t.after(() => rm(directory, { recursive: true, force: true }))

  const cappedFile = path.join(directory, 'capped-registry.json')
  await writeFile(cappedFile, `${JSON.stringify({ ...registryFixture, total: 9000 })}\n`)
  const result = spawnSync(process.execPath, [script, '--root', directory, '--from-file', cappedFile], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /capped/)
})

test('refuses a capped v1 registry fallback instead of shrinking the README to the cap', async () => {
  await assert.rejects(loadRegistry({
    base: 'https://example.test',
    retryDelayMs: 0,
    async fetchImplementation(url) {
      if (url.includes('/api/v2/plugins')) return notFoundResponse()
      return jsonResponse({
        name: 'dsh-1024store-catalog',
        updated: '2026-08-15',
        count: 2,
        total: 9000,
        categories: [],
        plugins: bucketPlugins('tools', 2, 0, 'capped'),
      })
    },
  }), /capped/)
})

test('accepts an uncapped v1 registry fallback from a pre-total deployment', async () => {
  const entries = bucketPlugins('tools', 2, 0, 'legacyv1')
  const registry = await loadRegistry({
    base: 'https://example.test',
    retryDelayMs: 0,
    async fetchImplementation(url) {
      if (url.includes('/api/v2/plugins')) return notFoundResponse()
      return jsonResponse({
        name: 'dsh-1024store-catalog',
        updated: '2026-08-15',
        count: entries.length,
        categories: [],
        plugins: entries,
      })
    },
  })
  assert.deepEqual(registry.plugins.map(plugin => plugin.id), entries.map(plugin => plugin.id))
})

test('surfaces persistent catalog failures instead of silently falling back', async () => {
  let calls = 0
  await assert.rejects(loadRegistry({
    base: 'https://example.test',
    retryDelayMs: 0,
    async fetchImplementation() {
      calls += 1
      return { ok: false, status: 500, async text() { return 'boom' } }
    },
  }), /api\/v2\/plugins failed: HTTP 500/)
  // A 5xx is retried across every sort before it fails the build.
  assert.equal(calls, 3)
})

test('writes deterministic files from --from-file and verifies them with --check', async t => {
  const { directory, registryFile } = await fixtureRoot()
  t.after(() => rm(directory, { recursive: true, force: true }))

  const first = spawnSync(process.execPath, [script, '--root', directory, '--from-file', registryFile], { encoding: 'utf8' })
  assert.equal(first.status, 0, first.stderr)
  const readme = await readFile(path.join(directory, 'README.md'), 'utf8')
  const catalogReadme = await readFile(path.join(directory, 'catalog/README.md'), 'utf8')

  const second = spawnSync(process.execPath, [script, '--root', directory, '--from-file', registryFile], { encoding: 'utf8' })
  assert.equal(second.status, 0, second.stderr)
  assert.equal(await readFile(path.join(directory, 'README.md'), 'utf8'), readme)
  assert.equal(await readFile(path.join(directory, 'catalog/README.md'), 'utf8'), catalogReadme)

  const check = spawnSync(process.execPath, [script, '--root', directory, '--from-file', registryFile, '--check'], { encoding: 'utf8' })
  assert.equal(check.status, 0, check.stderr)
  assert.match(check.stdout, /up to date/)

  await writeFile(path.join(directory, 'README.md'), `${readme}\nmanual edit\n`)
  const stale = spawnSync(process.execPath, [script, '--root', directory, '--from-file', registryFile, '--check'], { encoding: 'utf8' })
  assert.equal(stale.status, 1)
  assert.match(stale.stderr, /Stale generated files: README\.md/)
})

test('refuses to regenerate the projections from a degenerate empty registry', async t => {
  const { directory } = await fixtureRoot()
  t.after(() => rm(directory, { recursive: true, force: true }))

  const emptyFile = path.join(directory, 'empty-registry.json')
  await writeFile(emptyFile, `${JSON.stringify({ ...registryFixture, count: 0, plugins: [] })}\n`)
  const result = spawnSync(process.execPath, [script, '--root', directory, '--from-file', emptyFile], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /0 plugins/)
  const readme = await readFile(path.join(directory, 'README.md'), 'utf8').catch(() => null)
  assert.equal(readme, null)
})
