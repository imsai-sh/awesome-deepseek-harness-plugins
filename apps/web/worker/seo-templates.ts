import { pluginDetailPath } from './lib/plugin-id'
import type { CatalogPlugin, Language, RegistryPlugin } from './types'

/**
 * The single source of truth for page titles, descriptions and JSON-LD.
 *
 * The Worker stamps metadata into the served HTML and the React app restamps it
 * on client-side navigation. Two copies of the same templates drifted apart
 * before (the rankings description named different ranking signals in each), so
 * both sides import from here. The module stays framework-free — no DOM, no
 * node builtins — because it is compiled into the Worker bundle as well as the
 * browser bundle.
 */

export const SITE_ORIGIN = 'https://deepseek1024.com'
export const SITE_NAME = 'DSH 1024Store'
export const SITE_IMAGE = `${SITE_ORIGIN}/og-default.png`
export const GITHUB_REPOSITORY = 'https://github.com/imsai-sh/awesome-deepseek-harness-plugins'
export const TITLE_MAX = 60
export const DESC_MAX = 160

/** Auto-discovery fills this in when a repository ships no usable description. */
const PLACEHOLDER_DESCRIPTION = /^\S+\/\S+ discovered from GitHub\.$/

export function fitText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  const candidate = normalized.slice(0, maxLength - 1).trimEnd()
  const lastSpace = candidate.lastIndexOf(' ')
  const boundary = lastSpace >= Math.floor(maxLength * 0.7) ? lastSpace : candidate.length
  return `${candidate.slice(0, boundary).replace(/[.,;:!?，。；：！？-]+$/, '')}…`
}

export function absoluteUrl(path: string): string {
  return new URL(path, SITE_ORIGIN).toString()
}

export function pluginPath(plugin: Pick<RegistryPlugin, 'id'>): string {
  // Built from the id, not owner + repository name: a monorepo subpackage's
  // page lives at owner/repository/sub/dir, and encoding the separators away
  // would point every SEO surface at a URL that does not exist.
  return pluginDetailPath(plugin.id)
}

/**
 * Plugin names repeat across owners (607 of ~2,900 titles collided), so the
 * owner is part of every title. The brand tail is dropped a segment at a time
 * rather than letting the name itself be truncated — a half-eaten plugin name
 * is worthless in a SERP, a missing brand suffix is merely a shame.
 */
export function pluginTitle(name: string, owner: string, language: Language = 'en'): string {
  const zh = language === 'zh'
  const candidates = zh
    ? [
        `${name} — ${owner} 的 DeepSeek Harness 插件 | ${SITE_NAME}`,
        `${name} — ${owner} 的 DeepSeek Harness 插件`,
        `${name} — ${owner} 的 DSH 插件`,
        `${name} — ${owner}`,
      ]
    : [
        `${name} — DeepSeek Harness Plugin by ${owner} | ${SITE_NAME}`,
        `${name} — DeepSeek Harness Plugin by ${owner}`,
        `${name} — DSH Plugin by ${owner}`,
        `${name} by ${owner}`,
      ]
  for (const candidate of candidates) {
    if (candidate.length <= TITLE_MAX) return candidate
  }
  return candidates[candidates.length - 1] as string
}

/**
 * Lead with the plugin's own sentence so the ~2,900 snippets stay distinct;
 * fall back to a category-aware sentence only when the repository gave us
 * nothing usable.
 */
export function pluginLeadSentence(
  name: string,
  owner: string,
  description: string,
  categoryLabel: string,
  language: Language = 'en',
): string {
  const own = description.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim()
  const usable = own.length >= 20 && !PLACEHOLDER_DESCRIPTION.test(own)
  if (usable) return own
  if (language === 'zh') {
    return categoryLabel
      ? `${name} 是 ${owner} 发布的 DeepSeek Harness（dsh）${categoryLabel}插件。`
      : `${name} 是 ${owner} 发布的 DeepSeek Harness（dsh）插件。`
  }
  return categoryLabel
    ? `${name} is a ${categoryLabel.toLocaleLowerCase('en-US')} plugin for the DeepSeek Harness (dsh) coding agent, published by ${owner} on GitHub.`
    : `${name} is a plugin for the DeepSeek Harness (dsh) coding agent CLI, published by ${owner} on GitHub.`
}

export function pluginDescription(
  name: string,
  owner: string,
  description: string,
  categoryLabel: string,
  language: Language = 'en',
): string {
  const raw = pluginLeadSentence(name, owner, description, categoryLabel, language)
  const lead = /[.!?。！？…]$/.test(raw) ? raw : `${raw}.`
  const tail = language === 'zh'
    ? ` ${owner} 开发的 DSH 插件，一条命令即可安装。`
    : ` DSH plugin by ${owner}. Install with one command.`
  return fitText(lead.length + tail.length <= DESC_MAX ? lead + tail : lead, DESC_MAX)
}

