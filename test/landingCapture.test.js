// FEAT-002 landing-reliability tests. The user report: "landing seems scuffed,
// half the time it doesnt register." These cases drive the REAL movement +
// landing ECS headlessly (like landingBehavior.test.js) and assert that a range
// of realistic, slightly-imperfect approaches ALL capture, lock a clearance and
// land within a tick budget — approaches the OLD strict cone (28deg tol + tight
// depth/lateral window) would reject. They are revert-sensitive: against today's
// stricter snapToLanding (no captureRunway fallback) the off-axis / short /
// past-the-end / near-pad cases fail to lock and never land.
//
// Also guards the anti-over-snapping intent (perpendicular / far-off reject) and
// the forced-assignment rejection (a plane forced to one runway must not capture
// another).

import { test } from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../src/ecs/world.js";
import { createEventBus } from "../src/core/events.js";
import { createMap } from "../src/game/maps.js";
import { Components } from "../src/ecs/components.js";
import { createMovementSystem } from "../src/ecs/systems/movementSystem.js";
import { createLandingSystem } from "../src/ecs/systems/landingSystem.js";
import { finalizePath, snapToLanding } from "../src/ui/input.js";
import { AircraftKind, getAircraftDef } from "../src/game/aircraft.js";
import {
  runwayThreshold,
  runwayFarEnd,
  captureRunway,
  approachHeadingFromPath,
} from "../src/game/airport.js";

const DEG = Math.PI / 180;

function makeGame() {
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
  return game;
}

function spawn(game, kind, x, y, heading, assignment = null) {
  const def = getAircraftDef(kind);
  const id = game.world.createEntity();
  game.world.addComponent(id, Components.Transform, { x, y, heading });
  game.world.addComponent(id, Components.Aircraft, {
    kind,
    state: "inbound",
    passengers: 2,
    emergency: null,
    spawnTime: 0,
    assignment,
  });
  game.world.addComponent(id, Components.Path, { points: [], progress: 0, locked: false, built: null });
  game.world.addComponent(id, Components.Fuel, { capacity: def.fuelMax, remaining: def.fuelMax, critical: false });
  return id;
}

/** Fly the sim until the entity lands (removed) or the budget runs out. */
function runUntilLanded(game, id, maxTicks = 4000) {
  const dt = 1 / 60;
  let ticks = 0;
  let landed = 0;
  game.bus.on("aircraft:landed", () => landed++);
  while (game.world.hasEntity(id) && ticks < maxTicks) {
    game.time += dt;
    game.movement(dt);
    game.landing(dt);
    ticks++;
  }
  return { removed: !game.world.hasEntity(id), landed, ticks };
}

// --- (a) route ending SHORT of the threshold / cone mouth -------------------

test("a route ending SHORT of the approach cone captures, locks and lands", () => {
  const game = makeGame();
  const runway = game.map.runways[0]; // 09/27, heading 0 (east)
  const thr = runwayThreshold(runway);
  // End well BEFORE the cone mouth (coneLength 140): 260px back from threshold.
  const endX = thr.x - 260;
  const endY = thr.y;
  const id = spawn(game, AircraftKind.LIGHT, endX - 60, endY, 0);
  const route = [
    { x: endX - 60, y: endY },
    { x: endX - 30, y: endY },
    { x: endX, y: endY },
  ];
  finalizePath(game, id, route);
  const path = game.world.getComponent(id, Components.Path);
  assert.ok(path.locked, "short approach is captured/locked");
  assert.ok(game.world.getComponent(id, Components.Aircraft).clearance, "a clearance is recorded");
  const res = runUntilLanded(game, id);
  assert.ok(res.removed, "short-approach plane landed and was removed");
  assert.equal(res.landed, 1, "exactly one landing");
});

// --- (b) route ending PAST the far end --------------------------------------

