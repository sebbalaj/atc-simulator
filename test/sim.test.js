// Unit tests for the simulation/geometry logic (FEAT-002). All imports are pure
// modules (no DOM), so these run under `node --test`. Covers: movement along a
// known spline, collision/spatial-hash near vs far, wake separation when the
// leader is COMMERCIAL, runway approach-cone alignment accept/reject, and the
// SUPERSONIC turn-angle clamp.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createSpatialHash } from "../src/core/spatialHash.js";
import { buildPath } from "../src/core/spline.js";
import { sampleAlong, validateTurns, clampTurns, turnAngleAt } from "../src/game/pathUtils.js";
import {
  AircraftKind,
  getAircraftDef,
  requiredSeparation,
} from "../src/game/aircraft.js";
import { detectConflicts } from "../src/ecs/systems/collisionSystem.js";
import {
  createMap1,
  isRunwayAligned,
  findLandingTarget,
  runwayThreshold,
} from "../src/game/airport.js";

test("movement: advancing along a spline reaches the end after the path length", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 200, y: 0 },
  ];
  const built = buildPath(points);
  // Roughly a 200px straight line.
  assert.ok(built.length > 190 && built.length < 210, "length approx 200");

  const speed = 100; // px/s
  const dt = 1 / 60;
  let progress = 0;
  let pos = sampleAlong(built, progress);
  assert.ok(Math.abs(pos.x - 0) < 1, "starts at origin");

  // Simulate ~2.2s: should reach (and clamp at) the end (needs ~2s).
  for (let i = 0; i < Math.ceil(2.2 * 60); i++) {
    progress = Math.min(built.length, progress + speed * dt);
    pos = sampleAlong(built, progress);
  }
  assert.ok(Math.abs(progress - built.length) < 1e-6, "progress clamps to length");
  assert.ok(Math.abs(pos.x - built.points[built.points.length - 1].x) < 1, "ends at path end");
  // Heading should point along +x.
  assert.ok(Math.abs(pos.heading) < 0.05, "heading faces +x");
});

test("collision: flags a near pair and not a far pair", () => {
  const spatial = createSpatialHash(96);
  const lightSep = getAircraftDef(AircraftKind.LIGHT).separationRadius;

  // Two LIGHTs placed well within their separation radius.
  const near = [
    { id: 1, x: 100, y: 100, kind: AircraftKind.LIGHT, hitboxRadius: 7, separationRadius: lightSep },
    { id: 2, x: 100 + lightSep * 0.4, y: 100, kind: AircraftKind.LIGHT, hitboxRadius: 7, separationRadius: lightSep },
  ];
  let res = detectConflicts(near, spatial);
  assert.ok(res.warnings.has(1) && res.warnings.has(2), "near pair warned");
  assert.equal(res.crashes.length, 0, "no crash yet (hitboxes not overlapping)");

  // Two LIGHTs far apart.
  const far = [
    { id: 1, x: 0, y: 0, kind: AircraftKind.LIGHT, hitboxRadius: 7, separationRadius: lightSep },
    { id: 2, x: 500, y: 500, kind: AircraftKind.LIGHT, hitboxRadius: 7, separationRadius: lightSep },
  ];
  res = detectConflicts(far, spatial);
  assert.equal(res.warnings.size, 0, "far pair not warned");
  assert.equal(res.crashes.length, 0, "far pair no crash");
});

test("collision: overlapping hitboxes register a crash", () => {
  const spatial = createSpatialHash(96);
  const sep = getAircraftDef(AircraftKind.LIGHT).separationRadius;
  const snapshots = [
    { id: 1, x: 0, y: 0, kind: AircraftKind.LIGHT, hitboxRadius: 7, separationRadius: sep },
    { id: 2, x: 8, y: 0, kind: AircraftKind.LIGHT, hitboxRadius: 7, separationRadius: sep },
  ];
  const res = detectConflicts(snapshots, spatial);
  assert.equal(res.crashes.length, 1, "one crash");
  assert.ok(res.warnings.has(1) && res.warnings.has(2), "both warned on crash");
});

test("wake: COMMERCIAL leader forces the larger separation", () => {
  const commercial = getAircraftDef(AircraftKind.COMMERCIAL);
  const light = getAircraftDef(AircraftKind.LIGHT);

  // Commercial as leader -> at least its wake separation.
  const sepCommercialLead = requiredSeparation(commercial, light);
  assert.equal(sepCommercialLead, commercial.wakeSeparation, "uses wake separation");
  assert.ok(sepCommercialLead > light.separationRadius, "larger than light's own bubble");

  // Two LIGHTs -> no wake, just the base max separation.
  const sepLightOnly = requiredSeparation(light, light);
  assert.equal(sepLightOnly, light.separationRadius);
  assert.ok(sepCommercialLead > sepLightOnly, "commercial pair needs more room");

  // A pair where one is commercial should be flagged at a distance that would
  // NOT flag two lights, proving the wake bubble is applied in detectConflicts.
  const spatial = createSpatialHash(128);
  const gap = light.separationRadius + 15; // outside a light-light bubble
  const kinds = [
    { id: 1, x: 0, y: 0, kind: AircraftKind.COMMERCIAL, hitboxRadius: commercial.hitboxRadius, separationRadius: commercial.separationRadius },
    { id: 2, x: gap, y: 0, kind: AircraftKind.LIGHT, hitboxRadius: light.hitboxRadius, separationRadius: light.separationRadius },
  ];
  const res = detectConflicts(kinds, spatial);
  assert.ok(res.warnings.has(1) && res.warnings.has(2), "wake pair warned beyond light bubble");
});