/**
 * The hero paragraph both collection views render. It is shared rather than
 * per-view because the masthead is shared, and the pre-hydration shell has to
 * state exactly what the rendered page states.
 */
export const BRAND_HEADING = 'DeepSeek Harness Plugin 1024Store'

const HERO_INTRO = {
  en: 'Every listing passes DSH plugin spec checks and screening first. Then compare community plugins by wrapper-CLI install reports, GitHub stars, releases, and repository activity to find established and emerging tools.',
  zh: '收录插件均先经 DSH 插件规范检查与过滤，再按包装 CLI 上报的安装记录、GitHub Star、发布记录与仓库活跃度比较，发现成熟工具与潜力新项目。',
}

export type CollectionView = 'rankings' | 'catalog' | 'apiDocs' | 'account' | 'community' | 'communityRules'

export interface CollectionCopy {
  title: string
  description: string
  heading: string
  intro: string
  listHeading: string
}

function formatTotal(total: number, language: Language): string {
  return total > 0 ? total.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US') : ''
}

/**
 * Collection copy is generated rather than stored so the plugin count in the
 * description tracks the catalog instead of going stale in a translation file.
 */
export function collectionCopy(
  view: CollectionView,
  language: Language,
  total = 0,
): CollectionCopy {
  const count = formatTotal(total, language)
  const zh = language === 'zh'
  if (view === 'catalog') {
    return zh
      ? {
          title: `DeepSeek Harness 插件市场与目录 | ${SITE_NAME}`,
          description: fitText(
            `DeepSeek Harness 插件商店：按分类浏览${count ? ` ${count} 个` : ''} dsh 插件，对比 GitHub 活跃度，复制官方安装命令。`,
            DESC_MAX,
          ),
          heading: 'DeepSeek Harness 插件市场',
          intro: HERO_INTRO.zh,
          listHeading: '全部 DeepSeek Harness 插件',
        }
      : {
          title: `DeepSeek Harness Plugin Marketplace | ${SITE_NAME}`,
          description: fitText(
            `The DeepSeek Harness plugin hub: browse${count ? ` ${count}` : ''} dsh plugins by category, compare GitHub activity, and copy the official install command.`,
            DESC_MAX,
          ),
          heading: 'DeepSeek Harness Plugin Marketplace',
          intro: HERO_INTRO.en,
          listHeading: 'All DeepSeek Harness plugins',
        }
  }
  if (view === 'apiDocs') {
    return zh
      ? {
          title: `DeepSeek Harness 插件搜索 API | ${SITE_NAME}`,
          description: fitText(
            'DSH 1024Store 免费公开 API：搜索 DeepSeek Harness 社区插件目录，GitHub 登录即可申请 API Key，限流透明。',
            DESC_MAX,
          ),
          heading: '开发者 API',
          intro: '以编程方式查询 DSH 1024Store 插件目录。匿名请求即开即用；使用 GitHub 登录并创建 API Key 可获得更高配额。',
          listHeading: '接口',
        }
      : {
          title: `DeepSeek Harness Plugin Search API | ${SITE_NAME}`,
          description: fitText(
            'Search the DeepSeek Harness plugin store over a free public REST API, with GitHub-login API keys and transparent rate limits.',
            DESC_MAX,
          ),
          heading: 'Developer API',
          intro: 'Query the DSH 1024Store plugin catalog programmatically. Anonymous requests work out of the box; sign in with GitHub and create an API key for higher limits.',
          listHeading: 'Endpoints',
        }
  }
  if (view === 'community') {
    return zh
      ? {
          title: `DSH 讨论区 · 开发者社区 | ${SITE_NAME}`,
          description: 'DeepSeek Harness 插件开发者的公开广场：分享进展、提问、聊插件。用 GitHub 账号登录即可发言。',
          heading: 'DSH 讨论区',
          intro: 'DeepSeek Harness 开发者的公开广场。',
          listHeading: '最新发言',
        }
      : {
          title: `DSH Forum · Developer community | ${SITE_NAME}`,
          description: 'The open square for DeepSeek Harness plugin developers: progress, questions, and plugins. Sign in with GitHub to post.',
          heading: 'DSH Forum',
          intro: 'The open square for DeepSeek Harness developers.',
          listHeading: 'Latest posts',
        }
  }

  if (view === 'communityRules') {
    return zh
      ? {
          title: `社区规则 · DSH 讨论区 | ${SITE_NAME}`,
          description: 'DSH 讨论区的发言规则：谁能发、发什么、怎么删。',
          heading: '关于 DSH 讨论区',
          intro: 'DeepSeek Harness 开发者的公开广场。',
          listHeading: '规则',
        }
      : {
          title: `Guidelines · DSH Forum | ${SITE_NAME}`,
          description: 'How posting works on DSH Forum: who can post, what belongs here, and how removal works.',
          heading: 'About DSH Forum',
          intro: 'The open square for DeepSeek Harness developers.',
          listHeading: 'Guidelines',
        }
  }

  if (view === 'account') {
    return zh
      ? {
          title: `账户与 API Key | ${SITE_NAME}`,
          description: '管理你的 DSH 1024Store 账户与开发者 API Key。',
          heading: '账户与 API Key',
          intro: '管理你的 DSH 1024Store 账户与开发者 API Key。',
          listHeading: 'API Key',
        }
      : {
          title: `Account & API keys | ${SITE_NAME}`,
          description: 'Manage your DSH 1024Store account and developer API keys.',
          heading: 'Account & API keys',
          intro: 'Manage your DSH 1024Store account and developer API keys.',
          listHeading: 'API keys',
        }
  }
  return zh
    ? {
        title: `DeepSeek Harness 插件商店与排行榜 | ${SITE_NAME}`,
        description: fitText(
          `DeepSeek Harness 社区插件商店：按匿名安装量、GitHub 星标、发布与仓库活跃度对比${count ? ` ${count} 个` : ''} dsh 插件。`,
          DESC_MAX,
        ),
        heading: 'DeepSeek Harness 插件排行榜',
        intro: HERO_INTRO.zh,
        listHeading: 'DeepSeek Harness 插件排行榜',
      }
    : {
        title: `DeepSeek Harness Plugin Store & Rankings | ${SITE_NAME}`,
        description: fitText(
          `The community plugin store for DeepSeek Harness (dsh): compare${count ? ` ${count}` : ''} plugins by anonymous install activity, GitHub stars, releases and repository activity.`,
          DESC_MAX,
        ),
        heading: 'DeepSeek Harness Plugin Rankings',
        intro: HERO_INTRO.en,
        listHeading: 'DeepSeek Harness plugin rankings',
      }
}

