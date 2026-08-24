import {
  CalendarDays,
  ChevronDown,
  Download,
  Layers,
  Star,
  TrendingUp,
} from 'lucide-react'
import { memo, useId, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type { CatalogPlugin, CatalogSort, CategoryResult, RankingMode } from '../lib/api'
import { isSelfPlugin, packagePath, pluginListIdentity, repositoryInstallTarget } from '../lib/api'
import { formatDate, formatNumber } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { ROW_LINK_TARGET } from '../lib/link-target'
import { useEmbedBridge } from '../lib/embedBridge'
import { CategoryTag } from './CategoryTag'
import { OwnerAvatar } from './OwnerAvatar'
import { SplitInstallButton } from './SplitInstallButton'
import { BridgeInstallButton } from './BridgeInstallButton'
import { BridgeUninstallButton } from './BridgeUninstallButton'

interface PackageRowProps {
  plugin: CatalogPlugin
  category?: CategoryResult
  index: number
  ranking?: RankingMode
  directorySort?: CatalogSort
  /** Rendered inside a repository's expanded panel rather than on the board. */
  child?: boolean
  /** The repository blurb, so a child can tell whether it has copy of its own. */
  repositoryDescription?: string
  /** Resolves a category id for the rows rendered inside an expanded panel. */
  categories?: Map<string, CategoryResult>
  /**
   * Every plugin of this row's repository, this one included.
   *
   * Only ranking rows get it, and only boards ranked by a repository-level
   * metric collapse in the first place. Taken from the catalog the page already
   * holds, so an expanded row costs no request.
   */
  repositoryPlugins?: CatalogPlugin[]
  /** Installed-plugins tab: the action column uninstalls instead of installing. */
  uninstallable?: boolean
}

// Memoized so appending a page of rows leaves already-mounted rows untouched.
export const PackageRow = memo(function PackageRow({
  plugin,
  category,
  index,
  ranking,
  directorySort,
  child,
  repositoryDescription,
  categories,
  repositoryPlugins,
  uninstallable,
}: PackageRowProps) {
  const { language, t } = useI18n()
  const { embedded } = useEmbedBridge()
  const location = useLocation()
  const [expanded, setExpanded] = useState(false)
  const panelId = useId()
  const growth = ranking === 'growth24h'
    ? plugin.growth24h
    : ranking === 'growth7d'
      ? plugin.growth7d
      : ranking === 'growth30d'
        ? plugin.growth30d
        : null
  const isGrowthRanking =
    ranking === 'growth24h' || ranking === 'growth7d' || ranking === 'growth30d'
  const isInstallRanking =
    ranking === 'installs' ||
    ranking === 'installs24h' ||
    ranking === 'installs7d' ||
    ranking === 'installs30d'
  const isNpmRanking = ranking === 'npmDownloads7d'
  const showsNpmDownloads = isNpmRanking || (!ranking && directorySort === 'npmDownloads7d')
  const periodInstalls = ranking === 'installs24h'
    ? plugin.installs24h ?? 0
    : ranking === 'installs7d'
      ? plugin.installs7d ?? 0
      : ranking === 'installs30d'
        ? plugin.installs30d ?? 0
        : plugin.installCount ?? 0
  // Only the repository-level boards collapse, so this is zero everywhere else.
  const collapsed = ranking ? (plugin as { repositorySiblings?: number }).repositorySiblings ?? 0 : 0
  const siblings = collapsed > 0 ? repositoryPlugins ?? [] : []
  /**
   * This row is a repository rather than one of its plugins.
   *
   * Every number on it — stars, growth, last push — was fetched per repository
   * and is shared by all of them, so the row can only honestly claim the
   * repository. Which also settles what belongs on it: repository facts once
   * here, plugin facts once per plugin in the panel.
   */
  const isRepository = siblings.length > 1
  const installableRoot = isRepository ? repositoryInstallTarget(siblings) : undefined
  // A child inherits the repository blurb until it earns copy of its own, and
  // repeating one sentence down the whole panel differentiates nothing.
  const ownDescription = child && plugin.description[language] === repositoryDescription
    ? ''
    : plugin.description[language]
  const relevantDate = ranking === 'active'
    ? plugin.pushedAt
    : ranking === 'newest'
      ? plugin.latestReleaseAt ?? plugin.added
      : plugin.pushedAt ?? plugin.added
  const listIdentity = pluginListIdentity(plugin)
  const linkTarget = embedded ? undefined : ROW_LINK_TARGET

  return (
    <article
      className={`package-row${ranking ? ' ranking-row' : ''}${isRepository ? ' is-expandable' : ''}${
        expanded ? ' is-expanded' : ''
      }`}
      // A seat that stands for a whole repository opens that repository rather
      // than one of its plugins, so the stretched row link steps aside (see
      // `.is-expandable .row-link::after` in styles.css) and the row toggles.
      // Anything the reader can actually click keeps doing its own job; the
      // toggle button below is what makes this reachable from the keyboard.
      onClick={isRepository
        ? (event) => {
            if ((event.target as HTMLElement).closest('a, button')) return
            setExpanded((value) => !value)
          }
        : undefined}
    >
      {child ? (
        // Deliberately not the board's zero-padded rank badge: a plugin inside a
        // repository has no rank, and reusing the badge made the panel look like
        // a second leaderboard.
        <span className="row-index is-child" aria-hidden="true">{index + 1}</span>
      ) : (
        <span className={`row-index${index < 3 && ranking ? ' is-leading' : ''}`} aria-label={`${t('rank')} ${index + 1}`}>
          {String(index + 1).padStart(2, '0')}
        </span>
      )}

      {child ? null : <OwnerAvatar owner={plugin.owner} size={36} className="owner-avatar" />}

      <div className="row-identity">
        <div className="row-title-line">
          {/* The plugin name is the link text: a row-wide overlay anchor gave
              every one of ~2,900 catalog links the same boilerplate label. A
              repository row is not a link at all — it opens its panel. */}
          <h3 className="row-title">
            {isRepository ? plugin.repository : (
              <Link
                className="row-link"
                to={packagePath(plugin)}
                target={linkTarget}
                rel={linkTarget ? 'noreferrer' : undefined}
                state={embedded ? {
                  dsh1024ReturnTo: `${location.pathname}${location.search}${location.hash}`,
                } : undefined}
              >
                {listIdentity.displayName}
              </Link>
            )}
          </h3>
          {/* A child says nothing about its owner or repository: both are on the
              repository row directly above it, identically, once. */}
          {child ? null : (
            <span className="row-owner">
              {isRepository ? plugin.owner : listIdentity.sourceLabel}
            </span>
          )}
          {isRepository ? (
            // Stars, growth and activity are repository facts, so this row
            // stands for its whole repository. A bare "+23" told the reader a
            // number but not what it meant or that anything could be done with
            // it, so it is a labelled disclosure control instead.
            <button
              type="button"
              className="row-repo-toggle"
              aria-expanded={expanded}
              aria-controls={panelId}
              aria-label={expanded ? t('repoCollapse') : t('repoExpand')}
              onClick={() => setExpanded((value) => !value)}
            >
              <Layers size={12} aria-hidden="true" />
              {siblings.length} {t('repoPluginCount')}
              <ChevronDown className="row-repo-caret" size={13} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {ownDescription ? <p>{ownDescription}</p> : null}
      </div>

      {isRepository ? <span /> : <CategoryTag category={category} />}

      <div className="row-metrics">
        {showsNpmDownloads ? (
          <span className="install-metric" title={t('npmDownloads7d')}>
            <Download size={14} aria-hidden="true" />
            {formatNumber(plugin.npmDownloads7d ?? 0, language)}
          </span>
        ) : isInstallRanking ? (
          <span className="install-metric" title={t(
            ranking === 'installs24h'
              ? 'installs24h'
              : ranking === 'installs7d'
                ? 'installs7d'
                : ranking === 'installs30d'
                  ? 'installs30d'
                  : 'installOperations',
          )}>
            {ranking === 'installs' ? (
              <Download size={14} aria-hidden="true" />
            ) : (
              <TrendingUp size={14} aria-hidden="true" />
            )}
            {formatNumber(periodInstalls, language)}
          </span>
        ) : isGrowthRanking ? (
          <span className="growth-metric" title={t('starGrowth')}>
            <TrendingUp size={14} aria-hidden="true" />
            {growth === null
              ? '--'
              : `${growth >= 0 ? '+' : ''}${formatNumber(growth, language)}`}
          </span>
        ) : ranking ? (
          <span title={t('stars')}>
            <Star size={14} aria-hidden="true" />
            {plugin.stars === null ? '--' : formatNumber(plugin.stars, language)}
          </span>
        ) : (
          <span className="install-metric" title={t('installOperations')}>
            <Download size={14} aria-hidden="true" />
            {formatNumber(plugin.installCount ?? 0, language)}
          </span>
        )}
        {isGrowthRanking && (
          <span title={t('stars')}>
            <Star size={14} aria-hidden="true" />
            {plugin.stars === null ? '--' : formatNumber(plugin.stars, language)}
          </span>
        )}
        {isInstallRanking && ranking !== 'installs' && (
          <span title={t('installOperations')}>
            <Download size={14} aria-hidden="true" />
            {formatNumber(plugin.installCount ?? 0, language)}
          </span>
        )}
        {/* Stars and the last push are repository facts, printed once on the
            repository row. Repeating them down the panel filled two columns with
            the same number and read as if each plugin had earned it. */}
        {!ranking && !child && (
          <span className="catalog-star-metric" title={t('stars')}>
            <Star size={14} aria-hidden="true" />
            {plugin.stars === null ? '--' : formatNumber(plugin.stars, language)}
          </span>
        )}
        {!isGrowthRanking && !isInstallRanking && !showsNpmDownloads && !child && (
          <span
            className="date-metric"
            title={ranking === 'newest' ? t('latestRelease') : t('lastPush')}
          >
            <CalendarDays size={14} aria-hidden="true" />
            {relevantDate ? formatDate(relevantDate, language) : '--'}
          </span>
        )}
      </div>

      {uninstallable
        // The store's own row keeps the installed state — the local endpoint
        // refuses to uninstall it, so a live trigger would only ever fail.
        // The .split-install wrapper is load-bearing: it lifts the button
        // above the full-row .row-link overlay, or a real pointer click lands
        // on the link and navigates to the detail page instead.
        ? (
          <div className="split-install">
            {isSelfPlugin(plugin)
              ? <BridgeInstallButton pluginId={plugin.id} className="split-install-main bridge-local-install" />
              : <BridgeUninstallButton pluginId={plugin.id} pluginName={listIdentity.displayName} />}
          </div>
        )
        : isRepository
          ? installableRoot === undefined
            // Nothing to copy: this repository publishes only subdirectories, and
            // each of them offers its own command inside the panel.
            ? <span />
            : <SplitInstallButton plugin={installableRoot} />
          : <SplitInstallButton plugin={plugin} />}

      {isRepository ? (
        // Spans every grid column so the panel reads as part of the row rather
        // than as a new entry in the list. The children are plain catalog rows:
        // the reader already knows how to read one, and it is the only rendering
        // that gives them the category, the metrics and the install button.
        <div
          className="row-repo-panel"
          id={panelId}
          hidden={!expanded}
          // A click inside the panel belongs to the plugin it landed on, never
          // to the seat's toggle.
          onClick={(event) => event.stopPropagation()}
        >
          {siblings.map((sibling, position) => (
            <PackageRow
              key={sibling.id}
              plugin={sibling}
              category={categories?.get(sibling.category)}
              index={position}
              categories={categories}
              child
              repositoryDescription={plugin.description[language]}
            />
          ))}
        </div>
      ) : null}
    </article>
  )
})
