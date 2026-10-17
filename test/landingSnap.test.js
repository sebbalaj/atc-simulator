// FEAT-002 regression tests: "draw a line to the end of the runway at a sensible
// angle and it snaps to land." These guard the forgiving-but-not-over-eager
// landing geometry and the robust approach-heading helper. All imports are pure
// (DOM-free); the ECS case drives the real landing system headlessly like
// landingCleared.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createMap1,
  runwayThreshold,
  runwayFarEnd,
  findLandingTarget,
  approachHeadingFromPath,
  angleDifference,
} from "../src/game/airport.js";
import { snapToLanding } from "../src/ui/input.js";
import { AircraftKind, getAircraftDef } from "../src/game/aircraft.js";

import { createWorld } from "../src/ecs/world.js";
import { createEventBus } from "../src/core/events.js";
import { createMap } from "../src/game/maps.js";
import { Components } from "../src/ecs/components.js";
import { createMovementSystem } from "../src/ecs/systems/movementSystem.js";
import { createLandingSystem } from "../src/ecs/systems/landingSystem.js";
import { finalizePath } from "../src/ui/input.js";

const DEG = Math.PI / 180;

function map1() {
  return createMap1(400, 700);
}

test("player-drawn route to the FAR end of runway A snaps and locks with a runway clearance", () => {
  const map = map1();
  const def = getAircraftDef(AircraftKind.LIGHT);
  const runway = map.runways[0];
  const thr = runwayThreshold(runway);
  const far = runwayFarEnd(runway);

  // A multi-point hand-drawn polyline tracking in along the landing direction
  // and ENDING at the far/stop end of the runway (literally "draw to the end").
  const route = [
    { x: thr.x - 140, y: thr.y - 6 },
    { x: thr.x - 80, y: thr.y + 3 },
    { x: thr.x - 20, y: thr.y },
    { x: thr.x, y: thr.y },
    { x: far.x, y: far.y },
  ];
  const heading = approachHeadingFromPath(route);
  const target = findLandingTarget(map, route[route.length - 1], heading, def);
  assert.ok(target, "far-end endpoint resolves to a landing target");
  assert.equal(target.type, "runway", "it is a runway target");
  assert.equal(target.surface.id, runway.id, "it is runway A");

  const snapped = snapToLanding(map, route, heading, def);
  assert.equal(snapped.locked, true, "snapToLanding locks the route");
  assert.ok(snapped.clearance, "a clearance is recorded");
  assert.equal(snapped.clearance.surface, "runway", "runway clearance");
  assert.equal(snapped.clearance.runwayId, runway.id, "clearance names runway A");
});

test("an endpoint behind the threshold at a ~22deg-off heading still snaps (forgiving angle)", () => {
  const map = map1();
  const def = getAircraftDef(AircraftKind.LIGHT);
  const runway = map.runways[0];
  const thr = runwayThreshold(runway);

  // Endpoint well inside the approach cone (60px behind the threshold) but the
  // final drawn course is ~22deg off the runway heading - rejected by the old
  // 16deg window, accepted now.
  const endpoint = { x: thr.x - 60, y: thr.y };
  const heading = 22 * DEG;
  const target = findLandingTarget(map, endpoint, heading, def);
  assert.ok(target, "forgiving angle resolves to a target");
  assert.equal(target.type, "runway");
  assert.equal(target.surface.id, runway.id);
});

test("a 90deg crossing heading does NOT snap (no over-snapping)", () => {
  const map = map1();
  const def = getAircraftDef(AircraftKind.LIGHT);
  const runway = map.runways[0];
  const thr = runwayThreshold(runway);

  const endpoint = { x: thr.x - 60, y: thr.y };
  const crossing = findLandingTarget(map, endpoint, 90 * DEG, def);
  assert.equal(crossing, null, "a perpendicular approach is rejected");
});

