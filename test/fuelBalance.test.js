// FEAT-006 fuel-balance invariants. These are intentionally REVERT-SENSITIVE:
// the winnability floor and the threat ceiling are computed in-test from the
// actual map geometry (createMap + spawnRadius) and each class's cruise speed,
// so if someone reverts fuelMax back to the over-generous FEAT-003 numbers
// (640/1000/760/480) or cuts them below the direct-route floor, these fail.
//
// All imports are DOM-free so this runs under `node --test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AIRCRAFT_DEFS, ALL_KINDS, AircraftKind } from "../src/game/aircraft.js";
import { buildAllMaps } from "../src/game/maps.js";
import { HOLDING_BURN_MULTIPLIER } from "../src/game/fuel.js";

// Margin a direct route must clear: fuelMax must be at least 1.3x the worst-case
// direct spawn-to-farthest-surface seconds so a sensible route always lands.
const WINNABILITY_MARGIN = 1.3;
// A full tank spent entirely in a holding pattern (burning at
// HOLDING_BURN_MULTIPLIER) must flame out within this many seconds, proving a
// tank is a finite, threatening resource rather than effectively unlimited.
const THREAT_HOLD_WINDOW_SEC = 420; // 7 minutes of loitering

const maps = buildAllMaps(400, 700);

/**
 * The surfaces a class may be DIRECTED to land on, given the map. Mirrors
 * assignLandingTarget's eligibility (runway length gate / helipad use) without
 * depending on rng, so the geometry floor is deterministic.
 */
function eligibleSurfaces(def, map) {
  const out = [];
  if (def.usesRunway) {
    for (const r of map.runways) {
      if (r.length >= def.runwayLengthRequired) out.push({ x: r.x, y: r.y });
    }
  }
  if (def.landsOnHelipad) {
    const pads = map.helipads && map.helipads.length ? map.helipads : map.helipad ? [map.helipad] : [];
    for (const p of pads) out.push({ x: p.x, y: p.y });
  }
  return out;
}

/**
 * Worst-case DIRECT distance (px) a class may have to fly: the maximum over all
 * perimeter spawn points of the distance to the FARTHEST eligible surface
 * (pessimistic, since a forced assignment can send a plane to a specific far
 * surface). Returns null if the class has no eligible surface on the map.
 */
function worstCaseDirectDistance(def, map) {
  const surfaces = eligibleSurfaces(def, map);
  if (!surfaces.length) return null;
  const { x: cx, y: cy } = map.center;
  const r = map.spawnRadius;
  let worst = 0;
  for (let i = 0; i < 360; i++) {
    const a = (i / 360) * Math.PI * 2;
    const sx = cx + Math.cos(a) * r;
    const sy = cy + Math.sin(a) * r;
    let farthest = 0;
    for (const s of surfaces) {
      farthest = Math.max(farthest, Math.hypot(s.x - sx, s.y - sy));
    }
    worst = Math.max(worst, farthest);
  }
  return worst;
}

test("fuelBalance: WINNABILITY — fuelMax clears floor*1.3 for every class on every map", () => {
  for (const map of maps) {
    for (const kind of ALL_KINDS) {
      const def = AIRCRAFT_DEFS[kind];
      const dist = worstCaseDirectDistance(def, map);
      if (dist == null) continue; // class cannot land here at all; nothing to assert
      const directSeconds = dist / def.speed;
      const floor = directSeconds * WINNABILITY_MARGIN;
      assert.ok(
        def.fuelMax >= floor,
        `${kind} on ${map.id}: fuelMax ${def.fuelMax}s < required ${floor.toFixed(1)}s ` +
          `(direct ${directSeconds.toFixed(1)}s * ${WINNABILITY_MARGIN}); a direct route must be completable`
      );
    }
  }
});

test("fuelBalance: THREAT — a full tank held from spawn flames out within the loiter window", () => {
  for (const kind of ALL_KINDS) {
    const def = AIRCRAFT_DEFS[kind];
    const holdExhaustSec = def.fuelMax / HOLDING_BURN_MULTIPLIER;
    assert.ok(
      holdExhaustSec < THREAT_HOLD_WINDOW_SEC,
      `${kind}: holding exhaust ${holdExhaustSec.toFixed(0)}s >= ${THREAT_HOLD_WINDOW_SEC}s; ` +
        `fuel is not a real threat (tank too deep)`
    );
  }
});

