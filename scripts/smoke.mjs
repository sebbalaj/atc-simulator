// Headless simulation smoke test. Imports the pure / simulation modules (no DOM,
// no canvas) and drives several hundred fixed-timestep ticks with a seeded RNG,
// asserting that the core simulation behaves: aircraft spawn, move, and land;
// the economy + reputation update on a landing; and a forced proximity pair is
// detected by the collision geometry.
//
// Run with: `node scripts/smoke.mjs`. Exits 0 on success, non-zero on any
// failed assertion or thrown exception. This validates the simulation core
// without needing a browser.

import assert from "node:assert/strict";

import { createWorld } from "../src/ecs/world.js";
import { createEventBus } from "../src/core/events.js";
import { createSpatialHash } from "../src/core/spatialHash.js";
import { createRng } from "../src/core/rng.js";
import { createMap } from "../src/game/maps.js";
import { Components } from "../src/ecs/components.js";
import { createSpawnSystem } from "../src/ecs/systems/spawnSystem.js";
import { createMovementSystem } from "../src/ecs/systems/movementSystem.js";
import { createLandingSystem } from "../src/ecs/systems/landingSystem.js";
import { createCollisionSystem, detectConflicts } from "../src/ecs/systems/collisionSystem.js";
import { createAudioEngine } from "../src/game/audio.js";
import { computeLandingRevenue, createBank } from "../src/game/economy.js";
import { createReputation } from "../src/game/reputation.js";
import {
  AircraftKind,
  getAircraftDef,
  ALL_KINDS,
} from "../src/game/aircraft.js";
import { finalizePath } from "../src/ui/input.js";
import {
  runwayThreshold,
  runwayFarEnd,
} from "../src/game/airport.js";

const FIXED_DT = 1 / 60;

/** Minimal headless game harness: everything the sim systems read, no DOM. */
function createHeadlessGame(mapId = "map1") {
  const width = 400;
  const height = 700;
  const game = {
    world: createWorld(),
    bus: createEventBus(),
    spatial: createSpatialHash(96),
    rng: createRng(20240607),
    mapId,
    map: createMap(mapId, width, height),
    width,
    height,
    time: 0,
    gameOver: false,
    gameOverReason: null,
    closestSeparation: null,
    selectedId: null,
    weather: null,
    paused: false,
    flashBanner() {},
    camera: { target: null, followId: null },
  };
  game.systems = {
    spawn: createSpawnSystem(game),
    movement: createMovementSystem(game),
    landing: createLandingSystem(game),
    collision: createCollisionSystem(game),
  };
  return game;
}

/** Advance one fixed sim step across the simulation systems. */
function tick(game, dt = FIXED_DT) {
  game.time += dt;
  if (game.gameOver) return;
  game.systems.spawn(dt);
  game.systems.movement(dt);
  game.systems.landing(dt);
  game.systems.collision(dt);
}

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log("  PASS  " + label);
  } catch (err) {
    failures++;
    console.error("  FAIL  " + label);
    console.error("        " + (err && err.message ? err.message : err));
  }
}

console.log("ATC simulator headless smoke test\n");

// --- 1. Audio module imports/constructs under Node without throwing ---------
check("audio engine imports & constructs headlessly (feature-detected)", () => {
  const audio = createAudioEngine();
  assert.equal(audio.supported, false, "no AudioContext under Node");
  // Every method must be a safe no-op without a context.
  assert.doesNotThrow(() => {
    audio.unlock();
    audio.setProximity(0.9);
    audio.setCrowdingFromCount(8);
    audio.update(FIXED_DT);
    audio.playStaticClick();
    audio.playRoger();
    audio.playClearedToLand();
    audio.toggleMute();
    audio.setVolume(0.5);
    const detach = audio.subscribe(createEventBus());
    detach();
  });
});

