// Bundles the modular ES-module app (index.html + css/style.css + src/**/*.js)
// into a single self-contained standalone.html that runs directly from the
// local filesystem (file://) with no server and no network access.
//
// Strategy (robust, collision-free): each src module is wrapped in its own
// function scope and registered in a tiny synchronous CommonJS-style module
// registry. ES `import`/`export` statements are rewritten to `require(...)`
// calls and assignments onto a per-module `exports` object. Because every
// module keeps its own scope, there is ZERO risk of top-level identifier
// collisions between modules, and re-exports (export { X } where X was
// imported) work exactly as under native ESM.
//
// Only named imports/exports are used by this codebase (verified: no default
// exports, no `export ... from`, no dynamic import(), no `import * as`), so the
// rewriter below only needs to handle the named forms.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC = resolve(ROOT, "src");

// Deterministic module order: load leaf/core modules first and main.js last.
// (The registry is lazy via require(), so order only affects readability and a
// stable, dependency-respecting layout; main.js must come last because it is
// the entry that kicks off the app.)
const ORDER = [
  "src/core/vec2.js",
  "src/core/rng.js",
  "src/core/spline.js",
  "src/core/spatialHash.js",
  "src/core/events.js",
  "src/ecs/components.js",
  "src/game/aircraft.js",
  "src/game/airport.js",
  "src/game/pathUtils.js",
  "src/game/weather.js",
  "src/game/emergencies.js",
  "src/game/fuel.js",
  "src/game/economy.js",
  "src/game/reputation.js",
  "src/game/clock.js",
  "src/game/maps.js",
  "src/game/upgrades.js",
  "src/game/progression.js",
  "src/game/audio.js",
  "src/ecs/world.js",
  "src/ecs/systems/spawnSystem.js",
  "src/ecs/systems/weatherSystem.js",
  "src/ecs/systems/emergencySystem.js",
  "src/ecs/systems/movementSystem.js",
  "src/ecs/systems/landingSystem.js",
  "src/ecs/systems/collisionSystem.js",
  "src/ecs/systems/renderSystem.js",
  "src/ui/hud.js",
  "src/ui/flightStrips.js",
  "src/ui/console.js",
  "src/ui/screens.js",
  "src/ui/input.js",
  "src/main.js",
];

/** Normalize a module id to a repo-root-relative key, e.g. "src/core/vec2.js". */
function keyFor(absPath) {
  return relative(ROOT, absPath).split("\\").join("/");
}

/**
 * Rewrite one module's source so it can run inside
 *   registry[key] = function (exports, require) { ...body... };
 *
 * - `import { a, b as c } from "./x.js"` -> `const { a, b: c } = require("<resolvedKey>");`
 * - `export function f(...)`             -> `function f(...) ...` + `exports.f = f;`
 * - `export const X = ...`               -> `const X = ...` + `exports.X = X;`
 * - `export { a, b }`                    -> `exports.a = a; exports.b = b;`
 */
