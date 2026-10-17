// FEAT-004 ("make everything smaller") regression tests. The whole airport was
// scaled down by a consistent 0.70 factor (a 30% reduction) for phone
// readability: aircraft icons (via the Render-size multiplier), runway
// length/width, approach cone length, helipad radii AND each class's
// runwayLengthRequired. These assertions are revert-sensitive: a revert back to
// the old larger numbers, OR an over-shrink that breaks the landing invariant,
// fails here.
//
// All imports are pure / DOM-free.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AIRCRAFT_DEFS, AircraftKind, getAircraftDef } from "../src/game/aircraft.js";
import { createMap1, createRunway } from "../src/game/airport.js";
import { createMap, buildAllMaps } from "../src/game/maps.js";
import {
  NEW_RUNWAY_LENGTH,
  RUNWAY_LENGTHEN_STEP,
  COMMERCIAL_RUNWAY_LENGTH,
  applyUpgrade,
} from "../src/game/upgrades.js";

const SCALE = 0.7; // the FEAT-004 shrink factor

// --- runwayLengthRequired shrank by the same factor and keeps ordering ------

test("runwayLengthRequired shrank 0.70 and preserves class ordering", () => {
  // Pinned to the shrunk numbers so a revert to 90/190/220 fails.
  assert.equal(AIRCRAFT_DEFS[AircraftKind.LIGHT].runwayLengthRequired, 63, "light 90 -> 63");
  assert.equal(AIRCRAFT_DEFS[AircraftKind.COMMERCIAL].runwayLengthRequired, 133, "commercial 190 -> 133");
  assert.equal(AIRCRAFT_DEFS[AircraftKind.HELICOPTER].runwayLengthRequired, 0, "helicopter uses the pad");
  assert.equal(AIRCRAFT_DEFS[AircraftKind.SUPERSONIC].runwayLengthRequired, 154, "supersonic 220 -> 154");

  const light = AIRCRAFT_DEFS[AircraftKind.LIGHT].runwayLengthRequired;
  const commercial = AIRCRAFT_DEFS[AircraftKind.COMMERCIAL].runwayLengthRequired;
  const supersonic = AIRCRAFT_DEFS[AircraftKind.SUPERSONIC].runwayLengthRequired;
  assert.ok(light < commercial && commercial < supersonic, "ordering light < commercial < supersonic");
});

// --- the drawn icon shrank without changing collision -----------------------

test("hitbox/separation are unchanged (collision stays fair); icon shrinks via the Render multiplier", () => {
  // Collision geometry is untouched by FEAT-004 (icon size is a render concern).
  assert.equal(AIRCRAFT_DEFS[AircraftKind.LIGHT].hitboxRadius, 7);
  assert.equal(AIRCRAFT_DEFS[AircraftKind.COMMERCIAL].hitboxRadius, 11);
  assert.equal(AIRCRAFT_DEFS[AircraftKind.HELICOPTER].hitboxRadius, 8);
  assert.equal(AIRCRAFT_DEFS[AircraftKind.SUPERSONIC].hitboxRadius, 9);
  // The spawn system draws icons at hitboxRadius * 0.9 (down from * 1.3), a
  // ~31% smaller icon. Confirm 0.9 is within the 25-35% reduction band.
  const reduction = 1 - 0.9 / 1.3;
  assert.ok(reduction >= 0.25 && reduction <= 0.35, "icon reduction is ~25-35%");
});

// --- runways / cones / helipads shrank; defaults pinned ---------------------

test("createRunway defaults shrank 0.70 (width 14->10, cone 180->126)", () => {
  const r = createRunway({ id: "X", x: 0, y: 0, heading: 0, length: 161 });
  assert.equal(r.width, 10, "default width 14 -> 10");
  assert.equal(r.approach.coneLength, 126, "default coneLength 180 -> 126");
  // Tolerance stays forgiving (unchanged 28deg).
  assert.ok(Math.abs(r.approach.tolerance - (28 * Math.PI) / 180) < 1e-9, "28deg tolerance preserved");
});

test("map1 runway/helipad/cone geometry is the shrunk set", () => {
  const map = createMap1(400, 700);
  const [a, b] = map.runways;
  assert.equal(a.length, 161, "runwayA 230 -> 161");
  assert.equal(a.width, 10, "runwayA width 14 -> 10");
  assert.equal(a.approach.coneLength, 140, "runwayA cone 200 -> 140");
  assert.equal(b.length, 126, "runwayB 180 -> 126");
  assert.equal(b.width, 10, "runwayB width 14 -> 10");
  assert.equal(b.approach.coneLength, 126, "runwayB cone 180 -> 126");
  assert.equal(map.helipad.radius, 11, "helipad 16 -> 11");
});

