/**
 * The live-stats object has a single alarm doing double duty: a periodic sweep
 * and a short debounced flush that fans the headcount out to every socket. Every
 * membership change asks for a flush, so the scheduling rule has to (a) pull the
 * alarm earlier when a flush is due sooner than the pending sweep, and (b) be a
 * no-op when an equally-soon alarm already exists, so a burst of connects and
 * disconnects collapses onto one alarm instead of resetting it on every event.
 *
 * Returns the timestamp to set, or null to leave the current alarm untouched.
 */
export function alarmToSet(current: number | null, target: number): number | null {
  if (current !== null && current <= target) return null
  return target
}
