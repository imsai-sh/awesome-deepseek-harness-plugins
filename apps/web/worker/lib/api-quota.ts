export interface QuotaLimits {
  perMinute: number
  perDay: number
}

export const ANONYMOUS_QUOTA: QuotaLimits = { perMinute: 10, perDay: 50 }
export const AUTHENTICATED_QUOTA: QuotaLimits = { perMinute: 30, perDay: 500 }
// The registry is a full-catalog pull (up to hundreds of KB), so it gets its
// own, looser windows than the small search queries. The counters live in their
// own key namespace (`ip:reg:` / `user:reg:`), kept separate from search so one
// endpoint can never burn the other's quota.
export const REGISTRY_QUOTA: QuotaLimits = { perMinute: 20, perDay: 500 }
export const AUTHENTICATED_REGISTRY_QUOTA: QuotaLimits = { perMinute: 100, perDay: 5000 }

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export interface QuotaDecision {
  allowed: boolean
  dailyLimit: number
  dailyRemaining: number
  reason?: 'minute' | 'day'
  retryAfterSeconds?: number
}

async function incrementCounter(
  db: D1Database,
  counterKey: string,
  windowKind: 'minute' | 'day',
  bucketStart: number,
): Promise<number> {
  const row = await db.prepare(
    `INSERT INTO api_request_counters (counter_key, window_kind, bucket_start, count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(counter_key, window_kind, bucket_start) DO UPDATE SET count = count + 1
     RETURNING count`,
  ).bind(counterKey, windowKind, bucketStart).first<{ count: number | string }>()
  return Number(row?.count ?? 1)
}

async function readDailyCount(db: D1Database, counterKey: string, dayBucket: number): Promise<number> {
  const row = await db.prepare(
    `SELECT count FROM api_request_counters
     WHERE counter_key = ? AND window_kind = 'day' AND bucket_start = ?`,
  ).bind(counterKey, dayBucket).first<{ count: number | string }>()
  return Number(row?.count ?? 0)
}

/**
 * Fixed-window quota check. The minute window is consumed first so a client
 * hammering past the per-minute limit does not burn its daily quota on
 * rejected requests; the daily counter only grows once the minute window
 * admits the request.
 */
export async function consumeQuota(
  db: D1Database,
  counterKey: string,
  limits: QuotaLimits,
  nowMs: number,
): Promise<QuotaDecision> {
  const minuteBucket = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS
  const dayBucket = Math.floor(nowMs / DAY_MS) * DAY_MS

  const minuteCount = await incrementCounter(db, counterKey, 'minute', minuteBucket)
  if (minuteCount > limits.perMinute) {
    const dailyCount = await readDailyCount(db, counterKey, dayBucket)
    return {
      allowed: false,
      reason: 'minute',
      dailyLimit: limits.perDay,
      dailyRemaining: Math.max(0, limits.perDay - dailyCount),
      retryAfterSeconds: Math.max(1, Math.ceil((minuteBucket + MINUTE_MS - nowMs) / 1000)),
    }
  }

  const dailyCount = await incrementCounter(db, counterKey, 'day', dayBucket)
  if (dailyCount > limits.perDay) {
    return {
      allowed: false,
      reason: 'day',
      dailyLimit: limits.perDay,
      dailyRemaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((dayBucket + DAY_MS - nowMs) / 1000)),
    }
  }

  return {
    allowed: true,
    dailyLimit: limits.perDay,
    dailyRemaining: Math.max(0, limits.perDay - dailyCount),
  }
}
