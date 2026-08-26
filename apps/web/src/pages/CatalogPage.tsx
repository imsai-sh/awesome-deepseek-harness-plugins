import {
  AlertCircle,
  ArrowUpRight,
  ListFilter,
  PackageCheck,
  PackagePlus,
  Search,
  Trophy,
  UserRound,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { LoadingState } from '../components/LoadingState'
import { LanguageSwitch } from '../components/LanguageSwitch'
import { InstalledPackages } from '../components/InstalledPackages'
import { PackageRow } from '../components/PackageRow'
import { SelfInstallBanner } from '../components/SelfInstallBanner'
import type {
  CatalogPlugin,
  CatalogSort,
  CategoryResult,
  Language,
  PluginsPage,
  RankingMode,
  RankingsData,
} from '../lib/api'
import {
  getCachedPluginsPage,
  getCachedRankings,
  loadPluginsPage,
  loadRankings,
} from '../lib/catalog-cache'
import { publicAsset } from '../lib/assets'
import { formatDateTime, formatExactNumber, formatNumber, formatRelativeUpdate } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { useEmbedBridge } from '../lib/embedBridge'
import { useLiveStats } from '../lib/useLiveStats'
import {
  collectionCopy,
  collectionPageNode,
  graph,
  itemListNode,
  siteNodes,
  SITE_ORIGIN,
} from '../../worker/seo-templates'
import { usePageSeo } from '../lib/usePageSeo'

const SORT_MODES: CatalogSort[] = ['stars', 'npmDownloads7d', 'installs', 'newest', 'active']
// One directory page. The server slices the catalog; the client asks for the
// next page on "load more" and appends, so a browse never holds more than it
// has scrolled to.
const PAGE_SIZE = 100

interface DirectoryState {
  /** `${query}|${category}|${sort}` — the filter this accumulation belongs to. */
  key: string
  plugins: CatalogPlugin[]
  page: number
  totalPages: number
  total: number
  catalogTotal: number
  categories: CategoryResult[]
  generatedAt: string
}

function directoryFrom(key: string, page: PluginsPage): DirectoryState {
  return {
    key,
    plugins: page.plugins,
    page: page.page,
    totalPages: page.totalPages,
    total: page.total,
    catalogTotal: page.catalogTotal,
    categories: page.categories,
    generatedAt: page.generatedAt,
  }
}
// growth7d / growth30d stay available in the API but are hidden here until
// enough snapshot history accumulates to make those windows meaningful.
const INSTALL_RANKING_MODES: RankingMode[] = ['installs']
const GITHUB_RANKING_MODES: RankingMode[] = [
  'growth24h',
  'stars',
  'npmDownloads7d',
  'newest',
  'active',
]

function rankingLabel(mode: RankingMode): Parameters<ReturnType<typeof useI18n>['t']>[0] {
  if (mode === 'installs') return 'topInstalls'
  if (mode === 'installs24h') return 'installs24h'
  if (mode === 'installs7d') return 'installs7d'
  if (mode === 'installs30d') return 'installs30d'
  if (mode === 'npmDownloads7d') return 'npmRanking'
  if (mode === 'growth24h') return 'growth24h'
  if (mode === 'growth7d') return 'growth7d'
  if (mode === 'growth30d') return 'growth30d'
  if (mode === 'stars') return 'topStars'
  if (mode === 'newest') return 'latestReleases'
  return 'recentlyActive'
}

function useCountUp(target: number | null, animate: boolean): number | null {
  const [value, setValue] = useState<number | null>(null)
  const previousRef = useRef(0)
  useEffect(() => {
    if (target === null) return
    const from = previousRef.current
    if (
      !animate
      || target === from
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      previousRef.current = target
      setValue(target)
      return
    }
    let frame = 0
    const start = performance.now()
    const step = (now: number) => {
      const progress = Math.min(Math.max((now - start) / 900, 0), 1)
      const eased = 1 - (1 - progress) ** 3
      const next = Math.round(from + (target - from) * eased)
      previousRef.current = next
      setValue(next)
      if (progress < 1) frame = window.requestAnimationFrame(step)
    }
    frame = window.requestAnimationFrame(step)
    // Animation frames stop entirely in hidden/background tabs; make sure the
    // final value still lands once the duration has passed.
    const settle = window.setTimeout(() => {
      previousRef.current = target
      setValue(target)
    }, 1100)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(settle)
    }
  }, [animate, target])
  return value
}

