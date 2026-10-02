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
  // Torob's count moves between identical requests, so it travels with its
  // own caveat instead of being quoted as a fact.
  assert.match(out.total_matches_note, /approximate/i);
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

test("product_details opens a product from just the details_url it handed out", async () => {
  // The card's details_url is a complete address upstream. Handing it back
  // resolves the id with no server-side memory at all - which is the path a
  // Worker isolate that never saw the search depends on.
  const id = "3a1c0e6a-6b0f-4a6f-9d2e-2f4b8c0d1e2f";
  const seen = [];
  stub((url) => {
    seen.push(url);
    return { ...detailsPayload, random_key: id };
  });
  const out = await run("product_details", {
    prk: id,
    details_url: `https://api.torob.com/v4/base-product/details/?search_id=s9&prk=${id}`,
  });
  assert.equal(out.prk, id);
  assert.equal(out.offer_count, 2);
  assert.equal(out.resolved_by, "details-url");
  // One call, straight to the details endpoint: no name search behind it.
  assert.equal(seen.length, 1);
  assert.match(seen[0], /\/details\//);
});

test("product_details falls back to the id-only lookup and says how it resolved", async () => {
  // A product this server has never seen, with no details_url: the only way in
  // is the id-only details call. resolved_by records which path worked, so a
  // caller always knows how the product was found.
  const id = "9f8e7d6c-5b4a-4938-8271-6a5b4c3d2e1f";
  stub((url) => {
    if (url.includes("/details/")) return { ...detailsPayload, random_key: id };
    return { results: [], count: 0, next: "" };
  });
  const out = await run("product_details", { prk: id });
  assert.equal(out.prk, id);
  assert.equal(out.resolved_by, "id-only");
});

test("product_details reports the best rated seller and the delivered price", async () => {
  // Best rated is the highest score - ties break on votes - and the delivered
  // price adds the postage Torob states, so the cheapest item price is not
  // always the cheapest at the door.
  const id = "1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7081";
  const payload = {
    random_key: id,
    name1: "هدفون بی‌سیم",
    price: 90000,
    products_info: {
      result: [
        { shop_name: "ارزان", shop_score: 3, shop_votes_count: 10, price: 90000, availability: true, postage_fee: "هزینه ارسال ۲۰٫۰۰۰ تومان" },
        { shop_name: "فروشگاه مرکزی", shop_score: 5, shop_votes_count: 50, price: 95000, availability: true, postage_fee: "هزینه ارسال رایگان" },
        {
          shop_name: "بازار",
          shop_score: 5,
          shop_votes_count: 3,
          price: 92000,
          availability: true,
          guarantee_info: { status: "enabled" },
          installment: { providers: [{ name: "بلوبانک" }, { short_title: "تارا" }] },
          is_adv: true,
        },
        { shop_name: "بی‌امتیاز", price: 99000, availability: true },
      ],
    },
  };
  stub((url) => (url.includes("/details/") ? payload : searchPayload));
  const out = await run("product_details", {
    prk: id,
    details_url: `https://api.torob.com/v4/base-product/details/?search_id=s5&prk=${id}`,
  });
  // Cheapest item price, and the cheapest once postage is added: two answers.
  assert.equal(out.cheapest_offer.shop_name, "ارزان");
  assert.equal(out.cheapest_delivered_offer.shop_name, "بازار");
  assert.equal(out.cheapest_delivered_offer.delivered_price_toman, 92000);
  assert.match(out.cheapest_vs_delivered, /بازار/);
  // Two shops with a perfect score: the one with more votes wins.
  assert.equal(out.best_rated_offer.shop_name, "فروشگاه مرکزی");
  assert.match(out.cheapest_vs_best_rated, /فروشگاه مرکزی/);
  const bazaar = out.offers.find((o) => o.shop_name === "بازار");
  assert.equal(bazaar.guarantee, "enabled");
  assert.deepEqual(bazaar.installment_providers, ["بلوبانک", "تارا"]);
  assert.equal(bazaar.is_adv, true);
  // The no-score shop is never presented as best rated.
  assert.notEqual(out.best_rated_offer.shop_name, "بی‌امتیاز");
});

test("a cold compare reports each miss in its own row without runaway lookups", async () => {
  // Five ids the server has never seen, each with no details_url: every row
  // must come back with its own error, and the whole comparison must stay
  // within the shared lookup budget instead of hammering Torob.
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
  ];
  const seen = [];
  stub((url) => {
    seen.push(url);
    if (url.includes("/details/")) return { random_key: "someone-else", name1: "چیز دیگر", products_info: { result: [] } };
    return { results: [], count: 0, next: "" };
  });
  const out = await run("compare_products", { prks: ids });
  assert.equal(out.requested, 5);
  assert.equal(out.compared, 0);
  assert.equal(out.partial_failure, true);
  assert.equal(out.products.length, 5);
  assert.ok(out.products.every((p) => p.error));
  // One details attempt per id - the budget is spent, not blown.
  assert.equal(seen.filter((u) => u.includes("/details/")).length, 5);
});

