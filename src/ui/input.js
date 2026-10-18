// Pointer-based path drawing (touch AND mouse via Pointer Events). Browser-
// coupled module: it is only ever constructed by main.js inside start(), so the
// pure modules it imports keep loading under Node. The pure coordinate-mapping
// and point-throttling helpers are exported separately for reuse/testing.
//
// Interaction:
//   pointerdown on an aircraft hitbox  -> begin drawing a route from the plane
//   pointermove                        -> append throttled points (live path)
//   pointerup                          -> finalize: set the plane's Path; if the
//                                         endpoint falls in a runway approach
//                                         cone (correct angle) or on the helipad,
//                                         snap/lock the path to the runway
//                                         centerline ("cleared to land").
// Uses touch-action:none (set in CSS) so the browser never steals the gesture.

import { Components } from "../ecs/components.js";
import { getAircraftDef } from "../game/aircraft.js";
import { rebuildPath } from "../ecs/systems/movementSystem.js";
import {
  findLandingTarget,
  captureRunway,
  isHelipadLanding,
  helipadCaptureRadius,
  runwayThreshold,
  runwayFarEnd,
  holdingPatternPoints,
  isOverHospital,
  routePassesHospital,
  approachHeadingFromPath,
} from "../game/airport.js";
import { isLandingDirectionLegal } from "../game/weather.js";
import { EmergencyType } from "../game/emergencies.js";

/** Minimum world-space distance between appended control points (px). */
const MIN_POINT_DISTANCE = 12;

/**
 * Convert a pointer event's client coordinates to world/canvas coordinates.
 * Accounts for the canvas CSS box; the game draws in CSS pixels (the 2D context
 * already has the devicePixelRatio transform applied in main.js), and there is
 * no camera offset on Map 1, so world == CSS-pixel space. Pure helper.
 * @param {DOMRect} rect canvas bounding rect
 * @param {number} clientX
 * @param {number} clientY
 */
export function screenToWorld(rect, clientX, clientY, camera, width, height) {
  let x = clientX - rect.left;
  let y = clientY - rect.top;
  // Undo the camera translate (renderSystem centers camera.target on screen).
  if (camera && camera.target && width != null && height != null) {
    x -= width / 2 - camera.target.x;
    y -= height / 2 - camera.target.y;
  }
  return { x, y };
}

/** Whether a point is within an aircraft's pickable radius. Pure helper. */
export function hitTest(px, py, ax, ay, radius) {
  return Math.hypot(px - ax, py - ay) <= radius;
}

/**
 * Build a DISPLAY-ONLY preview descriptor for an in-progress drawn route. This
 * is the only channel the render layer reads for the pending line while the
 * player drags; the authoritative sim (movement/landing/collision) never reads
 * it, so the plane keeps flying its committed Path until pointerup. Pure helper
 * (returns a fresh snapshot of the points so later mutation of `points` cannot
 * retroactively change an already-published preview). Returns null for a route
 * with fewer than two points (nothing to draw yet).
 */
export function setDrawPreview(id, points) {
  if (!points || points.length < 2) return null;
  return { id, points: points.map((p) => ({ x: p.x, y: p.y })) };
}

/**
 * Attach pointer handlers to a canvas for a game instance. Returns a detach
 * function that removes the listeners. Browser-only; call from start().
 */
