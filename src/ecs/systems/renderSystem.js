// Render system (Canvas 2D, fully procedural, no assets). Browser-coupled: it
// touches a 2D context but nothing it needs at module load, so it still imports
// under Node. Draws, in order: radar background + range rings, the airport
// (runways with approach cones + helipad), each drawn/locked flight path, and
// every aircraft as a class-specific icon oriented to its heading with a label.
// Proximity-flagged aircraft blink red; the selected aircraft gets a highlight.

import { Components } from "../components.js";
import { getAircraftDef } from "../../game/aircraft.js";
import { runwayThreshold, runwayFarEnd } from "../../game/airport.js";
import {
  applyCamera,
  drawLowFuelGauges,
  drawProximityAlarm,
  drawEventBanner,
  drawStorms,
  drawHospital,
  drawFog,
  drawWindIndicator,
  drawEmergencyFlash,
  aircraftFogAlpha,
} from "../../ui/hud.js";

// Separation at/under which the proximity alarm vignette begins. Matches the
// widest class separation bubble so the alarm tracks real conflicts.
const ALARM_THRESHOLD = 72;

/** Build the ECS render system bound to a game instance. */
export function createRenderSystem(game) {
  const { world } = game;

  return function renderSystem(ctx, width, height, blinkPhase) {
    const blinkOn = blinkPhase === undefined ? true : blinkPhase < 0.5;

    // Background is drawn in screen space (fills the scope regardless of pan).
    drawRadarBackground(ctx, width, height, game.sweep);

    // World layers are drawn through the camera transform so a selected plane
    // can be centered on screen. With no camera target this is the identity.
    ctx.save();
    applyCamera(ctx, game.camera, width, height);
    drawAirport(ctx, game.map);
    if (game.map) drawHospital(ctx, game.map.hospital);
    drawPaths(ctx, world);
    // Storm cells are drawn under the aircraft so planes read on top of them.
    if (game.weather) drawStorms(ctx, game.weather.storms, game.time);
    drawAircraft(ctx, world, game, blinkPhase);
    drawEmergencyFlash(ctx, world, blinkOn);
    drawLowFuelGauges(ctx, world, blinkOn);
    ctx.restore();

    // Fog dims the whole field (screen space, over the world).
    if (game.weather) drawFog(ctx, width, height, game.weather.fogIntensity);

    // Screen-space overlays.
    if (game.weather) drawWindIndicator(ctx, game.weather);
    drawProximityAlarm(ctx, width, height, game.closestSeparation, ALARM_THRESHOLD, blinkOn);
    if (game.banner && game.banner.text) {
      drawEventBanner(ctx, width, game.banner.text, game.banner.alpha ?? 1);
    }

    if (game.gameOver) drawGameOver(ctx, width, height, game.gameOverReason);
  };
}

/** CRT radar field with grid, range rings and rotating sweep. */
export function drawRadarBackground(ctx, width, height, sweepAngle) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#001405";
  ctx.fillRect(0, 0, width, height);

  const cx = width / 2;
  const cy = height / 2;
  const maxR = Math.hypot(width, height) / 2;

  ctx.strokeStyle = "rgba(57, 255, 20, 0.10)";
  ctx.lineWidth = 1;
  const spacing = 40;
  ctx.beginPath();
  for (let x = cx % spacing; x <= width; x += spacing) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = cy % spacing; y <= height; y += spacing) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  ctx.strokeStyle = "rgba(57, 255, 20, 0.22)";
  for (let r = spacing; r <= maxR; r += spacing * 2) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  const grad = ctx.createLinearGradient(
    cx,
    cy,
    cx + Math.cos(sweepAngle) * maxR,
    cy + Math.sin(sweepAngle) * maxR
  );
  grad.addColorStop(0, "rgba(57, 255, 20, 0.5)");
  grad.addColorStop(1, "rgba(57, 255, 20, 0)");
  ctx.strokeStyle = grad;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(sweepAngle) * maxR, cy + Math.sin(sweepAngle) * maxR);
  ctx.stroke();
}

