# ATC Simulator

A fully browser-native, dependency-free 2D Air Traffic Control simulator. Built
for portrait-orientation mobile with touch-first controls using HTML5 Canvas 2D,
the Web Audio API, and vanilla JavaScript ES modules. No frameworks, no bundler,
no runtime CDNs, no external assets — every pixel is drawn procedurally and every
sound is synthesized at runtime.

You are the controller: draw flight paths on the radar to guide inbound aircraft
to the correct runway (or helipad), keep them separated, handle weather and
emergencies, earn revenue, and survive the shift without getting fired.

## Running the game

ES modules cannot be loaded over `file://`, so the game must be served over
HTTP. From the project root:

```sh
python3 -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000) in a browser. You start
at the main menu / map select; pick a map to begin a shift. Audio starts only
after your first tap/click/keypress (browser autoplay policy).

> Serving over a static HTTP server is required — opening `index.html` directly
> as a `file://` URL will fail because the browser blocks ES-module imports from
> the filesystem.

## Play with no server

Don't want to run a server? Use **`standalone.html`** at the repo root. It is a
single self-contained file that bundles the HTML, all CSS, and every JavaScript
module inline, so it plays directly from the local filesystem with **no server,
no hosting, and no network access**:

1. Download/save `standalone.html`.
2. Open it directly in any browser — double-tap/open the file (a `file://` URL).
   This works on desktop and on mobile (save the file, then open it from your
   browser or files app).
3. Pick a map and play. As always, audio unlocks on your first tap (browser
   autoplay policy).

`standalone.html` is a generated artifact — it behaves identically to the
modular `index.html` + `src/` version. Do not edit it by hand; edit the source
under `src/` and regenerate with:

```sh
npm run bundle      # or: node scripts/bundle.mjs
```

## Controls

- **Draw a route:** press (touch or mouse) on an aircraft and drag to trace a
  path. Release to commit. Selecting a plane plays a "Roger" acknowledgment.
- **Clear to land:** end the drawn path inside a runway's green approach cone,
  tracking the runway heading, and the route snaps onto the centerline and locks
  (shown in amber). Helicopters land on the helipad from any heading.
- **Hold:** end a route near the hold fix to put the plane into a circular
  holding orbit (it keeps burning fuel until you re-route it).
- **`m`:** toggle mute. **`d`:** toggle the on-screen FPS / plane-count debug
  readout. The console also has a mute button and a volume slider.

## Architecture

The project follows an **Entity-Component-System (ECS)** design with a strict
separation between pure logic and browser-coupled code:

- **Entities** are integer ids.
- **Components** are plain-data objects stored in typed maps keyed by component
  name (`Transform`, `Velocity`, `Aircraft`, `Path`, `Hitbox`, `Render`,
  `Fuel`, `Label`).
- **Systems** are plain functions that query the world each tick. The
  authoritative per-tick order is:
  `spawn -> weather -> emergency -> movement -> landing -> collision`,
  with rendering handled separately in the animation-frame callback.

A **fixed-timestep accumulator loop** (60 updates/second) drives the simulation,
decoupled from rendering, which runs via `requestAnimationFrame`. Large frame
gaps are clamped so the loop never spirals.

**Pure core + domain modules** (vector math, RNG, spline, spatial hash, event
bus, economy, reputation, clock, weather, emergencies, maps, aircraft defs) have
**zero DOM/canvas dependencies**, so they are unit-testable under Node and
drivable by the headless smoke test. Only the bootstrap, rendering, input,
console, screens, and audio modules touch the browser; their window/document/
AudioContext access is feature-detected and guarded so the pure modules still
import under Node.

**Performance.** Collision detection is broad-phased through a uniform-grid
spatial hash (`src/core/spatialHash.js`): each tick the aircraft are bucketed
and only candidates in overlapping cells get an exact pairwise distance test, so
the pass is effectively **O(n)** rather than O(n²) — this is what keeps Map 4
(four parallel runways, ~40% more traffic, strict wake separation) smooth at
the 60 FPS target. The spline arc-length polyline for each flight path is cached
and only rebuilt when the control points change. Press `d` in-game for a live
FPS + plane-count readout.

**Audio.** `src/game/audio.js` is a fully synthesized Web Audio engine (no audio
files). It lazily creates/resumes a single `AudioContext` on the first user
gesture, routes everything through a master gain for mute/volume, and subscribes
to the EventBus:

- `aircraft:spawn` → a band-passed **radio static click**.
- `landing:cleared` → a **"Cleared to land"** voice callout.
- `aircraft:selected` / `audio:roger` → a **"Roger"** acknowledgment.
- Voice uses the `SpeechSynthesis` API when available (guarded), otherwise
  synthesized oscillator/noise **formant syllables** so it works everywhere.
- A **proximity alarm** beeps with a rate and pitch that intensify as the
  closest separation shrinks (driven from `game.closestSeparation`).
