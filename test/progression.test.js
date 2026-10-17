// Unit tests for the FEAT-005 pure-logic: the upgrade shop (catalog +
// applyUpgrade + purchase), the maps registry (four maps with the required
// structures), the moving-runway helper, and the shift-progression summary
// aggregation. All imports are DOM-free so these run under `node --test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  UPGRADES,
  getUpgrade,
  applyUpgrade,
  purchase,
  isOwned,
  RADAR_RANGE_STEP,
  COMMERCIAL_RUNWAY_LENGTH,
} from "../src/game/upgrades.js";
import { createBank } from "../src/game/economy.js";
import {
  buildAllMaps,
  createMap,
  MAP_ORDER,
  updateMovingRunways,
} from "../src/game/maps.js";
import {
  createProgression,
  aggregateSummaries,
  computeBonus,
} from "../src/game/progression.js";
import {
  findLandingTarget,
  runwayThreshold,
} from "../src/game/airport.js";
import { getAircraftDef, AircraftKind } from "../src/game/aircraft.js";

// --- Upgrades --------------------------------------------------------------

test("upgrade: radar-range purchase debits the bank and grows the spawn radius", () => {
  const map = createMap("map1", 400, 700);
  const before = map.spawnRadius;
  const bank = createBank(5000);
  const state = { map };

  const res = purchase(state, bank, "radar-range");
  assert.ok(res.ok, "purchase succeeds with funds");
  assert.equal(map.spawnRadius, before + RADAR_RANGE_STEP, "spawn radius grows");
  const cost = getUpgrade("radar-range").cost;
  assert.equal(bank.balance, 5000 - cost, "bank debited the cost");
  assert.equal(bank.spent, cost);
});

test("upgrade: canAfford blocks the purchase when broke (no state change)", () => {
  const map = createMap("map1", 400, 700);
  const before = map.spawnRadius;
  const bank = createBank(100); // cannot afford the 1500 radar upgrade
  const state = { map };

  const res = purchase(state, bank, "radar-range");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "insufficient-funds");
  assert.equal(bank.balance, 100, "balance untouched");
  assert.equal(map.spawnRadius, before, "spawn radius unchanged");
});

test("upgrade: lengthen-runway makes the short runway accept a COMMERCIAL jet", () => {
  // Map 2's south field has a short 150px runway that a COMMERCIAL cannot use.
  const map = createMap("map2", 400, 700);
  const commercial = getAircraftDef(AircraftKind.COMMERCIAL);

  // Find the shortest runway and confirm it is too short initially.
  let shortest = map.runways[0];
  for (const r of map.runways) if (r.length < shortest.length) shortest = r;
  assert.ok(
    shortest.length < commercial.runwayLengthRequired,
    "short runway is below the COMMERCIAL requirement to start"
  );

  // An aligned COMMERCIAL approach to the short runway is rejected (too short).
  const dirRunway = { ...shortest, heading: shortest.heading };
  const thr = runwayThreshold(dirRunway);
  const approachPoint = {
    x: thr.x - Math.cos(shortest.heading) * 20,
    y: thr.y - Math.sin(shortest.heading) * 20,
  };
  const beforeTarget = findLandingTarget(map, approachPoint, shortest.heading, commercial);
  // It should not resolve to this (short) runway for a COMMERCIAL.
  const resolvedShortBefore =
    beforeTarget && beforeTarget.surface && beforeTarget.surface.id === shortest.id;
  assert.ok(!resolvedShortBefore, "COMMERCIAL cannot use the short runway before the upgrade");

  // Lengthen it (applyUpgrade mutates the map directly).
  const state = { map };
  const res = applyUpgrade(state, "lengthen-runway");
  assert.ok(res.ok);
  assert.ok(
    shortest.length >= COMMERCIAL_RUNWAY_LENGTH,
    "runway now meets the COMMERCIAL length requirement"
  );

  // Now an aligned COMMERCIAL approach resolves onto that runway.
  const thr2 = runwayThreshold({ ...shortest, heading: shortest.heading });
  const approachPoint2 = {
    x: thr2.x - Math.cos(shortest.heading) * 20,
    y: thr2.y - Math.sin(shortest.heading) * 20,
  };
  const afterTarget = findLandingTarget(map, approachPoint2, shortest.heading, commercial);
  assert.ok(afterTarget && afterTarget.type === "runway", "a runway target resolves");
  assert.equal(afterTarget.surface.id, shortest.id, "resolves onto the lengthened runway");
});

