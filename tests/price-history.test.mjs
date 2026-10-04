// The price tools: Torob's own chart, its change feed, and how fresh a price
// list is. Fixtures are copied from live payloads probed on 2026-10-01.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "../dist/tools.js";
import { priceChartOf, priceChangesOf } from "../dist/project.js";
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

const PRK = "ca10472a-7b83-4e75-b6ad-111576e83d6d";
const DETAILS_URL = `https://api.torob.com/v4/base-product/details/?search_id=s1&prk=${PRK}`;

// Every test that stubs a different payload needs its own product: the response
// cache is per process, so reusing one id would serve the previous test's chart.
let seq = 90;
function fresh() {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  return { id, details_url: `https://api.torob.com/v4/base-product/details/?search_id=s${seq}&prk=${id}` };
}

// Trimmed from the live chart: two series, and the entries deliberately out of
// order because Torob places them by their own `i`.
const chartPayload = {
  labels: ["۱۶ شهریور ۱۴۰۱", "۳۰ اردیبهشت ۱۴۰۲", "۲۶ مرداد ۱۴۰۵"],
  dataSets: [
    { label: "میانگین قیمت", color: "#00C853", entries: [{ val: 1130000, i: 0 }, { val: 1243456, i: 2 }] },
    { label: "کمترین قیمت", color: "#0091EA", entries: [{ val: 689999, i: 2 }, { val: 1130000, i: 0 }] },
  ],
};

const changesPayload = {
  count: 1649,
  next: "https://api.torob.com/v4/base-product/price-history/?page=1",
  previous: null,
  results: [
    {
      title: "افزایش قیمت در دکان دات شاپ",
      description: "از ۳٫۴۸۶٫۰۰۰ تومان به ۳٫۴۸۹٫۰۰۰ تومان",
      icon: "https://api.torob.com/static/price/t.png",
      timeago: "۸ ساعت پیش",
    },
  ],
};

test("chart points are placed by their own index, not by array order", () => {
  const chart = priceChartOf(chartPayload, 12);
  const lowest = chart.series.find((s) => s.label === "کمترین قیمت");
  assert.deepEqual(
    lowest.points.map((p) => [p.date, p.value]),
    [
      ["۱۶ شهریور ۱۴۰۱", 1130000],
      ["۲۶ مرداد ۱۴۰۵", 689999],
    ]
  );
  assert.equal(lowest.lowest.value, 689999);
  assert.equal(lowest.highest.value, 1130000);
  assert.equal(lowest.latest.date, "۲۶ مرداد ۱۴۰۵");
  assert.equal(chart.points_available, 2);
  assert.equal(chart.window.points, 2);
  assert.equal(chart.window.to, "۲۶ مرداد ۱۴۰۵");
});

test("the months window keeps the newest points and reports what exists", () => {
  const entries = [10, 20, 30, 40, 50].map((val, i) => ({ val, i }));
  const labels = ["م۱", "م۲", "م۳", "م۴", "م۵"];
  const chart = priceChartOf({ labels, dataSets: [{ label: "کمترین قیمت", entries }] }, 2);
  // What Torob charts and what we return are two different numbers: a caller
  // has to be able to see that more exists.
  assert.equal(chart.points_available, 5);
  assert.equal(chart.window.points, 2);
  assert.deepEqual(chart.series[0].points.map((p) => p.value), [40, 50]);
  assert.equal(chart.window.from, "م۴");
});

test("price changes keep Torob's wording and stop at the limit", () => {
  const out = priceChangesOf(changesPayload, 5);
  assert.equal(out.count, 1649);
  assert.equal(out.changes.length, 1);
  assert.equal(out.changes[0].title, "افزایش قیمت در دکان دات شاپ");
  assert.equal(out.changes[0].time_ago, "۸ ساعت پیش");
  // A feed with no entries is not an error - it is a product nobody has
  // re-priced yet.
  assert.deepEqual(priceChangesOf({ count: 0, results: [] }, 5), { count: 0, changes: [] });
});

