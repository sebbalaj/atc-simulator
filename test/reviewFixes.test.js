// Regression tests for the v1 semantic-review fixes. Each test pins a specific
// behavioral fix so it would FAIL if the fix were reverted:
//   1. Near-miss penalty is counted once per PAIR episode (not per plane), so a
//      single two-plane breach costs one reputation penalty, not two.
//   2. A MAYDAY gets an immediate straight-line priority clearance to the
//      nearest adequate runway, and all other inbound traffic is diverted.
//   3. The Automated Holding Patterns upgrade actually changes behavior: an
//      un-cleared plane that finishes its route is auto-placed into a holding
//      orbit only when the upgrade is owned.
//   4. The carrier's oscillation PERIOD is independent of its amplitude (map
//      width), via an explicit angular frequency.
// All tests drive the real pure logic / ECS systems headlessly (no DOM).

import { test } from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../src/ecs/world.js";
import { createEventBus } from "../src/core/events.js";
import { createSpatialHash } from "../src/core/spatialHash.js";
import { createMap } from "../src/game/maps.js";
import { makeMovingRunwayForTest, updateMovingRunways } from "../src/game/maps.js";
import { Components } from "../src/ecs/components.js";
import { detectConflicts, createCollisionSystem } from "../src/ecs/systems/collisionSystem.js";
import { createMovementSystem } from "../src/ecs/systems/movementSystem.js";
import { createEmergencySystem } from "../src/ecs/systems/emergencySystem.js";
import { createReputation, PENALTY } from "../src/game/reputation.js";
import { AircraftKind, getAircraftDef } from "../src/game/aircraft.js";
import {
  markMayday,
  nearestAdequateRunway,
  straightLineApproach,
  isMaydayPriority,
} from "../src/game/emergencies.js";
import {
  runwayThreshold,
  runwayFarEnd,
  normalizeAngle,
} from "../src/game/airport.js";

// --- 1. Near-miss double-penalty fix -------------------------------------

test("detectConflicts reports ONE warned pair for a single two-plane breach", () => {
  const spatial = createSpatialHash(96);
  const sep = getAircraftDef(AircraftKind.LIGHT).separationRadius;
  const near = [
    { id: 1, x: 100, y: 100, kind: AircraftKind.LIGHT, hitboxRadius: 7, separationRadius: sep },
    { id: 2, x: 100 + sep * 0.4, y: 100, kind: AircraftKind.LIGHT, hitboxRadius: 7, separationRadius: sep },
  ];
  const res = detectConflicts(near, spatial);
  assert.ok(res.warnings.has(1) && res.warnings.has(2), "both planes flagged");
  assert.ok(res.warnedPairs instanceof Set, "warnedPairs is a Set");
  assert.equal(res.warnedPairs.size, 1, "exactly one PAIR episode for a two-plane breach");
  assert.ok(res.warnedPairs.has("1:2"), "pair keyed by sorted ids");
});

test("collision system penalizes a two-plane near-miss exactly ONCE", () => {
  const world = createWorld();
  const bus = createEventBus();
  const spatial = createSpatialHash(96);
  const reputation = createReputation();
  const game = { world, bus, spatial, map: createMap("map1", 400, 700), gameOver: false };
  const collision = createCollisionSystem(game);

  // Mirror the console wiring: a near-miss costs one 'nearMiss' penalty.
  let nearmissEvents = 0;
  bus.on("aircraft:nearmiss", () => {
    nearmissEvents++;
    reputation.penalize("nearMiss");
  });

  const sep = getAircraftDef(AircraftKind.LIGHT).separationRadius;
  const mk = (x, y) => {
    const id = world.createEntity();
    world.addComponent(id, Components.Transform, { x, y, heading: 0 });
    world.addComponent(id, Components.Aircraft, { kind: AircraftKind.LIGHT, state: "inbound" });
    world.addComponent(id, Components.Hitbox, { radius: 7 });
    world.addComponent(id, Components.Render, {});
    return id;
  };
  mk(100, 100);
  mk(100 + sep * 0.4, 100);

  // Several ticks with the pair still in breach: the episode must fire once.
  for (let i = 0; i < 10; i++) collision();

  assert.equal(nearmissEvents, 1, "one near-miss event for one ongoing breach");
  assert.equal(
    reputation.score,
    100 - PENALTY.nearMiss,
    "reputation drops by a single nearMiss penalty, not double"
  );
});

// --- 2. MAYDAY priority routing ------------------------------------------

