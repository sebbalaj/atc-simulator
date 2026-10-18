// Render system (Canvas 2D, fully procedural, no assets). Browser-coupled: it
// touches a 2D context but nothing it needs at module load, so it still imports
// under Node. Draws, in order: radar background + range rings, the airport
// (runways with approach cones + helipad), each drawn/locked flight path, and
// every aircraft as a class-specific icon oriented to its heading with a label.
// Proximity-flagged aircraft blink red; the selected aircraft gets a highlight.

import { Components } from "../components.js";
import { getAircraftDef } from "../../game/aircraft.js";
import { runwayThreshold, runwayFarEnd, runwayEndLabel, normalizeAngle } from "../../game/airport.js";
import { activeLandingDirections } from "../../game/weather.js";
import { updateSweepDisplay, sweepPeriod } from "../../game/radar.js";
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
    drawAirport(ctx, game.map, activeRunwayIds(world), game.time, game.weather);
    if (game.map) drawHospital(ctx, game.map.hospital);
    drawPaths(ctx, world, blinkOn);
    // DISPLAY-ONLY: the in-progress route the player is currently drawing. Read
    // from game.drawPreview (set by input.js on pointermove, cleared on
    // pointerup). The sim never reads this; it is purely the pending-line cue.
    drawDrawPreview(ctx, game.drawPreview);
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

/**
 * Collect the set of runway ids that currently have an aircraft cleared onto
 * them (locked clearance or rolling out), so the render layer can highlight the
 * active runway + its catch cone. Display-only; never touches the sim.
 */
function activeRunwayIds(world) {
  const active = new Set();
  const ids = world.query(Components.Aircraft);
  for (const id of ids) {
    const ac = world.getComponent(id, Components.Aircraft);
    const rid = ac && ac.clearance && ac.clearance.runwayId;
    if (rid != null) active.add(rid);
    const lrid = ac && ac.landing && ac.landing.runwayId;
    if (lrid != null) active.add(lrid);
  }
  return active;
}

/**
 * Draw runways, their approach cones, and the helipad. `now` is the current sim
 * time: a runway with `now < occupiedUntil` has just taken a landing and is
 * rendered RED ("occupied / clearing") until the ground crew clears it, when it
 * returns to its normal/green styling.
 */
