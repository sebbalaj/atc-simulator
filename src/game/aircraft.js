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
//
// FEAT-003 tuning: cruise speeds were cut to 0.25x of the prior controllable
// band (light 40->10, heli 30->7.5, commercial 70->17.5, supersonic 100->25) so
// aircraft read at a calm, deliberate pace. Because fuelMax is measured in
// SECONDS of flight, the reachable distance per fuel-second drops to 1/4 with a
// 1/4-speed cut, so fuelMax was scaled up ~4x (light 200->640, heli 250->760,
// commercial 340->1000, supersonic 150->480) to keep planes able to reach a
// runway from the spawn perimeter with margin; SUPERSONIC keeps the tightest
// reserve of the four. The economy efficiency window (economy.js) was widened
// and the spawn cadence (spawnSystem.js) lengthened to match the ~4x-longer
// time-in-airspace. Class ORDERING is preserved: helicopter 7.5 <= light 10 <
// commercial 17.5 < supersonic 25.
//
// FEAT-004 ("make everything smaller"): the whole airport is scaled down by a
// consistent 0.70 factor (a 30% reduction) for phone readability - runways,
// helipads, approach cones AND the per-class runwayLengthRequired all shrink by
// the same 0.70 so every runway a class is meant to use still satisfies
// runway.length >= runwayLengthRequired. The runwayLengthRequired values below
// are the shrunk numbers: light 90->63, commercial 190->133, supersonic 220->154
// (helicopter stays 0, it uses the pad). Ordering light < commercial < supersonic
// is preserved. The drawn ICON size is shrunk separately in spawnSystem.js by
// lowering the Render-size multiplier (hitboxRadius*1.3 -> hitboxRadius*0.9, a
// ~31% smaller icon) WITHOUT changing hitboxRadius/separationRadius, so collision
// and separation stay exactly as balanced in FEAT-003.

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
    speed: 10,
    turnRateMax: Math.PI, // ~180 deg/s: very nimble
    maxTurnAngle: (150 * Math.PI) / 180, // can nearly reverse at a point
    hitboxRadius: 7,
    separationRadius: 46,
    wakeSeparation: 0,
    fuelMax: 640,
    runwayLengthRequired: 63, // FEAT-004: 90 * 0.70
    passengers: [1, 4],
    color: "#8fff6a",
    landsOnHelipad: false,
    usesRunway: true,
    drawShape: drawLight,
  },
  [AircraftKind.COMMERCIAL]: {
    kind: AircraftKind.COMMERCIAL,
    name: "Commercial",
    speed: 17.5,
    turnRateMax: (70 * Math.PI) / 180, // wide, airliner-like turns
    maxTurnAngle: (70 * Math.PI) / 180,
    hitboxRadius: 11,
    separationRadius: 64,
    wakeSeparation: 90, // trailing traffic must stay well clear of the wake
    fuelMax: 1000,
    runwayLengthRequired: 133, // FEAT-004: 190 * 0.70
    passengers: [90, 220],
    color: "#39ff14",
    landsOnHelipad: false,
    usesRunway: true,
    drawShape: drawCommercial,
  },
  [AircraftKind.HELICOPTER]: {
    kind: AircraftKind.HELICOPTER,
    name: "Helicopter",
    speed: 7.5,
    turnRateMax: Math.PI, // can pivot freely
    maxTurnAngle: Math.PI, // no corner restriction
    hitboxRadius: 8,
    separationRadius: 42,
    wakeSeparation: 0,
    fuelMax: 760,
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
    speed: 25,
    turnRateMax: (45 * Math.PI) / 180, // sluggish to turn at speed
    maxTurnAngle: (35 * Math.PI) / 180, // refuses sharp corners
    hitboxRadius: 9,
    separationRadius: 72,
    wakeSeparation: 0,
    fuelMax: 480, // minimal reserve (tightest margin of the four classes)
    runwayLengthRequired: 154, // FEAT-004: 220 * 0.70
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
  // Small single-prop (Cessna-style): a slim fuselage with a rounded nose,
  // straight (unswept) wings as a crossbar, a small tailplane, and a spinner +
  // propeller arc at the nose. Reads as a little prop plane, not a triangle.
  const s = size;
  const lw = ctx.lineWidth;

  // Slim fuselage: a narrow lozenge running nose(+x) to tail(-x).
  ctx.beginPath();
  ctx.moveTo(s * 0.95, 0); // nose
  ctx.lineTo(s * 0.2, -s * 0.22);
  ctx.lineTo(-s * 0.85, -s * 0.16);
  ctx.lineTo(-s * 0.85, s * 0.16);
  ctx.lineTo(s * 0.2, s * 0.22);
  ctx.closePath();
  ctx.fill();

  // Straight (unswept) main wing: a single crossbar near the nose.
  ctx.lineWidth = Math.max(1, s * 0.2);
  ctx.beginPath();
  ctx.moveTo(s * 0.15, -s * 1.0);
  ctx.lineTo(s * 0.15, s * 1.0);
  ctx.stroke();

  // Small straight tailplane near the tail.
  ctx.lineWidth = Math.max(1, s * 0.15);
  ctx.beginPath();
  ctx.moveTo(-s * 0.75, -s * 0.42);
  ctx.lineTo(-s * 0.75, s * 0.42);
  ctx.stroke();

  // Spinner + propeller arc at the nose.
  ctx.lineWidth = Math.max(1, s * 0.1);
  ctx.beginPath();
  ctx.arc(s * 1.0, 0, s * 0.28, -Math.PI * 0.5, Math.PI * 0.5);
  ctx.stroke();

  ctx.lineWidth = lw;
}