/**
 * `WebSite` + `Organization` nodes, emitted on every page so the `@id`
 * references in the page-level nodes resolve. `alternateName` is the only
 * lever available for binding the ambiguous "DSH" abbreviation to this entity.
 */
export function siteNodes(): object[] {
  return [
    {
      '@type': 'WebSite',
      '@id': `${SITE_ORIGIN}/#website`,
      name: SITE_NAME,
      url: `${SITE_ORIGIN}/`,
      inLanguage: ['en', 'zh-CN'],
      alternateName: [
        'DSH',
        'DSH Store',
        'DSH 1024Store',
        'DeepSeek Harness Plugin Store',
        'DeepSeek Harness Plugin Marketplace',
        'DeepSeek Harness 插件市场',
        'DeepSeek Harness 插件商店',
      ],
      publisher: { '@id': `${SITE_ORIGIN}/#organization` },
      potentialAction: {
        '@type': 'SearchAction',
        target: {
          '@type': 'EntryPoint',
          urlTemplate: `${SITE_ORIGIN}/plugins?q={search_term_string}`,
        },
        'query-input': 'required name=search_term_string',
      },
    },
    {
      '@type': 'Organization',
      '@id': `${SITE_ORIGIN}/#organization`,
      name: SITE_NAME,
      url: `${SITE_ORIGIN}/`,
      logo: {
        '@type': 'ImageObject',
        url: `${SITE_ORIGIN}/deepseek1024.png`,
        width: 512,
        height: 512,
      },
      sameAs: [GITHUB_REPOSITORY],
    },
  ]
}

export function collectionPageNode(
  path: string,
  copy: CollectionCopy,
  language: Language,
  itemListId?: string,
): object {
  const url = absoluteUrl(path)
  return {
    '@type': 'CollectionPage',
    '@id': `${url}#webpage`,
    url,
    name: copy.title,
    description: copy.description,
    inLanguage: language === 'zh' ? 'zh-CN' : 'en',
    isPartOf: { '@id': `${SITE_ORIGIN}/#website` },
    ...(itemListId ? { mainEntity: { '@id': itemListId } } : {}),
  }
}

/**
 * The catalog snapshot is ordered by normalized repository name, so ranked
 * lists must be sorted here or the "top plugins" list ships alphabetically.
 */
export function itemListNode(
  plugins: Pick<CatalogPlugin, 'id' | 'name' | 'owner' | 'url'>[],
  path: string,
  name: string,
  total: number,
): object {
  const url = absoluteUrl(path)
  return {
    '@type': 'ItemList',
    '@id': `${url}#items`,
    name,
    numberOfItems: total,
    itemListOrder: 'https://schema.org/ItemListOrderDescending',
    itemListElement: plugins.map((plugin, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: plugin.name,
      url: absoluteUrl(pluginPath(plugin)),
    })),
  }
}

