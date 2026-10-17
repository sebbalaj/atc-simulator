// Bootstrap + fixed-timestep game loop. Sizes the radar canvas with
// devicePixelRatio scaling, builds the ECS World, and runs an accumulator loop
// driven by requestAnimationFrame. Renders a CRT-style radar grid and a sweep
// placeholder so there is visible output. No gameplay yet.
//
// Browser-coupled: all window/document access is guarded so pure core/ECS
// modules remain importable under Node (`node --check` / unit tests).

import { createWorld } from "./ecs/world.js";
import { createEventBus } from "./core/events.js";
import { createSpatialHash } from "./core/spatialHash.js";

// Fixed simulation step: 60 updates per second.
const FIXED_DT = 1 / 60;
// Clamp huge frame gaps (e.g. tab regained focus) so we never spiral.
const MAX_FRAME_DELTA = 0.25;

/**
 * Create the Game object. Pure construction; nothing touches the DOM until
 * start() is called, keeping this importable under Node.
 */
export function createGame(options = {}) {
  const world = createWorld();
  const bus = createEventBus();
  const spatial = createSpatialHash(options.cellSize ?? 64);

  const game = {
    world,
    bus,
    spatial,
    canvas: null,
    ctx: null,
    dpr: 1,
    width: 0, // CSS pixels of the radar region
    height: 0,
    running: false,
    time: 0, // accumulated simulation time (seconds)
    sweep: 0, // radar sweep angle (radians), rendered placeholder
    _accumulator: 0,
    _lastTs: 0,
    _rafId: 0,
  };

  /** Advance the simulation by one fixed step. */
  function update(dt) {
    game.time += dt;
    // Radar sweep completes a revolution every ~4 seconds.
    game.sweep = (game.sweep + (dt * Math.PI * 2) / 4) % (Math.PI * 2);
    // Future systems (movement, collision, spawning) hook in here.
  }

  /** Draw a single frame. */
  function render() {
    const { ctx, width, height } = game;
    if (!ctx) return;
    drawRadar(ctx, width, height, game.sweep);
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

  /** Attach to the DOM, size the canvas, and start the loop. */
  function start(canvas) {
    if (typeof window === "undefined" || typeof document === "undefined") {
      throw new Error("start() requires a browser environment");
    }
    game.canvas = canvas;
    game.ctx = canvas.getContext("2d");

    resize();
    window.addEventListener("resize", resize);

    game.running = true;
    game._lastTs = performance.now() / 1000;
    game._rafId = requestAnimationFrame(frame);
  }

  /** Stop the loop and detach resize handling. */
  function stop() {
    game.running = false;
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
    game.width = rect.width;
    game.height = rect.height;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    // Draw in CSS-pixel coordinates; the transform handles the device scale.
    game.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  game.start = start;
  game.stop = stop;
  game.resize = resize;
  game.update = update; // exposed for headless/testing
  return game;
}

/**
 * Draw the CRT radar background: black field, concentric range rings, cross
 * grid, and a rotating sweep line. Pure drawing given a 2D context.
 */
export function drawRadar(ctx, width, height, sweepAngle) {
  ctx.clearRect(0, 0, width, height);

  // Dark field.
  ctx.fillStyle = "#001405";
  ctx.fillRect(0, 0, width, height);

  const cx = width / 2;
  const cy = height / 2;
  const maxR = Math.hypot(width, height) / 2;

  // Grid lines.
  ctx.strokeStyle = "rgba(57, 255, 20, 0.12)";
  ctx.lineWidth = 1;
  const spacing = 40;
  ctx.beginPath();
  for (let x = (cx % spacing); x <= width; x += spacing) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = (cy % spacing); y <= height; y += spacing) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  // Concentric range rings.
  ctx.strokeStyle = "rgba(57, 255, 20, 0.28)";
  for (let r = spacing; r <= maxR; r += spacing * 2) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Center crosshair.
  ctx.strokeStyle = "rgba(57, 255, 20, 0.45)";
  ctx.beginPath();
  ctx.moveTo(cx - 12, cy);
  ctx.lineTo(cx + 12, cy);
  ctx.moveTo(cx, cy - 12);
  ctx.lineTo(cx, cy + 12);
  ctx.stroke();

  // Sweep line with a faint trailing wedge.
  const grad = ctx.createLinearGradient(
    cx,
    cy,
    cx + Math.cos(sweepAngle) * maxR,
    cy + Math.sin(sweepAngle) * maxR
  );
  grad.addColorStop(0, "rgba(57, 255, 20, 0.6)");
  grad.addColorStop(1, "rgba(57, 255, 20, 0)");
  ctx.strokeStyle = grad;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(sweepAngle) * maxR, cy + Math.sin(sweepAngle) * maxR);
  ctx.stroke();
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