function drawCommercial(ctx, size) {
  // Airliner: a long tubular fuselage with a rounded nose, swept-back wings, a
  // tall vertical tail fin plus horizontal stabilizers, and two engine
  // nacelles under the wings. Clearly longer/larger than the light plane.
  const s = size;
  const lw = ctx.lineWidth;

  // Long tubular fuselage with a rounded nose at +x.
  ctx.beginPath();
  ctx.moveTo(s * 1.2, 0); // nose tip
  ctx.lineTo(s * 0.7, -s * 0.2);
  ctx.lineTo(-s * 1.0, -s * 0.18);
  ctx.lineTo(-s * 1.15, 0); // tail cone
  ctx.lineTo(-s * 1.0, s * 0.18);
  ctx.lineTo(s * 0.7, s * 0.2);
  ctx.closePath();
  ctx.fill();

  // Swept-back main wings (root near mid-fuselage, tips trailing back).
  ctx.beginPath();
  ctx.moveTo(s * 0.25, s * 0.1);
  ctx.lineTo(-s * 0.7, s * 1.15);
  ctx.lineTo(-s * 0.95, s * 1.1);
  ctx.lineTo(-s * 0.15, s * 0.1);
  ctx.closePath();
  ctx.moveTo(s * 0.25, -s * 0.1);
  ctx.lineTo(-s * 0.7, -s * 1.15);
  ctx.lineTo(-s * 0.95, -s * 1.1);
  ctx.lineTo(-s * 0.15, -s * 0.1);
  ctx.closePath();
  ctx.fill();

  // Horizontal stabilizers (smaller swept tail wings).
  ctx.beginPath();
  ctx.moveTo(-s * 0.85, s * 0.08);
  ctx.lineTo(-s * 1.25, s * 0.55);
  ctx.lineTo(-s * 1.35, s * 0.5);
  ctx.lineTo(-s * 1.1, s * 0.05);
  ctx.closePath();
  ctx.moveTo(-s * 0.85, -s * 0.08);
  ctx.lineTo(-s * 1.25, -s * 0.55);
  ctx.lineTo(-s * 1.35, -s * 0.5);
  ctx.lineTo(-s * 1.1, -s * 0.05);
  ctx.closePath();
  ctx.fill();

  // Vertical tail fin: a slim stroke along the fuselage axis at the tail so it
  // reads even though we are looking top-down.
  ctx.lineWidth = Math.max(1, s * 0.16);
  ctx.beginPath();
  ctx.moveTo(-s * 0.8, 0);
  ctx.lineTo(-s * 1.3, 0);
  ctx.stroke();

  // Two engine nacelles under the wings (short thick strokes).
  ctx.lineWidth = Math.max(1.5, s * 0.26);
  ctx.beginPath();
  ctx.moveTo(-s * 0.1, s * 0.55);
  ctx.lineTo(-s * 0.4, s * 0.6);
  ctx.moveTo(-s * 0.1, -s * 0.55);
  ctx.lineTo(-s * 0.4, -s * 0.6);
  ctx.stroke();

  ctx.lineWidth = lw;
}

