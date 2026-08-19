import { comparePlugins, findPluginById, findPluginsUnder, hasGrowthForSort, repositoryName } from './lib/catalog'
import { pluginDetailPath, pluginSourceUrl } from './lib/plugin-id'
import {
  renderCollectionShell,
  renderNotFoundShell,
  renderPluginShell,
  renderSimpleShell,
  type ShellCatalog,
} from './seo-content'
import {
  absoluteUrl,
  apiDocsNodes,
  collectionCopy,
  collectionPageNode,
  graph,
  itemListNode,
  pluginDescription,
  pluginNodes,
  pluginPath,
  pluginTitle,
  simplePageNode,
  siteNodes,
  SITE_IMAGE,
  SITE_NAME,
  SITE_ORIGIN,
} from './seo-templates'
import type { CatalogPlugin, Language, RegistryCategory, StoredCatalogSnapshot } from './types'

export { SITE_ORIGIN } from './seo-templates'

const ITEM_LIST_LIMIT = 30

/** The slice of the runtime catalog snapshot the SEO surfaces render from. */
export interface SeoCatalog {
  updated: string
  revision: string
  plugins: CatalogPlugin[]
  categories: Record<string, RegistryCategory>
  /**
   * Set when the catalog could not be loaded at all. Every plugin URL would
   * otherwise turn into a hard 404 + noindex for as long as the edge caches it,
   * so the metadata layer fails open instead.
   */
  degraded?: boolean
}

export function seoCatalog(snapshot: StoredCatalogSnapshot, degraded = false): SeoCatalog {
  return {
    updated: snapshot.registryUpdated,
    revision: snapshot.registryRevision,
    plugins: snapshot.plugins,
    categories: snapshot.categories,
    degraded,
  }
}

export interface PageMetadata {
  title: string
  description: string
  /** null drops the canonical link entirely — correct for noindexed and 404 pages. */
  canonical: string | null
  robots: 'index,follow' | 'noindex,follow'
  schema: object
  status: 200 | 404 | 503
  /** Crawlable HTML injected into the empty SPA container. */
  shell?: string
  imageAlt?: string
}

function categoryLabelFor(catalog: SeoCatalog, id: string, language: Language): string {
  const label = catalog.categories[id]
  if (label) return label[language]
  return language === 'zh' ? '待分类' : 'Unclassified'
}

function shellCatalog(catalog: SeoCatalog): ShellCatalog {
  return { updated: catalog.updated, plugins: catalog.plugins, categories: catalog.categories }
}

/**
 * The snapshot arrives ordered by normalized repository name, so any "top
 * plugins" list has to be re-sorted — and it must be sorted the way the page
 * the reader lands on actually sorts, or the ItemList claims an order the
 * rendered page does not show. `/` defaults to 24h star growth, `/plugins` to
 * stars. Sorting runs on every HTML request, so results are memoised against
 * the snapshot revision.
 */
const rankedCache = new Map<string, CatalogPlugin[]>()

function rankedPlugins(catalog: SeoCatalog, sort: 'stars' | 'growth24h'): CatalogPlugin[] {
  const key = `${catalog.revision}:${sort}`
  const cached = rankedCache.get(key)
  if (cached) return cached
  const ranked = catalog.plugins
    .filter((plugin) => hasGrowthForSort(plugin, sort))
    .sort(comparePlugins(sort))
  // One snapshot at a time: an older revision's entries are dead weight.
  rankedCache.clear()
  rankedCache.set(key, ranked)
  return ranked
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/** URL segments reach the document head, so strip control characters and clamp. */
function sanitizeSegment(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F<>]/g, '').trim().slice(0, 80)
}

function collectionMetadata(
  view: 'rankings' | 'catalog',
  path: string,
  catalog: SeoCatalog,
  language: Language,
): PageMetadata {
  const copy = collectionCopy(view, language, catalog.plugins.length)
  const sort = view === 'rankings' ? 'growth24h' : 'stars'
  const ranked = rankedPlugins(catalog, sort)
  const list = itemListNode(ranked.slice(0, ITEM_LIST_LIMIT), path, copy.listHeading, ranked.length)
  return {
    title: copy.title,
    description: copy.description,
    canonical: absoluteUrl(path),
    robots: 'index,follow',
    schema: graph([
      ...siteNodes(),
      collectionPageNode(path, copy, language, `${absoluteUrl(path)}#items`),
      list,
    ]),
    status: 200,
    shell: renderCollectionShell(shellCatalog(catalog), language, copy, {
      listed: ranked.slice(0, view === 'rankings' ? 60 : 120),
      showCategories: view === 'catalog',
    }),
    imageAlt: `${SITE_NAME} — ${copy.heading}`,
  }
}

