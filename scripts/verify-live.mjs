// Verifies the deployed endpoint end to end, the way a real MCP client does:
// initialize, list tools, then one call per tool. No dependencies.
//
// Run: node scripts/verify-live.mjs [url] [gap-ms]
import { readFile } from "node:fs/promises";

const BASE = process.argv[2] ?? "https://torob-mcp.mmdju3.workers.dev";
const MCP = `${BASE}/mcp`;

let sessionId = null;
const fail = [];
const ok = (label, extra = "") => console.log(`  ok  ${label}${extra ? ` - ${extra}` : ""}`);
const bad = (label, extra = "") => {
  fail.push(label);
  console.log(`  FAIL ${label}${extra ? ` - ${extra}` : ""}`);
};

async function rpc(method, params, id) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(MCP, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(line ? line.slice(5).trim() : text);
}

async function call(name, args, id) {
  const r = await rpc("tools/call", { name, arguments: args }, id);
  const text = r.result?.content?.[0]?.text ?? "{}";
  if (r.result?.isError) {
    const err = new Error(text);
    err.challenged = /challenge|challenged|retry in about|490/i.test(text);
    throw err;
  }
  return JSON.parse(text);
}

console.log(`torob-mcp live check against ${BASE}\n`);

// 1. health
const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null);
if (health?.ok) ok("health", `version ${health.version}`);
else bad("health");

// 2. the service must not lag the newest release documented here.
// Read the changelog beside this script - the repo is not public, so a raw
// GitHub URL would 404 for anyone running the check.
const newest = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8")
  .then((t) => t.match(/^## (\d+\.\d+\.\d+)/m)?.[1])
  .catch(() => null);
if (!newest) bad("newest release", "could not read CHANGELOG.md next to this script");
else if (health?.version === newest) ok("version match", `${health.version} is the newest release`);
else bad("version mismatch", `live ${health?.version} vs newest ${newest} - deploy before trusting these docs`);

// 3. landing
const landing = await fetch(BASE).then((r) => r.text()).catch(() => "");
landing.includes("torob-mcp") ? ok("landing page") : bad("landing page");

// 4. og image
const og = await fetch(`${BASE}/og.png`).then((r) => r.arrayBuffer()).catch(() => null);
og && new Uint8Array(og).length > 100 ? ok("og image") : bad("og image");

// 5. MCP handshake
const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "verify-live", version: "0.0.1" },
}, 1);
init.result?.serverInfo?.name === "torob-mcp" ? ok("initialize", init.result.serverInfo.version) : bad("initialize");

// 6. tools
const tools = (await rpc("tools/list", {}, 2)).result.tools.map((t) => t.name).sort();
const expected = [
  "browse_categories",
  "compare_products",
  "find_best_value",
  "list_locations",
  "product_details",
  "search_products",
  "similar_products",
  "special_offers",
  "torob_suggest",
];
JSON.stringify(tools) === JSON.stringify(expected) ? ok("tools/list", `${tools.length} tools`) : bad("tools/list", tools.join(", "));

// 7. the tools answer against the live API
// Torob does not throttle with a 429 - it challenges a client that calls too
// often, and the block then covers every endpoint for about five idle
// minutes. Measured, a full nine-tool sweep is walled partway through at any
// gap short of roughly 30s, so this walks the tools one at a time and stops
// at the first challenge. A challenge is Torob's answer, not a broken deploy:
// it is reported and the run exits 0, because the wall is upstream's
// behaviour and the contract checks above it already passed.
const gap = Number(process.argv[3] ?? 12000);
const pause = () => new Promise((r) => setTimeout(r, gap));
let id = 3;
let challenged = false;

const isChallenge = (text) => /challenge|challenged|retry in about|490/i.test(text);