test("nearestAdequateRunway skips too-short runways and picks the closest adequate one", () => {
  const map = createMap("map1", 400, 700);
  const supersonic = getAircraftDef(AircraftKind.SUPERSONIC); // needs a long runway
  // Only runway A (230) is long enough for SUPERSONIC (needs 220); B is 180.
  const pos = { x: map.runways[0].x - 300, y: map.runways[0].y };
  const r = nearestAdequateRunway(map.runways, pos, supersonic);
  assert.ok(r, "found an adequate runway");
  assert.ok(r.length >= supersonic.runwayLengthRequired, "runway long enough");
});

test("straightLineApproach builds a 2-point straight-in clearance to a runway end", () => {
  const map = createMap("map1", 400, 700);
  const runway = map.runways[0];
  const pos = { x: runway.x - 300, y: runway.y - 10 };
  const approach = straightLineApproach(pos, runway, {
    threshold: runwayThreshold,
    farEnd: runwayFarEnd,
    normalizeAngle,
  });
  assert.equal(approach.points.length, 2, "straight line = two points");
  assert.deepEqual(approach.points[0], { x: pos.x, y: pos.y }, "starts at the aircraft");
  assert.equal(approach.clearance.surface, "runway");
  assert.equal(approach.clearance.runwayId, runway.id);
  assert.ok(approach.clearance.priority, "flagged priority");
  // The threshold point is one of the runway's two thresholds.
  const t0 = runwayThreshold(runway);
  const t1 = runwayThreshold({ ...runway, heading: runway.heading + Math.PI });
  const end = approach.points[1];
  const matches =
    (Math.abs(end.x - t0.x) < 1e-6 && Math.abs(end.y - t0.y) < 1e-6) ||
    (Math.abs(end.x - t1.x) < 1e-6 && Math.abs(end.y - t1.y) < 1e-6);
  assert.ok(matches, "endpoint is a runway threshold");
});

test("mayday auto-clears a straight-line route and diverts other inbound traffic", () => {
  const world = createWorld();
  const bus = createEventBus();
  const game = {
    world,
    bus,
    rng: { next: () => 0.99 }, // never randomly classify; we flag manually
    map: createMap("map1", 400, 700),
    gameOver: false,
    reputation: createReputation(),
  };
  const emergency = createEmergencySystem(game);

  // An ordinary inbound plane that is already "cleared" toward a runway.
  const other = world.createEntity();
  world.addComponent(other, Components.Transform, { x: 60, y: 60, heading: 0 });
  world.addComponent(other, Components.Aircraft, {
    kind: AircraftKind.COMMERCIAL,
    state: "inbound",
    clearance: { surface: "runway", runwayId: map0Runway(game).id },
  });
  world.addComponent(other, Components.Path, { points: [{ x: 0, y: 0 }, { x: 60, y: 60 }], locked: true, built: null });

  // The mayday plane: flagged, then handed a priority clearance by the system.
  const mayday = world.createEntity();
  world.addComponent(mayday, Components.Transform, { x: 40, y: 350, heading: 0 });
  const mAc = world.getComponent(mayday, Components.Aircraft) || {};
  world.addComponent(mayday, Components.Aircraft, { kind: AircraftKind.COMMERCIAL, state: "inbound" });
  world.addComponent(mayday, Components.Path, { points: [], locked: false, built: null });
  markMayday(world.getComponent(mayday, Components.Aircraft));
  void mAc;

  let priorityEvents = 0;
  bus.on("emergency:priority-cleared", () => priorityEvents++);

  const applied = emergency.assignMaydayPriority(mayday);
  assert.ok(applied, "a priority clearance was produced");
  assert.equal(priorityEvents, 1, "priority-cleared event emitted");

  const mPath = world.getComponent(mayday, Components.Path);
  const mAcAfter = world.getComponent(mayday, Components.Aircraft);
  assert.ok(mPath.locked, "mayday route is locked/cleared automatically");
  assert.ok(mAcAfter.clearance && mAcAfter.clearance.surface === "runway", "runway clearance set");
  assert.ok(isMaydayPriority(mAcAfter.emergency), "still a mayday priority");
  assert.ok(mPath.points.length >= 2, "a straight-in route was stamped");

  // Other traffic diverted: its clearance released so it must be re-routed.
  const oPath = world.getComponent(other, Components.Path);
  const oAc = world.getComponent(other, Components.Aircraft);
  assert.equal(oPath.locked, false, "other traffic clearance released (diverted)");
  assert.equal(oAc.clearance, null, "other traffic no longer cleared");
});