export function drawAirport(ctx, map, activeIds, now = 0, weather = null) {
  if (!map) return;
  const active = activeIds || new Set();

  // FEAT-003: which landing DIRECTION(s) are into the wind (and therefore
  // routable) right now. At steady state exactly one end per runway; during a
  // wind-shift transition both ends. Emphasize the active threshold/cone and
  // dim the inactive end so the player can see which way to land.
  const windState =
    weather && weather.windDirection != null
      ? {
          windDirection: weather.windDirection,
          windTolerance: weather.windTolerance,
          transition: weather.windTransition,
        }
      : null;
  const dirIsActive = (runway, heading) => {
    if (!windState) return true; // no weather => both ends drawn equally
    const legal = activeLandingDirections(runway, windState);
    return legal.some((d) => Math.abs(normalizeAngle(d - heading)) < 1e-3);
  };

  for (const runway of map.runways) {
    // Both landing directions share one physical strip; draw cones for each.
    // The runway with a cleared aircraft gets a brighter "catch zone" cone so
    // the active approach reads at a glance. A cone whose landing direction is
    // not currently into the wind is dimmed (inactive end).
    const cleared = active.has(runway.id);
    const nearActive = dirIsActive(runway, runway.heading);
    const farActive = dirIsActive(runway, runway.heading + Math.PI);
    drawApproachCone(ctx, runway, runway.heading, cleared || nearActive, !nearActive);
    drawApproachCone(ctx, runway, runway.heading + Math.PI, cleared || farActive, !farActive);
  }

  for (const runway of map.runways) {
    const thr = runwayThreshold(runway);
    const far = runwayFarEnd(runway);
    const isActive = active.has(runway.id);
    // Occupied: a landing is clearing the strip (now < occupiedUntil). The red
    // "in use" styling takes visual priority over the active-amber underglow
    // once a plane has touched down.
    const occupied = now < (runway.occupiedUntil || 0);

    // An active (cleared) runway gets a faint amber underglow so it reads as the
    // one in use, consistent with the amber cleared-path/lock cues. An occupied
    // runway gets a RED underglow instead so "used, clearing" reads at a glance.
    if (occupied) {
      ctx.strokeStyle = "rgba(255, 59, 48, 0.35)";
      ctx.lineWidth = runway.width + 7;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(thr.x, thr.y);
      ctx.lineTo(far.x, far.y);
      ctx.stroke();
      ctx.lineCap = "butt";
    } else if (isActive) {
      ctx.strokeStyle = "rgba(255, 190, 40, 0.30)";
      ctx.lineWidth = runway.width + 7;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(thr.x, thr.y);
      ctx.lineTo(far.x, far.y);
      ctx.stroke();
      ctx.lineCap = "butt";
    }

    ctx.strokeStyle = occupied
      ? "rgba(255, 90, 80, 0.95)"
      : isActive
      ? "rgba(235, 240, 255, 0.95)"
      : "rgba(200, 220, 255, 0.85)";
    ctx.lineWidth = runway.width;
    ctx.lineCap = "butt";
    ctx.beginPath();
    ctx.moveTo(thr.x, thr.y);
    ctx.lineTo(far.x, far.y);
    ctx.stroke();

    // Threshold bar: a bright crossbar marking the touchdown end so the "aim
    // here" end of the active strip is obvious. RED while occupied.
    const perp = runway.heading + Math.PI / 2;
    const hw = runway.width / 2;
    ctx.strokeStyle = occupied
      ? "rgba(255, 59, 48, 0.95)"
      : isActive
      ? "rgba(255, 214, 70, 0.95)"
      : "rgba(220, 235, 255, 0.8)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(thr.x - Math.cos(perp) * hw, thr.y - Math.sin(perp) * hw);
    ctx.lineTo(thr.x + Math.cos(perp) * hw, thr.y + Math.sin(perp) * hw);
    ctx.stroke();

    // FEAT-003: label the ACTIVE (into-wind) landing end(s) with the runway end
    // name so the player can see which direction to land on. During a transition
    // both ends are active and both get labels. The label sits just outside the
    // threshold, back along the approach (where inbound traffic sees it).
    const nearActive = dirIsActive(runway, runway.heading);
    const farActive = dirIsActive(runway, runway.heading + Math.PI);
    ctx.save();
    ctx.font = 'bold 8px "Courier New", monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255, 214, 70, 0.95)";
    const labelOffset = runway.width + 10;
    if (nearActive) {
      const lx = thr.x - Math.cos(runway.heading) * labelOffset;
      const ly = thr.y - Math.sin(runway.heading) * labelOffset;
      ctx.fillText(runwayEndLabel(runway, runway.heading), lx, ly);
    }
    if (farActive) {
      const fdir = normalizeAngle(runway.heading + Math.PI);
      const fx = far.x - Math.cos(fdir) * labelOffset;
      const fy = far.y - Math.sin(fdir) * labelOffset;
      ctx.fillText(runwayEndLabel(runway, fdir), fx, fy);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.restore();

    // Edge lights: a row at each end. Red when occupied, green when clear — the
    // literal "runway lights turn red" cue.
    const lightColor = occupied ? "rgba(255, 59, 48, 0.95)" : "rgba(57, 255, 20, 0.9)";
    ctx.fillStyle = lightColor;
    for (const end of [thr, far]) {
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(
          end.x + Math.cos(perp) * hw * s,
          end.y + Math.sin(perp) * hw * s,
          1.6,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    }

    // Centerline dashes.
    ctx.strokeStyle = occupied ? "rgba(255, 120, 110, 0.6)" : "rgba(255,255,255,0.55)";
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

/**
 * Draw a single approach cone extending back from a runway threshold. The cone
 * is the forgiving "catch zone": end a drawn route anywhere inside it tracking
 * the runway heading and the approach snaps and locks. An `active` cone (a
 * plane already cleared into this runway) is drawn brighter.
 */
function drawApproachCone(ctx, runway, direction, active = false, dim = false) {
  ctx.save();
  if (dim) ctx.globalAlpha = 0.28; // inactive (down-wind) end reads faint
  const thr = {
    x: runway.x - Math.cos(direction) * (runway.length / 2),
    y: runway.y - Math.sin(direction) * (runway.length / 2),
  };
  const tol = runway.approach.tolerance;
  const len = runway.approach.coneLength;
  const back = direction + Math.PI; // cone opens toward inbound traffic
  const a1 = back + tol;
  const a2 = back - tol;

  const ex1 = thr.x + Math.cos(a1) * len;
  const ey1 = thr.y + Math.sin(a1) * len;
  const ex2 = thr.x + Math.cos(a2) * len;
  const ey2 = thr.y + Math.sin(a2) * len;

  // Filled wedge. A gradient fades the catch zone out toward its wide end so the
  // mouth reads as "aim roughly here" without a hard edge.
  const grad = ctx.createLinearGradient(thr.x, thr.y, (ex1 + ex2) / 2, (ey1 + ey2) / 2);
  if (active) {
    grad.addColorStop(0, "rgba(255, 210, 70, 0.20)");
    grad.addColorStop(1, "rgba(255, 210, 70, 0)");
  } else {
    grad.addColorStop(0, "rgba(57, 255, 20, 0.14)");
    grad.addColorStop(1, "rgba(57, 255, 20, 0)");
  }
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(thr.x, thr.y);
  ctx.lineTo(ex1, ey1);
  ctx.lineTo(ex2, ey2);
  ctx.closePath();
  ctx.fill();

  // Dashed cone edges so the boundary of the catch zone is legible.
  ctx.strokeStyle = active ? "rgba(255, 214, 70, 0.6)" : "rgba(57, 255, 20, 0.35)";
  ctx.lineWidth = active ? 1.4 : 1;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(thr.x, thr.y);
  ctx.lineTo(ex1, ey1);
  ctx.moveTo(thr.x, thr.y);
  ctx.lineTo(ex2, ey2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

/**
 * Draw every aircraft's drawn/locked flight path. A locked ("cleared to land")
 * route is drawn in a thick, bright amber so it is unmistakable from a pending
 * green route; a cleared aircraft also gets a small amber lock marker at the
 * runway threshold / pad it is cleared into. `blinkOn` (optional) pulses the
 * lock marker so a fresh clearance reads at a glance.
 */
export function drawPaths(ctx, world, blinkOn = true) {
  const ids = world.query(Components.Transform, Components.Path);
  for (const id of ids) {
    const path = world.getComponent(id, Components.Path);
    const poly = path.built && path.built.points.length >= 2
      ? path.built.points
      : path.points;
    if (!poly || poly.length < 2) continue;

    if (path.locked) {
      // Cleared-to-land: a bright amber glow underlay plus a solid thick core so
      // the route pops against the green scope.
      ctx.strokeStyle = "rgba(255, 190, 40, 0.28)";
      ctx.lineWidth = 7;
      ctx.lineCap = "round";
      ctx.setLineDash([]);
      strokePoly(ctx, poly);

      ctx.strokeStyle = "rgba(255, 214, 70, 0.95)";
      ctx.lineWidth = 3.5;
      strokePoly(ctx, poly);
      ctx.lineCap = "butt";
    } else {
      ctx.strokeStyle = "rgba(57, 255, 20, 0.55)";
      ctx.lineWidth = 1.8;
      ctx.setLineDash([4, 4]);
      strokePoly(ctx, poly);
      ctx.setLineDash([]);
    }

    // Lock indicator at the cleared touchdown point (threshold / pad).
    if (path.locked) {
      const ac = world.getComponent(id, Components.Aircraft);
      const c = ac && ac.clearance;
      const mark = c && (c.threshold || c.stop);
      if (mark) drawLockMarker(ctx, mark.x, mark.y, blinkOn);
    }
  }
}

/**
 * Draw the in-progress drawn route (display-only preview) as a pending green
 * dashed line, reusing the unlocked-path styling so it reads as "not yet
 * cleared". `preview` is {id, points} or null. The committed Path keeps being
 * drawn by drawPaths; this is only the line under the player's finger.
 */
export function drawDrawPreview(ctx, preview) {
  if (!preview || !preview.points || preview.points.length < 2) return;
  ctx.strokeStyle = "rgba(57, 255, 20, 0.55)";
  ctx.lineWidth = 1.8;
  ctx.setLineDash([4, 4]);
  strokePoly(ctx, preview.points);
  ctx.setLineDash([]);
}

/** Stroke an open polyline through the given points. */
function strokePoly(ctx, poly) {
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.stroke();
}

/** A small amber lock ring + crosshair marking a cleared touchdown point. */
function drawLockMarker(ctx, x, y, blinkOn) {
  const r = 9;
  ctx.save();
  ctx.strokeStyle = blinkOn ? "rgba(255, 214, 70, 0.95)" : "rgba(255, 214, 70, 0.5)";
  ctx.fillStyle = "rgba(255, 190, 40, 0.18)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Short tick marks (a "locked" crosshair).
  ctx.beginPath();
  ctx.moveTo(x - r - 3, y);
  ctx.lineTo(x - r + 3, y);
  ctx.moveTo(x + r - 3, y);
  ctx.lineTo(x + r + 3, y);
  ctx.moveTo(x, y - r - 3);
  ctx.lineTo(x, y - r + 3);
  ctx.moveTo(x, y + r - 3);
  ctx.lineTo(x, y + r + 3);
  ctx.stroke();
  ctx.restore();
}

// Fraction of a sweep period over which a stale blip fades from full alpha down
// to the dim floor. A blip just under one period old is the dimmest before its
// next refresh; this keeps the "last-known position" feel without going dark.
const BLIP_FADE_FLOOR = 0.28; // minimum alpha a swept-but-stale blip keeps
const TRAIL_STEPS = 3; // short fading trail segments behind a fresh blip

/**
 * Draw each aircraft icon, label, selection highlight and warning blink.
 *
 * Radar-sweep gating (DISPLAY ONLY): each aircraft's shown blip is latched to
 * its TRUE position only when the rotating sweep beam crosses its bearing; in
 * between it holds the last-swept position and fades. The authoritative sim is
 * never consulted here beyond reading true positions to latch. Selected and
 * warning/emergency aircraft are force-latched every frame so a stale blip can
 * never hide an actionable conflict. Fog/ILS alpha multiplies the sweep alpha.
 */
export function drawAircraft(ctx, world, game, blinkPhase) {
  const blinkOn = blinkPhase === undefined ? true : blinkPhase < 0.5;
  const ids = world.query(Components.Transform, Components.Aircraft, Components.Render);

  // Radar center is the map center (fall back to the scope center).
  const center =
    game.map && game.map.center
      ? game.map.center
      : { x: game.width / 2, y: game.height / 2 };

  // Build the display-update list: force-latch selected + warning/emergency
  // planes so they always track live and never fade out.
  const planes = [];
  for (const id of ids) {
    const t = world.getComponent(id, Components.Transform);
    const render = world.getComponent(id, Components.Render);
    const ac = world.getComponent(id, Components.Aircraft);
    const selected = game.selectedId === id;
    const force = selected || !!render.warning || !!(ac && ac.emergency);
    planes.push({ render, x: t.x, y: t.y, heading: t.heading, force });
  }

  // Latch last-swept positions for planes the beam crossed this frame. Use the
  // sweep value the render layer last observed (robust to frame/tick decoupling
  // and 2PI wraparound), NOT a dt-derived delta.
  const prevSweep = game._renderPrevSweep == null ? game.sweep : game._renderPrevSweep;
  updateSweepDisplay(game.sweep, prevSweep, game.time, center, planes);
  game._renderPrevSweep = game.sweep;

  // Refresh cadence used for the fade curve.
  const radarLevel =
    (game.upgradeState && game.upgradeState.flags && game.upgradeState.flags.radarLevel) || 0;
  const period = sweepPeriod(radarLevel);

  for (const id of ids) {
    const t = world.getComponent(id, Components.Transform);
    const render = world.getComponent(id, Components.Render);
    const ac = world.getComponent(id, Components.Aircraft);
    const label = world.getComponent(id, Components.Label);
    const def = getAircraftDef(ac.kind);

    const warning = render.warning;
    const selected = game.selectedId === id;
    const important = selected || warning || !!(ac && ac.emergency);

    // Never-swept new spawns are not drawn until the beam first reaches them,
    // so the player genuinely acts on swept information. Important planes are
    // force-latched above and so are always `seen`.
    if (!render.seen) continue;

    // Displayed blip position/heading is the LAST-SWEPT value, not the live one.
    const dx = render.lastSweepX;
    const dy = render.lastSweepY;
    const dHeading = render.lastSweepHeading;

    // Fog/ILS alpha is evaluated at the displayed (last-swept) position so it
    // composes with the sweep gating rather than fighting it.
    const fogAlpha = aircraftFogAlpha(game.weather, game.map, dx, dy);
    if (fogAlpha <= 0.02) continue;

    // Sweep fade: full alpha right after a sweep, decaying toward a floor as the
    // blip ages over one refresh period. Important planes stay at full alpha.
    const age = game.time - render.lastSweptTime;
    let sweepAlpha = 1;
    if (!important && period > 0) {
      const frac = Math.max(0, Math.min(1, age / period));
      sweepAlpha = 1 - (1 - BLIP_FADE_FLOOR) * frac;
    }

    const alpha = fogAlpha * sweepAlpha;
    if (alpha <= 0.02) continue;

    // Short fading trail from the previous display toward the fresh blip, so a
    // just-refreshed target reads as "newly painted by the sweep".
    if (!important && age >= 0 && age < period * 0.5) {
      const trailFade = 1 - Math.max(0, Math.min(1, age / (period * 0.5)));
      for (let s = 1; s <= TRAIL_STEPS; s++) {
        const back = (s / (TRAIL_STEPS + 1)) * def.size * 1.5;
        const tx = dx - Math.cos(dHeading) * back;
        const ty = dy - Math.sin(dHeading) * back;
        ctx.save();
        ctx.globalAlpha = alpha * trailFade * (1 - s / (TRAIL_STEPS + 1)) * 0.5;
        ctx.fillStyle = render.color;
        ctx.beginPath();
        ctx.arc(tx, ty, Math.max(1, render.size * 0.3), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(dx, dy);

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

    // Icon oriented to heading (last-swept heading).
    ctx.save();
    ctx.rotate(dHeading);
    const color = warning && !blinkOn ? "#ff3b30" : render.color;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    def.drawShape(ctx, render.size);
    ctx.restore();

    // Label: callsign (follows the blip). A thin dark outline keeps it legible
    // over bright blips and the green sweep fade behind it.
    const cs = label ? label.callsign : "";
    if (cs) {
      ctx.font = '10px "Courier New", monospace';
      const lx = render.size + 4;
      const ly = -4;
      ctx.strokeStyle = "rgba(0,20,5,0.85)";
      ctx.lineWidth = 2.5;
      ctx.lineJoin = "round";
      ctx.strokeText(cs, lx, ly);
      ctx.fillStyle = warning ? "#ff6a60" : "rgba(220,255,210,0.95)";
      ctx.fillText(cs, lx, ly);
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
