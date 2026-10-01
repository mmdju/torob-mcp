// Maps the live Torob API: verifies every endpoint and field this server relies
// on, so a silent upstream change shows up here first.
//
// IMPORTANT: run this from the deployment target, not from a laptop. Torob's
// edge answers data-centre and heavily-probed clients with an arCAPTCHA page
// (HTTP 490) instead of JSON, so a green run here can still mean a walled run
// in production - and a 490 here can be a local reputation problem rather than
// an upstream one. Compare against a deployed worker before believing either.
//
// Run: npm run probe
const BASE = "https://api.torob.com";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json",
  Referer: "https://torob.com/",
  Origin: "https://torob.com",
  source: "next_desktop",
};

const out = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, label) {
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS });
  const text = await res.text();
  const walled = res.status === 490 || /arcaptcha|ربات/i.test(text.slice(0, 3000));
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* walled or html */
  }
  out.push(
    `${label.padEnd(34)} HTTP ${String(res.status).padEnd(4)} ${walled ? "[BOT WALL]" : "[ok]      "} ` +
      `${String(text.length).padStart(7)}b ${Date.now() - started}ms`
  );
  if (walled) {
    out.push("  ^ Torob answered with a bot challenge. Not a rate limit; retrying will not clear it.");
    out.push("    If this is your machine and it used to work, the IP reputation changed - try later or from a worker.");
  }
  return { res, json, walled, text };
}

// 1. search
const search = await get(
  `/v4/base-product/search/?q=${encodeURIComponent("گوشی ایفون ۱۳")}&page=0&size=24&sort=popularity`,
  "search"
);
await sleep(1200);
const rows = search.json?.results ?? [];
out.push(`  results=${rows.length} count=${search.json?.count ?? "n/a"}`);
if (rows.length) {
  const row = rows[0];
  out.push(`  first: ${row.name1} | ${row.price_text} | shop=${row.shop_text ?? "-"}`);
  out.push(`  card fields: ${Object.keys(row).slice(0, 12).join(",")}`);
}

// 2. details - the seller list, which is the reason this server exists
const more = rows[0]?.more_info_url;
if (more) {
  const path = more.replace(BASE, "");
  const details = await get(path, "details (from more_info_url)");
  await sleep(1200);
  const offers = details.json?.products_info?.result ?? [];
  out.push(`  products_info.title=${details.json?.products_info?.title ?? "MISSING"}`);
  out.push(`  offers=${offers.length}`);
  // The in-person shops, the spec tables and the variant tabs ride along in
  // this same response - the price the server pays for them is nothing, so what
  // matters is that they are still there.
  const inStore = details.json?.products_in_store_info?.result ?? [];
  out.push(
    `  in-person shops=${inStore.length} (title=${details.json?.products_in_store_info?.title ?? "MISSING"})`
  );
  out.push(
    `  specs=${details.json?.key_specs?.length ?? 0} key / ${details.json?.structural_specs?.headers?.length ?? 0} table(s), ` +
      `variants=${details.json?.variants?.length ?? 0}, breadcrumbs=${details.json?.breadcrumbs?.length ?? 0}`
  );
  if (offers.length) {
    const o = offers[0];
    out.push(`  offer fields: ${Object.keys(o).join(",")}`);
    out.push(`  first offer: ${o.shop_name} ${o.price_text ?? o.price} score=${o.shop_score ?? "-"} votes=${o.shop_votes_count ?? "-"}`);
  } else {
    out.push("  ^ no offers - the seller list shape changed or this product has a single seller");
  }
} else {
  out.push("no more_info_url on the first row - the 2-hop detail path is gone");
}

// 3. every other endpoint a tool relies on, checked so an upstream change shows
// up here before it shows up as a wrong answer. The shop and price rows are
// keyed on ids taken from the search result above, so this stays a real probe
// rather than a list of guesses.
const shopId = search.json?.results?.[0]?.shop_id;
const prk = rows[0]?.random_key;
const ENDPOINTS = [
  ["/suggestion2/?q=phone&source=next_desktop", "suggestion2"],
  [`/v4/base-product/price-chart/?prk=${prk}`, "price chart"],
  [`/v4/base-product/price-history/?prk=${prk}&page=0&size=10`, "price changes"],
  [`/v4/base-product/last-modified-date/?prk=${prk}`, "price freshness"],
  ["/v4/search-trends/?t=1", "search-trends"],
  ["/v4/special-offers/?page=0", "special-offers"],
  ["/v4/city/list/?size=5", "city list"],
  ["/v4/city/most-visited/list/", "popular cities"],
  ["/v4/province/list/?size=5", "province list"],
  ["/v4/category/price-list-nested/?id=105&page=0&size=10", "category price-list"],
  ["/v4/internet-shop/list/?q=%D9%85%D9%88%D8%A8%D8%A7%DB%8C%D9%84&page=0&size=5&shop_type=all", "shop directory"],
  [shopId ? `/v4/internet-shop/details/?id=${shopId}` : null, "shop profile"],
  [shopId ? `/v4/internet-shop/base-product/list/?shop_id=${shopId}&page=0` : null, "shop catalogue"],
  [prk ? `/v4/base-product/map/sellers/?prk=${prk}` : null, "in-person sellers (map)"],
];
for (const [path, label] of ENDPOINTS) {
  if (!path) {
    out.push(`${label.padEnd(34)} skipped - no id in the search result above`);
    continue;
  }
  const r = await get(path, label);
  if (r.json) {
    const sample = Array.isArray(r.json) ? r.json[0] : r.json.results?.[0] ?? r.json;
    out.push(`  sample: ${JSON.stringify(sample).slice(0, 100)}`);
  }
  await sleep(1200);
}

console.log(out.join("\n"));
const walled = out.filter((l) => l.includes("[BOT WALL]")).length;
console.log(`\n${walled ? `${walled} endpoint(s) challenged.` : "No endpoint was challenged."}`);
