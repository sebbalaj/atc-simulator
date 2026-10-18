// Weather: pure, DOM-free decision logic and geometry for the three weather
// hazards (wind shifts, drifting thunderstorm cells, fog). Rendering of storms /
// fog / the wind arrow lives in the HUD/render system; everything here is plain
// math + state so it can be unit-tested under Node.
//
//   WIND SHIFT  - flips the active approach direction so a runway that used to
//                 accept an approach from one end now accepts the opposite end.
//                 landingSystem consults isApproachDirectionValid() to decide
//                 whether a resolved landing direction is currently legal.
//   THUNDERSTORM- opaque circular cells with a position, radius and drift
//                 velocity. Each tick the cell drifts; a plane whose position
//                 (or drawn route) intersects a cell is destroyed / loses nav.
//   FOG         - a visibility factor (0..1). The render system fades aircraft
//                 that are farther than the fog visibility range from the field,
//                 unless the ILS upgrade is owned (fogVisibilityRange reads an
//                 ILS-owned flag, default false until FEAT-005 sets it).

import { normalizeAngle, angleDifference } from "./airport.js";

// --- Wind -----------------------------------------------------------------

/**
 * Whether a resolved landing direction is valid for the current wind. Aircraft
 * must land into the wind, so the legal approach direction is the one pointing
 * OPPOSITE the wind's "blowing toward" heading, within a tolerance. A wind shift
 * rotates `windDirection` so the previously-correct end becomes invalid and the
 * opposite end becomes valid.
 *
 * `windDirection` is the compass heading the wind is blowing TOWARD (radians).
 * A plane lands into the wind, i.e. its travel heading should oppose the wind,
 * so a landing direction `landingHeading` is valid when it is roughly opposite
 * the wind direction. Pure function.
 *
 * @param {number} landingHeading the direction the aircraft travels on rollout
 * @param {number} windDirection direction the wind blows toward (radians)
 * @param {number} [tolerance] half-angle of the acceptable window (radians)
 * @returns {boolean}
 */
export function isApproachDirectionValid(landingHeading, windDirection, tolerance = Math.PI / 2) {
  // Landing into the wind: ideal landing heading is opposite the wind.
  const ideal = normalizeAngle(windDirection + Math.PI);
  return angleDifference(landingHeading, ideal) <= tolerance;
}

/**
 * The currently-legal LANDING DIRECTIONS (travel headings on rollout) for a
 * runway under a wind state. At steady state exactly ONE of a runway's two ends
 * is into the wind and therefore legal. During a wind-shift transition window
 * BOTH the end that is into the CURRENT wind and the end that was into the
 * PREVIOUS wind are legal, so the player can keep routing to the old end while
 * the shift settles.
 *
 * The runway is bidirectional: its two candidate landing headings are
 * `runway.heading` and its reciprocal. A heading is legal when it is into the
 * current wind (isApproachDirectionValid vs windDirection) OR, during an active
 * transition, into the previous wind (vs windPrevDirection).
 *
 * Pure function. `windState` is a plain snapshot:
 *   { windDirection, windTolerance?, transition?: { active, fromDirection } }
 * `fromDirection` is the PREVIOUS wind direction (blowing-toward heading).
 *
 * @param {object} runway runway with a base `heading`
 * @param {object} windState wind snapshot
 * @returns {number[]} normalized legal landing headings (0, 1 or 2 entries)
 */
export function activeLandingDirections(runway, windState) {
  if (!runway || !windState || windState.windDirection == null) return [];
  const tol = windState.windTolerance ?? WEATHER_DEFAULTS.windTolerance;
  const transition = windState.transition;
  const prevDir =
    transition && transition.active && transition.fromDirection != null
      ? transition.fromDirection
      : null;
  const ends = [normalizeAngle(runway.heading), normalizeAngle(runway.heading + Math.PI)];
  const out = [];
  for (const dir of ends) {
    const intoCurrent = isApproachDirectionValid(dir, windState.windDirection, tol);
    const intoPrev = prevDir != null && isApproachDirectionValid(dir, prevDir, tol);
    if (intoCurrent || intoPrev) out.push(dir);
  }
  return out;
}