test("upgrade: ILS is one-shot and sets the flag; a second buy is refused", () => {
  const map = createMap("map1", 400, 700);
  const bank = createBank(10000);
  const state = { map };

  const r1 = purchase(state, bank, "ils");
  assert.ok(r1.ok);
  assert.equal(state.flags.ilsOwned, true, "ILS flag set");
  assert.ok(isOwned(state, "ils"));
  const balAfter = bank.balance;

  const r2 = purchase(state, bank, "ils");
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "already-owned");
  assert.equal(bank.balance, balAfter, "no double charge");
});

test("upgrade: build-helipad and ground-crew change the map", () => {
  const map = createMap("map1", 400, 700);
  const padsBefore = map.helipads.length;
  const clearBefore = map.runways[0].clearTime;
  const bank = createBank(10000);
  const state = { map };

  assert.ok(purchase(state, bank, "build-helipad").ok);
  assert.equal(map.helipads.length, padsBefore + 1, "a helipad is added");

  assert.ok(purchase(state, bank, "ground-crew").ok);
  assert.ok(map.runways[0].clearTime < clearBefore, "ground crew reduces clear time");
  assert.equal(state.flags.groundCrew, 1);
});

test("upgrade: build-runway adds a jet-capable runway", () => {
  const map = createMap("map1", 400, 700);
  const n = map.runways.length;
  const state = { map };
  const res = applyUpgrade(state, "build-runway");
  assert.ok(res.ok);
  assert.equal(map.runways.length, n + 1);
  const added = map.runways[map.runways.length - 1];
  assert.ok(
    added.length >= COMMERCIAL_RUNWAY_LENGTH,
    "the new runway accepts heavy jets"
  );
});

test("upgrade: catalog spans all four categories", () => {
  const cats = new Set(UPGRADES.map((u) => u.category));
  assert.ok(cats.has("Radar Range"));
  assert.ok(cats.has("Infrastructure"));
  assert.ok(cats.has("Technology"));
  assert.ok(cats.has("Staffing"));
  assert.equal(getUpgrade("nope"), null);
});

// --- Maps registry ---------------------------------------------------------

test("maps: the registry returns all four maps with the required structures", () => {
  const maps = buildAllMaps(400, 700);
  assert.equal(maps.length, 4, "four maps");
  assert.deepEqual(maps.map((m) => m.id), MAP_ORDER);

  // Each map has the baseline required structures.
  for (const m of maps) {
    assert.ok(Array.isArray(m.runways) && m.runways.length >= 1, m.id + " has runways");
    assert.ok(m.center && typeof m.center.x === "number", m.id + " has a center");
    assert.ok(m.spawnRadius > 0, m.id + " has a spawn radius");
    assert.ok(m.hospital, m.id + " has a hospital POI");
    assert.ok(m.rules, m.id + " has rules");
  }

  const [map1, map2, map3, map4] = maps;

  // Map 1: two intersecting runways.
  assert.equal(map1.runways.length, 2, "Map 1 has two runways");

  // Map 2: two separate airports.
  assert.ok(Array.isArray(map2.airports) && map2.airports.length === 2, "Map 2 has two airports");
  const sizes = map2.airports.map((a) => a.size);
  assert.ok(sizes.includes("large") && sizes.includes("small"), "a large and a small field");

  // Map 3: a moving runway + an offshore helipad.
  assert.ok(Array.isArray(map3.movingRunways) && map3.movingRunways.length >= 1, "Map 3 moving runway");
  assert.ok(map3.movingRunways[0].moving, "the moving runway carries a moving descriptor");
  assert.ok(
    map3.helipads.some((p) => p.offshore),
    "Map 3 has at least one offshore helipad"
  );

  // Map 4: four parallel runways + strict wake rule.
  assert.equal(map4.runways.length, 4, "Map 4 has four runways");
  const headings = new Set(map4.runways.map((r) => r.heading));
  assert.equal(headings.size, 1, "all four runways are parallel");
  assert.ok(map4.rules.wakeMultiplier > 1, "Map 4 enforces stricter wake separation");
});

