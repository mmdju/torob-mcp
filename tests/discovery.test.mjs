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

// The same search with a choice group: the fixture's `storage` group offers
// "1 tb" and "2 tb" under Persian names.
const storagePayload = {
  ...searchPayload,
  attributes: [
    {
      title: "حافظه",
      slug: "storage",
      type: "multiple_choice",
      items: [
        { name: "۱ ترابایت", value: "1 tb" },
        { name: "۲ ترابایت", value: "2 tb" },
      ],
    },
  ],
};

// ------------------------------------------------------------------ filters

test("search_products reports the filter groups the search really accepts", async () => {
  stub(() => searchPayload);
  const out = await run("search_products", { query: "ایفون" });
  const slugs = out.available_filters.map((f) => f.slug);
  assert.deepEqual(slugs, ["price", "available", "torobpay", "brand"]);
  assert.match(out.total_matches_note, /approximate/i);
  const brand = out.available_filters.find((f) => f.slug === "brand");
  assert.equal(brand.values, 2);
  assert.match(brand.values_url, /brand\/list/);
  assert.equal(brand.options[0].name, "سامسونگ");
  // Torob filters on the brand id; the slug is only there to recognise it by.
  assert.equal(brand.options[0].value, "5");
  assert.equal(brand.options[0].slug, "samsung");
  // A brand list is a preview - the value is passed through unchecked.
  assert.equal(brand.options_truncated, true);
  // A price group is a range, not choices: it has no options to pass back.
  const price = out.available_filters.find((f) => f.slug === "price");
  assert.equal(price.options, undefined);
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

test("a filter value the group does not offer is refused with the real ones", async () => {
  // Torob ignores a value it does not know, so a typo would come back as an
  // unfiltered list that looks filtered. The refusal names the values that do
  // work. The fixture's `storage` group offers "1 tb" and "2 tb".
  stub(() => storagePayload);
  await assert.rejects(
    () => run("search_products", { query: "تبلت", filters: { storage: "4 tb" } }),
    /not a value 'storage' accepts/
  );
});

test("a remembered filter set turns 'true' into Torob's own '1'", async () => {
  // First call teaches the server this query's filter surface; the second can
  // canonicalize before spending an upstream request instead of refusing a
  // value that is not literally "1".
  stub(() => searchPayload);
  await run("search_products", { query: "هدفون سونی" });
  const out = await run("search_products", { query: "هدفون سونی", filters: { available: "true" } });
  assert.equal(out.filters_applied.available, "1");
});

test("a remembered filter set maps a display name onto its value", async () => {
  // The Persian name a shopper reads is not the value Torob takes: the
  // remembered group maps one onto the other, so the honest name works.
  stub(() => storagePayload);
  await run("search_products", { query: "تبلت سامسونگ" });
  let seen = "";
  stub((url) => {
    seen = url;
    return storagePayload;
  });
  const out = await run("search_products", { query: "تبلت سامسونگ", filters: { storage: "۱ ترابایت" } });
  assert.equal(out.filters_applied.storage, "1 tb");
  assert.match(seen, /storage=1(%20|\+)tb/);
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
  // like "Iran has no provinces". The full 31, because the default limit used
  // to be 30: the last one was dropped and the answer reported count: 30, so
  // nothing in the response said one was missing.
  const results = [{ id: 1, name: "آذربایجان شرقی" }].concat(
    Array.from({ length: 30 }, (_, i) => ({ id: i + 2, name: `استان ${i + 2}` }))
  );
  stub(() => ({ count: 31, next: null, previous: null, results }));
  const out = await run("list_locations", {});
  assert.equal(out.mode, "provinces");
  assert.equal(out.provinces[0].name, "آذربایجان شرقی");
  assert.equal(out.provinces.length, 31, "all 31 provinces fit the default, so none is dropped");
  assert.equal(out.count, 31);
  assert.equal(out.truncated, undefined);
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
  // The bug this guards: rows whose fields this server does not recognise are
  // all dropped, and `[]` reads as "there are no cities" - the wrong answer in
  // the direction a caller acts on (measured: `title` against `name` on the
  // location endpoints). Uses a city search (its own cache key) so it cannot
  // shadow the province list cached above.
  stub(() => ({ count: 2, results: [{ wrong_field: 1 }, { wrong_field: 2 }] }));
  await assert.rejects(() => run("list_locations", { search: "شکل-خراب" }), /could not read/);
});

test("a city search that matches nothing reports an empty list", async () => {
  // Nothing found is a different answer from nothing readable, and only the
  // first one may be an empty list.
  stub(() => ({ count: 0, results: [] }));
  const out = await run("list_locations", { search: "ناموجود" });
  assert.deepEqual(out.cities, []);
  assert.equal(out.count, 0);
});

// ------------------------------------------------------------------ brand

// Torob filters a search on the brand's numeric id, not on its slug. Measured
// on 2026-10-02 against the router category (1248): `brand=17418` returned 26
// of 26 MikroTik rows, while `brand=mikrotik-میکروتیک` - the slug, encoded once
// - came back unfiltered (10 of 26), exactly as an unknown brand does. The
// site's own brand chip sends `brand=17418&brand_name=<slug>`. The brand items
// arrive as {id, slug, name1, name2} with the slug already percent-encoded.
const MIKROTIK_SLUG = "mikrotik-%D9%85%DB%8C%DA%A9%D8%B1%D9%88%D8%AA%DB%8C%DA%A9";
const routerPayload = {
  ...searchPayload,
  categories: [{ id: "1248", title: "روتر" }],
  attributes: [
    {
      title: "انتخاب برند",
      slug: "brand",
      type: "brand",
      items: [
        { id: 17418, slug: MIKROTIK_SLUG, name1: "میکروتیک", name2: "Mikrotik" },
        { id: 32, slug: "tp-link-%D8%AA%DB%8C-%D9%BE%DB%8C-%D9%84%DB%8C%D9%86%DA%A9", name1: "تی پی-لینک", name2: "TP-Link" },
      ],
      url: "https://api.torob.com/v4/brand/list/?cat_list=1248",
    },
  ],
};
const brandSent = (url) => new URL(url).searchParams.get("brand");

test("the brand value a search advertises is the id Torob filters on", async () => {
  const seen = [];
  stub((url) => {
    seen.push(url);
    return routerPayload;
  });
  const first = await run("search_products", { query: "روتر برند-شناسه", category: "1248" });
  const option = first.available_filters.find((f) => f.slug === "brand").options[0];
  assert.equal(option.name, "میکروتیک");
  assert.equal(option.value, "17418");
  // Readable, not percent-encoded: it is there to recognise, not to send.
  assert.equal(option.slug, "mikrotik-میکروتیک");
  await run("search_products", { query: "روتر برند-شناسه", category: "1248", brand: option.value });
  assert.equal(brandSent(seen.at(-1)), "17418");
});

test("a brand slug from an earlier answer is sent as the brand id", async () => {
  // Older answers advertised the slug, encoded as Torob sent it. A caller that
  // still passes it, in either spelling, must not get an unfiltered list.
  const seen = [];
  stub((url) => {
    seen.push(url);
    return routerPayload;
  });
  await run("search_products", { query: "روتر برند-اسلاگ", category: "1248" });
  await run("search_products", { query: "روتر برند-اسلاگ", category: "1248", brand: MIKROTIK_SLUG });
  assert.equal(brandSent(seen.at(-1)), "17418");
  await run("search_products", { query: "روتر برند-اسلاگ", category: "1248", brand: "mikrotik-میکروتیک" });
  assert.equal(brandSent(seen.at(-1)), "17418");
});

test("a brand name is sent as the brand id", async () => {
  const seen = [];
  stub((url) => {
    seen.push(url);
    return routerPayload;
  });
  await run("search_products", { query: "روتر برند-نام", category: "1248" });
  await run("search_products", { query: "روتر برند-نام", category: "1248", brand: "میکروتیک" });
  assert.equal(brandSent(seen.at(-1)), "17418");
});

test("brand_values carry the id that brand takes", async () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    id: 100 + i,
    slug: `brand-${i}-%D8%A8%D8%B1%D9%86%D8%AF`,
    name1: `برند ${i}`,
  }));
  stub(() => ({ ...routerPayload, attributes: [{ title: "انتخاب برند", slug: "brand", type: "brand", items }] }));
  const out = await run("search_products", { query: "روتر برند-فهرست" });
  assert.equal(out.brand_values.length, 12);
  assert.deepEqual(out.brand_values[0], { name: "برند 0", value: "100", slug: "brand-0-برند" });
  assert.match(out.brand_values_note, /value/);
});

