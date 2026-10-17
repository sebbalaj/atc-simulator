// Fully synthesized audio engine (Web Audio API, no external assets/CDNs). All
// sounds are generated at runtime from oscillators and noise buffers:
//   - radio static click  on 'aircraft:spawn'
//   - synthesized voice    "Cleared to land" on 'landing:cleared',
//                          "Roger" on selection/acknowledge ('audio:roger')
//   - proximity alarm      beeps whose rate/pitch intensify as the closest
//                          separation shrinks (driven each tick via setProximity)
//   - ambient drone        a layered pad whose intensity scales with the live
//                          aircraft count (driven via setCrowding)
//
// Browser-autoplay policy: an AudioContext cannot start before a user gesture,
// so the context is created/resumed lazily on the first interaction (see
// unlock()). A mute/volume toggle gates a master gain node.
//
// DOM-guard discipline: the module feature-detects window + (webkit)AudioContext
// so importing it under Node (where neither exists) never throws. Every method
// is a safe no-op until a context is available, so wiring code can call them
// unconditionally.

/** Resolve an AudioContext constructor if the environment provides one. */
function getAudioContextCtor() {
  if (typeof window === "undefined") return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

/** Whether the SpeechSynthesis API is available (voice fallback). */
function hasSpeechSynthesis() {
  return (
    typeof window !== "undefined" &&
    typeof window.speechSynthesis !== "undefined" &&
    typeof window.SpeechSynthesisUtterance !== "undefined"
  );
}

/**
 * Create the audio engine. Pure construction: nothing is created in the audio
 * hardware until unlock() runs on a user gesture. Safe to construct under Node
 * (every call becomes a no-op because the AudioContext ctor is null).
 *
 * @param {object} [opts]
 * @param {number} [opts.volume] initial master volume 0..1 (default 0.6)
 * @param {boolean} [opts.muted] start muted (default false)
 * @param {boolean} [opts.useSpeech] prefer SpeechSynthesis for voice if present
 *   (default true; falls back to synthesized formants when unavailable)
 */
export function createAudioEngine(opts = {}) {
  const Ctor = getAudioContextCtor();
  const supported = !!Ctor;

  const state = {
    supported,
    ctx: null,
    master: null, // master gain (mute/volume)
    ambientGain: null, // ambient bed level (scaled by crowding)
    ambientNodes: null, // { oscA, oscB, lfo, lfoGain, noise, noiseGain }
    unlocked: false,
    muted: !!opts.muted,
    volume: clamp01(opts.volume ?? 0.6),
    useSpeech: opts.useSpeech !== false,
    // Proximity alarm scheduling.
    proximity: { severity: 0, nextBeepAt: 0 },
    crowding: 0, // 0..1 target ambient intensity
    _rafPump: null,
  };

  function clamp01(v) {
    if (!(v >= 0)) return 0;
    if (v > 1) return 1;
    return v;
  }

  /** Current context time, or 0 when there is no context. */
  function now() {
    return state.ctx ? state.ctx.currentTime : 0;
  }

  /**
   * Lazily create (and resume) the AudioContext. MUST be called from a user
   * gesture handler the first time so the browser allows playback. Idempotent
   * and a no-op where the API is unavailable (Node).
   */
  function unlock() {
    if (!supported) return false;
    if (!state.ctx) {
      try {
        state.ctx = new Ctor();
      } catch (_) {
        state.ctx = null;
        return false;
      }
      state.master = state.ctx.createGain();
      state.master.gain.value = state.muted ? 0 : state.volume;
      state.master.connect(state.ctx.destination);
      startAmbient();
    }
    // Resume if the context started suspended (common before a gesture).
    if (state.ctx.state === "suspended" && state.ctx.resume) {
      state.ctx.resume().catch(() => {});
    }
    state.unlocked = true;
    return true;
  }

  /** Apply the current mute/volume to the master gain. */
  function applyMasterGain() {
    if (!state.master || !state.ctx) return;
    const target = state.muted ? 0 : state.volume;
    const g = state.master.gain;
    g.cancelScheduledValues(now());
    g.setTargetAtTime(target, now(), 0.02);
  }

  /** Toggle mute and return the new muted flag. */
  function toggleMute() {
    state.muted = !state.muted;
    applyMasterGain();
    return state.muted;
  }

  /** Set mute explicitly. */
  function setMuted(m) {
    state.muted = !!m;
    applyMasterGain();
    return state.muted;
  }

  /** Set master volume 0..1. */
  function setVolume(v) {
    state.volume = clamp01(v);
    applyMasterGain();
    return state.volume;
  }

  // --- Noise ---------------------------------------------------------------

  /** Build a short white-noise buffer (cached) for static/formant sources. */
  let _noiseBuffer = null;
  function noiseBuffer() {
    if (!state.ctx) return null;
    if (_noiseBuffer) return _noiseBuffer;
    const len = Math.floor(state.ctx.sampleRate * 1.0);
    const buf = state.ctx.createBuffer(1, len, state.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    _noiseBuffer = buf;
    return buf;
  }

  // --- Spawn: radio static click ------------------------------------------

  /**
   * A short burst of band-passed static with a click transient — the "radio
   * keyed" sound when a new contact appears.
   */
  function playStaticClick() {
    if (!state.ctx || !state.master) return;
    const t0 = now();
    const buf = noiseBuffer();
    if (!buf) return;

    const src = state.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const band = state.ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 1800;
    band.Q.value = 0.8;

    const g = state.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);

    src.connect(band).connect(g).connect(state.master);
    src.start(t0);
    src.stop(t0 + 0.14);
  }

  // --- Voice: synthesized acknowledgments ----------------------------------

  /**
   * Speak a short phrase. Prefers SpeechSynthesis when available (and allowed)
   * for intelligible words; otherwise synthesizes a radio-style formant "word"
   * so the acknowledgment is still audible on every platform.
   */
  function speak(phrase) {
    if (state.muted) return;
    if (state.useSpeech && hasSpeechSynthesis()) {
      try {
        const u = new window.SpeechSynthesisUtterance(phrase);
        u.volume = state.volume;
        u.rate = 1.05;
        u.pitch = 0.9;
        window.speechSynthesis.speak(u);
        return;
      } catch (_) {
        /* fall through to synthesized formants */
      }
    }
    synthVoice(phrase);
  }

  /**
   * Synthesize a short "radio voice" burst: a couple of formant tones under a
   * noise bed, chopped into syllables so it reads as a spoken acknowledgment
   * even without SpeechSynthesis. The syllable count scales with phrase length.
   */
  function synthVoice(phrase) {
    if (!state.ctx || !state.master) return;
    const t0 = now();
    const words = String(phrase || "").trim().split(/\s+/).filter(Boolean);
    const syllables = Math.max(2, Math.min(6, words.length + 2));
    const syllDur = 0.13;

    // Shared radio band so it sounds like it comes over the frequency.
    const radio = state.ctx.createBiquadFilter();
    radio.type = "bandpass";
    radio.frequency.value = 1500;
    radio.Q.value = 1.2;
    radio.connect(state.master);

    for (let i = 0; i < syllables; i++) {
      const start = t0 + i * (syllDur + 0.03);
      // Two formants give a vowel-like timbre; vary pitch per syllable.
      const base = 150 + (i % 3) * 40;
      const f1 = state.ctx.createOscillator();
      f1.type = "sawtooth";
      f1.frequency.setValueAtTime(base, start);
      const f2 = state.ctx.createOscillator();
      f2.type = "triangle";
      f2.frequency.setValueAtTime(base * 2.4, start);

      const g = state.ctx.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + syllDur);

      f1.connect(g);
      f2.connect(g);
      g.connect(radio);
      f1.start(start);
      f2.start(start);
      f1.stop(start + syllDur + 0.02);
      f2.stop(start + syllDur + 0.02);
    }
  }

  function playRoger() {
    speak("Roger");
  }
  function playClearedToLand() {
    speak("Cleared to land");
  }

  // --- Proximity alarm ------------------------------------------------------

  /**
   * Update the proximity alarm severity (0 = clear, 1 = imminent collision).
   * The pump schedules beeps whose rate and pitch rise with severity. Typically
   * fed from game.closestSeparation vs an alarm threshold each tick.
   */
  function setProximity(severity) {
    state.proximity.severity = clamp01(severity);
  }

  /** Emit one alarm beep at a pitch scaled by severity. */
  function playAlarmBeep(severity) {
    if (!state.ctx || !state.master) return;
    const t0 = now();
    const osc = state.ctx.createOscillator();
    osc.type = "square";
    const freq = 440 + severity * 660; // 440 -> 1100 Hz as danger rises
    osc.frequency.setValueAtTime(freq, t0);

    const g = state.ctx.createGain();
    const peak = 0.05 + severity * 0.18;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);

    osc.connect(g).connect(state.master);
    osc.start(t0);
    osc.stop(t0 + 0.1);
  }

  // --- Ambient soundscape ---------------------------------------------------

  /** Build the persistent ambient bed (runs for the life of the context). */
  function startAmbient() {
    if (!state.ctx || !state.master || state.ambientNodes) return;
    const ctx = state.ctx;

    const bed = ctx.createGain();
    bed.gain.value = 0; // scaled by crowding via setCrowding()
    bed.connect(state.master);
    state.ambientGain = bed;

    // Two detuned low oscillators form a slow, tense drone.
    const oscA = ctx.createOscillator();
    oscA.type = "sine";
    oscA.frequency.value = 55;
    const oscB = ctx.createOscillator();
    oscB.type = "sine";
    oscB.frequency.value = 55 * 1.5 + 1.2; // slightly detuned fifth

    // A slow LFO shimmers the drone amplitude for unease.
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.12;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.25;
    lfo.connect(lfoGain);

    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.5;
    lfoGain.connect(droneGain.gain);
    oscA.connect(droneGain);
    oscB.connect(droneGain);
    droneGain.connect(bed);

    // A faint filtered-noise "wind" layer under the drone.
    const buf = noiseBuffer();
    let noise = null;
    let noiseGain = null;
    if (buf) {
      noise = ctx.createBufferSource();
      noise.buffer = buf;
      noise.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 420;
      noiseGain = ctx.createGain();
      noiseGain.gain.value = 0.12;
      noise.connect(lp).connect(noiseGain).connect(bed);
      noise.start();
    }

    oscA.start();
    oscB.start();
    lfo.start();

    state.ambientNodes = { oscA, oscB, lfo, lfoGain, droneGain, noise, noiseGain };
  }

  /**
   * Set the crowding level 0..1 (e.g. aircraftCount / softCap). Raises the
   * ambient bed level and nudges the drone pitch up so the soundscape builds
   * tension as the airspace fills. Safe no-op without a context.
   */
  function setCrowding(level) {
    state.crowding = clamp01(level);
    if (!state.ctx || !state.ambientGain) return;
    const target = 0.04 + state.crowding * 0.5;
    state.ambientGain.gain.setTargetAtTime(target, now(), 0.6);
    const nodes = state.ambientNodes;
    if (nodes && nodes.oscA && nodes.oscB) {
      const base = 55 + state.crowding * 18;
      nodes.oscA.frequency.setTargetAtTime(base, now(), 0.8);
      nodes.oscB.frequency.setTargetAtTime(base * 1.5 + 1.2, now(), 0.8);
    }
  }

  /**
   * Convert an aircraft count into a crowding 0..1 using a soft cap, then apply
   * it. A convenience for the game loop which knows the live plane count.
   */
  function setCrowdingFromCount(count, softCap = 12) {
    const n = Math.max(0, count || 0);
    setCrowding(Math.min(1, n / Math.max(1, softCap)));
  }

  /**
   * Advance the audio engine by dt seconds. Drives the proximity alarm beeping
   * (rate scales with severity). Called each frame from the game loop; a no-op
   * without a context so it is safe to call unconditionally.
   */
  function update(dt) {
    if (!state.ctx || !state.master) return;
    const sev = state.proximity.severity;
    if (sev > 0.001 && !state.muted) {
      const t = now();
      if (t >= state.proximity.nextBeepAt) {
        playAlarmBeep(sev);
        // Interval shrinks from ~0.6s (mild) to ~0.12s (imminent).
        const interval = 0.6 - 0.48 * sev;
        state.proximity.nextBeepAt = t + interval;
      }
    } else {
      // Keep the next beep ready so a new breach beeps immediately.
      state.proximity.nextBeepAt = now();
    }
  }

  /**
   * Subscribe the engine to a game's EventBus. Wires spawn/landing/selection/
   * proximity/crowding to the synthesized sounds. Returns a detach function.
   * Does not require a context — callers unlock() on the first gesture; before
   * that every handler is a cheap no-op.
   *
   * @param {object} bus the EventBus (on/off/emit)
   */
  function subscribe(bus) {
    if (!bus || typeof bus.on !== "function") return () => {};
    const unsub = [];
    unsub.push(bus.on("aircraft:spawn", () => playStaticClick()));
    unsub.push(bus.on("landing:cleared", () => playClearedToLand()));
    // A dedicated acknowledge event so selection/clearance can say "Roger".
    unsub.push(bus.on("audio:roger", () => playRoger()));
    // Allow other modules to trigger a generic acknowledge on selection.
    unsub.push(bus.on("aircraft:selected", () => playRoger()));
    return () => {
      for (const u of unsub) u();
      unsub.length = 0;
    };
  }

  return {
    get supported() {
      return state.supported;
    },
    get unlocked() {
      return state.unlocked;
    },
    get muted() {
      return state.muted;
    },
    get volume() {
      return state.volume;
    },
    unlock,
    toggleMute,
    setMuted,
    setVolume,
    subscribe,
    update,
    setProximity,
    setCrowding,
    setCrowdingFromCount,
    // Direct sound triggers (used by the console UI / tests).
    playStaticClick,
    playRoger,
    playClearedToLand,
    playAlarmBeep,
    // Exposed for testing/inspection.
    _state: state,
  };
}