/**
 * Whether a resolved landing direction is legal for a runway under a wind state,
 * accounting for the transition window (legal if into the current wind OR, during
 * a transition, into the previous wind). Thin wrapper over
 * activeLandingDirections using an angular match. Pure function.
 *
 * @param {number} landingHeading travel heading on rollout
 * @param {object} windState wind snapshot (see activeLandingDirections)
 * @param {number} [tol] half-angle window (defaults to windState.windTolerance)
 */
export function isLandingDirectionLegal(landingHeading, windState, tol) {
  if (landingHeading == null || !windState || windState.windDirection == null) return true;
  const tolerance = tol ?? windState.windTolerance ?? WEATHER_DEFAULTS.windTolerance;
  if (isApproachDirectionValid(landingHeading, windState.windDirection, tolerance)) return true;
  const transition = windState.transition;
  if (transition && transition.active && transition.fromDirection != null) {
    if (isApproachDirectionValid(landingHeading, transition.fromDirection, tolerance)) return true;
  }
  return false;
}

// --- Thunderstorm cells ----------------------------------------------------

/**
 * Create a storm cell. Position/velocity in world px (px, px/s), radius in px.
 */
export function createStormCell(opts = {}) {
  return {
    id: opts.id ?? 0,
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    vx: opts.vx ?? 0,
    vy: opts.vy ?? 0,
    radius: opts.radius ?? 60,
    life: opts.life ?? Infinity, // seconds remaining before the cell dissipates
  };
}

/**
 * Advance a storm cell by dt seconds, drifting it along its velocity and
 * decrementing its life. Mutates and returns the cell. Pure (deterministic for
 * fixed inputs).
 */
export function driftStorm(cell, dt) {
  cell.x += cell.vx * dt;
  cell.y += cell.vy * dt;
  if (Number.isFinite(cell.life)) cell.life -= dt;
  return cell;
}

/** Whether a point lies inside a storm cell (circle test). Pure function. */
export function isPointInStorm(cell, x, y) {
  return Math.hypot(x - cell.x, y - cell.y) <= cell.radius;
}

/**
 * Whether any point is inside any of the storm cells. Convenience for an
 * aircraft position vs a list of cells. Pure function.
 */
export function pointInAnyStorm(cells, x, y) {
  for (const cell of cells) {
    if (isPointInStorm(cell, x, y)) return cell;
  }
  return null;
}

/**
 * Whether a polyline path crosses a storm cell. Tests each segment against the
 * circle (closest-point-on-segment distance <= radius). `points` is an array of
 * {x,y}. Pure function. Returns true on the first segment that intersects.
 */
export function pathCrossesStorm(cell, points) {
  if (!points || points.length === 0) return false;
  if (points.length === 1) return isPointInStorm(cell, points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    if (segmentIntersectsCircle(points[i - 1], points[i], cell)) return true;
  }
  return false;
}