test("price_history reads the chart and the freshness, and only reads changes when asked", async () => {
  const seen = [];
  stub((url) => {
    seen.push(url);
    if (url.includes("price-chart")) return chartPayload;
    if (url.includes("last-modified-date")) return { last_modified_date: "2026-09-30T20:33:05.645676+00:00" };
    return changesPayload;
  });

  const out = await run("price_history", { prk: PRK, details_url: DETAILS_URL, months: 12 });
  assert.equal(out.series.length, 2);
  assert.equal(out.window.points, 2);
  assert.equal(out.last_modified, "2026-09-30T20:33:05.645676+00:00");
  // formatToman groups digits with the Persian thousands separator.
  assert.match(out.reading, /689٬999 Toman/);
  // The sentence ends on the last series, with the unit stated once per value.
  assert.match(out.reading, /\)\. Latest: .* Toman \(.*\)\.$/);
  assert.match(out.last_modified_note, /confirm on torob\.com/i);
  // Two calls: the chart and the freshness line. The change feed costs a
  // third, so it is not paid for unless the caller asks.
  assert.equal(seen.filter((u) => u.includes("price-chart")).length, 1);
  assert.equal(seen.filter((u) => u.includes("price-history")).length, 0);
  assert.equal(out.changes, undefined);

  seen.length = 0;
  const withChanges = await run("price_history", {
    prk: PRK,
    details_url: DETAILS_URL,
    include_changes: true,
    changes_limit: 3,
  });
  assert.equal(withChanges.changes.length, 1);
  assert.equal(withChanges.changes_count, 1649);
  assert.equal(withChanges.changes[0].time_ago, "۸ ساعت پیش");
  assert.equal(seen.filter((u) => u.includes("price-history")).length, 1);
  assert.match(seen.find((u) => u.includes("price-history")), /page=0&size=3/);
});

test("price_history says so when Torob charts nothing yet", async () => {
  const product = fresh();
  stub((url) => {
    if (url.includes("price-chart")) return { labels: [], dataSets: [] };
    return { last_modified_date: "" };
  });
  const out = await run("price_history", { prk: product.id, details_url: product.details_url });
  assert.deepEqual(out.series, []);
  assert.equal(out.reading, null);
  assert.equal(out.last_modified, null);
  assert.match(out.note, /no price history/i);
});

test("price_history asks for a search first when the id is unknown", async () => {
  // Nothing remembered (so no name to search by), no details_url, and an
  // id-only answer that does not check out: the honest answer names the way
  // back to the product.
  stub(() => ({ results: [], count: 0, next: "" }));
  await assert.rejects(
    () => run("price_history", { prk: "00000000-0000-0000-0000-000000000000" }),
    /search_products/
  );
});

test("price_history needs a prk", async () => {
  await assert.rejects(() => run("price_history", { prk: "  " }), /needs a prk/);
});

test("price_history opens an id this server has never seen, the way product_details does", async () => {
  // The documented input is "a prk from a card, or a torob.com product URL" -
  // the same wording product_details has. Without a details_url the id-only
  // details call is the way in, and it used to be missing here: the very same
  // id opened one tool and was refused by three others.
  const product = fresh();
  const seen = [];
  stub((url) => {
    seen.push(url);
    if (url.includes("price-chart")) return chartPayload;
    if (url.includes("last-modified-date")) return { last_modified_date: "2026-09-30T20:33:05.645676+00:00" };
    if (url.includes("/details/")) {
      return { random_key: product.id, name1: "هدفون بی‌سیم", price: 1000, price_text: "۱٫۰۰۰ تومان" };
    }
    return { labels: [], dataSets: [] };
  });
  const out = await run("price_history", { prk: product.id });
  assert.equal(out.series.length, 2);
  assert.ok(
    seen.some((u) => u.includes("/details/?prk=")),
    "the id-only details call is what opened it"
  );
  assert.ok(
    !seen.some((u) => u.includes("base-product/search")),
    "an id this server never saw has no name to search by, so no search is attempted"
  );
});