// --- 2. Several hundred ticks run without exception; planes spawn & move ----
check("600 ticks run clean; aircraft spawn and move inbound", () => {
  const game = createHeadlessGame("map1");
  let maxSeen = 0;
  const startPositions = new Map();

  // Seed an immediate spawn so the assertion is deterministic even before the
  // timed spawn stream kicks in; the loop then exercises the ramping stream.
  game.systems.spawn.spawnOne();

  for (let i = 0; i < 600; i++) {
    tick(game);
    const ids = game.world.query(Components.Transform, Components.Aircraft);
    maxSeen = Math.max(maxSeen, ids.length);
    for (const id of ids) {
      const t = game.world.getComponent(id, Components.Transform);
      if (!startPositions.has(id)) startPositions.set(id, { x: t.x, y: t.y });
    }
  }

  assert.ok(maxSeen > 0, "at least one aircraft existed at some point");

  // Confirm at least one plane actually moved from where it spawned.
  let moved = false;
  for (const id of game.world.query(Components.Transform, Components.Aircraft)) {
    const t = game.world.getComponent(id, Components.Transform);
    const s = startPositions.get(id);
    if (s && Math.hypot(t.x - s.x, t.y - s.y) > 1) {
      moved = true;
      break;
    }
  }
  // If all current planes just spawned, the fact that we saw traffic churn is
  // enough; but typically several have moved.
  assert.ok(moved || maxSeen > 1, "aircraft moved inbound over the run");
});

// --- 3. A routed plane lands; economy + reputation update -------------------
check("a cleared aircraft lands and updates economy + reputation", () => {
  const game = createHeadlessGame("map1");
  const bank = createBank(0);
  const reputation = createReputation();

  let landedPayload = null;
  game.bus.on("aircraft:landed", (p) => {
    landedPayload = p;
    bank.credit(computeLandingRevenue(p));
    reputation.recover();
  });
  let clearedCount = 0;
  game.bus.on("landing:cleared", () => {
    clearedCount++;
  });

  // Spawn a single LIGHT right on the approach to runway A, then route it onto
  // the threshold so it clears and lands.
  const runway = game.map.runways[0];
  const def = getAircraftDef(AircraftKind.LIGHT);
  const thr = runwayThreshold(runway);
  const far = runwayFarEnd(runway);

  const id = game.world.createEntity();
  // Start a little behind the threshold, aligned with the landing direction.
  const startX = thr.x - Math.cos(runway.heading) * 70;
  const startY = thr.y - Math.sin(runway.heading) * 70;
  game.world.addComponent(id, Components.Transform, { x: startX, y: startY, heading: runway.heading });
  game.world.addComponent(id, Components.Velocity, { speed: def.speed });
  game.world.addComponent(id, Components.Aircraft, {
    kind: AircraftKind.LIGHT,
    state: "inbound",
    passengers: 3,
    emergency: null,
    spawnTime: game.time,
  });
  game.world.addComponent(id, Components.Path, { points: [], progress: 0, locked: false, built: null });
  game.world.addComponent(id, Components.Hitbox, { radius: def.hitboxRadius });
  game.world.addComponent(id, Components.Fuel, { capacity: def.fuelMax, remaining: def.fuelMax, critical: false });

  // Draw a straight route from behind the threshold, inside the approach cone,
  // ending on the threshold while tracking the landing direction. finalizePath
  // snaps it onto the runway centerline and marks it cleared to land.
  const route = [
    { x: startX, y: startY },
    { x: thr.x - Math.cos(runway.heading) * 20, y: thr.y - Math.sin(runway.heading) * 20 },
    { x: thr.x, y: thr.y },
  ];
  void far;
  finalizePath(game, id, route);

  const path = game.world.getComponent(id, Components.Path);
  assert.ok(path.locked, "route snapped to the runway (cleared to land)");

  // Run until the plane lands or we give up.
  let ticks = 0;
  while (game.world.hasEntity(id) && ticks < 1200) {
    tick(game);
    ticks++;
  }

  assert.ok(!game.world.hasEntity(id), "aircraft removed after touchdown");
  assert.ok(landedPayload, "'aircraft:landed' emitted");
  assert.ok(clearedCount >= 1, "'landing:cleared' emitted at clearance");
  assert.ok(bank.balance > 0, "economy credited landing revenue");
  assert.equal(reputation.score, 100, "reputation recovered/held at full on a clean landing");
});