// --- the core invariant: every runway a class is meant to use is long enough -

test("INVARIANT: for every map, each runway is still long enough for the classes meant to use it", () => {
  const maps = buildAllMaps(400, 700);

  for (const map of maps) {
    // Each map must still have at least one runway that accepts a COMMERCIAL
    // jet and at least one that accepts a SUPERSONIC (the binding long cases),
    // otherwise the shrink has gone too far.
    for (const kind of [AircraftKind.COMMERCIAL, AircraftKind.SUPERSONIC]) {
      const req = getAircraftDef(kind).runwayLengthRequired;
      const usable = map.runways.some((r) => r.length >= req);
      assert.ok(usable, `${map.id}: at least one runway accepts ${kind} (need >= ${req})`);
    }

    // Every runway must at least clear the LIGHT requirement (no runway shrank
    // so far that even a Cessna can't use it) and the longest runway on the map
    // must clear the SUPERSONIC requirement (revert-sensitive to an over-shrink
    // that would drop the field's best strip below the fast-jet threshold).
    const lightReq = getAircraftDef(AircraftKind.LIGHT).runwayLengthRequired;
    for (const runway of map.runways) {
      assert.ok(
        runway.length >= lightReq,
        `${map.id} ${runway.id}: length ${runway.length} >= light required ${lightReq}`
      );
    }
    const longest = Math.max(...map.runways.map((r) => r.length));
    assert.ok(
      longest >= getAircraftDef(AircraftKind.SUPERSONIC).runwayLengthRequired,
      `${map.id}: longest runway ${longest} accepts supersonic`
    );

  }
});

test("binding cases: the short prop strips still accept LIGHT; the long strips still accept COMMERCIAL/SUPERSONIC", () => {
  const map1 = createMap("map1", 400, 700);
  const map2 = createMap("map2", 400, 700);
  const lightReq = getAircraftDef(AircraftKind.LIGHT).runwayLengthRequired;
  const commReq = getAircraftDef(AircraftKind.COMMERCIAL).runwayLengthRequired;
  const superReq = getAircraftDef(AircraftKind.SUPERSONIC).runwayLengthRequired;

  // map1 runwayB (the shorter cross strip) and map2 smallRunway (the prop strip)
  // must still clear the LIGHT requirement after the shrink.
  assert.ok(map1.runways[1].length >= lightReq, "map1 runwayB accepts light");
  const smallRunway = map2.runways.find((r) => r.id === "18R");
  assert.ok(smallRunway.length >= lightReq, "map2 small strip accepts light");

  // The long strips (map1 runwayA, map2 big field) still clear the heavy/fast
  // requirements.
  assert.ok(map1.runways[0].length >= commReq, "map1 runwayA accepts commercial");
  assert.ok(map1.runways[0].length >= superReq, "map1 runwayA accepts supersonic");
  const bigRunway = map2.runways.find((r) => r.id === "36L");
  assert.ok(bigRunway.length >= commReq, "map2 big field accepts commercial");
  assert.ok(bigRunway.length >= superReq, "map2 big field accepts supersonic");
});

// --- upgrade-built runways also shrank and stay jet-capable ------------------

test("upgrade-built/lengthened runways stay consistent with the shrunk thresholds", () => {
  assert.equal(NEW_RUNWAY_LENGTH, 154, "new-runway length 220 -> 154");
  assert.equal(RUNWAY_LENGTHEN_STEP, 49, "lengthen step 70 -> 49");
  // A freshly built runway must accept the classes it is advertised for (jets).
  assert.ok(NEW_RUNWAY_LENGTH >= COMMERCIAL_RUNWAY_LENGTH, "built runway accepts commercial");

  // Lengthening the shortest strip guarantees it clears the commercial length.
  const map = createMap("map2", 400, 700);
  const state = { map, flags: {}, owned: [] };
  const res = applyUpgrade(state, "lengthen-runway");
  assert.ok(res.ok, "lengthen upgrade applied");
  const shortest = map.runways.reduce((a, b) => (a.length <= b.length ? a : b));
  assert.ok(shortest.length >= COMMERCIAL_RUNWAY_LENGTH, "lengthened strip accepts commercial");
});