function transform(absPath, source) {
  const moduleDir = dirname(absPath);
  const exportNames = [];
  const lines = source.split("\n");
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const trimmed = line.trimStart();

    // --- imports (possibly multi-line) ---
    if (/^import[\s{]/.test(trimmed)) {
      // Accumulate until we hit the closing `from "...";` or `";`.
      let stmt = line;
      while (!/from\s+["'][^"']+["']\s*;?\s*$/.test(stmt.trim()) && i + 1 < lines.length) {
        i++;
        stmt += "\n" + lines[i];
      }
      const m = stmt.match(/^import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']\s*;?\s*$/);
      if (!m) {
        throw new Error(`Unhandled import form in ${keyFor(absPath)}:\n${stmt}`);
      }
      const specifiers = m[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const parts = s.split(/\s+as\s+/);
          return parts.length === 2 ? `${parts[0]}: ${parts[1]}` : parts[0];
        });
      const resolvedKey = keyFor(resolve(moduleDir, m[2]));
      out.push(`const { ${specifiers.join(", ")} } = require(${JSON.stringify(resolvedKey)});`);
      continue;
    }

    // --- export { a, b } (standalone re-export block) ---
    let mBlock = trimmed.match(/^export\s*\{([^}]*)\}\s*;?\s*$/);
    if (mBlock) {
      const names = mBlock[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.split(/\s+as\s+/).map((t) => t.trim()));
      for (const pair of names) {
        const local = pair[0];
        const exported = pair[1] || pair[0];
        out.push(`exports.${exported} = ${local};`);
        exportNames.push(exported);
      }
      continue;
    }

    // --- export function / class / const / let / var ---
    const mDecl = line.match(/^(\s*)export\s+(function|class|const|let|var)\s+([A-Za-z0-9_$]+)/);
    if (mDecl) {
      const indent = mDecl[1];
      const name = mDecl[3];
      exportNames.push(name);
      // Strip the leading `export ` keyword, keep the declaration as-is.
      out.push(line.replace(/^(\s*)export\s+/, "$1"));
      continue;
    }

    out.push(line);
  }

  // Append the export registrations for declaration exports at the end so they
  // see hoisted/initialized bindings (functions are hoisted; const/let are in
  // TDZ only before their line, and all our export-const are top-level and
  // initialized by the time the module body finishes executing).
  const tail = [];
  for (const name of exportNames) {
    // `export {}` blocks already wrote `exports.x = ...`; only register the
    // declaration-style exports here. We detect those by excluding ones already
    // emitted as `exports.name =` above.
  }

  // Register declaration-style exports (function/const/let/var/class). Block
  // re-exports were already written inline above. To avoid double-registering,
  // only add names that were NOT emitted via an inline `exports.X =` line.
  const alreadyInline = new Set(
    out
      .map((l) => l.match(/^exports\.([A-Za-z0-9_$]+)\s*=/))
      .filter(Boolean)
      .map((m) => m[1]),
  );
  for (const name of exportNames) {
    if (!alreadyInline.has(name)) tail.push(`exports.${name} = ${name};`);
  }

  return out.join("\n") + (tail.length ? "\n\n" + tail.join("\n") : "");
}

// --- Build the combined module registry script ---
const moduleBlocks = [];
for (const rel of ORDER) {
  const absPath = resolve(ROOT, rel);
  const source = readFileSync(absPath, "utf8");
  const key = keyFor(absPath);
  const body = transform(absPath, source);
  moduleBlocks.push(
    `  ${JSON.stringify(key)}: function (exports, require) {\n` +
      body
        .split("\n")
        .map((l) => (l.length ? "    " + l : l))
        .join("\n") +
      "\n  },",
  );
}

const entryKey = "src/main.js";

const runtime = `(function () {
  "use strict";
  // CommonJS-style module registry. Each factory runs once; its exports object
  // is cached. Isolated scopes => no cross-module identifier collisions.
  var __factories = {
${moduleBlocks.join("\n")}
  };
  var __cache = Object.create(null);
  function require(key) {
    if (__cache[key]) return __cache[key].exports;
    var factory = __factories[key];
    if (!factory) throw new Error("Module not found: " + key);
    var module = { exports: {} };
    __cache[key] = module;
    factory(module.exports, require);
    return module.exports;
  }
  // Kick off the app: main.js auto-boots on load (it checks document.readyState
  // and wires DOMContentLoaded / boots immediately), exactly like the module
  // script in index.html.
  require(${JSON.stringify(entryKey)});
})();`;

// --- Assemble the HTML ---
const css = readFileSync(resolve(ROOT, "css/style.css"), "utf8");
const indexHtml = readFileSync(resolve(ROOT, "index.html"), "utf8");

// Pull the <body> inner markup out of index.html, dropping the module <script>
// tag (we inline the bundled script instead) and the external stylesheet link.
const bodyMatch = indexHtml.match(/<body>([\s\S]*?)<\/body>/);
if (!bodyMatch) throw new Error("Could not find <body> in index.html");
let bodyInner = bodyMatch[1].replace(
  /\s*<script\s+type="module"[^>]*><\/script>/,
  "",
);

const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover"
    />
    <meta name="theme-color" content="#001405" />
    <title>ATC Simulator</title>
    <!--
      SELF-CONTAINED BUILD. This single file bundles index.html + css/style.css +
      every src/**/*.js module so the game plays directly from the local
      filesystem (file://), with no server and no network access. Regenerate with:
        node scripts/bundle.mjs
      Do not edit this file by hand; edit the source under src/ and rebuild.
    -->
    <style>
${css.replace(/\n/g, "\n")}
    </style>
  </head>
  <body>${bodyInner}
    <script>
${runtime
  .split("\n")
  .map((l) => (l.length ? "      " + l : l))
  .join("\n")}
    </script>
  </body>
</html>
`;

writeFileSync(resolve(ROOT, "standalone.html"), html, "utf8");
console.log("Wrote standalone.html (" + html.length + " bytes)");