/** Draw runways, their approach cones, and the helipad. */
export function drawAirport(ctx, map) {
  if (!map) return;

  for (const runway of map.runways) {
    // Both landing directions share one physical strip; draw cones for each.
    drawApproachCone(ctx, runway, runway.heading);
    drawApproachCone(ctx, runway, runway.heading + Math.PI);
  }

  for (const runway of map.runways) {
    const thr = runwayThreshold(runway);
    const far = runwayFarEnd(runway);
    ctx.strokeStyle = "rgba(200, 220, 255, 0.85)";
    ctx.lineWidth = runway.width;
    ctx.lineCap = "butt";
    ctx.beginPath();
    ctx.moveTo(thr.x, thr.y);
    ctx.lineTo(far.x, far.y);
    ctx.stroke();

    // Centerline dashes.
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(thr.x, thr.y);
    ctx.lineTo(far.x, far.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Helipad: circle with an "H".
  const pad = map.helipad;
  if (pad) {
    ctx.strokeStyle = "rgba(120, 200, 255, 0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pad.x, pad.y, pad.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(120, 200, 255, 0.9)";
    ctx.font = `${Math.round(pad.radius)}px "Courier New", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("H", pad.x, pad.y + 1);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }
}

/** Draw a single approach cone extending back from a runway threshold. */
function drawApproachCone(ctx, runway, direction) {
  const thr = {
    x: runway.x - Math.cos(direction) * (runway.length / 2),
    y: runway.y - Math.sin(direction) * (runway.length / 2),
  };
  const tol = runway.approach.tolerance;
  const len = runway.approach.coneLength;
  const back = direction + Math.PI; // cone opens toward inbound traffic
  const a1 = back + tol;
  const a2 = back - tol;

  ctx.fillStyle = "rgba(57, 255, 20, 0.07)";
  ctx.strokeStyle = "rgba(57, 255, 20, 0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(thr.x, thr.y);
  ctx.lineTo(thr.x + Math.cos(a1) * len, thr.y + Math.sin(a1) * len);
  ctx.lineTo(thr.x + Math.cos(a2) * len, thr.y + Math.sin(a2) * len);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

/** Draw every aircraft's drawn/locked flight path. */
export function drawPaths(ctx, world) {
  const ids = world.query(Components.Transform, Components.Path);
  for (const id of ids) {
    const path = world.getComponent(id, Components.Path);
    const poly = path.built && path.built.points.length >= 2
      ? path.built.points
      : path.points;
    if (!poly || poly.length < 2) continue;

    ctx.strokeStyle = path.locked
      ? "rgba(255, 210, 59, 0.9)" // cleared-to-land path
      : "rgba(57, 255, 20, 0.55)";
    ctx.lineWidth = path.locked ? 2.5 : 1.8;
    ctx.setLineDash(path.locked ? [] : [4, 4]);
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** Draw each aircraft icon, label, selection highlight and warning blink. */
export function drawAircraft(ctx, world, game, blinkPhase) {
  const blinkOn = blinkPhase === undefined ? true : blinkPhase < 0.5;
  const ids = world.query(Components.Transform, Components.Aircraft, Components.Render);

  for (const id of ids) {
    const t = world.getComponent(id, Components.Transform);
    const render = world.getComponent(id, Components.Render);
    const ac = world.getComponent(id, Components.Aircraft);
    const label = world.getComponent(id, Components.Label);
    const def = getAircraftDef(ac.kind);

    const warning = render.warning;
    const selected = game.selectedId === id;

    // Fog hides planes beyond the visibility range (unless ILS is owned).
    const fogAlpha = aircraftFogAlpha(game.weather, game.map, t.x, t.y);
    if (fogAlpha <= 0.02) continue;

    ctx.save();
    ctx.globalAlpha = fogAlpha;
    ctx.translate(t.x, t.y);

    // Selection ring (drawn unrotated, around the icon).
    if (selected) {
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, render.size + 6, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Proximity warning: pulsing red ring.
    if (warning) {
      ctx.strokeStyle = blinkOn ? "rgba(255,59,48,0.95)" : "rgba(255,59,48,0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, def.separationRadius * 0.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Icon oriented to heading.
    ctx.save();
    ctx.rotate(t.heading);
    const color = warning && !blinkOn ? "#ff3b30" : render.color;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    def.drawShape(ctx, render.size);
    ctx.restore();

    // Label: callsign.
    const cs = label ? label.callsign : "";
    if (cs) {
      ctx.fillStyle = warning ? "#ff6a60" : "rgba(220,255,210,0.9)";
      ctx.font = '10px "Courier New", monospace';
      ctx.fillText(cs, render.size + 4, -4);
    }
    ctx.restore();
  }
}

/** Dim overlay + message when the level ends. */
function drawGameOver(ctx, width, height, reason) {
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#ff3b30";
  ctx.font = 'bold 28px "Courier New", monospace';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const msg =
    reason === "collision"
      ? "MID-AIR COLLISION"
      : reason === "fired"
      ? "YOU'RE FIRED"
      : "LEVEL OVER";
  ctx.fillText(msg, width / 2, height / 2 - 14);
  ctx.font = '14px "Courier New", monospace';
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  const sub = reason === "fired" ? "Reputation hit zero" : "Level ended";
  ctx.fillText(sub, width / 2, height / 2 + 16);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}
