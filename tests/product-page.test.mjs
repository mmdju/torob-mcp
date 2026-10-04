// What a product page already knows, and what a search's own filters say about
// a result set. Fixtures are copied from live payloads probed on 2026-10-01.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "../dist/tools.js";
import {
  brandValuesOf,
  categoryPathOf,
  inPersonSellersOf,
  priceBoundsOf,
  purchaseOptionsOf,
  specsOf,
  variantsOf,
} from "../dist/project.js";
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
test.afterEach(async () => {
  globalThis.fetch = originalFetch;
  await resetBreakerForTests();
});
const run = (name, args) => TOOLS.find((t) => t.name === name).run(args);

const liveInStoreShop = {
  prk: "26f65e3c-303f-4e9a-9e8b-391248767039",
  shop_id: 152418,
  name1: "خیابان سعدی، بین سعدی...",
  name2: "تست و تحویل در حضور مشتری",
  shop_name: "شهاب دیجیتال",
  shop_name2: "مشهد",
  working_hours: { type: "schedule", title: { status: "بسته", text: "تا ۰۹:۰۰ امروز" } },
  is_open: false,
  price: 890000,
  price_string: "۸۹۰٫۰۰۰ تومان",
  is_price_unreliable: false,
  last_price_change_date: "۸ ماه و ۹ روز پیش",
  supports_fast_delivery: true,
  location: { lat: 36.294835528386756, lon: 59.6006706612004 },
};

const detailsPayload = {
  random_key: "ca10472a-7b83-4e75-b6ad-111576e83d6d",
  name1: "هدفون جی بی ال مدل Tune 510 BT",
  price: 689999,
  price_text: "از ۶۸۹٫۹۹۹ تومان",
  min_price: 689999,
  max_price: 7700000,
  image_url: "https://image.torob.com/base/images/8_/oJ/x.jpg",
  image_count: 2,
  products_info: {
    title: "فروشنده‌ها",
    result: [
      { shop_name: "زوبین کالا", shop_id: 365234, shop_score: 5, shop_votes_count: 0, price: 689999, availability: true },
      { shop_name: "موبو۱۸", shop_id: 416370, shop_score: 5, shop_votes_count: 0, price: 950000, availability: true },
    ],
  },
  products_in_store_info: {
    count: 2,
    is_visible: true,
    map_sellers_url: "https://torob.com/map-sellers/?prk=ca10472a-7b83-4e75-b6ad-111576e83d6d&seed=1",
    result: [
      liveInStoreShop,
      { ...liveInStoreShop, shop_id: 999, shop_name: "گران‌فروش", price: 1200000, price_string: "۱٫۲۰۰٫۰۰۰ تومان" },
    ],
  },
  key_specs: [{ header: "مشخصات کلیدی", items: [{ key: "نسخه Bluetooth", value: ["5"] }] }],
  structural_specs: {
    headers: [{ header: "مشخصات کلی", specs: { "بدنه": "title", "وزن": "160 گرم", "پلتفرم": "title" } }],
  },
  breadcrumbs: [
    { id: 0, title: "ترب", cat_id: 0 },
    { id: 175, title: "موبایل و کالای دیجیتال", cat_id: 175 },
    { id: 97, title: "هدفون، هدست و هندزفری", cat_id: 97 },
  ],
  variants: [
    {
      title: "اصالت کالا",
      items: [
        {
          random_key: "other-1",
          name1: "هدفون جی بی ال (اورجینال)",
          price: 720000,
          more_info_url: "https://api.torob.com/v4/base-product/details/?prk=other-1",
        },
      ],
    },
  ],
  filters: {
    items: [
      { title: "دارای ضمانت ترب", price_str: "از ۹۵۵٫۰۰۰ تومان", online_shop_display_count: 5, offline_shop_display_count: 0 },
    ],
  },
  is_authentic: false,
  has_wiki: true,
};

const detailsUrl = "https://api.torob.com/v4/base-product/details/?search_id=s1&prk=ca10472a-7b83-4e75-b6ad-111576e83d6d";

// The response cache lives for the whole test process, so a test that stubs a
// different payload gets its own product id rather than the previous answer.
let seq = 40;
function fresh() {
  seq += 1;
  const id = `00000000-0000-4000-9000-${String(seq).padStart(12, "0")}`;
  return { id, details_url: `https://api.torob.com/v4/base-product/details/?search_id=s${seq}&prk=${id}` };
}

test("in-person shops come cheapest first and keep the age of their price", () => {
  const out = inPersonSellersOf({ products_in_store_info: detailsPayload.products_in_store_info });
  assert.equal(out.count, 2);
  assert.equal(out.sellers[0].shop_name, "شهاب دیجیتال");
  assert.equal(out.sellers[1].shop_name, "گران‌فروش");
  const first = out.sellers[0];
  assert.equal(first.city, "مشهد");
  assert.equal(first.hours_status, "بسته");
  // A shelf price can be months old: the age travels with the number.
  assert.equal(first.last_price_change_date, "۸ ماه و ۹ روز پیش");
  assert.equal(first.url, "https://torob.com/shop/152418/");
  assert.equal(out.map_url, detailsPayload.products_in_store_info.map_sellers_url);
});

test("a product with no in-person shop reports zero and no map", () => {
  const out = inPersonSellersOf({ products_in_store_info: { count: 0, is_visible: false, result: [] } });
  assert.equal(out.count, 0);
  assert.deepEqual(out.sellers, []);
  assert.equal(out.map_url, null);
  // A link that is not Torob's own is never handed out as the map.
  assert.equal(inPersonSellersOf({ products_in_store_info: { map_sellers_url: "https://evil.test/", result: [] } }).map_url, null);
});

