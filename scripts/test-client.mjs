// Live smoke test: drives the tools the way an agent would, against the real
// Torob API, and prints what came back. This is the check that catches "the
// build is green but the server answers nothing useful".
//
// Run: npm run test:live
import { TOOLS } from "../dist/tools.js";

const run = (name, args) => TOOLS.find((t) => t.name === name).run(args);
const line = (s) => console.log(s);

async function step(label, fn) {
  const started = Date.now();
  try {
    const out = await fn();
    line(`✔ ${label} (${Date.now() - started}ms)`);
    return out;
  } catch (err) {
    line(`✖ ${label}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

line(`torob-mcp live check — ${new Date().toISOString()}\n`);

const suggested = await step("torob_suggest", () => run("torob_suggest", { query: "قاب گوشی" }));
if (suggested) line(`  ${suggested.suggestions.slice(0, 4).join(" · ") || "(no suggestions)"}`);

const search = await step("search_products", () => run("search_products", { query: "گوشی ایفون ۱۳", limit: 5 }));
if (search) {
  line(`  ${search.total_matches} matches, showing ${search.products.length}`);
  for (const p of search.products) {
    line(`  · ${p.name_fa ?? "(no name)"} — ${p.price_text ?? "ناموجود"}${p.available ? "" : " [out of stock]"}`);
  }
}

const first = search?.products?.find((p) => p.available);
if (first) {
  const details = await step("product_details", () => run("product_details", { prk: first.prk, max_offers: 8 }));
  if (details) {
    line(`  ${details.name_fa ?? first.prk}: ${details.offer_count} offers, spread ${details.price_spread_toman ?? "-"}`);
    for (const o of details.offers.slice(0, 5)) {
      line(
        `  · ${o.shop_name} ${o.price_text ?? "-"}${o.available ? "" : " [out of stock]"}` +
          `${o.shop_score !== null ? ` score ${o.shop_score} (${o.shop_votes} votes)` : " score n/a"}` +
          `${o.price_unreliable ? " [price flagged unreliable]" : ""}`
      );
    }
  }
}

const pair = search?.products?.slice(0, 2) ?? [];
if (pair.length === 2) {
  const compared = await step("compare_products", () => run("compare_products", { prks: pair.map((p) => p.prk) }));
  if (compared) line(`  cheapest overall: ${compared.cheapest_overall?.name ?? "-"} (diff ${compared.price_difference_toman ?? "-"})`);
}

const budget = await step("find_best_value", () => run("find_best_value", { query: "کابل_aux", budget_toman: 5_000_000, limit: 3 }));
if (budget) line(`  ${budget.matches_in_budget} in budget, best: ${budget.best_value?.name_fa ?? "-"}`);

line("\ndone.");
