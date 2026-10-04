// The projection layer is where an upstream quirk becomes a wrong answer, so
// the fixtures here are copied from the live payloads probed on 2026-09-24.
import { test } from "node:test";
import assert from "node:assert/strict";
import { offersOf, toCard } from "../dist/project.js";

const searchRow = {
  random_key: "2ee0949f-e7de-4cd8-a45a-ea5bad3eff95",
  name1: "گاوصندوق گنج بان مدل FAS-620",
  name2: "",
  price: 95800000,
  price_text: "۹۵٫۸۰۰٫۰۰۰ تومان",
  price_prefix: "cheapest",
  stock_status: "",
  image_url: "https://image.torob.com/base/images/yC/7u/yC7uNkn6zzPsraEL.jpg",
  image_count: 3,
  shop_text: "در ایران کاوه سیف",
  badges: [],
  web_client_absolute_url: "/p/2ee0949f-e7de-4cd8-a45a-ea5bad3eff95/gao/",
  more_info_url: "https://api.torob.com/v4/base-product/details/?search_id=abc&prk=2ee0949f",
};

test("toCard projects a search row into a compact record", () => {
  const card = toCard(searchRow);
  assert.equal(card.prk, "2ee0949f-e7de-4cd8-a45a-ea5bad3eff95");
  assert.equal(card.name_fa, "گاوصندوق گنج بان مدل FAS-620");
  assert.equal(card.price_toman, 95800000);
  assert.equal(card.available, true);
  assert.equal(card.shop_name, "در ایران کاوه سیف");
  assert.equal(card.url, "https://torob.com/p/2ee0949f-e7de-4cd8-a45a-ea5bad3eff95/");
});

test("toCard reports price 0 as out of stock, not free", () => {
  // Torob uses price 0 for "not available". Turning that into 0 Toman would
  // read as the cheapest thing in the market.
  const card = toCard({ ...searchRow, price: 0, price_text: "" });
  assert.equal(card.price_toman, null);
  assert.equal(card.available, false);
});

test("toCard falls back to the Persian price text when the number is missing", () => {
  const card = toCard({ ...searchRow, price: undefined, price_text: "۷۹۹٬۰۰۰ تومان" });
  assert.equal(card.price_toman, 799000);
});

test("toCard keeps a 'from' price honest", () => {
  // "از" means "from" - the cheapest of several offers, not a fixed price. The
  // number must survive, and the wording must not be quietly dropped.
  const card = toCard({ ...searchRow, price: 114610000, price_text: "از ۱۱۴٫۶۱۰٫۰۰۰ تومان" });
  assert.equal(card.price_toman, 114610000);
  assert.match(card.price_text, /^از /);
});

test("toCard drops a row with no product id", () => {
  assert.equal(toCard({ name1: "بی‌نام" }), null);
});

test("toCard surfaces badges as short text", () => {
  const card = toCard({
    ...searchRow,
    badges: [{ text: "کارکرده", badge_type: "stock_status" }, { text: "تخفیف", badge_type: "discount" }],
  });
  assert.deepEqual(card.badges, ["کارکرده", "تخفیف"]);
});

// The seller list is the reason a Torob MCP exists: products_info.result[].
const detailsRow = {
  ...searchRow,
  products_info: {
    title: "فروشنده‌ها",
    result: [
      {
        shop_name: "دیجی‌کالا",
        shop_name2: "تهران",
        shop_id: "12345",
        shop_score: 4.8,
        shop_votes_count: 12000,
        price: 82000000,
        price_text: "۸۲٫۰۰۰٫۰۰۰ تومان",
        availability: true,
        is_price_unreliable: false,
        postage_fee: "هزینه ارسال رایگان",
        more_info: { free_shipping: true, payment_on_delivery: true, same_day_delivery: "تهران" },
      },
      {
        shop_name: "فروشگاه ارزان",
        shop_name2: "اصفهان",
        shop_id: "99999",
        shop_score: 3.2,
        shop_votes_count: 40,
        price: 79000000,
        price_text: "۷۹٫۰۰۰٫۰۰۰ تومان",
        price_text_striked: "۸۵٫۰۰۰٫۰۰۰ تومان",
        availability: true,
        is_price_unreliable: true,
        postage_fee: "هزینه ارسال ۷۰٫۰۰۰ تومان",
        guarantee_info: { status: "enabled" },
        installment: { providers: [{ name: "بلوبانک" }, { short_title: "تارا" }] },
        is_adv: true,
        last_price_change_date: "۳ روز پیش",
        has_public_torob_profile: true,
        shop_score_percentile: 42,
        more_info: { free_shipping: false },
      },
      {
        shop_name: "ناموجود",
        price: 0,
        price_text: "ناموجود",
        availability: false,
      },
      {
        shop_name: "تک‌رأی",
        shop_score: 5,
        shop_votes_count: 1,
        price: 77000000,
        availability: true,
      },
    ],
  },
};

