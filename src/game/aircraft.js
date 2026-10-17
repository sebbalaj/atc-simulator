// Aircraft class definitions and balanced stat tables for the four playable
// classes. Pure module: no DOM dependency. `drawShape(ctx, size)` draws a
// class-specific icon centered at the origin, oriented along +x (the render
// system rotates/translates the context before calling it).
//
// Balance rationale (all distances in world/canvas px, speeds px/s):
//   LIGHT (Cessna):   slow, very maneuverable, short runway, low fuel.
//   COMMERCIAL (jet): fast, wide turns, long runway, emits wake turbulence so
//                     trailing traffic needs a larger separation bubble.
//   HELICOPTER:       slowest, lands on the helipad from any heading.
//   SUPERSONIC (mil): fastest, tiny fuel margin, hard cap on per-point turn
//                     angle (cannot make sharp corners).

/** Canonical aircraft kind constants. */
export const AircraftKind = Object.freeze({
  LIGHT: "light",
  COMMERCIAL: "commercial",
  HELICOPTER: "helicopter",
  SUPERSONIC: "supersonic",
});

/**
 * Per-class definitions. Numeric fields:
 *  - speed:              constant cruise speed (px/s).
 *  - turnRateMax:        max heading change (rad/s) the airframe can sustain.
 *  - maxTurnAngle:       max allowed bend between consecutive path points
 *                        (radians). Sharper corners are rejected/clamped. This
 *                        is what makes SUPERSONIC refuse tight routes.
 *  - hitboxRadius:       collision radius (px). Two planes crash when their
 *                        hitbox circles overlap.
 *  - separationRadius:   proximity-warning bubble radius (px).
 *  - wakeSeparation:     extra trailing separation (px) required *behind* this
 *                        aircraft when it is the leader (COMMERCIAL only).
 *  - fuelMax:            fuel capacity in seconds of flight.
 *  - runwayLengthRequired: minimum runway length (px) the class can land on.
 *  - passengers:         [min, max] inclusive passenger count range.
 *  - color:              radar icon color.
 *  - landsOnHelipad:     true for the helicopter (helipad accepts any heading).
 *  - usesRunway:         true if the class lands on runways.
 */
export const AIRCRAFT_DEFS = Object.freeze({
  [AircraftKind.LIGHT]: {
    kind: AircraftKind.LIGHT,
    name: "Light",
    speed: 90,
    turnRateMax: Math.PI, // ~180 deg/s: very nimble
    maxTurnAngle: (150 * Math.PI) / 180, // can nearly reverse at a point
    hitboxRadius: 7,
    separationRadius: 46,
    wakeSeparation: 0,
    fuelMax: 90,
    runwayLengthRequired: 90,
    passengers: [1, 4],
    color: "#8fff6a",
    landsOnHelipad: false,
    usesRunway: true,
    drawShape: drawLight,
  },
  [AircraftKind.COMMERCIAL]: {
    kind: AircraftKind.COMMERCIAL,
    name: "Commercial",
    speed: 160,
    turnRateMax: (70 * Math.PI) / 180, // wide, airliner-like turns
    maxTurnAngle: (70 * Math.PI) / 180,
    hitboxRadius: 11,
    separationRadius: 64,
    wakeSeparation: 90, // trailing traffic must stay well clear of the wake
    fuelMax: 150,
    runwayLengthRequired: 190,
    passengers: [90, 220],
    color: "#39ff14",
    landsOnHelipad: false,
    usesRunway: true,
    drawShape: drawCommercial,
  },
  [AircraftKind.HELICOPTER]: {
    kind: AircraftKind.HELICOPTER,
    name: "Helicopter",
    speed: 70,
    turnRateMax: Math.PI, // can pivot freely
    maxTurnAngle: Math.PI, // no corner restriction
    hitboxRadius: 8,
    separationRadius: 42,
    wakeSeparation: 0,
    fuelMax: 110,
    runwayLengthRequired: 0, // uses the helipad, not a runway
    passengers: [1, 8],
    color: "#6ad1ff",
    landsOnHelipad: true,
    usesRunway: false,
    drawShape: drawHelicopter,
  },
  [AircraftKind.SUPERSONIC]: {
    kind: AircraftKind.SUPERSONIC,
    name: "Supersonic",
    speed: 230,
    turnRateMax: (45 * Math.PI) / 180, // sluggish to turn at speed
    maxTurnAngle: (35 * Math.PI) / 180, // refuses sharp corners
    hitboxRadius: 9,
    separationRadius: 72,
    wakeSeparation: 0,
    fuelMax: 70, // minimal reserve
    runwayLengthRequired: 220,
    passengers: [1, 2],
    color: "#ffd23b",
    landsOnHelipad: false,
    usesRunway: true,
    drawShape: drawSupersonic,
  },
});

