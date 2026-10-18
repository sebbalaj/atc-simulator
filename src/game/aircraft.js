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
// aircraft read at a calm, deliberate pace. Class SPEED ORDERING is preserved:
// helicopter 7.5 <= light 10 < commercial 17.5 < supersonic 25.
//
// FEAT-006 fuel rebalance ("fuel felt too easy"): the FEAT-003 slowdown was
// paired with a blunt ~4x fuelMax scale-up (light 200->640, heli 250->760,
// commercial 340->1000, supersonic 150->480) that left every tank so deep that
// running out was never a real threat. Fuel is measured in SECONDS of flight,
// so we re-derive the budgets from map geometry: the worst-case DIRECT route
// from the spawn perimeter (map.spawnRadius) to the farthest surface a class may
// be sent to, at its cruise speed, is the floor. Measured maxima across the four
// 400x700 maps (farthest eligible surface): light ~40s, commercial ~23s,
// helicopter ~69s, supersonic ~16s. fuelMax is set BELOW the old values but
// comfortably ABOVE floor*1.3 so a direct route always lands with margin, while
// a plane left HOLDING (burns HOLDING_BURN_MULTIPLIER=1.6x) or routed the long
// way can now genuinely run out:
//   light 640->420 (34% cut), commercial 1000->620 (38%),
//   helicopter 760->500 (34%), supersonic 480->300 (38%).
// RESERVE ORDERING (the gameplay-meaningful "tightest reserve"): the time a
// full tank survives while HOLDING, fuelMax/1.6, is shortest for SUPERSONIC
// (300/1.6 ~= 188s) < light (263s) < helicopter (313s) < commercial (388s), so
// a supersonic left to loiter is the first to flame out. SUPERSONIC is also the
// lowest absolute tank (300) and COMMERCIAL the highest (620), matching intent
// (helicopter/light low, commercial highest absolute, supersonic tightest).
// See test/fuelBalance.test.js for the revert-sensitive winnability + threat +
// ordering invariants computed from createMap geometry. The economy efficiency
// window (economy.js) and spawn cadence (spawnSystem.js) were left as tuned in
// FEAT-003; shorter tanks do not change route DURATION (speeds are unchanged),
// so both windows stay coherent.
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
 *  - assignmentPolicy:   per-class landing-assignment preference, one of
 *                        'forced-long' | 'forced-pad' | 'prefer-short' | 'any'.
 *                        COMMERCIAL/SUPERSONIC are FORCED to a long-enough
 *                        runway (they physically cannot use short strips),
 *                        HELICOPTER is FORCED to a pad, LIGHT PREFERS a short
 *                        runway but may land anywhere legal (don't-care). This
 *                        is consumed by assignLandingTarget() below. Pure data.
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
    fuelMax: 420, // FEAT-006: 640 -> 420 (direct floor ~40s, holds ~263s)
    runwayLengthRequired: 63, // FEAT-004: 90 * 0.70
    passengers: [1, 4],
    color: "#8fff6a",
    landsOnHelipad: false,
    usesRunway: true,
    assignmentPolicy: "prefer-short",
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
    fuelMax: 620, // FEAT-006: 1000 -> 620 (highest absolute; holds ~388s)
    runwayLengthRequired: 133, // FEAT-004: 190 * 0.70
    passengers: [90, 220],
    color: "#39ff14",
    landsOnHelipad: false,
    usesRunway: true,
    assignmentPolicy: "forced-long",
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
    fuelMax: 500, // FEAT-006: 760 -> 500 (direct floor ~69s, holds ~313s)
    runwayLengthRequired: 0, // uses the helipad, not a runway
    passengers: [1, 8],
    color: "#6ad1ff",
    landsOnHelipad: true,
    usesRunway: false,
    assignmentPolicy: "forced-pad",
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
    fuelMax: 300, // FEAT-006: 480 -> 300 (tightest reserve: holds only ~188s)
    runwayLengthRequired: 154, // FEAT-004: 220 * 0.70
    passengers: [1, 2],
    color: "#ffd23b",
    landsOnHelipad: false,
    usesRunway: true,
    assignmentPolicy: "forced-long",
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

/**
 * Choose a concrete landing target for a class on a given map, deterministically
 * given an rng. Returns a plain-data assignment the strip/render/landing layers
 * can read:
 *
 *   { kind: 'runway'|'helipad'|'any',
 *     runwayId?: string,   // when kind === 'runway'
 *     padId?: string,      // when kind === 'helipad'
 *     mode: 'forced'|'preferred'|'any' }
 *
 * Rules by def.assignmentPolicy:
 *   'forced-long'  (commercial/supersonic): FORCED to a runway long enough for
 *                  the class (length >= runwayLengthRequired). A specific legal
 *                  runway is picked via rng among the eligible ones.
 *   'forced-pad'   (helicopter): FORCED to a specific helipad (rng among pads).
 *   'prefer-short' (light): PREFERS the shortest legal runway (a soft target it
 *                  would rather use), but about a third of the time returns a
 *                  don't-care assignment (mode 'any', no specific surface) so a
 *                  light plane may be happy landing anywhere legal.
 *   'any'          fallback: mode 'any' with no specific surface.
 *
 * Deterministic for a fixed rng so smoke/tests are reproducible. Pure (reads
 * only map data + rng; mutates nothing). Falls back gracefully to mode 'any'
 * when no eligible surface exists on the map.
 * @param {object} def aircraft definition (from AIRCRAFT_DEFS)
 * @param {object} map a built map (runways[], helipads[]/helipad)
 * @param {object} rng seeded rng (createRng) — uses rng.pick / rng.chance
 * @returns {{kind:string, runwayId?:string, padId?:string, mode:string}}
 */
export function assignLandingTarget(def, map, rng) {
  const policy = def.assignmentPolicy || "any";
  const pads = map.helipads && map.helipads.length ? map.helipads : map.helipad ? [map.helipad] : [];
  const runways = map.runways || [];

  if (policy === "forced-pad") {
    const pad = rng && rng.pick ? rng.pick(pads) : pads[0];
    if (pad) return { kind: "helipad", padId: pad.id, mode: "forced" };
    return { kind: "any", mode: "any" };
  }

  if (policy === "forced-long") {
    const eligible = runways.filter((r) => r.length >= def.runwayLengthRequired);
    const runway = eligible.length ? (rng && rng.pick ? rng.pick(eligible) : eligible[0]) : null;
    if (runway) return { kind: "runway", runwayId: runway.id, mode: "forced" };
    return { kind: "any", mode: "any" };
  }

  if (policy === "prefer-short") {
    const legal = runways.filter((r) => r.length >= def.runwayLengthRequired);
    // Don't-care a portion of the time: a light plane that is happy anywhere.
    if (!legal.length || (rng && rng.chance && rng.chance(0.34))) {
      return { kind: "any", mode: "any" };
    }
    // Soft preference for the shortest eligible strip.
    let shortest = legal[0];
    for (const r of legal) {
      if (r.length < shortest.length) shortest = r;
    }
    return { kind: "runway", runwayId: shortest.id, mode: "preferred" };
  }

  return { kind: "any", mode: "any" };
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
