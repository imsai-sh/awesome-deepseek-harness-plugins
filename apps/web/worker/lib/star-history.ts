import type { CatalogPlugin, StarGrowth } from '../types'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const BASELINE_TOLERANCE_MS = 2 * HOUR_MS
const MIN_PARTIAL_BASELINE_AGE_MS = HOUR_MS
const INSERT_ROWS_PER_STATEMENT = 25
const REPOSITORIES_PER_LOOKUP = 80
const EARLIEST_LOOKUPS_PER_BATCH = 50

const WINDOWS = {
  growth24h: DAY_MS,
  growth7d: 7 * DAY_MS,
  growth30d: 30 * DAY_MS,
} as const

type GrowthField = keyof typeof WINDOWS

interface SnapshotRow {
  repository: string
  bucket_hour: number
  captured_at: number
  star_count: number
}

interface BaselineCandidate {
  distance: number
  capturedAt: number
  stars: number
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let offset = 0; offset < items.length; offset += size) {
    result.push(items.slice(offset, offset + size))
  }
  return result
}

function repositoryKey(plugin: Pick<CatalogPlugin, 'owner' | 'repository'>): string {
  return `${plugin.owner}/${plugin.repository}`.toLocaleLowerCase()
}

export function emptyStarGrowth(): StarGrowth {
  return {
    growth24h: null,
    growth7d: null,
    growth30d: null,
  }
}

export function hourBucket(timestamp: number): number {
  return Math.floor(timestamp / HOUR_MS) * HOUR_MS
}

export async function recordStarSnapshots(
  db: D1Database,
  plugins: CatalogPlugin[],
  capturedAt: number,
): Promise<void> {
  // Star counts are repository facts. Monorepo siblings share one repository
  // key, and SQLite refuses an ON CONFLICT DO UPDATE that touches the same row
  // twice within one statement, so dedupe before building the batch.
  const byRepository = new Map<string, CatalogPlugin>()
  for (const plugin of plugins) {
    if (plugin.stars === null) continue
    const key = repositoryKey(plugin)
    if (!byRepository.has(key)) byRepository.set(key, plugin)
  }
  const tracked = [...byRepository.values()]
  if (tracked.length === 0) return

  const bucketHour = hourBucket(capturedAt)
  const statements = chunks(tracked, INSERT_ROWS_PER_STATEMENT).map((batch) => {
    const placeholders = batch.map(() => '(?, ?, ?, ?)').join(', ')
    const values = batch.flatMap((plugin) => [
      repositoryKey(plugin),
      bucketHour,
      capturedAt,
      plugin.stars as number,
    ])
    return db.prepare(`
      INSERT INTO github_star_snapshots (
        repository,
        bucket_hour,
        captured_at,
        star_count
      ) VALUES ${placeholders}
      ON CONFLICT(repository, bucket_hour) DO UPDATE SET
        captured_at = excluded.captured_at,
        star_count = excluded.star_count
    `).bind(...values)
  })

  await db.batch(statements)
}

async function loadEarliestSnapshots(
  db: D1Database,
  repositories: string[],
): Promise<Map<string, SnapshotRow>> {
  const earliest = new Map<string, SnapshotRow>()
  for (const repositoryBatch of chunks(repositories, EARLIEST_LOOKUPS_PER_BATCH)) {
    const statements = repositoryBatch.map((repository) => db.prepare(`
      SELECT repository, bucket_hour, captured_at, star_count
      FROM github_star_snapshots
      WHERE repository = ?
      ORDER BY bucket_hour ASC
      LIMIT 1
    `).bind(repository))
    const results = await db.batch<SnapshotRow>(statements)
    for (const result of results) {
      const row = result.results?.[0]
      if (row) earliest.set(row.repository.toLocaleLowerCase(), row)
    }
  }
  return earliest
}

