// FEAT-003: wind dictates a runway's landable direction, ONE way at a time,
// with a brief TRANSITION WINDOW on a shift during which BOTH ends are
// routable. Planes ALREADY ROUTED (locked clearance) before/at a shift land
// anyway. This suite covers:
//   (a) steady state: exactly ONE direction legal (into-wind); the opposite end
//       is illegal for NEW clearances.
//   (b) immediately after shiftWind(): transition active, BOTH ends legal.
//   (c) after the transition timer elapses: only the NEW end legal, old illegal.
//   (d) ECS: a plane routed + locked into the into-wind end STILL lands after a
//       wind flip that makes that direction illegal (clearance honored).
//   (e) a NEW routing attempt to the now-illegal end after the transition does
//       NOT clear.
// Pure helpers are tested directly; the ECS cases drive the real movement +
// landing systems headlessly (same pattern as landingBehavior.test.js).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createWeatherController,
  activeLandingDirections,
  isLandingDirectionLegal,
  isApproachDirectionValid,
} from "../src/game/weather.js";
import { createRng } from "../src/core/rng.js";
import { normalizeAngle } from "../src/game/airport.js";

import { createWorld } from "../src/ecs/world.js";
import { createEventBus } from "../src/core/events.js";
import { createSpatialHash } from "../src/core/spatialHash.js";
import { createMap } from "../src/game/maps.js";
import { Components } from "../src/ecs/components.js";
import { createMovementSystem } from "../src/ecs/systems/movementSystem.js";
import { createLandingSystem } from "../src/ecs/systems/landingSystem.js";
import { finalizePath, snapToLanding } from "../src/ui/input.js";
import { AircraftKind, getAircraftDef } from "../src/game/aircraft.js";
import { runwayThreshold, approachHeadingFromPath } from "../src/game/airport.js";

// A runway with base heading 0 (lands toward +x/east). Into-wind legality is
// decided against the wind "blowing toward" direction.
const runway0 = { id: "09/27", heading: 0 };

// --- (a) steady state: exactly one direction legal ---------------------------

test("steady state: exactly ONE runway direction is legal (into the wind); the opposite is illegal", () => {
  // Wind blows toward PI (west) => legal landing heading is east (0).
  const windState = { windDirection: Math.PI, windTolerance: Math.PI / 2 };
  const legal = activeLandingDirections(runway0, windState);
  assert.equal(legal.length, 1, "exactly one landing direction legal at steady state");
  assert.ok(Math.abs(normalizeAngle(legal[0] - 0)) < 1e-6, "the legal end is heading 0 (into the west wind)");
  // The reciprocal end (heading PI) is illegal.
  assert.ok(isLandingDirectionLegal(0, windState), "east end legal");
  assert.ok(!isLandingDirectionLegal(Math.PI, windState), "west end illegal at steady state");
});

// --- (b) after a shift: transition active, BOTH ends legal -------------------

test("immediately after a wind shift a transition is active and BOTH ends are legal", () => {
  const wc = createWeatherController({ rng: createRng(7), map: null });
  // Pin a known start so the flip is deterministic in direction.
  wc.state.windDirection = Math.PI; // legal end = east (0)
  wc.shiftWind(); // now blows ~east; previous (west) still honored in the window

  assert.equal(wc.state.windTransition.active, true, "transition window open after shiftWind");
  const snap = wc.windStateSnapshot();
  const legal = activeLandingDirections(runway0, snap);
  assert.equal(legal.length, 2, "BOTH ends legal during the transition window");
  assert.ok(isLandingDirectionLegal(0, snap), "old into-wind end still legal during transition");
  assert.ok(isLandingDirectionLegal(Math.PI, snap), "new into-wind end legal during transition");
});

// --- (c) after the timer elapses: only the NEW end legal ---------------------

test("after the transition timer elapses only the NEW end is legal and the OLD end is illegal", () => {
  const wc = createWeatherController({ rng: createRng(7), map: null });
  wc.state.windDirection = Math.PI; // legal end = east (0)
  // Suppress scatter so the flip is a clean 180 (east wind => legal end = west).
  wc.shiftWind();
  wc.state.windDirection = 0; // blows east => legal landing heading = PI (west)
  wc.state.windTransition.toDirection = 0;

  // Advance well past the transition window (default 8s).
  for (let i = 0; i < 200; i++) wc.update(1 / 10); // 20s of sim time

  assert.equal(wc.state.windTransition.active, false, "transition window closed");
  const snap = wc.windStateSnapshot();
  const legal = activeLandingDirections(runway0, snap);
  assert.equal(legal.length, 1, "exactly one legal direction after the window closes");
  assert.ok(Math.abs(normalizeAngle(legal[0] - Math.PI)) < 1e-6, "the legal end is now the reciprocal (west)");
  assert.ok(!isLandingDirectionLegal(0, snap), "the OLD end (east) is now illegal");
  assert.ok(isLandingDirectionLegal(Math.PI, snap), "the NEW end (west) is legal");
});

