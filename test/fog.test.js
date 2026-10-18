// Unit tests for the FEAT-004 moving fog region + select=communicate behavior.
// All imports are pure / DOM-free at the points exercised here, so these run
// under `node --test` with no canvas:
//   - isPointInFog: inside vs outside a rounded-rect fog bank
//   - driftFogBank: advances the bank by velocity * dt (and decrements life)
//   - fogConceals: HIDDEN for an in-fog plane that is neither ILS nor selected;
//     VISIBLE when the plane is selected OR when ILS is owned, OR out of fog
//   - the weather controller spawns a drifting fog bank on its fog schedule
//   - flightStrips.select() does NOT set a camera target/followId (no camera move)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createFogBank,
  driftFogBank,
  isPointInFog,
  pointInAnyFog,
  fogConceals,
  createWeatherController,
} from "../src/game/weather.js";
import { createRng } from "../src/core/rng.js";
import { createFlightStrips } from "../src/ui/flightStrips.js";
import { createWorld } from "../src/ecs/world.js";
import { Components } from "../src/ecs/components.js";
import { drawAircraft } from "../src/ecs/systems/renderSystem.js";
import { getAircraftDef, AircraftKind } from "../src/game/aircraft.js";

// A no-op Canvas 2D context recorder good enough for drawAircraft: every draw
// method is a no-op, and style props are settable. drawAircraft only needs the
// geometry calls to be harmless; we assert on component state, not pixels.
function makeMockCtx() {
  const noop = () => {};
  const ctx = {
    save: noop,
    restore: noop,
    translate: noop,
    rotate: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    clearRect: noop,
    fillText: noop,
    strokeText: noop,
    setLineDash: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    fillStyle: null,
    strokeStyle: null,
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    globalAlpha: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
  };
  return ctx;
}

// --- isPointInFog ---------------------------------------------------------

test("isPointInFog: true inside the bank, false outside", () => {
  const bank = createFogBank({ x: 100, y: 100, hx: 80, hy: 50, radius: 0 });
  assert.equal(isPointInFog(bank, 100, 100), true, "center inside");
  assert.equal(isPointInFog(bank, 170, 140), true, "within half-extents inside");
  assert.equal(isPointInFog(bank, 100, 160), false, "beyond hy outside");
  assert.equal(isPointInFog(bank, 400, 400), false, "far away outside");
});

test("isPointInFog: rounded corners are cut off", () => {
  // A square bank with a large corner radius: the exact corner is outside.
  const bank = createFogBank({ x: 0, y: 0, hx: 50, hy: 50, radius: 50 });
  assert.equal(isPointInFog(bank, 0, 0), true, "center inside");
  // The geometric corner (50,50) is sqrt(2)*50 ~ 70.7 from center > radius 50.
  assert.equal(isPointInFog(bank, 50, 50), false, "rounded corner excluded");
  // A point straight out along an axis at the edge is still inside.
  assert.equal(isPointInFog(bank, 49, 0), true, "axis edge inside");
});

test("pointInAnyFog finds the covering bank or null", () => {
  const a = createFogBank({ x: 0, y: 0, hx: 20, hy: 20 });
  const b = createFogBank({ id: 2, x: 200, y: 0, hx: 20, hy: 20 });
  assert.equal(pointInAnyFog([a, b], 200, 0), b, "finds second bank");
  assert.equal(pointInAnyFog([a, b], 500, 500), null, "none covers => null");
  assert.equal(pointInAnyFog(null, 0, 0), null, "null list => null");
});

// --- driftFogBank ---------------------------------------------------------

test("driftFogBank moves the bank by velocity * dt and decrements life", () => {
  const bank = createFogBank({ x: 0, y: 0, hx: 40, hy: 40, vx: 10, vy: -4, life: 30 });
  driftFogBank(bank, 2);
  assert.equal(bank.x, 20, "x advanced by vx*dt");
  assert.equal(bank.y, -8, "y advanced by vy*dt");
  assert.equal(bank.life, 28, "life decremented by dt");
});

test("driftFogBank leaves an infinite life untouched", () => {
  const bank = createFogBank({ x: 0, y: 0, vx: 5, vy: 0 }); // life defaults Infinity
  driftFogBank(bank, 3);
  assert.equal(bank.x, 15);
  assert.equal(bank.life, Infinity);
});

// --- fogConceals (the pure hide/override decision) ------------------------

test("fogConceals: HIDDEN in fog when neither ILS nor selected", () => {
  const bank = createFogBank({ x: 0, y: 0, hx: 60, hy: 60, radius: 10 });
  assert.equal(fogConceals(bank, 0, 0, {}), true, "in-fog, plain => hidden");
  assert.equal(fogConceals(bank, 0, 0, { selected: false, ilsOwned: false }), true);
});

