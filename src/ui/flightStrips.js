// Flight strips: the scrollable list in the bottom console, one strip per active
// aircraft. Each strip shows the callsign/ID, a small class badge, a live
// altitude readout, the ASSIGNED landing surface (with a preferred-vs-forced
// marker) and a fuel status bar. Tapping a strip selects (COMMUNICATES with)
// that aircraft: the render layer reveals its live position (even through fog)
// and highlights the surface it must land on. The camera does NOT move.
//
// The strip's overall COLOR follows a strict precedence resolved by the pure
// helper stripColorState() below, so the decision can be unit-tested without
// the DOM:
//   red       (solid)    -> emergency OR low fuel
//   red-blink (blinking) -> near-collision pair (both planes blink)
//   grey                 -> concealed by fog AND not the selected/comms plane
//   blue                 -> routed with a cleared-to-land path
//   green     (default)  -> unrouted + high fuel
//
// Browser-coupled (creates DOM), but constructed only from console.js at start,
// so the pure modules it imports still load under Node. Strips are added on
// 'aircraft:spawn' and removed on land/crash/fuel-out.

import { Components } from "../ecs/components.js";
import { getAircraftDef } from "../game/aircraft.js";
import { fuelStatus } from "../game/fuel.js";

/** The five resolved strip color states, highest precedence first. */
export const STRIP_STATES = Object.freeze([
  "red",
  "red-blink",
  "grey",
  "blue",
  "green",
]);

/**
 * Resolve the single winning color state for a strip from authoritative flags.
 * Pure (no DOM) so it is fully unit-testable. Exactly one state wins, by
 * precedence:
 *   (a) emergency OR low fuel        => 'red'       (solid, highest)
 *   (b) near-collision proximity     => 'red-blink' (both planes of the pair)
 *   (c) fog-hidden AND not selected  => 'grey'
 *   (d) routed to land               => 'blue'
 *   (e) default                      => 'green'
 *
 * @param {object} s
 * @param {boolean} [s.emergency]    aircraft has an active emergency
 * @param {boolean} [s.fuelLow]      fuel is low/critical
 * @param {boolean} [s.proximity]    in a near-collision warned pair
 * @param {boolean} [s.fogHidden]    concealed by the fog region (display flag)
 * @param {boolean} [s.selected]     currently selected / communicating
 * @param {boolean} [s.routedToLand] cleared-to-land path (Path.locked / clearance)
 * @returns {'red'|'red-blink'|'grey'|'blue'|'green'}
 */
export function stripColorState(s = {}) {
  if (s.emergency || s.fuelLow) return "red";
  if (s.proximity) return "red-blink";
  if (s.fogHidden && !s.selected) return "grey";
  if (s.routedToLand) return "blue";
  return "green";
}

/**
 * Format the assigned landing surface for display. Pure. Returns a short text
 * token and the mode so the strip can style FORCED vs PREFERRED vs don't-care
 * distinctly:
 *   forced    => { text: '!'+id,  mode: 'forced'   }   hard assignment (lock)
 *   preferred => { text: '->'+id, mode: 'preferred' }  soft preference
 *   any       => { text: 'ANY',   mode: 'any'       }  don't-care
 *
 * @param {object|null} assignment { kind, runwayId?, padId?, mode } or null
 * @returns {{text:string, mode:'forced'|'preferred'|'any'}}
 */
export function assignmentLabel(assignment) {
  if (!assignment || assignment.mode === "any" || assignment.kind === "any") {
    return { text: "ANY", mode: "any" };
  }
  const id = assignment.runwayId || assignment.padId || "";
  if (!id) return { text: "ANY", mode: "any" };
  if (assignment.mode === "forced") return { text: "!" + id, mode: "forced" };
  if (assignment.mode === "preferred") return { text: "\u2192" + id, mode: "preferred" };
  // Unknown mode but a concrete surface: treat as a neutral preference.
  return { text: "\u2192" + id, mode: "preferred" };
}

/**
 * Whether a plane's path counts as "routed with a cleared-to-land path" for the
 * blue state. A locked path, or a resolved clearance, both qualify. A holding
 * orbit does NOT (it is not a landing route). Pure helper.
 * @param {object|null} path Path component
 * @param {object|null} ac Aircraft component (carries .clearance)
 */
export function isRoutedToLand(path, ac) {
  if (path && path.locked && !path.holding) return true;
  if (ac && ac.clearance) return true;
  return false;
}

/**
 * Create the flight-strip controller.
 * @param {HTMLElement} container the #flight-strips element
 * @param {object} game the game instance (world, camera, selectedId)
 */
