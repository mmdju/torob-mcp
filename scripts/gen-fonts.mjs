// Emits src/fonts.ts: the four Doran weights, base64-inlined, so the worker can
// serve them at /doran-<weight>.woff2. Same shape as og-image.ts.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

var root = join(dirname(fileURLToPath(import.meta.url)), "..");
var weights = [400, 500, 700, 800];
var entries = weights.map(function (w) {
  var b64 = readFileSync(join(root, "assets", "doran-" + w + ".woff2")).toString("base64");
  return { w: w, b64: b64 };
});

var out =
  '// Generated from assets/doran-*.woff2 by scripts/gen-fonts.mjs. Do not edit by hand.\n' +
  '// The landing page links these; keeping them out of the HTML is what makes the page small.\n' +
  'const BIN: Record<number, string> = {\n' +
  entries.map(function (e) { return "  " + e.w + ': "' + e.b64 + '"'; }).join(",\n") +
  '\n};\n\n' +
  'export const FONT_BIN: Record<number, Uint8Array> = Object.fromEntries(\n' +
  '  Object.entries(BIN).map(([w, b64]) => [Number(w), Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))])\n' +
  ');\n';

writeFileSync(join(root, "src", "fonts.ts"), out);
console.log("fonts.ts written, bytes=" + out.length);