test("fogConceals: VISIBLE when selected OR when ILS is owned", () => {
  const bank = createFogBank({ x: 0, y: 0, hx: 60, hy: 60, radius: 10 });
  assert.equal(fogConceals(bank, 0, 0, { selected: true }), false, "selected => visible");
  assert.equal(fogConceals(bank, 0, 0, { ilsOwned: true }), false, "ILS => visible");
});

test("fogConceals: VISIBLE when the plane is outside every bank", () => {
  const bank = createFogBank({ x: 0, y: 0, hx: 60, hy: 60 });
  assert.equal(fogConceals(bank, 500, 500, {}), false, "out of fog => visible");
  assert.equal(fogConceals([], 0, 0, {}), false, "no banks => visible");
  assert.equal(fogConceals(null, 0, 0, {}), false, "null banks => visible");
});

test("fogConceals accepts a list of banks", () => {
  const banks = [
    createFogBank({ x: 0, y: 0, hx: 20, hy: 20 }),
    createFogBank({ id: 2, x: 300, y: 300, hx: 40, hy: 40 }),
  ];
  assert.equal(fogConceals(banks, 300, 300, {}), true, "inside the second bank");
  assert.equal(fogConceals(banks, 150, 150, {}), false, "between banks");
});

// --- controller fog schedule ---------------------------------------------

test("weather controller spawns a drifting fog bank on the fog schedule", () => {
  const map = { width: 400, height: 600, center: { x: 200, y: 300 } };
  const wc = createWeatherController({ rng: createRng(99), map });
  assert.equal(wc.fogBanks.length, 0, "no fog banks at start");
  const bank = wc.spawnFogBank();
  assert.ok(bank, "spawnFogBank returns a bank");
  assert.equal(wc.fogBanks.length, 1, "bank is tracked in state");
  assert.ok(bank.hx > 0 && bank.hy > 0, "bank has positive extents");
  // The bank drifts when the controller advances.
  const x0 = bank.x;
  const y0 = bank.y;
  wc.update(1);
  assert.ok(bank.x !== x0 || bank.y !== y0, "bank drifted after an update");
});

// --- stale Render.fogHidden for a never-swept plane -----------------------
//
// drawAircraft returns early on `!render.seen` (a plane the radar beam has not
// yet painted is not drawn). The fix clears Render.fogHidden BEFORE that gate so
// a never-swept plane cannot keep a stale `fogHidden` flag that would briefly
// mis-grey its flight strip. Revert-sensitive: if the clear is removed (or
// placed after the early return) the stale `true` survives and this fails.

test("drawAircraft clears a stale Render.fogHidden on a never-swept plane", () => {
  const game = {
    world: createWorld(),
    map: { center: { x: 200, y: 300 } },
    width: 400,
    height: 600,
    time: 100,
    selectedId: null,
    sweep: 0,
    // No fog banks: even so, the never-swept plane must END at fogHidden=false.
    weather: { fog: { banks: [], active: false }, ilsOwned: false },
  };
  const { world } = game;
  const def = getAircraftDef(AircraftKind.LIGHT);
  const id = world.createEntity();
  world.addComponent(id, Components.Transform, { x: 50, y: 50, heading: 0 });
  world.addComponent(id, Components.Aircraft, { kind: AircraftKind.LIGHT, state: "inbound" });
  // Never swept (seen:false) but carrying a STALE fogHidden=true from a prior
  // position/frame.
  world.addComponent(id, Components.Render, {
    color: def.color,
    size: def.size,
    seen: false,
    fogHidden: true,
  });

  const render = world.getComponent(id, Components.Render);
  assert.equal(render.fogHidden, true, "precondition: stale fogHidden set");

  drawAircraft(makeMockCtx(), world, game, 0);

  assert.equal(render.seen, false, "plane is still unseen (beam at bearing 0 did not reach it this frame)");
  assert.equal(render.fogHidden, false, "stale fogHidden cleared before the seen gate (no grey strip)");
});

// --- select = communicate (no camera move) --------------------------------

test("flightStrips.select() does NOT set a camera target or followId", () => {
  // Minimal game-like object. select() only needs world.hasEntity/getComponent,
  // selectedId, bus, and (importantly) must NOT touch camera.target/followId.
  let emitted = null;
  const game = {
    world: {
      hasEntity: (id) => id === 7,
      getComponent: () => ({ x: 123, y: 456, heading: 0 }),
    },
    bus: { emit: (name, p) => { emitted = { name, p }; } },
    camera: { target: null, followId: null },
    selectedId: null,
  };
  const strips = createFlightStrips(/* container */ null, game);
  strips.select(7);

  assert.equal(game.selectedId, 7, "selection recorded");
  assert.equal(game.camera.target, null, "camera target stays null (view does not move)");
  assert.equal(game.camera.followId, null, "no followId set");
  assert.ok(emitted && emitted.name === "aircraft:selected", "emits aircraft:selected");

  // Re-selecting the same plane does not re-emit (only new selections do).
  emitted = null;
  strips.select(7);
  assert.equal(emitted, null, "no re-emit on same selection");
  assert.equal(game.camera.target, null, "camera still static");
});
