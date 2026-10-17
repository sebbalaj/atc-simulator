// Spawn system. Emits a continuous stream of inbound aircraft from the radar
// perimeter at a controlled, time-ramping rate using the seeded RNG so a shift
// is reproducible. Each spawn gets a kind, a callsign, fuel, a heading aimed
// roughly toward the field, and an initial short path so it drifts inbound until
// the controller draws a route. Emits 'aircraft:spawn'.

import { Components } from "../components.js";
import {
  Transform,
  Velocity,
  Aircraft,
  Path,
  Hitbox,
  Render,
  Fuel,
  Label,
} from "../components.js";
import { ALL_KINDS, getAircraftDef, AircraftKind } from "../../game/aircraft.js";

const CALLSIGN_PREFIX = {
  [AircraftKind.LIGHT]: "N",
  [AircraftKind.COMMERCIAL]: "AC",
  [AircraftKind.HELICOPTER]: "H",
  [AircraftKind.SUPERSONIC]: "SR",
};

/**
 * Compute the spawn interval (seconds) at a given elapsed shift time. Starts
 * relaxed and ramps up (shorter interval) as the shift progresses, floored so
 * the field never becomes impossible. Pure function.
 */
export function spawnInterval(shiftTime) {
  // FEAT-003: aircraft now cruise at 0.25x (another ~4x slower), so each plane
  // lingers in the airspace much longer before it reaches a runway. At the old
  // cadence that would pile up the standing-aircraft count, so the base and
  // floor intervals are lengthened (8.5->14, 3.2->5.5) to keep peak crowding
  // comparable to the pre-slowdown balance.
  const base = 14; // seconds between spawns at the start
  const floor = 5.5; // never faster than this
  const ramp = Math.min(1, shiftTime / 300); // fully ramped after 5 minutes
  return base - (base - floor) * ramp;
}

/** Build the ECS spawn system bound to a game instance. */
export function createSpawnSystem(game) {
  const { world, bus, rng } = game;

  let timer = 0;
  let serial = 0;

  function makeCallsign(kind) {
    serial += 1;
    const prefix = CALLSIGN_PREFIX[kind] ?? "AC";
    const num = 100 + (serial % 900);
    return prefix + num;
  }

  function spawnOne() {
    const map = game.map;
    const kind = rng.pick(ALL_KINDS);
    const def = getAircraftDef(kind);

    // Spawn point on the perimeter circle around the field center.
    const angle = rng.range(0, Math.PI * 2);
    const r = map.spawnRadius;
    const x = map.center.x + Math.cos(angle) * r;
    const y = map.center.y + Math.sin(angle) * r;

    // Face roughly toward the field center with a little scatter.
    const toCenter = Math.atan2(map.center.y - y, map.center.x - x);
    const heading = toCenter + rng.range(-0.25, 0.25);

    const passengers = Math.round(
      rng.range(def.passengers[0], def.passengers[1])
    );

    const id = world.createEntity();
    world.addComponent(id, Components.Transform, Transform(x, y, heading));
    world.addComponent(id, Components.Velocity, Velocity(def.speed));
    world.addComponent(
      id,
      Components.Aircraft,
      Aircraft(kind, { passengers, state: "inbound" })
    );
    // Start with no drawn route; the plane drifts straight inbound.
    world.addComponent(id, Components.Path, Path([]));
    world.addComponent(id, Components.Hitbox, Hitbox(def.hitboxRadius));
    world.addComponent(
      id,
      Components.Render,
      Render({ shape: kind, color: def.color, size: def.hitboxRadius * 1.3 })
    );
    world.addComponent(id, Components.Fuel, Fuel(def.fuelMax));
    world.addComponent(id, Components.Label, Label(makeCallsign(kind)));

    // Track spawn time so landing can report time-in-airspace.
    const ac = world.getComponent(id, Components.Aircraft);
    ac.spawnTime = game.time;

    bus.emit("aircraft:spawn", { id, kind, passengers });
    return id;
  }

  const system = function spawnSystem(dt) {
    if (game.gameOver) return;
    timer += dt;
    // Map-specific spawn scaling (Map 4 Mega Hub is busier => shorter interval).
    const scale = (game.map && game.map.rules && game.map.rules.spawnScale) || 1;
    const interval = spawnInterval(game.time) * scale;
    if (timer >= interval) {
      timer -= interval;
      spawnOne();
    }
  };

  // Expose the one-shot spawner for tests / initial seeding.
  system.spawnOne = spawnOne;
  return system;
}
