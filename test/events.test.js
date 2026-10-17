// Unit tests for the dynamic event system (FEAT-004): weather + emergencies.
// All imports are pure, DOM-free modules so these run under `node --test`.
// Covers:
//   - deterministic storm-cell drift for a seed
//   - point-in-storm hit vs miss, and path-crosses-storm hit vs miss
//   - wind-shift flipping which approach direction is valid
//   - mayday flag increasing effective speed + marking priority
//   - medical-evac landing rejected until the hospital waypoint flag is set
//   - holding too long draining fuel into the emergency threshold

import { test } from "node:test";
import assert from "node:assert/strict";

import { createRng } from "../src/core/rng.js";
import {
  createStormCell,
  driftStorm,
  isPointInStorm,
  pointInAnyStorm,
  pathCrossesStorm,
  segmentIntersectsCircle,
  isApproachDirectionValid,
  fogVisibilityRange,
  fogAlphaForDistance,
  createWeatherController,
} from "../src/game/weather.js";
import {
  markMayday,
  markMedical,
  maydaySpeedFactor,
  isMaydayPriority,
  isMedicalLandingAllowed,
  isFuelEmergency,
  MAYDAY_SPEED_FACTOR,
  FUEL_EMERGENCY_FRACTION,
  EmergencyType,
} from "../src/game/emergencies.js";
import { drainFuel } from "../src/game/fuel.js";
import { Fuel } from "../src/ecs/components.js";
import {
  createMap1,
  isOverHospital,
  routePassesHospital,
  holdingPatternPoints,
} from "../src/game/airport.js";

// --- Storm drift ----------------------------------------------------------

test("storm cell drift is deterministic and advances by velocity * dt", () => {
  const cell = createStormCell({ x: 0, y: 0, vx: 10, vy: -4, radius: 50, life: 100 });
  const dt = 1 / 60;
  for (let i = 0; i < 60; i++) driftStorm(cell, dt);
  // After ~1 second: x ~= 10, y ~= -4 (float arithmetic), life decremented.
  assert.ok(Math.abs(cell.x - 10) < 1e-6, "x advanced by vx*t");
  assert.ok(Math.abs(cell.y - -4) < 1e-6, "y advanced by vy*t");
  assert.ok(Math.abs(cell.life - 99) < 1e-6, "life decremented");

  // Determinism: a second identical cell reaches the same place.
  const cell2 = createStormCell({ x: 0, y: 0, vx: 10, vy: -4, radius: 50, life: 100 });
  for (let i = 0; i < 60; i++) driftStorm(cell2, dt);
  assert.equal(cell2.x, cell.x);
  assert.equal(cell2.y, cell.y);
});

test("weather controller storm spawn/drift is reproducible for a seed", () => {
  const map = createMap1(400, 600);
  const mk = () => createWeatherController({ rng: createRng(99), map, config: { stormMinInterval: 1, stormMaxInterval: 1, windShiftMinInterval: 1000, windShiftMaxInterval: 1000, fogMinInterval: 1000, fogMaxInterval: 1000 } });
  const a = mk();
  const b = mk();
  for (let i = 0; i < 180; i++) { a.update(1 / 60); b.update(1 / 60); }
  assert.equal(a.storms.length, b.storms.length, "same storm count for a seed");
  assert.ok(a.storms.length > 0, "at least one storm spawned");
  assert.equal(a.storms[0].x, b.storms[0].x, "same storm position for a seed");
  assert.equal(a.storms[0].y, b.storms[0].y, "same storm position for a seed");
});

// --- Point / path in storm ------------------------------------------------

test("point-in-storm flags a point inside and misses one outside", () => {
  const cell = createStormCell({ x: 100, y: 100, radius: 40 });
  assert.ok(isPointInStorm(cell, 110, 105), "inside the cell");
  assert.ok(!isPointInStorm(cell, 200, 200), "outside the cell");
  assert.ok(pointInAnyStorm([cell], 100, 100), "pointInAnyStorm returns the cell");
  assert.equal(pointInAnyStorm([cell], 300, 300), null, "no cell far away");
});

test("path-crosses-storm hits a route through a cell, misses one around it", () => {
  const cell = createStormCell({ x: 100, y: 100, radius: 30 });

  // A route passing straight through the center.
  const through = [
    { x: 0, y: 100 },
    { x: 200, y: 100 },
  ];
  assert.ok(pathCrossesStorm(cell, through), "route through the cell is flagged");

  // A route that stays well clear (detours above the cell).
  const around = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 200, y: 0 },
  ];
  assert.ok(!pathCrossesStorm(cell, around), "route around the cell is not flagged");

  // Segment-vs-circle tangent check.
  assert.ok(segmentIntersectsCircle({ x: 0, y: 70 }, { x: 200, y: 70 }, cell), "tangent clips the cell");
  assert.ok(!segmentIntersectsCircle({ x: 0, y: 40 }, { x: 200, y: 40 }, cell), "line above clears the cell");
});

// --- Wind shift -----------------------------------------------------------

test("wind shift flips which approach direction is valid", () => {
  // Wind blowing toward -x (west, PI). Planes land into the wind -> landing
  // heading should be toward +x (east, 0).
  const windWest = Math.PI;
  assert.ok(isApproachDirectionValid(0, windWest), "landing east valid when wind blows west");
  assert.ok(!isApproachDirectionValid(Math.PI, windWest), "landing west invalid when wind blows west");

  // Now the wind shifts to blow toward +x (east, 0). The valid landing flips.
  const windEast = 0;
  assert.ok(!isApproachDirectionValid(0, windEast), "landing east now invalid");
  assert.ok(isApproachDirectionValid(Math.PI, windEast), "landing west now valid");
});

