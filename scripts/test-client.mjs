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
  line(`  ${search.available_filters.length} filter groups, ${search.total_matches_note.slice(0, 48)}...`);
  for (const p of search.products) {
    line(`  · ${p.name_fa ?? "(no name)"} — ${p.price_text ?? "ناموجود"}${p.available ? "" : " [out of stock]"}`);
  }
}

// The filter loop an agent is supposed to run: take a value the search itself
// advertised, pass it back, and confirm the server echoed what it applied.
const group = search?.available_filters?.find((f) => f.options?.length);
if (group) {
  const value = group.options[0].value;
  const filtered = await step(`search_products filters ${group.slug}=${value}`, () =>
    run("search_products", { query: "گوشی ایفون ۱۳", filters: { [group.slug]: value }, sort: "expensive", limit: 3 })
  );
  if (filtered) {
    line(`  applied ${JSON.stringify(filtered.filters_applied)} · ${filtered.sort_meaning} · ${filtered.total_matches} matches`);
    const echoed = filtered.filters_applied?.[group.slug] === value;
    line(echoed ? "  filter round-trip ok" : "  filter round-trip FAILED");
  }
}

const first = search?.products?.find((p) => p.available);
if (first) {
  const details = await step("product_details", () =>
    run("product_details", {
      prk: first.prk,
      ...(first.details_url ? { details_url: first.details_url } : {}),
      max_offers: 8,
    })
  );
  if (details) {
    line(`  ${details.name_fa ?? first.prk}: ${details.offer_count} offers, spread ${details.price_spread_toman ?? "-"}`);
    line(`  resolved_by ${details.resolved_by} · cheapest delivered ${details.cheapest_delivered_offer?.shop_name ?? "-"}`);
    for (const o of details.offers.slice(0, 5)) {
      line(
        `  · ${o.shop_name} ${o.price_text ?? "-"}${o.available ? "" : " [out of stock]"}` +
          `${o.shop_score !== null ? ` score ${o.shop_score} (${o.shop_votes} votes)` : " score n/a"}` +
          `${o.postage_text ? ` · ${o.postage_text}` : ""}` +
          `${o.guarantee ? ` · guarantee ${o.guarantee}` : ""}` +
          `${o.installment_providers.length ? ` · instalments: ${o.installment_providers.join(", ")}` : ""}` +
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

const budget = await step("find_best_value", () => run("find_best_value", { query: "کابل_aux", budget_toman: 500_000, limit: 3 }));
if (budget) line(`  ${budget.matches_in_budget} in budget, best: ${budget.best_value?.name_fa ?? "-"}`);

line("\ndone.");