// Isolates the per-frame count-up state so the animation re-renders this leaf
// only, not the whole page while up to 100 package rows are mounted.
function TallyCount({ total, language, animate }: {
  total: number | null
  language: Language
  animate: boolean
}) {
  const value = useCountUp(total, animate)
  return <>{value === null ? '--' : formatExactNumber(value, language)}</>
}

function CatalogUpdatedAt({ value, language }: { value: string; language: Language }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [])

  const label = formatRelativeUpdate(value, language, now)
  if (!label) return null

  return (
    <time className="hero-updated" dateTime={value} title={formatDateTime(value, language)}>
      {label}
    </time>
  )
}

// Play the hero entrance (CSS rise + count-up) once per page load, not every
// time the router remounts this page on the way back from a detail view.
let heroIntroPlayed = false

interface CatalogPageProps {
  view: 'catalog' | 'rankings'
}

export function CatalogPage({ view }: CatalogPageProps) {
  const { language, t } = useI18n()
  const {
    embedded,
    connected: bridgeConnected,
    activation,
    installedPluginIds,
    readCatalogPageCache,
    writeCatalogPageCache,
  } = useEmbedBridge()
  const { stats, connected } = useLiveStats()
  const [searchParams, setSearchParams] = useSearchParams()
  const query = searchParams.get('q') ?? ''
  const category = searchParams.get('category') ?? ''
  const showInstalled = embedded && searchParams.get('local') === 'installed'
  const requestedSort = searchParams.get('sort')
  const sort: CatalogSort = view === 'catalog' && SORT_MODES.includes(requestedSort as CatalogSort)
    ? requestedSort as CatalogSort
    : 'stars'
  const [draftQuery, setDraftQuery] = useState(query)
  const [rankingMode, setRankingMode] = useState<RankingMode>('growth24h')
  const directoryKey = `${query}|${category}|${sort}`
  // The directory, a page at a time and accumulated on "load more"; the
  // rankings boards; and, when a search runs on the rankings view, that
  // search's first page. None of these is the whole catalog.
  const [directory, setDirectory] = useState<DirectoryState | null>(() => {
    const first = getCachedPluginsPage({ q: query, category, sort, page: 1, limit: PAGE_SIZE })
    return first ? directoryFrom(directoryKey, first) : null
  })
  const [rankingsData, setRankingsData] = useState<RankingsData | null>(() => getCachedRankings())
  const [rankingSearch, setRankingSearch] = useState<{ key: string; plugins: CatalogPlugin[]; total: number } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [playIntro] = useState(() => !heroIntroPlayed)
  useEffect(() => {
    heroIntroPlayed = true
  }, [])
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [reload, setReload] = useState(0)
  const [showingPluginCache, setShowingPluginCache] = useState(false)
  const pluginCacheKeyRef = useRef<string | null>(null)
  const networkResolvedKeyRef = useRef<string | null>(null)

  useEffect(() => setDraftQuery(query), [query])

  useEffect(() => {
    if (draftQuery === query) return
    const timeout = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams)
      if (draftQuery.trim()) next.set('q', draftQuery.trim())
      else next.delete('q')
      setSearchParams(next, { replace: true })
    }, 220)
    return () => window.clearTimeout(timeout)
  }, [draftQuery, query, searchParams, setSearchParams])

  const pluginCacheEligible = embedded && view === 'catalog'
    && query === '' && category === '' && sort === 'stars'

  // The embedded plugin owns this snapshot. Ask for it immediately, but do
  // not wait before starting the production request below: cached content is
  // the first paint, never the freshness mechanism.
  useEffect(() => {
    if (!pluginCacheEligible || !bridgeConnected) {
      pluginCacheKeyRef.current = null
      setShowingPluginCache(false)
      return
    }
    let cancelled = false
    void readCatalogPageCache().then((page) => {
      if (cancelled || page === null || networkResolvedKeyRef.current === directoryKey) return
      pluginCacheKeyRef.current = directoryKey
      setShowingPluginCache(true)
      setDirectory(directoryFrom(directoryKey, page))
      setError(null)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [directoryKey, pluginCacheEligible, bridgeConnected, readCatalogPageCache])

  // Directory: fetch page 1 whenever the filter changes or a refresh fires.
  // In the DSH shell this is classic stale-while-revalidate: the memory/disk
  // snapshot paints first, but every activation still reaches the real API.
  // "Load more" appends later pages; it does not run here.
  useEffect(() => {
    if (view !== 'catalog') return
    let cancelled = false
    networkResolvedKeyRef.current = null
    const force = embedded || reload > 0
    const params = { q: query, category, sort, page: 1, limit: PAGE_SIZE }
    if (getCachedPluginsPage(params) === null) setRefreshing(true)
    loadPluginsPage(params, { force })
      .then((data) => {
        if (cancelled) return
        networkResolvedKeyRef.current = directoryKey
        pluginCacheKeyRef.current = null
        setShowingPluginCache(false)
        setDirectory(directoryFrom(directoryKey, data))
        setError(null)
        if (pluginCacheEligible) void writeCatalogPageCache(data).catch(() => {})
      })
      .catch((requestError: unknown) => {
        if (cancelled || getCachedPluginsPage(params) || pluginCacheKeyRef.current === directoryKey) return
        setError(requestError instanceof Error ? requestError.message : t('loadError'))
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false)
      })
    return () => {
      cancelled = true
    }
  }, [view, directoryKey, query, category, sort, reload, activation, t, embedded, pluginCacheEligible, writeCatalogPageCache])

  // Rankings use the same embedded stale-while-revalidate contract: cached
  // boards remain visible while each activation requests a fresh payload.
  useEffect(() => {
    if (view !== 'rankings') return
    let cancelled = false
    const force = embedded || reload > 0
    if (!getCachedRankings()) setRefreshing(true)
    loadRankings({ force })
      .then((data) => {
        if (cancelled) return
        setRankingsData(data)
        setError(null)
      })
      .catch((requestError: unknown) => {
        if (cancelled || getCachedRankings()) return
        setError(requestError instanceof Error ? requestError.message : t('loadError'))
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false)
      })
    return () => {
      cancelled = true
    }
  }, [view, reload, activation, t, embedded])

  // Searching on the rankings view shows the matches, ranked by the active
  // board's metric — the same behaviour the client-derived model had, now a
  // single search page instead of a filter over the whole catalog.
  useEffect(() => {
    if (view !== 'rankings' || !query) {
      setRankingSearch(null)
      return
    }
    let cancelled = false
    const key = `${query}|${rankingMode}`
    loadPluginsPage({ q: query, sort: rankingMode, page: 1, limit: 100 })
      .then((data) => {
        if (!cancelled) setRankingSearch({ key, plugins: data.plugins, total: data.total })
      })
      .catch(() => {
        if (!cancelled) setRankingSearch({ key, plugins: [], total: 0 })
      })
    return () => {
      cancelled = true
    }
  }, [view, query, rankingMode])

  async function loadMore() {
    if (!directory || directory.key !== directoryKey || loadingMore) return
    if (directory.page >= directory.totalPages) return
    setLoadingMore(true)
    try {
      const next = await loadPluginsPage({
        q: query,
        category,
        sort,
        page: directory.page + 1,
        limit: PAGE_SIZE,
      })
      setDirectory((prev) =>
        prev && prev.key === directoryKey
          ? {
              ...prev,
              plugins: [...prev.plugins, ...next.plugins],
              page: next.page,
              totalPages: next.totalPages,
              total: next.total,
            }
          : prev,
      )
    } catch {
      // Keep what is already shown; the button stays and the reader can retry.
    } finally {
      setLoadingMore(false)
    }
  }

  const directoryReady = directory !== null && directory.key === directoryKey
  const rankingReady = query ? rankingSearch?.key === `${query}|${rankingMode}` : rankingsData !== null

  useEffect(() => {
    const interval = window.setInterval(() => setReload((value) => value + 1), 5 * 60 * 1000)
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') setReload((value) => value + 1)
    }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [])

  // Categories carry whole-catalog counts on both responses, so the sidebar
  // reads from whichever view is active.
  const activeCategories = (view === 'catalog' ? directory?.categories : rankingsData?.categories) ?? []
  const categoryMap = useMemo(
    () => new Map(activeCategories.map((item) => [item.id, item])),
    [activeCategories],
  )

  // A repository-collapsed board seat expands to its siblings; with the catalog
  // no longer client-side, those siblings arrive with the rankings response,
  // keyed by `owner/repository` exactly as the client used to group them.
  const pluginsByRepository = useMemo(
    () => new Map(Object.entries(rankingsData?.siblingsByRepository ?? {})),
    [rankingsData],
  )

  const visiblePackages = directoryReady ? directory.plugins : []
  const npmDirectoryPending = directoryReady && visiblePackages.length > 0 && sort === 'npmDownloads7d' &&
    visiblePackages.every((plugin) => plugin.npmDownloads7d == null)
  const hasMorePackages = directoryReady && directory.page < directory.totalPages
  const directoryTotal = directoryReady ? directory.total : 0
  const catalogTotal = directory?.catalogTotal ?? rankingsData?.catalogTotal ?? null
  const generatedAt = directory?.generatedAt ?? rankingsData?.generatedAt ?? null
  // The search box's match count: the directory's filtered total on the catalog
  // view, the search total when searching the rankings, the whole catalog
  // otherwise. Null until the relevant response has arrived.
  const resultCount: number | null = showInstalled
    ? null
    : view === 'catalog'
    ? (directoryReady ? directoryTotal : null)
    : (query ? rankingSearch?.total ?? null : catalogTotal)

  function updateFilter(key: 'category' | 'sort', value: string) {
    const next = new URLSearchParams(searchParams)
    if (value && !(key === 'sort' && value === 'stars')) next.set(key, value)
    else next.delete(key)
    setSearchParams(next)
  }

  function resetFilters() {
    setDraftQuery('')
    setSearchParams({})
  }

  function showInstalledPlugins() {
    const next = new URLSearchParams(searchParams)
    next.set('local', 'installed')
    next.delete('category')
    next.delete('sort')
    setSearchParams(next)
  }

  const ranking = useMemo(() => {
    const candidates = query
      ? rankingSearch?.plugins ?? []
      : rankingsData?.rankings[rankingMode] ?? []
    return candidates.slice(0, 100)
  }, [query, rankingSearch, rankingsData, rankingMode])
  const isGrowthMode =
    rankingMode === 'growth24h' || rankingMode === 'growth7d' || rankingMode === 'growth30d'
  const isNpmMode = rankingMode === 'npmDownloads7d'
  const isPendingRanking = !query && (isGrowthMode || isNpmMode)
  const catalogHref = query ? `/plugins?q=${encodeURIComponent(query)}` : '/plugins'
  const rankingsHref = query ? `/?q=${encodeURIComponent(query)}` : '/'
  const canonicalPath = view === 'catalog' ? '/plugins' : '/'
  // Titles, descriptions and JSON-LD come from the same module the Worker uses,
  // so a client-side navigation cannot disagree with the served HTML.
  const copy = collectionCopy(
    view === 'catalog' ? 'catalog' : 'rankings',
    language,
    catalogTotal ?? 0,
  )
  const hasIndexableFilters = Boolean(query || category || requestedSort || embedded)
  const rankedForSchema = useMemo(
    () => (view === 'catalog'
      ? directory?.plugins ?? []
      : rankingsData?.rankings[rankingMode] ?? []).slice(0, 30),
    [directory, rankingsData, rankingMode, view],
  )

  usePageSeo({
    title: copy.title,
    description: copy.description,
    path: canonicalPath,
    language,
    // Until the catalog resolves there is no ItemList and no plugin count, and
    // writing that emptiness over the Worker's populated metadata is strictly
    // worse than leaving the served head alone.
    ready: catalogTotal !== null,
    robots: hasIndexableFilters ? 'noindex,follow' : 'index,follow',
    canonical: hasIndexableFilters ? null : `${SITE_ORIGIN}${canonicalPath}`,
    schema: graph([
      ...siteNodes(),
      collectionPageNode(
        canonicalPath,
        copy,
        language,
        `${SITE_ORIGIN}${canonicalPath === '/' ? '/' : canonicalPath}#items`,
      ),
      itemListNode(
        rankedForSchema,
        canonicalPath,
        copy.listHeading,
        catalogTotal ?? rankedForSchema.length,
      ),
    ]),
  })

  return (
    <div
      className={`catalog-page ${view === 'rankings' ? 'rankings-page' : 'directory-page'}${playIntro ? '' : ' hero-static'}`}
    >
      <section className="catalog-hero">
        <div className="page-container catalog-hero-inner">
          <header className="hero-stage">
            <div className="hero-actions" aria-label={t('siteActions')}>
              <a
                className="hero-action-link hero-author"
                href="https://www.imsai.cc/"
                target="_blank"
                rel="noreferrer"
              >
                <UserRound size={16} aria-hidden="true" />
                <span>{t('authorHome')}</span>
                <ArrowUpRight size={12} aria-hidden="true" />
              </a>
              <a
                className="hero-action-link github-link"
                href="https://github.com/imsai-sh/awesome-deepseek-harness-plugins"
                target="_blank"
                rel="noreferrer"
              >
                <img src={publicAsset('github-mark.svg')} alt="" aria-hidden="true" />
                <span>{t('marketSource')}</span>
                <ArrowUpRight size={12} aria-hidden="true" />
              </a>
              <a
                className="hero-action-link hero-submit"
                href="https://github.com/imsai-sh/awesome-deepseek-harness-plugins"
                target="_blank"
                rel="noreferrer"
              >
                <PackagePlus size={16} aria-hidden="true" />
                <span>{t('submit')}</span>
              </a>
              <LanguageSwitch className="hero-language" />
            </div>
            <div className="hero-heading">
              <div className="hero-lockup">
                <span className="hero-lockup-mark" aria-hidden="true">
                  <img src={publicAsset('deepseek1024.png')} alt="" />
                </span>
                <div className="hero-lockup-copy">
                  <p className="hero-eyebrow">{t('heroEyebrow')}</p>
                  <h1>
                    <a
                      href="https://deepseek1024.com/"
                      aria-label="DeepSeek Harness Plugin 1024Store"
                    >
                      <span>DeepSeek Harness Plugin</span>
                      <em>1024Store</em>
                    </a>
                  </h1>
                </div>
              </div>
              <p className="hero-description">{copy.intro}</p>
              <a
                className="hero-link-exchange"
                href="https://www.imsai.cc/"
                target="_blank"
                rel="noreferrer"
              >
                <span className="hero-link-exchange-dot" aria-hidden="true" />
                <strong>{t('linkExchangeTitle')}</strong>
                <span>{t('linkExchangeBody')}</span>
                <ArrowUpRight size={12} aria-hidden="true" />
              </a>
            </div>

            <dl className="hero-tally">
              <div className="hero-tally-count">
                <dt className="hero-tally-label">{t('totalPlugins')}</dt>
                <dd className="hero-tally-value">
                  <TallyCount
                    total={catalogTotal}
                    language={language}
                    animate={playIntro}
                  />
                </dd>
              </div>
              <div className="hero-live">
                <dt className="hero-live-label">
                  <span className={connected ? 'live-dot is-connected' : 'live-dot'} aria-hidden="true" />
                  {t('online')}
                </dt>
                <dd className="hero-live-count">
                  {stats ? formatNumber(stats.online, language) : '--'}
                </dd>
              </div>
              {generatedAt && (
                <CatalogUpdatedAt value={generatedAt} language={language} />
              )}
            </dl>

            <SelfInstallBanner />
          </header>
        </div>
      </section>

      <div className="page-container catalog-content">
        <section className="catalog-navigation" aria-label={`${t('search')} / ${t('catalog')} / ${t('rankings')}`}>
          <section className="catalog-toolbar" aria-label={t('search')}>
            <label className="search-control">
              <Search size={19} aria-hidden="true" />
              <span className="visually-hidden">{t('search')}</span>
              <input
                type="search"
                value={draftQuery}
                onChange={(event) => setDraftQuery(event.target.value)}
                placeholder={t('searchPlaceholder')}
              />
              {resultCount !== null && (
                <small>
                  {formatExactNumber(resultCount, language)} {t(resultCount === 1 ? 'result' : 'results')}
                </small>
              )}
            </label>
          </section>

          <nav className="catalog-view-tabs" aria-label={`${t('catalog')} / ${t('rankings')}`}>
            <Link to={rankingsHref} className={!showInstalled && view === 'rankings' ? 'selected' : undefined} aria-current={!showInstalled && view === 'rankings' ? 'page' : undefined}>
              <Trophy size={16} aria-hidden="true" />
              {t('rankings')}
            </Link>
            <Link to={catalogHref} className={!showInstalled && view === 'catalog' ? 'selected' : undefined} aria-current={!showInstalled && view === 'catalog' ? 'page' : undefined}>
              <ListFilter size={16} aria-hidden="true" />
              <span>
                {t('catalog')}{catalogTotal !== null ? ` (${formatExactNumber(catalogTotal, language)})` : ''}
              </span>
            </Link>
            {embedded && (
              <button
                type="button"
                className={showInstalled ? 'selected' : undefined}
                aria-current={showInstalled ? 'page' : undefined}
                onClick={showInstalledPlugins}
              >
                <PackageCheck size={16} aria-hidden="true" />
                <span>
                  {t('installed')}{installedPluginIds !== null ? ` (${formatExactNumber(installedPluginIds.length, language)})` : ''}
                </span>
              </button>
            )}
          </nav>
        </section>

        {!showInstalled && view === 'catalog' && (
          <section className="category-section" aria-labelledby="categories-heading">
            <div className="section-heading compact-heading">
              <h2 id="categories-heading">{t('categories')}</h2>
            </div>
            <div className="category-filter" role="group" aria-label={t('category')}>
              <button
                type="button"
                className={!category ? 'selected' : undefined}
                onClick={() => updateFilter('category', '')}
                aria-pressed={!category}
              >
                {t('allCategories')}
                <span>{catalogTotal === null ? '--' : formatExactNumber(catalogTotal, language)}</span>
              </button>
              {activeCategories.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={category === item.id ? 'selected' : undefined}
                  onClick={() => updateFilter('category', item.id)}
                  aria-pressed={category === item.id}
                >
                  {item[language]}
                  <span>{formatExactNumber(item.count, language)}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {!showInstalled && view === 'rankings' && (
          <section className="catalog-section ranking-section" aria-labelledby="rankings-heading">
            <h2 id="rankings-heading" className="visually-hidden">{copy.listHeading}</h2>
            <div className="view-controls">
              <div className="ranking-mode-groups">
                <div className="ranking-mode-group">
                  <div className="segmented-control" role="group" aria-label={t('installRankings')}>
                    {INSTALL_RANKING_MODES.map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={rankingMode === mode ? 'selected' : undefined}
                        onClick={() => setRankingMode(mode)}
                        aria-pressed={rankingMode === mode}
                      >
                        {t(rankingLabel(mode))}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="ranking-mode-group">
                  <div className="segmented-control" role="group" aria-label={t('githubRankings')}>
                    {GITHUB_RANKING_MODES.map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={rankingMode === mode ? 'selected' : undefined}
                        onClick={() => setRankingMode(mode)}
                        aria-pressed={rankingMode === mode}
                      >
                        {t(rankingLabel(mode))}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {refreshing && rankingReady && (
                <span className="refresh-note" role="status">{t('refreshing')}</span>
              )}
            </div>

            {error ? (
              <div className="state-panel" role="alert">
                <AlertCircle size={27} aria-hidden="true" />
                <h3>{t('loadError')}</h3>
                <p>{error}</p>
                <button className="button button-secondary" type="button" onClick={() => setReload((value) => value + 1)}>
                  {t('retry')}
                </button>
              </div>
            ) : rankingReady && ranking.length === 0 ? (
              <div className="state-panel">
                <Search size={27} aria-hidden="true" />
                <h3>{t(
                  isGrowthMode && !query
                    ? 'growthPendingTitle'
                    : isNpmMode && !query
                      ? 'npmDownloadsPendingTitle'
                      : 'emptyTitle',
                )}</h3>
                <p>{t(
                  isGrowthMode && !query
                    ? 'growthPendingBody'
                    : isNpmMode && !query
                      ? 'npmDownloadsPendingBody'
                      : 'emptyBody',
                )}</p>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={isPendingRanking ? () => setRankingMode('stars') : resetFilters}
                >
                  {t(isPendingRanking ? 'topStars' : 'reset')}
                </button>
              </div>
            ) : rankingReady ? (
              <div className={`package-list ranking-list${refreshing ? ' is-refreshing' : ''}`}>
                {ranking.map((plugin, index) => (
                  <PackageRow
                    key={`${rankingMode}-${plugin.id}`}
                    plugin={plugin}
                    category={categoryMap.get(plugin.category)}
                    index={index}
                    ranking={rankingMode}
                    categories={categoryMap}
                    repositoryPlugins={pluginsByRepository.get(
                      `${plugin.owner}/${plugin.repository}`.toLocaleLowerCase('en-US'),
                    )}
                  />
                ))}
              </div>
            ) : !error ? (
              <LoadingState rows={5} />
            ) : null}
          </section>
        )}

        {!showInstalled && view === 'catalog' && (
          <section className="catalog-section directory-section" aria-labelledby="directory-heading">
            <h2 id="directory-heading" className="section-title">{copy.listHeading}</h2>
            <div className="view-controls">
              <div className="segmented-control sort-segments" role="group" aria-label={t('sort')}>
                {SORT_MODES.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={sort === mode ? 'selected' : undefined}
                    onClick={() => updateFilter('sort', mode)}
                    aria-pressed={sort === mode}
                  >
                    {t(
                      mode === 'stars'
                        ? 'sortStars'
                        : mode === 'npmDownloads7d'
                          ? 'npmRanking'
                          : mode === 'installs'
                            ? 'sortInstalls'
                            : mode === 'newest'
                              ? 'sortNewest'
                              : 'sortActive',
                    )}
                  </button>
                ))}
              </div>
              {refreshing && directoryReady && !showingPluginCache && (
                <span className="refresh-note" role="status">{t('refreshing')}</span>
              )}
            </div>

            {error ? (
              <div className="state-panel" role="alert">
                <AlertCircle size={27} aria-hidden="true" />
                <h3>{t('loadError')}</h3>
                <p>{error}</p>
                <button className="button button-secondary" type="button" onClick={() => setReload((value) => value + 1)}>
                  {t('retry')}
                </button>
              </div>
            ) : !directoryReady ? (
              <LoadingState />
            ) : npmDirectoryPending ? (
              <div className="state-panel">
                <Search size={27} aria-hidden="true" />
                <h3>{t('npmDownloadsPendingTitle')}</h3>
                <p>{t('npmDownloadsPendingBody')}</p>
                <button className="button button-secondary" type="button" onClick={() => updateFilter('sort', 'stars')}>
                  {t('sortStars')}
                </button>
              </div>
            ) : visiblePackages.length === 0 ? (
              <div className="state-panel">
                <Search size={27} aria-hidden="true" />
                <h3>{t('emptyTitle')}</h3>
                <p>{t('emptyBody')}</p>
                <button className="button button-secondary" type="button" onClick={resetFilters}>
                  {t('reset')}
                </button>
              </div>
            ) : (
              <>
                <div className={`package-list${refreshing && !showingPluginCache ? ' is-refreshing' : ''}`} aria-live="polite">
                  {visiblePackages.map((plugin, index) => (
                    <PackageRow
                      key={plugin.id}
                      plugin={plugin}
                      category={categoryMap.get(plugin.category)}
                      index={index}
                      directorySort={sort}
                    />
                  ))}
                </div>
                {hasMorePackages && (
                  <div className="load-more-row">
                    <button
                      className="button button-secondary"
                      type="button"
                      onClick={loadMore}
                      disabled={loadingMore}
                    >
                      {t(loadingMore ? 'loading' : 'loadMore')}
                    </button>
                    <span className="load-more-count">
                      {formatExactNumber(visiblePackages.length, language)}
                      {' / '}
                      {formatExactNumber(directoryTotal, language)}
                    </span>
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {showInstalled && (
          <section className="catalog-section installed-section" aria-labelledby="installed-heading">
            <div className="section-heading compact-heading">
              <h2 id="installed-heading">{t('installedPlugins')}</h2>
              <span>{installedPluginIds?.length ?? '--'}</span>
            </div>
            <InstalledPackages query={query} />
          </section>
        )}
      </div>
    </div>
  )
}
