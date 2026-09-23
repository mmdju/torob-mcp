// Pure helpers: Persian numbers, coercions and the small URL/shape fixes the
// projection layer needs. Persian/Arabic folding itself is imported from
// fa-text-utils.
// Why folding matters: Iranian keyboards produce both the Arabic yeh/kaf
// (ي U+064A, ك U+0643) and the Persian ones (ی U+06CC, ک U+06A9), plus
// Arabic-Indic digits. Two spellings of one word are two different queries
// upstream, and titles that look identical to a human compare as different
// strings to code.

// Re-exported so the rest of the server can keep importing them from here.
export { ZWNJ, faFold, faSearchVariants } from "fa-text-utils";

export function str(v: unknown, fallback = ""): string {
  // Ids and codes arrive as numbers from some endpoints and as strings from
  // others - province/city ids are numeric upstream, product ids are strings.
  // Coercing here means a projection can read one shape without knowing which
  // endpoint it came from; without the number case, `str(1)` returned "" and
  // every row of a perfectly good response was silently dropped.
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return fallback;
}

export function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseFloat(str(v));
  return Number.isFinite(n) ? n : fallback;
}

export function short(s: unknown, n = 220): string | null {
  const t = str(s).replace(/\s+/g, " ").trim();
  if (!t) return null;
  // Truncate to n INCLUDING the ellipsis, so the caller's cap is a real cap.
  return t.length > n ? t.slice(0, Math.max(1, n - 3)) + "..." : t;
}

export function clampLimit(v: unknown, def = 10, max = 30): number {
  return Math.min(Math.max(Math.floor(num(v, def)) || def, 1), max);
}

// Torob pages are 0-based upstream; this server speaks 1-based pages because
// that is what every other tool in the family does, and an agent asking for
// "page 1" means the first page. page 1 -> upstream page 0.
export function clampPage(v: unknown, max = 50): number {
  return Math.min(Math.max(Math.floor(num(v, 1)) || 1, 1), max);
}

// Clamp used to correct silently: an agent asking for page 999 got the last
// page back with no hint, and could quote the wrong page as fact. Tool
// responses spread this next to the pager so the correction travels with the
// answer.
export function pageClampNote(v: unknown, max = 50): Record<string, unknown> {
  const requested = Math.floor(num(v, 1)) || 1;
  if (requested <= max) return {};
  return {
    page_clamped: true,
    page_requested: requested,
    page_note: `Torob serves at most ${max} pages per search here; page ${requested} was clamped to ${max}.`,
  };
}

// Persian and Arabic-Indic digits, plus the separators Torob mixes into
// price_text ("۹۵٫۸۰۰٫۰۰۰" mixes U+066B decimal and U+066C thousands).
const DIGIT_MAP: Record<string, string> = {
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

// A price in Persian, without units: "۹۵٫۸۰۰٫۰۰۰ تومان" -> 95800000.
// Returns null when there is no number at all, so a caller can tell "no price"
// from "price 0" - the difference between free and out of stock.
export function tomanFromText(s: unknown): number | null {
  const t = str(s).replace(/[۰-۹٠-٩]/g, (d) => DIGIT_MAP[d] ?? d);
  const m = t.match(/\d[\d٬,\s٫\.]*/);
  if (!m) return null;
  // Only separators, no other digits: strip them and read the integer.
  const digits = m[0].replace(/[٬,\s٫\.]/g, "");
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

// Torob is already in Toman; this exists so the unit is stated in one place
// and a future change has somewhere obvious to go.
export function toman(v: unknown): number | null {
  return num(v, 0) > 0 ? Math.round(num(v, 0)) : null;
}

// Torob marks an out-of-stock product with price 0 rather than omitting it.
// "Free" and "not for sale" must not collapse into the same answer.
export function availableFrom(price: number | null): boolean {
  return price !== null && price > 0;
}

// "۷۹۹٬۰۰۰" with a Persian thousands separator breaks a plain toLocaleString
// on some runtimes, so group the digits by hand.
export function formatToman(n: number | null): string | null {
  if (n === null || !Number.isFinite(n)) return null;
  return n.toLocaleString("en-US").replace(/,/g, "٬");
}

// Product and offer URLs arrive as site-relative paths ("/p/<prk>/<slug>/").
// A clean product link is https://torob.com/p/<prk>/ - the slug is decorative.
export function productUrl(path: unknown, prk: unknown): string | null {
  const key = str(prk).trim();
  if (key) return `https://torob.com/p/${key}/`;
  const p = str(path).trim();
  if (!p) return null;
  if (p.startsWith("http")) return p;
  return `https://torob.com${p.startsWith("/") ? "" : "/"}${p}`;
}
