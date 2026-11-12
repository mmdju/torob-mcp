import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "../dist/tools.js";
import { setPaceForTests, resetBreakerForTests } from "../dist/http.js";

setPaceForTests(0);
const realFetch = globalThis.fetch;
afterEach(async () => { globalThis.fetch = realFetch; await resetBreakerForTests(); });
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const item = (n, quantity = 1) => ({ prk: id(n), details_url: `https://api.torob.com/v4/base-product/details/?prk=${id(n)}`, quantity });
const offer = (shop, price, extra = {}) => ({ shop_id: shop, shop_name: `shop-${shop}`, price, availability: true, name1: "exact listing", ...extra });
let serial = 100;
function setup(rows) {
  const start = serial; serial += rows.length;
  const items = rows.map((_, i) => item(start + i));
  const calls = [];
  globalThis.fetch = async (url) => {
    const prk = new URL(url).searchParams.get("prk");
    calls.push(prk);
    const index = items.findIndex((x) => x.prk === prk);
    const raw = rows[index];
    if (raw instanceof Error) throw raw;
    return new Response(JSON.stringify({ random_key: prk, name1: `item-${index}`, availability: true, price: 1, products_info: { result: raw } }), { headers: { "content-type": "application/json" } });
  };
  return { items, calls };
}
const run = (args) => TOOLS.find((t) => t.name === "compare_shopping_list").run(args);

test("shops rank by distinct-item coverage before subtotal, with quantities and duplicate offers handled", async () => {
  const { items, calls } = setup([[offer(1, 100), offer(1, 90), offer(2, 5)], [offer(1, 200), offer(3, 10)]]);
  items[0].quantity = 2;
  const out = await run({ items });
  assert.equal(calls.length, 2);
  assert.equal(out.comparison_complete, true);
  assert.equal(out.shops[0].shop_id, "1");
  assert.equal(out.shops[0].complete, true);
  assert.equal(out.shops[0].covered_items, 2);
  assert.equal(out.shops[0].subtotal_toman, 380);
  assert.equal(out.shops[0].lines.length, 2);
  assert.equal(out.shops[1].complete, false);
  assert.equal(out.shops[1].subtotal_toman, 10);
  assert.equal(out.shops[1].missing_prks.length, 1);
  assert.equal(out.favorites_url, "https://torob.com/user/favorites/");
});

test("out-of-stock, unknown-stock, unreliable, unpriced and unidentified offers never count as coverage", async () => {
  const { items } = setup([[offer(1, 1, { availability: false }), offer(2, 1, { availability: undefined }), offer(3, 1, { is_price_unreliable: true }), offer(4, 0), offer(null, 1)]]);
  const out = await run({ items });
  assert.equal(out.shops.length, 0);
  assert.equal(out.items[0].eligible_shop_count, 0);
  assert.equal(out.items[0].excluded_offers, 5);
});

test("invalid lists are refused before any network request", async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
  for (const items of [[], Array.from({ length: 11 }, (_, i) => item(i)), [item(1), item(1)], [{ ...item(1), quantity: 0 }], [{ ...item(1), quantity: 1.5 }], [{ ...item(1), quantity: 101 }], [{ ...item(1), prk: "bad" }], [{ ...item(1), details_url: item(2).details_url }], [{ ...item(1), details_url: "https://attacker.example/" }], [{ prk: id(1) }]]) {
    await assert.rejects(() => run({ items }));
  }
  assert.equal(calls, 0);
});

test("an upstream failure is explicit and cannot make an incomplete basket look complete", async () => {
  const { items } = setup([[offer(1, 100)], []]);
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => new URL(url).searchParams.get("prk") === items[1].prk
    ? new Response("missing", { status: 404 }) : previous(url, options);
  const out = await run({ items });
  assert.equal(out.comparison_complete, false);
  assert.equal(out.items[1].status, "error");
  assert.equal(out.shops[0].complete, false);
  assert.deepEqual(out.shops[0].missing_prks, [items[1].prk]);
});

test("a different returned product is reported as an error rather than substituted", async () => {
  const { items } = setup([[offer(1, 100)]]);
  globalThis.fetch = async () => new Response(JSON.stringify({ random_key: id(99999), name1: "different", products_info: { result: [offer(1, 100)] } }), { headers: { "content-type": "application/json" } });
  const out = await run({ items });
  assert.equal(out.comparison_complete, false);
  assert.equal(out.shops.length, 0);
  assert.match(out.items[0].error, /different product/i);
});

test("shop pagination does not hide that more matching shops exist", async () => {
  const { items } = setup([[offer(1, 10), offer(2, 20), offer(3, 30)]]);
  const out = await run({ items, limit: 1, page: 2 });
  assert.equal(out.shop_count, 3);
  assert.equal(out.shops[0].shop_id, "2");
  assert.equal(out.has_next_page, true);
});

test("a withdrawn product contributes no offers even if stale seller rows remain", async () => {
  const { items } = setup([[offer(1, 10)]]);
  globalThis.fetch = async () => new Response(JSON.stringify({ random_key: items[0].prk, name1: "withdrawn", is_accessible: false, products_info: { result: [offer(1, 10)] } }), { headers: { "content-type": "application/json" } });
  assert.equal((await run({ items })).shops.length, 0);
});
