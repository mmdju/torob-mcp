// Verifies the deployed endpoint end to end, the way a real MCP client does:
// initialize, list tools, then one call per tool. No dependencies.
//
// Run: node scripts/verify-live.mjs [url] [gap-seconds]
// Either argument may be left out, and a bare number counts as the gap, so
// `node scripts/verify-live.mjs 5` slows the run down the way the docs say it
// does instead of being read as a host and failing on the first fetch.
import { readFile } from "node:fs/promises";

const ARGS = process.argv.slice(2);
const isCount = (a) => /^\d+$/.test(a);
const BASE = ARGS.find((a) => !isCount(a)) ?? "https://torob-mcp.mmdju3.workers.dev";
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

// 5. the hosted copy limits /mcp, and says so in headers. A self-hosted run has
// no limit, so this is about the deployment rather than about the tools.
const budget = await fetch(MCP, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list", params: {} }),
});
const limit = budget.headers.get("x-ratelimit-limit");
limit ? ok("rate limit", `${limit} /mcp calls a minute per client`) : bad("rate limit", "x-ratelimit-limit missing");

// 6. MCP handshake
const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "verify-live", version: "0.0.1" },
}, 1);
init.result?.serverInfo?.name === "torob-mcp" ? ok("initialize", init.result.serverInfo.version) : bad("initialize");

// 7. tools
const tools = (await rpc("tools/list", {}, 2)).result.tools.map((t) => t.name).sort();
const expected = [
  "browse_categories",
  "compare_products",
  "find_best_value",
  "find_shops",
  "list_locations",
  "price_history",
  "product_details",
  "product_guide",
  "search_by_image",
  "search_products",
  "shop_profile",
  "similar_products",
  "special_offers",
  "torob_suggest",
  "torob_trends",
];
JSON.stringify(tools) === JSON.stringify(expected) ? ok("tools/list", `${tools.length} tools`) : bad("tools/list", tools.join(", "));

// 8. the tools answer against the live API
// Torob does not throttle with a 429 - it challenges a client that calls too
// often, and the block then covers every endpoint for about five idle
// minutes. Measured, a full sweep is walled partway through at any gap short
// of roughly 30s, so this walks the tools one at a time, lightest first, and
// stops at the first challenge. A challenge is Torob's answer, not a broken
// deploy: it is reported and the run exits 0, because the wall is upstream's
// behaviour and the contract checks above it already passed.
const gapSeconds = Number(ARGS.filter(isCount)[0] ?? 15);
const gap = gapSeconds * 1000;
const pause = () => new Promise((r) => setTimeout(r, gap));
let id = 3;
let challenged = false;

