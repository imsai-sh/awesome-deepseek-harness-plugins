/**
 * Reconnect backoff with equal jitter. The ceiling doubles each attempt up to a
 * 30s cap; the delay actually used is drawn from the upper half of that window,
 * [ceiling/2, ceiling]. The jitter matters: when the server drops every socket at
 * once (a restart, or an overloaded object shedding load), a fixed backoff makes
 * all clients reconnect in lockstep and immediately re-stampede it. Spreading the
 * reconnects across the window breaks that feedback loop while still backing off.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(30_000, 1_000 * 2 ** attempt)
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}