export interface PluginNodeInput {
  name: string
  owner: string
  url: string
  description: string
  categoryLabel: string
  added: string
  stars?: number | null
  pushedAt?: string | null
  updatedAt?: string | null
  license?: string | null
  repository: string
  /**
   * Where the plugin's source actually lives. A monorepo subpackage points at
   * its subdirectory; omit it and the repository URL is used.
   */
  sourceUrl?: string
}

export function pluginNodes(
  plugin: PluginNodeInput,
  canonical: string,
  title: string,
  description: string,
  language: Language,
  breadcrumbLabel: string,
): object[] {
  const softwareId = `${canonical}#software`
  const dateModified = plugin.pushedAt ?? plugin.updatedAt ?? undefined
  return [
    {
      '@type': 'WebPage',
      '@id': `${canonical}#webpage`,
      url: canonical,
      name: title,
      description,
      inLanguage: language === 'zh' ? 'zh-CN' : 'en',
      isPartOf: { '@id': `${SITE_ORIGIN}/#website` },
      mainEntity: { '@id': softwareId },
      breadcrumb: { '@id': `${canonical}#breadcrumb` },
    },
    {
      // Dual-typed: it is source code on GitHub and an installable application
      // inside the harness, and the two vocabularies answer different queries.
      '@type': ['SoftwareApplication', 'SoftwareSourceCode'],
      '@id': softwareId,
      name: plugin.name,
      alternateName: `${plugin.owner}/${plugin.repository}`,
      description: plugin.description,
      applicationCategory: 'DeveloperApplication',
      applicationSubCategory: 'DeepSeek Harness plugin',
      operatingSystem: 'Cross-platform',
      runtimePlatform: 'DeepSeek Harness',
      softwareRequirements: 'DeepSeek Harness (dsh) CLI',
      codeRepository: plugin.sourceUrl ?? plugin.url,
      author: {
        '@type': 'Person',
        name: plugin.owner,
        url: `https://github.com/${plugin.owner}`,
      },
      datePublished: plugin.added,
      ...(dateModified ? { dateModified } : {}),
      ...(plugin.license ? { license: plugin.license } : {}),
      ...(typeof plugin.stars === 'number' && plugin.stars > 0
        ? {
            // GitHub stars are not ratings; InteractionCounter is the honest
            // mapping and aggregateRating would be fabricated.
            interactionStatistic: [{
              '@type': 'InteractionCounter',
              interactionType: 'https://schema.org/LikeAction',
              userInteractionCount: plugin.stars,
            }],
          }
        : {}),
    },
    {
      '@type': 'BreadcrumbList',
      '@id': `${canonical}#breadcrumb`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: breadcrumbLabel, item: `${SITE_ORIGIN}/plugins` },
        { '@type': 'ListItem', position: 2, name: plugin.name, item: canonical },
      ],
    },
  ]
}

export function apiDocsNodes(copy: CollectionCopy, language: Language): object[] {
  const url = absoluteUrl('/docs/api')
  return [
    {
      '@type': 'TechArticle',
      '@id': `${url}#webpage`,
      url,
      name: copy.title,
      description: copy.description,
      inLanguage: language === 'zh' ? 'zh-CN' : 'en',
      isPartOf: { '@id': `${SITE_ORIGIN}/#website` },
      mainEntity: { '@id': `${url}#api` },
    },
    {
      '@type': 'WebAPI',
      '@id': `${url}#api`,
      name: 'DSH 1024Store Plugin Search API',
      description: copy.description,
      documentation: url,
      url: 'https://api.deepseek1024.com/v1/plugins/search',
      provider: { '@id': `${SITE_ORIGIN}/#organization` },
    },
    {
      '@type': 'WebAPI',
      '@id': `${url}#registry`,
      name: 'DSH 1024Store Plugin Catalog Registry API',
      description: copy.description,
      documentation: url,
      url: 'https://api.deepseek1024.com/v1/registry',
      provider: { '@id': `${SITE_ORIGIN}/#organization` },
    },
  ]
}

export function simplePageNode(path: string, copy: CollectionCopy, language: Language): object {
  const url = absoluteUrl(path)
  return {
    '@type': 'WebPage',
    '@id': `${url}#webpage`,
    url,
    name: copy.title,
    description: copy.description,
    inLanguage: language === 'zh' ? 'zh-CN' : 'en',
    isPartOf: { '@id': `${SITE_ORIGIN}/#website` },
  }
}

export function graph(nodes: object[]): object {
  return { '@context': 'https://schema.org', '@graph': nodes }
}
