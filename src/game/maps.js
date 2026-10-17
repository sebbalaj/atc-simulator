// Map registry: all four playable maps as data-returning factories. A map
// definition is a superset of the Map 1 structure already used across the
// systems (runways[], helipad, hospital, holdFix, center, spawnRadius,
// width/height) plus FEAT-005 additions:
//
//   helipads[]      all landing pads (helipad stays set to the primary pad for
//                   back-compat with code that reads map.helipad).
//   airports[]      named sub-airports (Map 2 Twin Cities / Map 3 international)
//                   used by routing hints and rendering labels.
//   rules           map-specific gameplay rules:
//                     wakeMultiplier    scales the wake-separation bubble
//                                       enforced behind COMMERCIAL leaders
//                                       (Map 4 is stricter).
//                     spawnScale        multiplies spawn frequency (Map 4 is
//                                       busier: < 1 shortens the interval).
//                     routingHint       short human-readable rule shown in the
//                                       briefing / shop.
//   movingRunways   derived list of runways that translate over time (Map 3
//                   carrier). Each carries a `moving` descriptor consumed by the
//                   movement system to advance runway.x/runway.y each tick.
//
// Everything here is pure data construction (no DOM), so the registry can be
// unit-tested under Node.

import {
  createRunway,
  createMap1,
  isOverHospital,
  routePassesHospital,
  holdingPatternPoints,
  findLandingTarget,
} from "./airport.js";

const DEG = Math.PI / 180;

/**
 * Attach a `moving` descriptor to a runway so the movement system translates it
 * each tick. The runway oscillates along a heading `axis` by +/- `amplitude`
 * px at `speed` px/s (a carrier steaming back and forth on station). The base
 * position is captured so the offset is relative to it.
 */
function makeMovingRunway(runway, { axis = 0, amplitude = 60, speed = 18 } = {}) {
  // Derive an explicit angular frequency (rad/s) from a peak deck speed so the
  // oscillation PERIOD is independent of the amplitude (and thus of map width).
  // For x(t) = amplitude * sin(omega * t), peak speed = amplitude * omega, so
  // omega = speed / amplitude gives a carrier whose fastest pass is `speed`
  // px/s regardless of how far it travels. Storing omega (not re-dividing by a
  // length each tick) keeps the frequency a first-class, dimensionally-sound
  // quantity instead of an accidental speed/amplitude coupling.
  const omega = speed / Math.max(1, amplitude);
  runway.moving = {
    axis,
    amplitude,
    speed,
    omega, // angular frequency (rad/s)
    baseX: runway.x,
    baseY: runway.y,
    phase: 0, // seconds accumulated; movement system advances this
  };
  return runway;
}

/** Default map rules; individual maps override what they need. */
function defaultRules(overrides = {}) {
  return {
    wakeMultiplier: 1,
    spawnScale: 1,
    routingHint: "",
    ...overrides,
  };
}

// Map 1 — Regional Airfield. Re-exported from airport.js (the canonical Map 1
// layout) so the registry and the rest of the game share one definition.
export { createMap1 };

/**
 * Map 2 — Twin Cities. Two separate airports, one near the top of the portrait
 * screen (the large/international field, long runways for jets) and one near the
 * bottom (the small field, short runway for props). Their approach corridors
 * overlap in the middle so routes must weave between the two patterns.
 */
export function createMap2(width, height) {
  const cx = width / 2;
  const cy = height / 2;

  // Large field near the top: a long runway that accepts heavy jets.
  const bigY = height * 0.26;
  const bigRunway = createRunway({
    id: "36L",
    x: cx,
    y: bigY,
    heading: 90 * DEG, // landing toward +y (south), into the field from the top
    // FEAT-004: shrunk 0.70 (240->168, width 15->11, cone 200->140).
    length: 168,
    width: 11,
    approach: { tolerance: 28 * DEG, coneLength: 140 },
    clearTime: 3,
  });

  // Small field near the bottom: a short strip only props/light can use.
  const smallY = height * 0.76;
  const smallRunway = createRunway({
    id: "18R",
    x: cx,
    y: smallY,
    heading: -90 * DEG, // landing toward -y (north), into the field from below
    // FEAT-004: shrunk 0.70 (150->105, width 12->8, cone 170->119).
    length: 105,
    width: 8,
    approach: { tolerance: 28 * DEG, coneLength: 119 },
    clearTime: 3,
  });

  const helipad = { id: "H1", x: cx + width * 0.3, y: cy, radius: 11 }; // FEAT-004: 15 -> 11
  const hospital = { id: "HOSP", x: cx - width * 0.3, y: cy, radius: 22 };
  const holdFix = { id: "HOLD1", x: cx + width * 0.28, y: height * 0.5, radius: 34 };

  return {
    id: "map2",
    name: "Twin Cities",
    width,
    height,
    center: { x: cx, y: cy },
    runways: [bigRunway, smallRunway],
    helipad,
    helipads: [helipad],
    airports: [
      { id: "BIG", name: "Metropolitan Intl", x: cx, y: bigY, size: "large", runwayId: "36L" },
      { id: "SML", name: "Downtown Muni", x: cx, y: smallY, size: "small", runwayId: "18R" },
    ],
    hospital,
    holdFix,
    spawnRadius: Math.min(width, height) * 0.54,
    rules: defaultRules({
      routingHint: "Jets to the north field, props to the south; weave between patterns.",
    }),
  };
}