/**
 * Where a `/plugins/...` address should redirect when it names no plugin but
 * names something plugins live under.
 *
 * A repository whose bundle sits in a subdirectory is catalogued at the
 * subpackage's id, so its previously published repository-level URL would
 * otherwise 404 and be deindexed. One successor redirects to it; several
 * (a monorepo publishing many plugins) cannot pick a winner, so the catalog
 * lists them instead.
 *
 * @returns the target path, or null when the address needs no redirect.
 */
export function detailRedirectForPath(pathname: string, catalog: SeoCatalog): string | null {
  const match = pathname.match(/^\/plugins\/([^/]+(?:\/[^/]+)+)\/?$/)
  if (!match) return null
  const segments = (match[1] ?? '').split('/').map(safeDecode)
  if (!segments.every((segment) => segment !== null && segment.length > 0)) return null
  const requestedId = segments.join('/')
  if (findPluginById(catalog.plugins, requestedId)) return null

  const successors = findPluginsUnder(catalog.plugins, requestedId)
  if (successors.length === 1) return pluginDetailPath(successors[0]!.id)
  if (successors.length > 1) return `/plugins?q=${encodeURIComponent(requestedId)}`
  return null
}

export function metadataForPath(
  pathname: string,
  catalog: SeoCatalog,
  language: Language = 'en',
): PageMetadata {
  if (pathname === '/' || pathname === '/rankings') {
    return collectionMetadata('rankings', '/', catalog, language)
  }

  if (pathname === '/plugins') {
    return collectionMetadata('catalog', '/plugins', catalog, language)
  }

  if (pathname === '/docs/api') {
    const copy = collectionCopy('apiDocs', language, catalog.plugins.length)
    const url = absoluteUrl('/docs/api')
    return {
      title: copy.title,
      description: copy.description,
      canonical: url,
      robots: 'index,follow',
      schema: graph([...siteNodes(), ...apiDocsNodes(copy, language)]),
      status: 200,
      shell: renderSimpleShell(copy.heading, copy.intro),
      imageAlt: `${SITE_NAME} — ${copy.heading}`,
    }
  }

  // The community's static pages. A single post's title is not static copy —
  // it is a row in D1 — so worker/index.ts layers that over this. See
  // worker/community/metadata.ts.
  if (pathname === '/community' || pathname.startsWith('/community/p/')) {
    const copy = collectionCopy('community', language, 0)
    return {
      title: copy.title,
      description: copy.description,
      canonical: absoluteUrl(pathname === '/community' ? '/community' : pathname),
      robots: 'index,follow',
      schema: graph([...siteNodes(), simplePageNode(pathname, copy, language)]),
      status: 200,
      shell: renderSimpleShell(copy.heading, copy.intro),
      imageAlt: `${SITE_NAME} — ${copy.heading}`,
    }
  }

  if (pathname === '/community/about') {
    const copy = collectionCopy('communityRules', language, 0)
    return {
      title: copy.title,
      description: copy.description,
      canonical: absoluteUrl('/community/about'),
      robots: 'index,follow',
      schema: graph([...siteNodes(), simplePageNode('/community/about', copy, language)]),
      status: 200,
      shell: renderSimpleShell(copy.heading, copy.intro),
    }
  }

  if (pathname.startsWith('/community/u/')) {
    const copy = collectionCopy('community', language, 0)
    return {
      title: copy.title,
      description: copy.description,
      canonical: null,
      // A profile is a view over posts that are indexed on their own pages.
      robots: 'noindex,follow',
      schema: graph(siteNodes()),
      status: 200,
      shell: renderSimpleShell(copy.heading, copy.intro),
    }
  }

  if (pathname === '/account') {
    const copy = collectionCopy('account', language, 0)
    const url = absoluteUrl('/account')
    return {
      title: copy.title,
      description: copy.description,
      canonical: url,
      robots: 'noindex,follow',
      schema: graph([...siteNodes(), simplePageNode('/account', copy, language)]),
      status: 200,
      shell: renderSimpleShell(copy.heading, copy.intro),
    }
  }

  // Any depth: a monorepo plugin's detail path carries its in-repo directory.
  // Without this the page would be served as a 404 + noindex shell.
  const match = pathname.match(/^\/plugins\/([^/]+(?:\/[^/]+)+)\/?$/)
  if (match) {
    // match[1] is the whole tail, so a monorepo subpackage keeps its path.
    const segments = (match[1] ?? '').split('/').map(safeDecode)
    const requestedId = segments.every((segment) => segment !== null && segment.length > 0)
      ? segments.join('/')
      : ''
    const plugin = requestedId ? findPluginById(catalog.plugins, requestedId) : undefined
    if (plugin) return pluginMetadata(plugin, catalog, language)
    if (catalog.degraded && requestedId) {
      // A cold or failed catalog must not deindex the whole corpus: serve a
      // 200 built from the URL itself and let the client fill in the detail.
      return degradedPluginMetadata(segments.map((segment) => sanitizeSegment(segment!)).join('/'), language)
    }
  }

  const notFoundTitle = language === 'zh' ? `页面未找到 | ${SITE_NAME}` : `Page not found | ${SITE_NAME}`
  const notFoundBody = language === 'zh'
    ? '请求的页面不在 DeepSeek Harness 社区插件目录中。'
    : 'The requested page is not available in the DeepSeek Harness community plugin catalog.'
  return {
    title: notFoundTitle,
    description: notFoundBody,
    canonical: null,
    robots: 'noindex,follow',
    schema: graph([
      ...siteNodes(),
      {
        '@type': 'WebPage',
        '@id': `${absoluteUrl(pathname)}#webpage`,
        url: absoluteUrl(pathname),
        name: notFoundTitle,
        isPartOf: { '@id': `${SITE_ORIGIN}/#website` },
      },
    ]),
    status: 404,
    shell: renderNotFoundShell(
      language === 'zh' ? '页面未找到' : 'Page not found',
      notFoundBody,
      language === 'zh' ? '浏览 DeepSeek Harness 插件目录' : 'Browse the DeepSeek Harness plugin catalog',
    ),
  }
}

