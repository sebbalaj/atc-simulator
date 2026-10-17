// FEAT-002 behavior tests: the landing cluster (user reports #4/#5/#6).
//   (a) THRESHOLD LANDING: a cleared plane touches down and is removed the
//       instant it reaches the runway threshold — it does NOT fly the whole
//       rollout to the far end.
//   (b) COLLISION GATING: an aircraft in state 'landing' is excluded from
//       mid-air conflict checks, while two INBOUND planes at the same distance
//       still warn — proving the gate is STATE-based, not distance-based.
//   (c) OCCUPANCY: after a landing the runway is occupied (isRunwayClear false)
//       until now >= occupiedUntil (== land time + clearTime); a second plane is
//       BLOCKED from committing until it clears; and the ground-crew upgrade
//       shrinks the occupied span.
// All imports are pure / DOM-free; the ECS cases drive the real systems
// headlessly like landingCleared.test.js. Assertions are revert-sensitive.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../src/ecs/world.js";
import { createEventBus } from "../src/core/events.js";
import { createSpatialHash } from "../src/core/spatialHash.js";
import { createMap } from "../src/game/maps.js";
import { Components } from "../src/ecs/components.js";
import { createMovementSystem } from "../src/ecs/systems/movementSystem.js";
import { createLandingSystem } from "../src/ecs/systems/landingSystem.js";
import { createCollisionSystem } from "../src/ecs/systems/collisionSystem.js";
import { finalizePath } from "../src/ui/input.js";
import { AircraftKind, getAircraftDef } from "../src/game/aircraft.js";
import {
  runwayThreshold,
  runwayFarEnd,
  isRunwayClear,
  occupyRunway,
} from "../src/game/airport.js";
import { applyUpgrade } from "../src/game/upgrades.js";

function makeGame() {
  const game = {
    world: createWorld(),
    bus: createEventBus(),
    spatial: createSpatialHash(96),
    map: createMap("map1", 400, 700),
    width: 400,
    height: 700,
    time: 0,
    gameOver: false,
    weather: null,
  };
  game.movement = createMovementSystem(game);
  game.landing = createLandingSystem(game);
  game.collision = createCollisionSystem(game);
  return game;
}

function spawnInbound(game, kind, x, y, heading, spawnTime = 0) {
  const def = getAircraftDef(kind);
  const id = game.world.createEntity();
  game.world.addComponent(id, Components.Transform, { x, y, heading });
  game.world.addComponent(id, Components.Velocity, { speed: def.speed });
  game.world.addComponent(id, Components.Aircraft, {
    kind,
    state: "inbound",
    passengers: 2,
    emergency: null,
    spawnTime,
  });
  game.world.addComponent(id, Components.Path, { points: [], progress: 0, locked: false, built: null });
  game.world.addComponent(id, Components.Hitbox, { radius: def.hitboxRadius });
  game.world.addComponent(id, Components.Render, { warning: false });
  game.world.addComponent(id, Components.Fuel, { capacity: def.fuelMax, remaining: def.fuelMax, critical: false });
  return id;
}

// --- (a) THRESHOLD LANDING ---------------------------------------------------

