// Emergency system. Wires the emergency decision logic (game/emergencies.js)
// into the live simulation:
//   - On spawn, it rolls to flag a plane as a MAYDAY (engine failure) or, for
//     helicopters, a MEDICAL evac, stamping the Aircraft.emergency state.
//   - Each tick it tracks medical-evac helicopters overflying the hospital POI
//     (setting emergency.hospitalVisited so landing can be accepted), promotes
//     low-fuel held planes to a FUEL emergency (visible gauge flag), and marks
//     mayday planes for the red-flash / faster movement already read elsewhere.
//   - On a successful landing of an emergency aircraft it awards a reputation
//     bonus; storm losses / fuel-outs penalize reputation (handled by the
//     console's existing fuelout penalty plus a stormloss penalty added here).

import { Components } from "../components.js";
import { AircraftKind, getAircraftDef } from "../../game/aircraft.js";
import {
  isOverHospital,
  runwayThreshold,
  runwayFarEnd,
  normalizeAngle,
} from "../../game/airport.js";
import { rebuildPath } from "./movementSystem.js";
import {
  createEmergencyController,
  EmergencyType,
  isFuelEmergency,
  isMaydayPriority,
  markFuelEmergency,
  nearestAdequateRunway,
  straightLineApproach,
} from "../../game/emergencies.js";

