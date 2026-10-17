// Unit tests for the economy / reputation / clock pure-logic modules (FEAT-003).
// All imports are DOM-free so these run under `node --test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeLandingRevenue,
  efficiencyMultiplier,
  createBank,
} from "../src/game/economy.js";
import {
  createReputation,
  REPUTATION_MAX,
  PENALTY,
} from "../src/game/reputation.js";
import { createClock, formatMinutes } from "../src/game/clock.js";
import { AircraftKind } from "../src/game/aircraft.js";
import { drainFuel, fuelStatus } from "../src/game/fuel.js";

test("revenue: a loaded commercial jet pays more than a light aircraft", () => {
  const commercial = computeLandingRevenue({
    kind: AircraftKind.COMMERCIAL,
    passengers: 200,
    timeInAirspace: 40,
  });
  const light = computeLandingRevenue({
    kind: AircraftKind.LIGHT,
    passengers: 3,
    timeInAirspace: 40,
  });
  assert.ok(commercial > light, "commercial jet earns more than light aircraft");
});

test("revenue: more passengers earns more (same type/efficiency)", () => {
  const few = computeLandingRevenue({
    kind: AircraftKind.COMMERCIAL,
    passengers: 90,
    timeInAirspace: 40,
  });
  const many = computeLandingRevenue({
    kind: AircraftKind.COMMERCIAL,
    passengers: 220,
    timeInAirspace: 40,
  });
  assert.ok(many > few, "more passengers => more revenue");
});

test("revenue: a shorter time in the airspace earns an efficiency bonus", () => {
  const quick = computeLandingRevenue({
    kind: AircraftKind.COMMERCIAL,
    passengers: 150,
    timeInAirspace: 10,
  });
  const slow = computeLandingRevenue({
    kind: AircraftKind.COMMERCIAL,
    passengers: 150,
    timeInAirspace: 110,
  });
  assert.ok(quick > slow, "faster landing pays more than a slow one");

  // The multiplier itself is monotonically non-increasing with time.
  assert.ok(efficiencyMultiplier(5) >= efficiencyMultiplier(60));
  assert.ok(efficiencyMultiplier(60) >= efficiencyMultiplier(200));
  // Full bonus at/under the threshold; floor far out.
  assert.equal(efficiencyMultiplier(0), efficiencyMultiplier(20));
});

test("bank: credit, debit, and canAfford behave correctly", () => {
  const bank = createBank(100);
  assert.equal(bank.balance, 100);

  bank.credit(250);
  assert.equal(bank.balance, 350);
  assert.equal(bank.earned, 250);

  assert.ok(bank.canAfford(350));
  assert.ok(!bank.canAfford(351));

  assert.equal(bank.debit(100), true);
  assert.equal(bank.balance, 250);
  assert.equal(bank.spent, 100);

  // Over-draft is refused and leaves the balance untouched.
  assert.equal(bank.debit(1000), false);
  assert.equal(bank.balance, 250);

  // Non-positive amounts are ignored.
  bank.credit(-50);
  assert.equal(bank.balance, 250);
  assert.equal(bank.debit(0), false);
});

test("reputation: penalties reduce score and isFired triggers at <= 0", () => {
  const rep = createReputation();
  assert.equal(rep.score, REPUTATION_MAX);
  assert.ok(!rep.isFired());

  rep.penalize("nearMiss");
  assert.equal(rep.score, REPUTATION_MAX - PENALTY.nearMiss);

  rep.penalize("fuelOut");
  assert.equal(rep.score, REPUTATION_MAX - PENALTY.nearMiss - PENALTY.fuelOut);
  assert.equal(rep.incidents.nearMiss, 1);
  assert.equal(rep.incidents.fuelOut, 1);

  // Recovery clamps at the max.
  const rep2 = createReputation(99);
  rep2.recover(10);
  assert.equal(rep2.score, REPUTATION_MAX);

  // Drive to zero -> fired. Score clamps at 0 (never negative).
  const rep3 = createReputation(5);
  rep3.penalize("fuelOut"); // -25
  assert.equal(rep3.score, 0);
  assert.ok(rep3.isFired());

  // A crash wipes the whole meter.
  const rep4 = createReputation();
  rep4.penalize("crash");
  assert.equal(rep4.score, 0);
  assert.ok(rep4.isFired());

  // Unknown penalty types are ignored.
  const rep5 = createReputation(50);
  rep5.penalize("nope");
  assert.equal(rep5.score, 50);
});

test("clock: format and isShiftOver boundaries", () => {
  // Default shift 06:00 -> 14:00 over 480 real seconds.
  const clock = createClock();
  assert.equal(clock.format(), "06:00");
  assert.ok(!clock.isShiftOver());

  // Halfway through the shift window: 10:00.
  clock.setElapsed(240);
  assert.equal(clock.format(), "10:00");
  assert.ok(!clock.isShiftOver());

  // At/after the end: clamps to 14:00 and the shift is over.
  clock.setElapsed(480);
  assert.equal(clock.format(), "14:00");
  assert.ok(clock.isShiftOver());

  clock.setElapsed(600);
  assert.equal(clock.format(), "14:00", "does not run past the shift end");
  assert.ok(clock.isShiftOver());

  // formatMinutes zero-pads and wraps a full day.
  assert.equal(formatMinutes(6 * 60 + 5), "06:05");
  assert.equal(formatMinutes(0), "00:00");
  assert.equal(formatMinutes(23 * 60 + 59), "23:59");
});

test("clock: a custom window formats correctly", () => {
  const clock = createClock({ startMinutes: 22 * 60, endMinutes: 24 * 60, realSeconds: 120 });
  assert.equal(clock.format(), "22:00");
  clock.setElapsed(60);
  assert.equal(clock.format(), "23:00");
  clock.tick(60);
  assert.ok(clock.isShiftOver());
});

test("fuel: drains over time, flags low/critical, and reports emptying once", () => {
  const fuel = { capacity: 100, remaining: 100 };
  // Cruise burn for 30s: 70 remaining, not low.
  let res = drainFuel(fuel, 30);
  assert.ok(Math.abs(fuel.remaining - 70) < 1e-6);
  assert.ok(!res.low);

  // Holding burns faster (1.6x). Burn down into the low band.
  drainFuel(fuel, 30, { holding: true }); // 70 - 48 = 22
  const st = fuelStatus(fuel);
  assert.ok(st.low, "22/100 is low");
  assert.ok(!st.critical, "not yet critical");

  // Keep burning to empty; justEmptied fires exactly on the transition.
  drainFuel(fuel, 13); // 22 - 13 = 9 (critical)
  assert.ok(fuelStatus(fuel).critical, "9/100 is critical");
  const emptyRes = drainFuel(fuel, 20); // overshoots to 0
  assert.equal(fuel.remaining, 0);
  assert.ok(emptyRes.justEmptied, "reports the emptying transition once");
  const afterRes = drainFuel(fuel, 5);
  assert.ok(!afterRes.justEmptied, "does not re-report once already empty");
});
