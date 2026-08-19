import { describe, expect, it } from 'vitest'
import { alarmToSet } from '../worker/lib/live-schedule'

describe('alarm coalescing', () => {
  it('sets the alarm when none is scheduled yet', () => {
    expect(alarmToSet(null, 2_000)).toBe(2_000)
  })

  it('pulls the alarm earlier when the current one fires later', () => {
    // A pending 30s sweep must not delay a 2s flush.
    expect(alarmToSet(30_000, 2_000)).toBe(2_000)
  })

  it('keeps the current alarm when it already fires at or before the target', () => {
    // A burst of membership changes within the debounce window must collapse onto
    // the single alarm already scheduled, not reset it on every event.
    expect(alarmToSet(2_000, 2_000)).toBeNull()
    expect(alarmToSet(1_500, 2_000)).toBeNull()
  })
})