- A layered **ambient drone** whose level and pitch rise with the live aircraft
  count (crowding), building tension as the airspace fills.

The module feature-detects `window`/`AudioContext`, so it imports under Node
without throwing and every method is a safe no-op until a context exists.

## File layout

```
index.html              Entry point: radar canvas + ATC console DOM, module script
css/style.css           Portrait layout (radar 75% / console 25%), CRT aesthetic
src/
  main.js               Bootstrap, canvas sizing (DPR), fixed-timestep loop,
                        system wiring, audio unlock, FPS/plane-count debug readout
  core/                 Pure logic (no DOM)
    vec2.js             2D vector math
    rng.js              Seedable mulberry32 PRNG (deterministic shifts)
    spline.js           Catmull-Rom spline + arc-length reparameterization
    spatialHash.js      Uniform-grid broad-phase spatial hash (O(n) collisions)
    events.js           Tiny synchronous pub/sub EventBus
  ecs/
    world.js            ECS World (entities, components, queries)
    components.js       Component factories + name constants
    systems/
      spawnSystem.js        Perimeter spawn stream (ramping rate, seeded RNG)
      weatherSystem.js      Wind shifts, storm cells, fog; applies to aircraft
      emergencySystem.js    Mayday / medical-evac / fuel emergencies
      movementSystem.js     Spline path-following, fuel burn, holding/excess hold
      landingSystem.js      Approach clearance, runway rollout, 'landing:cleared'
      collisionSystem.js    Spatial-hash proximity + crash detection (pure core)
      renderSystem.js       Canvas 2D radar, airport, aircraft, HUD overlays
  game/                 Domain logic (pure unless noted)
    aircraft.js         Four aircraft classes + balance table + procedural icons
    airport.js          Runway/helipad geometry, approach cones, Map 1 definition
    maps.js             Registry of all four maps + moving-runway update
    pathUtils.js        Spline sampling + turn-angle validate/clamp per class
    spline helpers      (via core/spline.js)
    economy.js          Landing revenue model + Bank
    reputation.js       Reputation model + penalty table
    clock.js            Shift clock (06:00 -> 14:00 compressed)
    progression.js      Shift stats, end-of-shift summary, map unlock gating
    upgrades.js         Between-shift upgrade catalog + purchase/apply
    weather.js          Wind/storm/fog geometry + controller
    emergencies.js      Emergency decision logic + controller
    fuel.js             Fuel drain model
    audio.js            Synthesized Web Audio engine (feature-detected)
  ui/                   Browser-coupled view/controllers
    input.js            Pointer path-drawing + runway snap (pure snap exported)
    console.js          Bottom console: clock/bank/reputation/strips + audio ctrl
    flightStrips.js     Flight-strip list
    hud.js              On-canvas overlays (fuel gauges, alarm, banners, weather)
    screens.js          Menu / map select / summary / shop / game over
scripts/
  smoke.mjs             Headless simulation smoke test (no browser)
  verify.sh             Run-all: node --check + node --test + smoke
test/
  core.test.js          Pure core modules (vec2, rng, spline, spatial hash, bus)
  sim.test.js           Movement/collision/wake/alignment/turn-angle geometry
  economy.test.js       Revenue + Bank + efficiency curve
  events.test.js        Weather + emergencies logic
  progression.test.js   Shift stats, summary, bonuses, map unlocks
  audio.test.js         Audio engine feature-detection + mute/volume/state
  landingCleared.test.js  'landing:cleared' emitted once on commit (via the ECS)
```

## The four maps

| Map | Name | Layout & rules |
| --- | --- | --- |
| 1 | **Regional Airfield** | Two intersecting runways plus a helipad and a hospital POI. The gentle introduction. |
| 2 | **Twin Cities** | Two separate airports — a long-runway field to the north (jets) and a short strip to the south (props/light) — whose approach corridors overlap, so routes must weave between the two patterns. |
| 3 | **Coastal Hub** | A long inland international runway, an **aircraft carrier that is a moving runway** steaming back and forth (its approach cone and rollout track the deck), and offshore oil-rig helipads over the water. |
| 4 | **Mega Hub** | Four parallel runways, a busier spawn stream (~40% more traffic), and **strict wake-turbulence separation** — a larger bubble is enforced behind every COMMERCIAL leader (`rules.wakeMultiplier`). The performance stress case. |

Aircraft classes: **Light** (slow, nimble, short runway), **Commercial** (fast,
wide turns, long runway, emits wake turbulence), **Helicopter** (slowest, lands
on the helipad from any heading), **Supersonic** (fastest, tiny fuel margin, cannot
make sharp turns).

## Economy, upgrades, and events

**Economy.** Each landing pays `(base_fee[kind] + passengers * per_passenger[kind])`
scaled by an **efficiency multiplier** (1.5× for a quick landing, decaying toward
0.8× the longer a plane loiters in the airspace). Revenue accrues to the Bank,
which persists across shifts and funds upgrades.