export function attachInput(canvas, game) {
  const { world } = game;

  let drawing = null; // { id, points: [...] }

  function pick(worldPt) {
    // Choose the closest aircraft whose generous pick radius contains the point.
    const ids = world.query(Components.Transform, Components.Aircraft);
    let best = null;
    let bestDist = Infinity;
    for (const id of ids) {
      const t = world.getComponent(id, Components.Transform);
      const ac = world.getComponent(id, Components.Aircraft);
      if (ac.state === "landing") continue; // already committed
      const def = getAircraftDef(ac.kind);
      const pickRadius = Math.max(18, def.hitboxRadius * 2.2);
      const d = Math.hypot(worldPt.x - t.x, worldPt.y - t.y);
      if (d <= pickRadius && d < bestDist) {
        bestDist = d;
        best = id;
      }
    }
    return best;
  }

  function onPointerDown(ev) {
    if (game.gameOver) return;
    const rect = canvas.getBoundingClientRect();
    const pt = screenToWorld(rect, ev.clientX, ev.clientY, game.camera, game.width, game.height);
    const id = pick(pt);
    if (id == null) {
      game.selectedId = null;
      return;
    }
    const t = world.getComponent(id, Components.Transform);
    const wasSelected = game.selectedId === id;
    game.selectedId = id;
    // Radio acknowledge ("Roger") when a new aircraft is selected for routing.
    if (!wasSelected && game.bus) game.bus.emit("aircraft:selected", { id });
    // Start the route from the plane's current position.
    drawing = { id, points: [{ x: t.x, y: t.y }] };
    try {
      canvas.setPointerCapture(ev.pointerId);
    } catch (_) {
      /* capture is best-effort */
    }
    ev.preventDefault();
  }

  function onPointerMove(ev) {
    if (!drawing) return;
    const rect = canvas.getBoundingClientRect();
    const pt = screenToWorld(rect, ev.clientX, ev.clientY, game.camera, game.width, game.height);
    const last = drawing.points[drawing.points.length - 1];
    if (Math.hypot(pt.x - last.x, pt.y - last.y) >= MIN_POINT_DISTANCE) {
      drawing.points.push(pt);
      // DISPLAY-ONLY live preview. Crucially we do NOT mutate the committed Path
      // here: the plane must keep flying its current route while the player
      // draws. The in-progress route lives only in `drawing` and is mirrored to
      // a display-only channel the render layer reads (same convention as the
      // radar-sweep fields). The authoritative sim never reads this.
      game.drawPreview = setDrawPreview(drawing.id, drawing.points);
    }
    ev.preventDefault();
  }

  function onPointerUp(ev) {
    if (!drawing) return;
    const id = drawing.id;
    const points = drawing.points;
    drawing = null;
    // Drawing is done: clear the display-only preview. The route is now
    // committed onto the Path via finalizePath below.
    game.drawPreview = null;
    try {
      canvas.releasePointerCapture(ev.pointerId);
    } catch (_) {
      /* ignore */
    }

    if (!world.hasEntity(id) || points.length < 2) {
      finalizePath(game, id, points);
      return;
    }
    finalizePath(game, id, points);
    ev.preventDefault();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);

  return function detach() {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
  };
}

/**
 * Finalize a drawn route onto a plane's Path component. If the endpoint lines up
 * with a runway approach cone (or the helipad for a helicopter), the path is
 * snapped so its tail follows the runway centerline and marked locked. Exported
 * (DOM-free) so the snap logic is testable.
 */
export function finalizePath(game, id, points) {
  const { world, map } = game;
  if (!world.hasEntity(id)) return;
  const path = world.getComponent(id, Components.Path);
  const ac = world.getComponent(id, Components.Aircraft);
  if (!path || !ac) return;

  if (!points || points.length < 2) {
    path.points = [];
    path.built = null;
    path.progress = 0;
    path.locked = false;
    return;
  }

  const def = getAircraftDef(ac.kind);

  // Approach direction at the drawn endpoint, averaged over the path tail so a
  // hand-drawn / touch wobble on the final segment does not throw it off.
  const approachHeading = approachHeadingFromPath(points);

  // Medical-evac: if the DRAWN route passes over the hospital POI, satisfy the
  // overflight gate immediately (routePassesHospital over the polyline) rather
  // than waiting for the live position tick. The live-position tracking in the
  // emergency system remains as a fallback for routes sampled between points.
  if (
    ac.emergency &&
    ac.emergency.type === EmergencyType.MEDICAL &&
    !ac.emergency.hospitalVisited &&
    map.hospital &&
    routePassesHospital(map.hospital, points)
  ) {
    ac.emergency.hospitalVisited = true;
    if (game.bus) game.bus.emit("emergency:hospitalreached", { id, kind: ac.kind });
  }

  // FEAT-003: pass the current wind snapshot so snapToLanding only offers a
  // runway DIRECTION that is currently legal (into-wind, or either end during a
  // wind-shift transition window). This enforces one-direction-at-a-time at
  // ROUTING time without importing the live weather controller into the pure
  // helper. game.weather is undefined during headless/pure usage (all legal).
  const snapped = snapToLanding(map, points, approachHeading, def, ac.assignment, game.weather);

  path.holding = snapped.holding ?? false;
  path.points = snapped.points;
  path.progress = 0;
  path.built = null;
  path._dirty = true;
  path.locked = snapped.locked;
  // Record the resolved landing clearance so the landing system can commit the
  // rollout once the plane tracks down to the runway/helipad, without having to
  // re-derive alignment from the snapped tail (which already sits on the strip).
  ac.clearance = snapped.clearance ?? null;
  rebuildPath(path, def);
}