function drawHelicopter(ctx, size) {
  // Helicopter: an egg/teardrop cabin pointed +x, a slim tail boom with a small
  // vertical tail rotor, and a large, clearly visible main rotor disc + blades
  // spanning the body so it is unmistakable from above.
  const s = size;
  const lw = ctx.lineWidth;

  // Egg/teardrop cabin: fat at the nose, tapering toward the boom.
  ctx.beginPath();
  ctx.ellipse(s * 0.05, 0, s * 0.55, s * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();

  // Tail boom extending back (-x).
  ctx.lineWidth = Math.max(1, s * 0.16);
  ctx.beginPath();
  ctx.moveTo(-s * 0.3, 0);
  ctx.lineTo(-s * 1.25, 0);
  ctx.stroke();

  // Small vertical tail rotor at the end of the boom.
  ctx.lineWidth = Math.max(1, s * 0.12);
  ctx.beginPath();
  ctx.moveTo(-s * 1.25, -s * 0.3);
  ctx.lineTo(-s * 1.25, s * 0.3);
  ctx.stroke();

  // Main rotor disc: faint circle plus two blade strokes across the cabin.
  ctx.lineWidth = Math.max(1, s * 0.08);
  ctx.beginPath();
  ctx.arc(s * 0.05, 0, s * 1.05, 0, Math.PI * 2);
  ctx.stroke();

  ctx.lineWidth = Math.max(1, s * 0.14);
  ctx.beginPath();
  ctx.moveTo(s * 0.05 - s * 1.05, -s * 0.12);
  ctx.lineTo(s * 0.05 + s * 1.05, s * 0.12);
  ctx.moveTo(s * 0.05 - s * 1.05, s * 0.12);
  ctx.lineTo(s * 0.05 + s * 1.05, -s * 0.12);
  ctx.stroke();

  // Rotor hub dot at the center.
  ctx.beginPath();
  ctx.arc(s * 0.05, 0, Math.max(1, s * 0.14), 0, Math.PI * 2);
  ctx.fill();

  ctx.lineWidth = lw;
}

function drawSupersonic(ctx, size) {
  // Supersonic/military jet: a sharp needle nose, a sleek sharply-swept delta
  // wing, forward canards and a sharp vertical tail. An aggressive dart, but
  // detailed enough to read as a fast fighter rather than a plain triangle.
  const s = size;
  const lw = ctx.lineWidth;

  // Needle fuselage: a long sharp spike.
  ctx.beginPath();
  ctx.moveTo(s * 1.45, 0); // needle nose
  ctx.lineTo(-s * 0.5, -s * 0.16);
  ctx.lineTo(-s * 1.0, -s * 0.12);
  ctx.lineTo(-s * 1.0, s * 0.12);
  ctx.lineTo(-s * 0.5, s * 0.16);
  ctx.closePath();
  ctx.fill();

  // Sharply-swept delta wing (tips trail well back toward the tail).
  ctx.beginPath();
  ctx.moveTo(s * 0.25, 0);
  ctx.lineTo(-s * 0.95, s * 0.95);
  ctx.lineTo(-s * 0.95, s * 0.25);
  ctx.closePath();
  ctx.moveTo(s * 0.25, 0);
  ctx.lineTo(-s * 0.95, -s * 0.95);
  ctx.lineTo(-s * 0.95, -s * 0.25);
  ctx.closePath();
  ctx.fill();

  // Forward canards near the nose (small sharp foreplanes).
  ctx.beginPath();
  ctx.moveTo(s * 0.7, 0);
  ctx.lineTo(s * 0.25, s * 0.45);
  ctx.lineTo(s * 0.35, s * 0.08);
  ctx.closePath();
  ctx.moveTo(s * 0.7, 0);
  ctx.lineTo(s * 0.25, -s * 0.45);
  ctx.lineTo(s * 0.35, -s * 0.08);
  ctx.closePath();
  ctx.fill();

  // Sharp vertical tail fin at the back (stroke along the axis).
  ctx.lineWidth = Math.max(1, s * 0.14);
  ctx.beginPath();
  ctx.moveTo(-s * 0.7, 0);
  ctx.lineTo(-s * 1.15, 0);
  ctx.stroke();

  ctx.lineWidth = lw;
}