**Reputation.** Starts at 100 and depletes on mistakes — near-miss (−8), excessive
hold (−6), storm loss (−20), fuel-out (−25), mid-air collision (−100). Clean
landings recover a little. Reputation at zero = **you're fired** (game over). A
mid-air collision ends the shift immediately.

**Shifts & progression.** A shift is one play of a map on the compressed 06:00 →
14:00 clock. Surviving a shift and meeting the revenue target pays a bonus and
unlocks the next map. Each handled emergency adds to the bonus. The end-of-shift
summary totals landings, revenue, target, bonus, emergencies handled, crashes,
and final reputation.

**Upgrade shop** (between shifts): Extend Radar Range, Build/Lengthen Runway,
Build Helipad, Install **ILS** (land in fog), Automated Holding Patterns, Hire
Ground Crew (faster runway turnaround).

**Dynamic events.**
- *Weather* — **wind shifts** reverse which approach direction is legal;
  **thunderstorm cells** drift across the field (flying into one is fatal; a
  route through one gets scrubbed so you must re-route); **fog** cuts visibility
  (unless ILS is owned).
- *Emergencies* — **mayday** (engine failure: faster, priority, red-flashing,
  wants a straight shot to a runway); **medical evac** (a helicopter that must
  overfly the hospital POI before it can land); **fuel emergency** (a plane held
  too long drops into a critical-fuel state and will crash at empty).

## Development & verification

No dependencies to install. Node 22 and Python 3.11 are expected.

- **Run everything (recommended):**

  ```sh
  npm run verify      # node --check on all JS + node --test + smoke test
  ```

- **Unit tests:** `npm test` (runs `node --test 'test/**/*.test.js'`). You can
  also target one file, e.g. `node --test test/sim.test.js`.

  > On Node 22.x use the glob form (`node --test 'test/**/*.test.js'`) or
  > `npm test`; a bare `node --test test/` can fail on some 22.x builds.

- **Headless simulation smoke test:** `npm run smoke` (or
  `node scripts/smoke.mjs`). It imports the pure/sim modules, drives several
  hundred fixed-timestep ticks with a seeded RNG, and asserts that aircraft
  spawn, move, and land; that the economy and reputation update; that a forced
  proximity pair and a crash are detected; and that the audio module and all
  four maps run clean. Exits non-zero on any failure.

- **Syntax check:** `node --check` on every `.js` under `src/` and `test/`
  (covered by `npm run verify`). For example:

  ```sh
  find src test -name '*.js' -exec node --check {} \;
  ```

- **Manual browser check:** serve with `python3 -m http.server 8000`, load the
  page, confirm the radar renders and the loop runs at ~60 FPS (press `d`),
  reach gameplay on each map with no console errors, and — after a tap — hear the
  spawn clicks, the "Cleared to land" / "Roger" callouts, the proximity alarm
  intensifying with danger, and the ambient bed building with traffic. Toggle
  mute from the console or with `m`.

## Spec coverage

Design-doc sections and their implementation status:

**Fully implemented**
- Core radar UI (CRT scope, sweep, range rings), portrait layout, touch/mouse
  path-drawing with runway/helipad snap and approach cones.
- ECS architecture, fixed-timestep loop, DPR-scaled canvas, pure/testable core.
- Four aircraft classes with distinct speed/turn/fuel/runway-length behavior and
  procedural icons; wake turbulence behind commercial jets.
- Spawning (ramping, seeded), movement along splines with turn-angle limits,
  fuel burn + holding patterns + excessive-hold penalty.
- Landing clearance, runway occupancy/clear-time, moving-runway (carrier)
  rollout, `landing:cleared` event.
- Spatial-hash collision/proximity detection with near-miss and crash handling.
- Economy (revenue + efficiency + Bank), reputation + firing, shift clock,
  progression/summary, full upgrade shop.
- Weather (wind shifts, drifting storms, fog + ILS) and emergencies (mayday,
  medical evac, fuel) with HUD overlays.
- All four maps with their distinct layouts and rules.
- Fully synthesized Web Audio (spawn clicks, voice callouts, proximity alarm,
  crowding ambient), mute/volume control, gesture-gated unlock.
- FPS / plane-count debug readout; headless smoke test; run-all verify script.

**Partially implemented / simplified**
- **Voice callouts** are either `SpeechSynthesis` (when the platform provides it)
  or synthesized formant syllables as a fallback — not a recorded/scripted
  phraseology set; only "Roger" and "Cleared to land" are spoken.
- **Automated Holding Patterns** upgrade sets a flag but auto-management of
  orbits is minimal; holding is primarily manual.
- **Persistence** (career save/load across browser sessions) is not implemented;
  progression lives in memory for the session.
- **Automated browser/audio testing** — rendering and audio are verified by
  `node --check`, the headless smoke test, and a DOM-mock boot check; true
  in-browser audio and frame-rate confirmation remain a manual step (no headless
  Canvas/WebAudio/Chrome harness is set up in this environment).
```