export function createFlightStrips(container, game) {
  const { world } = game;
  // Map<entityId, { el, fuelFill, altEl, asgEl }>
  const strips = new Map();

  // A one-line legend so the player can tell the markers apart. Inserted once,
  // ahead of the strip rows (which are appended after it).
  ensureLegend(container);

  function add(id) {
    if (strips.has(id)) return;
    const ac = world.getComponent(id, Components.Aircraft);
    const label = world.getComponent(id, Components.Label);
    if (!ac) return;
    const def = getAircraftDef(ac.kind);

    const el = document.createElement("div");
    el.className = "flight-strip";
    el.dataset.id = String(id);

    const head = document.createElement("div");
    head.className = "strip-head";

    // Small class badge (the class color used to live on the left border, which
    // is now repurposed for the color STATE; the badge keeps class readable).
    const badge = document.createElement("span");
    badge.className = "strip-badge";
    badge.style.background = def.color;
    badge.title = def.name;
    badge.textContent = classAbbrev(def.name);

    const cs = document.createElement("span");
    cs.className = "strip-callsign";
    cs.textContent = label ? label.callsign : "AC" + id;

    const asgEl = document.createElement("span");
    asgEl.className = "strip-assign";

    const altEl = document.createElement("span");
    altEl.className = "strip-alt";
    altEl.textContent = "--";

    head.appendChild(badge);
    head.appendChild(cs);
    head.appendChild(asgEl);
    head.appendChild(altEl);

    const fuelBar = document.createElement("div");
    fuelBar.className = "strip-fuel";
    const fuelFill = document.createElement("div");
    fuelFill.className = "strip-fuel-fill";
    fuelBar.appendChild(fuelFill);

    el.appendChild(head);
    el.appendChild(fuelBar);

    // Tap/click selects (communicates with) the aircraft. No camera move.
    el.addEventListener("click", () => select(id));

    container.appendChild(el);
    strips.set(id, { el, fuelFill, altEl, asgEl });

    // Paint the (static-ish) assignment marker once at creation.
    paintAssignment(asgEl, ac.assignment);
  }

  function remove(id) {
    const strip = strips.get(id);
    if (!strip) return;
    if (strip.el.parentNode) strip.el.parentNode.removeChild(strip.el);
    strips.delete(id);
    if (game.selectedId === id) {
      game.selectedId = null;
    }
  }

  /**
   * Select (COMMUNICATE with) an aircraft: highlight its strip and emit
   * 'aircraft:selected'. This reveals the plane's live position through fog and
   * highlights its assigned surface in the render layer. It does NOT move or
   * recenter the camera — the view stays put.
   */
  function select(id) {
    if (!world.hasEntity || !world.hasEntity(id)) return;
    const wasSelected = game.selectedId === id;
    game.selectedId = id;
    if (!wasSelected && game.bus) game.bus.emit("aircraft:selected", { id });
  }

  /**
   * Refresh every strip's live data (altitude readout + fuel bar), the resolved
   * color state, and the selected-strip highlight. Called from console.update()
   * each render.
   */
  function refresh() {
    for (const [id, strip] of strips) {
      if (!world.hasEntity(id)) continue;
      const ac = world.getComponent(id, Components.Aircraft);
      const fuel = world.getComponent(id, Components.Fuel);
      const path = world.getComponent(id, Components.Path);
      const render = world.getComponent(id, Components.Render);

      // Altitude: a cosmetic readout. Inbound planes descend from ~8000ft toward
      // the pattern altitude; derived from how long they have been in airspace.
      const tis = Math.max(0, game.time - (ac?.spawnTime ?? game.time));
      const alt = Math.max(1200, Math.round((8000 - tis * 60) / 100) * 100);
      strip.altEl.textContent = (ac?.state === "landing" ? "LAND" : alt + "ft");

      const st = fuel ? fuelStatus(fuel) : { fraction: 1, low: false, critical: false };
      if (fuel) {
        strip.fuelFill.style.width = Math.round(st.fraction * 100) + "%";
      }

      const selected = game.selectedId === id;
      const state = stripColorState({
        emergency: !!(ac && ac.emergency),
        fuelLow: !!(st.low || st.critical),
        proximity: !!((ac && ac.proximity) || (render && render.warning)),
        fogHidden: !!(render && render.fogHidden),
        selected,
        routedToLand: isRoutedToLand(path, ac),
      });

      // Apply exactly one strip-state-* class (toggle all, enable the winner).
      for (const name of STRIP_STATES) {
        strip.el.classList.toggle("strip-state-" + name, name === state);
      }

      strip.el.classList.toggle("selected", selected);
    }
  }

  /** Remove every strip (e.g. on game over / reset). */
  function clear() {
    for (const id of Array.from(strips.keys())) remove(id);
  }

  return { add, remove, select, refresh, clear, strips };
}

/** Paint the assignment marker into an element from an assignment object. */
function paintAssignment(el, assignment) {
  const { text, mode } = assignmentLabel(assignment);
  el.textContent = text;
  el.classList.remove("asg-forced", "asg-preferred", "asg-any");
  el.classList.add("asg-" + mode);
  el.title =
    mode === "forced"
      ? "Forced: must land here"
      : mode === "preferred"
      ? "Preferred landing surface"
      : "No preference";
}

/** A compact 3-char class tag for the badge (e.g. "Commercial" -> "COM"). */
function classAbbrev(name) {
  return String(name || "")
    .replace(/[^A-Za-z]/g, "")
    .slice(0, 3)
    .toUpperCase();
}

/**
 * Insert the one-line legend explaining the preferred-vs-forced markers once,
 * at the top of the strip list. Idempotent (no-op if already present).
 */
function ensureLegend(container) {
  if (!container || container.querySelector(".strip-legend")) return;
  const legend = document.createElement("div");
  legend.className = "strip-legend";
  legend.innerHTML =
    '<span class="asg-forced">!RWY</span> forced' +
    ' \u00b7 <span class="asg-preferred">\u2192RWY</span> preferred' +
    ' \u00b7 <span class="asg-any">ANY</span> no pref';
  container.appendChild(legend);
}
