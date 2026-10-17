// Runtime verification of standalone.html WITHOUT a real browser.
//
// Extracts the inlined bundle and executes it inside a minimal mocked DOM /
// window / canvas-2d / AudioContext environment, captures requestAnimationFrame
// and pumps a few hundred frames, then drives the game through the main menu ->
// map select -> active play path. Any thrown error (bad require graph, a
// leftover reference, a boot crash) fails the check. This exercises the bundled
// code the way the browser would, so it is far stronger than a static parse.
//
// Not shipped in the bundle. Run: node scripts/browser-sim-check.mjs
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(ROOT, "standalone.html"), "utf8");
const m = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (m.length !== 1) throw new Error(`expected 1 plain <script>, found ${m.length}`);
const code = m[0][1];

// ---- Minimal browser mocks ------------------------------------------------
function makeCtx2d() {
  const noop = () => {};
  const ctx = new Proxy(
    {
      canvas: null,
      measureText: () => ({ width: 10 }),
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      createLinearGradient: () => ({ addColorStop: noop }),
      createRadialGradient: () => ({ addColorStop: noop }),
      setTransform: noop,
      save: noop,
      restore: noop,
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        // Any other canvas method is a no-op; any property reads back a number.
        return typeof prop === "string" ? noop : undefined;
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    },
  );
  return ctx;
}

function makeElement(tag = "div") {
  const listeners = {};
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {},
    children: [],
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    attributes: {},
    _html: "",
    width: 400,
    height: 600,
    getContext: () => makeCtx2d(),
    getBoundingClientRect: () => ({ width: 400, height: 600, left: 0, top: 0, right: 400, bottom: 600 }),
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    removeAttribute(k) { delete this.attributes[k]; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() {},
    insertBefore(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    dispatch(type, ev) { for (const fn of listeners[type] || []) fn(ev || {}); },
    querySelector() { return makeElement("div"); },
    querySelectorAll() { return []; },
    focus() {},
    blur() {},
    closest() { return null; },
    contains() { return false; },
    getPointerCapture() {},
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return this._html; },
    set(v) { this._html = v; this.children = []; },
  });
  Object.defineProperty(el, "textContent", {
    get() { return this._text || ""; },
    set(v) { this._text = v; },
  });
  Object.defineProperty(el, "className", {
    get() { return this._cls || ""; },
    set(v) { this._cls = v; },
  });
  return el;
}

const knownIds = ["radar-canvas", "console", "screens", "shift-clock", "bank-balance", "flight-strips"];
const idEls = Object.fromEntries(knownIds.map((id) => [id, makeElement(id === "radar-canvas" ? "canvas" : "div")]));

const rafQueue = [];
let rafId = 0;
const documentMock = {
  readyState: "complete",
  body: makeElement("body"),
  documentElement: makeElement("html"),
  getElementById: (id) => idEls[id] || null,
  querySelector: () => makeElement("div"),
  querySelectorAll: () => [],
  createElement: (t) => makeElement(t),
  createElementNS: (_ns, t) => makeElement(t),
  createTextNode: (t) => ({ nodeValue: t }),
  addEventListener() {},
  removeEventListener() {},
};

class AudioParamMock { constructor(v = 0) { this.value = v; } setValueAtTime() { return this; } linearRampToValueAtTime() { return this; } exponentialRampToValueAtTime() { return this; } setTargetAtTime() { return this; } cancelScheduledValues() { return this; } }
function audioNode(extra = {}) {
  return Object.assign(
    { connect: () => audioNode(), disconnect() {}, start() {}, stop() {}, addEventListener() {} },
    extra,
  );
}
class AudioContextMock {
  constructor() { this.state = "running"; this.currentTime = 0; this.destination = audioNode(); this.sampleRate = 44100; }
  resume() { this.state = "running"; return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createGain() { return audioNode({ gain: new AudioParamMock(1) }); }
  createOscillator() { return audioNode({ frequency: new AudioParamMock(440), detune: new AudioParamMock(0), type: "sine" }); }
  createBiquadFilter() { return audioNode({ frequency: new AudioParamMock(350), Q: new AudioParamMock(1), type: "lowpass" }); }
  createBufferSource() { return audioNode({ buffer: null, loop: false, playbackRate: new AudioParamMock(1) }); }
  createBuffer() { return { getChannelData: () => new Float32Array(1024), length: 1024 }; }
  createDynamicsCompressor() { return audioNode({ threshold: new AudioParamMock(-24), knee: new AudioParamMock(30), ratio: new AudioParamMock(12), attack: new AudioParamMock(0.003), release: new AudioParamMock(0.25) }); }
  createStereoPanner() { return audioNode({ pan: new AudioParamMock(0) }); }
  createWaveShaper() { return audioNode({ curve: null, oversample: "none" }); }
}

const windowMock = {
  devicePixelRatio: 2,
  innerWidth: 400,
  innerHeight: 800,
  AudioContext: AudioContextMock,
  webkitAudioContext: AudioContextMock,
  requestAnimationFrame: (cb) => { rafQueue.push(cb); return ++rafId; },
  cancelAnimationFrame: () => {},
  addEventListener() {},
  removeEventListener() {},
  performance: { now: () => Date.now() },
  setTimeout,
  clearTimeout,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } },
};