test("a route ending PAST the far end captures, locks and lands", () => {
  const game = makeGame();
  const runway = game.map.runways[0];
  const thr = runwayThreshold(runway);
  const far = runwayFarEnd(runway);
  // End a bit beyond the far/stop end along the landing direction.
  const endX = far.x + 14;
  const endY = far.y;
  const id = spawn(game, AircraftKind.LIGHT, thr.x - 40, thr.y, 0);
  const route = [
    { x: thr.x - 40, y: thr.y },
    { x: thr.x, y: thr.y },
    { x: endX, y: endY },
  ];
  finalizePath(game, id, route);
  const path = game.world.getComponent(id, Components.Path);
  assert.ok(path.locked, "past-the-end approach is captured/locked");
  const res = runUntilLanded(game, id);
  assert.ok(res.removed, "past-the-end plane landed and was removed");
  assert.equal(res.landed, 1, "exactly one landing");
});

// --- (c) route ending slightly OFF-AXIS in heading (~40deg) -----------------

test("an off-axis approach (~40deg, outside the 28deg cone) captures and lands", () => {
  const game = makeGame();
  const runway = game.map.runways[0];
  const thr = runwayThreshold(runway);
  // A drag approaching the threshold from the south-west at ~40deg off the
  // (east) landing direction — outside the strict 28deg cone tol.
  const ang = 40 * DEG;
  const endX = thr.x - 20;
  const endY = thr.y;
  const route = [
    { x: endX - Math.cos(ang) * 80, y: endY - Math.sin(ang) * 80 },
    { x: endX - Math.cos(ang) * 40, y: endY - Math.sin(ang) * 40 },
    { x: endX, y: endY },
  ];
  const heading = approachHeadingFromPath(route);
  assert.ok(Math.abs(heading) > 28 * DEG, "drawn heading is outside the 28deg cone tol");
  const id = spawn(game, AircraftKind.LIGHT, route[0].x, route[0].y, heading);
  finalizePath(game, id, route);
  const path = game.world.getComponent(id, Components.Path);
  assert.ok(path.locked, "off-axis approach is captured/locked");
  const res = runUntilLanded(game, id);
  assert.ok(res.removed, "off-axis plane landed and was removed");
  assert.equal(res.landed, 1, "exactly one landing");
});

// --- (d) a CURVED approach whose tail wobbles -------------------------------

test("a curved approach with a wobbly tail still captures and lands", () => {
  const game = makeGame();
  const runway = game.map.runways[0];
  const thr = runwayThreshold(runway);
  // A sweeping curve that straightens out near the threshold but still jitters
  // on the last couple of samples.
  const route = [
    { x: thr.x - 160, y: thr.y - 90 },
    { x: thr.x - 120, y: thr.y - 55 },
    { x: thr.x - 80, y: thr.y - 25 },
    { x: thr.x - 45, y: thr.y - 6 },
    { x: thr.x - 20, y: thr.y + 4 },
    { x: thr.x, y: thr.y },
  ];
  const id = spawn(game, AircraftKind.LIGHT, route[0].x, route[0].y, 0);
  finalizePath(game, id, route);
  const path = game.world.getComponent(id, Components.Path);
  assert.ok(path.locked, "curved approach is captured/locked");
  const res = runUntilLanded(game, id);
  assert.ok(res.removed, "curved-approach plane landed and was removed");
  assert.equal(res.landed, 1, "exactly one landing");
});

// --- Helipad: ON the pad and NEAR the pad from two headings -----------------

test("a helicopter route ending ON the helipad lands", () => {
  const game = makeGame();
  const pad = game.map.helipad;
  const id = spawn(game, AircraftKind.HELICOPTER, pad.x - 60, pad.y - 60, 0);
  const route = [
    { x: pad.x - 60, y: pad.y - 60 },
    { x: pad.x - 20, y: pad.y - 20 },
    { x: pad.x, y: pad.y },
  ];
  finalizePath(game, id, route);
  assert.ok(game.world.getComponent(id, Components.Path).locked, "on-pad route locks");
  const res = runUntilLanded(game, id);
  assert.ok(res.removed, "helicopter landed on the pad");
  assert.equal(res.landed, 1, "exactly one landing");
});

