// Projection layer: raw Torob JSON -> small, high-signal objects.
//
// This is the whole point of the server. A Torob search page is ~70KB of
// ranking metadata, experiment ids and ad plumbing; a product page carries the
// same row again plus a seller list. An agent cannot afford any of that, so
// every tool returns compact records built here and nothing else.
//
// Field paths were verified against the live API from a deployed worker
// (probe, 2026-09-24). Two upstream facts drive the shape below:
//
// 1. `more_info_url` is a ready-made absolute details URL. The product id it
//    needs (`prk`, `search_id`) is NOT a response field - third-party scrapers
//    regex it out of this URL. Following the URL verbatim is both simpler and
//    less brittle than rebuilding it.
// 2. Seller offers live at `products_info.result[]` (upstream titles it
//    "فروشنده‌ها"). That list is the reason a Torob MCP exists at all, so it
//    gets a first-class shape rather than being flattened into a string.

import { ATTRIBUTION, MIN_SHOP_VOTES, TTL } from "./config.js";
import { cached } from "./cache.js";
import { UpstreamError, torobGet } from "./http.js";
import {
  availableFrom,
  formatToman,
  num,
  productUrl,
  short,
  str,
  toman,
  tomanFromText,
} from "./normalize.js";

/** One seller offer for a product. */
export interface Offer {
  shop_name: string;
  shop_city: string | null;
  shop_id: string | null;
  /** 0-5, or null when too few votes to mean anything. */
  shop_score: number | null;
  shop_votes: number;
  price_toman: number | null;
  price_text: string | null;
  /** Struck-through price when the shop had a discount. */
  was_price_text: string | null;
  available: boolean;
  /** Torob itself flags some prices as untrustworthy; surfaced, never hidden. */
  price_unreliable: boolean;
  free_shipping: boolean | null;
  payment_on_delivery: boolean | null;
  same_day_delivery: string | null;
  url: string | null;
}

export interface ProductCard {
  prk: string;
  name_fa: string | null;
  name_en: string | null;
  /** Cheapest available offer in Toman; null when out of stock. */
  price_toman: number | null;
  price_text: string | null;
  available: boolean;
  shop_name: string | null;
  image: string | null;
  image_count: number;
  badges: string[];
  url: string;
}

export interface ProductDetails extends ProductCard {
  offers: Offer[];
  offer_count: number;
  /** Spread between cheapest and dearest available offer, in Toman. */
  price_spread_toman: number | null;
  cheapest_offer: Offer | null;
  best_rated_offer: Offer | null;
  similar_count: number;
  attribution: string;
}

// ------------------------------------------------------------------ raw types
// Only the fields actually read are typed. The upstream payload is large and
// loosely shaped; typing the whole thing would be a lie that breaks silently.

interface RawOffer {
  shop_name?: unknown;
  shop_name2?: unknown;
  shop_id?: unknown;
  shop_score?: unknown;
  shop_votes_count?: unknown;
  price?: unknown;
  price_text?: unknown;
  price_string?: unknown;
  price_text_striked?: unknown;
  availability?: unknown;
  is_price_unreliable?: unknown;
  page_url?: unknown;
  more_info?: {
    payment_on_delivery?: unknown;
    free_shipping?: unknown;
    same_day_delivery?: unknown;
  };
}

interface RawProduct {
  random_key?: unknown;
  name1?: unknown;
  name2?: unknown;
  price?: unknown;
  price_text?: unknown;
  stock_status?: unknown;
  image_url?: unknown;
  image_count?: unknown;
  web_client_absolute_url?: unknown;
  more_info_url?: unknown;
  badges?: unknown;
  product_page_url?: unknown;
  products_info?: { result?: unknown };
}

export interface RawSearch {
  results?: unknown;
  count?: unknown;
  min_price?: unknown;
  max_price?: unknown;
  next?: unknown;
  categories?: unknown;
  filters1?: unknown;
  filters2?: unknown;
  attributes?: unknown;
  spellcheck?: unknown;
  has_visible_result?: unknown;
}

// ----------------------------------------------------------------- normalizers