test("fuelBalance: THREAT is well clear of the WINNABILITY floor (harder-but-fair band)", () => {
  // For each class, the hardest map's direct-route floor must sit comfortably
  // below the tank, yet the tank must be far below an 'effectively unlimited'
  // amount. This encodes 'harder but winnable': there is real slack to route
  // around weather/traffic, but not an infinite loiter budget.
  for (const kind of ALL_KINDS) {
    const def = AIRCRAFT_DEFS[kind];
    let hardestDirectSec = 0;
    for (const map of maps) {
      const dist = worstCaseDirectDistance(def, map);
      if (dist == null) continue;
      hardestDirectSec = Math.max(hardestDirectSec, dist / def.speed);
    }
    // There is usable slack beyond the direct route (can absorb a detour)...
    assert.ok(
      def.fuelMax > hardestDirectSec * WINNABILITY_MARGIN,
      `${kind}: no slack above the winnability floor`
    );
    // ...but the tank is not absurd: a full tank cannot outlast a long shift of
    // pure holding. (Same assertion family as the THREAT test, kept explicit so
    // the band is documented.)
    assert.ok(
      def.fuelMax / HOLDING_BURN_MULTIPLIER < THREAT_HOLD_WINDOW_SEC,
      `${kind}: tank too deep to ever threaten`
    );
  }
});

test("fuelBalance: ORDERING — supersonic has the tightest reserve (shortest holding survival)", () => {
  // The gameplay-meaningful 'reserve' is how long a full tank survives while
  // HOLDING (burning at HOLDING_BURN_MULTIPLIER). Supersonic must be the first
  // to flame out when left to loiter — the documented 'tightest reserve'.
  const holdSurvival = (kind) => AIRCRAFT_DEFS[kind].fuelMax / HOLDING_BURN_MULTIPLIER;
  const supersonic = holdSurvival(AircraftKind.SUPERSONIC);
  for (const kind of ALL_KINDS) {
    if (kind === AircraftKind.SUPERSONIC) continue;
    assert.ok(
      supersonic < holdSurvival(kind),
      `supersonic hold survival ${supersonic.toFixed(0)}s must be < ${kind} ${holdSurvival(kind).toFixed(0)}s`
    );
  }
});

test("fuelBalance: ORDERING — absolute fuelMax matches documented intent", () => {
  // Documented intent: supersonic lowest absolute tank, commercial highest;
  // light and helicopter in the low-to-mid band between them.
  const fm = (k) => AIRCRAFT_DEFS[k].fuelMax;
  assert.ok(
    fm(AircraftKind.SUPERSONIC) < fm(AircraftKind.LIGHT),
    "supersonic tank < light tank"
  );
  assert.ok(
    fm(AircraftKind.LIGHT) < fm(AircraftKind.HELICOPTER),
    "light tank < helicopter tank"
  );
  assert.ok(
    fm(AircraftKind.HELICOPTER) < fm(AircraftKind.COMMERCIAL),
    "helicopter tank < commercial tank (commercial highest absolute)"
  );
});

test("fuelBalance: fuelMax was tightened below the prior FEAT-003 numbers", () => {
  // Revert guard: the old over-generous tanks (640/1000/760/480) must not creep
  // back in.
  assert.ok(AIRCRAFT_DEFS[AircraftKind.LIGHT].fuelMax < 640, "light tightened below 640");
  assert.ok(AIRCRAFT_DEFS[AircraftKind.COMMERCIAL].fuelMax < 1000, "commercial tightened below 1000");
  assert.ok(AIRCRAFT_DEFS[AircraftKind.HELICOPTER].fuelMax < 760, "helicopter tightened below 760");
  assert.ok(AIRCRAFT_DEFS[AircraftKind.SUPERSONIC].fuelMax < 480, "supersonic tightened below 480");
});
