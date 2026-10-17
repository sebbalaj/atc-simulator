# ATC Simulator

A fully browser-native, dependency-free 2D Air Traffic Control simulator. Built
for portrait-orientation mobile with touch-first controls using HTML5 Canvas 2D
and vanilla JavaScript ES modules. No frameworks, no bundler, no runtime CDNs.

## Running the game

ES modules cannot be loaded over `file://`, so the game must be served over
HTTP. From the project root:

```sh
python3 -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000) in a browser. You
should see a CRT-style radar grid with a rotating sweep and the ATC console
region along the bottom.

## Architecture

The project follows an **Entity-Component-System (ECS)** design with a strict
separation between pure logic and browser-coupled code:

- **Entities** are integer ids.
- **Components** are plain-data objects stored in typed maps keyed by component
  name.
- **Systems** are plain functions that query the world each tick.

A **fixed-timestep accumulator loop** (60 updates/second) drives the simulation,
decoupled from rendering, which runs via `requestAnimationFrame`.

Pure-logic modules (vector math, RNG, spline, spatial hash, event bus) have
**zero DOM/canvas dependencies**, so they are unit-testable under Node. Only the
bootstrap, rendering, and (later) input modules touch the browser; their
window/document access is guarded so the pure modules still import under Node.

## File layout

```
index.html            Entry point: radar canvas + ATC console DOM, module script
css/style.css         Portrait layout (radar 75% / console 25%), CRT aesthetic
src/
  main.js             Bootstrap, canvas sizing (DPR), fixed-timestep loop, radar render
  core/               Pure logic (no DOM)
    vec2.js           2D vector math
    rng.js            Seedable mulberry32 PRNG
    spline.js         Catmull-Rom spline + arc-length reparameterization
    spatialHash.js    Uniform-grid broad-phase spatial hash
    events.js         Tiny pub/sub EventBus
  ecs/
    world.js          ECS World (entities, components, queries)
    components.js     Component factories + name constants
test/
  core.test.js        node:test unit tests for the pure core modules
```

> Later features add aircraft, path-drawing input, economy, weather,
> emergencies, maps, the full ATC console UI, and synthesized Web Audio.

## Development & verification

No dependencies to install. Node 22 and Python 3.11 are expected.

- **Unit tests:** `npm test` (which runs `node --test`, discovering every
  `*.test.js` file). You can also run them explicitly with
  `node --test 'test/**/*.test.js'` or `node --test test/core.test.js`.
- **Syntax check:** run `node --check` on every `.js` file under `src/` and
  `test/`. For example:

  ```sh
  find src test -name '*.js' -exec node --check {} \;
  ```

- **Manual browser check:** serve with `python3 -m http.server 8000`, load the
  page, and confirm the radar grid renders with no console errors.
