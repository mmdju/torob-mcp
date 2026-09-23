// The discovery tools (similar, categories, locations, offers) and the filter
// path on search. All against a stubbed fetch, shaped like the live payloads
// probed on 2026-09-24.
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
// The projection caches upstream responses in module state that outlives a
// single test, so a payload from an earlier test would answer a later one. Each
// test below uses a distinct category id / province id so its cache key is
// its own.

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  resetBreakerForTests();
});

const run = (name, args) => TOOLS.find((t) => t.name === name).run(args);

const ID = "2ee0949f-e7de-4cd8-a45a-ea5bad3eff95";

const searchPayload = {
  results: [
    {
      random_key: ID,
      name1: "گوشی ایفون ۱۳",
      price: 50000000,
      price_text: "۵۰٫۰۰۰٫۰۰۰ تومان",
      web_client_absolute_url: `/p/${ID}/`,
      more_info_url: `https://api.torob.com/v4/base-product/details/?search_id=s1&prk=${ID}`,
    },
  ],
  count: 1200,
  min_price: 0,
  max_price: 90000000,
  next: "https://api.torob.com/v4/base-product/search/?q=x&page=1",
  categories: [{ id: "94", title: "گوشی موبایل" }],
  // The live filter payload: 13 range groups, 5 toggles, 12 attribute groups.
  filters1: [
    { title: "قیمت", slug: "price", type: "price", items: [{ slug: "price__gt", value: 0 }, { slug: "price__lt", value: 0 }] },
    { title: "موجودی", slug: "available", type: "toggle", items: [{ slug: "available", value: 1 }] },
  ],
  filters2: [{ title: "خرید قسطی ترب‌پی", slug: "torobpay", type: "toggle", items: [] }],
  attributes: [
    {
      title: "انتخاب برند",
      slug: "brand",
      type: "brand",
      items: [{ id: 5, slug: "samsung", name1: "سامسونگ" }, { id: 1, slug: "apple", name1: "اپل" }],
      url: "https://api.torob.com/v4/brand/list/?cat_list=94",
    },
  ],
};

// ------------------------------------------------------------------ filters

test("search_products reports the filter groups the search really accepts", async () => {
  stub(() => searchPayload);
  const out = await run("search_products", { query: "ایفون" });
  const slugs = out.available_filters.map((f) => f.slug);
  assert.deepEqual(slugs, ["price", "available", "torobpay", "brand"]);
  const brand = out.available_filters.find((f) => f.slug === "brand");
  assert.equal(brand.values, 2);
  assert.match(brand.values_url, /brand\/list/);
  assert.equal(brand.sample[0].label, "سامسونگ");
});

test("min_price_toman and max_price_toman become Torob's own slugs", async () => {
  let seen = "";
  stub((url) => {
    seen = url;
    return searchPayload;
  });
  const out = await run("search_products", { query: "ایفون", min_price_toman: 1000000, max_price_toman: 60000000 });
  assert.deepEqual(out.filters_applied, { price__gt: "1000000", price__lt: "60000000" });
  assert.match(seen, /price__gt=1000000/);
  assert.match(seen, /price__lt=60000000/);
});

test("a reversed price window is refused instead of returning nothing", async () => {
  stub(() => searchPayload);
  await assert.rejects(
    () => run("search_products", { query: "x", min_price_toman: 90000000, max_price_toman: 1000000 }),
    /nothing can match/
  );
});

test("an unknown filter slug is refused with the real ones", async () => {
  // Torob ignores an unknown slug and answers unfiltered, which looks like a
  // filtered result. Refusing is the only honest option.
  stub(() => searchPayload);
  await assert.rejects(
    () => run("search_products", { query: "x", filters: { colour: "red" } }),
    /not a filter this search accepts/
  );
});

test("a known filter slug is passed through", async () => {
  let seen = "";
  stub((url) => {
    seen = url;
    return searchPayload;
  });
  const out = await run("search_products", { query: "ایفون", filters: { available: "1" } });
  assert.match(seen, /available=1/);
  assert.equal(out.filters_applied.available, "1");
});

// ------------------------------------------------------------------ similar

test("similar_products returns comparable products for one this server knows", async () => {
  stub((url) => {
    if (url.includes("similar-base-product")) {
      return {
        results: [
          { random_key: "b-1", name1: "آیفون ۱۳", price: 48000000, web_client_absolute_url: "/p/b-1/", more_info_url: "https://api.torob.com/v4/base-product/details/?search_id=s2&prk=b-1" },
        ],
        count: 1,
      };
    }
    return searchPayload;
  });
  await run("search_products", { query: "ایفون ۱۳" }); // warms the id
  const out = await run("similar_products", { prk: ID });
  assert.equal(out.found, 1);
  assert.equal(out.products[0].name_fa, "آیفون ۱۳");
});