// --- ECS harness -------------------------------------------------------------

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
    // A plain mutable wind snapshot (no controller) that the landing system and
    // input snap read exactly like the published game.weather.
    weather: {
      windDirection: Math.PI, // blows west => legal landing heading east (0)
      windTolerance: Math.PI / 2,
      windPrevDirection: null,
      windTransition: { active: false, fromDirection: null, toDirection: null, remaining: 0 },
    },
  };
  game.movement = createMovementSystem(game);
  game.landing = createLandingSystem(game);
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

// --- (d) an already-routed (locked) plane lands after a wind flip ------------

test("a plane already routed with a LOCKED clearance lands even after the wind flips against it", () => {
  const game = makeGame();
  // Pick the runway whose heading-0 end is the into-wind (legal) end.
  const runway = game.map.runways.find((r) => Math.abs(normalizeAngle(r.heading)) < 1e-6) || game.map.runways[0];
  const thr = runwayThreshold({ ...runway, heading: 0 });

  // Start short of the threshold, aligned east (into the west wind => legal).
  const startX = thr.x - Math.cos(0) * 24;
  const startY = thr.y - Math.sin(0) * 24;
  const id = spawnInbound(game, AircraftKind.LIGHT, startX, startY, 0);

  finalizePath(game, id, [
    { x: startX, y: startY },
    { x: thr.x, y: thr.y },
  ]);
  const path = game.world.getComponent(id, Components.Path);
  const ac = game.world.getComponent(id, Components.Aircraft);
  assert.ok(path.locked, "route cleared/locked while the direction was legal");
  assert.ok(ac.clearance && ac.clearance.surface === "runway", "runway clearance recorded");
  const clearedHeading = ac.clearance.heading;

  // Now the wind FLIPS so the cleared direction is illegal (no transition
  // window active: a hard reversal that would reject a NEW clearance).
  game.weather.windDirection = 0; // blows east => legal landing = west (PI)
  game.weather.windPrevDirection = null;
  game.weather.windTransition = { active: false, fromDirection: null, toDirection: null, remaining: 0 };
  assert.ok(
    !isLandingDirectionLegal(clearedHeading, game.weather),
    "the cleared direction is now wind-illegal for NEW clearances"
  );

  let landed = false;
  game.bus.on("aircraft:landed", () => (landed = true));

  const dt = 1 / 60;
  let ticks = 0;
  while (game.world.hasEntity(id) && ticks < 1200) {
    game.time += dt;
    game.movement(dt);
    game.landing(dt);
    ticks++;
  }
  assert.ok(!game.world.hasEntity(id), "the already-routed plane STILL landed after the wind flip");
  assert.ok(landed, "'aircraft:landed' emitted for the honored clearance");
});

// --- (e) a NEW routing attempt to the now-illegal end does NOT clear ---------

test("a NEW routing attempt to the now-illegal (down-wind) end does NOT clear", () => {
  const game = makeGame();
  // Flip the wind first: now blows east, so the legal landing heading is west
  // (PI). A fresh route drawn into the EAST (0) end must be rejected.
  game.weather.windDirection = 0;
  game.weather.windPrevDirection = null;
  game.weather.windTransition = { active: false, fromDirection: null, toDirection: null, remaining: 0 };

  const runway = game.map.runways.find((r) => Math.abs(normalizeAngle(r.heading)) < 1e-6) || game.map.runways[0];
  const thr = runwayThreshold({ ...runway, heading: 0 });
  const startX = thr.x - Math.cos(0) * 24;
  const startY = thr.y - Math.sin(0) * 24;
  const def = getAircraftDef(AircraftKind.LIGHT);

  const route = [
    { x: startX, y: startY },
    { x: thr.x, y: thr.y },
  ];
  const heading = approachHeadingFromPath(route);
  const snapped = snapToLanding(game.map, route, heading, def, null, game.weather);
  assert.ok(!snapped.locked, "a new route to the down-wind end is not locked");
  assert.equal(snapped.clearance, null, "no clearance recorded for the illegal direction");

  // And through the real input layer: no clearance is set on the aircraft.
  const id = spawnInbound(game, AircraftKind.LIGHT, startX, startY, 0);
  finalizePath(game, id, route);
  const ac = game.world.getComponent(id, Components.Aircraft);
  const path = game.world.getComponent(id, Components.Path);
  assert.equal(path.locked, false, "input layer did not lock a down-wind clearance");
  assert.equal(ac.clearance, null, "no clearance on the aircraft for the illegal end");
});