function pluginMetadata(
  plugin: CatalogPlugin,
  catalog: SeoCatalog,
  language: Language,
): PageMetadata {
  const canonical = absoluteUrl(pluginPath(plugin))
  const categoryLabel = categoryLabelFor(catalog, plugin.category, language)
  const title = pluginTitle(plugin.name, plugin.owner, language)
  const description = pluginDescription(
    plugin.name,
    plugin.owner,
    plugin.description[language],
    categoryLabel,
    language,
  )
  return {
    title,
    description,
    canonical,
    robots: 'index,follow',
    schema: graph([
      ...siteNodes(),
      ...pluginNodes(
        {
          name: plugin.name,
          owner: plugin.owner,
          url: plugin.url,
          description: plugin.description[language],
          categoryLabel,
          added: plugin.added,
          stars: plugin.stars,
          pushedAt: plugin.pushedAt,
          updatedAt: plugin.updatedAt,
          repository: repositoryName(plugin),
          sourceUrl: pluginSourceUrl(plugin.id, plugin.url),
        },
        canonical,
        title,
        description,
        language,
        language === 'zh' ? '插件目录' : 'Plugin catalog',
      ),
    ]),
    status: 200,
    shell: renderPluginShell(plugin, shellCatalog(catalog), language, categoryLabel),
    imageAlt: language === 'zh'
      ? `${plugin.name} — DeepSeek Harness 插件`
      : `${plugin.name} — DeepSeek Harness plugin`,
  }
}

/**
 * @param id - the full plugin id from the URL, `owner/repository[/sub/dir]`.
 *   Encoding it segment-wise keeps a monorepo subpackage's canonical pointing
 *   at its real page; percent-encoding the separators would invent a URL.
 */