test("a brand id is sent unchanged, even with no earlier search", async () => {
  const seen = [];
  stub((url) => {
    seen.push(url);
    return routerPayload;
  });
  await run("search_products", { query: "روتر برند-سرد", brand: "17418" });
  assert.equal(seen.length, 1);
  assert.equal(brandSent(seen[0]), "17418");
});

test("an unknown brand value is still passed through unchecked", async () => {
  // The brand group is a preview, so a value outside it may be real.
  const seen = [];
  stub((url) => {
    seen.push(url);
    return routerPayload;
  });
  await run("search_products", { query: "روتر برند-ناشناس", category: "1248" });
  await run("search_products", { query: "روتر برند-ناشناس", category: "1248", brand: "99999" });
  assert.equal(brandSent(seen.at(-1)), "99999");
});

test("a brand wording the search cannot map is refused with the brands it does offer", async () => {
  // A word that maps to nothing upstream is ignored, so sending it would return
  // every brand's product under a brand filter that was never applied. An id is
  // still accepted as given (the preview may not list it) - a word cannot be.
  stub(() => routerPayload);
  await run("search_products", { query: "روتر برند-بی‌معنا", category: "1248" });
  await assert.rejects(
    () => run("search_products", { query: "روتر برند-بی‌معنا", category: "1248", brand: "برند-غیر معین" }),
    /is not a brand this search offers/
  );
  await assert.rejects(
    () => run("search_products", { query: "روتر برند-بی‌معنا", category: "1248", brand: "برند-غیر معین" }),
    /17418/
  );
});