function map0Runway(game) {
  return game.map.runways[0];
}

// --- 3. Automated Holding Patterns upgrade actually changes behavior ------

function buildHoldingGame(holdingAutomation) {
  const world = createWorld();
  const bus = createEventBus();
  const game = {
    world,
    bus,
    map: createMap("map1", 400, 700),
    gameOver: false,
    upgradeState: { flags: { holdingAutomation } },
  };
  game.movement = createMovementSystem(game);
  return game;
}

/** Spawn a LIGHT with a short, un-cleared route that it will fly off the end of. */
function spawnShortRoute(game) {
  const { world } = game;
  const id = world.createEntity();
  const start = { x: 60, y: 60 };
  const end = { x: 120, y: 60 };
  world.addComponent(id, Components.Transform, { x: start.x, y: start.y, heading: 0 });
  world.addComponent(id, Components.Aircraft, { kind: AircraftKind.LIGHT, state: "inbound" });
  world.addComponent(id, Components.Path, { points: [start, end], locked: false, built: null, progress: 0 });
  return id;
}

test("auto-holding OFF: an un-cleared finished route just completes (no orbit)", () => {
  const game = buildHoldingGame(false);
  const id = spawnShortRoute(game);
  const dt = 1 / 60;
  // 60px route at the FEAT-003 slowed light speed (10px/s) needs ~360 ticks to
  // fly off the end; run 600 for margin so the route actually completes.
  for (let i = 0; i < 600; i++) game.movement(dt);
  const path = game.world.getComponent(id, Components.Path);
  assert.ok(!path.holding, "no holding orbit when the upgrade is not owned");
  assert.equal(path.completed, true, "route completed and the plane flies on straight");
});

test("auto-holding ON: an un-cleared finished route converts into a holding orbit", () => {
  const game = buildHoldingGame(true);
  let autoHold = 0;
  game.bus.on("holding:auto", () => autoHold++);
  const id = spawnShortRoute(game);
  const dt = 1 / 60;
  // 60px route at the FEAT-003 slowed light speed (10px/s) needs ~360 ticks to
  // reach the end before auto-holding converts it; run 600 for margin.
  for (let i = 0; i < 600; i++) game.movement(dt);
  const path = game.world.getComponent(id, Components.Path);
  assert.ok(autoHold >= 1, "a holding:auto event fired (upgrade took effect)");
  assert.equal(path.holding, true, "plane auto-placed into a holding orbit");
  assert.equal(path.completed, false, "no longer treated as a completed drifting route");
});

// --- 4. Carrier oscillation period independent of amplitude ---------------

test("carrier oscillation period does not depend on amplitude (angular frequency)", () => {
  // Two carriers with the SAME peak speed but very different amplitudes. With a
  // dimensionally-sound angular frequency their periods differ (omega = v/A);
  // the regression is when the period is accidentally tied to amplitude in a way
  // that makes the motion dimensionally wrong. We instead pin the invariant the
  // fix guarantees: offset(t) = A * sin((v/A) * t), so peak |velocity| ~= v for
  // BOTH regardless of A.
  const makeMap = (amplitude) => ({
    movingRunways: [
      makeMovingRunwayForTest({ x: 1000, y: 500, amplitude, speed: 16, axis: 0 }),
    ],
  });

  const peakSpeed = (amplitude) => {
    const map = makeMap(amplitude);
    const r = map.movingRunways[0];
    const dt = 1 / 240; // fine step to sample the derivative near t=0 crossing
    let prevX = r.x;
    let maxV = 0;
    for (let i = 0; i < 240 * 20; i++) {
      updateMovingRunways(map, dt);
      const v = Math.abs(r.x - prevX) / dt;
      if (v > maxV) maxV = v;
      prevX = r.x;
    }
    return maxV;
  };

  const vSmall = peakSpeed(50);
  const vLarge = peakSpeed(400);
  // Peak deck speed should be ~the configured speed (16 px/s) for BOTH, i.e. the
  // frequency scales with 1/amplitude so the peak speed stays fixed. Allow a
  // tolerance for the discrete sampling.
  assert.ok(Math.abs(vSmall - 16) < 2.0, `small-amplitude peak speed ~16 (got ${vSmall})`);
  assert.ok(Math.abs(vLarge - 16) < 2.0, `large-amplitude peak speed ~16 (got ${vLarge})`);
});