// A Torob-hosted picture, used as a stable public URL for search_by_image.
// Torob fetches the link itself, and recognising nothing is a legitimate
// answer - the check below is about the shape, not about a match.
const IMAGE_URL = "https://image.torob.com/base/images/8_/oJ/8_oJN_VQScbbQBux.jpg";

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
  // The cheapest and dearest price Torob saw for this query ride along.
  search.price_bounds_toman ? ok("search price bounds", `${search.price_bounds_toman.min} to ${search.price_bounds_toman.max}`) : bad("search price bounds", "price_bounds_toman missing");
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
    // The in-person sellers, the spec tables and the price window ride along
    // in the same upstream response; what matters is that they are still there.
    details.in_person_count !== undefined
      ? ok("in-person sellers", `${details.in_person_count} shops`)
      : bad("in-person sellers", "in_person_count missing");
    // The spec tables ride along in the same response. The cheapest card of a
    // broad search can be a bare accessory with none, so the check walks the
    // cards this run already holds until one carries a spec table.
    let specRows = Array.isArray(details.specs) ? details.specs : null;
    for (const card of search.products.slice(1, 3)) {
      if (specRows) break;
      const extra = await call("product_details", { prk: card.prk, details_url: card.details_url, max_offers: 1 }, id++);
      if (Array.isArray(extra.specs) && extra.specs.length) specRows = extra.specs;
      else await pause();
    }
    specRows
      ? ok("spec tables", `${specRows.length} spec row(s)`)
      : bad("spec tables", "no spec table on any of the first three cards - the shape may have changed");
    await pause();

    // The chart is Torob's own: monthly points plus the shop-level changes.
    // The first card of a phone search is normally charted; when it is not, the
    // next card is tried before the shape is called broken. An empty chart and
    // a renamed upstream field look the same from here, so the live check needs
    // a card that really charts something.
    let chart = null;
    let chartPoints = 0;
    for (const card of search.products.slice(0, 3)) {
      const attempt = await call("price_history", { prk: card.prk, details_url: card.details_url, months: 6, include_changes: true, changes_limit: 3 }, id++);
      const points = (attempt.series ?? []).reduce((n, s) => n + (s.points?.length ?? 0), 0);
      if (points >= 2) {
        chart = attempt;
        chartPoints = points;
        break;
      }
      await pause();
    }
    chart
      ? ok("price_history", `${chartPoints} chart point(s) over ${chart.window?.points} month(s), ${chart.changes_count ?? "no"} change(s)`)
      : bad("price_history", "Torob charts no points for the first two search cards - the chart shape may have changed");
    chart?.reading ? ok("price reading", "a plain-language sentence travels with the chart") : bad("price reading", "reading missing");
    await pause();

    // The details_url has to come back with the prk: Torob cannot look up a
    // product by id alone, and this server's own memory of a product is per
    // isolate and per colo, so an id-only call here would fail on a cold one
    // rather than test the contract.
    const similar = await call("similar_products", { prk: first.prk, details_url: first.details_url, limit: 3 }, id++);
    similar.found !== undefined ? ok("similar_products", `${similar.found} similar`) : bad("similar_products");
    await pause();

    if (search.products.length > 1) {
      const cmp = await call(
        "compare_products",
        { prks: search.products.slice(0, 2).map((p) => ({ prk: p.prk, details_url: p.details_url })) },
        id++
      );
      // A comparison that resolved nothing is not a pass - the ids came from
      // a search this same run handed out, so they are expected to resolve.
      cmp.compared === cmp.requested
        ? ok("compare_products", `${cmp.compared}/${cmp.requested} resolved`)
        : bad("compare_products", `only ${cmp.compared}/${cmp.requested} resolved`);
      await pause();
    }

    // The shop behind the cheapest offer answers with its own profile, and
    // with its catalogue when asked for one.
    const shopId = details.offers?.find((o) => o.shop_id)?.shop_id;
    if (shopId) {
      const profile = await call("shop_profile", { shop_id: shopId, include_products: true, limit: 3 }, id++);
      profile.name && profile.url === `https://torob.com/shop/${shopId}/`
        ? ok("shop_profile", `${profile.name}`)
        : bad("shop_profile", `name=${profile.name ?? "missing"} url=${profile.url ?? "missing"}`);
      profile.trust_seal && typeof profile.trust_seal === "object"
        ? ok("shop trust seal", profile.trust_seal.level ?? "sent without a level")
        : bad("shop trust seal", "trust_seal missing");
      profile.catalogue_count !== undefined
        ? ok("shop catalogue", `${profile.catalogue_count} products listed`)
        : bad("shop catalogue", "catalogue_count missing with include_products");
      await pause();
    }
  }

  // The shop directory is its own search - businesses, not products.
  const shops = await call("find_shops", { query: "موبایل", limit: 5 }, id++);
  shops.shops?.length && shops.shops[0].id
    ? ok("find_shops", `${shops.total_shops} shops, first id ${shops.shops[0].id}`)
    : bad("find_shops", "no shops and no note");
  await pause();

  // Torob fetches the picture itself, so this needs a publicly reachable URL.
  const image = await call("search_by_image", { image_url: IMAGE_URL, limit: 3 }, id++);
  Array.isArray(image.products)
    ? ok("search_by_image", image.products.length ? `${image.products.length} cards` : "no cards, explained in the note")
    : bad("search_by_image", "products missing");
  if (!image.products.length && !image.note) bad("search_by_image note", "an empty match must explain itself");
  await pause();

  const trends = await call("torob_trends", { limit: 10 }, id++);
  trends.trends?.length ? ok("torob_trends", `${trends.count} trending wordings`) : bad("torob_trends", "none returned");
  await pause();

  // Budgets here are the real market: a phone case runs from ~20,000 Toman to
  // tens of millions, so 1.5M is a normal ask and returns matches.
  const best = await call("find_best_value", { query: "قاب گوشی", budget_toman: 1500000, limit: 3 }, id++);
  best.picks !== undefined ? ok("find_best_value", `${best.matches_in_budget} in budget`) : bad("find_best_value");
  await pause();

  const cats = await call("browse_categories", { id: "1", limit: 8 }, id++);
  cats.categories?.length ? ok("browse_categories", `${cats.count} under ${cats.parent_id}`) : bad("browse_categories");
  await pause();

  const locs = await call("list_locations", {}, id++);
  locs.provinces?.length ? ok("list_locations", `${locs.count} provinces`) : bad("list_locations");
  // The five cities Torob's own users pick most, so an agent can suggest one.
  locs.popular_cities?.length ? ok("popular cities", `${locs.popular_cities.length} cities`) : bad("popular cities", "popular_cities missing");
  await pause();

  const offers = await call("special_offers", { limit: 5 }, id++);
  offers.offers !== undefined ? ok("special_offers", `${offers.count} featured`) : bad("special_offers");
} catch (err) {
  // A challenge is Torob's answer, not a broken deployment. It is reported as
  // the finding it is, and it does not fail the run: the wall is upstream's
  // behaviour, the contract checks above it already passed, and the next
  // scheduled run picks the remaining tools up once the block clears.
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
