// Shops, pictures and trends: the tools that answer questions a product search
// cannot. Fixtures are copied from live payloads probed on 2026-10-01.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "../dist/tools.js";
import { shopsOf, shopProfileOf, trendsOf } from "../dist/project.js";
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

const shopPayload = {
  id: 365234,
  name: "زوبین کالا",
  domain: "zoobinkala.com",
  shop_type: "online",
  city: "بانه",
  province: "کردستان",
  address: "استان : کردستان - شهرستان : بانه",
  shop_logo: "https://storage3.torob.com/backend-api/internet_shop/logos/a85b5e80d166.png",
  enamad_level: "نماد بدون ستاره",
  enamad_expire_date: "اعتبار تا تاریخ ۱۴۰۶/۰۶/۱۷",
  licenses: [{ title: "وضعیت نماد: فعال (بدون ستاره)", description_1: "تاریخ اخذ نماد اعتماد: ۱۴۰۴/۱۲/۲۷" }],
  score_info: ["امتیاز: ۴.۹ از ۵", "۲ پیگیری سفارش خاتمه یافته با وضعیت تخلف فروشگاه"],
  date_added: "۱۴۰۵/۰۱/۰۹ (۶ ماه پیش)",
  active_time: "۵ ماه و ۳ هفته",
  last_updated: "تاریخ بروزرسانی: ۹ فروردین",
  block_description: "فعال",
  shop_score: 5,
  score_percentile: 0,
  payment_info: { items: ["امکان پرداخت در محل در همدان، تهران"] },
  delivery_info: { items: ["روش‌های ارسال: شرکت‌های پست خصوصی"] },
  customer_support_info: { schedule: "۷ روز هفته و ۲۴ ساعت شبانه روز", badges: [{ title: "تماس تلفنی" }] },
  guarantee_info: { status: "disabled" },
  is_marketplace: false,
};

const cataloguePayload = {
  results: [
    {
      random_key: "1448f849-66d1-4ddd-8db4-fd6f6b40a8e9",
      name1: "هندزفری انکر مدل Soundcore R50i",
      name2: "Anker Soundcore R50i",
      price: 2500000,
      price_text: "۲٫۵۰۰٫۰۰۰ تومان",
      shop_text: "در زوبین کالا",
      more_info_url: "https://api.torob.com/v4/base-product/details/?prk=1448f849-66d1-4ddd-8db4-fd6f6b40a8e9",
    },
  ],
  count: 412,
  min_price: 47376,
  max_price: 18000000,
  next: "https://api.torob.com/v4/internet-shop/base-product/list/?shop_id=365234&page=1",
};

test("a shop profile reads Torob's seal, notes and link", () => {
  const profile = shopProfileOf(shopPayload, "365234");
  assert.equal(profile.name, "زوبین کالا");
  assert.equal(profile.website, "https://zoobinkala.com");
  assert.equal(profile.url, "https://torob.com/shop/365234/");
  assert.equal(profile.trust_seal.level, "نماد بدون ستاره");
  assert.equal(profile.active_time, "۵ ماه و ۳ هفته");
  // Torob's own sentences travel as sent, including the violation note.
  assert.match(profile.score_notes[1], /تخلف فروشگاه/);
  assert.equal(profile.payment[0], "امکان پرداخت در محل در همدان، تهران");
  assert.equal(profile.support.badges[0], "تماس تلفنی");
  assert.equal(profile.guarantee, "disabled");
});

test("shop_profile returns the profile and, when asked, the catalogue", async () => {
  const seen = [];
  stub((url) => {
    seen.push(url);
    if (url.includes("base-product/list")) return cataloguePayload;
    return shopPayload;
  });

  const profile = await run("shop_profile", { shop_id: "365234" });
  assert.equal(profile.name, "زوبین کالا");
  assert.equal(profile.catalogue_products, undefined);
  // The catalogue costs an extra request, so it is not read unless asked.
  assert.equal(seen.filter((u) => u.includes("base-product/list")).length, 0);

  seen.length = 0;
  const withCatalogue = await run("shop_profile", { shop_id: "365234", include_products: true });
  assert.equal(withCatalogue.catalogue_count, 412);
  assert.deepEqual(withCatalogue.catalogue_price_range_toman, { min: 47376, max: 18000000 });
  assert.equal(withCatalogue.catalogue_products[0].prk, "1448f849-66d1-4ddd-8db4-fd6f6b40a8e9");
  assert.equal(seen.filter((u) => u.includes("base-product/list")).length, 1);
  // The catalogue page is asked for 0-based, the way upstream pages.
  assert.match(seen.find((u) => u.includes("base-product/list")), /page=0/);
});

test("shop_profile refuses an id that is not a shop id", async () => {
  await assert.rejects(() => run("shop_profile", { shop_id: "زوبین کالا" }), /not a Torob shop id/);
  await assert.rejects(() => run("shop_profile", {}), /needs a shop_id/);
});