test("weather controller shiftWind reverses the valid approach", () => {
  const map = createMap1(400, 600);
  const wc = createWeatherController({ rng: createRng(5), map });
  const before = wc.windDirection;
  const valid1 = isApproachDirectionValid(0, before, wc.state.windTolerance);
  wc.shiftWind();
  const after = wc.windDirection;
  const valid2 = isApproachDirectionValid(0, after, wc.state.windTolerance);
  assert.notEqual(valid1, valid2, "a wind shift flips validity of the same approach");
});

// --- Fog ------------------------------------------------------------------

test("fog reduces visibility range, ILS restores it", () => {
  const full = 400;
  assert.equal(fogVisibilityRange(0, full), full, "no fog = full range");
  assert.ok(fogVisibilityRange(1, full) < full, "full fog shrinks the range");
  assert.equal(fogVisibilityRange(1, full, true), full, "ILS owned keeps full range");

  // A plane beyond the fog range fades out; one inside is fully visible.
  const range = fogVisibilityRange(1, full);
  assert.equal(fogAlphaForDistance(range - 10, range), 1, "inside range fully visible");
  assert.ok(fogAlphaForDistance(range + 1000, range) < 1, "far beyond range faded");
});

// --- Mayday ---------------------------------------------------------------

test("mayday flag increases effective speed and marks priority", () => {
  const ac = { kind: "commercial", emergency: null, speedFactor: 1 };
  assert.equal(maydaySpeedFactor(ac.emergency), 1, "no emergency = base speed");
  assert.ok(!isMaydayPriority(ac.emergency), "not priority before flagging");

  markMayday(ac);
  assert.equal(ac.emergency.type, EmergencyType.MAYDAY);
  assert.ok(isMaydayPriority(ac.emergency), "mayday is priority");
  assert.equal(maydaySpeedFactor(ac.emergency), MAYDAY_SPEED_FACTOR, "effective speed bumped");
  assert.ok(MAYDAY_SPEED_FACTOR > 1, "mayday flies faster");
  assert.equal(ac.speedFactor, MAYDAY_SPEED_FACTOR, "shared speedFactor set for movement");
});

// --- Medical evac ---------------------------------------------------------

test("medical-evac landing rejected until the hospital waypoint is set", () => {
  const ac = { kind: "helicopter", emergency: null };
  markMedical(ac);
  assert.equal(ac.emergency.type, EmergencyType.MEDICAL);
  // Before overflying the hospital: landing not allowed.
  assert.ok(!isMedicalLandingAllowed(ac.emergency), "rejected before hospital visit");
  // Mark the hospital visited: landing now allowed.
  ac.emergency.hospitalVisited = true;
  assert.ok(isMedicalLandingAllowed(ac.emergency), "accepted after hospital visit");

  // Non-medical aircraft are always allowed.
  assert.ok(isMedicalLandingAllowed(null), "non-emergency always allowed");
  assert.ok(isMedicalLandingAllowed({ type: EmergencyType.MAYDAY }), "mayday not gated by hospital");
});

test("hospital POI overflight detection and route check", () => {
  const map = createMap1(400, 600);
  const h = map.hospital;
  assert.ok(isOverHospital(h, h.x, h.y), "center is over the hospital");
  assert.ok(!isOverHospital(h, h.x + 1000, h.y), "far point is not over the hospital");
  // A route that passes through the hospital point is detected.
  const route = [
    { x: 0, y: 0 },
    { x: h.x, y: h.y },
    { x: map.center.x, y: map.center.y },
  ];
  assert.ok(routePassesHospital(h, route), "route passing the hospital is detected");
  const miss = [{ x: 0, y: 0 }, { x: 5, y: 5 }];
  assert.ok(!routePassesHospital(h, miss), "route missing the hospital is not detected");
});

// --- Fuel emergency from holding -----------------------------------------

test("holding too long drains fuel to the emergency threshold", () => {
  // A small tank so the test is quick; capacity in seconds of flight.
  const fuel = Fuel(40);
  assert.ok(!isFuelEmergency(fuel), "full tank is not a fuel emergency");

  const dt = 1 / 60;
  let ticks = 0;
  const maxTicks = 60 * 120; // safety bound: 120s
  // Drain while holding until we drop into the emergency band.
  while (!isFuelEmergency(fuel) && ticks < maxTicks) {
    drainFuel(fuel, dt, { holding: true });
    ticks++;
  }
  assert.ok(isFuelEmergency(fuel), "held plane reaches the fuel emergency band");
  const frac = fuel.remaining / fuel.capacity;
  assert.ok(frac <= FUEL_EMERGENCY_FRACTION + 1e-6, "fraction at/under the threshold");

  // Keep draining: fuel eventually empties (would crash in-sim).
  let empty = false;
  for (let i = 0; i < maxTicks && !empty; i++) {
    const res = drainFuel(fuel, dt, { holding: true });
    if (res.empty || fuel.remaining <= 0) empty = true;
  }
  assert.ok(empty, "a plane left holding eventually runs out of fuel");
});

test("holding pattern points form a closed orbit around the fix", () => {
  const fix = { x: 100, y: 100, radius: 30 };
  const pts = holdingPatternPoints(fix, 12);
  assert.ok(pts.length >= 12, "orbit has enough points");
  // All points are ~radius from the fix.
  for (const p of pts) {
    const d = Math.hypot(p.x - fix.x, p.y - fix.y);
    assert.ok(Math.abs(d - fix.radius) < 1e-6, "point lies on the orbit radius");
  }
  // First and last coincide (closed loop).
  assert.ok(Math.abs(pts[0].x - pts[pts.length - 1].x) < 1e-6, "loop closes in x");
  assert.ok(Math.abs(pts[0].y - pts[pts.length - 1].y) < 1e-6, "loop closes in y");
});