test("find_best_value can read postage for the cheapest picks", async () => {
  stub((url) => (url.includes("/details/") ? detailsPayload : searchPayload));
  const out = await run("find_best_value", { query: "ایفون", budget_toman: 60000000, include_delivery: true });
  assert.equal(out.delivered.length, 1);
  assert.equal(out.delivered[0].prk, "prk-aaa");
  assert.equal(out.delivered[0].cheapest_delivered_offer.price_toman, 50000000);
  assert.match(out.delivery_note, /postage/i);
});

test("similar_products accepts the details_url as proof the id is real", async () => {
  // Without a search or a memory of the product, the prk alone is nothing;
  // the details URL that came with the card is what confirms it.
  const id = "7c2d4f10-8a3b-4c5d-9e6f-1a2b3c4d5e6f";
  stub((url) => {
    if (url.includes("similar-base-product")) {
      return {
        results: [
          {
            random_key: "b-2",
            name1: "آیفون ۱۳",
            price: 48000000,
            web_client_absolute_url: "/p/b-2/",
            more_info_url: "https://api.torob.com/v4/base-product/details/?search_id=s3&prk=b-2",
          },
        ],
        count: 1,
      };
    }
    return searchPayload;
  });
  const out = await run("similar_products", {
    prk: id,
    details_url: `https://api.torob.com/v4/base-product/details/?search_id=s7&prk=${id}`,
  });
  assert.equal(out.found, 1);
  assert.equal(out.products[0].name_fa, "آیفون ۱۳");
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

// The search cache key used to leave out `brand` and `city`, so a second search
// with the same words and a different brand or city came back from the cache
// as if the filter had never changed - an unfiltered or wrongly filtered list
// that read as the answer. Each query below is unique to its test so no other
// test's cached search can satisfy it.
test("a different brand is a different search, not a cache hit", async () => {
  const seen = [];
  stub((url) => {
    seen.push(url);
    return searchPayload;
  });
  await run("search_products", { query: "کلید-برند-یک", brand: "apple" });
  await run("search_products", { query: "کلید-برند-یک", brand: "samsung" });
  assert.equal(seen.length, 2, "the second brand must reach upstream");
  assert.match(seen[0], /brand=apple/);
  assert.match(seen[1], /brand=samsung/);
});

test("a different city is a different search, not a cache hit", async () => {
  const seen = [];
  stub((url) => {
    seen.push(url);
    return searchPayload;
  });
  await run("search_products", { query: "کلید-شهر-یک", city: "1" });
  await run("search_products", { query: "کلید-شهر-یک", city: "2" });
  assert.equal(seen.length, 2, "the second city must reach upstream");
  assert.match(seen[0], /city=1(&|$)/);
  assert.match(seen[1], /city=2(&|$)/);
});

test("the same brand and city still share one cache entry", async () => {
  let calls = 0;
  stub(() => {
    calls += 1;
    return searchPayload;
  });
  await run("search_products", { query: "کلید-یکسان", brand: "apple", city: "1" });
  await run("search_products", { query: "کلید-یکسان", brand: "apple", city: "1" });
  assert.equal(calls, 1);
});
