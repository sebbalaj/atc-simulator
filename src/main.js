// Bootstrap + fixed-timestep game loop. Sizes the radar canvas with
// devicePixelRatio scaling, builds the ECS World and Map 1, wires the gameplay
// systems (spawn -> movement -> landing -> collision -> render) into an
// accumulator loop driven by requestAnimationFrame, and attaches pointer input.
//
// Browser-coupled: all window/document access is guarded so pure core/ECS/game
// modules remain importable under Node (`node --check` / unit tests). main.js
// only auto-boots and touches the DOM inside start()/the document guard below.

import { createWorld } from "./ecs/world.js";
import { createEventBus } from "./core/events.js";
import { createSpatialHash } from "./core/spatialHash.js";
import { createRng } from "./core/rng.js";
import { createMap } from "./game/maps.js";
import { createSpawnSystem } from "./ecs/systems/spawnSystem.js";
import { createWeatherSystem } from "./ecs/systems/weatherSystem.js";
import { createEmergencySystem } from "./ecs/systems/emergencySystem.js";
import { createMovementSystem } from "./ecs/systems/movementSystem.js";
import { createLandingSystem } from "./ecs/systems/landingSystem.js";
import { createCollisionSystem } from "./ecs/systems/collisionSystem.js";
import { createRenderSystem } from "./ecs/systems/renderSystem.js";
import { attachInput } from "./ui/input.js";
import { createConsole } from "./ui/console.js";
import { createProgression } from "./game/progression.js";
import { createScreens } from "./ui/screens.js";
import { createAudioEngine } from "./game/audio.js";
import { sweepRate } from "./game/radar.js";

// Fixed simulation step: 60 updates per second.
const FIXED_DT = 1 / 60;
// Clamp huge frame gaps (e.g. tab regained focus) so we never spiral.
const MAX_FRAME_DELTA = 0.25;

// Default radar dimensions used for headless construction (before a canvas is
// attached). Overwritten by resize() once a real canvas exists.
const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 600;

// Separation (px) at/under which the proximity alarm engages. Mirrors the HUD's
// ALARM_THRESHOLD so the audible alarm tracks the visual vignette.
const ALARM_THRESHOLD = 72;
// Aircraft count mapped to full ambient intensity (soft cap for crowding).
const CROWDING_SOFT_CAP = 12;

/**
 * Create the Game object. Pure construction; nothing touches the DOM until
 * start() is called, keeping this importable under Node.
 */