test("offersOf reads the seller list and sorts cheapest available first", () => {
  const offers = offersOf(detailsRow);
  assert.equal(offers.length, 4);
  // The out-of-stock offer is kept (it is real information) but sorts last.
  assert.equal(offers[0].shop_name, "تک‌رأی");
  assert.equal(offers[offers.length - 1].shop_name, "ناموجود");
  assert.equal(offers[offers.length - 1].available, false);
});

test("a shop score is passed through even when the vote count is zero", () => {
  // Measured upstream: 30 of 30 offers on a live product had shop_score 5 with
  // shop_votes_count 0. A vote floor would hide the only reliability signal
  // this server has, so the score travels as sent and the count beside it.
  const offers = offersOf(detailsRow);
  const one = offers.find((o) => o.shop_name === "تک‌رأی");
  assert.equal(one.shop_score, 5);
  assert.equal(one.shop_votes, 1);

  // The measured case itself: a perfect score with no votes behind it. A vote
  // floor would have nulled this one out, hiding the only signal there is.
  const noVotes = offersOf({
    ...searchRow,
    products_info: { result: [{ shop_name: "بدون رأی", price: 1000, availability: true, shop_score: 5, shop_votes_count: 0 }] },
  });
  assert.equal(noVotes[0].shop_score, 5, "the score travels as Torob sent it, even at zero votes");
  assert.equal(noVotes[0].shop_votes, 0);

  // A shop with no score at all gets none invented for it.
  const unscored = offersOf({
    ...searchRow,
    products_info: { result: [{ shop_name: "بی‌امتیاز", price: 1000, availability: true, shop_score: 0, shop_votes_count: 0 }] },
  });
  assert.equal(unscored[0].shop_score, null);
});

test("a well-reviewed offer keeps its score, city and delivery info", () => {
  const offers = offersOf(detailsRow);
  const dk = offers.find((o) => o.shop_name === "دیجی‌کالا");
  assert.equal(dk.shop_score, 4.8);
  assert.equal(dk.shop_city, "تهران");
  assert.equal(dk.shop_id, "12345");
  assert.equal(dk.free_shipping, true);
  assert.equal(dk.payment_on_delivery, true);
  assert.equal(dk.same_day_delivery, "تهران");
});

test("a discounted offer keeps its was-price and Torob's own warning", () => {
  const offers = offersOf(detailsRow);
  const cheap = offers.find((o) => o.shop_name === "فروشگاه ارزان");
  assert.equal(cheap.price_toman, 79000000);
  assert.equal(cheap.was_price_text, "۸۵٫۰۰۰٫۰۰۰ تومان");
  assert.equal(cheap.price_unreliable, true);
  assert.equal(cheap.free_shipping, false);
});

test("a seller offer keeps postage, guarantee and instalment as the shop stated them", () => {
  // Live fields measured on 2026-09-24. The postage is a Persian line, not a
  // number, and the delivered price is where it becomes comparable.
  const offers = offersOf(detailsRow);
  const cheap = offers.find((o) => o.shop_name === "فروشگاه ارزان");
  assert.equal(cheap.postage_text, "هزینه ارسال ۷۰٫۰۰۰ تومان");
  assert.equal(cheap.postage_fee_toman, 70000);
  assert.equal(cheap.delivered_price_toman, 79070000);
  assert.equal(cheap.guarantee, "enabled");
  assert.deepEqual(cheap.installment_providers, ["بلوبانک", "تارا"]);
  assert.equal(cheap.is_adv, true);
  assert.equal(cheap.last_price_change_date, "۳ روز پیش");
  assert.equal(cheap.has_public_torob_profile, true);
  assert.equal(cheap.shop_score_percentile, 42);
});

test("free postage adds nothing, and an unstated fee is not invented", () => {
  const offers = offersOf(detailsRow);
  const dk = offers.find((o) => o.shop_name === "دیجی‌کالا");
  assert.equal(dk.postage_text, "هزینه ارسال رایگان");
  assert.equal(dk.postage_fee_toman, null);
  assert.equal(dk.delivered_price_toman, dk.price_toman);
});

test("offersOf returns an empty list when there are no sellers", () => {
  assert.deepEqual(offersOf({ ...searchRow }), []);
  assert.deepEqual(offersOf({ ...searchRow, products_info: { result: "nope" } }), []);
});
