// Verification helper: extracts the inlined <script> from standalone.html,
// writes it to a temp file, and uses node --check to confirm it parses with no
// syntax errors and no leftover ES module syntax. Not shipped in the bundle.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(ROOT, "standalone.html"), "utf8");

// Grab the last <script>...</script> (the bundled app; the only script tag).
const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (matches.length !== 1) {
  throw new Error(`Expected exactly 1 plain <script>, found ${matches.length}`);
}
const code = matches[0][1];

const tmp = resolve(ROOT, "scripts", ".standalone-bundle.tmp.js");
writeFileSync(tmp, code, "utf8");
execFileSync(process.execPath, ["--check", tmp], { stdio: "inherit" });
console.log("node --check: inlined bundle parses OK (" + code.length + " chars)");

// Belt-and-braces: assert no residual ESM tokens survived the bundling.
const bad = [];
if (/^\s*import\s*[{A-Za-z*]/m.test(code.replace(/require\(/g, ""))) bad.push("import");
if (/^\s*export\s+(function|class|const|let|var|\{|default)/m.test(code)) bad.push("export");
if (/\bfrom\s+["'][\.\/]/m.test(code)) bad.push("from './...'");
if (bad.length) throw new Error("Residual module syntax: " + bad.join(", "));
console.log("No residual ESM syntax in the bundle.");