test("a cleared plane lands the instant it reaches the threshold (no full rollout)", () => {
  const game = makeGame();
  const def = getAircraftDef(AircraftKind.LIGHT);
  const runway = game.map.runways[0];
  const thr = runwayThreshold(runway);
  const far = runwayFarEnd(runway);

  // Start just SHORT of the threshold, aligned with the landing direction.
  const startX = thr.x - Math.cos(runway.heading) * 24;
  const startY = thr.y - Math.sin(runway.heading) * 24;

  const id = spawnInbound(game, AircraftKind.LIGHT, startX, startY, runway.heading);

  let landedCount = 0;
  let landedPayload = null;
  game.bus.on("aircraft:landed", (p) => {
    landedCount++;
    landedPayload = p;
  });

  const route = [
    { x: startX, y: startY },
    { x: thr.x, y: thr.y },
  ];
  finalizePath(game, id, route);
  assert.ok(game.world.getComponent(id, Components.Path).locked, "route cleared/locked");

  // Distance threshold -> far end: a full rollout would take this many ticks at
  // the old def.speed*0.55 rollout speed. The threshold landing must resolve in
  // far fewer ticks than that (it does not traverse the strip at all).
  const dt = 1 / 60;
  const rolloutDist = Math.hypot(far.x - thr.x, far.y - thr.y);
  const rolloutTicks = rolloutDist / (def.speed * 0.55) / dt;

  let ticks = 0;
  while (game.world.hasEntity(id) && ticks < 1200) {
    game.time += dt;
    game.movement(dt);
    game.landing(dt);
    ticks++;
  }

  assert.ok(!game.world.hasEntity(id), "plane landed and was removed");
  assert.equal(landedCount, 1, "exactly one 'aircraft:landed' emitted");
  assert.equal(landedPayload.kind, AircraftKind.LIGHT);
  assert.equal(landedPayload.passengers, 2);
  assert.equal(typeof landedPayload.timeInAirspace, "number");
  // Revert-sensitive: the OLD rollout-to-far-end would need ~rolloutTicks more
  // ticks after reaching the threshold. A threshold landing finishes in well
  // under half that budget.
  assert.ok(
    ticks < rolloutTicks * 0.5,
    `landed promptly (${ticks} ticks) rather than rolling the whole runway (~${Math.round(rolloutTicks)} ticks)`
  );
});

// --- (b) COLLISION GATING (state-based, not distance-based) -----------------

test("a plane in state 'landing' is excluded from collision checks; two inbound at the same distance DO warn", () => {
  // LIGHT: hitboxRadius 7 (sum 14), separationRadius 46. A gap of 20 is OUTSIDE
  // the hitbox sum (no crash) but INSIDE the separation bubble (a near-miss),
  // so two inbound planes warn without ending the level.
  const closeDist = 20;

  // Case 1: one plane is 'landing' (on the ground) — NO warning/crash for the pair.
  {
    const game = makeGame();
    const a = spawnInbound(game, AircraftKind.LIGHT, 200, 300, 0);
    const b = spawnInbound(game, AircraftKind.LIGHT, 200 + closeDist, 300, 0);
    // Put plane A on the ground (as commitLanding would).
    game.world.getComponent(a, Components.Aircraft).state = "landing";

    let crashed = false;
    let nearmiss = false;
    game.bus.on("aircraft:crashed", () => (crashed = true));
    game.bus.on("aircraft:nearmiss", () => (nearmiss = true));

    game.collision(1 / 60);

    assert.equal(crashed, false, "no crash when one plane is on the ground (landing)");
    assert.equal(nearmiss, false, "no near-miss when one plane is on the ground (landing)");
    assert.equal(game.world.getComponent(a, Components.Render).warning, false, "landing plane carries no warning ring");
    assert.equal(game.world.getComponent(b, Components.Render).warning, false, "the lone inbound plane is not warned");
    assert.equal(game.gameOver, false, "no game-over from a grounded plane");
  }

  // Case 2: BOTH planes inbound at the SAME distance — they DO warn (proving the
  // exclusion is state-based, not because the distance is safe).
  {
    const game = makeGame();
    const a = spawnInbound(game, AircraftKind.LIGHT, 200, 300, 0);
    const b = spawnInbound(game, AircraftKind.LIGHT, 200 + closeDist, 300, 0);

    let nearmiss = false;
    game.bus.on("aircraft:nearmiss", () => (nearmiss = true));

    game.collision(1 / 60);

    assert.ok(
      nearmiss || game.world.getComponent(a, Components.Render).warning,
      "two inbound planes at the same distance raise a conflict (crash or near-miss)"
    );
  }
});

// --- (c) OCCUPANCY: red/blocked until cleared, ground-crew shrinks the span --

