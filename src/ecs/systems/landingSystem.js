// Landing system. When an aircraft's drawn path terminates in a runway approach
// cone it is aligned with (correct angle + heading + the runway long enough for
// the class), or on the helipad for a helicopter, the approach is locked
// ("cleared to land"). The plane touches down IMMEDIATELY on reaching the
// threshold (the tail of the cleared route) / pad: the entity is removed and
// 'aircraft:landed' is emitted with {kind, passengers, timeInAirspace,
// _emergency}. No rollout to the far end (so slow/short/moving-runway landings
// resolve promptly). Runway occupancy/clear-time blocks the next landing on the
// same runway.

import { Components } from "../components.js";
import { getAircraftDef } from "../../game/aircraft.js";
import {
  findLandingTarget,
  runwayThreshold,
  runwayFarEnd,
  isRunwayClear,
  occupyRunway,
  approachHeadingFromPath,
} from "../../game/airport.js";
import { isApproachDirectionValid } from "../../game/weather.js";
import { isMedicalLandingAllowed, EmergencyType } from "../../game/emergencies.js";

/** Build the ECS landing system bound to a game instance. */
export function createLandingSystem(game) {
  const { world, bus } = game;

  function endpointAndHeading(path, t) {
    // Prefer the built polyline's tail for an accurate endpoint + direction.
    // The approach heading is averaged over the path tail (not just the last
    // two samples) so it matches the forgiving snap logic in input.finalizePath.
    if (path.built && path.built.points.length >= 2) {
      const pts = path.built.points;
      const end = pts[pts.length - 1];
      return {
        point: { x: end.x, y: end.y },
        heading: approachHeadingFromPath(pts),
      };
    }
    if (path.points && path.points.length >= 2) {
      const end = path.points[path.points.length - 1];
      return {
        point: { x: end.x, y: end.y },
        heading: approachHeadingFromPath(path.points),
      };
    }
    return { point: { x: t.x, y: t.y }, heading: t.heading };
  }

  function runwayById(rid) {
    return game.map.runways.find((r) => r.id === rid);
  }

  /**
   * Whether a resolved landing direction is legal under the current wind. With
   * no weather state (headless construction) all directions are allowed.
   * Helipad landings (no fixed direction) are always wind-legal.
   */
  function windAllows(landingHeading) {
    const w = game.weather;
    if (!w || w.windDirection == null || landingHeading == null) return true;
    return isApproachDirectionValid(landingHeading, w.windDirection, w.windTolerance);
  }

  /** Whether a medical-evac aircraft has satisfied the hospital-overflight gate. */
  function medicalAllows(ac) {
    return isMedicalLandingAllowed(ac.emergency);
  }

  return function landingSystem(dt) {
    if (game.gameOver) return;
    const map = game.map;
    const ids = world.query(Components.Transform, Components.Aircraft, Components.Path);

    for (const id of ids) {
      const t = world.getComponent(id, Components.Transform);
      const ac = world.getComponent(id, Components.Aircraft);
      const path = world.getComponent(id, Components.Path);
      const def = getAircraftDef(ac.kind);

      if (ac.state === "landing" || ac.state === "landed") {
        // Already touched down this tick (threshold landing resolves
        // immediately in commitLanding); nothing more to do.
        continue;
      }

      if (!path.points || path.points.length < 2) continue;

      // Medical evac must overfly the hospital POI before any landing clears.
      if (!medicalAllows(ac)) continue;

      // Preferred path: a clearance was resolved when the controller snapped the
      // route into an approach cone / onto the helipad (see input.finalizePath).
      // Commit the landing once the plane reaches the end of that cleared route.
      if (path.locked && ac.clearance && path.built && path.progress >= path.built.length - 0.5) {
        // Reject a runway landing whose direction is now illegal under the wind
        // (a wind shift can invalidate a previously-cleared approach).
        if (ac.clearance.surface === "runway" && !windAllows(ac.clearance.heading)) {
          continue;
        }
        commitLanding(id, t, ac, path);
        continue;
      }

      // Fallback: if no clearance was recorded but the current path tail happens
      // to sit in a valid approach, clear it now.
      if (!ac.clearance) {
        const { point, heading } = endpointAndHeading(path, t);
        const target = findLandingTarget(map, point, heading, def);
        if (!target) continue;
        if (target.type === "runway") {
          const runway = target.surface;
          if (!isRunwayClear(runway, game.time)) continue;
          if (!windAllows(target.direction)) continue;
          const dirRunway = { ...runway, heading: target.direction };
          ac.clearance = {
            surface: "runway",
            runwayId: runway.id,
            heading: target.direction,
            threshold: runwayThreshold(dirRunway),
            stop: runwayFarEnd(dirRunway),
          };
        } else if (target.type === "helipad") {
          ac.clearance = { surface: "helipad", stop: { x: target.surface.x, y: target.surface.y } };
        }
        path.locked = true;
      }
    }
  };

  function commitLanding(id, t, ac, path) {
    const c = ac.clearance;
    if (c.surface === "runway") {
      const runway = runwayById(c.runwayId);
      if (runway) {
        if (!isRunwayClear(runway, game.time)) return; // hold: runway busy
        // Mark the strip occupied at touchdown; it stays red/blocked until
        // now >= occupiedUntil (now + clearTime, shrunk by the ground-crew
        // upgrade). Called exactly once per landing.
        occupyRunway(runway, game.time);
      }
      announceCleared(id, ac, c);
      ac.state = "landing";
      // Threshold landing: touchdown is immediate at the runway threshold (the
      // tail of the cleared route), so there is no rollout to the far end. This
      // keeps short/slow-speed and moving-runway (carrier) landings resolving
      // promptly instead of chasing the far end.
      ac.landing = { surface: "runway", heading: c.heading };
    } else {
      announceCleared(id, ac, c);
      ac.state = "landing";
      ac.landing = { surface: "helipad", heading: t.heading };
    }
    // Resolve the landed/removed transition immediately on reaching the
    // threshold / pad.
    completeLanding(id, ac);
  }

  /**
   * Emit a one-shot 'landing:cleared' event when a plane commits to a landing
   * surface. Audio uses this for the "Cleared to land" callout; guarded so it
   * fires once per aircraft even if commitLanding is re-entered.
   */
  function announceCleared(id, ac, clearance) {
    if (ac._clearedAnnounced) return;
    ac._clearedAnnounced = true;
    bus.emit("landing:cleared", {
      id,
      kind: ac.kind,
      surface: clearance && clearance.surface,
    });
  }

  /**
   * Touchdown complete: mark the plane landed, remove the entity and emit
   * 'aircraft:landed' with {kind, passengers, timeInAirspace, _emergency}
   * exactly as the former rollout did. Called the moment the plane reaches the
   * threshold (runway) or pad (helipad).
   */
  function completeLanding(id, ac) {
    ac.state = "landed";
    const timeInAirspace = game.time - (ac.spawnTime ?? game.time);
    const wasEmergency = !!(
      ac.emergency &&
      (ac.emergency.type === EmergencyType.MAYDAY ||
        ac.emergency.type === EmergencyType.MEDICAL ||
        ac.emergency.type === EmergencyType.FUEL)
    );
    world.destroyEntity(id);
    bus.emit("aircraft:landed", {
      id,
      kind: ac.kind,
      passengers: ac.passengers,
      timeInAirspace,
      _emergency: wasEmergency ? ac.emergency.type : null,
    });
  }
}
