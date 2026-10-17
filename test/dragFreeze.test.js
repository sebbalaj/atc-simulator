// Regression test for the drag-freeze bug (user report #3 / FEAT-001). While
// the player is drawing a new route, the aircraft MUST keep flying its current
// committed Path; the route only switches on pointerup (finalizePath). The old
// bug mutated the live Path on every pointer move (path.points = drawing
// points; path.built=null; path.progress=0; path.locked=false), rebuilding the
// route from the drag-start origin and zeroing progress, so the plane "stopped
// midair".
//
// attachInput is browser-coupled (Pointer Events), so we exercise the pure/ECS
// behavior directly: a committed Path advanced by the REAL movement system
// while an un-finalized draw is published only to the display-only preview
// channel (setDrawPreview). The invariant: an un-finalized draw never zeroes or
// rebuilds the committed Path. Then finalizePath switches the plane to the new
// route.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../src/ecs/world.js";
import { createEventBus } from "../src/core/events.js";
import { createMap } from "../src/game/maps.js";
import { Components } from "../src/ecs/components.js";
import { createMovementSystem } from "../src/ecs/systems/movementSystem.js";
import { finalizePath, setDrawPreview } from "../src/ui/input.js";
import { AircraftKind, getAircraftDef } from "../src/game/aircraft.js";

function makeGame() {
  const game = {
    world: createWorld(),
    bus: createEventBus(),
    map: createMap("map1", 400, 700),
    time: 0,
    gameOver: false,
    weather: null,
    drawPreview: null,
  };
  game.movement = createMovementSystem(game);
  return game;
}

test("aircraft keeps flying its committed path while a new route is being drawn", () => {
  const game = makeGame();
  const { world } = game;
  const def = getAircraftDef(AircraftKind.LIGHT);

  // A committed multi-point route heading to the right across the field.
  const startX = 120;
  const startY = 350;
  const committed = [
    { x: startX, y: startY },
    { x: startX + 60, y: startY },
    { x: startX + 120, y: startY },
  ];

  const id = world.createEntity();
  world.addComponent(id, Components.Transform, { x: startX, y: startY, heading: 0 });
  world.addComponent(id, Components.Aircraft, {
    kind: AircraftKind.LIGHT,
    state: "inbound",
    passengers: 2,
    emergency: null,
    spawnTime: 0,
  });
  world.addComponent(id, Components.Path, { points: committed.slice(), progress: 0, locked: false, built: null });
  world.addComponent(id, Components.Fuel, { capacity: def.fuelMax, remaining: def.fuelMax, critical: false });

  const dt = 1 / 60;

  // Fly forward a bit on the committed path.
  for (let i = 0; i < 60; i++) {
    game.time += dt;
    game.movement(dt);
  }

  const path = world.getComponent(id, Components.Path);
  const t = world.getComponent(id, Components.Transform);
  const progressBeforeDraw = path.progress;
  const xBeforeDraw = t.x;
  assert.ok(progressBeforeDraw > 0, "plane advanced along its committed path before any drag");
  assert.ok(xBeforeDraw > startX + 1, "plane moved forward (x increased) before any drag");
  assert.ok(!path.locked, "committed path is unlocked here");

  // Capture the committed built polyline identity so we can prove it is not
  // rebuilt by an un-finalized draw.
  const builtBeforeDraw = path.built;
  assert.ok(builtBeforeDraw, "committed path has a built polyline");

  // Begin a NEW drawing from the plane's current position (as onPointerDown
  // would) and append preview points over time WITHOUT finalizing. This mirrors
  // onPointerMove: publish only to the display-only preview channel.
  const drawStart = { x: t.x, y: t.y };
  const drawing = { id, points: [{ x: drawStart.x, y: drawStart.y }] };

  const sampledProgress = [];
  const sampledX = [];
  for (let i = 0; i < 90; i++) {
    // Simulate the player dragging upward to draw a new route.
    drawing.points.push({ x: drawStart.x + i * 2, y: drawStart.y - i * 2 });
    game.drawPreview = setDrawPreview(drawing.id, drawing.points);

    game.time += dt;
    game.movement(dt);

    sampledProgress.push(path.progress);
    sampledX.push(t.x);
  }

  // INVARIANT: the committed Path was never zeroed/rebuilt by the draw.
  assert.ok(path.progress > progressBeforeDraw, "progress kept INCREASING during the un-finalized draw");
  assert.ok(t.x > xBeforeDraw, "plane kept moving forward during the draw (did not freeze)");
  assert.ok(!path.locked, "un-finalized draw did not lock the committed path");
  assert.equal(path.built, builtBeforeDraw, "committed built polyline was NOT rebuilt during the draw");

  // Progress must be monotonically non-decreasing throughout the draw: no reset
  // back to the drag-start position (the old bug zeroed progress every move).
  for (let i = 1; i < sampledProgress.length; i++) {
    assert.ok(
      sampledProgress[i] >= sampledProgress[i - 1] - 1e-9,
      `progress must not reset during draw (step ${i}: ${sampledProgress[i - 1]} -> ${sampledProgress[i]})`
    );
    assert.ok(
      sampledX[i] >= sampledX[i - 1] - 1e-9,
      `x must not snap back during draw (step ${i})`
    );
  }

  // The display-only preview reflects the drawn route (purely visual).
  assert.ok(game.drawPreview && game.drawPreview.id === id, "preview channel holds the in-progress route");
  assert.ok(game.drawPreview.points.length >= 2, "preview has the drawn points");

  // Now the player lifts off (pointerup): finalize onto the new route.
  const newRoute = drawing.points.slice();
  const yAtFinalize = t.y;
  finalizePath(game, id, newRoute);
  game.drawPreview = null;

  // The plane has adopted the new route: progress reset to the start of the new
  // path (finalizePath sets progress = 0) and the built polyline was rebuilt.
  const pathAfter = world.getComponent(id, Components.Path);
  assert.equal(pathAfter.progress, 0, "finalizePath reset progress for the new route");
  assert.notEqual(pathAfter.built, builtBeforeDraw, "a new built polyline was produced on commit");

  // Advancing now follows the NEW route (heading up/left as drawn), proving the
  // switch only happened on finalize.
  for (let i = 0; i < 30; i++) {
    game.time += dt;
    game.movement(dt);
  }
  assert.ok(pathAfter.progress > 0, "plane advances along the newly committed route after finalize");
  // The new route was drawn trending upward (decreasing y); after following it
  // the plane's y should move up from where it was at finalize, proving the
  // route switch only happened on commit.
  assert.ok(t.y < yAtFinalize, "plane now tracks the newly drawn (upward) route");
});
