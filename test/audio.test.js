// Unit tests for the synthesized audio engine (FEAT-006). These run under
// `node --test`, where there is no window / AudioContext. The engine must
// import and operate as a safe no-op in that environment (feature-detection),
// and still track its mute/volume/proximity/crowding state so wiring code can
// call it unconditionally.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createAudioEngine } from "../src/game/audio.js";
import { createEventBus } from "../src/core/events.js";

test("audio engine imports and reports unsupported under Node", () => {
  const audio = createAudioEngine();
  assert.equal(audio.supported, false, "no AudioContext in Node");
  assert.equal(audio.unlocked, false, "not unlocked before a gesture");
  // unlock() returns false (no API) but must not throw.
  assert.doesNotThrow(() => audio.unlock());
});

test("audio engine methods are safe no-ops without a context", () => {
  const audio = createAudioEngine();
  assert.doesNotThrow(() => {
    audio.playStaticClick();
    audio.playRoger();
    audio.playClearedToLand();
    audio.playAlarmBeep(0.5);
    audio.setProximity(0.8);
    audio.setCrowding(0.5);
    audio.setCrowdingFromCount(10);
    audio.update(1 / 60);
  });
});

test("mute toggle and volume setter update state", () => {
  const audio = createAudioEngine({ volume: 0.6, muted: false });
  assert.equal(audio.muted, false);
  assert.equal(audio.volume, 0.6);

  assert.equal(audio.toggleMute(), true, "toggles to muted");
  assert.equal(audio.muted, true);
  assert.equal(audio.toggleMute(), false, "toggles back");

  audio.setMuted(true);
  assert.equal(audio.muted, true);

  audio.setVolume(0.25);
  assert.equal(audio.volume, 0.25);
  // Volume clamps to [0, 1].
  audio.setVolume(5);
  assert.equal(audio.volume, 1);
  audio.setVolume(-1);
  assert.equal(audio.volume, 0);
});

test("proximity severity and crowding clamp into [0,1]", () => {
  const audio = createAudioEngine();
  audio.setProximity(2);
  assert.equal(audio._state.proximity.severity, 1, "severity clamps high");
  audio.setProximity(-3);
  assert.equal(audio._state.proximity.severity, 0, "severity clamps low");

  audio.setCrowding(2);
  assert.equal(audio._state.crowding, 1, "crowding clamps high");
  audio.setCrowdingFromCount(6, 12);
  assert.equal(audio._state.crowding, 0.5, "count/softCap maps to crowding");
  audio.setCrowdingFromCount(100, 12);
  assert.equal(audio._state.crowding, 1, "crowding caps at 1");
});

test("subscribe wires EventBus events and detaches cleanly", () => {
  const audio = createAudioEngine();
  const bus = createEventBus();
  const detach = audio.subscribe(bus);
  // Emitting known events must not throw (handlers are no-ops without a ctx).
  assert.doesNotThrow(() => {
    bus.emit("aircraft:spawn", { id: 1 });
    bus.emit("landing:cleared", { id: 1 });
    bus.emit("audio:roger", {});
    bus.emit("aircraft:selected", { id: 1 });
  });
  assert.doesNotThrow(() => detach());

  // subscribe tolerates a missing/invalid bus.
  assert.doesNotThrow(() => {
    const noop = audio.subscribe(null);
    noop();
  });
});