/** Build the ECS emergency system bound to a game instance. */
export function createEmergencySystem(game) {
  const { world, bus, rng } = game;

  const controller = createEmergencyController({ rng, config: game.emergencyConfig });

  // Classify fresh spawns into emergencies. Listening to the spawn event keeps
  // the spawn system itself free of emergency concerns.
  const unsub = [];
  unsub.push(
    bus.on("aircraft:spawn", ({ id }) => {
      const ac = world.getComponent(id, Components.Aircraft);
      if (!ac || ac.emergency) return;
      const isHeli = ac.kind === AircraftKind.HELICOPTER;
      const em = controller.classifySpawn(ac, isHeli);
      if (em) {
        if (em.type === EmergencyType.MAYDAY) {
          game.flashBanner && game.flashBanner("MAYDAY - ENGINE FAILURE, PRIORITY");
          bus.emit("emergency:mayday", { id, kind: ac.kind });
          // Immediate straight-line priority clearance to the nearest adequate
          // runway, and divert all other inbound traffic out of the way.
          assignMaydayPriority(id);
        } else if (em.type === EmergencyType.MEDICAL) {
          game.flashBanner && game.flashBanner("MEDEVAC - ROUTE VIA HOSPITAL");
          bus.emit("emergency:medical", { id, kind: ac.kind });
        }
      }
    })
  );

  // Award a bonus when an emergency aircraft lands safely; penalize storm loss.
  unsub.push(
    bus.on("aircraft:landed", (p) => {
      // The entity is already destroyed by the landing system; the payload does
      // not carry the emergency flag, so we tag it on the clearance path. We
      // instead award based on a flag recorded at commit time (see below).
      if (p && p._emergency && game.reputation) {
        game.reputation.recover(controller.config.bonusReputation);
        game.flashBanner && game.flashBanner("EMERGENCY HANDLED +REP");
        bus.emit("emergency:resolved", { kind: p.kind });
      }
    })
  );

  unsub.push(
    bus.on("aircraft:stormloss", (p) => {
      if (game.reputation) game.reputation.penalize("stormLoss");
      game.flashBanner && game.flashBanner("LOST IN STORM - REP PENALTY");
      checkFired();
    })
  );

  /**
   * Give a mayday aircraft an immediate straight-line priority clearance to the
   * nearest adequate runway and divert every OTHER inbound plane: any other
   * plane currently cleared/locked toward a surface has its clearance released
   * so it reverts to holding and must be re-routed, keeping the approach free
   * for the emergency. Returns the clearance applied (or null if none possible).
   */
  function assignMaydayPriority(maydayId) {
    const ac = world.getComponent(maydayId, Components.Aircraft);
    const t = world.getComponent(maydayId, Components.Transform);
    const path = world.getComponent(maydayId, Components.Path);
    if (!ac || !t || !path || !isMaydayPriority(ac.emergency)) return null;
    if (!game.map || !game.map.runways) return null;

    const def = getAircraftDef(ac.kind);
    const runway = nearestAdequateRunway(game.map.runways, { x: t.x, y: t.y }, def);
    if (!runway) return null; // no adequate runway; player must handle manually

    const approach = straightLineApproach({ x: t.x, y: t.y }, runway, {
      threshold: runwayThreshold,
      farEnd: runwayFarEnd,
      normalizeAngle,
    });

    // Stamp the straight-in route + clearance exactly as a hand-drawn clearance
    // would, so the landing system commits it with no player action required.
    path.points = approach.points;
    path.holding = false;
    path.completed = false;
    path.progress = 0;
    path.built = null;
    path._dirty = true;
    path.locked = true;
    ac.clearance = approach.clearance;
    rebuildPath(path, def);

    // Divert all other inbound traffic: release their clearances so they hold.
    const others = world.query(Components.Transform, Components.Aircraft, Components.Path);
    for (const otherId of others) {
      if (otherId === maydayId) continue;
      const oac = world.getComponent(otherId, Components.Aircraft);
      const opath = world.getComponent(otherId, Components.Path);
      if (!oac || !opath) continue;
      if (oac.state === "landing") continue; // already committed to the runway
      if (opath.locked || oac.clearance) {
        opath.locked = false;
        opath.completed = false;
        oac.clearance = null;
      }
    }

    bus.emit("emergency:priority-cleared", { id: maydayId, runwayId: runway.id });
    game.flashBanner && game.flashBanner("PRIORITY: ALL TRAFFIC DIVERTED");
    return approach.clearance;
  }

  function checkFired() {
    if (game.reputation && game.reputation.isFired() && !game.gameOver) {
      game.gameOver = true;
      game.gameOverReason = "fired";
      bus.emit("level:over", { reason: "fired" });
    }
  }

  const system = function emergencySystem() {
    if (game.gameOver) return;
    const ids = world.query(Components.Transform, Components.Aircraft);
    for (const id of ids) {
      const ac = world.getComponent(id, Components.Aircraft);
      const t = world.getComponent(id, Components.Transform);

      // Medical evac: track hospital overflight.
      if (ac.emergency && ac.emergency.type === EmergencyType.MEDICAL) {
        const hospital = game.map && game.map.hospital;
        if (!ac.emergency.hospitalVisited && hospital && isOverHospital(hospital, t.x, t.y)) {
          ac.emergency.hospitalVisited = true;
          void hospital;
          bus.emit("emergency:hospitalreached", { id, kind: ac.kind });
          game.flashBanner && game.flashBanner("HOSPITAL REACHED - CLEARED TO LAND");
        }
      }

      // Fuel emergency: a held/low-fuel plane that is not already flagged.
      const fuel = world.getComponent(id, Components.Fuel);
      if (fuel && isFuelEmergency(fuel)) {
        const alreadyFuel = ac.emergency && ac.emergency.type === EmergencyType.FUEL;
        // Do not downgrade a mayday/medical emergency; fuel gauge still shows via
        // fuel.low. Only auto-flag ordinary planes so the HUD red-flags them.
        if (!ac.emergency) {
          markFuelEmergency(ac);
          bus.emit("emergency:fuel", { id, kind: ac.kind });
          game.flashBanner && game.flashBanner("FUEL EMERGENCY");
        }
        void alreadyFuel;
      }
    }
  };

  system.controller = controller;
  // Exposed for headless tests and manual triggering of a priority clearance.
  system.assignMaydayPriority = assignMaydayPriority;
  system.detach = () => {
    for (const u of unsub) u();
    unsub.length = 0;
  };
  return system;
}
