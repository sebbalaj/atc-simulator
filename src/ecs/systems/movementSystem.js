// Movement system. Advances each aircraft along its Path (a Catmull-Rom spline)
// at its class speed, using arc-length parameterization so speed stays constant
// regardless of control-point spacing. Planes with no path fly straight on their
// current heading. The system also (re)builds a path's arc-length polyline when
// its control points change, validating/clamping turns against the class limit
// so SUPERSONIC jets cannot be given impossibly sharp routes.

import { Components } from "../components.js";
import { getAircraftDef } from "../../game/aircraft.js";
import { buildPath, clampTurns, sampleAlong } from "../../game/pathUtils.js";
import { drainFuel } from "../../game/fuel.js";
import { updateMovingRunways, holdingPatternPoints } from "../../game/maps.js";
import { maydaySpeedFactor } from "../../game/emergencies.js";

// A plane without a cleared route for this many seconds counts as "held too
// long" and costs reputation once (per hold episode).
export const EXCESSIVE_HOLD_TIME = 30;

/**
 * Ensure a Path component has an up-to-date built polyline. Turns are clamped to
 * the class max so the followed route is always flyable. Returns the built path.
 * Exposed for input.js to validate a freshly drawn path.
 */
export function rebuildPath(path, aircraftDef) {
  const safePoints = clampTurns(path.points, aircraftDef.maxTurnAngle);
  const built = buildPath(safePoints);
  path.built = built;
  path.points = safePoints;
  path._dirty = false;
  return built;
}

/** Build the ECS movement system bound to a game instance. */
export function createMovementSystem(game) {
  const { world, bus } = game;

  /** Whether the Automated Holding Patterns upgrade is owned (reads the flag). */
  function holdingAutomationEnabled() {
    return !!(
      game.upgradeState &&
      game.upgradeState.flags &&
      game.upgradeState.flags.holdingAutomation
    );
  }

  /**
   * Nearest hold fix to a transform. Supports a single map.holdFix (the common
   * case) or a map.holdFixes[] list; returns null when the map defines none.
   */
  function nearestHoldFix(t) {
    const map = game.map;
    if (!map) return null;
    const fixes = map.holdFixes && map.holdFixes.length ? map.holdFixes : map.holdFix ? [map.holdFix] : [];
    let best = null;
    let bestDist = Infinity;
    for (const f of fixes) {
      const d = Math.hypot(t.x - f.x, t.y - f.y);
      if (d < bestDist) {
        bestDist = d;
        best = f;
      }
    }
    return best;
  }

  return function movementSystem(dt) {
    // Advance any moving runways (Map 3 carrier) so the landing system and the
    // approach cone track the live deck position this tick.
    updateMovingRunways(game.map, dt);
    const ids = world.query(Components.Transform, Components.Aircraft);
    for (const id of ids) {
      const t = world.getComponent(id, Components.Transform);
      const ac = world.getComponent(id, Components.Aircraft);
      const def = getAircraftDef(ac.kind);
      const path = world.getComponent(id, Components.Path);

      // Once committed to a landing the landing system drives the rollout; the
      // path-follower must not fight it by snapping the plane back to the path.
      if (ac.state === "landing") continue;

      // Effective speed: base class speed scaled by any stamped speedFactor, and
      // further bumped for a MAYDAY (engine-failure dive) via the pure helper so
      // the emergency state — not just a one-time stamped field — drives it.
      const speed = maydaySpeedFactor(ac.emergency, def.speed * (ac.speedFactor ?? 1));

      // A plane that has not been cleared toward a runway/helipad is effectively
      // being held in the airspace: no locked route means "holding". Holding
      // burns fuel faster and, past a threshold, costs reputation once.
      const holding = !(path && path.locked);

      let completed = false;
      if (path && path.points && path.points.length >= 2) {
        if (!path.built || path._dirty) rebuildPath(path, def);
        const built = path.built;
        path.progress = Math.min(built.length, (path.progress ?? 0) + speed * dt);
        const sample = sampleAlong(built, path.progress);
        t.x = sample.x;
        t.y = sample.y;
        t.heading = sample.heading;

        if (path.progress >= built.length) {
          if (path.holding && built.length > 0) {
            // Holding-pattern orbit: loop back to the start so the plane keeps
            // circling the hold fix (and keeps burning fuel) until re-routed.
            path.progress = path.progress % built.length;
          } else {
            // Reached the end of the drawn route.
            path.completed = true;
            completed = true;
            // Automated Holding Patterns upgrade: instead of letting an
            // un-cleared plane fly straight off the end of its route (and drift
            // out of the airspace / burn out), auto-convert the finished route
            // into a holding orbit at the nearest hold fix so it loops safely
            // until the controller re-routes it. Only when the upgrade is owned.
            if (!ac.clearance && !path.holding && holdingAutomationEnabled()) {
              const fix = nearestHoldFix(t);
              if (fix) {
                const orbit = holdingPatternPoints(fix);
                path.points = orbit;
                path.holding = true;
                path.completed = false;
                path.built = null;
                path._dirty = true;
                path.progress = 0;
                completed = false;
                rebuildPath(path, def);
                if (bus) bus.emit("holding:auto", { id, kind: ac.kind, fix: fix.id });
              }
            }
          }
        }
      } else {
        // No path: fly straight ahead on the current heading.
        t.x += Math.cos(t.heading) * speed * dt;
        t.y += Math.sin(t.heading) * speed * dt;
      }

      // Fuel burn. A plane with no cleared route (or one that has flown out the
      // end of its drawn route without a clearance) is holding and burns faster.
      const fuel = world.getComponent(id, Components.Fuel);
      if (fuel) {
        const burnHolding = holding || (completed && !ac.clearance);
        const res = drainFuel(fuel, dt, { holding: burnHolding });
        if (res.justEmptied && bus) {
          bus.emit("aircraft:fuelout", {
            id,
            kind: ac.kind,
            passengers: ac.passengers,
          });
          world.destroyEntity(id);
          continue;
        }
      }

      // Excessive-hold tracking: accumulate time spent holding and flag it once.
      if (holding) {
        ac.holdTime = (ac.holdTime ?? 0) + dt;
        if (ac.holdTime >= EXCESSIVE_HOLD_TIME && !ac.heldFlagged) {
          ac.heldFlagged = true;
          if (bus) {
            bus.emit("aircraft:excessivehold", { id, kind: ac.kind });
          }
        }
      } else {
        // Cleared toward a surface: reset the hold episode so a future hold can
        // flag again.
        ac.holdTime = 0;
        ac.heldFlagged = false;
      }
    }
  };
}