export function createGame(options = {}) {
  const world = createWorld();
  const bus = createEventBus();
  const spatial = createSpatialHash(options.cellSize ?? 96);
  const rng = createRng(options.seed ?? 1337);

  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;

  const game = {
    world,
    bus,
    spatial,
    rng,
    map: createMap(options.mapId ?? "map1", width, height),
    mapId: options.mapId ?? "map1",
    canvas: null,
    ctx: null,
    dpr: 1,
    width,
    height,
    running: false,
    paused: false, // true while a screen overlay (menu/summary/shop) is shown
    time: 0, // accumulated simulation time (seconds)
    sweep: 0, // radar sweep angle (radians)
    selectedId: null,
    // Camera for strip-centering: target in world coords, followId tracks a
    // selected plane. null target == identity (no pan), the default on Map 1.
    camera: { target: null, followId: null },
    // Transient top-banner event message: { text, alpha, until }.
    banner: null,
    gameOver: false,
    gameOverReason: null,
    closestSeparation: null,
    // Live weather snapshot (populated by the weather system each tick).
    weather: null,
    // Whether the ILS upgrade is owned. FEAT-005 flips this on purchase; until
    // then fog always reduces visibility. Fog/landing code reads it defensively.
    ilsOwned: false,
    console: null,
    screens: null,
    // Synthesized Web Audio engine. Constructed eagerly (safe no-op under Node
    // / where the API is missing); it unlocks on the first user gesture.
    audio: createAudioEngine(options.audio ?? {}),
    // On-screen FPS + plane-count debug readout (toggled with the 'd' key).
    debug: false,
    _fps: 0,
    _frameTimes: [],
    // Progression: shift manager (per-shift counters, map unlock gating). The
    // upgrade shop reads/writes the active map + game flags via this.
    progression: createProgression(options.progression ?? {}),
    // Upgrade state the shop mutates: the live map plus game flags. flags.ilsOwned
    // mirrors game.ilsOwned (kept in sync on purchase).
    upgradeState: null,
    stats: { landed: 0, crashed: 0 },
    _accumulator: 0,
    _lastTs: 0,
    _rafId: 0,
    _detachInput: null,
  };

  // The upgrade shop mutates the active map + flags through this state object.
  game.upgradeState = { map: game.map, flags: { ilsOwned: game.ilsOwned }, owned: [] };

  // Systems are (re)built per map load so each captures the active map/world.
  // update()/render() call through game.systems so a reload swaps them cleanly.
  game.systems = {};
  function buildSystems() {
    game.systems.spawn = createSpawnSystem(game);
    game.systems.weather = createWeatherSystem(game);
    game.systems.emergency = createEmergencySystem(game);
    game.systems.movement = createMovementSystem(game);
    game.systems.landing = createLandingSystem(game);
    game.systems.collision = createCollisionSystem(game);
    game.systems.render = createRenderSystem(game);
    // Back-compat aliases exposed for seeding/testing.
    game.spawnSystem = game.systems.spawn;
    game.weatherSystem = game.systems.weather;
    game.emergencySystem = game.systems.emergency;
  }
  buildSystems();

  /** Flash a transient banner message at the top of the scope. */
  function flashBanner(text, seconds = 2.5) {
    game.banner = { text, alpha: 1, until: game.time + seconds };
  }
  game.flashBanner = flashBanner;

  // Light bookkeeping + banner feedback on gameplay events.
  bus.on("aircraft:landed", (p) => {
    game.stats.landed += 1;
    flashBanner((p && p.kind ? p.kind.toUpperCase() : "FLIGHT") + " LANDED");
  });
  bus.on("aircraft:crashed", () => {
    game.stats.crashed += 1;
  });
  bus.on("aircraft:fuelout", () => flashBanner("FUEL EXHAUSTED - REP PENALTY"));
  bus.on("aircraft:excessivehold", () => flashBanner("HELD TOO LONG"));
  bus.on("level:over", (p) => {
    if (p && p.reason === "fired") flashBanner("GAME OVER - YOU'RE FIRED");
  });

  // Wire the synthesized audio engine to the EventBus: spawn static clicks,
  // "Cleared to land" / "Roger" callouts, etc. The alarm + ambient layers are
  // driven each tick from update() (proximity severity + live plane count).
  game._detachAudio = game.audio.subscribe(bus);

  /**
   * Advance the simulation by one fixed step. System order (authoritative):
   * spawn -> movement (applies drawn paths) -> landing -> collision -> (render
   * is separate, in the frame callback).
   */
  function update(dt) {
    game.time += dt;
    // Advance the radar sweep authoritatively. A higher radar level (from the
    // radar-range upgrade) speeds the sweep up so more range comes with faster
    // refresh. The render layer reads game.sweep (and the value it last saw) to
    // gate displayed blips - it never advances the sweep itself.
    const radarLevel =
      (game.upgradeState && game.upgradeState.flags && game.upgradeState.flags.radarLevel) || 0;
    game.sweep = (game.sweep + dt * sweepRate(radarLevel)) % (Math.PI * 2);
    // Fade/expire the transient banner regardless of game-over state.
    if (game.banner) {
      const remaining = game.banner.until - game.time;
      if (remaining <= 0) game.banner = null;
      else game.banner.alpha = Math.min(1, remaining / 0.8);
    }
    if (game.gameOver) return;
    if (game.paused) return;

    // End-of-shift: when the shift clock runs out, hand off to the screen
    // manager to show the summary (a survived shift) and pause the sim.
    if (
      game.clock &&
      game.clock.isShiftOver &&
      game.clock.isShiftOver() &&
      game.progression &&
      game.progression.state.active &&
      game.screens
    ) {
      game.screens.onShiftClockExpired();
      return;
    }

    game.systems.spawn(dt);
    game.systems.weather(dt);
    game.systems.emergency(dt);
    game.systems.movement(dt);
    game.systems.landing(dt);
    game.systems.collision(dt);

    // Drive the audio engine's live layers from the simulation state:
    //  - proximity alarm severity from the closest separation vs the threshold,
    //  - ambient soundscape intensity from the live aircraft count (crowding).
    const closest = game.closestSeparation;
    const severity =
      closest == null || !(closest < ALARM_THRESHOLD)
        ? 0
        : Math.max(0, Math.min(1, 1 - closest / ALARM_THRESHOLD));
    game.audio.setProximity(severity);
    game.audio.setCrowdingFromCount(game.world.entityCount(), CROWDING_SOFT_CAP);
    game.audio.update(dt);
  }

  /** Draw a single frame. */
  function render() {
    const { ctx, width: w, height: h } = game;
    // Refresh the DOM console (clock/bank/reputation/strips) each frame.
    if (game.console) game.console.update();
    if (!ctx) return;
    // Blink phase for proximity warnings (~3 Hz).
    const blinkPhase = (game.time * 3) % 1;
    game.systems.render(ctx, w, h, blinkPhase);
    if (game.debug) drawDebugReadout(ctx);
  }

  /** Small corner overlay: FPS + live aircraft count (toggle with 'd'). */
  function drawDebugReadout(ctx) {
    const fps = Math.round(game._fps);
    const planes = game.world.entityCount();
    const text = `FPS ${fps}  PLANES ${planes}`;
    ctx.save();
    ctx.font = '11px "Courier New", monospace';
    const pad = 4;
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(4, 4, tw + pad * 2, 18);
    ctx.fillStyle = fps >= 55 ? "#8fff6a" : fps >= 30 ? "#ffd23b" : "#ff6a60";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 4 + pad, 4 + 9);
    ctx.restore();
  }

  /** The requestAnimationFrame callback: fixed-step accumulator. */
  function frame(ts) {
    if (!game.running) return;
    const now = ts / 1000;
    let delta = now - game._lastTs;
    game._lastTs = now;
    if (delta > MAX_FRAME_DELTA) delta = MAX_FRAME_DELTA;

    // Rolling FPS estimate over the last ~30 frames (for the debug readout).
    if (delta > 0) {
      game._frameTimes.push(delta);
      if (game._frameTimes.length > 30) game._frameTimes.shift();
      const sum = game._frameTimes.reduce((a, b) => a + b, 0);
      game._fps = sum > 0 ? game._frameTimes.length / sum : 0;
    }

    game._accumulator += delta;
    while (game._accumulator >= FIXED_DT) {
      update(FIXED_DT);
      game._accumulator -= FIXED_DT;
    }
    render();

    game._rafId = requestAnimationFrame(frame);
  }

  /** Attach to the DOM, size the canvas, wire input, and start the loop. */
  function start(canvas) {
    if (typeof window === "undefined" || typeof document === "undefined") {
      throw new Error("start() requires a browser environment");
    }
    game.canvas = canvas;
    game.ctx = canvas.getContext("2d");

    resize();
    window.addEventListener("resize", resize);

    // Unlock the AudioContext on the first user gesture (mobile autoplay policy).
    // Once unlocked the handlers remove themselves.
    const unlockAudio = () => {
      game.audio.unlock();
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
      window.removeEventListener("touchstart", unlockAudio);
    };
    window.addEventListener("pointerdown", unlockAudio);
    window.addEventListener("keydown", unlockAudio);
    window.addEventListener("touchstart", unlockAudio);
    game._detachAudioUnlock = () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
      window.removeEventListener("touchstart", unlockAudio);
    };

    // Debug readout toggle: press 'd' to show/hide the FPS + plane-count HUD.
    const onKey = (ev) => {
      if (ev.key === "d" || ev.key === "D") game.debug = !game.debug;
      else if (ev.key === "m" || ev.key === "M") game.audio.toggleMute();
    };
    window.addEventListener("keydown", onKey);
    game._detachKeys = () => window.removeEventListener("keydown", onKey);

    game._detachInput = attachInput(canvas, game);

    // Build the bottom-console UI (clock/bank/reputation/flight strips) now that
    // the DOM exists. It subscribes to the EventBus for economy/reputation.
    if (document.getElementById("console")) {
      game.console = createConsole(game);
    }

    // Build the screen manager (menu / summary / shop / game-over). It boots
    // into the main menu and pauses the sim until a map is chosen.
    if (document.getElementById("screens")) {
      game.screens = createScreens(game);
    }

    game.running = true;
    game._lastTs = performance.now() / 1000;
    game._rafId = requestAnimationFrame(frame);
  }

  /** Stop the loop and detach handlers. */
  function stop() {
    game.running = false;
    if (game.systems.emergency && game.systems.emergency.detach) {
      game.systems.emergency.detach();
    }
    if (game._detachInput) {
      game._detachInput();
      game._detachInput = null;
    }
    if (game._detachAudioUnlock) {
      game._detachAudioUnlock();
      game._detachAudioUnlock = null;
    }
    if (game._detachKeys) {
      game._detachKeys();
      game._detachKeys = null;
    }
    if (game.console) {
      game.console.detach();
      game.console = null;
    }
    if (game.screens) {
      game.screens.detach();
      game.screens = null;
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", resize);
      if (game._rafId) cancelAnimationFrame(game._rafId);
    }
  }

  /** Size the canvas to its CSS box, scaled by devicePixelRatio for sharpness. */
  function resize() {
    const { canvas } = game;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    game.dpr = dpr;
    const newW = Math.max(1, rect.width);
    const newH = Math.max(1, rect.height);
    game.width = newW;
    game.height = newH;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    // Draw in CSS-pixel coordinates; the transform handles the device scale.
    game.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Rebuild the active map centered on the new radar size, then rebind the
    // systems + upgrade state to the fresh map object.
    game.map = createMap(game.mapId, newW, newH);
    game.upgradeState.map = game.map;
    buildSystems();
  }

  /**
   * Load a map by id: reset the World, the simulation clock, and game-over
   * state, rebuild the active map at the current radar size, re-point the
   * upgrade state at it, and rebuild the systems. Used to start each shift on
   * the selected map (map select / between-shift advance).
   */
  function loadMap(mapId) {
    // Detach the old emergency bus subscriptions before replacing systems.
    if (game.systems.emergency && game.systems.emergency.detach) {
      game.systems.emergency.detach();
    }
    game.mapId = mapId;
    game.world.clear();
    game.time = 0;
    game.sweep = 0;
    game._renderPrevSweep = 0;
    game.selectedId = null;
    game.camera = { target: null, followId: null };
    game.banner = null;
    game.gameOver = false;
    game.gameOverReason = null;
    game.closestSeparation = null;
    game._accumulator = 0;
    game.stats = { landed: 0, crashed: 0 };
    game.map = createMap(mapId, game.width, game.height);
    game.upgradeState.map = game.map;
    buildSystems();
    // Fresh economy/reputation/clock for the new shift if a console exists.
    if (game.console) game.console.resetForShift();
    game.progression.startShift();
    return game.map;
  }

  game.start = start;
  game.stop = stop;
  game.resize = resize;
  game.loadMap = loadMap;
  game.update = update; // exposed for headless/testing
  game.render = render;
  // System aliases (game.spawnSystem / weatherSystem / emergencySystem) are set
  // by buildSystems() and refreshed on every loadMap().
  return game;
}

// Auto-boot when loaded in a browser as a module script.
if (typeof document !== "undefined") {
  const boot = () => {
    const canvas = document.getElementById("radar-canvas");
    if (!canvas) return;
    const game = createGame();
    game.start(canvas);
    // Expose for debugging / later feature wiring.
    window.Game = game;
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
}
