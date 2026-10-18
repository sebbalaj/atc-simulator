// Unit tests for FEAT-001 data foundations: runway end labels + per-class
// landing assignment. All imports are pure modules (no DOM), so these run under
// `node --test`. Covers: runwayEndLabel for both landing directions on
// representative runways; assignLandingTarget determinism for a fixed rng seed;
// forced classes only ever get a legal surface (commercial/supersonic a
// long-enough runway, helicopter a pad); light gets a preferred short runway or
// mode 'any'.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createRng } from "../src/core/rng.js";
import {
  AircraftKind,
  getAircraftDef,
  assignLandingTarget,
} from "../src/game/aircraft.js";
import { runwayEndLabel, deriveEndLabels } from "../src/game/airport.js";
import { buildAllMaps, createMap } from "../src/game/maps.js";

test("runwayEndLabel returns the expected end label for each direction", () => {
  const map1 = createMap("map1", 400, 700);
  const r = map1.runways.find((x) => x.id === "09/27");
  assert.ok(r, "map1 has runway 09/27");
  // heading 0 end is '09'; the reciprocal (heading + PI) end is '27'.
  assert.equal(runwayEndLabel(r, r.heading), "09");
  assert.equal(runwayEndLabel(r, r.heading + Math.PI), "27");

  const r2 = map1.runways.find((x) => x.id === "13/31");
  assert.equal(runwayEndLabel(r2, r2.heading), "13");
  assert.equal(runwayEndLabel(r2, r2.heading + Math.PI), "31");

  // Explicit endLabels on Map 2's single-token id runway.
  const map2 = createMap("map2", 400, 700);
  const big = map2.runways.find((x) => x.id === "36L");
  assert.equal(runwayEndLabel(big, big.heading), "36L");
  assert.equal(runwayEndLabel(big, big.heading + Math.PI), "18R");

  // Single-label runway (both ends read the same stable label).
  const map4 = createMap("map4", 400, 700);
  const rw1 = map4.runways.find((x) => x.id === "RW1");
  assert.equal(runwayEndLabel(rw1, rw1.heading), "RW1");
  assert.equal(runwayEndLabel(rw1, rw1.heading + Math.PI), "RW1");
});

test("deriveEndLabels splits two-end ids and computes reciprocals", () => {
  assert.deepEqual(deriveEndLabels("09/27"), { near: "09", far: "27" });
  assert.deepEqual(deriveEndLabels("10/28"), { near: "10", far: "28" });
  assert.deepEqual(deriveEndLabels("36L"), { near: "36L", far: "18R" });
  assert.deepEqual(deriveEndLabels("CVN"), { near: "CVN", far: "CVN" });
});

test("assignLandingTarget is deterministic for a fixed rng seed", () => {
  const maps = buildAllMaps();
  for (const map of maps) {
    for (const kind of Object.values(AircraftKind)) {
      const def = getAircraftDef(kind);
      const a = assignLandingTarget(def, map, createRng(12345));
      const b = assignLandingTarget(def, map, createRng(12345));
      assert.deepEqual(a, b, `${kind} on ${map.id} is deterministic`);
    }
  }
});

test("forced classes only ever get a surface they can actually use", () => {
  const maps = buildAllMaps();
  const forcedRunwayKinds = [AircraftKind.COMMERCIAL, AircraftKind.SUPERSONIC];
  // Sweep many seeds to exercise every eligible runway choice on each map.
  for (const map of maps) {
    for (const kind of forcedRunwayKinds) {
      const def = getAircraftDef(kind);
      for (let seed = 1; seed <= 200; seed++) {
        const a = assignLandingTarget(def, map, createRng(seed));
        assert.equal(a.kind, "runway", `${kind} on ${map.id} assigned a runway`);
        assert.equal(a.mode, "forced", `${kind} on ${map.id} is forced`);
        const runway = map.runways.find((r) => r.id === a.runwayId);
        assert.ok(runway, `${kind} assignment ${a.runwayId} exists on ${map.id}`);
        assert.ok(
          runway.length >= def.runwayLengthRequired,
          `${kind} on ${map.id}: runway ${a.runwayId} long enough`
        );
      }
    }
  }
});

test("helicopter is forced to a pad on every map", () => {
  const maps = buildAllMaps();
  const def = getAircraftDef(AircraftKind.HELICOPTER);
  for (const map of maps) {
    const pads = map.helipads && map.helipads.length ? map.helipads : [map.helipad];
    for (let seed = 1; seed <= 100; seed++) {
      const a = assignLandingTarget(def, map, createRng(seed));
      assert.equal(a.kind, "helipad", `heli on ${map.id} gets a pad`);
      assert.equal(a.mode, "forced", `heli on ${map.id} is forced`);
      assert.ok(
        pads.some((p) => p.id === a.padId),
        `heli pad ${a.padId} exists on ${map.id}`
      );
    }
  }
});

test("light gets either a preferred legal short runway or mode 'any'", () => {
  const maps = buildAllMaps();
  const def = getAircraftDef(AircraftKind.LIGHT);
  for (const map of maps) {
    let sawPreferred = false;
    let sawAny = false;
    for (let seed = 1; seed <= 200; seed++) {
      const a = assignLandingTarget(def, map, createRng(seed));
      if (a.mode === "any") {
        assert.equal(a.kind, "any", `light don't-care has no surface on ${map.id}`);
        sawAny = true;
      } else {
        assert.equal(a.mode, "preferred", `light soft target is preferred on ${map.id}`);
        assert.equal(a.kind, "runway");
        const runway = map.runways.find((r) => r.id === a.runwayId);
        assert.ok(runway, `light preferred runway exists on ${map.id}`);
        assert.ok(
          runway.length >= def.runwayLengthRequired,
          `light preferred runway legal on ${map.id}`
        );
        sawPreferred = true;
      }
    }
    // Over 200 seeds we should see both outcomes on every map (light prefers a
    // runway but is don't-care ~a third of the time).
    assert.ok(sawPreferred, `light sees a preferred target on ${map.id}`);
    assert.ok(sawAny, `light sees a don't-care outcome on ${map.id}`);
  }
});