function degradedPluginMetadata(id: string, language: Language): PageMetadata {
  const segments = id.split('/')
  const owner = segments[0] ?? id
  // The last segment names the plugin: the repository for a plain id, the
  // subpackage directory for a monorepo one.
  const displayName = segments.at(-1) ?? id
  const canonical = absoluteUrl(pluginDetailPath(id))
  const title = pluginTitle(displayName, owner, language)
  const description = pluginDescription(displayName, owner, '', '', language)
  return {
    title,
    description,
    canonical,
    robots: 'index,follow',
    schema: graph([
      ...siteNodes(),
      {
        '@type': 'WebPage',
        '@id': `${canonical}#webpage`,
        url: canonical,
        name: title,
        isPartOf: { '@id': `${SITE_ORIGIN}/#website` },
      },
    ]),
    status: 200,
  }
}

const INDEXABLE_COLLECTION_PATHS = new Set(['/', '/plugins', '/rankings'])
const COLLECTION_PARAMS = ['q', 'category', 'sort'] as const

/**
 * A filtered or searched collection view is a permutation of one page, so it is
 * noindexed and drops its canonical — the filtered result really is different
 * content, and pointing it at the unfiltered page would contradict the noindex.
 *
 * A campaign tag is the opposite case: `/?utm_source=x` is byte-identical to
 * `/`, so it stays indexable and simply canonicalises to the clean URL. Treating
 * those as filters would noindex every shared link and consolidate nothing.
 */