test("an endpoint far off the centerline laterally does NOT snap", () => {
  const map = map1();
  const def = getAircraftDef(AircraftKind.LIGHT);
  const runway = map.runways[0];
  const thr = runwayThreshold(runway);

  // Same depth, but 120px off the centerline (far outside the cone width).
  const endpoint = { x: thr.x - 60, y: thr.y + 120 };
  const target = findLandingTarget(map, endpoint, 0, def);
  assert.equal(target, null, "a far-off-centerline endpoint is rejected");
});

test("approachHeadingFromPath averages a wobbly tail to within the runway tolerance", () => {
  const map = map1();
  const runway = map.runways[0]; // heading 0 (east), 28deg tolerance

  // A path running mostly east with jitter, and a sharp wobble on the final
  // segment that would mislead a last-two-point heading.
  const pts = [
    { x: 0, y: 0 },
    { x: 20, y: 1 },
    { x: 40, y: -1 },
    { x: 60, y: 2 },
    { x: 72, y: 12 },
  ];
  const robust = approachHeadingFromPath(pts);
  const naive = Math.atan2(12 - 2, 72 - 60); // last-two-point heading

  assert.ok(
    angleDifference(robust, runway.heading) <= runway.approach.tolerance,
    "robust heading is within the runway's angular tolerance"
  );
  assert.ok(
    angleDifference(naive, runway.heading) > angleDifference(robust, runway.heading),
    "the robust heading is closer to the runway heading than the naive last-two-point heading"
  );
});

test("approachHeadingFromPath falls back safely for a degenerate 2-point path", () => {
  const h = approachHeadingFromPath([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
  assert.equal(h, 0, "straight-east 2-point path => heading 0");
  assert.equal(approachHeadingFromPath([]), 0, "empty path => 0 (no throw)");
  assert.equal(approachHeadingFromPath([{ x: 1, y: 1 }]), 0, "single point => 0");
});

test("driven through the ECS, a to-the-far-end route clears, lands, and is removed", () => {
  const game = {
    world: createWorld(),
    bus: createEventBus(),
    map: createMap("map1", 400, 700),
    time: 0,
    gameOver: false,
    weather: null,
  };
  game.movement = createMovementSystem(game);
  game.landing = createLandingSystem(game);

  const def = getAircraftDef(AircraftKind.LIGHT);
  const runway = game.map.runways[0];
  const thr = runwayThreshold(runway);
  const far = runwayFarEnd(runway);

  const startX = thr.x - Math.cos(runway.heading) * 90;
  const startY = thr.y - Math.sin(runway.heading) * 90;

  const id = game.world.createEntity();
  game.world.addComponent(id, Components.Transform, { x: startX, y: startY, heading: runway.heading });
  game.world.addComponent(id, Components.Aircraft, {
    kind: AircraftKind.LIGHT,
    state: "inbound",
    passengers: 2,
    emergency: null,
    spawnTime: 0,
  });
  game.world.addComponent(id, Components.Path, { points: [], progress: 0, locked: false, built: null });
  game.world.addComponent(id, Components.Fuel, { capacity: def.fuelMax, remaining: def.fuelMax, critical: false });

  let clearedCount = 0;
  let landedCount = 0;
  game.bus.on("landing:cleared", () => clearedCount++);
  game.bus.on("aircraft:landed", () => landedCount++);

  // A route that ends AT the far end of the runway (the user's "draw to end").
  const route = [
    { x: startX, y: startY },
    { x: thr.x - 30, y: thr.y },
    { x: thr.x, y: thr.y },
    { x: far.x, y: far.y },
  ];
  finalizePath(game, id, route);
  assert.ok(game.world.getComponent(id, Components.Path).locked, "far-end route is cleared/locked");

  const dt = 1 / 60;
  let ticks = 0;
  while (game.world.hasEntity(id) && ticks < 2000) {
    game.time += dt;
    game.movement(dt);
    game.landing(dt);
    ticks++;
  }

  assert.ok(!game.world.hasEntity(id), "plane landed and was removed");
  assert.equal(clearedCount, 1, "exactly one 'landing:cleared' emitted");
  assert.equal(landedCount, 1, "exactly one 'aircraft:landed' emitted");
});
