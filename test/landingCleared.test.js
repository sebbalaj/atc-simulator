// Unit test for the 'landing:cleared' event (FEAT-006). The landing system must
// emit exactly one 'landing:cleared' when an aircraft commits to a landing
// surface (used by the audio engine's "Cleared to land" callout). This drives
// the real ECS landing system headlessly (no DOM), routing a plane onto a
// runway via the pure finalizePath snap logic.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../src/ecs/world.js";
import { createEventBus } from "../src/core/events.js";
import { createMap } from "../src/game/maps.js";
import { Components } from "../src/ecs/components.js";
import { createMovementSystem } from "../src/ecs/systems/movementSystem.js";
import { createLandingSystem } from "../src/ecs/systems/landingSystem.js";
import { finalizePath } from "../src/ui/input.js";
import { AircraftKind, getAircraftDef } from "../src/game/aircraft.js";
import { runwayThreshold } from "../src/game/airport.js";

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

test("landing system emits 'landing:cleared' once when a plane commits", () => {
  const game = makeGame();
  const def = getAircraftDef(AircraftKind.LIGHT);
  const runway = game.map.runways[0];
  const thr = runwayThreshold(runway);

  const startX = thr.x - Math.cos(runway.heading) * 70;
  const startY = thr.y - Math.sin(runway.heading) * 70;

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
  let clearedPayload = null;
  game.bus.on("landing:cleared", (p) => {
    clearedCount++;
    clearedPayload = p;
  });

  // Route ending at the threshold, tracking the landing direction (in-cone).
  const route = [
    { x: startX, y: startY },
    { x: thr.x - Math.cos(runway.heading) * 20, y: thr.y - Math.sin(runway.heading) * 20 },
    { x: thr.x, y: thr.y },
  ];
  finalizePath(game, id, route);
  assert.ok(game.world.getComponent(id, Components.Path).locked, "route is cleared/locked");

  // Advance the sim until the plane touches down (or a generous bound).
  const dt = 1 / 60;
  let ticks = 0;
  while (game.world.hasEntity(id) && ticks < 1200) {
    game.time += dt;
    game.movement(dt);
    game.landing(dt);
    ticks++;
  }

  assert.ok(!game.world.hasEntity(id), "plane landed and was removed");
  assert.equal(clearedCount, 1, "exactly one 'landing:cleared' emitted");
  assert.equal(clearedPayload.surface, "runway", "cleared onto a runway");
});