test("runway alignment: accepts an in-cone aligned approach, rejects off-angle", () => {
  const map = createMap1(400, 600);
  const runway = map.runways[0]; // heading 0 (landing toward +x)
  const def = getAircraftDef(AircraftKind.LIGHT);

  const thr = runwayThreshold(runway);
  // Endpoint on the approach side (behind threshold, i.e. -x), traveling +x.
  const goodEndpoint = { x: thr.x - 60, y: thr.y };
  const goodHeading = 0; // along the runway direction
  const good = isRunwayAligned(runway, goodEndpoint, goodHeading, def);
  assert.ok(good.aligned, "aligned approach accepted");

  // Off-angle: approaching from the correct spot but heading 90deg off.
  const badHeading = Math.PI / 2;
  const bad = isRunwayAligned(runway, goodEndpoint, badHeading, def);
  assert.ok(!bad.aligned, "off-angle approach rejected");
  assert.ok(!bad.headingOk, "heading flagged wrong");
});

test("runway alignment: findLandingTarget picks the runway for an aligned approach", () => {
  const map = createMap1(400, 600);
  const runway = map.runways[0];
  const def = getAircraftDef(AircraftKind.COMMERCIAL);
  const thr = runwayThreshold(runway);
  const endpoint = { x: thr.x - 80, y: thr.y };
  const target = findLandingTarget(map, endpoint, 0, def);
  assert.ok(target, "found a landing target");
  assert.equal(target.type, "runway");
});

test("runway length: short runway rejects a class that needs a long one", () => {
  const map = createMap1(400, 600);
  // runway B is 180 long; SUPERSONIC needs 220.
  const shortRunway = map.runways[1];
  const supersonic = getAircraftDef(AircraftKind.SUPERSONIC);
  const thr = runwayThreshold(shortRunway);
  const endpoint = {
    x: thr.x - Math.cos(shortRunway.heading) * 60,
    y: thr.y - Math.sin(shortRunway.heading) * 60,
  };
  const detail = isRunwayAligned(shortRunway, endpoint, shortRunway.heading, supersonic);
  assert.ok(!detail.lengthOk, "runway too short for supersonic");
  assert.ok(!detail.aligned, "not aligned because too short");
});

test("helipad: a helicopter lands on the pad from any heading", () => {
  const map = createMap1(400, 600);
  const heli = getAircraftDef(AircraftKind.HELICOPTER);
  const pad = map.helipad;
  const endpoint = { x: pad.x + 4, y: pad.y - 3 };
  // Arbitrary heading.
  const target = findLandingTarget(map, endpoint, 2.1, heli);
  assert.ok(target, "helicopter found a target");
  assert.equal(target.type, "helipad");
});

test("turn-angle: SUPERSONIC rejects/clamps an over-sharp corner", () => {
  const supersonic = getAircraftDef(AircraftKind.SUPERSONIC);

  // A sharp ~90-degree corner.
  const sharp = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ];
  const angle = turnAngleAt(sharp[0], sharp[1], sharp[2]);
  assert.ok(Math.abs(angle - Math.PI / 2) < 1e-6, "90deg corner measured");

  const res = validateTurns(sharp, supersonic.maxTurnAngle);
  assert.ok(!res.ok, "supersonic cannot make a 90deg turn");

  // The LIGHT can.
  const lightRes = validateTurns(sharp, getAircraftDef(AircraftKind.LIGHT).maxTurnAngle);
  assert.ok(lightRes.ok, "light can make a 90deg turn");

  // Clamp removes the offending corner for supersonic (smooths the route).
  const clamped = clampTurns(sharp, supersonic.maxTurnAngle);
  assert.equal(clamped.length, 2, "sharp corner dropped");
  const clampedRes = validateTurns(clamped, supersonic.maxTurnAngle);
  assert.ok(clampedRes.ok, "clamped route is now flyable");
});

test("gentle turns within the SUPERSONIC limit are accepted", () => {
  const supersonic = getAircraftDef(AircraftKind.SUPERSONIC);
  // ~20-degree bend, under the ~35-degree supersonic cap.
  const gentle = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 194, y: 34 },
  ];
  const res = validateTurns(gentle, supersonic.maxTurnAngle);
  assert.ok(res.ok, "gentle bend accepted for supersonic");
});
