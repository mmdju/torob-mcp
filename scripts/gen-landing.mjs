import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
var root = join(dirname(fileURLToPath(import.meta.url)), "..");
function escFile(name) {
  var html = readFileSync(join(root, "landing", name), "utf8");
  return html.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}
var landing = escFile("torob-landing-preview.html");
var mcpPage = escFile("torob-mcp-page.html");
var out = "// The Persian landing page served by worker.ts (GET /) and by index.ts --http.\n// One owner, so the two transports cannot drift apart in what they show.\n// Generated from ../landing/torob-landing-preview.html - edit that file, then run: node scripts/gen-landing.mjs\n export const LANDING = `" + landing + "`;\n// Human-friendly guide for GET /mcp (agents use POST, untouched).\n// Generated from ../landing/torob-mcp-page.html - edit that file, then run: node scripts/gen-landing.mjs\n export const MCP_PAGE = `" + mcpPage + "`;\n";
writeFileSync(join(root, "src", "landing.ts"), out);
console.log("landing.ts written, bytes=" + out.length);