// A shop score without votes behind it is noise. Reporting 5.0 from two votes
// would make an agent recommend a shop it knows nothing about.
function shopScore(score: unknown, votes: unknown): number | null {
  const v = Math.max(0, Math.round(num(votes, 0)));
  const s = num(score, 0);
  if (v < MIN_SHOP_VOTES || s <= 0) return null;
  return Math.round(s * 10) / 10;
}

function badgesOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const b of raw) {
    const text = short((b as any)?.text, 60);
    if (text) out.push(text);
  }
  return out.slice(0, 5);
}

// The one price that matters on a search card: the cheapest offer upstream.
// 0 means out of stock, which is not free and must not read as such.
function priceOf(row: RawProduct): number | null {
  const n = num(row.price, 0);
  if (n > 0) return Math.round(n);
  // Some rows carry the number only in the Persian text.
  return tomanFromText(row.price_text);
}

export function toCard(row: RawProduct): ProductCard | null {
  const prk = str(row.random_key).trim();
  if (!prk) return null;
  const price = priceOf(row);
  return {
    prk,
    name_fa: short(row.name1),
    name_en: short(row.name2, 160),
    price_toman: price,
    price_text: short(row.price_text, 80) ?? (price !== null ? `${formatToman(price)} تومان` : null),
    available: availableFrom(price),
    shop_name: short((row as any).shop_text, 80),
    image: short(row.image_url, 300),
    image_count: Math.max(0, Math.round(num(row.image_count, 0))),
    badges: badgesOf(row.badges),
    url: productUrl(row.web_client_absolute_url, prk) ?? `https://torob.com/p/${prk}/`,
  };
}

// The id a caller gets back is only half an address: Torob's details endpoint
// also needs a `search_id` that exists only on the row we just saw. Remember
// the row's details URL against its id, so `product_details(prk)` works
// instead of failing on a search that matches names, not ids.
const detailUrls = new Map<string, { url: string; name: string | null }>();
const DETAIL_URL_MEMORY = 500;

function rememberDetailUrl(row: RawProduct): void {
  const prk = str(row.random_key).trim();
  const url = str(row.more_info_url).trim();
  if (!prk || !url) return;
  if (detailUrls.size >= DETAIL_URL_MEMORY) {
    const oldest = detailUrls.keys().next();
    if (!oldest.done) detailUrls.delete(oldest.value);
  }
  detailUrls.set(prk, { url, name: short(row.name1, 160) });
}

function toOffer(raw: RawOffer): Offer | null {
  const shop = short(raw.shop_name, 80);
  if (!shop) return null;
  // Prefer the numeric price; fall back to the Persian text when only that is
  // present. Never invent a price from a shop name.
  const price = num(raw.price, 0) > 0 ? Math.round(num(raw.price, 0)) : tomanFromText(raw.price_text ?? raw.price_string);
  const more = raw.more_info ?? {};
  return {
    shop_name: shop,
    shop_city: short(raw.shop_name2, 60),
    shop_id: str(raw.shop_id).trim() || null,
    shop_score: shopScore(raw.shop_score, raw.shop_votes_count),
    shop_votes: Math.max(0, Math.round(num(raw.shop_votes_count, 0))),
    price_toman: price,
    price_text: short(raw.price_text ?? raw.price_string, 80) ?? (price !== null ? `${formatToman(price)} تومان` : null),
    was_price_text: short(raw.price_text_striked, 60),
    available: raw.availability === undefined ? availableFrom(price) : raw.availability === true,
    price_unreliable: raw.is_price_unreliable === true,
    free_shipping: more.free_shipping === undefined ? null : more.free_shipping === true,
    payment_on_delivery: more.payment_on_delivery === undefined ? null : more.payment_on_delivery === true,
    same_day_delivery: short(more.same_day_delivery, 120),
    url: str(raw.page_url).startsWith("http") ? str(raw.page_url) : null,
  };
}

export function offersOf(row: RawProduct): Offer[] {
  const list = (row.products_info?.result ?? []) as RawOffer[];
  if (!Array.isArray(list)) return [];
  const out: Offer[] = [];
  for (const raw of list) {
    const offer = toOffer(raw);
    if (offer) out.push(offer);
  }
  // Cheapest available first, then best rated. An out-of-stock offer is kept
  // (it is real supply information) but sorts after everything buyable.
  out.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (a.price_toman !== b.price_toman) {
      if (a.price_toman === null) return 1;
      if (b.price_toman === null) return -1;
      return a.price_toman - b.price_toman;
    }
    return (b.shop_score ?? -1) - (a.shop_score ?? -1);
  });
  return out;
}

