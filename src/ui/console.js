// ATC console UI: renders the bottom-25% DOM region — the digital shift clock,
// the live bank balance, the reputation meter (green -> red), and the flight-
// strip list. It owns the Bank/Reputation/Clock models and subscribes to the
// EventBus so gameplay events (spawn/landed/crashed/fuelout/excessivehold/
// near-miss) update the economy + reputation and refresh the display.
//
// Browser-coupled: constructed by main.js inside start() with the live #console
// element. The models it uses (economy/reputation/clock) are pure and DOM-free.

import { createBank, computeLandingRevenue } from "../game/economy.js";
import { createReputation } from "../game/reputation.js";
import { createClock } from "../game/clock.js";
import { createFlightStrips } from "./flightStrips.js";

/**
 * Attach the console to the DOM and wire it to the game's EventBus. Returns an
 * object exposing { bank, reputation, clock, strips, update, detach } so main.js
 * can advance the clock and refresh the view each frame.
 *
 * @param {object} game the game instance (bus, world, camera, ...)
 * @param {object} [dom] element overrides (defaults resolve by id)
 */
export function createConsole(game, dom = {}) {
  const root = dom.root || document.getElementById("console");
  const clockEl = dom.clockEl || document.getElementById("shift-clock");
  const bankEl = dom.bankEl || document.getElementById("bank-balance");
  const meterEl = dom.meterEl || document.getElementById("reputation-meter");
  const fillEl =
    dom.fillEl || (meterEl ? meterEl.querySelector(".reputation-fill") : null);
  const stripsEl = dom.stripsEl || document.getElementById("flight-strips");

  const bank = createBank(game.startingBalance ?? 0);
  const reputation = createReputation();
  const clock = createClock(game.clockOptions ?? {});
  const strips = stripsEl ? createFlightStrips(stripsEl, game) : null;

  // Expose the models on the game so other systems / later features can read
  // them (e.g. the FEAT-005 upgrade shop reads game.bank).
  game.bank = bank;
  game.reputation = reputation;
  game.clock = clock;

  const unsubscribers = [];
  const on = (ev, fn) => unsubscribers.push(game.bus.on(ev, fn));

  on("aircraft:spawn", ({ id }) => {
    if (strips) strips.add(id);
  });

  // Record into the shift progression (for the end-of-shift summary) if present.
  const prog = () => game.progression;

  on("aircraft:landed", (payload) => {
    const revenue = computeLandingRevenue(payload);
    bank.credit(revenue);
    reputation.recover();
    if (prog()) {
      prog().recordLanding(revenue);
      if (payload && payload._emergency) prog().recordEmergency();
    }
    if (strips) strips.remove(payload.id);
    render();
  });

  on("aircraft:crashed", (payload) => {
    reputation.penalize("crash");
    if (prog()) prog().recordIncident("crash");
    if (strips) {
      if (payload && payload.a != null) strips.remove(payload.a);
      if (payload && payload.b != null) strips.remove(payload.b);
    }
    render();
  });

  on("aircraft:fuelout", (payload) => {
    reputation.penalize("fuelOut");
    if (prog()) prog().recordIncident("fuelOut");
    if (strips && payload) strips.remove(payload.id);
    checkFired();
    render();
  });

  on("aircraft:stormloss", () => {
    if (prog()) prog().recordIncident("stormLoss");
    render();
  });

  on("aircraft:nearmiss", () => {
    reputation.penalize("nearMiss");
    if (prog()) prog().recordIncident("nearMiss");
    checkFired();
    render();
  });

  on("aircraft:excessivehold", () => {
    reputation.penalize("excessiveHold");
    if (prog()) prog().recordIncident("excessiveHold");
    checkFired();
    render();
  });

  /** If reputation bottomed out, end the game as a firing. */
  function checkFired() {
    if (reputation.isFired() && !game.gameOver) {
      game.gameOver = true;
      game.gameOverReason = "fired";
      game.bus.emit("level:over", { reason: "fired" });
    }
  }

  /** Paint the static fields (clock/bank/reputation). */
  function render() {
    if (clockEl) clockEl.textContent = clock.format();
    if (bankEl) bankEl.textContent = formatMoney(bank.balance);
    if (fillEl) {
      const frac = reputation.fraction();
      fillEl.style.width = Math.round(frac * 100) + "%";
      fillEl.style.background = reputationColor(frac);
    }
  }

  /**
   * Called each frame from main.js. Advances the shift clock to match sim time
   * and refreshes the strips + static fields.
   */
  function update() {
    clock.setElapsed(game.time);
    if (strips) strips.refresh();
    render();
  }

  // Initial paint.
  render();

  /**
   * Reset the per-shift state for a new shift: reputation back to full and the
   * shift clock to zero. The bank balance PERSISTS across shifts (earned money
   * carries over to the upgrade shop). Flight strips are cleared.
   */
  function resetForShift() {
    const fresh = createReputation();
    reputation.score = fresh.score;
    reputation.incidents = fresh.incidents;
    clock.setElapsed(0);
    if (strips) strips.clear();
    render();
  }

  function detach() {
    for (const un of unsubscribers) un();
    unsubscribers.length = 0;
    if (strips) strips.clear();
  }

  return { bank, reputation, clock, strips, update, render, detach, resetForShift, root };
}

/** Format a whole-dollar balance like "$1,250". Pure helper. */
export function formatMoney(amount) {
  const n = Math.round(amount);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return sign + "$" + abs;
}

/** Meter color shifting green -> yellow -> red as reputation drops. Pure. */
export function reputationColor(fraction) {
  const f = Math.max(0, Math.min(1, fraction));
  // Hue 0 (red) at 0 to 120 (green) at 1.
  const hue = Math.round(120 * f);
  return `hsl(${hue}, 100%, 50%)`;
}
