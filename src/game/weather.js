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
//   FOG         - a MOVING REGION (a drifting "bank") that conceals only the
//                 part of the scope it covers. A plane inside the bank is hidden
//                 on radar (shows a '?' at its last-known position) unless it is
//                 ILS-equipped or the player has selected/communicated with it.
//                 Concealment is DISPLAY-ONLY; the sim runs on true positions.

import { normalizeAngle, angleDifference } from "./airport.js";

// --- Wind -----------------------------------------------------------------

/**
 * Read the wind-shift transition descriptor off a wind snapshot, accepting
 * EITHER canonical field name. Pure-helper unit tests and the render snapshot
 * use `transition`; the live `game.weather` object published by weatherSystem
 * uses `windTransition`. Both gameplay call sites (snapToLanding, windAllows)
 * hand `game.weather` straight through, so the helpers must understand both
 * shapes or the transition window silently never fires in-game. Returns the
 * descriptor ({ active, fromDirection, ... }) or null.
 */
function readTransition(windState) {
  if (!windState) return null;
  return windState.transition ?? windState.windTransition ?? null;
}

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
 *   { windDirection, windTolerance?, transition?|windTransition?: { active, fromDirection } }
 * The transition descriptor may be named `transition` (pure-helper tests / the
 * render snapshot) OR `windTransition` (the live game.weather object); both are
 * accepted. `fromDirection` is the PREVIOUS wind direction (blowing-toward).
 *
 * @param {object} runway runway with a base `heading`
 * @param {object} windState wind snapshot
 * @returns {number[]} normalized legal landing headings (0, 1 or 2 entries)
 */
export function activeLandingDirections(runway, windState) {
  if (!runway || !windState || windState.windDirection == null) return [];
  const tol = windState.windTolerance ?? WEATHER_DEFAULTS.windTolerance;
  const transition = readTransition(windState);
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
  const transition = readTransition(windState);
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

// --- Fog (moving region / "bank") ------------------------------------------
//
// Fog is now a MOVING REGION rather than a global visibility shrink. A fog bank
// is a rounded-rectangle area (half-extents hx/hy, with a corner radius) that
// drifts across the field along a velocity. It conceals ONLY the part of the
// scope it covers: a plane inside the bank is hidden on radar (shows a '?' at
// its last-known position) unless it is ILS-equipped or the player has selected
// (is communicating with) it. Concealment is DISPLAY-ONLY; the sim always runs
// on true positions. All the geometry/decision logic here is pure so it can be
// unit-tested under Node.

/**
 * Create a fog bank. A rounded-rect region with a center (x,y), half-extents
 * (hx,hy) and a drift velocity (vx,vy) in px / px per second. `radius` rounds
 * the corners (clamped to the smaller half-extent). A bank can be LARGE (cover
 * a big part of the map). Pure factory.
 */
export function createFogBank(opts = {}) {
  const hx = opts.hx ?? 120;
  const hy = opts.hy ?? 120;
  return {
    id: opts.id ?? 0,
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    hx,
    hy,
    vx: opts.vx ?? 0,
    vy: opts.vy ?? 0,
    radius: Math.max(0, Math.min(opts.radius ?? Math.min(hx, hy) * 0.5, Math.min(hx, hy))),
    life: opts.life ?? Infinity, // seconds remaining before the bank clears
  };
}

/**
 * Advance a fog bank by dt seconds, drifting it along its velocity and
 * decrementing its life. Mutates and returns the bank. Pure (deterministic for
 * fixed inputs).
 */
export function driftFogBank(bank, dt) {
  bank.x += bank.vx * dt;
  bank.y += bank.vy * dt;
  if (Number.isFinite(bank.life)) bank.life -= dt;
  return bank;
}

/**
 * Whether a point lies inside a fog bank (rounded-rectangle test). Pure.
 * The rounded-rect is the Minkowski sum of an inner rectangle (half-extents
 * hx-r, hy-r) and a disc of radius r, so the test is: clamp the point to the
 * inner rectangle, then check the distance to that clamp is <= r.
 */
export function isPointInFog(bank, x, y) {
  if (!bank) return false;
  const r = bank.radius || 0;
  const ix = Math.max(0, bank.hx - r);
  const iy = Math.max(0, bank.hy - r);
  let dx = Math.abs(x - bank.x) - ix;
  let dy = Math.abs(y - bank.y) - iy;
  if (dx <= 0 && dy <= 0) return true; // inside the inner rectangle
  dx = Math.max(dx, 0);
  dy = Math.max(dy, 0);
  return Math.hypot(dx, dy) <= r;
}

/** Whether a point lies inside ANY of a list of fog banks. Pure. */
export function pointInAnyFog(banks, x, y) {
  if (!banks) return null;
  for (const bank of banks) {
    if (isPointInFog(bank, x, y)) return bank;
  }
  return null;
}

/**
 * The authoritative CONCEALMENT decision for a single plane against the fog
 * region(s). A plane is concealed (hidden, shows a '?') when it is inside a fog
 * bank AND it is neither ILS-equipped NOR the selected/communicating plane.
 * ILS ownership or selection grants full visibility through fog. Pure function
 * so the hide/override logic is unit-testable independent of the renderer.
 *
 * @param {object|Array} banks a single bank or a list of banks
 * @param {number} x point x (the plane's displayed/last-known position)
 * @param {number} y point y
 * @param {object} [flags] { selected?:boolean, ilsOwned?:boolean }
 * @returns {boolean} true => CONCEAL (hide + show '?'), false => visible
 */
export function fogConceals(banks, x, y, flags = {}) {
  if (flags.selected || flags.ilsOwned) return false;
  const list = Array.isArray(banks) ? banks : banks ? [banks] : [];
  if (list.length === 0) return false;
  return pointInAnyFog(list, x, y) != null;
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
  // Moving fog bank tuning. The bank is a large rounded-rect that drifts across
  // the field from an edge. Half-extents are a FRACTION of the field size so a
  // bank can conceal a large part of the map; speed is px/s drift.
  fogBankHalfSpan: [0.32, 0.5], // half-extent as a fraction of field width/height
  fogBankSpeed: [8, 20], // px/s drift
  windTolerance: Math.PI / 2,
  // Length (s of sim time) of the transition window opened on a wind shift,
  // during which BOTH the old and new into-wind ends remain routable so the
  // player can adapt before the old end becomes illegal.
  windTransitionSeconds: 8,
});