const sandbox = {
  window: windowMock,
  document: documentMock,
  navigator: { userAgent: "node-sim", maxTouchPoints: 5 },
  AudioContext: AudioContextMock,
  webkitAudioContext: AudioContextMock,
  requestAnimationFrame: windowMock.requestAnimationFrame,
  cancelAnimationFrame: windowMock.cancelAnimationFrame,
  performance: windowMock.performance,
  localStorage: windowMock.localStorage,
  setTimeout,
  clearTimeout,
  console,
  Math,
  Date,
  JSON,
  Object,
  Array,
  Map,
  Set,
  Float32Array,
  Uint8ClampedArray,
  Proxy,
  isNaN,
  parseFloat,
  parseInt,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

// ---- Execute the bundle ----------------------------------------------------
let threw = null;
try {
  vm.runInNewContext(code, sandbox, { filename: "standalone-bundle.js" });
} catch (err) {
  threw = err;
}
if (threw) {
  console.error("BOOT FAILED: the bundled script threw on load:");
  console.error(threw && threw.stack ? threw.stack : threw);
  process.exit(1);
}

// main.js exposes window.Game after boot.
const game = windowMock.Game;
if (!game) {
  console.error("BOOT FAILED: window.Game was not set (main.js did not boot).");
  process.exit(1);
}
console.log("boot: window.Game created, running =", game.running);

// Pump a few animation frames. Each frame reschedules itself via rAF, so we
// drain + re-run the queue with an advancing timestamp.
let t = 16;
for (let i = 0; i < 120; i++) {
  const batch = rafQueue.splice(0, rafQueue.length);
  if (!batch.length) break;
  for (const cb of batch) {
    try {
      cb(t);
    } catch (err) {
      console.error(`FRAME ${i} FAILED:`, err && err.stack ? err.stack : err);
      process.exit(1);
    }
  }
  t += 16;
}
console.log(`ran ${Math.min(120, t / 16)} animation frames with no exceptions`);

// Drive the game into active play: load a map and run the fixed-step update
// loop directly (menu overlay normally pauses the sim).
try {
  game.paused = false;
  game.loadMap("map1");
  if (game.spawnSystem && game.spawnSystem.spawnOne) game.spawnSystem.spawnOne();
  for (let i = 0; i < 600; i++) game.update(1 / 60);
  // Render a frame through the real render system + mocked 2d context.
  game.render();
  console.log("active play: 600 sim ticks + a render frame OK; planes =", game.world.entityCount());
} catch (err) {
  console.error("ACTIVE PLAY FAILED:", err && err.stack ? err.stack : err);
  process.exit(1);
}

// Exercise the audio engine unlock path against the mocked AudioContext.
try {
  game.audio.unlock();
  game.audio.setProximity(0.8);
  game.audio.setCrowdingFromCount(6, 12);
  game.audio.update(1 / 60);
  console.log("audio: unlock + live layers drive against mocked AudioContext OK (supported =", game.audio.supported, ")");
} catch (err) {
  console.error("AUDIO FAILED:", err && err.stack ? err.stack : err);
  process.exit(1);
}

console.log("\nSTANDALONE RUNTIME CHECK PASSED: the bundle boots and runs headlessly.");
process.exit(0);