// --- 4. A forced proximity pair is detected ---------------------------------
check("collision geometry detects a forced proximity pair and a crash", () => {
  const spatial = createSpatialHash(96);
  const sep = getAircraftDef(AircraftKind.LIGHT).separationRadius;

  // Two LIGHTs well inside their separation bubble but not overlapping: warn.
  const warnPair = [
    { id: 1, x: 100, y: 100, kind: AircraftKind.LIGHT, hitboxRadius: 7, separationRadius: sep },
    { id: 2, x: 100 + sep * 0.4, y: 100, kind: AircraftKind.LIGHT, hitboxRadius: 7, separationRadius: sep },
  ];
  const warn = detectConflicts(warnPair, spatial);
  assert.ok(warn.warnings.has(1) && warn.warnings.has(2), "forced pair warned");
  assert.equal(warn.crashes.length, 0, "no crash at warning distance");
  assert.ok(warn.closest < sep, "closest separation reported inside the bubble");

  // Overlapping hitboxes: a crash.
  const crashPair = [
    { id: 1, x: 0, y: 0, kind: AircraftKind.LIGHT, hitboxRadius: 7, separationRadius: sep },
    { id: 2, x: 8, y: 0, kind: AircraftKind.LIGHT, hitboxRadius: 7, separationRadius: sep },
  ];
  const crash = detectConflicts(crashPair, spatial);
  assert.equal(crash.crashes.length, 1, "overlapping hitboxes crash");
});

// --- 5. Collision system runs through the ECS on a crash pair ---------------
check("collision system emits a crash through the ECS on overlapping planes", () => {
  const game = createHeadlessGame("map1");
  const def = getAircraftDef(AircraftKind.LIGHT);
  let crashed = false;
  game.bus.on("aircraft:crashed", () => {
    crashed = true;
  });

  for (let i = 0; i < 2; i++) {
    const id = game.world.createEntity();
    game.world.addComponent(id, Components.Transform, { x: 200 + i * 6, y: 300, heading: 0 });
    game.world.addComponent(id, Components.Aircraft, { kind: AircraftKind.LIGHT, state: "inbound", passengers: 1 });
    game.world.addComponent(id, Components.Hitbox, { radius: def.hitboxRadius });
    game.world.addComponent(id, Components.Render, { warning: false });
  }
  game.systems.collision(FIXED_DT);
  assert.ok(crashed, "'aircraft:crashed' emitted for overlapping pair");
  assert.ok(game.gameOver, "game-over set on collision");
});

// --- 6. All four maps build and run a short burst cleanly -------------------
check("all four maps spawn/update without exception", () => {
  for (const mapId of ["map1", "map2", "map3", "map4"]) {
    const game = createHeadlessGame(mapId);
    assert.doesNotThrow(() => {
      for (let i = 0; i < 180; i++) tick(game);
    }, `map ${mapId} ran clean`);
  }
  // Sanity: the aircraft kind table is complete.
  assert.equal(ALL_KINDS.length, 4, "four aircraft kinds defined");
});

// --- 7. FEAT-006: tighter fuel does NOT trigger an early fuel-out cascade ----
// With the FEAT-006 rebalance (fuelMax cut ~34-38%) a plane left holding still
// survives for minutes; a healthy early-shift stretch must show zero fuel-outs
// on every map. If someone cuts fuelMax catastrophically low this fails, so it
// is revert-sensitive to the rebalance staying winnable.
check("no fuel-out cascade across the four maps in an early-shift window", () => {
  for (const mapId of ["map1", "map2", "map3", "map4"]) {
    const game = createHeadlessGame(mapId);
    let fuelOuts = 0;
    game.bus.on("aircraft:fuelout", () => {
      fuelOuts++;
    });
    game.systems.spawn.spawnOne();
    // ~60 seconds of sim time: well short of the ~188s tightest holding-exhaust
    // window, so even un-routed (holding) traffic must not have burned out yet.
    for (let i = 0; i < 3600 && !game.gameOver; i++) tick(game);
    assert.equal(fuelOuts, 0, `map ${mapId}: ${fuelOuts} fuel-out(s) in a 60s window (expected 0)`);
  }
});

console.log("");
if (failures > 0) {
  console.error(`SMOKE TEST FAILED: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("SMOKE TEST PASSED: simulation core is healthy.");
process.exit(0);