test("maps: the carrier runway translates over time (moving runway)", () => {
  const map = createMap("map3", 400, 700);
  const carrier = map.movingRunways[0];
  const startX = carrier.x;
  // Advance several seconds; the deck should have translated from its start.
  let moved = false;
  for (let i = 0; i < 300; i++) {
    updateMovingRunways(map, 1 / 60);
    if (Math.abs(carrier.x - startX) > 1) moved = true;
  }
  assert.ok(moved, "the carrier runway moved from its base position");
  // A map without moving runways is a safe no-op.
  const map1 = createMap("map1", 400, 700);
  assert.doesNotThrow(() => updateMovingRunways(map1, 1 / 60));
});

// --- Progression / shift summary -------------------------------------------

test("progression: a shift summary aggregates landings and revenue", () => {
  const prog = createProgression({ target: 2000 });
  prog.startShift();
  prog.recordLanding(1200);
  prog.recordLanding(900);
  prog.recordIncident("nearMiss");
  prog.recordEmergency();

  const summary = prog.endShift({ reputationScore: 80, survived: true });
  assert.equal(summary.landed, 2, "two landings counted");
  assert.equal(summary.revenue, 2100, "revenue summed");
  assert.equal(summary.metTarget, true, "met the 2000 target");
  assert.equal(summary.incidents.nearMiss, 1);
  assert.equal(summary.emergenciesHandled, 1);
  assert.ok(summary.bonus > 0, "a bonus is awarded for meeting the target");
  assert.equal(summary.total, summary.revenue + summary.bonus);
});

test("progression: a failed shift yields no bonus; survival unlocks the next map", () => {
  const prog = createProgression({ target: 1000, unlockedMaps: 1 });
  assert.ok(prog.isMapUnlocked(0));
  assert.ok(!prog.isMapUnlocked(1), "map 2 locked initially");

  prog.startShift();
  prog.recordLanding(5000);
  const failed = prog.endShift({ reputationScore: 0, survived: false });
  assert.equal(failed.bonus, 0, "no bonus when not survived");
  assert.equal(failed.survived, false);

  // Surviving an advance unlocks the next map.
  prog.advance({ survived: true });
  assert.ok(prog.isMapUnlocked(1), "map 2 unlocked after surviving");
  assert.ok(prog.selectMap(1), "can select the newly unlocked map");
  assert.equal(prog.currentMapId(), MAP_ORDER[1]);
});

test("progression: computeBonus and aggregateSummaries", () => {
  assert.equal(computeBonus({ stats: { emergenciesHandled: 0 }, metTarget: false, survived: true }), 0);
  assert.equal(computeBonus({ stats: { emergenciesHandled: 2 }, metTarget: true, survived: true }), 1000 + 500);
  assert.equal(computeBonus({ stats: { emergenciesHandled: 5 }, metTarget: true, survived: false }), 0);

  const totals = aggregateSummaries([
    { landed: 3, revenue: 1000, bonus: 500, crashed: 0, emergenciesHandled: 1 },
    { landed: 2, revenue: 800, bonus: 0, crashed: 1, emergenciesHandled: 0 },
  ]);
  assert.equal(totals.landed, 5);
  assert.equal(totals.revenue, 1800);
  assert.equal(totals.bonus, 500);
  assert.equal(totals.total, 2300);
  assert.equal(totals.crashed, 1);
});