export function collectionQueryKind(url: URL): 'clean' | 'filtered' | 'tagged' {
  if (!INDEXABLE_COLLECTION_PATHS.has(url.pathname)) return 'clean'
  for (const key of COLLECTION_PARAMS) {
    if ((url.searchParams.get(key) ?? '').trim().length > 0) return 'filtered'
  }
  return [...url.searchParams.keys()].length > 0 ? 'tagged' : 'clean'
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function buildSitemap(catalog: SeoCatalog): string {
  const pages: { path: string; lastModified?: string }[] = [
    { path: '/', lastModified: catalog.updated },
    { path: '/plugins', lastModified: catalog.updated },
    // No lastmod: the API reference changes on its own schedule, and stamping
    // it with the catalog rebuild time trains crawlers to ignore the signal.
    { path: '/docs/api' },
    ...catalog.plugins.map((plugin) => ({
      path: pluginPath(plugin),
      lastModified: (plugin.pushedAt ?? plugin.updatedAt ?? plugin.added).slice(0, 10),
    })),
  ]
  const urls = pages.map(({ path, lastModified }) => [
    '  <url>',
    `    <loc>${xmlEscape(absoluteUrl(path))}</loc>`,
    ...(lastModified ? [`    <lastmod>${xmlEscape(lastModified)}</lastmod>`] : []),
    '  </url>',
  ].join('\n')).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}

/**
 * The SPA has no content of its own: every page is assembled from
 * `/api/v1/plugins*`. Blanket-disallowing `/api/` therefore made the whole site
 * unrenderable for crawlers, so the read-only catalog endpoints are explicitly
 * allowed and only the account/telemetry surface stays closed.
 */
export function buildRobotsTxt(): string {
  const rules = [
    'Allow: /',
    'Allow: /api/v1/plugins',
    'Disallow: /api/v1/auth/',
    'Disallow: /api/v1/api-keys',
    'Disallow: /api/v1/catalog/',
    'Disallow: /api/v1/install-events',
    'Disallow: /api/live',
  ]
  const aiAgents = [
    'GPTBot',
    'OAI-SearchBot',
    'ChatGPT-User',
    'ClaudeBot',
    'Claude-SearchBot',
    'PerplexityBot',
    'Google-Extended',
    'Applebot-Extended',
    'CCBot',
  ]
  return [
    'User-agent: *',
    ...rules,
    '',
    // Named groups replace the wildcard group entirely, so these repeat the
    // same rules; the stanza states the existing policy rather than changing it.
    ...aiAgents.map((agent) => `User-agent: ${agent}`),
    ...rules,
    '',
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    '',
  ].join('\n')
}

/**
 * The API host serves external API clients, never the website, and has no page
 * on it worth indexing. robots.txt governs crawling, not API calls: a developer
 * or an agent hitting the documented endpoint is a client, not a crawler, so
 * closing the host to crawlers costs that audience nothing.
 */
export function buildApiHostRobotsTxt(): string {
  return ['User-agent: *', 'Disallow: /', ''].join('\n')
}

/**
 * The whole catalog as plain text, for answer engines that will not run
 * JavaScript and will not crawl 2,900 URLs. Install commands come from the
 * registry `install` field, never a literal.
 */
export function buildLlmsFullTxt(catalog: SeoCatalog): string {
  const grouped = new Map<string, CatalogPlugin[]>()
  for (const plugin of [...catalog.plugins].sort(comparePlugins('stars'))) {
    const bucket = grouped.get(plugin.category) ?? []
    bucket.push(plugin)
    grouped.set(plugin.category, bucket)
  }
  const sections = [...grouped.entries()]
    .sort((left, right) => right[1].length - left[1].length)
    .map(([category, plugins]) => {
      const lines = plugins.map((plugin) => {
        const description = plugin.description.en.replace(/\s+/g, ' ').trim()
        return `- [${plugin.name}](${SITE_ORIGIN}${pluginPath(plugin)}) — ${description} — install: ${plugin.install}`
      })
      return `## ${categoryLabelFor(catalog, category, 'en')} (${plugins.length})\n\n${lines.join('\n')}`
    })
  return [
    '# DSH 1024Store — full DeepSeek Harness plugin catalog',
    '',
    `> ${catalog.plugins.length} plugins for DeepSeek Harness (\`dsh\`), DeepSeek's coding-agent CLI. Updated ${catalog.updated}.`,
    '> Install any listed plugin with: dsh plugin --profile web add github:<owner>/<repository>',
    `> Source: ${SITE_ORIGIN}/ · Search API: https://api.deepseek1024.com/v1/plugins/search?q= · Catalog: https://api.deepseek1024.com/v1/registry`,
    '',
    ...sections,
    '',
  ].join('\n')
}

export function rewriteHtmlResponse(response: Response, metadata: PageMetadata): Response {
  const rewriter = new HTMLRewriter()
    .on('title', {
      element(element) {
        element.setInnerContent(metadata.title)
      },
    })
    .on('meta[name="description"]', {
      element(element) {
        element.setAttribute('content', metadata.description)
      },
    })
    .on('meta[name="robots"]', {
      element(element) {
        element.setAttribute('content', metadata.robots)
      },
    })
    .on('meta[property="og:title"], meta[name="twitter:title"]', {
      element(element) {
        element.setAttribute('content', metadata.title)
      },
    })
    .on('meta[property="og:description"], meta[name="twitter:description"]', {
      element(element) {
        element.setAttribute('content', metadata.description)
      },
    })
    .on('meta[property="og:url"]', {
      element(element) {
        if (metadata.canonical) element.setAttribute('content', metadata.canonical)
        // Leaving the static homepage URL on a permutation would describe the
        // wrong page to anything that unfurls the link.
        else element.remove()
      },
    })
    .on('meta[property="og:image"], meta[name="twitter:image"]', {
      element(element) {
        element.setAttribute('content', SITE_IMAGE)
      },
    })
    .on('meta[property="og:image:alt"]', {
      element(element) {
        element.setAttribute('content', metadata.imageAlt ?? SITE_NAME)
      },
    })
    .on('link[rel="canonical"]', {
      element(element) {
        if (metadata.canonical) element.setAttribute('href', metadata.canonical)
        else element.remove()
      },
    })
    .on('script[data-seo-schema]', {
      element(element) {
        const json = JSON.stringify(metadata.schema).replaceAll('<', '\\u003c')
        element.setInnerContent(json, { html: true })
      },
    })
    // The React app is client rendered, so without this the document a crawler
    // receives is an empty container. `createRoot().render()` discards these
    // children on mount, which is what keeps the shell a pre-hydration
    // projection rather than a second document. Switching to `hydrateRoot`
    // would turn it into a hydration mismatch.
    .on('div#root', {
      element(element) {
        if (metadata.shell) element.setInnerContent(metadata.shell, { html: true })
      },
    })

  const transformed = rewriter.transform(response)
  const headers = new Headers(transformed.headers)
  headers.set(
    'Cache-Control',
    metadata.status === 200
      ? 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600'
      : 'public, max-age=60, s-maxage=300',
  )
  headers.set('X-Robots-Tag', metadata.robots)
  return new Response(transformed.body, {
    status: metadata.status,
    headers,
  })
}
