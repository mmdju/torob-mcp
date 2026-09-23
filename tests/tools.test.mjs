// The tools are exercised against a stubbed fetch, so the suite never touches
// Torob and never waits on a real network. The stubs are shaped like the live
// payloads probed on 2026-09-24.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "../dist/tools.js";
import { resetBreakerForTests, setPaceForTests, setRetryDelayForTests } from "../dist/http.js";

setPaceForTests(0);
setRetryDelayForTests(0);

const originalFetch = globalThis.fetch;
function stub(handler) {
  globalThis.fetch = async (url) => {
    const res = handler(String(url));
    if (res instanceof Response) return res;
    return new Response(typeof res === "string" ? res : JSON.stringify(res), {
      headers: { "content-type": "application/json" },
    });
  };
}
// The challenge test below trips the circuit breaker, and the breaker is
// per-isolate module state that outlives a single test. Clear it alongside the
// fetch stub so the next test starts from a clean slate.
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  resetBreakerForTests();
});

const run = (name, args) => TOOLS.find((t) => t.name === name).run(args);

const searchPayload = {
  results: [
    {
      random_key: "prk-aaa",
      name1: "گوشی ایفون ۱۳",
      name2: "iPhone 13",
      price: 50000000,
      price_text: "۵۰٫۰۰۰٫۰۰۰ تومان",
      image_url: "https://image.torob.com/a.jpg",
      image_count: 2,
      shop_text: "دیجی‌کالا",
      web_client_absolute_url: "/p/prk-aaa/",
      more_info_url: "https://api.torob.com/v4/base-product/details/?search_id=s1&prk=prk-aaa",
    },
    {
      random_key: "prk-bbb",
      name1: "قاب گوشی",
      price: 0,
      price_text: "",
      web_client_absolute_url: "/p/prk-bbb/",
      more_info_url: "https://api.torob.com/v4/base-product/details/?search_id=s1&prk=prk-bbb",
    },
  ],
  count: 120,
  min_price: 0,
  max_price: 90000000,
  next: "https://api.torob.com/v4/base-product/search/?q=x&page=1",
  categories: [{ id: "230", title: "موبایل" }],
  spellcheck: { initial_query: "ایفون ۱۳", corrected_query: "" },
};

const detailsPayload = {
  random_key: "prk-aaa",
  name1: "گوشی ایفون ۱۳",
  price: 50000000,
  price_text: "۵۰٫۰۰۰٫۰۰۰ تومان",
  products_info: {
    title: "فروشنده‌ها",
    result: [
      { shop_name: "دیجی‌کالا", shop_score: 4.8, shop_votes_count: 9000, price: 50000000, availability: true, more_info: {} },
      { shop_name: "فروشگاه دوم", shop_score: 4.0, shop_votes_count: 50, price: 52000000, availability: true, more_info: {} },
    ],
  },
};

test("search_products returns compact cards and the honest total", async () => {
  stub(() => searchPayload);
  const out = await run("search_products", { query: "ایفون ۱۳" });
  assert.equal(out.query, "ایفون ۱۳");
  assert.equal(out.total_matches, 120);
  assert.equal(out.products.length, 2);
  assert.equal(out.products[0].price_toman, 50000000);
  // The out-of-stock card must be visibly out of stock, not priced at 0.
  assert.equal(out.products[1].available, false);
  assert.equal(out.products[1].price_toman, null);
  assert.equal(out.has_next_page, true);
  assert.equal(out.suggested_categories[0].id, "230");
});

test("search_products reports a price range and the sort meaning", async () => {
  stub(() => searchPayload);
  const out = await run("search_products", { query: "x", sort: "price" });
  assert.equal(out.sort, "price");
  assert.equal(out.sort_meaning, "cheapest first");
  assert.equal(out.price_range_toman.max, 90000000);
});

test("search_products refuses a blank query instead of searching everything", async () => {
  stub(() => searchPayload);
  await assert.rejects(() => run("search_products", { query: "   " }), /needs a query/);
});

test("search_products explains an empty result instead of implying the product is gone", async () => {
  stub((url) => {
    if (url.includes("/suggestion2/")) return [{ text: "ایفون ۱۳ پرو" }, { text: "قاب ایفون ۱۳" }];
    return { results: [], count: 0, next: "" };
  });
  const out = await run("search_products", { query: "چیزی که نیست" });
  assert.equal(out.products.length, 0);
  assert.deepEqual(out.suggested_queries, ["ایفون ۱۳ پرو", "قاب ایفون ۱۳"]);
  assert.match(out.query_note, /not proof/i);
});

test("a bot challenge is a clear error, not an empty market", async () => {
  // The single most important failure mode: Torob answering 490 with HTML
  // must never be parsed into "no results".
  stub(() => new Response("<html>arcaptcha</html>", { status: 490 }));
  await assert.rejects(() => run("search_products", { query: "x" }), /bot challenge/i);
});

