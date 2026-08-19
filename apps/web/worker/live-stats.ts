import { DurableObject } from 'cloudflare:workers'
import {
  HEARTBEAT_TIMEOUT_MS,
  partitionConnections,
  type LiveConnection,
} from './lib/live-connections'
import { alarmToSet } from './lib/live-schedule'
import { VISIT_ID_PATTERN } from './lib/visit-id'
import type { LiveStatsPayload } from './types'

const VISIT_DEDUPE_MS = 60 * 60 * 1000
const SWEEP_INTERVAL_MS = HEARTBEAT_TIMEOUT_MS / 3
// A membership change never fans out on its own; it schedules a flush this far
// out and lets any other change in the window ride the same alarm. That caps the
// broadcast rate at one O(N) fan-out per window no matter how many sockets join
// or leave at once — the property that keeps a reconnect storm from turning into
// O(N^2) work on this single object.
const BROADCAST_DEBOUNCE_MS = 2_000

interface ConnectionAttachment {
  visitId: string
  connectedAt: number
}

export class LiveStats extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS counters (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        views INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO counters (id, views) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS recent_visits (
        visit_id TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recent_visits_expiry ON recent_visits (expires_at);
    `)
    // Answered by the runtime without waking this object, and timestamped so the
    // sweep below can tell a live client from one that vanished without a close frame.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  private liveConnections(): Array<LiveConnection<WebSocket>> {
    return this.ctx.getWebSockets().flatMap((socket) => {
      if (socket.readyState !== 1) return []
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null
      const heartbeat = this.ctx.getWebSocketAutoResponseTimestamp(socket)
      return [{
        socket,
        state: {
          visitId: attachment?.visitId ?? '',
          lastSeenAt: heartbeat?.getTime() ?? attachment?.connectedAt ?? 0,
        },
      }]
    })
  }

  private currentStats(): LiveStatsPayload {
    const row = this.ctx.storage.sql.exec<{ views: number }>(
      'SELECT views FROM counters WHERE id = 1',
    ).one()
    // Sockets pending eviction are excluded here too, so a sweep that has not run
    // yet never inflates the number.
    const { online } = partitionConnections(this.liveConnections(), Date.now())
    return {
      type: 'stats',
      views: row.views,
      online,
      updatedAt: new Date().toISOString(),
    }
  }

  private recordVisit(visitId: string): void {
    const inserted = this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO recent_visits (visit_id, expires_at) VALUES (?, ?)',
      visitId,
      Date.now() + VISIT_DEDUPE_MS,
    ).rowsWritten
    if (inserted > 0) {
      this.ctx.storage.sql.exec('UPDATE counters SET views = views + 1 WHERE id = 1')
    }
  }

  private broadcast(): void {
    const message = JSON.stringify(this.currentStats())
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message)
      } catch {
        try {
          socket.close(1011, 'Unable to deliver live stats')
        } catch {
          // The socket is already closed.
        }
      }
    }
  }

  private evictStaleConnections(): number {
    const { stale } = partitionConnections(this.liveConnections(), Date.now())
    for (const socket of stale) {
      try {
        socket.close(1001, 'Heartbeat timeout')
      } catch {
        // The socket is already closed.
      }
    }
    return stale.length
  }

  /** Move the single alarm no later than `target`, never pushing it out. */
  private async ensureAlarmBy(target: number): Promise<void> {
    const at = Math.max(target, Date.now() + 1)
    const next = alarmToSet(await this.ctx.storage.getAlarm(), at)
    if (next !== null) await this.ctx.storage.setAlarm(next)
  }

  /**
   * A membership change asks the next sweep to run soon rather than fanning out
   * itself. Within the debounce window every such request coalesces onto one
   * alarm, so a burst of joins or leaves costs a single broadcast, not one each.
   */
  private async scheduleFlush(): Promise<void> {
    await this.ensureAlarmBy(Date.now() + BROADCAST_DEBOUNCE_MS)
  }

  private async scheduleNextSweep(): Promise<void> {
    const now = Date.now()
    // Connected clients need a regular sweep; an idle object only has to wake up
    // when the next visit dedupe entry expires.
    const next: number | null = this.ctx.getWebSockets().length > 0
      ? now + SWEEP_INTERVAL_MS
      : this.ctx.storage.sql.exec<{ expiresAt: number | null }>(
        'SELECT MIN(expires_at) AS expiresAt FROM recent_visits',
      ).one().expiresAt

    if (next === null) return
    await this.ensureAlarmBy(Math.max(next, now + 1000))
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLocaleLowerCase() !== 'websocket') {
      return Response.json({ error: 'Expected a WebSocket upgrade.' }, { status: 426 })
    }

    const visitId = new URL(request.url).searchParams.get('visit') ?? ''
    if (!VISIT_ID_PATTERN.test(visitId)) {
      return Response.json({ error: 'Invalid visit identifier.' }, { status: 400 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    server.serializeAttachment({ visitId, connectedAt: Date.now() } satisfies ConnectionAttachment)
    this.ctx.acceptWebSocket(server)
    this.recordVisit(visitId)
    // A join used to broadcast to the whole roster before returning the upgrade,
    // so every connect was O(N) and a reconnect storm was O(N^2) on this one
    // object — the shape that overloads it. Now it only schedules the coalesced
    // flush; this newcomer learns the count from that flush like everyone else.
    await this.scheduleFlush()

    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    // 'ping' never reaches here: the auto-response pair answers it without waking
    // this object. 'stats' is the explicit resync a client can ask for.
    if (message === 'stats') socket.send(JSON.stringify(this.currentStats()))
  }

  // Async so the runtime keeps this object awake until the alarm is persisted;
  // a fire-and-forget schedule could be lost to hibernation before it lands.
  async webSocketClose(): Promise<void> {
    // A mass disconnect schedules one flush, not a fan-out per closing socket.
    await this.scheduleFlush()
  }

  async webSocketError(_socket: WebSocket, error: unknown): Promise<void> {
    console.error(
      JSON.stringify({
        message: 'live_stats_websocket_error',
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    await this.scheduleFlush()
  }

  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM recent_visits WHERE expires_at <= ?', Date.now())
    this.evictStaleConnections()
    // The one place the headcount fans out. Joins, leaves and stale evictions all
    // converge here, so a burst costs a single O(N) broadcast per debounce window
    // instead of one per event.
    this.broadcast()
    await this.scheduleNextSweep()
  }
}
