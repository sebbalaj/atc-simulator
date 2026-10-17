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
import { createMap1 } from "./game/airport.js";
import { createSpawnSystem } from "./ecs/systems/spawnSystem.js";
import { createWeatherSystem } from "./ecs/systems/weatherSystem.js";
import { createEmergencySystem } from "./ecs/systems/emergencySystem.js";
import { createMovementSystem } from "./ecs/systems/movementSystem.js";
import { createLandingSystem } from "./ecs/systems/landingSystem.js";
import { createCollisionSystem } from "./ecs/systems/collisionSystem.js";
import { createRenderSystem } from "./ecs/systems/renderSystem.js";
import { attachInput } from "./ui/input.js";
import { createConsole } from "./ui/console.js";

// Fixed simulation step: 60 updates per second.
const FIXED_DT = 1 / 60;
// Clamp huge frame gaps (e.g. tab regained focus) so we never spiral.
const MAX_FRAME_DELTA = 0.25;

// Default radar dimensions used for headless construction (before a canvas is
// attached). Overwritten by resize() once a real canvas exists.
const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 600;

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
    map: createMap1(width, height),
    canvas: null,
    ctx: null,
    dpr: 1,
    width,
    height,
    running: false,
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
    stats: { landed: 0, crashed: 0 },
    _accumulator: 0,
    _lastTs: 0,
    _rafId: 0,
    _detachInput: null,
  };

  // Build systems bound to this game.
  const spawnSystem = createSpawnSystem(game);
  const weatherSystem = createWeatherSystem(game);
  const emergencySystem = createEmergencySystem(game);
  const movementSystem = createMovementSystem(game);
  const landingSystem = createLandingSystem(game);
  const collisionSystem = createCollisionSystem(game);
  const renderSystem = createRenderSystem(game);

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

  /**
   * Advance the simulation by one fixed step. System order (authoritative):
   * spawn -> movement (applies drawn paths) -> landing -> collision -> (render
   * is separate, in the frame callback).
   */
  function update(dt) {
    game.time += dt;
    game.sweep = (game.sweep + (dt * Math.PI * 2) / 4) % (Math.PI * 2);
    // Fade/expire the transient banner regardless of game-over state.
    if (game.banner) {
      const remaining = game.banner.until - game.time;
      if (remaining <= 0) game.banner = null;
      else game.banner.alpha = Math.min(1, remaining / 0.8);
    }
    if (game.gameOver) return;
    spawnSystem(dt);
    weatherSystem(dt);
    emergencySystem(dt);
    movementSystem(dt);
    landingSystem(dt);
    collisionSystem(dt);
  }

  /** Draw a single frame. */
  function render() {
    const { ctx, width: w, height: h } = game;
    // Refresh the DOM console (clock/bank/reputation/strips) each frame.
    if (game.console) game.console.update();
    if (!ctx) return;
    // Blink phase for proximity warnings (~3 Hz).
    const blinkPhase = (game.time * 3) % 1;
    renderSystem(ctx, w, h, blinkPhase);
  }

  /** The requestAnimationFrame callback: fixed-step accumulator. */
  function frame(ts) {
    if (!game.running) return;
    const now = ts / 1000;
    let delta = now - game._lastTs;
    game._lastTs = now;
    if (delta > MAX_FRAME_DELTA) delta = MAX_FRAME_DELTA;

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

    game._detachInput = attachInput(canvas, game);

    // Build the bottom-console UI (clock/bank/reputation/flight strips) now that
    // the DOM exists. It subscribes to the EventBus for economy/reputation.
    if (document.getElementById("console")) {
      game.console = createConsole(game);
    }

    game.running = true;
    game._lastTs = performance.now() / 1000;
    game._rafId = requestAnimationFrame(frame);
  }

  /** Stop the loop and detach handlers. */
  function stop() {
    game.running = false;
    if (emergencySystem && emergencySystem.detach) emergencySystem.detach();
    if (game._detachInput) {
      game._detachInput();
      game._detachInput = null;
    }
    if (game.console) {
      game.console.detach();
      game.console = null;
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
    // Rebuild the map centered on the new radar size.
    game.map = createMap1(newW, newH);
  }

  game.start = start;
  game.stop = stop;
  game.resize = resize;
  game.update = update; // exposed for headless/testing
  game.render = render;
  game.spawnSystem = spawnSystem; // exposed for seeding/testing
  game.weatherSystem = weatherSystem; // exposed for manual triggering/testing
  game.emergencySystem = emergencySystem;
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