test("after a landing the runway stays occupied until now >= occupiedUntil and blocks a second landing", () => {
  const game = makeGame();
  const def = getAircraftDef(AircraftKind.LIGHT);
  const runway = game.map.runways[0];
  const clearTime = runway.clearTime;
  const thr = runwayThreshold(runway);

  // Fly the first plane onto the threshold and land it.
  const startX = thr.x - Math.cos(runway.heading) * 24;
  const startY = thr.y - Math.sin(runway.heading) * 24;
  const id1 = spawnInbound(game, AircraftKind.LIGHT, startX, startY, runway.heading);
  finalizePath(game, id1, [
    { x: startX, y: startY },
    { x: thr.x, y: thr.y },
  ]);

  const dt = 1 / 60;
  let ticks = 0;
  while (game.world.hasEntity(id1) && ticks < 1200) {
    game.time += dt;
    game.movement(dt);
    game.landing(dt);
    ticks++;
  }
  assert.ok(!game.world.hasEntity(id1), "first plane landed");

  const landTime = game.time;
  assert.ok(
    Math.abs(runway.occupiedUntil - (landTime + clearTime)) < 1e-6,
    "occupiedUntil == land time + clearTime"
  );
  assert.equal(isRunwayClear(runway, landTime), false, "runway occupied right after touchdown");
  assert.equal(isRunwayClear(runway, landTime + clearTime - 0.01), false, "still occupied just before clearTime elapses");
  assert.equal(isRunwayClear(runway, landTime + clearTime), true, "clear once clearTime has elapsed");

  // A second plane routed to the SAME runway cannot commit while occupied.
  const id2 = spawnInbound(game, AircraftKind.LIGHT, startX, startY, runway.heading);
  finalizePath(game, id2, [
    { x: startX, y: startY },
    { x: thr.x, y: thr.y },
  ]);
  assert.ok(game.world.getComponent(id2, Components.Path).locked, "second plane cleared/locked");

  // Advance while the runway is still occupied: the second plane must NOT land.
  const blockedUntilTicks = Math.ceil((runway.occupiedUntil - game.time) / dt);
  for (let i = 0; i < Math.max(1, blockedUntilTicks - 2); i++) {
    game.time += dt;
    game.movement(dt);
    game.landing(dt);
  }
  // It has reached the threshold (route end) but is blocked from committing.
  assert.ok(game.world.hasEntity(id2), "second plane blocked from landing while runway occupied");
  assert.equal(game.world.getComponent(id2, Components.Aircraft).state, "inbound", "second plane still inbound (not committed)");

  // Once the runway clears, it lands.
  ticks = 0;
  while (game.world.hasEntity(id2) && ticks < 1200) {
    game.time += dt;
    game.movement(dt);
    game.landing(dt);
    ticks++;
  }
  assert.ok(!game.world.hasEntity(id2), "second plane lands once the runway clears");
});

test("the ground-crew upgrade reduces the occupied (red) span", () => {
  const baseGame = makeGame();
  const runwayBase = baseGame.map.runways[0];
  const baseClear = runwayBase.clearTime;
  occupyRunway(runwayBase, 0);
  const baseSpan = runwayBase.occupiedUntil - 0;
  assert.ok(Math.abs(baseSpan - baseClear) < 1e-6, "base occupied span == base clearTime");

  // Apply the ground-crew upgrade to a fresh map and re-measure.
  const map = createMap("map1", 400, 700);
  const state = { map, flags: {}, owned: [] };
  const res = applyUpgrade(state, "ground-crew");
  assert.ok(res.ok, "ground-crew upgrade applied");
  const runwayUp = map.runways[0];
  assert.ok(runwayUp.clearTime < baseClear, "ground crew reduced clearTime");
  occupyRunway(runwayUp, 0);
  const upSpan = runwayUp.occupiedUntil - 0;
  assert.ok(upSpan < baseSpan, "occupied (red) span shrinks after hiring ground crew");
});
