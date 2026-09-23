import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availableFrom,
  clampLimit,
  clampPage,
  formatToman,
  num,
  pageClampNote,
  productUrl,
  short,
  str,
  toman,
  tomanFromText,
} from "../dist/normalize.js";

test("str keeps strings and falls back for anything else", () => {
  assert.equal(str("سلام"), "سلام");
  assert.equal(str(42), "");
  assert.equal(str(null, "x"), "x");
  assert.equal(str(undefined, "x"), "x");
});

test("num reads numbers and numeric strings, rejects the rest", () => {
  assert.equal(num(7, 0), 7);
  assert.equal(num("7.5", 0), 7.5);
  assert.equal(num("abc", 3), 3);
  assert.equal(num(undefined, -1), -1);
});

test("tomanFromText reads Persian digits and separators", () => {
  // The real price_text shape from the live API.
  assert.equal(tomanFromText("۹۵٫۸۰۰٫۰۰۰ تومان"), 95800000);
  assert.equal(tomanFromText("۷۹۹٬۰۰۰ تومان"), 799000);
  assert.equal(tomanFromText("از ۱۱۴٫۶۱۰٫۰۰۰ تومان"), 114610000);
  // Arabic-Indic digits appear in older listings.
  assert.equal(tomanFromText("١٢٣٤٥ تومان"), 12345);
  assert.equal(tomanFromText("12,345"), 12345);
});

test("tomanFromText returns null when there is no number at all", () => {
  // "no price" and "price 0" are different answers: one is unknown, the other
  // is out of stock upstream.
  assert.equal(tomanFromText("تماس بگیرید"), null);
  assert.equal(tomanFromText(""), null);
  assert.equal(tomanFromText(null), null);
});

test("toman normalizes to a positive integer or null", () => {
  assert.equal(toman(1234.6), 1235);
  assert.equal(toman(0), null);
  assert.equal(toman(-5), null);
});

test("availableFrom treats 0 as out of stock, not free", () => {
  assert.equal(availableFrom(0), false);
  assert.equal(availableFrom(null), false);
  assert.equal(availableFrom(1), true);
});

test("formatToman groups with a Persian separator", () => {
  assert.equal(formatToman(799000), "799٬000");
  assert.equal(formatToman(null), null);
});

test("short collapses whitespace and truncates with an ellipsis", () => {
  assert.equal(short("  a   b  "), "a b");
  assert.equal(short(""), null);
  assert.equal(short(null), null);
  // Truncation keeps the result within the budget, ellipsis included.
  const long = short("x".repeat(50), 10);
  assert.equal(long.length, 10);
  assert.ok(long.endsWith("..."));
  assert.equal(short("short enough", 20), "short enough");
});

test("productUrl builds a clean /p/<id>/ link from a relative path", () => {
  assert.equal(
    productUrl("/p/28c82809-0f27-47aa-a534-a9ad1bb858e5/قاب-موبایل/", "28c82809-0f27-47aa-a534-a9ad1bb858e5"),
    "https://torob.com/p/28c82809-0f27-47aa-a534-a9ad1bb858e5/"
  );
});

test("productUrl recovers the id from a full product URL", () => {
  // An agent that read a link out of a search result should not have to parse
  // it out by hand.
  const url = "https://torob.com/p/2ee0949f-e7de-4cd8-a45a-ea5bad3eff95/گاوصندوق/";
  assert.equal(productUrl(url, ""), url);
});

test("clampLimit and clampPage stay in range", () => {
  assert.equal(clampLimit(undefined), 10);
  assert.equal(clampLimit(5), 5);
  assert.equal(clampLimit(999, 10, 30), 30);
  assert.equal(clampLimit(0, 10, 30), 10);
  assert.equal(clampPage(undefined), 1);
  assert.equal(clampPage(999), 50);
});

test("pageClampNote explains a silent clamp", () => {
  assert.deepEqual(pageClampNote(3), {});
  const note = pageClampNote(999);
  assert.equal(note.page_clamped, true);
  assert.equal(note.page_requested, 999);
  assert.match(String(note.page_note), /50/);
});
