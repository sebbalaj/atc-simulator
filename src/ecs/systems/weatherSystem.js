// Weather system. Each tick it advances the WeatherController (storm drift,
// wind-shift schedule, fog schedule), then applies the resulting weather to the
// simulation:
//   - storms: any aircraft whose position sits inside a cell, or whose locked
//     route crosses a cell, loses navigation (its path is cleared) and, if it is
//     actually inside the cell, is destroyed. A destroyed plane penalizes
//     reputation like a fuel-out and emits 'aircraft:stormloss'.
//   - wind: the current wind state is exposed on game.weather for landingSystem
//     to validate approach directions against.
//   - fog: the fog intensity/visibility range is exposed for renderSystem.
// It emits HUD banner events ('weather:wind', 'weather:storm', 'weather:fog')
// as weather changes occur.

import { Components } from "../components.js";
import {
  createWeatherController,
  pointInAnyStorm,
  pathCrossesStorm,
  fogVisibilityRange,
} from "../../game/weather.js";

/** Build the ECS weather system bound to a game instance. */
export function createWeatherSystem(game) {
  const { world, bus, rng } = game;
  const map = game.map;

  const controller = createWeatherController({ rng, map, config: game.weatherConfig });

  // Publish the live weather state on the game so other systems (landing,
  // render) can read it without importing the controller.
  game.weather = {
    controller,
    windDirection: controller.state.windDirection,
    windTolerance: controller.state.windTolerance,
    storms: controller.state.storms,
    fogIntensity: 0,
    fogVisibility: Infinity,
    ilsOwned: game.ilsOwned ?? false, // FEAT-005 will flip this on purchase
  };

  function fullRange() {
    return Math.max(map.width, map.height) * 0.6;
  }

  const system = function weatherSystem(dt) {
    if (game.gameOver) return;

    const events = controller.update(dt);

    // Refresh the published snapshot.
    game.weather.windDirection = controller.state.windDirection;
    game.weather.storms = controller.state.storms;
    game.weather.fogIntensity = controller.state.fogIntensity;
    // The ILS flag is owned by FEAT-005; read it fresh each tick (default false).
    game.weather.ilsOwned = game.ilsOwned ?? false;
    game.weather.fogVisibility = fogVisibilityRange(
      controller.state.fogIntensity,
      fullRange(),
      game.weather.ilsOwned
    );

    // Announce changes via banners / events.
    for (const ev of events) {
      if (ev.type === "wind") {
        game.flashBanner && game.flashBanner("WIND SHIFT - APPROACH REVERSED");
        bus.emit("weather:wind", { windDirection: ev.windDirection });
      } else if (ev.type === "storm") {
        game.flashBanner && game.flashBanner("THUNDERSTORM - ROUTE AROUND CELLS");
        bus.emit("weather:storm", { cell: ev.cell });
      } else if (ev.type === "fog") {
        if (ev.on) {
          game.flashBanner && game.flashBanner("FOG - VISIBILITY REDUCED");
          bus.emit("weather:fog", { on: true });
        } else {
          bus.emit("weather:fog", { on: false });
        }
      }
    }

    // Apply storms to aircraft.
    applyStorms(controller.state.storms);
  };

  /** Destroy/disable aircraft that fly into or route through a storm. */
  function applyStorms(storms) {
    if (!storms || storms.length === 0) return;
    const ids = world.query(Components.Transform, Components.Aircraft);
    for (const id of ids) {
      const t = world.getComponent(id, Components.Aircraft)
        ? world.getComponent(id, Components.Transform)
        : null;
      if (!t) continue;
      const ac = world.getComponent(id, Components.Aircraft);
      if (ac.state === "landing") continue; // committed; leave the rollout alone

      // Direct hit: inside a cell -> destroyed.
      const hit = pointInAnyStorm(storms, t.x, t.y);
      if (hit) {
        world.destroyEntity(id);
        bus.emit("aircraft:stormloss", { id, kind: ac.kind, cellId: hit.id });
        continue;
      }

      // Nav loss: a locked route that crosses a cell is scrubbed so the player
      // must re-route around the weather.
      const path = world.getComponent(id, Components.Path);
      if (path && path.points && path.points.length >= 2) {
        const poly = path.built && path.built.points.length >= 2
          ? path.built.points
          : path.points;
        let crosses = false;
        for (const cell of storms) {
          if (pathCrossesStorm(cell, poly)) {
            crosses = true;
            break;
          }
        }
        if (crosses) {
          path.points = [];
          path.built = null;
          path.progress = 0;
          path.locked = false;
          path.completed = false;
          ac.clearance = null;
          if (!ac._navLost) {
            ac._navLost = true;
            bus.emit("aircraft:navloss", { id, kind: ac.kind });
          }
        } else {
          ac._navLost = false;
        }
      }
    }
  }

  system.controller = controller;
  return system;
}