test("product_details lists every seller offer with scores", async () => {
  stub((url) => {
    if (url.includes("/details/")) return detailsPayload;
    return searchPayload;
  });
  const out = await run("product_details", { prk: "prk-aaa" });
  assert.equal(out.prk, "prk-aaa");
  assert.equal(out.offer_count, 2);
  assert.equal(out.offers[0].shop_name, "دیجی‌کالا");
  assert.equal(out.offers[0].shop_score, 4.8);
  // Same product, two shops, different prices: the spread is the point.
  assert.equal(out.price_spread_toman, 2000000);
  assert.equal(out.cheapest_offer.shop_name, "دیجی‌کالا");
  assert.equal(out.best_rated_offer.shop_name, "دیجی‌کالا");
});

test("product_details resolves an id this server already handed out", async () => {
  // The realistic flow: search returns a prk, the agent passes it straight
  // back. Torob's search endpoint matches names, not ids, so this only works
  // because the details URL from the search row is remembered.
  const searchOnly = { results: [searchPayload.results[0]], count: 1, next: "" };
  stub((url) => (url.includes("/details/") ? detailsPayload : searchOnly));

  await run("search_products", { query: "ایفون ۱۳" });
  const out = await run("product_details", { prk: "prk-aaa" });
  assert.equal(out.prk, "prk-aaa");
  assert.equal(out.offer_count, 2);
  // Exactly one search and one details call - no id-as-query round trip.
});

test("product_details accepts a full torob product URL", async () => {
  // Real Torob product ids are UUIDs, so the fixture uses one: an agent that
  // copied a product link must not have to strip the slug itself.
  const id = "2ee0949f-e7de-4cd8-a45a-ea5bad3eff95";
  stub((url) => {
    if (url.includes("/details/")) return { ...detailsPayload, random_key: id };
    return {
      ...searchPayload,
      results: [{ ...searchPayload.results[0], random_key: id, more_info_url: `https://api.torob.com/v4/base-product/details/?search_id=s1&prk=${id}` }],
    };
  });
  // Warm the id by searching, the way an agent would have.
  await run("search_products", { query: "ایفون ۱۳" });
  const out = await run("product_details", { prk: `https://torob.com/p/${id}/گاوصندوق/` });
  assert.equal(out.prk, id);
});

test("product_details explains that an unknown id needs a fresh search", async () => {
  // Nothing remembered and nothing findable: the error must name the way out
  // rather than saying "not found".
  stub(() => ({ results: [], count: 0, next: "" }));
  await assert.rejects(
    () => run("product_details", { prk: "00000000-0000-0000-0000-000000000000" }),
    /search_products/
  );
});

test("compare_products reports each product and survives one failure", async () => {
  stub((url) => {
    if (url.includes("/details/")) return detailsPayload;
    return searchPayload;
  });
  // One product the server has seen (via a search) and one it has not.
  await run("search_products", { query: "ایفون ۱۳" });
  const out = await run("compare_products", { prks: ["prk-aaa", "prk-zzz"] });
  assert.equal(out.requested, 2);
  // One resolved, one failed: the working row still answers.
  assert.equal(out.partial_failure, true);
  assert.equal(out.products.length, 2);
  assert.ok(out.products.some((p) => p.error));
  assert.ok(out.products.some((p) => p.prk === "prk-aaa" && !p.error));
});

test("compare_products insists on at least two products", async () => {
  await assert.rejects(() => run("compare_products", { prks: ["only-one"] }), /at least 2/);
});

test("compare_products caps at five", async () => {
  await assert.rejects(() => run("compare_products", { prks: ["a", "b", "c", "d", "e", "f"] }), /up to 5/);
});

test("find_best_value ranks buyable products under the budget", async () => {
  stub(() => searchPayload);
  const out = await run("find_best_value", { query: "ایفون", budget_toman: 60000000 });
  assert.equal(out.budget_toman, 60000000);
  assert.equal(out.best_value.prk, "prk-aaa");
  // The out-of-stock row is excluded from the picks and counted separately.
  assert.equal(out.picks.length, 1);
  assert.equal(out.out_of_stock_excluded, 1);
});

test("find_best_value says so when nothing fits the budget", async () => {
  stub(() => searchPayload);
  const out = await run("find_best_value", { query: "ایفون", budget_toman: 1000 });
  assert.equal(out.matches_in_budget, 0);
  assert.equal(out.best_value, null);
  assert.match(out.budget_note, /under/i);
});

test("torob_suggest returns the wordings Torob itself suggests", async () => {
  stub(() => [{ text: "قاب گوشی ایفون" }, { text: "گلس ایفون" }]);
  const out = await run("torob_suggest", { query: "قاب گوشی" });
  assert.deepEqual(out.suggestions, ["قاب گوشی ایفون", "گلس ایفون"]);
  assert.match(out.next, /search_products/);
});
