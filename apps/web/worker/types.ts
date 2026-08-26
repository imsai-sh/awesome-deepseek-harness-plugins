import type { PluginInstallMethod } from './lib/install-methods'

export type Language = 'en' | 'zh'

export interface LocalizedText {
  en: string
  zh: string
}

export interface RegistryCategory {
  en: string
  zh: string
}

export interface RegistryPlugin {
  /**
   * How this plugin can be installed, each with its own verification state.
   * Absent on snapshots written before install verification shipped.
   */
  installMethods?: PluginInstallMethod[]
  /** Full plugin id: `owner/repository[/sub/dir]`, in its submitted case. */
  id: string
  name: string
  owner: string
  url: string
  category: string
  description: LocalizedText
  install: string
  added: string
}

export interface CategoryDescriptor {
  id: string
  order: number
  label: LocalizedText
}

export interface RepositoryMetric {
  stars: number | null
  forks: number | null
  pushedAt: string | null
  updatedAt: string | null
  latestReleaseAt: string | null
}

export interface StarGrowth {
  growth24h: number | null
  growth7d: number | null
  growth30d: number | null
}

export interface InstallMetrics {
  installCount: number
  installerCount: number
  firstInstallCount: number
  reinstallCount: number
  updateCount: number
  removeCount: number
  failureCount: number
  installs24h: number
  installs7d: number
  installs30d: number
  latestInstallAt: string | null
}

export interface NpmDownloadMetrics {
  /** npm registry download events for the reported seven-day window. */
  npmDownloads7d?: number | null
  npmDownloadsStart?: string | null
  npmDownloadsEnd?: string | null
}

export interface CatalogPlugin extends RegistryPlugin, RepositoryMetric, StarGrowth, InstallMetrics, NpmDownloadMetrics {
  /** Repository name only; the in-repo path lives in `id`. */
  repository: string
}

/**
 * Fast, first-party detail payload used to paint a plugin page before any
 * GitHub request starts. The category id from the snapshot is resolved to the
 * descriptor the detail UI needs; everything else comes directly from KV.
 */
export type PackageSummary = Omit<CatalogPlugin, 'category'> & {
  category: CategoryDescriptor | null
}

export interface StoredCatalogSnapshot {
  generatedAt: string
  registryUpdated: string
  registryRevision: string
  metricCoverage: number
  categories: Record<string, RegistryCategory>
  plugins: CatalogPlugin[]
}

export type CatalogSource = 'd1' | 'kv' | 'stale' | 'empty'

export interface CatalogSnapshotResult {
  snapshot: StoredCatalogSnapshot
  source: CatalogSource
}

export interface CategoryResult extends RegistryCategory {
  id: string
  count: number
}

export type CatalogSort =
  | 'stars'
  | 'installs'
  | 'installs24h'
  | 'installs7d'
  | 'installs30d'
  | 'npmDownloads7d'
  | 'growth24h'
  | 'growth7d'
  | 'growth30d'
  | 'newest'
  | 'active'
  | 'name'

/**
 * A ranking row.
 *
 * `repositorySiblings` is how many further plugins of the same repository this
 * board had to leave out. It is zero on the install boards, which are ranked by
 * a per-plugin metric and therefore never collapsed.
 */
export interface RankedPlugin extends CatalogPlugin {
  repositorySiblings: number
}

export interface RankingBoards {
  stars: RankedPlugin[]
  installs: RankedPlugin[]
  installs24h: RankedPlugin[]
  installs7d: RankedPlugin[]
  installs30d: RankedPlugin[]
  growth24h: RankedPlugin[]
  growth7d: RankedPlugin[]
  growth30d: RankedPlugin[]
  newest: RankedPlugin[]
  active: RankedPlugin[]
}

export interface RankingBoardsV3 extends RankingBoards {
  npmDownloads7d: RankedPlugin[]
}

export interface CatalogResponse {
  packages: CatalogPlugin[]
  rankings: RankingBoards
  categories: CategoryResult[]
  meta: {
    total: number
    catalogTotal: number
    updated: string
    generatedAt: string
    revision: string
    source: CatalogSource
    metricCoverage: number
  }
}

/**
 * One page of the directory, for the main site's own `/api/v2/plugins`. Unlike
 * the frozen `/api/v1/plugins`, this returns a slice rather than the whole
 * catalog, so a browse never ships the multi-megabyte body that made slow
 * connections give up mid-download. `categories` carries whole-catalog counts
 * (not just this page's), because the sidebar shows the full tally.
 */
export interface PluginsPageResponse {
  plugins: CatalogPlugin[]
  page: number
  limit: number
  /** Matches for the current query — the denominator of "showing N of M". */
  total: number
  totalPages: number
  /** Every plugin in the catalog, unfiltered — the hero and sidebar tally. */
  catalogTotal: number
  categories: CategoryResult[]
  generatedAt: string
  source: CatalogSource
}

/**
 * The ten leaderboards, for `/api/v2/rankings`. A repository-collapsed seat
 * needs its siblings to render the expand-in-place row the site already shows;
 * with the full catalog no longer client-side, they travel here instead, keyed
 * by `owner/repository` (lowercased) so the client can look each seat up
 * exactly as it did when it grouped the whole catalog itself.
 */
export interface RankingsResponse {
  rankings: RankingBoards
  siblingsByRepository: Record<string, CatalogPlugin[]>
  catalogTotal: number
  categories: CategoryResult[]
  generatedAt: string
  source: CatalogSource
}

/** Adds npm's independently measured seven-day downloads without changing v2. */
export interface RankingsResponseV3 extends Omit<RankingsResponse, 'rankings'> {
  rankings: RankingBoardsV3
}

export interface RegistryProjectionPlugin {
  id: string
  name: string
  owner: string
  url: string
  category: string
  description: LocalizedText
  install: string
  /** Validated package spec consumed by the in-DSH installer. */
  target: string
  /** pnpm build grant for a git prepare script. */
  allowBuild: string | null
  added: string
  stars: number | null
}

export interface RegistryProjection {
  name: string
  updated: string
  /** Number of entries in `plugins` — the frozen contract ties them together. */
  count: number
  /** Full catalog size, additive: pre-cap clients ignore it. */
  total: number
  categories: CategoryDescriptor[]
  plugins: RegistryProjectionPlugin[]
}

export interface PackageManifestSummary {
  name: string | null
  version: string | null
  license: string | null
  bundlePatch: string | null
  dependencies: number
  peerDependencies: number
  engines: Record<string, string> | null
}

export interface GitHubSummary {
  stars: number
  forks: number
  openIssues: number
  defaultBranch: string
  updatedAt: string
  pushedAt: string
  license: string | null
  homepage: string | null
  avatarUrl: string
}

export interface PackageDetail extends RegistryPlugin, InstallMetrics {
  github: GitHubSummary | null
  manifest: PackageManifestSummary | null
  readme: string | null
  /**
   * Directory the README was read from, relative to the repository root
   * (`''` for the root). A subpackage without its own README falls back to the
   * root one, and its relative links must then resolve against the root.
   */
  readmeBasePath: string
  verification: {
    repositoryReachable: boolean
    bundleDeclared: boolean
  }
}

export interface LiveStatsPayload {
  type: 'stats'
  views: number
  online: number
  updatedAt: string
}

export interface BackgroundContext {
  waitUntil(promise: Promise<unknown>): void
}
