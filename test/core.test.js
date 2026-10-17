// Unit tests for the pure core modules using Node's built-in runner.
// Run: node --test test/

import { test } from "node:test";
import assert from "node:assert/strict";

import * as vec2 from "../src/core/vec2.js";
import { createRng } from "../src/core/rng.js";
import { buildPath, pointAtDistance, sampleSpline } from "../src/core/spline.js";
import { createSpatialHash } from "../src/core/spatialHash.js";

test("vec2: length and distance", () => {
  assert.equal(vec2.length({ x: 3, y: 4 }), 5);
  assert.equal(vec2.distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assert.equal(vec2.lengthSq({ x: 3, y: 4 }), 25);
});

test("vec2: normalize yields unit length and handles zero", () => {
  const n = vec2.normalize({ x: 0, y: 5 });
  assert.ok(Math.abs(vec2.length(n) - 1) < 1e-12);
  assert.deepEqual(n, { x: 0, y: 1 });
  assert.deepEqual(vec2.normalize({ x: 0, y: 0 }), { x: 0, y: 0 });
});

test("vec2: rotate by 90 degrees", () => {
  const r = vec2.rotate({ x: 1, y: 0 }, Math.PI / 2);
  assert.ok(Math.abs(r.x - 0) < 1e-12);
  assert.ok(Math.abs(r.y - 1) < 1e-12);
});

test("vec2: add, sub, scale, dot, lerp", () => {
  assert.deepEqual(vec2.add({ x: 1, y: 2 }, { x: 3, y: 4 }), { x: 4, y: 6 });
  assert.deepEqual(vec2.sub({ x: 5, y: 5 }, { x: 1, y: 2 }), { x: 4, y: 3 });
  assert.deepEqual(vec2.scale({ x: 2, y: 3 }, 2), { x: 4, y: 6 });
  assert.equal(vec2.dot({ x: 1, y: 0 }, { x: 0, y: 1 }), 0);
  assert.deepEqual(vec2.lerp({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5), { x: 5, y: 10 });
});

test("rng: deterministic for a fixed seed", () => {
  const a = createRng(12345);
  const b = createRng(12345);
  for (let i = 0; i < 100; i++) {
    assert.equal(a.next(), b.next());
  }
});

test("rng: different seeds diverge", () => {
  const a = createRng(1);
  const b = createRng(2);
  assert.notEqual(a.next(), b.next());
});

test("rng: range stays within bounds and next in [0,1)", () => {
  const r = createRng(7);
  for (let i = 0; i < 1000; i++) {
    const n = r.next();
    assert.ok(n >= 0 && n < 1);
    const v = r.range(10, 20);
    assert.ok(v >= 10 && v < 20);
    const vi = r.rangeInt(1, 6);
    assert.ok(vi >= 1 && vi <= 6 && Number.isInteger(vi));
  }
});

test("rng: pick and chance", () => {
  const r = createRng(99);
  const arr = ["a", "b", "c"];
  for (let i = 0; i < 50; i++) assert.ok(arr.includes(r.pick(arr)));
  assert.equal(r.chance(0), false);
  assert.equal(r.chance(1), true);
});

test("spline: buildPath cumulative length is monotonic", () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];
  const path = buildPath(pts);
  assert.ok(path.points.length > pts.length);
  assert.equal(path.cumulative[0], 0);
  for (let i = 1; i < path.cumulative.length; i++) {
    assert.ok(path.cumulative[i] >= path.cumulative[i - 1]);
  }
  assert.ok(path.length > 0);
  assert.equal(path.cumulative[path.cumulative.length - 1], path.length);
});

test("spline: pointAtDistance endpoints", () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 50, y: 50 },
    { x: 100, y: 0 },
  ];
  const path = buildPath(pts);
  const start = pointAtDistance(path, 0);
  const end = pointAtDistance(path, path.length);
  assert.ok(Math.abs(start.x - 0) < 1e-6 && Math.abs(start.y - 0) < 1e-6);
  assert.ok(Math.abs(end.x - 100) < 1e-6 && Math.abs(end.y - 0) < 1e-6);
  // Clamping: out-of-range distances map to endpoints.
  const clampedLow = pointAtDistance(path, -50);
  const clampedHigh = pointAtDistance(path, path.length + 1000);
  assert.deepEqual(clampedLow, start);
  assert.deepEqual(clampedHigh, end);
});

test("spline: sampleSpline passes through control points at t=0 and t=1", () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 10, y: 20 },
    { x: 30, y: 5 },
  ];
  const first = sampleSpline(pts, 0);
  const last = sampleSpline(pts, 1);
  assert.ok(Math.abs(first.x - 0) < 1e-9 && Math.abs(first.y - 0) < 1e-9);
  assert.ok(Math.abs(last.x - 30) < 1e-9 && Math.abs(last.y - 5) < 1e-9);
});

test("spatialHash: queryNeighbors returns nearby ids and excludes far ones", () => {
  const hash = createSpatialHash(50);
  hash.insert(1, 10, 10);
  hash.insert(2, 20, 15);
  hash.insert(3, 500, 500);

  const near = hash.queryNeighbors(12, 12, 30);
  assert.ok(near.includes(1));
  assert.ok(near.includes(2));
  assert.ok(!near.includes(3));

  const far = hash.queryNeighbors(500, 500, 10);
  assert.ok(far.includes(3));
  assert.ok(!far.includes(1));
});

test("spatialHash: clear empties the grid", () => {
  const hash = createSpatialHash(32);
  hash.insert(1, 0, 0);
  hash.clear();
  assert.deepEqual(hash.queryNeighbors(0, 0, 100), []);
});
