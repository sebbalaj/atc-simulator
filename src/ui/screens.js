// Screen manager: portrait DOM overlays for the game's non-radar states —
// Main Menu / map select, in-game (no overlay), End-of-Shift Summary, the
// Upgrade Shop, and Game Over (crash or fired). Transitions are driven by
// progression (shift start/end) and by reputation/crash events ('level:over').
//
// Browser-coupled: constructed by main.js inside start() with the live #screens
// mount. All the logic it drives (progression, upgrades, economy) lives in pure
// modules so this file is a thin view/controller layer.

import { MAP_META } from "../game/maps.js";
import { UPGRADES, purchase } from "../game/upgrades.js";
import { formatMoney } from "./console.js";

const SCREEN = Object.freeze({
  NONE: "none",
  MENU: "menu",
  SUMMARY: "summary",
  SHOP: "shop",
  GAMEOVER: "gameover",
});

/**
 * Create the screen manager. Returns { show, detach, current } and takes over
 * showing menus / transitioning shifts. It:
 *   - shows the Main Menu + map select at boot,
 *   - on 'level:over' freezes the sim and shows Summary (survived vs fired/crash),
 *   - Summary -> Shop -> next map (loadMap + resume).
 *
 * @param {object} game the live game instance (progression, bank, loadMap, ...)
 * @param {object} [dom] { mount } overrides (defaults to #screens)
 */