// ----------------------------------------------------------------- endpoints

function searchKey(q: string, page: number, sort: string, category: string, shopType: string): string {
  return `s:${q}|${page}|${sort}|${category}|${shopType}`;
}

export interface SearchOptions {
  q: string;
  page: number; // 1-based here, 0-based upstream
  sort: string;
  category?: string;
  brand?: string;
  city?: string;
  shopType?: string;
}

export interface SearchResult {
  products: ProductCard[];
  total: number;
  page: number;
  page_count: number;
  has_next_page: boolean;
  next_url: string | null;
  min_price_toman: number | null;
  max_price_toman: number | null;
  /** Categories Torob suggested for this wording, so an agent can narrow down. */
  suggested_categories: { id: string; title: string }[];
  spellcheck: { corrected: string | null; original: string } | null;
  attribution: string;
}

function categoriesOf(raw: unknown): { id: string; title: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { id: string; title: string }[] = [];
  for (const c of raw) {
    const id = str((c as any)?.id ?? (c as any)?.category_id).trim();
    const title = short((c as any)?.title ?? (c as any)?.name, 80);
    if (id && title) out.push({ id, title });
  }
  return out.slice(0, 8);
}

export async function searchProducts(opts: SearchOptions): Promise<SearchResult> {
  const raw = await searchRaw(opts);
  return projectSearch(raw, opts);
}

// The upstream payload, cached. Kept separate from the projection so the
// details path can reuse a search it already paid for instead of asking again.
async function searchRaw(opts: SearchOptions): Promise<RawSearch> {
  const key = searchKey(opts.q, opts.page, opts.sort, opts.category ?? "", opts.shopType ?? "");
  return cached(key, TTL.search, () => {
    const params = new URLSearchParams({
      q: opts.q,
      // Torob pages upstream are 0-based; this server takes 1-based pages.
      page: String(Math.max(0, opts.page - 1)),
      size: "24",
      sort: opts.sort,
    });
    if (opts.category) params.set("category", opts.category);
    if (opts.brand) params.set("brand", opts.brand);
    if (opts.city) params.set("city", opts.city);
    if (opts.shopType) params.set("shop_type", opts.shopType);
    return torobGet<RawSearch>(`/v4/base-product/search/?${params.toString()}`);
  });
}

function projectSearch(raw: RawSearch, opts: SearchOptions): SearchResult {
  const rows = Array.isArray(raw.results) ? (raw.results as RawProduct[]) : [];
  const products = rows.map(toCard).filter((c): c is ProductCard => c !== null);
  // Every row we hand out becomes resolvable by its id alone.
  for (const row of rows) rememberDetailUrl(row);
  const total = Math.max(0, Math.round(num(raw.count, 0)));
  const spell = raw.spellcheck as { corrected_query?: unknown; initial_query?: unknown } | undefined;

  return {
    products,
    total,
    page: opts.page,
    // Upstream returns 24-26 rows regardless of size, so the real per-page
    // count is what we actually got, not what we asked for.
    page_count: rows.length,
    has_next_page: typeof raw.next === "string" && raw.next.length > 0,
    next_url: typeof raw.next === "string" ? raw.next : null,
    min_price_toman: toman(raw.min_price),
    max_price_toman: toman(raw.max_price),
    suggested_categories: categoriesOf(raw.categories),
    spellcheck: spell
      ? {
          corrected: str(spell.corrected_query).trim() || null,
          original: str(spell.initial_query, opts.q),
        }
      : null,
    attribution: ATTRIBUTION,
  };
}

// The details URL is discovered through a search: Torob only hands out a
// ready-made `more_info_url` on a result row, and it carries the ids needed to
// open the product.
async function detailsRaw(moreInfoUrl: string, prk: string): Promise<RawProduct> {
  return cached(`d:${prk}`, TTL.product, () => torobGet<RawProduct>(moreInfoUrl));
}