test("specs drop Torob's own group markers and stay capped", () => {
  const out = specsOf(detailsPayload);
  assert.deepEqual(
    out.items.map((i) => [i.group, i.key, i.value]),
    [
      ["مشخصات کلیدی", "نسخه Bluetooth", "5"],
      ["مشخصات کلی", "وزن", "160 گرم"],
    ]
  );
  assert.ok(!out.items.some((i) => i.value === "title"));
  assert.equal(out.truncated, false);

  const many = {};
  for (let i = 0; i < 40; i += 1) many[`کلید ${i}`] = `مقدار ${i}`;
  const capped = specsOf({ structural_specs: { headers: [{ header: "جدول", specs: many }] } });
  assert.equal(capped.items.length, 24);
  assert.equal(capped.available, 40);
  assert.equal(capped.truncated, true);
});

test("variants, category path and purchase options keep Torob's own labels", () => {
  const variants = variantsOf(detailsPayload);
  assert.equal(variants[0].title, "اصالت کالا");
  assert.equal(variants[0].count, 1);
  assert.equal(variants[0].items[0].price_toman, 720000);

  assert.deepEqual(categoryPathOf(detailsPayload), [
    { id: "175", title: "موبایل و کالای دیجیتال" },
    { id: "97", title: "هدفون، هدست و هندزفری" },
  ]);

  const options = purchaseOptionsOf(detailsPayload);
  assert.equal(options[0].price_from_text, "از ۹۵۵٫۰۰۰ تومان");
  assert.equal(options[0].online_sellers, 5);
});

test("product_details carries the in-person shops, specs and the full price window", async () => {
  const product = fresh();
  stub((url) => (url.includes("/details/") ? { ...detailsPayload, random_key: product.id } : { results: [], count: 0, next: "" }));
  const out = await run("product_details", { prk: product.id, details_url: product.details_url });

  assert.equal(out.offer_count, 2);
  assert.deepEqual(out.price_range_toman, { min: 689999, max: 7700000 });
  assert.equal(out.in_person_count, 2);
  assert.equal(out.in_person_sellers.length, 2);
  assert.equal(out.in_person_map_url, detailsPayload.products_in_store_info.map_sellers_url);
  // The age of a shelf price is stated, not hidden behind a bare number.
  assert.match(out.in_person_note, /can be old/i);
  assert.match(out.in_person_sellers[0].last_price_change_date, /پیش/);
  assert.equal(out.specs.length, 2);
  assert.equal(out.variants[0].title, "اصالت کالا");
  assert.equal(out.category_path[1].id, "97");
  assert.equal(out.purchase_options[0].online_sellers, 5);
  assert.equal(out.has_wiki, true);
  // is_authentic was false upstream: an absent flag is not a claim of fake.
  assert.equal(out.is_authentic, undefined);
});

test("product_details caps the in-person list and says how many exist", async () => {
  const product = fresh();
  const many = Array.from({ length: 14 }, (_, i) => ({ ...liveInStoreShop, shop_id: 1000 + i, shop_name: `فروشگاه ${i}`, price: 100000 + i }));
  stub((url) =>
    url.includes("/details/")
      ? { ...detailsPayload, random_key: product.id, products_in_store_info: { count: 14, result: many } }
      : {}
  );
  const out = await run("product_details", { prk: product.id, details_url: product.details_url, max_in_person: 5 });
  assert.equal(out.in_person_count, 14);
  assert.equal(out.in_person_sellers.length, 5);
  assert.equal(out.in_person_truncated, true);
  assert.match(out.in_person_truncated_note, /14 in-person shops/);
});

test("search_products reports the search's own price window and full brand list", async () => {
  const brandItems = Array.from({ length: 14 }, (_, i) => ({ id: i + 1, slug: `brand-${i + 1}`, name1: `برند ${i + 1}` }));
  stub(() => ({
    results: [
      {
        random_key: "prk-aaa",
        name1: "هدفون",
        price: 689999,
        price_text: "۶۸۹٫۹۹۹ تومان",
        more_info_url: "https://api.torob.com/v4/base-product/details/?search_id=s1&prk=prk-aaa",
      },
    ],
    count: 1200,
    min_price: 0,
    max_price: 444480000,
    next: "https://api.torob.com/v4/base-product/search/?page=1",
    attributes: [{ title: "انتخاب برند", slug: "brand", type: "brand", items: brandItems }],
    filters1: [
      { title: "قیمت", slug: "price", type: "price", items: [{ value: 47985, slug: "price__gt" }, { value: 444480000, slug: "price__lt" }] },
    ],
  }));

  const out = await run("search_products", { query: "هدفون برنددار" });
  assert.deepEqual(out.price_bounds_toman, { min: 47985, max: 444480000 });
  assert.equal(out.brand_values.length, 14);
  assert.equal(out.brand_values[0].slug, "brand-1");
  assert.match(out.brand_values_note, /preview/);
});

test("a short brand list stays in available_filters where it already is", async () => {
  // Duplicating three brands in two shapes would only make the answer longer.
  const brandItems = [{ id: 1, slug: "anker-انکر", name1: "انکر" }];
  stub(() => ({
    results: [],
    count: 0,
    attributes: [{ title: "انتخاب برند", slug: "brand", type: "brand", items: brandItems }],
    filters1: [],
    filters2: [],
  }));
  const out = await run("search_products", { query: "هدفون کم‌برند" });
  assert.equal(out.brand_values, undefined);
  assert.equal(brandValuesOf({ attributes: [{ type: "brand", items: brandItems }] }).values.length, 1);
  assert.deepEqual(priceBoundsOf({ filters1: [], filters2: [] }), null);
});
