// On-canvas HUD overlays, drawn by the render system after the world. These are
// browser-coupled (they draw to a 2D context) but import nothing at load time
// that needs the DOM, so the module still parses under `node --check`.
//
// Provides:
//   - drawLowFuelGauges: a small fuel arc over any low-fuel aircraft.
//   - drawProximityAlarm: a screen-edge red vignette whose intensity tracks the
//     closest separation (the audible alarm is wired separately in FEAT-006).
//   - drawEventBanner: a top banner for transient event messages.
//   - applyCamera / clearCamera: center the view on the selected plane.

import { Components } from "../ecs/components.js";
import { getAircraftDef } from "../game/aircraft.js";
import { fuelStatus } from "../game/fuel.js";

/**
 * Apply the camera transform (translate so camera.target is centered). Call
 * after ctx.save(); pair with a ctx.restore(). No-op if there is no target.
 * Returns the applied offset for hit-testing callers that need it.
 */
export function applyCamera(ctx, camera, width, height) {
  if (!camera || !camera.target) return { x: 0, y: 0 };
  const ox = width / 2 - camera.target.x;
  const oy = height / 2 - camera.target.y;
  ctx.translate(ox, oy);
  return { x: ox, y: oy };
}

/** Draw low-fuel gauges (a depleting arc) over aircraft running low. */
export function drawLowFuelGauges(ctx, world, blinkOn) {
  const ids = world.query(Components.Transform, Components.Aircraft, Components.Fuel);
  for (const id of ids) {
    const fuel = world.getComponent(id, Components.Fuel);
    const st = fuelStatus(fuel);
    if (!st.low) continue;
    const t = world.getComponent(id, Components.Transform);
    const ac = world.getComponent(id, Components.Aircraft);
    const def = getAircraftDef(ac.kind);
    const r = def.hitboxRadius * 1.3 + 9;

    // Background ring.
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(t.x, t.y, r, 0, Math.PI * 2);
    ctx.stroke();

    // Remaining-fuel arc. Critical fuel blinks.
    const color = st.critical
      ? (blinkOn ? "#ff3b30" : "rgba(255,59,48,0.3)")
      : "#ffd23b";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    const start = -Math.PI / 2;
    ctx.arc(t.x, t.y, r, start, start + Math.PI * 2 * st.fraction);
    ctx.stroke();
  }
}

/**
 * Draw a red edge vignette whose opacity scales with how far inside the closest
 * separation breach the nearest pair is. `closest` is game.closestSeparation
 * (px) or null when nothing is near.
 */
export function drawProximityAlarm(ctx, width, height, closest, warnThreshold, blinkOn) {
  if (closest == null || !(closest < warnThreshold)) return;
  // 0 at the threshold, 1 at zero separation.
  const severity = Math.max(0, Math.min(1, 1 - closest / warnThreshold));
  const base = 0.12 + 0.35 * severity;
  const alpha = blinkOn ? base : base * 0.4;

  const thickness = Math.max(width, height) * 0.14;
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  // Use a radial-ish vignette via four edge gradients kept simple: paint a
  // border rectangle with a soft inner falloff.
  ctx.save();
  ctx.fillStyle = `rgba(255,59,48,${alpha})`;
  // Top / bottom / left / right bands.
  ctx.fillRect(0, 0, width, thickness);
  ctx.fillRect(0, height - thickness, width, thickness);
  ctx.fillRect(0, 0, thickness, height);
  ctx.fillRect(width - thickness, 0, thickness, height);
  ctx.restore();
  void grad;
}

/** Draw a top banner with a short event message (fades handled by caller). */
export function drawEventBanner(ctx, width, text, alpha = 1) {
  if (!text) return;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  const h = 26;
  ctx.fillRect(0, 0, width, h);
  ctx.fillStyle = "#ffd23b";
  ctx.font = 'bold 13px "Courier New", monospace';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, width / 2, h / 2);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.restore();
}