/**
 * If the endpoint of `points` falls on (or near) a valid landing surface, extend
 * the path so it runs down the runway centerline (or onto the helipad) and lock
 * it with a recorded clearance. Returns {points, locked, clearance, holding?}.
 *
 * Resolution order (FEAT-002 landing-reliability fix):
 *   1. Strict findLandingTarget — preserves the precise cone behavior and all
 *      existing snap tests when the player drags a clean approach.
 *   2. Forgiving captureRunway / widened helipad capture — catches the common
 *      "scuffed" approaches (short of the cone mouth, past the far end, slightly
 *      off-axis, wobbly tail) that the strict cone rejected.
 * On ANY capture (strict OR forgiving) the tail is AUTO-APPENDED with a short
 * runway-aligned lead-in segment and then the threshold point, so the built
 * polyline's final course is ALWAYS the legal landing heading. This guarantees
 * the landing system's windAllows / approachHeadingFromPath checks see a legal
 * final approach and commit the landing.
 *
 * `assignment` (from Aircraft.assignment) is honored: when mode === 'forced' and
 * it names a runwayId, capture is restricted to that runway so a forced jet
 * cannot land on the wrong strip. A forced-pad helicopter only captures pads.
 * Pure function.
 *
 * @param {object} map built map
 * @param {Array<{x:number,y:number}>} points drawn route
 * @param {number} approachHeading averaged tail heading (radians)
 * @param {object} def aircraft definition
 * @param {object|null} [assignment] Aircraft.assignment
 * @param {object|null} [windState] current wind snapshot (game.weather). When
 *   present, a runway may only be cleared in a currently-legal DIRECTION
 *   (into-wind, or either end during a transition window). When omitted (pure/
 *   headless usage) all directions are allowed.
 */
