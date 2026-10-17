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
import { fogAlphaForDistance } from "../game/weather.js";
import { EmergencyType } from "../game/emergencies.js";

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

/** Draw drifting opaque thunderstorm cells (world space, under aircraft). */
export function drawStorms(ctx, storms, time) {
  if (!storms || storms.length === 0) return;
  for (const cell of storms) {
    const grad = ctx.createRadialGradient(cell.x, cell.y, cell.radius * 0.2, cell.x, cell.y, cell.radius);
    grad.addColorStop(0, "rgba(40,30,60,0.92)");
    grad.addColorStop(0.7, "rgba(60,50,90,0.78)");
    grad.addColorStop(1, "rgba(60,50,90,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cell.x, cell.y, cell.radius, 0, Math.PI * 2);
    ctx.fill();
    // Occasional lightning flicker.
    const flicker = (Math.sin((time ?? 0) * 7 + cell.id) + 1) / 2;
    if (flicker > 0.82) {
      ctx.strokeStyle = "rgba(200,220,255,0.7)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cell.x - cell.radius * 0.3, cell.y - cell.radius * 0.3);
      ctx.lineTo(cell.x + cell.radius * 0.1, cell.y);
      ctx.lineTo(cell.x - cell.radius * 0.1, cell.y + cell.radius * 0.35);
      ctx.stroke();
    }
  }
}

/** Draw the hospital POI (world space): a cross marker + range ring. */
export function drawHospital(ctx, hospital) {
  if (!hospital) return;
  ctx.save();
  ctx.strokeStyle = "rgba(255,90,90,0.5)";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.arc(hospital.x, hospital.y, hospital.radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  // Red cross.
  const s = 7;
  ctx.fillStyle = "rgba(255,70,70,0.95)";
  ctx.fillRect(hospital.x - s, hospital.y - 2.5, s * 2, 5);
  ctx.fillRect(hospital.x - 2.5, hospital.y - s, 5, s * 2);
  ctx.fillStyle = "rgba(255,160,160,0.9)";
  ctx.font = '9px "Courier New", monospace';
  ctx.fillText("HOSP", hospital.x - 12, hospital.y + hospital.radius + 10);
  ctx.restore();
}

/**
 * Dim aircraft that are outside the fog visibility range so planes only draw
 * when close. Returns a function used by drawAircraft; here we expose a helper
 * to compute an aircraft's fog alpha so the render system can apply it. When
 * there is no fog (intensity ~0) this returns 1 for everything.
 */
export function aircraftFogAlpha(weather, map, x, y) {
  if (!weather || !map || !(weather.fogIntensity > 0.01)) return 1;
  if (weather.ilsOwned) return 1;
  const d = Math.hypot(x - map.center.x, y - map.center.y);
  return fogAlphaForDistance(d, weather.fogVisibility ?? Infinity);
}

/** Paint a fog vignette over the whole radar (screen space). */
export function drawFog(ctx, width, height, intensity) {
  if (!(intensity > 0.01)) return;
  const a = Math.min(0.55, 0.15 + intensity * 0.5);
  const grad = ctx.createRadialGradient(
    width / 2, height / 2, Math.min(width, height) * 0.12,
    width / 2, height / 2, Math.max(width, height) * 0.6
  );
  grad.addColorStop(0, `rgba(200,210,215,${a * 0.3})`);
  grad.addColorStop(1, `rgba(200,210,215,${a})`);
  ctx.save();
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/** Draw a wind-direction arrow + label in the top-left corner (screen space). */
export function drawWindIndicator(ctx, weather) {
  if (!weather || weather.windDirection == null) return;
  const ox = 30;
  const oy = 46;
  const len = 14;
  const a = weather.windDirection; // blowing toward
  ctx.save();
  ctx.strokeStyle = "rgba(120,200,255,0.9)";
  ctx.fillStyle = "rgba(120,200,255,0.9)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(ox - Math.cos(a) * len, oy - Math.sin(a) * len);
  ctx.lineTo(ox + Math.cos(a) * len, oy + Math.sin(a) * len);
  ctx.stroke();
  // Arrowhead at the "toward" end.
  const hx = ox + Math.cos(a) * len;
  const hy = oy + Math.sin(a) * len;
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(hx - Math.cos(a - 0.5) * 6, hy - Math.sin(a - 0.5) * 6);
  ctx.lineTo(hx - Math.cos(a + 0.5) * 6, hy - Math.sin(a + 0.5) * 6);
  ctx.closePath();
  ctx.fill();
  ctx.font = '9px "Courier New", monospace';
  ctx.fillText("WIND", ox - 14, oy - 18);
  ctx.restore();
}

/**
 * Red-flash ring over emergency (mayday / fuel) aircraft. Drawn in world space
 * after the icons. blinkOn drives the flash.
 */
export function drawEmergencyFlash(ctx, world, blinkOn) {
  const ids = world.query(Components.Transform, Components.Aircraft);
  for (const id of ids) {
    const ac = world.getComponent(id, Components.Aircraft);
    if (!ac.emergency) continue;
    const type = ac.emergency.type;
    if (type !== EmergencyType.MAYDAY && type !== EmergencyType.FUEL) continue;
    const t = world.getComponent(id, Components.Transform);
    const def = getAircraftDef(ac.kind);
    const r = def.hitboxRadius * 1.3 + 5;
    ctx.strokeStyle = blinkOn ? "rgba(255,40,40,0.95)" : "rgba(255,40,40,0.2)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(t.x, t.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
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