/** All kinds as an array, for spawn selection. */
export const ALL_KINDS = Object.freeze([
  AircraftKind.LIGHT,
  AircraftKind.COMMERCIAL,
  AircraftKind.HELICOPTER,
  AircraftKind.SUPERSONIC,
]);

/** Look up a definition by kind. Throws on an unknown kind. */
export function getAircraftDef(kind) {
  const def = AIRCRAFT_DEFS[kind];
  if (!def) throw new Error("Unknown aircraft kind: " + kind);
  return def;
}

/**
 * The separation distance that must be maintained between a leader and a
 * follower. If the leader is a COMMERCIAL jet, its wake turbulence forces a
 * larger bubble. Otherwise the larger of the two planes' own separation radii
 * is used. Pure function (testable).
 * @param {object} leaderDef definition of the plane in front
 * @param {object} followerDef definition of the trailing plane
 * @param {number} [wakeMultiplier] scales the wake bubble (map-specific; Map 4
 *   Mega Hub enforces stricter wake separation behind COMMERCIAL leaders).
 * @returns {number} required center-to-center separation (px)
 */
export function requiredSeparation(leaderDef, followerDef, wakeMultiplier = 1) {
  const base = Math.max(leaderDef.separationRadius, followerDef.separationRadius);
  if (leaderDef.wakeSeparation > 0) {
    return Math.max(base, leaderDef.wakeSeparation * wakeMultiplier);
  }
  return base;
}

// ---------------------------------------------------------------------------
// Procedural icon drawing. Each shape is drawn centered on the origin, nose
// pointing toward +x. The render system applies translate+rotate first. These
// touch only the passed-in 2D context (no document/window), so the module still
// imports cleanly under Node.
// ---------------------------------------------------------------------------

function drawLight(ctx, size) {
  // Small single-prop: slim fuselage with straight wings.
  const s = size;
  ctx.beginPath();
  ctx.moveTo(s, 0);
  ctx.lineTo(-s * 0.6, s * 0.5);
  ctx.lineTo(-s * 0.3, 0);
  ctx.lineTo(-s * 0.6, -s * 0.5);
  ctx.closePath();
  ctx.fill();
  // Wing bar.
  ctx.beginPath();
  ctx.moveTo(-s * 0.05, -s * 0.9);
  ctx.lineTo(-s * 0.05, s * 0.9);
  ctx.lineWidth = Math.max(1, s * 0.18);
  ctx.stroke();
}

function drawCommercial(ctx, size) {
  // Larger airliner: long fuselage, swept wings, tail.
  const s = size;
  ctx.beginPath();
  ctx.moveTo(s * 1.1, 0);
  ctx.lineTo(-s * 0.9, s * 0.42);
  ctx.lineTo(-s * 0.9, -s * 0.42);
  ctx.closePath();
  ctx.fill();
  // Swept wings.
  ctx.beginPath();
  ctx.moveTo(s * 0.1, 0);
  ctx.lineTo(-s * 0.7, s * 1.05);
  ctx.moveTo(s * 0.1, 0);
  ctx.lineTo(-s * 0.7, -s * 1.05);
  // Tailplane.
  ctx.moveTo(-s * 0.8, 0);
  ctx.lineTo(-s * 1.1, s * 0.4);
  ctx.moveTo(-s * 0.8, 0);
  ctx.lineTo(-s * 1.1, -s * 0.4);
  ctx.lineWidth = Math.max(1, s * 0.22);
  ctx.stroke();
}

function drawHelicopter(ctx, size) {
  // Body with a spinning-rotor cross.
  const s = size;
  ctx.beginPath();
  ctx.ellipse(0, 0, s * 0.55, s * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();
  // Tail boom.
  ctx.beginPath();
  ctx.moveTo(-s * 0.4, 0);
  ctx.lineTo(-s * 1.2, 0);
  ctx.lineWidth = Math.max(1, s * 0.18);
  ctx.stroke();
  // Rotor disc (cross).
  ctx.beginPath();
  ctx.moveTo(-s, -s);
  ctx.lineTo(s, s);
  ctx.moveTo(-s, s);
  ctx.lineTo(s, -s);
  ctx.lineWidth = Math.max(1, s * 0.12);
  ctx.stroke();
}

function drawSupersonic(ctx, size) {
  // Sharp delta-wing dart.
  const s = size;
  ctx.beginPath();
  ctx.moveTo(s * 1.3, 0);
  ctx.lineTo(-s * 0.8, s * 0.6);
  ctx.lineTo(-s * 0.4, 0);
  ctx.lineTo(-s * 0.8, -s * 0.6);
  ctx.closePath();
  ctx.fill();
}