// A window falls back to the repository's earliest snapshot only while the
// recorded history is shorter than the window itself; a gap around the target
// inside otherwise-sufficient history stays null instead of overstating the
// window. The baseline must also be at least an hour old so a repository that
// was first snapshotted moments ago does not report a meaningless zero.
function partialBaselineStars(
  first: SnapshotRow | undefined,
  target: number,
  capturedAt: number,
): number | null {
  if (!first) return null
  if (first.captured_at <= target + BASELINE_TOLERANCE_MS) return null
  if (first.captured_at > capturedAt - MIN_PARTIAL_BASELINE_AGE_MS) return null
  return first.star_count
}

export async function loadStarGrowth(
  db: D1Database,
  plugins: CatalogPlugin[],
  capturedAt: number,
): Promise<Map<string, StarGrowth>> {
  const currentStars = new Map(
    plugins
      .filter((plugin) => plugin.stars !== null)
      .map((plugin) => [repositoryKey(plugin), plugin.stars as number]),
  )
  const repositories = [...currentStars.keys()]
  const candidates = new Map<string, Partial<Record<GrowthField, BaselineCandidate>>>()
  const targets = Object.fromEntries(
    Object.entries(WINDOWS).map(([field, duration]) => [field, capturedAt - duration]),
  ) as Record<GrowthField, number>

  for (const repositoryBatch of chunks(repositories, REPOSITORIES_PER_LOOKUP)) {
    const repositoryPlaceholders = repositoryBatch.map(() => '?').join(', ')
    const ranges = Object.values(targets).flatMap((target) => [
      hourBucket(target - BASELINE_TOLERANCE_MS),
      hourBucket(target + BASELINE_TOLERANCE_MS),
    ])
    const result = await db.prepare(`
      SELECT repository, bucket_hour, captured_at, star_count
      FROM github_star_snapshots
      WHERE repository IN (${repositoryPlaceholders})
        AND (
          bucket_hour BETWEEN ? AND ?
          OR bucket_hour BETWEEN ? AND ?
          OR bucket_hour BETWEEN ? AND ?
        )
    `).bind(...repositoryBatch, ...ranges).all<SnapshotRow>()

    for (const row of result.results) {
      const key = row.repository.toLocaleLowerCase()
      if (!currentStars.has(key)) continue
      const repositoryCandidates = candidates.get(key) ?? {}
      for (const field of Object.keys(WINDOWS) as GrowthField[]) {
        const distance = Math.abs(row.captured_at - targets[field])
        const previous = repositoryCandidates[field]
        const isCloser = !previous || distance < previous.distance
        const isNewerTie = previous &&
          distance === previous.distance &&
          row.captured_at > previous.capturedAt
        if (distance <= BASELINE_TOLERANCE_MS && (isCloser || isNewerTie)) {
          repositoryCandidates[field] = {
            distance,
            capturedAt: row.captured_at,
            stars: row.star_count,
          }
        }
      }
      candidates.set(key, repositoryCandidates)
    }
  }

  const needsFallback = repositories.filter((repository) => {
    const repositoryCandidates = candidates.get(repository)
    return (Object.keys(WINDOWS) as GrowthField[]).some(
      (field) => !repositoryCandidates?.[field],
    )
  })
  const earliest = needsFallback.length > 0
    ? await loadEarliestSnapshots(db, needsFallback)
    : new Map<string, SnapshotRow>()

  return new Map(
    repositories.map((repository) => {
      const stars = currentStars.get(repository) as number
      const baseline = candidates.get(repository)
      const first = earliest.get(repository)
      const growthFor = (field: GrowthField): number | null => {
        const exact = baseline?.[field]
        if (exact) return stars - exact.stars
        const partial = partialBaselineStars(first, targets[field], capturedAt)
        return partial === null ? null : stars - partial
      }
      return [repository, {
        growth24h: growthFor('growth24h'),
        growth7d: growthFor('growth7d'),
        growth30d: growthFor('growth30d'),
      }]
    }),
  )
}
