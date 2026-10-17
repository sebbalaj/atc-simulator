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
import { AircraftKind } from "../../game/aircraft.js";
import { isOverHospital } from "../../game/airport.js";
import {
  createEmergencyController,
  EmergencyType,
  isFuelEmergency,
  markFuelEmergency,
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
  system.detach = () => {
    for (const u of unsub) u();
    unsub.length = 0;
  };
  return system;
}