/**
 * Map 3 — Coastal Hub. A major international airport inland plus an aircraft
 * carrier that serves as a MOVING runway steaming along the coast, and offshore
 * helipads (oil-rig pads) out over the water.
 */
export function createMap3(width, height) {
  const cx = width / 2;
  const cy = height / 2;

  // International airport (inland, long runway).
  const intl = createRunway({
    id: "10/28",
    x: cx,
    y: height * 0.32,
    heading: 0,
    // FEAT-004: shrunk 0.70 (250->175, width 16->11, cone 210->147).
    length: 175,
    width: 11,
    approach: { tolerance: 28 * DEG, coneLength: 147 },
    clearTime: 3,
  });

  // Carrier: a shorter runway that translates over time. It steams left/right
  // (axis 0 => along +x) and the movement system tracks the moving position so
  // the approach cone and rollout follow the deck.
  const carrier = createRunway({
    id: "CVN",
    x: cx,
    y: height * 0.74,
    heading: 10 * DEG,
    // FEAT-004: shrunk 0.70 (170->119, width 16->11, cone 160->112).
    length: 119,
    width: 11,
    approach: { tolerance: 26 * DEG, coneLength: 112 },
    clearTime: 4,
  });
  makeMovingRunway(carrier, { axis: 0, amplitude: width * 0.18, speed: 16 });

  // Offshore helipads out over the water (bottom corners).
  const pad1 = { id: "OSP1", x: width * 0.2, y: height * 0.88, radius: 11, offshore: true }; // FEAT-004: 15 -> 11
  const pad2 = { id: "OSP2", x: width * 0.8, y: height * 0.88, radius: 11, offshore: true }; // FEAT-004: 15 -> 11

  const hospital = { id: "HOSP", x: width * 0.16, y: height * 0.4, radius: 22 };
  const holdFix = { id: "HOLD1", x: width * 0.82, y: height * 0.5, radius: 34 };

  return {
    id: "map3",
    name: "Coastal Hub",
    width,
    height,
    center: { x: cx, y: cy },
    runways: [intl, carrier],
    movingRunways: [carrier],
    helipad: pad1,
    helipads: [pad1, pad2],
    airports: [
      { id: "INTL", name: "Coastal Intl", x: cx, y: height * 0.32, size: "large", runwayId: "10/28" },
      { id: "CVN", name: "USS Carrier", x: carrier.x, y: carrier.y, size: "carrier", runwayId: "CVN", moving: true },
    ],
    hospital,
    holdFix,
    spawnRadius: Math.min(width, height) * 0.56,
    rules: defaultRules({
      routingHint: "Carrier runway moves; offshore helipads over the water.",
    }),
  };
}

/**
 * Map 4 — Mega Hub. Four parallel runways, a very busy spawn stream, and
 * strict wake-turbulence separation (a larger bubble is enforced behind every
 * COMMERCIAL leader via rules.wakeMultiplier).
 */
