// Landing system. When an aircraft's drawn path terminates in a runway approach
// cone it is aligned with (correct angle + heading + the runway long enough for
// the class), or on the helipad for a helicopter, the approach is locked
// ("cleared to land"). The plane then rolls down the runway; once it reaches the
// stop end the entity is removed and 'aircraft:landed' is emitted with
// {kind, passengers, timeInAirspace}. Runway occupancy/clear-time blocks the
// next landing on the same runway.

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

      if (ac.state === "landing") {
        // Roll down the active surface toward the stop point.
        advanceLanding(id, t, ac, def, dt);
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
        occupyRunway(runway, game.time);
      }
      announceCleared(id, ac, c);
      ac.landing = {
        surface: "runway",
        heading: c.heading,
        stop: c.stop,
        // Moving-runway (carrier) landings track the live far-end each tick.
        runwayId: runway && runway.moving ? c.runwayId : null,
      };
    } else {
      announceCleared(id, ac, c);
      ac.landing = { surface: "helipad", heading: t.heading, stop: c.stop };
    }
    ac.state = "landing";
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

  function advanceLanding(id, t, ac, def, dt) {
    const info = ac.landing;
    // For a moving runway (carrier) refresh the stop point to the live far-end
    // so the rollout tracks the deck as it translates under the aircraft.
    if (info.runwayId) {
      const runway = runwayById(info.runwayId);
      if (runway) {
        info.stop = runwayFarEnd({ ...runway, heading: info.heading });
      }
    }
    const stop = info.stop;
    // Decelerate along the landing direction toward the stop point.
    const speed = def.speed * 0.55;
    const toStop = Math.hypot(stop.x - t.x, stop.y - t.y);
    const step = speed * dt;

    if (toStop <= step || toStop < 2) {
      // Touchdown complete: remove the entity and award the landing.
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
      return;
    }

    const dir = Math.atan2(stop.y - t.y, stop.x - t.x);
    t.x += Math.cos(dir) * step;
    t.y += Math.sin(dir) * step;
    t.heading = info.heading ?? dir;
  }
}
