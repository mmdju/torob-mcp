// Torob's own product guide. The payload is an article, so the tests are about
// what survives the trip: headings become sections, entities become characters,
// no markup reaches the caller, and the cap is a real cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "../dist/tools.js";
import { guideOf } from "../dist/project.js";
import { resetBreakerForTests, setPaceForTests, setRetryDelayForTests } from "../dist/http.js";

setPaceForTests(0);
setRetryDelayForTests(0);

const originalFetch = globalThis.fetch;
let calls = [];

function stubWiki(payload) {
  calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
  };
}

test.afterEach(async () => {
  globalThis.fetch = originalFetch;
  await resetBreakerForTests();
});

const run = (args) => TOOLS.find((t) => t.name === "product_guide").run(args);
const detailsUrl = (prk) => `https://api.torob.com/v4/base-product/details/?prk=${prk}&search_id=x`;

// Shaped like the live payload measured on 2026-10-09: headings, a list, an
// entity in the middle of a phrase, and a non-breaking space inside a sentence.
const guideHtml =
  `<h1>هدفون بی‌سیم P9</h1>\n<p>اطلاعات محدود</p>\n<h2>نقاط قوت</h2>\n` +
  `<ul><li>باتری ۱۰ ساعت</li><li>سازگاری &amp; قیمت</li></ul>\n<h2>نقاط ضعف</h2>\n` +
  `<p>کیفیت ساخت ساده&nbsp;است.</p>\n<h2>منابع</h2>`;

test("guideOf turns headings into sections and never keeps markup", () => {
  const out = guideOf({ data_html: guideHtml, name1: "هدفون بی‌سیم P9" });
  assert.equal(out.title, "هدفون بی‌سیم P9");
  assert.deepEqual(out.sections.map((s) => s.heading), [null, "نقاط قوت", "نقاط ضعف", "منابع"]);
  assert.match(out.sections[1].text, /باتری ۱۰ ساعت/);
  assert.match(out.sections[1].text, /سازگاری & قیمت/);
  assert.doesNotMatch(out.sections[1].text, /[<>&](amp|nbsp|lt|gt)/);
  assert.equal(out.sections[2].text, "کیفیت ساخت ساده است.");
  assert.ok(out.text_length > 0);
});

test("guideOf answers an absent or empty guide with no sections", () => {
  assert.deepEqual(guideOf({}).sections, []);
  assert.deepEqual(guideOf({ data_html: "" }).sections, []);
  assert.equal(guideOf({ data_html: "" }).text_length, 0);
});

test("product_guide reads Torob's guide through the card's details_url", async () => {
  const prk = "26f65e3c-303f-4e9a-9e8b-391248767039";
  stubWiki({ data_html: guideHtml, name1: "هدفون بی‌سیم P9" });
  const out = await run({ prk, details_url: detailsUrl(prk) });
  assert.equal(out.prk, prk);
  assert.equal(out.sections.length, 4);
  assert.equal(out.guide_url, `https://torob.com/p/${prk}/`);
  assert.ok(calls.some((u) => u.includes("/v4/base-product/wiki/?prk=")), "the guide comes from Torob's own endpoint");
  assert.equal(calls.length, 1, "the details_url path costs no lookup of its own");
  assert.ok(!JSON.stringify(out.sections).includes("<"), "no markup reaches the caller");
});

test("product_guide caps the text and says which cap it applied", async () => {
  const prk = "d9e21a3c-e73f-42c7-b6ab-56ad1eb41f4d";
  stubWiki({ data_html: `<p>${"متن ".repeat(120)}</p><h2>بخش دوم</h2><p>پایان</p>`, name1: "هدفون" });
  const out = await run({ prk, details_url: detailsUrl(prk), max_chars: 60 });
  assert.equal(out.truncated, true);
  assert.match(out.note, /max_chars/);
  const returned = out.sections.map((s) => s.text).join("");
  assert.ok(returned.length <= 60, `capped text was ${returned.length} characters`);
  assert.ok(out.text_length > returned.length, "text_length still reports the whole guide");
});

test("product_guide says a missing guide is missing instead of composing one", async () => {
  const prk = "055848fc-529b-487a-ac47-9221322c3344";
  stubWiki({ data_html: "", name1: null });
  const out = await run({ prk, details_url: detailsUrl(prk) });
  assert.deepEqual(out.sections, []);
  assert.match(out.note, /no guide for this product/i);
});