export function createMap4(width, height) {
  const cx = width / 2;
  const cy = height / 2;

  // Four parallel strips running horizontally (landing toward +x), stacked
  // vertically across the field so inbound heavy traffic stays separated.
  const runways = [];
  const spacing = height * 0.16;
  const topY = cy - spacing * 1.5;
  for (let i = 0; i < 4; i++) {
    runways.push(
      createRunway({
        id: "RW" + (i + 1),
        x: cx,
        y: topY + spacing * i,
        heading: 0, // all parallel, landing toward +x (east)
        // FEAT-004: shrunk 0.70 (230->161, width 14->10, cone 190->133).
        length: 161,
        width: 10,
        approach: { tolerance: 20 * DEG, coneLength: 133 },
        clearTime: 2.5,
      })
    );
  }

  const helipad = { id: "H1", x: width * 0.12, y: cy, radius: 11 }; // FEAT-004: 15 -> 11
  const hospital = { id: "HOSP", x: width * 0.88, y: height * 0.16, radius: 22 };
  const holdFix = { id: "HOLD1", x: width * 0.85, y: height * 0.84, radius: 34 };

  return {
    id: "map4",
    name: "Mega Hub",
    width,
    height,
    center: { x: cx, y: cy },
    runways,
    helipad,
    helipads: [helipad],
    airports: [{ id: "MEGA", name: "Mega International", x: cx, y: cy, size: "mega" }],
    hospital,
    holdFix,
    spawnRadius: Math.min(width, height) * 0.58,
    rules: defaultRules({
      wakeMultiplier: 1.6, // strict wake turbulence separation
      spawnScale: 0.7, // ~40% more traffic
      routingHint: "Four parallel runways; strict wake separation behind jets.",
    }),
  };
}

/** Ordered list of map factories, keyed by id. */
export const MAP_FACTORIES = Object.freeze({
  map1: createMap1,
  map2: createMap2,
  map3: createMap3,
  map4: createMap4,
});

/** Stable play order of the four maps. */
export const MAP_ORDER = Object.freeze(["map1", "map2", "map3", "map4"]);

/** Human-friendly metadata for the map-select screen (no geometry needed). */
export const MAP_META = Object.freeze([
  { id: "map1", name: "Regional Airfield", blurb: "Two intersecting runways." },
  { id: "map2", name: "Twin Cities", blurb: "Two airports, overlapping airspace." },
  { id: "map3", name: "Coastal Hub", blurb: "Moving carrier runway + offshore pads." },
  { id: "map4", name: "Mega Hub", blurb: "Four parallel runways, strict wake rules." },
]);

/**
 * Build a map by id at the given radar size. Falls back to Map 1 for unknown
 * ids so callers never crash on a bad id.
 */
export function createMap(id, width, height) {
  const factory = MAP_FACTORIES[id] || createMap1;
  return factory(width, height);
}

/**
 * Return all four maps built at a reference size. Used by tests and the
 * map-select screen to introspect layouts/rules. Pure.
 */
export function buildAllMaps(width = 400, height = 700) {
  return MAP_ORDER.map((id) => createMap(id, width, height));
}

/**
 * Advance a map's moving runways by dt seconds, translating each along its
 * oscillation axis. Pure helper (mutates the runway positions in place). Safe to
 * call on maps without moving runways (no-op). Exposed for the movement system
 * and for unit testing the carrier motion deterministically.
 */
export function updateMovingRunways(map, dt) {
  if (!map || !map.movingRunways || map.movingRunways.length === 0) return;
  for (const runway of map.movingRunways) {
    const m = runway.moving;
    if (!m) continue;
    m.phase += dt;
    // Oscillate with a sine (eases at the turnaround points) using an explicit
    // angular frequency. omega is captured at construction (speed/amplitude) so
    // the period does NOT drift with the amplitude; fall back to deriving it for
    // any runway whose descriptor predates the omega field.
    const omega = m.omega != null ? m.omega : m.speed / Math.max(1, m.amplitude);
    const offset = Math.sin(omega * m.phase) * m.amplitude;
    runway.x = m.baseX + Math.cos(m.axis) * offset;
    runway.y = m.baseY + Math.sin(m.axis) * offset;
  }
}

/**
 * Construct a standalone runway with a `moving` oscillation descriptor, for unit
 * testing the carrier motion (amplitude/frequency decoupling) without building a
 * whole map. Returns the runway object. Pure.
 */
export function makeMovingRunwayForTest(opts = {}) {
  const runway = {
    id: opts.id || "TEST",
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    heading: opts.heading ?? 0,
    length: opts.length ?? 119, // FEAT-004: 170 -> 119 (carrier scale)
    width: opts.width ?? 11, // FEAT-004: 16 -> 11
  };
  return makeMovingRunway(runway, {
    axis: opts.axis ?? 0,
    amplitude: opts.amplitude ?? 60,
    speed: opts.speed ?? 16,
  });
}

// Re-export geometry helpers so callers can import map + helpers from one place.
export { isOverHospital, routePassesHospital, holdingPatternPoints, findLandingTarget };