test("a brand inside filters takes the brand path instead of being reported as applied", async () => {
  // `brand` compiles to its own upstream parameter. Echoing it back inside
  // filters_applied claimed a filter had been applied when only the brand
  // argument ever reached upstream.
  const seen = [];
  stub((url) => {
    seen.push(url);
    return routerPayload;
  });
  const out = await run("search_products", {
    query: "روتر برند-داخل-فیلتر",
    category: "1248",
    filters: { brand: "17418" },
  });
  assert.equal(brandSent(seen.at(-1)), "17418");
  assert.equal(out.filters_applied, undefined, "the brand is its own argument, not an applied filter");
});

test("a search that carried a brand still teaches this query its filters", async () => {
  // The filter memory is keyed on the query and its category/city/shop type.
  // It used to include the brand as well, while its reader did not - so every
  // brand-bearing search wrote an entry nothing could read back, and the next
  // call paid for a search that a remembered group would have refused first.
  let fetches = 0;
  stub(() => {
    fetches += 1;
    return storagePayload;
  });
  await run("search_products", {
    query: "روتر-حافظه-برند-آزمون",
    category: "1248",
    brand: "17418",
    filters: { storage: "1 tb" },
  });
  const afterWarm = fetches;
  await assert.rejects(
    () => run("search_products", { query: "روتر-حافظه-برند-آزمون", category: "1248", filters: { storage: "9 tb" } }),
    /not a value 'storage' accepts/
  );
  assert.equal(fetches, afterWarm, "the refusal must come from memory, before an upstream request");
});
