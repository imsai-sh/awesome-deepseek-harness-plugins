import {
  fetchPluginsPage,
  fetchRankings,
  type PluginsPage,
  type PluginsPageParams,
  type RankingsData,
} from './api'

// The directory now arrives a page at a time instead of as one multi-megabyte
// body, so a browse no longer ships the whole catalog to filter it client-side.
// A short-lived module cache keeps re-renders and back-navigation instant
// without turning every one into a request; the edge cache and ETags handle
// anything that does reach the network.
const PAGE_TTL_MS = 5 * 60 * 1000

function pageKey(params: PluginsPageParams): string {
  return [
    params.q ?? '',
    params.category ?? '',
    params.sort ?? 'stars',
    params.page ?? 1,
    params.limit ?? '',
  ].join('|')
}

interface Cached<T> {
  data: T
  fetchedAt: number
}

const pages = new Map<string, Cached<PluginsPage>>()
const pagesInflight = new Map<string, Promise<PluginsPage>>()

export function getCachedPluginsPage(params: PluginsPageParams): PluginsPage | null {
  return pages.get(pageKey(params))?.data ?? null
}

export function loadPluginsPage(
  params: PluginsPageParams,
  options?: { force?: boolean },
): Promise<PluginsPage> {
  const key = pageKey(params)
  const cached = pages.get(key)
  if (!options?.force && cached && Date.now() - cached.fetchedAt < PAGE_TTL_MS) {
    return Promise.resolve(cached.data)
  }
  const existing = pagesInflight.get(key)
  if (existing) return existing
  const request = fetchPluginsPage(params)
    .then((data) => {
      pages.set(key, { data, fetchedAt: Date.now() })
      return data
    })
    .finally(() => {
      pagesInflight.delete(key)
    })
  pagesInflight.set(key, request)
  return request
}

let rankings: Cached<RankingsData> | null = null
let rankingsInflight: Promise<RankingsData> | null = null

export function getCachedRankings(): RankingsData | null {
  return rankings?.data ?? null
}

export function isRankingsFresh(): boolean {
  return rankings !== null && Date.now() - rankings.fetchedAt < PAGE_TTL_MS
}

export function loadRankings(options?: { force?: boolean }): Promise<RankingsData> {
  if (!options?.force && rankings && Date.now() - rankings.fetchedAt < PAGE_TTL_MS) {
    return Promise.resolve(rankings.data)
  }
  rankingsInflight ??= fetchRankings()
    .then((data) => {
      rankings = { data, fetchedAt: Date.now() }
      return data
    })
    .finally(() => {
      rankingsInflight = null
    })
  return rankingsInflight
}
