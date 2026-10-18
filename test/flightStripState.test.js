// Unit tests for the pure flight-strip helpers: stripColorState() precedence
// and assignmentLabel() forced-vs-preferred-vs-any formatting. These exercise
// the DOM-free decision logic extracted from src/ui/flightStrips.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripColorState,
  assignmentLabel,
  isRoutedToLand,
  STRIP_STATES,
} from "../src/ui/flightStrips.js";

test("STRIP_STATES lists the five states, highest precedence first", () => {
  assert.deepEqual(STRIP_STATES, ["red", "red-blink", "grey", "blue", "green"]);
});

test("emergency outranks everything => solid red", () => {
  const state = stripColorState({
    emergency: true,
    fuelLow: true,
    proximity: true,
    fogHidden: true,
    selected: false,
    routedToLand: true,
  });
  assert.equal(state, "red");
});

test("low fuel (no emergency) => solid red, outranks proximity/fog/routing", () => {
  assert.equal(
    stripColorState({
      fuelLow: true,
      proximity: true,
      fogHidden: true,
      routedToLand: true,
    }),
    "red"
  );
});

test("proximity only (no emergency/low fuel) => blinking red", () => {
  assert.equal(
    stripColorState({
      proximity: true,
      fogHidden: true,
      routedToLand: true,
    }),
    "red-blink"
  );
});

test("proximity outranks fog and routing but NOT emergency/low-fuel", () => {
  assert.equal(stripColorState({ proximity: true }), "red-blink");
  assert.equal(stripColorState({ proximity: true, emergency: true }), "red");
});

test("fog-hidden AND not selected => grey", () => {
  assert.equal(
    stripColorState({ fogHidden: true, selected: false, routedToLand: true }),
    "grey"
  );
});

test("fog-hidden AND selected => NOT grey (falls through to blue/green)", () => {
  // Selected + routed falls through to blue.
  assert.equal(
    stripColorState({ fogHidden: true, selected: true, routedToLand: true }),
    "blue"
  );
  // Selected + unrouted falls through to green.
  assert.equal(
    stripColorState({ fogHidden: true, selected: true, routedToLand: false }),
    "green"
  );
});

test("routed to land (no higher state) => blue", () => {
  assert.equal(stripColorState({ routedToLand: true }), "blue");
});

test("default (unrouted, high fuel, visible) => green", () => {
  assert.equal(stripColorState({}), "green");
  assert.equal(
    stripColorState({
      emergency: false,
      fuelLow: false,
      proximity: false,
      fogHidden: false,
      selected: false,
      routedToLand: false,
    }),
    "green"
  );
});

test("assignmentLabel marks FORCED distinctly", () => {
  const out = assignmentLabel({ kind: "runway", runwayId: "09L", mode: "forced" });
  assert.equal(out.mode, "forced");
  assert.ok(out.text.startsWith("!"), "forced uses the '!' hard marker");
  assert.ok(out.text.includes("09L"));
});

test("assignmentLabel marks PREFERRED distinctly with an arrow", () => {
  const out = assignmentLabel({ kind: "runway", runwayId: "27", mode: "preferred" });
  assert.equal(out.mode, "preferred");
  assert.ok(out.text.includes("\u2192"), "preferred uses the '->' soft marker");
  assert.ok(out.text.includes("27"));
});

test("assignmentLabel marks helipad forced with the pad id", () => {
  const out = assignmentLabel({ kind: "helipad", padId: "H1", mode: "forced" });
  assert.equal(out.mode, "forced");
  assert.equal(out.text, "!H1");
});

test("assignmentLabel treats any/null/missing-id as don't-care 'ANY'", () => {
  assert.deepEqual(assignmentLabel(null), { text: "ANY", mode: "any" });
  assert.deepEqual(assignmentLabel({ kind: "any", mode: "any" }), {
    text: "ANY",
    mode: "any",
  });
  assert.deepEqual(assignmentLabel({ kind: "runway", mode: "forced" }), {
    text: "ANY",
    mode: "any",
  });
});

test("forced vs preferred vs any are all distinct tokens", () => {
  const forced = assignmentLabel({ kind: "runway", runwayId: "36", mode: "forced" }).text;
  const preferred = assignmentLabel({ kind: "runway", runwayId: "36", mode: "preferred" }).text;
  const any = assignmentLabel(null).text;
  assert.notEqual(forced, preferred);
  assert.notEqual(forced, any);
  assert.notEqual(preferred, any);
});

test("isRoutedToLand: locked non-holding path or a clearance qualifies", () => {
  assert.equal(isRoutedToLand({ locked: true, holding: false }, null), true);
  assert.equal(isRoutedToLand(null, { clearance: { runwayId: "09" } }), true);
  // A holding orbit is not a landing route.
  assert.equal(isRoutedToLand({ locked: true, holding: true }, null), false);
  // No path, no clearance.
  assert.equal(isRoutedToLand(null, {}), false);
  assert.equal(isRoutedToLand({ locked: false }, null), false);
});