export function createScreens(game, dom = {}) {
  const mount = dom.mount || document.getElementById("screens");
  const unsub = [];
  let current = SCREEN.NONE;
  let lastSummary = null;

  // When a level ends (crash or fired), pause the sim and show the summary.
  unsub.push(
    game.bus.on("level:over", (p) => {
      const reason = (p && p.reason) || game.gameOverReason;
      const survived = false;
      endCurrentShift(survived, reason);
    })
  );

  /** Show the Main Menu with the map-select grid. */
  function showMenu() {
    current = SCREEN.MENU;
    game.paused = true;
    const prog = game.progression;
    mount.innerHTML = "";
    const panel = makePanel("ATC SIMULATOR", "Select a map to begin your shift.");

    const grid = el("div", "map-grid");
    MAP_META.forEach((m, i) => {
      const unlocked = prog.isMapUnlocked(i);
      const card = el("button", "map-card" + (unlocked ? "" : " locked"));
      card.disabled = !unlocked;
      card.innerHTML =
        `<span class="map-name">${m.name}</span>` +
        `<span class="map-blurb">${unlocked ? m.blurb : "Locked - survive earlier shifts"}</span>`;
      card.addEventListener("click", () => {
        if (!prog.selectMap(i)) return;
        startShiftOnSelectedMap();
      });
      grid.appendChild(card);
    });
    panel.appendChild(grid);
    mount.appendChild(panel);
    showMount();
  }

  /** Begin a shift on the currently selected map. */
  function startShiftOnSelectedMap() {
    const mapId = game.progression.currentMapId();
    game.loadMap(mapId);
    hideMount();
    current = SCREEN.NONE;
    game.paused = false;
  }

  /** End the current shift and show the summary screen. */
  function endCurrentShift(survived, reason) {
    game.paused = true;
    const repScore = game.reputation ? game.reputation.score : 100;
    const summary = game.progression.endShift({ reputationScore: repScore, survived });
    summary.reason = reason || null;
    lastSummary = summary;
    showSummary(summary);
  }

  /** Called by main.js when the shift clock runs out (a survived shift). */
  function onShiftClockExpired() {
    if (current !== SCREEN.NONE) return;
    if (game.gameOver) return;
    endCurrentShift(true, "shift-complete");
  }

  /** Show the End-of-Shift summary. */
  function showSummary(summary) {
    current = SCREEN.SUMMARY;
    mount.innerHTML = "";
    const survived = summary.survived;
    const title = survived
      ? "SHIFT COMPLETE"
      : summary.reason === "collision"
      ? "SHIFT ENDED - COLLISION"
      : "SHIFT ENDED - FIRED";
    const panel = makePanel(title, survived ? "Nice work keeping the skies clear." : "Review the shift and try again.");

    const rows = [
      ["Planes landed", summary.landed],
      ["Revenue", formatMoney(summary.revenue)],
      ["Target", formatMoney(summary.target) + (summary.metTarget ? " (met)" : " (missed)")],
      ["Bonus", formatMoney(summary.bonus)],
      ["Emergencies handled", summary.emergenciesHandled],
      ["Crashes", summary.crashed],
      ["Final reputation", Math.round(summary.reputation)],
      ["Total earned", formatMoney(summary.total)],
    ];
    panel.appendChild(makeStatTable(rows));

    const next = el("button", "screen-btn");
    next.textContent = survived ? "To Upgrade Shop" : "Main Menu";
    next.addEventListener("click", () => {
      if (survived) showShop();
      else {
        // A failed shift returns to the menu to retry (no unlock advance).
        game.progression.advance({ survived: false });
        showMenu();
      }
    });
    panel.appendChild(next);
    mount.appendChild(panel);
    showMount();
  }

  /** Show the Upgrade Shop. */
  function showShop() {
    current = SCREEN.SHOP;
    renderShop();
    showMount();
  }

  function renderShop() {
    mount.innerHTML = "";
    const bank = game.bank;
    const panel = makePanel("UPGRADE SHOP", "Spend earnings to improve your field.");

    const balance = el("div", "shop-balance");
    balance.textContent = "Balance: " + formatMoney(bank ? bank.balance : 0);
    panel.appendChild(balance);

    const list = el("div", "shop-list");
    for (const up of UPGRADES) {
      const owned = up.repeatable ? false : game.upgradeState.owned.includes(up.id);
      const affordable = bank && bank.canAfford(up.cost);
      const item = el("div", "shop-item");
      item.innerHTML =
        `<div class="shop-item-head"><span class="shop-cat">${up.category}</span>` +
        `<span class="shop-cost">${formatMoney(up.cost)}</span></div>` +
        `<div class="shop-label">${up.label}</div>` +
        `<div class="shop-desc">${up.description}</div>`;
      const buy = el("button", "shop-buy");
      buy.textContent = owned ? "Owned" : "Buy";
      buy.disabled = owned || !affordable;
      buy.addEventListener("click", () => {
        const res = purchase(game.upgradeState, bank, up.id);
        if (res.ok) {
          // Keep the live game flags in sync with the upgrade state.
          syncFlags();
          renderShop();
        }
      });
      item.appendChild(buy);
      list.appendChild(item);
    }
    panel.appendChild(list);

    const done = el("button", "screen-btn");
    done.textContent = "Start Next Shift";
    done.addEventListener("click", () => {
      // Advance progression (unlock the next map) and go to map select.
      game.progression.advance({ survived: true });
      showMenu();
    });
    panel.appendChild(done);
    mount.appendChild(panel);
  }

  /**
   * Mirror upgrade flags onto the live game so systems pick them up. Notably
   * game.ilsOwned must flip true for fog landings (the fog/landing code reads
   * it). Infrastructure/radar effects already mutate the live map in place.
   */
  function syncFlags() {
    const f = game.upgradeState.flags || {};
    if (f.ilsOwned) game.ilsOwned = true;
    if (game.weather) game.weather.ilsOwned = game.ilsOwned;
  }

  /** Show the Main Menu. */
  function show(screen) {
    if (screen === SCREEN.MENU) showMenu();
    else if (screen === SCREEN.SHOP) showShop();
    else if (screen === SCREEN.SUMMARY && lastSummary) showSummary(lastSummary);
    else hideMount();
  }

  function showMount() {
    if (mount) mount.classList.add("visible");
  }
  function hideMount() {
    if (mount) mount.classList.remove("visible");
  }

  function detach() {
    for (const u of unsub) u();
    unsub.length = 0;
    if (mount) mount.innerHTML = "";
  }

  // Boot into the main menu.
  showMenu();

  return {
    show,
    showMenu,
    showShop,
    showSummary,
    onShiftClockExpired,
    syncFlags,
    detach,
    get current() {
      return current;
    },
    SCREEN,
  };
}

// --- tiny DOM helpers ------------------------------------------------------

function el(tag, className) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function makePanel(title, subtitle) {
  const panel = el("div", "screen-panel");
  const h = el("h1", "screen-title");
  h.textContent = title;
  panel.appendChild(h);
  if (subtitle) {
    const s = el("p", "screen-sub");
    s.textContent = subtitle;
    panel.appendChild(s);
  }
  return panel;
}

function makeStatTable(rows) {
  const table = el("div", "stat-table");
  for (const [label, value] of rows) {
    const row = el("div", "stat-row");
    const l = el("span", "stat-label");
    l.textContent = label;
    const v = el("span", "stat-value");
    v.textContent = String(value);
    row.appendChild(l);
    row.appendChild(v);
    table.appendChild(row);
  }
  return table;
}
