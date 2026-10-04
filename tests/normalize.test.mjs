import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availableFrom,
  clampLimit,
  clampPage,
  foldKey,
  formatToman,
  num,
  pageClampNote,
  productUrl,
  short,
  str,
  toman,
  tomanFromText,
} from "../dist/normalize.js";

test("foldKey makes the same words compare equal across keyboards", () => {
  // Torob's own search treats these spellings as the same words; the server's
  // cache keys and name matching have to agree with it, not with a byte
  // comparison that would call them different products.
  assert.equal(foldKey("آيفون ۱۳"), foldKey("آیفون 13"));
  assert.equal(foldKey("كتاب"), foldKey("کتاب"));
  assert.equal(foldKey("iPhone"), "iphone");
  assert.equal(foldKey("  a   b "), "a b");
  // A ZWNJ is a real difference (نیم‌فاصله is not نیم فاصله), so it survives.
  assert.notEqual(foldKey("نیم‌فاصله"), foldKey("نیم فاصله"));
  assert.equal(foldKey(null), "");
});

test("str keeps strings and falls back for anything else", () => {
  assert.equal(str("سلام"), "سلام");
  assert.equal(str(null, "x"), "x");
  assert.equal(str(undefined, "x"), "x");
  assert.equal(str({}, "x"), "x");
});

test("str coerces a numeric id, because Torob sends ids both ways", () => {
  // Province and city ids come back as numbers, product ids as strings. A
  // projection that assumed one shape dropped every row of a good response and
  // reported it as "no provinces exist".
  assert.equal(str(1), "1");
  assert.equal(str(0), "0");
  assert.equal(str(748), "748");
  assert.equal(str(NaN, "x"), "x");
  assert.equal(str(Infinity, "x"), "x");
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

test("numbers typed with Persian or Arabic-Indic digits are read as numbers", () => {
  // An Iranian user types ۱۰. Read as text it parsed to nothing and fell back
  // to the default, so the caller's own number was dropped without a word.
  assert.equal(num("۱۰", 0), 10);
  assert.equal(num("٥", 0), 5);
  assert.equal(clampLimit("۲۵", 10, 30), 25);
  assert.equal(clampLimit("۲۵", 10, 24), 24, "the cap still applies to a Persian-digit input");
  assert.equal(clampPage("۳"), 3);
});

test("pageClampNote reports the maximum that was actually applied", () => {
  // Three of the pagers stop at 20, not at the shared default of 50, so the
  // note has to name the real ceiling rather than the documented one.
  assert.deepEqual(pageClampNote(20, 20), {});
  const note = pageClampNote(21, 20);
  assert.equal(note.page_clamped, true);
  assert.equal(note.page_requested, 21);
  assert.match(String(note.page_note), /20/);
});