test("similar_products explains that an unseen id must be searched first", async () => {
  stub(() => searchPayload);
  await assert.rejects(() => run("similar_products", { prk: "unknown-id" }), /search_products/);
});

// --------------------------------------------------------------- categories

test("browse_categories lists the children of a category", async () => {
  // Live shape: the payload nests under `categories`, with a product count.
  stub(() => ({
    count: 2,
    categories: [
      { id: 94, title: "گوشی موبایل", slug: "موبایل", image: "https://a/b.jpg", absolute_url: "/browse/94/", count: 1200 },
      { id: 95, title: "تبلت", slug: "تبلت", absolute_url: "/browse/95/", count: 0 },
    ],
  }));
  const out = await run("browse_categories", { id: "1" });
  assert.equal(out.parent_id, "1");
  assert.equal(out.count, 2);
  assert.equal(out.categories[0].title, "گوشی موبایل");
  assert.equal(out.categories[0].product_count, 1200);
  assert.equal(out.categories[0].has_children, true);
  assert.equal(out.categories[0].url, "https://torob.com/browse/94/");
  // A category with nothing under it is a leaf, not a broken entry.
  assert.equal(out.categories[1].has_children, false);
  assert.match(out.next, /search_products/);
});

test("browse_categories reports an empty level honestly", async () => {
  stub(() => ({ count: 0, categories: [] }));
  const out = await run("browse_categories", { id: "99999" });
  assert.deepEqual(out.categories, []);
  assert.match(out.next, /no children/);
});

test("browse_categories needs a starting id and says which one", async () => {
  await assert.rejects(() => run("browse_categories", {}), /Start with '1'/);
});

// ---------------------------------------------------------------- locations

test("list_locations returns provinces when no province is given", async () => {
  // Live shape: {count, next, previous, results:[{id, name}]} - the field is
  // `name`, not `title`. Guessing `title` returned an empty list that looked
  // like "Iran has no provinces".
  stub(() => ({ count: 31, next: null, previous: null, results: [{ id: 1, name: "آذربایجان شرقی" }, { id: 8, name: "تهران" }] }));
  const out = await run("list_locations", {});
  assert.equal(out.mode, "provinces");
  assert.equal(out.provinces[0].name, "آذربایجان شرقی");
});

test("list_locations returns a province's cities with a search term", async () => {
  let seen = "";
  stub((url) => {
    seen = url;
    return { count: 1, results: [{ id: 121, name: "تهران" }] };
  });
  const out = await run("list_locations", { province_id: "8", search: "تهران" });
  assert.equal(out.mode, "cities");
  assert.equal(out.cities[0].name, "تهران");
  assert.match(seen, /province=8/);
  assert.match(seen, /search=/);
  assert.match(out.next, /search_products/);
});

// ------------------------------------------------------------------- offers

test("special_offers returns the featured banners, clearly not shop data", async () => {
  // Live shape: grouped banners under results[].data[], each with a link.
  stub(() => ({
    name: "پیشنهادهای ویژه",
    count: 1,
    results: [
      {
        type: 1,
        data: [{ title: "خرید قسطی", description: "با ترب‌پی", desktop_image_url: "https://image.torob.com/b.jpg", more_info_url: "https://torobpay.com/?x=1" }],
      },
    ],
  }));
  const out = await run("special_offers", {});
  assert.equal(out.count, 1);
  assert.equal(out.offers[0].title, "خرید قسطی");
  assert.equal(out.offers[0].group, "پیشنهادهای ویژه");
  assert.equal(out.offers[0].url, "https://torobpay.com/?x=1");
  assert.match(out.note, /product_details/);
});

test("a wrong field name is a failure, not an empty answer", async () => {
  // The bug this guards: an endpoint that answers 200 with an unexpected shape
  // produced `[]` and read as "Torob has no provinces". The projection must
  // report nothing only when there is nothing. Uses a city search (its own
  // cache key) so it cannot shadow the province list cached above.
  stub(() => ({ count: 0, results: [] }));
  const out = await run("list_locations", { search: "ناموجود" });
  assert.deepEqual(out.cities, []);
  assert.equal(out.count, 0);
});
