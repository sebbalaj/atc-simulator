// Unit tests for the radar-sweep display mechanic (FEAT-005). All imports are
// pure DOM-free modules, so these run under `node --test` with no canvas. They
// cover the sweep-crossing helper (including 2PI wraparound) and the pure
// display-latch update that only refreshes blips the beam crossed this frame.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  sweepCrossed,
  normalizeAngle,
  sweepPeriod,
  sweepRate,
  updateSweepDisplay,
} from "../src/game/radar.js";
import { Render } from "../src/ecs/components.js";

const TWO_PI = Math.PI * 2;

test("normalizeAngle wraps into [0, 2PI)", () => {
  assert.ok(Math.abs(normalizeAngle(-0.1) - (TWO_PI - 0.1)) < 1e-9);
  assert.ok(Math.abs(normalizeAngle(TWO_PI + 0.3) - 0.3) < 1e-9);
  assert.equal(normalizeAngle(0), 0);
});

test("sweepCrossed: a bearing between prevSweep and sweep returns true", () => {
  // Beam moved from 1.0 -> 1.4 rad this frame; bearing 1.2 is inside.
  assert.equal(sweepCrossed(1.4, 1.0, 1.2), true);
});

test("sweepCrossed: a bearing outside the swept arc returns false", () => {
  // Beam moved 1.0 -> 1.4; bearing 2.0 is ahead of the beam, not yet swept.
  assert.equal(sweepCrossed(1.4, 1.0, 2.0), false);
  // A bearing behind the start is also not crossed this frame.
  assert.equal(sweepCrossed(1.4, 1.0, 0.5), false);
});

test("sweepCrossed: 2PI wraparound - prev just under 2PI, now just over 0", () => {
  const prev = TWO_PI - 0.05;
  const now = 0.05;
  // A bearing near 0 (just past the wrap) is crossed.
  assert.equal(sweepCrossed(now, prev, 0.01), true);
  // A bearing near 2PI (just before the wrap) is crossed too.
  assert.equal(sweepCrossed(now, prev, TWO_PI - 0.01), true);
  // A bearing far from the wrap is not.
  assert.equal(sweepCrossed(now, prev, Math.PI), false);
});

test("sweepCrossed: no motion this frame crosses nothing", () => {
  assert.equal(sweepCrossed(1.0, 1.0, 1.0), false);
});

test("sweepPeriod/sweepRate: higher radar level speeds up the sweep", () => {
  assert.equal(sweepPeriod(0), 4);
  assert.ok(sweepPeriod(2) < sweepPeriod(0));
  // Floor is respected.
  assert.equal(sweepPeriod(100), 2);
  // Rate is the inverse-period relationship.
  assert.ok(sweepRate(2) > sweepRate(0));
  assert.ok(Math.abs(sweepRate(0) - TWO_PI / 4) < 1e-9);
});

test("updateSweepDisplay latches only crossed bearings and leaves others stale", () => {
  const center = { x: 0, y: 0 };
  // Plane A at bearing ~0 (east), plane B at bearing ~PI/2 (south, +y).
  const a = { render: Render(), x: 100, y: 0, heading: 0 };
  const b = { render: Render(), x: 0, y: 100, heading: 0 };

  // Sweep from -0.1 -> 0.1 rad: crosses bearing 0 (A) but not PI/2 (B).
  const planes = [
    { render: a.render, x: a.x, y: a.y, heading: a.heading },
    { render: b.render, x: b.x, y: b.y, heading: b.heading },
  ];
  updateSweepDisplay(0.1, -0.1, 5, center, planes);

  assert.equal(a.render.seen, true, "A was swept");
  assert.equal(a.render.lastSweepX, 100);
  assert.equal(a.render.lastSweptTime, 5);

  assert.equal(b.render.seen, false, "B not yet swept, stays unseen");
});

test("updateSweepDisplay keeps stale position until the beam returns", () => {
  const center = { x: 0, y: 0 };
  const render = Render();
  // First frame: beam crosses bearing 0 while the plane is at x=100.
  updateSweepDisplay(0.1, -0.1, 1, center, [{ render, x: 100, y: 0, heading: 0 }]);
  assert.equal(render.lastSweepX, 100);

  // The plane has since moved to x=160 but the beam is elsewhere (PI..PI+0.2).
  updateSweepDisplay(Math.PI + 0.2, Math.PI, 2, center, [
    { render, x: 160, y: 0, heading: 0 },
  ]);
  // Displayed position is still the stale last-swept value.
  assert.equal(render.lastSweepX, 100, "blip holds last-swept position");
  assert.equal(render.lastSweptTime, 1);

  // Beam returns across bearing 0: blip refreshes to the current true position.
  updateSweepDisplay(0.1, -0.1, 3, center, [{ render, x: 160, y: 0, heading: 0 }]);
  assert.equal(render.lastSweepX, 160, "blip refreshes on next sweep");
  assert.equal(render.lastSweptTime, 3);
});

test("updateSweepDisplay force-latches regardless of sweep", () => {
  const center = { x: 0, y: 0 };
  const render = Render();
  // Beam nowhere near bearing PI/2, but force=true (selected/emergency).
  updateSweepDisplay(0.1, -0.1, 7, center, [
    { render, x: 0, y: 100, heading: 1.5, force: true },
  ]);
  assert.equal(render.seen, true);
  assert.equal(render.lastSweepY, 100);
  assert.equal(render.lastSweptTime, 7);
});