export function snapToLanding(map, points, approachHeading, def, assignment = null, windState = null) {
  const end = points[points.length - 1];
  const forced = assignment && assignment.mode === "forced" ? assignment : null;
  const forcedRunwayId = forced && forced.kind === "runway" ? forced.runwayId : null;

  // Only offer a runway DIRECTION that is currently wind-legal. Helipads have no
  // fixed landing direction so they are unaffected.
  const directionLegal = (dir) =>
    !windState || windState.windDirection == null || isLandingDirectionLegal(dir, windState);

  // --- Helipad (helicopters) -----------------------------------------------
  // A forced-pad assignment only lands on a pad; otherwise strict helipad
  // capture still runs first via findLandingTarget below. Here we also provide a
  // widened fallback so a route ending NEAR the pad (any heading) captures.
  if (def.landsOnHelipad) {
    const pads = map.helipads && map.helipads.length ? map.helipads : map.helipad ? [map.helipad] : [];
    let padTarget = null;
    // Strict first (keeps the primary-pad behavior), then widened across pads.
    if (map.helipad && isHelipadLanding(map.helipad, end, def)) {
      padTarget = map.helipad;
    } else {
      let bestD = Infinity;
      for (const pad of pads) {
        const d = Math.hypot(end.x - pad.x, end.y - pad.y);
        if (d <= helipadCaptureRadius(pad) && d < bestD) {
          bestD = d;
          padTarget = pad;
        }
      }
    }
    if (padTarget) {
      return buildHelipadSnap(points, padTarget);
    }
    // Fall through: no pad captured. A helicopter does not use runways.
  }

  // --- Runway: strict cone first, then forgiving capture -------------------
  let target = findLandingTarget(map, end, approachHeading, def);
  // If the strict target contradicts a forced runway, drop it so we re-resolve
  // (the forced jet must not commit to the wrong strip).
  if (target && target.type === "runway" && forcedRunwayId && target.surface.id !== forcedRunwayId) {
    target = null;
  }
  // Drop a strict target whose landing DIRECTION is not currently wind-legal so
  // we do not clear a route to the wrong (down-wind) end.
  if (target && target.type === "runway" && !directionLegal(target.direction)) {
    target = null;
  }
  if (!target && def.usesRunway) {
    const captured = captureRunway(map, end, approachHeading, def, { forcedRunwayId });
    if (captured && captured.type === "runway" && directionLegal(captured.direction)) {
      target = captured;
    } else {
      target = null;
    }
  }

  if (target && target.type === "runway") {
    return buildRunwaySnap(points, target.surface, target.direction);
  }
  if (target && target.type === "helipad") {
    return buildHelipadSnap(points, target.surface);
  }

  // --- Holding pattern (no landing) ----------------------------------------
  if (map.holdFix && isNearHoldFix(map.holdFix, end)) {
    const orbit = holdingPatternPoints(map.holdFix);
    return {
      points: points.concat(orbit),
      locked: false,
      holding: true,
      clearance: null,
    };
  }
  return { points: points.slice(), locked: false, clearance: null };
}

/**
 * Append a runway-aligned lead-in + threshold so the built route's final course
 * is exactly the legal landing heading, and return a locked runway clearance.
 * Used for BOTH the strict and the forgiving capture so every accepted approach
 * ends on the centerline. Pure helper.
 */
function buildRunwaySnap(points, runway, direction) {
  const dirRunway = { ...runway, heading: direction };
  const thr = runwayThreshold(dirRunway);
  const far = runwayFarEnd(dirRunway);
  // A short straight lead-in BEFORE the threshold, aligned to the landing
  // direction, so the tail heading reads as the runway heading even when the
  // player's drag approached off-axis. Scale the lead-in with the cone length.
  const lead = Math.max(24, runway.approach.coneLength * 0.35);
  const leadPt = {
    x: thr.x - Math.cos(direction) * lead,
    y: thr.y - Math.sin(direction) * lead,
  };
  const out = points.slice();
  out.push(leadPt);
  out.push({ x: thr.x, y: thr.y });
  return {
    points: out,
    locked: true,
    clearance: {
      surface: "runway",
      runwayId: runway.id,
      heading: direction,
      threshold: { x: thr.x, y: thr.y },
      stop: { x: far.x, y: far.y },
    },
  };
}

/** Append the pad center and return a locked helipad clearance. Pure helper. */
function buildHelipadSnap(points, pad) {
  const out = points.slice();
  out.push({ x: pad.x, y: pad.y });
  return {
    points: out,
    locked: true,
    clearance: { surface: "helipad", stop: { x: pad.x, y: pad.y } },
  };
}

/** Whether a point is close enough to a hold fix to trigger a holding orbit. */
export function isNearHoldFix(fix, point) {
  if (!fix) return false;
  return Math.hypot(point.x - fix.x, point.y - fix.y) <= fix.radius * 1.5;
}

/** Re-export for callers that need the hospital overflight test. */
export { isOverHospital };

/** For internal reuse. */
export { MIN_POINT_DISTANCE };