/**
 * Create a WeatherController. It owns the mutable weather state (wind direction,
 * active storm cells, drifting fog banks) and schedules changes using the seeded RNG
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
    // Active fog banks (moving regions). Empty when no fog episode is running.
    fogBanks: [],
    _nextStormId: 1,
    _nextFogId: 1,
  };

  // Schedule timers (seconds of sim time until the next event of each type).
  let windTimer = randRange(cfg.windShiftMinInterval, cfg.windShiftMaxInterval);
  let stormTimer = randRange(cfg.stormMinInterval, cfg.stormMaxInterval);
  let fogTimer = randRange(cfg.fogMinInterval, cfg.fogMaxInterval);

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
   * Spawn a fog bank drifting across the field from a random edge. The bank is
   * a large rounded-rect (half-extents a fraction of the field) that enters from
   * just off one edge and drifts toward/across the field, concealing the part of
   * the scope it covers until it clears (life) or drifts well off the field.
   */
  function spawnFogBank() {
    const w = map ? map.width : 400;
    const h = map ? map.height : 600;
    const cx = map ? map.center.x : w / 2;
    const cy = map ? map.center.y : h / 2;
    const hx = randRange(cfg.fogBankHalfSpan[0], cfg.fogBankHalfSpan[1]) * w;
    const hy = randRange(cfg.fogBankHalfSpan[0], cfg.fogBankHalfSpan[1]) * h;
    const edge = rng ? rng.rangeInt(0, 3) : 0;
    let x;
    let y;
    if (edge === 0) { x = -hx; y = randRange(0, h); }
    else if (edge === 1) { x = w + hx; y = randRange(0, h); }
    else if (edge === 2) { x = randRange(0, w); y = -hy; }
    else { x = randRange(0, w); y = h + hy; }
    const toCenter = Math.atan2(cy - y, cx - x) + (rng ? rng.range(-0.4, 0.4) : 0);
    const speed = randRange(cfg.fogBankSpeed[0], cfg.fogBankSpeed[1]);
    const bank = createFogBank({
      id: state._nextFogId++,
      x,
      y,
      hx,
      hy,
      vx: Math.cos(toCenter) * speed,
      vy: Math.sin(toCenter) * speed,
      radius: Math.min(hx, hy) * 0.4,
      life: randRange(cfg.fogDuration[0], cfg.fogDuration[1]),
    });
    state.fogBanks.push(bank);
    return bank;
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

    // Fog schedule: a fog episode SPAWNS a drifting bank from an edge rather
    // than ramping a global intensity. Banks drift + retire below; when none
    // remain the episode is considered over and the next-spawn timer rearms.
    const fogBounds = map ? Math.max(map.width, map.height) : 600;
    for (const bank of state.fogBanks) driftFogBank(bank, dt);
    const fogCountBefore = state.fogBanks.length;
    state.fogBanks = state.fogBanks.filter((b) => {
      if (Number.isFinite(b.life) && b.life <= 0) return false;
      const bcx = map ? map.center.x : 200;
      const bcy = map ? map.center.y : 300;
      // Retire a bank once it has fully drifted off the field.
      if (Math.hypot(b.x - bcx, b.y - bcy) > fogBounds * 1.2 + Math.max(b.hx, b.hy)) {
        return false;
      }
      return true;
    });
    if (fogCountBefore > 0 && state.fogBanks.length === 0) {
      // The last bank cleared: episode over, rearm the spawn timer.
      fogTimer = randRange(cfg.fogMinInterval, cfg.fogMaxInterval);
      events.push({ type: "fog", on: false });
    }

    if (state.fogBanks.length === 0) {
      fogTimer -= dt;
      if (fogTimer <= 0) {
        spawnFogBank();
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
    spawnFogBank,
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
    get fogBanks() {
      return state.fogBanks;
    },
  };
}
