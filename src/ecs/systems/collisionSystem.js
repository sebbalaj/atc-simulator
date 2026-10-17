// Collision + proximity system. Each tick it rebuilds the spatial hash from the
// aircraft transforms (broad phase), then does an exact pairwise distance test
// among candidates (narrow phase). Pairs closer than the required separation
// (wake-aware: larger when the *leading* plane is COMMERCIAL) raise a proximity
// warning on both; pairs whose hitboxes overlap emit 'aircraft:crashed' and end
// the level.
//
// The core math (detectConflicts) is a pure function over a plain list of
// aircraft snapshots so it can be unit-tested under Node without the ECS/DOM.

import { Components } from "../components.js";
import { getAircraftDef, requiredSeparation, AircraftKind } from "../../game/aircraft.js";

/**
 * Pure conflict detection. Operates on an array of snapshots:
 *   { id, x, y, kind, hitboxRadius, separationRadius }
 * and a spatial hash. Returns:
 *   {
 *     warnings: Set<id>,                 // planes in a proximity breach
 *     crashes: [{a, b, distance}],       // hitbox overlaps
 *     closest: number                    // smallest center-to-center distance
 *   }
 *
 * Wake rule: when deciding the separation for a pair, whichever plane is the
 * "leader" matters. We do not track leader/follower ordering here, so if either
 * plane in the pair is COMMERCIAL we apply its wake separation (the conservative
 * choice) via requiredSeparation on both orderings and take the max.
 *
 * @param {Array} snapshots
 * @param {object} spatial spatial hash (createSpatialHash)
 */
export function detectConflicts(snapshots, spatial, wakeMultiplier = 1) {
  spatial.clear();
  let maxSep = 0;
  for (const s of snapshots) {
    spatial.insert(s.id, s.x, s.y);
    if (s.separationRadius > maxSep) maxSep = s.separationRadius;
  }
  // Query radius must cover the largest possible required separation (wake),
  // scaled by the map's wake strictness (Map 4 Mega Hub is stricter).
  const queryRadius = maxSep + wakePad(snapshots) * wakeMultiplier;

  const byId = new Map(snapshots.map((s) => [s.id, s]));
  const warnings = new Set();
  const crashes = [];
  const seen = new Set();
  let closest = Infinity;

  for (const s of snapshots) {
    const candidates = spatial.queryNeighbors(s.x, s.y, queryRadius);
    for (const otherId of candidates) {
      if (otherId === s.id) continue;
      const pairKey = s.id < otherId ? s.id + ":" + otherId : otherId + ":" + s.id;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      const o = byId.get(otherId);
      if (!o) continue;

      const dist = Math.hypot(s.x - o.x, s.y - o.y);
      if (dist < closest) closest = dist;

      // Required separation, wake-aware from either plane acting as leader.
      // The map's wake multiplier scales the wake bubble (Map 4 is stricter).
      const defA = getAircraftDef(s.kind);
      const defB = getAircraftDef(o.kind);
      const sep = Math.max(
        requiredSeparation(defA, defB, wakeMultiplier),
        requiredSeparation(defB, defA, wakeMultiplier)
      );

      if (dist < s.hitboxRadius + o.hitboxRadius) {
        crashes.push({ a: s.id, b: otherId, distance: dist });
        warnings.add(s.id);
        warnings.add(otherId);
      } else if (dist < sep) {
        warnings.add(s.id);
        warnings.add(otherId);
      }
    }
  }

  return { warnings, crashes, closest: closest === Infinity ? null : closest };
}

/** Largest wake separation present in the set (adds to the query radius). */
function wakePad(snapshots) {
  let pad = 0;
  for (const s of snapshots) {
    if (s.kind === AircraftKind.COMMERCIAL) {
      const def = getAircraftDef(s.kind);
      if (def.wakeSeparation > pad) pad = def.wakeSeparation;
    }
  }
  return pad;
}

/**
 * Build the ECS collision system. Reads aircraft each tick, runs
 * detectConflicts, writes warning flags onto Render.blink / Aircraft, emits
 * crashes, and records game.closestSeparation for the HUD/alarm.
 */
export function createCollisionSystem(game) {
  const { world, bus, spatial } = game;

  // Track which plane is currently in a proximity breach so each distinct
  // near-miss episode (a plane entering the warning state) emits exactly one
  // 'aircraft:nearmiss' event instead of one per tick.
  const warnedLast = new Set();

  return function collisionSystem() {
    const ids = world.query(Components.Transform, Components.Aircraft, Components.Hitbox);
    const snapshots = [];
    for (const id of ids) {
      const t = world.getComponent(id, Components.Transform);
      const ac = world.getComponent(id, Components.Aircraft);
      const def = getAircraftDef(ac.kind);
      snapshots.push({
        id,
        x: t.x,
        y: t.y,
        kind: ac.kind,
        hitboxRadius: def.hitboxRadius,
        separationRadius: def.separationRadius,
      });
    }

    const wakeMultiplier =
      (game.map && game.map.rules && game.map.rules.wakeMultiplier) || 1;
    const { warnings, crashes, closest } = detectConflicts(snapshots, spatial, wakeMultiplier);
    game.closestSeparation = closest;

    // Apply/clear warning state and emit one near-miss per new breach episode.
    for (const id of ids) {
      const render = world.getComponent(id, Components.Render);
      const ac = world.getComponent(id, Components.Aircraft);
      const warned = warnings.has(id);
      if (render) render.warning = warned;
      if (ac) ac.proximity = warned;
      if (warned && !warnedLast.has(id)) {
        // New entrant into a proximity breach: a near-miss.
        bus.emit("aircraft:nearmiss", { id, kind: ac && ac.kind });
      }
    }
    // Refresh the "warned last tick" set for next-tick edge detection.
    warnedLast.clear();
    for (const id of warnings) warnedLast.add(id);

    if (crashes.length > 0 && !game.gameOver) {
      game.gameOver = true;
      game.gameOverReason = "collision";
      for (const c of crashes) {
        const acA = world.getComponent(c.a, Components.Aircraft);
        const acB = world.getComponent(c.b, Components.Aircraft);
        bus.emit("aircraft:crashed", {
          a: c.a,
          b: c.b,
          kinds: [acA && acA.kind, acB && acB.kind],
          distance: c.distance,
        });
      }
      bus.emit("level:over", { reason: "collision" });
    }
  };
}
