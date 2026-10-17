// Radar sweep: pure, DOM-free helpers for the sweep-gated display mechanic.
//
// The radar sweep beam rotates around the scope center once every few seconds.
// An aircraft's DISPLAYED blip only refreshes to its current TRUE position when
// the beam passes over that aircraft's true bearing from center; between sweeps
// the blip holds its last-swept position and fades. This module contains only
// the math/state transitions for that behavior, so it is unit-testable under
// Node with no canvas. The authoritative simulation never imports this.

const TWO_PI = Math.PI * 2;

/** Normalize an angle into the [0, 2PI) range. */
export function normalizeAngle(a) {
  let r = a % TWO_PI;
  if (r < 0) r += TWO_PI;
  return r;
}

/**
 * Did the sweep beam cross `bearing` while moving from `prevSweep` to `sweep`
 * this frame? The beam always rotates in the increasing-angle direction, so the
 * swept arc is (prevSweep -> sweep] going forward, which may wrap past 2PI.
 *
 * All three inputs are angles in radians (any real value; they are normalized).
 * Returns true when `bearing` lies within the forward arc swept this frame.
 *
 * Wraparound: when prevSweep is just under 2PI and sweep is just over 0, a
 * bearing near 0 (or near 2PI) is considered crossed.
 *
 * @param {number} sweep current beam angle this frame
 * @param {number} prevSweep beam angle the render layer last observed
 * @param {number} bearing aircraft bearing = atan2(trueY-cy, trueX-cx)
 */
export function sweepCrossed(sweep, prevSweep, bearing) {
  const s0 = normalizeAngle(prevSweep);
  const s1 = normalizeAngle(sweep);
  const b = normalizeAngle(bearing);
  // Forward-swept arc length since last frame (handles wraparound at 2PI).
  const arc = normalizeAngle(s1 - s0);
  if (arc <= 0) return false; // no motion this frame
  // Distance from the arc start to the bearing, forward.
  const toBearing = normalizeAngle(b - s0);
  // Crossed if the bearing sits within (0, arc]. We include the arc endpoint so
  // a bearing exactly reached this frame counts as swept.
  return toBearing > 0 && toBearing <= arc;
}

/**
 * Sweep angular rate (radians/second) for a given radar level. The base rate is
 * one revolution per BASE_PERIOD seconds; each radar-range upgrade speeds the
 * sweep up (more range comes with faster refresh), down to a floor period.
 *
 * @param {number} radarLevel number of radar-range upgrades owned (>= 0)
 */
export const SWEEP_BASE_PERIOD = 4; // seconds per revolution at radarLevel 0
export const SWEEP_PERIOD_PER_LEVEL = 0.5; // seconds shaved per radar level
export const SWEEP_MIN_PERIOD = 2; // never refresh faster than this

export function sweepPeriod(radarLevel = 0) {
  const lvl = Math.max(0, radarLevel | 0);
  return Math.max(SWEEP_MIN_PERIOD, SWEEP_BASE_PERIOD - lvl * SWEEP_PERIOD_PER_LEVEL);
}

export function sweepRate(radarLevel = 0) {
  return TWO_PI / sweepPeriod(radarLevel);
}

/**
 * Pure display-state update for one frame. Given the per-aircraft display state
 * (the Render component's last-swept fields), the current/previous sweep angles,
 * and a list of planes with their TRUE positions/headings, latch the displayed
 * position/heading to the TRUE value for any plane whose bearing the beam just
 * crossed, mark it seen, and reset its swept timestamp. Planes not crossed this
 * frame keep their stale last-swept values; a never-swept plane stays unseen
 * (so the render layer can keep it invisible/dim) until the beam first reaches
 * it, unless `force` is set.
 *
 * Each plane entry: { render, x, y, heading, force? }. `render` is mutated in
 * place (lastSweepX/Y/Heading, lastSweptTime, seen). `force` latches regardless
 * of the sweep (used for selected / emergency aircraft so they never go stale).
 *
 * @param {number} sweep current beam angle
 * @param {number} prevSweep beam angle last frame
 * @param {number} time current sim time (seconds) stamped on a refresh
 * @param {{x:number,y:number}} center radar center
 * @param {Array} planes list described above
 * @returns {number} count of planes refreshed this frame (for testing)
 */
export function updateSweepDisplay(sweep, prevSweep, time, center, planes) {
  let refreshed = 0;
  for (const p of planes) {
    const bearing = Math.atan2(p.y - center.y, p.x - center.x);
    const crossed = p.force || sweepCrossed(sweep, prevSweep, bearing);
    if (crossed) {
      p.render.lastSweepX = p.x;
      p.render.lastSweepY = p.y;
      p.render.lastSweepHeading = p.heading;
      p.render.lastSweptTime = time;
      if (p.render.seen) refreshed += 1;
      p.render.seen = true;
    }
  }
  return refreshed;
}