/** Whether a segment a->b comes within `cell.radius` of the cell center. Pure. */
export function segmentIntersectsCircle(a, b, cell) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = ((cell.x - a.x) * dx + (cell.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = a.x + dx * t;
  const cy = a.y + dy * t;
  return Math.hypot(cell.x - cx, cell.y - cy) <= cell.radius;
}

// --- Fog -------------------------------------------------------------------

/**
 * The visibility range (px) at a given fog intensity. 0 intensity = full
 * visibility (a large range); as intensity rises the range shrinks so planes
 * only draw when close. When ILS is owned the controller keeps full visibility
 * regardless of fog. Pure function.
 *
 * @param {number} intensity fog intensity 0..1
 * @param {number} fullRange the no-fog visibility range (px), e.g. radar size
 * @param {boolean} ilsOwned whether the ILS upgrade is owned (FEAT-005 flag)
 */
export function fogVisibilityRange(intensity, fullRange, ilsOwned = false) {
  if (ilsOwned) return fullRange;
  const i = Math.max(0, Math.min(1, intensity));
  // At full fog, visibility collapses to ~22% of the range.
  const minFactor = 0.22;
  const factor = 1 - (1 - minFactor) * i;
  return fullRange * factor;
}

/**
 * The render alpha for an aircraft at `distance` from the field center given the
 * current fog visibility range. Planes within the range are fully visible; they
 * fade out over a short band beyond it. Pure function (used by renderSystem).
 */
export function fogAlphaForDistance(distance, visibilityRange) {
  if (distance <= visibilityRange) return 1;
  const fade = Math.max(1, visibilityRange * 0.25);
  const over = distance - visibilityRange;
  return Math.max(0, 1 - over / fade);
}

// --- Controller ------------------------------------------------------------

/** Default tuning for the weather controller. */
export const WEATHER_DEFAULTS = Object.freeze({
  windShiftMinInterval: 35, // seconds between possible wind shifts
  windShiftMaxInterval: 70,
  stormMinInterval: 40, // seconds between storm spawns
  stormMaxInterval: 80,
  maxStorms: 3,
  stormRadius: [46, 78],
  stormSpeed: [10, 26], // px/s drift
  stormLife: [45, 90], // seconds a cell lives
  fogMinInterval: 55,
  fogMaxInterval: 110,
  fogDuration: [25, 50],
  windTolerance: Math.PI / 2,
  // Length (s of sim time) of the transition window opened on a wind shift,
  // during which BOTH the old and new into-wind ends remain routable so the
  // player can adapt before the old end becomes illegal.
  windTransitionSeconds: 8,
});

/**
 * Create a WeatherController. It owns the mutable weather state (wind direction,
 * active storm cells, fog intensity) and schedules changes using the seeded RNG
 * so a shift is reproducible. The ECS weatherSystem calls update() each tick and
 * reads the resulting state; emitting HUD banners is the system's job.
 *
 * Pure in the sense that it touches no DOM; it does read wall-less sim time and
 * the RNG passed in. `map` supplies the field center and bounds for spawning.
 *
 * @param {object} opts { rng, map, config? }
 */
export function createWeatherController(opts = {}) {
  const rng = opts.rng;
  const map = opts.map;
  const cfg = { ...WEATHER_DEFAULTS, ...(opts.config || {}) };

  const state = {
    // Wind blows toward this heading. Default so runway A's primary direction
    // (heading 0, landing toward +x) is valid: wind blowing toward -x (west).
    windDirection: Math.PI,
    windTolerance: cfg.windTolerance,
    // Wind-shift transition window. When a shift occurs we record the previous
    // wind direction and open a timer; while the timer is active BOTH the old
    // and new into-wind ends are routable. After it elapses only the new end is.
    windPrevDirection: null,
    windTransition: { active: false, fromDirection: null, toDirection: null, remaining: 0 },
    storms: [],
    fogIntensity: 0,
    _nextStormId: 1,
  };

  // Schedule timers (seconds of sim time until the next event of each type).
  let windTimer = randRange(cfg.windShiftMinInterval, cfg.windShiftMaxInterval);
  let stormTimer = randRange(cfg.stormMinInterval, cfg.stormMaxInterval);
  let fogTimer = randRange(cfg.fogMinInterval, cfg.fogMaxInterval);
  let fogActiveFor = 0; // remaining seconds of the current fog episode

  function randRange(a, b) {
    return rng ? rng.range(a, b) : (a + b) / 2;
  }

  /**
   * Rotate the wind so the opposite approach becomes the valid one, and OPEN a
   * transition window during which BOTH the old and new into-wind ends stay
   * routable. The previous wind direction is recorded so landing legality and
   * the direction indicator can treat both ends as active until the window
   * closes.
   */
  function shiftWind() {
    // Flip ~180 degrees with a little scatter so it reads as a real crosswind
    // reversal but stays within the new opposite window.
    const jitter = rng ? rng.range(-0.3, 0.3) : 0;
    const prev = state.windDirection;
    state.windDirection = normalizeAngle(state.windDirection + Math.PI + jitter);
    state.windPrevDirection = prev;
    state.windTransition = {
      active: true,
      fromDirection: prev,
      toDirection: state.windDirection,
      remaining: cfg.windTransitionSeconds,
    };
    return state.windDirection;
  }

  /** Current wind snapshot shape consumed by the pure direction helpers. */
  function windStateSnapshot() {
    return {
      windDirection: state.windDirection,
      windTolerance: state.windTolerance,
      transition: {
        active: state.windTransition.active,
        fromDirection: state.windTransition.fromDirection,
        toDirection: state.windTransition.toDirection,
        remaining: state.windTransition.remaining,
      },
    };
  }

  /** Spawn a storm cell drifting across the field from a random edge. */
  function spawnStorm() {
    const w = map ? map.width : 400;
    const h = map ? map.height : 600;
    const cx = map ? map.center.x : w / 2;
    const cy = map ? map.center.y : h / 2;
    // Start just off one edge and drift toward/across the field.
    const edge = rng ? rng.rangeInt(0, 3) : 0;
    const radius = randRange(cfg.stormRadius[0], cfg.stormRadius[1]);
    let x;
    let y;
    if (edge === 0) { x = -radius; y = randRange(0, h); }
    else if (edge === 1) { x = w + radius; y = randRange(0, h); }
    else if (edge === 2) { x = randRange(0, w); y = -radius; }
    else { x = randRange(0, w); y = h + radius; }
    // Drift roughly toward the field center with scatter.
    const toCenter = Math.atan2(cy - y, cx - x) + (rng ? rng.range(-0.5, 0.5) : 0);
    const speed = randRange(cfg.stormSpeed[0], cfg.stormSpeed[1]);
    const cell = createStormCell({
      id: state._nextStormId++,
      x,
      y,
      vx: Math.cos(toCenter) * speed,
      vy: Math.sin(toCenter) * speed,
      radius,
      life: randRange(cfg.stormLife[0], cfg.stormLife[1]),
    });
    state.storms.push(cell);
    return cell;
  }

  /**
   * Advance weather by dt. Returns a list of event objects that occurred this
   * tick, e.g. [{type:'wind'}, {type:'storm', cell}, {type:'fog', on:true}].
   * The caller (weatherSystem) turns these into HUD banners / EventBus emits.
   */
  function update(dt) {
    const events = [];

    // Drift existing storms and retire expired / far-gone ones.
    const bounds = map ? Math.max(map.width, map.height) : 600;
    for (const cell of state.storms) driftStorm(cell, dt);
    state.storms = state.storms.filter((c) => {
      if (Number.isFinite(c.life) && c.life <= 0) return false;
      // Drop cells that have drifted well off the field.
      const cx = map ? map.center.x : 200;
      const cy = map ? map.center.y : 300;
      if (Math.hypot(c.x - cx, c.y - cy) > bounds * 1.2 + c.radius) return false;
      return true;
    });

    // Wind shift schedule.
    windTimer -= dt;
    if (windTimer <= 0) {
      windTimer = randRange(cfg.windShiftMinInterval, cfg.windShiftMaxInterval);
      shiftWind();
      events.push({
        type: "wind",
        windDirection: state.windDirection,
        transition: true,
        fromDirection: state.windTransition.fromDirection,
      });
    }

    // Advance the transition window; close it (only the new end stays legal)
    // when the timer elapses.
    if (state.windTransition.active) {
      state.windTransition.remaining -= dt;
      if (state.windTransition.remaining <= 0) {
        state.windTransition.active = false;
        state.windTransition.remaining = 0;
        state.windTransition.fromDirection = null;
        state.windPrevDirection = null;
        events.push({ type: "windTransitionEnd", windDirection: state.windDirection });
      }
    }

    // Storm spawn schedule (respect the cap).
    stormTimer -= dt;
    if (stormTimer <= 0) {
      stormTimer = randRange(cfg.stormMinInterval, cfg.stormMaxInterval);
      if (state.storms.length < cfg.maxStorms) {
        const cell = spawnStorm();
        events.push({ type: "storm", cell });
      }
    }

    // Fog schedule: toggle an episode on/off.
    if (fogActiveFor > 0) {
      fogActiveFor -= dt;
      // Ramp intensity up to 1 quickly, hold, then let it clear when the timer
      // runs out.
      state.fogIntensity = Math.min(1, state.fogIntensity + dt * 0.5);
      if (fogActiveFor <= 0) {
        state.fogIntensity = 0;
        fogTimer = randRange(cfg.fogMinInterval, cfg.fogMaxInterval);
        events.push({ type: "fog", on: false });
      }
    } else {
      fogTimer -= dt;
      if (fogTimer <= 0) {
        fogActiveFor = randRange(cfg.fogDuration[0], cfg.fogDuration[1]);
        state.fogIntensity = 0.05;
        events.push({ type: "fog", on: true });
      }
    }

    return events;
  }

  return {
    state,
    update,
    // Expose the schedulers for tests / manual triggering.
    shiftWind,
    spawnStorm,
    windStateSnapshot,
    get storms() {
      return state.storms;
    },
    get windDirection() {
      return state.windDirection;
    },
    get windTransition() {
      return state.windTransition;
    },
    get fogIntensity() {
      return state.fogIntensity;
    },
  };
}
