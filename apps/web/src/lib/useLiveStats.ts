import { useEffect, useState } from 'react'
import { newVisitId, VISIT_ID_PATTERN } from '../../worker/lib/visit-id'
import { API_ORIGIN, type LiveStats } from './api'
import { reconnectDelayMs } from './reconnect'

interface LiveStatsState {
  stats: LiveStats | null
  connected: boolean
}

const VISIT_STORAGE_KEY = 'dsh.visit-id'

let pageVisitId: string | undefined

/**
 * Kept in localStorage so a reload or a second tab is the same visitor: the
 * worker dedupes both the hourly view counter and the live headcount by this id.
 */
function visitId(): string {
  if (pageVisitId) return pageVisitId

  try {
    const stored = window.localStorage.getItem(VISIT_STORAGE_KEY)
    if (stored && VISIT_ID_PATTERN.test(stored)) {
      pageVisitId = stored
      return pageVisitId
    }
  } catch {
    // Storage can be denied in private browsing; fall back to a per-page identity.
  }

  pageVisitId = newVisitId()
  try {
    window.localStorage.setItem(VISIT_STORAGE_KEY, pageVisitId)
  } catch {
    // Ignore: the identifier still works for the lifetime of this page.
  }
  return pageVisitId
}

function isLiveStats(value: unknown): value is LiveStats {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<LiveStats>
  return (
    candidate.type === 'stats' &&
    typeof candidate.views === 'number' &&
    typeof candidate.online === 'number' &&
    typeof candidate.updatedAt === 'string'
  )
}

export function useLiveStats(): LiveStatsState {
  const [state, setState] = useState<LiveStatsState>({ stats: null, connected: false })

  useEffect(() => {
    let socket: WebSocket | undefined
    let reconnectTimer: number | undefined
    let heartbeatTimer: number | undefined
    let stopped = false
    let attempt = 0

    function connect() {
      const httpOrigin = API_ORIGIN || window.location.origin
      const wsOrigin = httpOrigin.replace(/^http/, 'ws')
      socket = new WebSocket(`${wsOrigin}/api/live?visit=${visitId()}`)
      socket.addEventListener('open', () => {
        attempt = 0
        setState((current) => ({ ...current, connected: true }))
        heartbeatTimer = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send('ping')
        }, 25_000)
      })
      socket.addEventListener('message', (event) => {
        const data = String(event.data)
        if (data === 'pong') return
        try {
          const payload: unknown = JSON.parse(data)
          if (isLiveStats(payload)) setState({ stats: payload, connected: true })
        } catch {
          // Ignore malformed frames and retain the last valid snapshot.
        }
      })
      socket.addEventListener('close', () => {
        if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer)
        setState((current) => ({ ...current, connected: false }))
        if (!stopped) {
          // Jittered so that clients dropped together by one overloaded object do
          // not reconnect in lockstep and immediately re-stampede it.
          reconnectTimer = window.setTimeout(connect, reconnectDelayMs(attempt))
          attempt += 1
        }
      })
      socket.addEventListener('error', () => socket?.close())
    }

    // Leaving the page closes the socket immediately instead of waiting for the
    // worker to time the heartbeat out.
    function handlePageHide() {
      socket?.close(1000, 'Page hidden')
    }

    connect()
    window.addEventListener('pagehide', handlePageHide)
    return () => {
      stopped = true
      window.removeEventListener('pagehide', handlePageHide)
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer)
      socket?.close(1000, 'Page closed')
    }
  }, [])

  return state
}
