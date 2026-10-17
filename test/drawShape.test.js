// Unit tests for the procedural aircraft icon drawing (FEAT-004). The four
// drawShape(ctx, size) functions must be pure w.r.t. a 2D context: they may
// only call methods / set properties on the passed-in context, never touch a
// DOM global (document/window). This guards the context-only, +x-oriented
// contract so the module keeps importing cleanly under Node and bundling stays
// safe. Run: node --test 'test/**/*.test.js'

import { test } from "node:test";
import assert from "node:assert/strict";

import { AircraftKind, ALL_KINDS, getAircraftDef } from "../src/game/aircraft.js";

// A minimal mock 2D context that records every method call and property set.
// Path/draw methods are no-op recorders; fillStyle/strokeStyle/lineWidth are
// settable (and lineWidth reads back so callers can save/restore it).
function makeMockCtx() {
  const calls = [];
  const state = { fillStyle: null, strokeStyle: null, lineWidth: 1 };
  const record = (name) => (...args) => { calls.push({ name, args }); };
  const ctx = {
    calls,
    beginPath: record("beginPath"),
    closePath: record("closePath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    arc: record("arc"),
    ellipse: record("ellipse"),
    fill: record("fill"),
    stroke: record("stroke"),
    save: record("save"),
    restore: record("restore"),
    setLineDash: record("setLineDash"),
    rotate: record("rotate"),
    translate: record("translate"),
  };
  // Track property assignments so a leaked state change would be observable.
  Object.defineProperty(ctx, "fillStyle", {
    get() { return state.fillStyle; },
    set(v) { state.fillStyle = v; calls.push({ name: "set:fillStyle", args: [v] }); },
  });
  Object.defineProperty(ctx, "strokeStyle", {
    get() { return state.strokeStyle; },
    set(v) { state.strokeStyle = v; calls.push({ name: "set:strokeStyle", args: [v] }); },
  });
  Object.defineProperty(ctx, "lineWidth", {
    get() { return state.lineWidth; },
    set(v) { state.lineWidth = v; calls.push({ name: "set:lineWidth", args: [v] }); },
  });
  return ctx;
}

test("drawShape: every aircraft kind draws without throwing or touching DOM", () => {
  // If any drawShape referenced a DOM global, importing/running it in this pure
  // Node context would throw a ReferenceError here.
  for (const kind of ALL_KINDS) {
    const def = getAircraftDef(kind);
    assert.equal(typeof def.drawShape, "function", `${kind} has a drawShape fn`);

    const ctx = makeMockCtx();
    // Render system sets fill+stroke to the class color before calling.
    ctx.fillStyle = def.color;
    ctx.strokeStyle = def.color;

    assert.doesNotThrow(() => def.drawShape(ctx, 12), `${kind} drawShape runs`);

    // It must issue real path/draw work.
    const names = ctx.calls.map((c) => c.name);
    assert.ok(names.includes("beginPath"), `${kind} begins a path`);
    assert.ok(
      names.includes("fill") || names.includes("stroke"),
      `${kind} fills or strokes`
    );
  }
});

test("drawShape: each kind produces a recognizably distinct call signature", () => {
  // The helicopter must draw its main rotor + tail-rotor strokes; the airliner
  // and jet fill multiple sub-shapes; the light plane uses the prop arc. We
  // assert distinguishing structure so the icons stay class-specific.
  const sig = (kind) => {
    const def = getAircraftDef(kind);
    const ctx = makeMockCtx();
    ctx.fillStyle = def.color;
    ctx.strokeStyle = def.color;
    def.drawShape(ctx, 12);
    const names = ctx.calls.map((c) => c.name);
    return {
      fills: names.filter((n) => n === "fill").length,
      strokes: names.filter((n) => n === "stroke").length,
      arcs: names.filter((n) => n === "arc").length,
      ellipses: names.filter((n) => n === "ellipse").length,
    };
  };

  // Helicopter: ellipse cabin + rotor circle(s) via arc, and multiple strokes.
  const heli = sig(AircraftKind.HELICOPTER);
  assert.ok(heli.ellipses >= 1, "helicopter draws an ellipse cabin");
  assert.ok(heli.arcs >= 1, "helicopter draws a rotor disc arc");
  assert.ok(heli.strokes >= 2, "helicopter strokes boom + rotor blades");

  // Light plane: uses a propeller arc at the nose.
  const light = sig(AircraftKind.LIGHT);
  assert.ok(light.arcs >= 1, "light plane draws a propeller arc");

  // Commercial airliner: multiple filled sub-shapes (fuselage + wings + tails).
  const commercial = sig(AircraftKind.COMMERCIAL);
  assert.ok(commercial.fills >= 2, "airliner fills several body parts");

  // Supersonic jet: multiple filled sub-shapes (fuselage + delta + canards).
  const jet = sig(AircraftKind.SUPERSONIC);
  assert.ok(jet.fills >= 2, "jet fills several body parts");
});

test("drawShape: restores lineWidth it changed (no state leak)", () => {
  for (const kind of ALL_KINDS) {
    const def = getAircraftDef(kind);
    const ctx = makeMockCtx();
    ctx.fillStyle = def.color;
    ctx.strokeStyle = def.color;
    ctx.lineWidth = 3.5; // a sentinel the render system might have set
    def.drawShape(ctx, 12);
    assert.equal(ctx.lineWidth, 3.5, `${kind} restores lineWidth`);
  }
});