test("a helicopter route ending NEAR the pad lands from two different headings", () => {
  const pad = createMap("map1", 400, 700).helipad;
  for (const ang of [20 * DEG, 200 * DEG]) {
    const game = makeGame();
    const p = game.map.helipad;
    // End a little off the pad center (within the capture band) approaching from
    // opposite sides.
    const endX = p.x + Math.cos(ang) * (p.radius * 1.9);
    const endY = p.y + Math.sin(ang) * (p.radius * 1.9);
    const id = spawn(game, AircraftKind.HELICOPTER, endX + 50, endY + 50, 0);
    const route = [
      { x: endX + 50, y: endY + 50 },
      { x: endX + 20, y: endY + 20 },
      { x: endX, y: endY },
    ];
    finalizePath(game, id, route);
    assert.ok(
      game.world.getComponent(id, Components.Path).locked,
      `near-pad route locks (heading ${Math.round(ang / DEG)}deg)`
    );
    const res = runUntilLanded(game, id);
    assert.ok(res.removed, `helicopter landed near the pad (heading ${Math.round(ang / DEG)}deg)`);
  }
  // Keep `pad` referenced (readability): the pad is the same across games.
  assert.ok(pad && pad.id === "H1", "map1 primary pad is H1");
});

// --- FORCED assignment rejection --------------------------------------------

test("a plane FORCED to one runway does NOT capture a different runway", () => {
  // Both map1 runways are long enough for a LIGHT plane (len 161/126 >= 63), so
  // without the forced gate a drag near 13/31 would capture it. Force the plane
  // to 09/27 and aim the drag at 13/31: it must NOT capture 13/31.
  const map = createMap("map1", 400, 700);
  const runwayA = map.runways.find((r) => r.id === "09/27");
  const runwayB = map.runways.find((r) => r.id === "13/31");
  const def = getAircraftDef(AircraftKind.LIGHT);

  const thrB = runwayThreshold(runwayB);
  const route = [
    {
      x: thrB.x - Math.cos(runwayB.heading) * 60,
      y: thrB.y - Math.sin(runwayB.heading) * 60,
    },
    {
      x: thrB.x - Math.cos(runwayB.heading) * 25,
      y: thrB.y - Math.sin(runwayB.heading) * 25,
    },
    { x: thrB.x, y: thrB.y },
  ];
  const heading = approachHeadingFromPath(route);

  // Sanity: with NO assignment the drag resolves to 13/31 (would capture).
  const free = snapToLanding(map, route, heading, def, null);
  assert.ok(free.locked && free.clearance.runwayId === "13/31", "unforced drag captures 13/31");

  // FORCED to 09/27: must not capture 13/31.
  const forced = { kind: "runway", runwayId: "09/27", mode: "forced" };
  const snapped = snapToLanding(map, route, heading, def, forced);
  if (snapped.locked) {
    assert.equal(snapped.clearance.runwayId, "09/27", "forced plane only ever captures its runway");
  } else {
    assert.equal(snapped.clearance, null, "forced plane does not capture the wrong runway");
  }

  // The pure capture helper agrees when restricted to the forced id.
  const cap = captureRunway(map, thrB, heading, def, { forcedRunwayId: "09/27" });
  assert.ok(!cap || cap.surface.id === "09/27", "captureRunway honors forcedRunwayId");
  // Keep runwayA referenced.
  assert.ok(runwayA.id === "09/27", "runway A id stable");
});

// --- Anti-over-snapping: perpendicular / far-off still reject ---------------

test("a perpendicular or far-off endpoint does NOT capture", () => {
  const map = createMap("map1", 400, 700);
  const def = getAircraftDef(AircraftKind.LIGHT);
  const runway = map.runways[0];
  const thr = runwayThreshold(runway);

  // 90deg crossing at the threshold: rejected.
  const perp = captureRunway(map, { x: thr.x - 40, y: thr.y }, 90 * DEG, def, {});
  assert.equal(perp, null, "perpendicular approach is not captured");

  // Far off the centerline (120px) laterally: rejected.
  const farOff = captureRunway(map, { x: thr.x - 40, y: thr.y + 120 }, 0, def, {});
  assert.equal(farOff, null, "far-off-centerline endpoint is not captured");

  // Nowhere near any strip: rejected.
  const nowhere = captureRunway(map, { x: 5, y: 5 }, 0, def, {});
  assert.equal(nowhere, null, "an endpoint far from every strip is not captured");
});
