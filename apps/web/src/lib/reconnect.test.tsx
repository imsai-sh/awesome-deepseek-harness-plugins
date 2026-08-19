import { describe, expect, it } from 'vitest'
import { reconnectDelayMs } from './reconnect'

describe('reconnect backoff', () => {
  it('doubles the ceiling each attempt and caps it at 30s', () => {
    // random()=>1 draws the top of the window, i.e. the full ceiling.
    const top = () => 1
    expect(reconnectDelayMs(0, top)).toBe(1_000)
    expect(reconnectDelayMs(1, top)).toBe(2_000)
    expect(reconnectDelayMs(2, top)).toBe(4_000)
    expect(reconnectDelayMs(5, top)).toBe(30_000)
    expect(reconnectDelayMs(20, top)).toBe(30_000)
  })

  it('never returns less than half the ceiling, so retries still back off', () => {
    const bottom = () => 0
    expect(reconnectDelayMs(0, bottom)).toBe(500)
    expect(reconnectDelayMs(5, bottom)).toBe(15_000)
  })

  it('spreads reconnects across the window so a mass drop does not restampede', () => {
    // Same attempt, different random draws must yield different delays; that
    // desynchronisation is the whole point of the jitter.
    const delays = new Set(
      Array.from({ length: 100 }, (_, i) => reconnectDelayMs(4, () => i / 100)),
    )
    expect(delays.size).toBeGreaterThan(50)
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(8_000)
      expect(delay).toBeLessThanOrEqual(16_000)
    }
  })
})
