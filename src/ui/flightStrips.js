// Flight strips: the scrollable list in the bottom console, one strip per active
// aircraft. Each strip shows the callsign/ID, class, a live altitude readout
// (derived/animated from how long the plane has been inbound) and a fuel status
// bar. Tapping a strip selects that aircraft and centers the camera on it (the
// render system reads game.camera.target).
//
// Browser-coupled (creates DOM), but constructed only from console.js at start,
// so the pure modules it imports still load under Node. Strips are added on
// 'aircraft:spawn' and removed on land/crash/fuel-out.

import { Components } from "../ecs/components.js";
import { getAircraftDef } from "../game/aircraft.js";
import { fuelStatus } from "../game/fuel.js";

/**
 * Create the flight-strip controller.
 * @param {HTMLElement} container the #flight-strips element
 * @param {object} game the game instance (world, camera, selectedId)
 */
export function createFlightStrips(container, game) {
  const { world } = game;
  // Map<entityId, { el, fuelFill, altEl }>
  const strips = new Map();

  function add(id) {
    if (strips.has(id)) return;
    const ac = world.getComponent(id, Components.Aircraft);
    const label = world.getComponent(id, Components.Label);
    if (!ac) return;
    const def = getAircraftDef(ac.kind);

    const el = document.createElement("div");
    el.className = "flight-strip";
    el.dataset.id = String(id);
    el.style.borderLeftColor = def.color;

    const head = document.createElement("div");
    head.className = "strip-head";

    const cs = document.createElement("span");
    cs.className = "strip-callsign";
    cs.textContent = label ? label.callsign : "AC" + id;

    const kindEl = document.createElement("span");
    kindEl.className = "strip-kind";
    kindEl.textContent = def.name;

    const altEl = document.createElement("span");
    altEl.className = "strip-alt";
    altEl.textContent = "--";

    head.appendChild(cs);
    head.appendChild(kindEl);
    head.appendChild(altEl);

    const fuelBar = document.createElement("div");
    fuelBar.className = "strip-fuel";
    const fuelFill = document.createElement("div");
    fuelFill.className = "strip-fuel-fill";
    fuelBar.appendChild(fuelFill);

    el.appendChild(head);
    el.appendChild(fuelBar);

    // Tap/click selects the aircraft and centers the camera on it.
    el.addEventListener("click", () => select(id));

    container.appendChild(el);
    strips.set(id, { el, fuelFill, altEl });
  }

  function remove(id) {
    const strip = strips.get(id);
    if (!strip) return;
    if (strip.el.parentNode) strip.el.parentNode.removeChild(strip.el);
    strips.delete(id);
    if (game.selectedId === id) {
      game.selectedId = null;
      if (game.camera) game.camera.target = null;
    }
  }

  /** Select an aircraft: highlight its strip and center the camera on it. */
  function select(id) {
    if (!world.hasEntity || !world.hasEntity(id)) return;
    game.selectedId = id;
    const t = world.getComponent(id, Components.Transform);
    if (t && game.camera) {
      game.camera.target = { x: t.x, y: t.y };
      game.camera.followId = id;
    }
  }

  /**
   * Refresh every strip's live data (altitude readout + fuel bar) and the
   * selected-strip highlight. Also keeps the camera target tracking a followed
   * plane. Called from console.update() each render.
   */
  function refresh() {
    for (const [id, strip] of strips) {
      if (!world.hasEntity(id)) continue;
      const ac = world.getComponent(id, Components.Aircraft);
      const fuel = world.getComponent(id, Components.Fuel);

      // Altitude: a cosmetic readout. Inbound planes descend from ~8000ft toward
      // the pattern altitude; derived from how long they have been in airspace.
      const tis = Math.max(0, game.time - (ac?.spawnTime ?? game.time));
      const alt = Math.max(1200, Math.round((8000 - tis * 60) / 100) * 100);
      strip.altEl.textContent = (ac?.state === "landing" ? "LAND" : alt + "ft");

      if (fuel) {
        const st = fuelStatus(fuel);
        strip.fuelFill.style.width = Math.round(st.fraction * 100) + "%";
        strip.el.classList.toggle("fuel-low", st.low && !st.critical);
        strip.el.classList.toggle("fuel-critical", st.critical);
      }

      strip.el.classList.toggle("selected", game.selectedId === id);
    }

    // Keep the camera centered on the followed plane as it moves.
    if (game.camera && game.camera.followId != null) {
      const fid = game.camera.followId;
      if (world.hasEntity(fid)) {
        const t = world.getComponent(fid, Components.Transform);
        if (t) game.camera.target = { x: t.x, y: t.y };
      } else {
        game.camera.followId = null;
        game.camera.target = null;
      }
    }
  }

  /** Remove every strip (e.g. on game over / reset). */
  function clear() {
    for (const id of Array.from(strips.keys())) remove(id);
  }

  return { add, remove, select, refresh, clear, strips };
}