test("find_shops lists shops with the id shop_profile needs", async () => {
  stub(() => ({
    count: 11124,
    results: [
      { id: 494303, name: "موبایل رضا موبایلچی", shop_type: "offline", city: "تبریز", shop_logo: "https://image.torob.com/a.jpg" },
      { id: 417194, name: "ایت پی سی استور", shop_type: "online", city: "تهران" },
    ],
    next: "https://api.torob.com/v4/internet-shop/list/?page=1",
  }));
  const out = await run("find_shops", { query: "موبایل", limit: 10 });
  assert.equal(out.total_shops, 11124);
  assert.equal(out.has_next_page, true);
  assert.equal(out.shops[0].id, "494303");
  assert.equal(out.shops[0].url, "https://torob.com/shop/494303/");
  assert.match(out.note, /shop_profile/);
});

test("find_shops says so when nothing matches", async () => {
  stub(() => ({ count: 0, results: [], next: "" }));
  const out = await run("find_shops", { query: "فروشگاهی که نیست" });
  assert.equal(out.shops.length, 0);
  assert.match(out.note, /No shop matched/);
});

test("a page past the directory's own maximum says it was clamped", async () => {
  // This pager stops at 20 while the shared convention promises 50. Clamped
  // silently, page 21 came back as page 20 with nothing to say so - an agent
  // would quote the wrong page as fact.
  stub(() => ({ count: 11124, results: [{ id: 494303, name: "موبایل رضا", shop_type: "offline", city: "تبریز" }], next: "" }));
  const out = await run("find_shops", { query: "موبایل", page: 21 });
  assert.equal(out.page, 20);
  assert.equal(out.page_clamped, true);
  assert.equal(out.page_requested, 21);
  assert.match(String(out.page_note), /20/);
});

test("search_by_image sends the link to Torob and keeps what it recognised", async () => {
  const seen = [];
  stub((url) => {
    seen.push(url);
    return {
      results: [
        {
          random_key: "84069e65-9b24-4ca1-9afd-d9f106165e95",
          name1: "هدفون بی‌سیم جی‌بی‌ال JBL Tune 530BT",
          price: 11020000,
          price_text: "۱۱٫۰۲۰٫۰۰۰ تومان",
          more_info_url: "https://api.torob.com/v4/base-product/details/?prk=84069e65-9b24-4ca1-9afd-d9f106165e95",
        },
      ],
      uploaded_image_url: "https://image.torob.com/base/images/8_/oJ/x.jpg",
      detected_objects: { initial: null, sorted: [] },
      searched_product_info: {
        random_key: "84069e65-9b24-4ca1-9afd-d9f106165e95",
        name1: "هدفون بی‌سیم جی‌بی‌ال JBL Tune 530BT",
        price: 11020000,
      },
      next: "",
    };
  });
  const out = await run("search_by_image", { image_url: "https://image.torob.com/base/images/8_/oJ/x.jpg" });
  assert.equal(out.products.length, 1);
  assert.equal(out.matched_product.prk, "84069e65-9b24-4ca1-9afd-d9f106165e95");
  assert.equal(out.image_url, "https://image.torob.com/base/images/8_/oJ/x.jpg");
  assert.match(seen[0], /search-by-image\/\?image_url=/);
});

test("search_by_image refuses anything that is not a URL, or not http", async () => {
  await assert.rejects(() => run("search_by_image", { image_url: "not a url" }), /not a URL/);
  await assert.rejects(() => run("search_by_image", { image_url: "ftp://example.com/a.jpg" }), /only accepts http/);
  await assert.rejects(() => run("search_by_image", { image_url: " " }), /needs an image_url/);
});

test("search_by_image explains an empty match without implying the product is gone", async () => {
  stub(() => ({ results: [], next: "" }));
  const out = await run("search_by_image", { image_url: "https://example.com/a.jpg" });
  assert.equal(out.products.length, 0);
  assert.match(out.note, /not proof/i);
});

test("torob_trends returns wordings with a sample product", async () => {
  stub(() => [
    {
      query: "قیمت طلا 18",
      category_id: 171,
      partial_info: {
        random_key: "81a30976-a494-4f5f-9a8f-61b8e08948fe",
        name1: "انگشتر طلا ۱۸ عیار",
        price: 48543000,
        price_text: "۴۸٫۵۴۳٫۰۰۰ تومان",
        more_info_url: "https://api.torob.com/v4/base-product/details/?prk=81a30976-a494-4f5f-9a8f-61b8e08948fe",
      },
    },
    { query: "قیمت دلار", category_id: 2, partial_info: null },
  ]);
  const out = await run("torob_trends", { limit: 10 });
  assert.equal(out.count, 2);
  assert.equal(out.trends[0].query, "قیمت طلا 18");
  assert.equal(out.trends[0].sample.prk, "81a30976-a494-4f5f-9a8f-61b8e08948fe");
  assert.equal(out.trends[1].sample, null);
});

test("the shop directory and trends projections keep what the tool needs", () => {
  const dir = shopsOf({ count: 11124, results: [{ id: 494303, name: "رضا موبایل", shop_type: "offline" }] }, 10);
  assert.equal(dir.shops[0].url, "https://torob.com/shop/494303/");
  // A row without an id or a name is dropped rather than handed out half-empty.
  assert.deepEqual(shopsOf({ results: [{ name: "بی‌شناسه" }] }, 10).shops, []);
  assert.deepEqual(trendsOf([{ category_id: 3 }], 10), []);
});