// A product id on its own is NOT an address upstream, and this was measured:
// feeding a search result's prk back as a query returns nothing, because the
// search endpoint matches names, not ids. So the id cannot be resolved by
// searching for it.
//
// What does work: the product's own name. A card carries name1, and a search
// for that name returns the product again - usually first, and always with a
// fresh details URL. So the id path re-searches by name and matches on the id.
async function rowForId(prk: string, fallbackQuery?: string): Promise<RawProduct | null> {
  const attempts = [prk, fallbackQuery].filter((q): q is string => typeof q === "string" && q.trim().length > 0);
  for (const q of attempts) {
    const raw = await searchRaw({ q: q.trim(), page: 1, sort: "popularity" });
    const rows = Array.isArray(raw.results) ? (raw.results as RawProduct[]) : [];
    const exact = rows.find((r) => str(r.random_key) === prk);
    if (exact) return exact;
    // A name search can drift onto a similar product; the first row is the
    // best available match and the caller still gets the real seller list.
    if (q !== prk && rows[0]?.more_info_url) return rows[0];
  }
  return null;
}

// The caller may hand us a bare id, a /p/<id>/ path, or a full torob.com URL.
// An agent that read an id out of a link should not have to parse it out.
export function idFrom(source: string): string {
  const wanted = source.trim();
  const m =
    wanted.match(/\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) ??
    wanted.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return (m?.[1] ?? wanted).trim();
}

/**
 * Open a product. `source` is either a product id / product URL, or a search
 * result row passed whole.
 *
 * The id is resolved through the details URL this server saw when it handed
 * that id out, and only falls back to a name search if that row is gone (a
 * fresh isolate, a restart, a much older id).
 */
export async function productDetails(
  source: { more_info_url?: string; random_key?: string; prk?: string } | string
): Promise<ProductDetails> {
  let prk: string;
  let moreInfoUrl: string;
  let card: ProductCard | null = null;

  if (typeof source === "string") {
    const wanted = source.trim();
    if (!wanted) throw new UpstreamError("Empty product id.", "usage");
    prk = idFrom(wanted);

    const remembered = detailUrls.get(prk);
    if (remembered) {
      moreInfoUrl = remembered.url;
    } else {
      // The id is not a search term upstream, so search for it by name. The
      // name is the only other thing this server keeps, and it is enough.
      const row = await rowForId(prk);
      if (!row?.more_info_url) {
        throw new UpstreamError(
          `No Torob product matched '${wanted}', and this server has no earlier record of it. ` +
            `Product ids expire: call search_products with what the user asked for, then pass the prk ` +
            `from that fresh result.`,
          "usage"
        );
      }
      card = toCard(row);
      moreInfoUrl = str(row.more_info_url);
    }
  } else {
    moreInfoUrl = str(source.more_info_url);
    prk = str(source.random_key ?? source.prk).trim();
    if (!moreInfoUrl) {
      throw new UpstreamError(
        "This product row carries no details URL. Re-run search_products and pass the fresh row.",
        "usage"
      );
    }
    rememberDetailUrl({ random_key: prk, more_info_url: moreInfoUrl } as RawProduct);
  }

  const raw = await detailsRaw(moreInfoUrl, prk);
  const offers = offersOf(raw);
  const base = card ?? toCard(raw);
  if (!base) {
    throw new UpstreamError("Torob returned a product page with no product in it.", "http");
  }

  const prices = offers.filter((o) => o.available && o.price_toman !== null).map((o) => o.price_toman as number);
  const bestRated = offers.filter((o) => o.available && o.shop_score !== null)[0] ?? null;

  return {
    ...base,
    offers,
    offer_count: offers.length,
    price_spread_toman: prices.length > 1 ? Math.max(...prices) - Math.min(...prices) : null,
    cheapest_offer: offers.find((o) => o.available && o.price_toman !== null) ?? null,
    best_rated_offer: bestRated,
    similar_count: 0,
    attribution: ATTRIBUTION,
  };
}

export async function suggestTerms(q: string): Promise<{ query: string; suggestions: string[] }> {
  const raw = await cached(`sg:${q}`, TTL.suggest, () =>
    torobGet<unknown>(`/suggestion2/?q=${encodeURIComponent(q)}&source=next_desktop`)
  );
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const s of raw) {
      const text = short((s as any)?.text, 80);
      if (text) out.push(text);
    }
  }
  return { query: q, suggestions: [...new Set(out)].slice(0, 10) };
}

export function emptyList(): ProductCard[] {
  return [];
}