// --- (f) ECS/snap-level transition window with a game.weather-shaped object --
//
// Revert-sensitive: this drives finalizePath / the landing-system fallback with
// a LIVE game.weather object whose transition descriptor is named
// `windTransition` (exactly as weatherSystem publishes it), NOT the
// `transition`-shaped snapshot the pure-helper tests feed. It asserts the OLD
// into-wind end is routable DURING an active transition window and NOT routable
// after it closes. Against the old field-name mismatch (helpers read only
// `windState.transition`) the OLD end would be rejected during the window, so
// this case FAILS pre-fix and PASSES post-fix.

test("ECS/snap: during an ACTIVE transition the OLD into-wind end is routable via game.weather.windTransition", () => {
  const game = makeGame();
  // Steady state before the shift: wind blows west (PI) => legal landing = east
  // (0). Then the wind flips to blow east (0) => new legal landing = west (PI),
  // but a transition window keeps the OLD east (0) end routable briefly.
  game.weather.windDirection = 0; // now blows east => new legal end = west (PI)
  game.weather.windPrevDirection = Math.PI; // previous wind blew west
  game.weather.windTransition = {
    active: true,
    fromDirection: Math.PI, // into-wind end for the PREVIOUS wind = east (0)
    toDirection: 0,
    remaining: 8,
  };

  // Sanity on the pure legality using the LIVE object shape: the OLD east end
  // (heading 0) must be legal ONLY because the transition is honored.
  assert.ok(
    isLandingDirectionLegal(0, game.weather),
    "OLD into-wind end (east/0) is legal during the transition window (game.weather shape)"
  );

  const runway = game.map.runways.find((r) => Math.abs(normalizeAngle(r.heading)) < 1e-6) || game.map.runways[0];
  const thr = runwayThreshold({ ...runway, heading: 0 });
  const startX = thr.x - Math.cos(0) * 24;
  const startY = thr.y - Math.sin(0) * 24;
  const def = getAircraftDef(AircraftKind.LIGHT);
  const route = [
    { x: startX, y: startY },
    { x: thr.x, y: thr.y },
  ];
  const heading = approachHeadingFromPath(route);

  // Snap layer: a route into the OLD east end clears during the window.
  const snapped = snapToLanding(game.map, route, heading, def, null, game.weather);
  assert.ok(snapped.locked, "route to the OLD end clears DURING the transition window");
  assert.ok(
    snapped.clearance && snapped.clearance.surface === "runway",
    "runway clearance recorded for the OLD end during the window"
  );
  assert.ok(
    Math.abs(normalizeAngle(snapped.clearance.heading - 0)) < 1e-3,
    "the cleared direction is the OLD east end (heading 0)"
  );

  // ECS input layer: finalizePath records the clearance too.
  const id = spawnInbound(game, AircraftKind.LIGHT, startX, startY, 0);
  finalizePath(game, id, route);
  const ac = game.world.getComponent(id, Components.Aircraft);
  const path = game.world.getComponent(id, Components.Path);
  assert.ok(path.locked, "finalizePath locked the OLD-end clearance during the window");
  assert.ok(ac.clearance && ac.clearance.surface === "runway", "clearance set on the aircraft during the window");

  // Now CLOSE the transition window: the OLD east end must become illegal for a
  // fresh route, while the NEW west end stays legal.
  game.weather.windPrevDirection = null;
  game.weather.windTransition = { active: false, fromDirection: null, toDirection: null, remaining: 0 };
  assert.ok(
    !isLandingDirectionLegal(0, game.weather),
    "OLD east end is illegal AFTER the window closes (game.weather shape)"
  );
  const snappedAfter = snapToLanding(game.map, route, heading, def, null, game.weather);
  assert.ok(!snappedAfter.locked, "a NEW route to the OLD end does NOT clear after the window closes");
  assert.equal(snappedAfter.clearance, null, "no clearance for the OLD end after the window closes");
});

// --- Sanity: the pure helper agrees with isApproachDirectionValid ------------

test("isLandingDirectionLegal with no transition matches isApproachDirectionValid", () => {
  const windState = { windDirection: Math.PI, windTolerance: Math.PI / 2 };
  for (const h of [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    assert.equal(
      isLandingDirectionLegal(h, windState),
      isApproachDirectionValid(h, Math.PI, Math.PI / 2),
      `direction ${h} agrees`
    );
  }
});