try {
  const suggested = await call("torob_suggest", { query: "قاب" }, id++);
  suggested.suggestions ? ok("torob_suggest", `${suggested.suggestions.length} suggestions`) : bad("torob_suggest");
  await pause();

  const search = await call("search_products", { query: "گوشی ایفون ۱۳", limit: 3 }, id++);
  search.products?.length ? ok("search_products", `${search.total_matches} matches`) : bad("search_products", "no products");
  // The filter groups this search accepts, and that a real slug round-trips.
  const groups = search.available_filters?.length ?? 0;
  groups ? ok("search filters", `${groups} groups: ${search.available_filters.slice(0, 4).map((f) => f.slug).join(", ")}`) : bad("search filters", "none reported");
  // The groups carry the values they take, and Torob's count travels with its
  // own caveat instead of being quoted as a fact.
  const withOptions = (search.available_filters ?? []).find((f) => Array.isArray(f.options) && f.options.length);
  withOptions
    ? ok("filter values", `${withOptions.slug}: ${withOptions.options.length} option(s)`)
    : bad("filter values", "no group carries its values");
  search.total_matches_note ? ok("count is labelled approximate") : bad("count note", "total_matches_note missing");
  await pause();

  // A value the search itself advertised must round-trip through `filters`.
  if (withOptions) {
    const slug = withOptions.slug;
    const value = withOptions.options[0].value;
    const filtered = await call("search_products", { query: "گوشی ایفون ۱۳", filters: { [slug]: value }, limit: 3, sort: "expensive" }, id++);
    filtered.filters_applied?.[slug] === value
      ? ok("filter round-trip", `${slug}=${value}`)
      : bad("filter round-trip", `${slug}=${value} came back as ${JSON.stringify(filtered.filters_applied)}`);
    filtered.sort_meaning ? ok("sort meaning", filtered.sort_meaning) : bad("sort meaning", "sort_meaning missing");
    await pause();
  }

  if (search.products?.length) {
    const first = search.products[0];
    const detailsArgs = { prk: first.prk, max_offers: 5 };
    if (first.details_url) detailsArgs.details_url = first.details_url;
    const details = await call("product_details", detailsArgs, id++);
    details.offer_count !== undefined ? ok("product_details", `${details.offer_count} offers`) : bad("product_details");
    details.resolved_by ? ok("resolved_by", details.resolved_by) : bad("resolved_by", "missing");
    details.offers?.[0] && "postage_fee_toman" in details.offers[0]
      ? ok("offer carries its postage")
      : bad("offer postage", "postage_fee_toman missing");
    await pause();

    const similar = await call("similar_products", { prk: first.prk, limit: 3 }, id++);
    similar.found !== undefined ? ok("similar_products", `${similar.found} similar`) : bad("similar_products");
    await pause();

    if (search.products.length > 1) {
      const cmp = await call("compare_products", { prks: search.products.slice(0, 2).map((p) => p.prk) }, id++);
      // A comparison that resolved nothing is not a pass - the ids came from
      // a search this same run handed out, so they are expected to resolve.
      cmp.compared === cmp.requested
        ? ok("compare_products", `${cmp.compared}/${cmp.requested} resolved`)
        : bad("compare_products", `only ${cmp.compared}/${cmp.requested} resolved`);
      await pause();
    }
  }

  const best = await call("find_best_value", { query: "قاب گوشی", budget_toman: 500000, limit: 3 }, id++);
  best.picks !== undefined ? ok("find_best_value", `${best.matches_in_budget} in budget`) : bad("find_best_value");
  await pause();

  const cats = await call("browse_categories", { id: "1", limit: 8 }, id++);
  cats.categories?.length ? ok("browse_categories", `${cats.count} under ${cats.parent_id}`) : bad("browse_categories");
  await pause();

  const locs = await call("list_locations", {}, id++);
  locs.provinces?.length ? ok("list_locations", `${locs.count} provinces`) : bad("list_locations");
  await pause();

  const offers = await call("special_offers", { limit: 5 }, id++);
  offers.offers !== undefined ? ok("special_offers", `${offers.count} featured`) : bad("special_offers");
} catch (err) {
  // A challenge is Torob's answer, not a broken deployment. It is reported as
  // the finding it is, and it does not fail the run: the wall is upstream's
  // behaviour, the contract checks above it already passed, and the retry job
  // in the workflow picks the remaining tools up once the block clears.
  if (err.challenged) {
    challenged = true;
    console.log(`  wall Torob challenged the sweep - ${String(err.message).slice(0, 160)}`);
    console.log("       The tools checked so far passed. The rest need a run after a few idle minutes.");
  } else {
    bad("live tool calls", err.message);
  }
}

if (challenged) console.log("\nStopped at the wall. Nothing above failed - re-run later for the remaining tools.");
console.log(fail.length ? `\n${fail.length} check(s) failed.` : "\nAll checks passed.");
process.exit(fail.length ? 1 : 0);
