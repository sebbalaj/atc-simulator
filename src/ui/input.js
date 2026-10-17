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
  runwayThreshold,
  runwayFarEnd,
  holdingPatternPoints,
  isOverHospital,
  routePassesHospital,
  approachHeadingFromPath,
} from "../game/airport.js";
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
      // Live preview: write the raw points so the render system shows the path.
      const path = world.getComponent(drawing.id, Components.Path);
      if (path) {
        path.points = drawing.points.slice();
        path.built = null;
        path.progress = 0;
        path.locked = false;
      }
    }
    ev.preventDefault();
  }

  function onPointerUp(ev) {
    if (!drawing) return;
    const id = drawing.id;
    const points = drawing.points;
    drawing = null;
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

  const snapped = snapToLanding(map, points, approachHeading, def);

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
 * If the endpoint of `points` falls in a valid landing surface, extend the path
 * so it runs down the runway centerline (or onto the helipad). Returns
 * {points, locked}. Pure function.
 */
export function snapToLanding(map, points, approachHeading, def) {
  const end = points[points.length - 1];
  const target = findLandingTarget(map, end, approachHeading, def);
  if (!target) {
    // Holding pattern: if the route ends near the hold fix, append a circular
    // orbit so the plane loops there (burning fuel) instead of flying off.
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

  if (target.type === "runway") {
    const runway = target.surface;
    const dirRunway = { ...runway, heading: target.direction };
    const thr = runwayThreshold(dirRunway);
    const far = runwayFarEnd(dirRunway);
    // Replace the raw tail with the threshold so the plane tracks the centerline
    // onto the numbers; the landing system then rolls it out to the far end.
    const out = points.slice();
    out.push({ x: thr.x, y: thr.y });
    return {
      points: out,
      locked: true,
      clearance: {
        surface: "runway",
        runwayId: runway.id,
        heading: target.direction,
        threshold: { x: thr.x, y: thr.y },
        stop: { x: far.x, y: far.y },
      },
    };
  }

  // Helipad: steer onto the pad center.
  const pad = target.surface;
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
