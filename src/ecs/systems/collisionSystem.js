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
  // Ordered "a:b" keys (a<b) of the pairs currently in a proximity breach, so
  // the caller can count one near-miss episode per pair rather than per plane.
  const warnedPairs = new Set();
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
        warnedPairs.add(pairKey);
      } else if (dist < sep) {
        warnings.add(s.id);
        warnings.add(otherId);
        warnedPairs.add(pairKey);
      }
    }
  }

  return { warnings, warnedPairs, crashes, closest: closest === Infinity ? null : closest };
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

  // Track which *pairs* are currently in a proximity breach so each distinct
  // near-miss episode emits exactly one 'aircraft:nearmiss' event. Keying on the
  // pair (not the plane) means a single two-plane breach costs one penalty, not
  // one per plane — it also still suppresses per-tick spam while the pair stays
  // in breach, firing again only after they separate and re-converge.
  const warnedPairsLast = new Set();

  return function collisionSystem() {
    const ids = world.query(Components.Transform, Components.Aircraft, Components.Hitbox);
    const snapshots = [];
    for (const id of ids) {
      const t = world.getComponent(id, Components.Transform);
      const ac = world.getComponent(id, Components.Aircraft);
      // Touched-down aircraft are on the ground: exclude 'landing'/'landed' from
      // mid-air conflict checks. Aircraft.state only becomes 'landing' inside
      // commitLanding (requires path.locked + ac.clearance + reaching the
      // cleared route end / threshold), so this cannot be abused to fly through
      // traffic before a plane is actually cleared/at the threshold.
      if (ac.state === "landing" || ac.state === "landed") continue;
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
    const { warnings, warnedPairs, crashes, closest } = detectConflicts(
      snapshots,
      spatial,
      wakeMultiplier
    );
    game.closestSeparation = closest;

    // Apply/clear the per-plane warning flag (drives the blink + HUD). Gated-out
    // (landing/landed) planes are never in `warnings`, so their flag is cleared
    // here too — no stale warning ring lingers on a plane that has touched down.
    for (const id of ids) {
      const render = world.getComponent(id, Components.Render);
      const ac = world.getComponent(id, Components.Aircraft);
      const grounded = ac && (ac.state === "landing" || ac.state === "landed");
      const warned = !grounded && warnings.has(id);
      if (render) render.warning = warned;
      if (ac) ac.proximity = warned;
    }

    // Emit exactly ONE 'aircraft:nearmiss' per newly-breaching PAIR. A single
    // two-plane breach is one episode (one reputation penalty), not two — and an
    // ongoing breach does not re-fire until the pair separates and re-converges.
    for (const pairKey of warnedPairs) {
      if (warnedPairsLast.has(pairKey)) continue;
      const [aStr, bStr] = pairKey.split(":");
      const a = Number(aStr);
      const b = Number(bStr);
      const acA = world.getComponent(a, Components.Aircraft);
      const acB = world.getComponent(b, Components.Aircraft);
      bus.emit("aircraft:nearmiss", {
        a,
        b,
        kinds: [acA && acA.kind, acB && acB.kind],
      });
    }
    // Refresh the "warned last tick" pair set for next-tick edge detection.
    warnedPairsLast.clear();
    for (const pairKey of warnedPairs) warnedPairsLast.add(pairKey);

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
