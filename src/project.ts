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

import { ATTRIBUTION, MIN_SHOP_VOTES, SORT_PARAMS, SOURCE, TOROB_API, TTL, type Sort } from "./config.js";
import { cached } from "./cache.js";
import { UpstreamError, torobGet } from "./http.js";
import {
  availableFrom,
  foldKey,
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
  /** Torob's own ad flag for this offer. */
  is_adv: boolean;
  /** Torob's postage line as sent, e.g. "هزینه ارسال ۷۰٫۰۰۰ تومان". */
  postage_text: string | null;
  /** Postage parsed from that line; null when it is free or unstated. */
  postage_fee_toman: number | null;
  /** price_toman + stated postage; equals price when postage is free/unstated. */
  delivered_price_toman: number | null;
  /** "enabled" / "disabled" from Torob's guarantee_info. */
  guarantee: string | null;
  /** BNPL providers Torob lists for this offer, by name. */
  installment_providers: string[];
  /** Persian relative time, e.g. "۲ ساعت پیش". */
  last_price_change_date: string | null;
  /** Whether the shop has a public Torob profile page. */
  has_public_torob_profile: boolean | null;
  /** The shop's percentile on Torob, 0-100, when sent. */
  shop_score_percentile: number | null;
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
  /** Torob's ad flag for this row. */
  is_adv: boolean;
  /**
   * Torob's own details URL for this row. It carries the `search_id` the
   * details endpoint wants, so passing it back to product_details /
   * similar_products lets the server open the product without remembering
   * anything between requests.
   */
  details_url: string | null;
}

export interface ProductDetails extends ProductCard {
  offers: Offer[];
  offer_count: number;
  /** Spread between cheapest and dearest available offer, in Toman. */
  price_spread_toman: number | null;
  cheapest_offer: Offer | null;
  best_rated_offer: Offer | null;
  /** Cheapest offer once stated postage is added. */
  cheapest_delivered_offer: Offer | null;
  /** How this id was resolved: exact-id, name-search, details-url, remembered or id-only. */
  resolved_by: string;
  /** Torob's own cheapest and dearest price for this product, before slicing. */
  price_range_toman?: { min: number | null; max: number | null };
  /** How many shops sell this product in person (حضوری), before slicing. */
  in_person_count: number;
  in_person_sellers: InPersonSeller[];
  /** torob.com's own map of those shops, when Torob sent the link. */
  in_person_map_url?: string;
  specs?: SpecItem[];
  specs_truncated?: true;
  specs_available?: number;
  variants?: ProductVariant[];
  category_path?: { id: string; title: string }[];
  purchase_options?: PurchaseOption[];
  is_authentic?: true;
  has_wiki?: true;
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
  is_adv?: unknown;
  postage_fee?: unknown;
  guarantee_info?: unknown;
  installment?: unknown;
  last_price_change_date?: unknown;
  has_public_torob_profile?: unknown;
  shop_score_percentile?: unknown;
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
  is_adv?: unknown;
  product_page_url?: unknown;
  products_info?: { result?: unknown };
  // The details payload is the same one the product page renders, so it carries
  // the in-person shop list, the spec tables and the variant tabs as well. They
  // are read from here rather than fetched again: the response is already paid
  // for (measured: ~300KB of json, of which the seller lists are the bulk).
  products_in_store_info?: {
    count?: unknown;
    result?: unknown;
    is_visible?: unknown;
    map_sellers_url?: unknown;
  };
  key_specs?: unknown;
  structural_specs?: unknown;
  variants?: unknown;
  breadcrumbs?: unknown;
  filters?: { items?: unknown };
  min_price?: unknown;
  max_price?: unknown;
  torob_category?: unknown;
  is_authentic?: unknown;
  has_wiki?: unknown;
}

export interface RawSearch {
  results?: unknown;
  count?: unknown;
  min_price?: unknown;
  max_price?: unknown;
  next?: unknown;
  categories?: unknown;
  filters1?: unknown[];
  filters2?: unknown[];
  attributes?: unknown[];
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

// Torob's details endpoint, and nothing else: the tool layer accepts a URL from
// the caller, so this is the gate that keeps a caller-supplied string from
// pointing a fetch somewhere else.
const DETAILS_HOST = "api.torob.com";
const DETAILS_PATH = "/v4/base-product/details/";

/** A URL only when it is one of Torob's own details URLs, otherwise null. */
export function detailsUrlOf(v: unknown): string | null {
  const raw = str(v).trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname !== DETAILS_HOST) return null;
  if (!parsed.pathname.startsWith(DETAILS_PATH)) return null;
  return parsed.toString();
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
    is_adv: row.is_adv === true,
    details_url: detailsUrlOf(row.more_info_url),
  };
}

// The id a caller gets back is only half an address: Torob's details endpoint
// also wants a `search_id` that exists only on the row we just saw. Three
// things can supply it, and `detailsUrlForId` tries them in this order: the row
// remembered here, the `details_url` the caller echoes back (every card
// carries it), and a fresh search for the product's own name.
//
// The map is per-isolate, and a Worker hands consecutive requests to different
// isolates, so it is a fast path and never the mechanism.
const detailUrls = new Map<string, { url: string; name: string | null }>();
const DETAIL_URL_MEMORY = 500;

// A Worker may finish a request before a floating promise settles, and a cache
// write that was never awaited is exactly how the shared name used to go
// missing: the entry survived only in the isolate that learned it. Anything
// that has to outlive the response goes through here - the Worker hands over
// its `waitUntil`, and Node simply lets the promise run.
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

let keepAliveFn: ((promise: Promise<unknown>) => void) | null = null;

export function setWaitUntil(fn: ((promise: Promise<unknown>) => void) | null): void {
  keepAliveFn = fn;
}

function keepAlive(promise: Promise<unknown>): void {
  if (!keepAliveFn) {
    void promise;
    return;
  }
  try {
    keepAliveFn(promise);
  } catch {
    void promise;
  }
}

function rememberResolved(prk: string, url: string, name: string | null): void {
  if (detailUrls.size >= DETAIL_URL_MEMORY) {
    const oldest = detailUrls.keys().next();
    if (!oldest.done) detailUrls.delete(oldest.value);
  }
  detailUrls.set(prk, { url, name });
}

function rememberDetailUrl(row: RawProduct): void {
  const prk = str(row.random_key).trim();
  const url = detailsUrlOf(row.more_info_url);
  if (!prk || !url) return;
  const name = short(row.name1, 160);
  rememberResolved(prk, url, name);
  // The name is what lets a cold isolate re-resolve the id; the URL it came
  // with is what makes that cost no upstream call at all. Both travel together
  // through the per-colo cache, and only when there is a name: a nameless entry
  // could not be re-found by a search anyway.
  if (name) {
    keepAlive(cacheSet(prk, { name, url }, REMEMBERED_TTL_SECONDS));
  }
}

// Torob sends the postage as a Persian line ("هزینه ارسال ۷۰٫۰۰۰ تومان",
// "هزینه ارسال رایگان") rather than a number. Keep the text and parse the
// number out of it; an unreadable fee stays null and never blocks the offer.
function postageOf(raw: RawOffer): { text: string | null; fee: number | null } {
  const text = short(raw.postage_fee, 60);
  if (!text) return { text: null, fee: null };
  return { text, fee: tomanFromText(text) };
}

function installmentProvidersOf(raw: RawOffer): string[] {
  const providers = (raw.installment as { providers?: unknown } | null | undefined)?.providers;
  if (!Array.isArray(providers)) return [];
  const out: string[] = [];
  for (const p of providers) {
    const name = short((p as any)?.name ?? (p as any)?.short_title, 60);
    if (name) out.push(name);
  }
  return out.slice(0, 5);
}

function toOffer(raw: RawOffer): Offer | null {
  const shop = short(raw.shop_name, 80);
  if (!shop) return null;
  // Prefer the numeric price; fall back to the Persian text when only that is
  // present. Never invent a price from a shop name.
  const price = num(raw.price, 0) > 0 ? Math.round(num(raw.price, 0)) : tomanFromText(raw.price_text ?? raw.price_string);
  const more = raw.more_info ?? {};
  const postage = postageOf(raw);
  const guarantee = short((raw.guarantee_info as { status?: unknown } | null | undefined)?.status, 20);
  const percentile = num(raw.shop_score_percentile, NaN);
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
    is_adv: raw.is_adv === true,
    postage_text: postage.text,
    postage_fee_toman: postage.fee,
    delivered_price_toman: price === null ? null : price + (postage.fee ?? 0),
    guarantee,
    installment_providers: installmentProvidersOf(raw),
    last_price_change_date: short(raw.last_price_change_date, 60),
    has_public_torob_profile: typeof raw.has_public_torob_profile === "boolean" ? raw.has_public_torob_profile : null,
    shop_score_percentile: Number.isFinite(percentile) ? Math.round(percentile) : null,
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

// --------------------------------------------------- in-person (حضوری) shops

/** One shop that sells this product in person, as Torob lists it. */
export interface InPersonSeller {
  shop_name: string;
  shop_id: string | null;
  /** The shop's city, e.g. "مشهد". */
  city: string | null;
  /** Street address as Torob reports it (itself often truncated upstream). */
  address: string | null;
  /** The shop's own note, e.g. "تست و تحویل در حضور مشتری". */
  note: string | null;
  price_toman: number | null;
  price_text: string | null;
  /** Torob's own warning about this shelf price. */
  price_unreliable: boolean;
  is_open: boolean | null;
  /** Torob's own line for today, e.g. "تا ۰۹:۰۰ امروز" or "باز است". */
  hours_today: string | null;
  /** Torob's own status word, e.g. "بسته". */
  hours_status: string | null;
  /**
   * How long ago this shop's price was last touched, as Torob words it
   * (measured: "8 ماه و 9 روز پیش" on a live row). A shelf price can be old,
   * which is exactly why it travels with the number instead of being hidden.
   */
  last_price_change_date: string | null;
  fast_delivery: boolean;
  location: { lat: number; lon: number } | null;
  /** The shop's page on torob.com, where its details live. */
  url: string;
}

function locationOf(raw: any): { lat: number; lon: number } | null {
  const lat = num(raw?.lat, NaN);
  const lon = num(raw?.lon, NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function toInPersonSeller(raw: any): InPersonSeller | null {
  const shop_name = short(raw?.shop_name, 80);
  if (!shop_name) return null;
  const price = num(raw?.price, 0) > 0 ? Math.round(num(raw.price, 0)) : tomanFromText(raw?.price_string ?? raw?.price_text);
  const shopId = str(raw?.shop_id).trim();
  return {
    shop_name,
    shop_id: shopId || null,
    city: short(raw?.shop_name2, 60),
    address: short(raw?.name1, 160),
    note: short(raw?.name2, 120),
    price_toman: price,
    price_text: short(raw?.price_string ?? raw?.price_text, 80) ?? (price !== null ? `${formatToman(price)} تومان` : null),
    price_unreliable: raw?.is_price_unreliable === true,
    is_open: typeof raw?.is_open === "boolean" ? raw.is_open : null,
    hours_today: short(raw?.working_hours?.title?.text, 60),
    hours_status: short(raw?.working_hours?.title?.status, 20),
    last_price_change_date: short(raw?.last_price_change_date, 60),
    fast_delivery: raw?.supports_fast_delivery === true,
    location: locationOf(raw?.location),
    url: shopId
      ? `https://torob.com/shop/${shopId}/`
      : `https://torob.com/p/${str(raw?.prk).trim()}/`,
  };
}

/** The in-person seller list a product's own details payload carries. */
export function inPersonSellersOf(raw: RawProduct): {
  count: number;
  sellers: InPersonSeller[];
  map_url: string | null;
} {
  const block = raw.products_in_store_info;
  const rows = Array.isArray(block?.result) ? block.result : [];
  const sellers: InPersonSeller[] = [];
  for (const row of rows) {
    const seller = toInPersonSeller(row);
    if (seller) sellers.push(seller);
  }
  // Cheapest first, the same way the online offers are ordered, so "where is
  // this cheapest in person" needs no second sort by the caller. A shop with
  // no price sorts last rather than pretending to be cheapest.
  sellers.sort((a, b) => {
    if (a.price_toman === b.price_toman) return 0;
    if (a.price_toman === null) return 1;
    if (b.price_toman === null) return -1;
    return a.price_toman - b.price_toman;
  });
  const link = str(block?.map_sellers_url).trim();
  return {
    count: sellers.length,
    sellers,
    map_url: /^https:\/\/torob\.com\//.test(link) ? link : null,
  };
}

// ------------------------------------------------------ specs and variants

/** One spec line. `group` is Torob's own table header when it sends one. */
export interface SpecItem {
  group: string | null;
  key: string;
  value: string;
}

// Torob marks a table section by sending the literal string "title" as the
// value of the row that names it (measured: {بدنه: "title", وزن: "۱۶۰ گرم",
// پلتفرم: "title"}). Keeping those would hand an agent a spec whose value is
// the word "title", so they are dropped - but only that exact marker, never a
// real value that happens to be short.
const SPEC_GROUP_MARKER = "title";
const SPEC_CAP = 24;

function specValue(v: unknown): string | null {
  if (Array.isArray(v)) {
    const parts = v.map((x) => short(x, 120)).filter((x): x is string => Boolean(x));
    return parts.length ? parts.join("، ") : null;
  }
  if (typeof v === "string" || typeof v === "number") {
    const text = short(v, 160);
    return text && text !== SPEC_GROUP_MARKER ? text : null;
  }
  return null;
}

/** The spec tables a product page shows, flattened into one capped list. */
export function specsOf(raw: RawProduct): { items: SpecItem[]; available: number; truncated: boolean } {
  const all: SpecItem[] = [];
  const keySpecs = Array.isArray(raw.key_specs) ? raw.key_specs : [];
  for (const block of keySpecs) {
    const header = short((block as any)?.header, 80);
    const items = Array.isArray((block as any)?.items) ? (block as any).items : [];
    for (const item of items) {
      const key = short((item as any)?.key ?? (item as any)?.title, 80);
      const value = specValue((item as any)?.value);
      if (key && value) all.push({ group: header, key, value });
    }
  }
  const structural = raw.structural_specs as { headers?: unknown } | undefined;
  const headers = Array.isArray(structural?.headers) ? (structural.headers as any[]) : [];
  for (const block of headers) {
    const header = short(block?.header, 80);
    const specs = block?.specs && typeof block.specs === "object" ? (block.specs as Record<string, unknown>) : {};
    for (const [key, value] of Object.entries(specs)) {
      const text = specValue(value);
      if (text) all.push({ group: header, key: short(key, 80) ?? key, value: text });
    }
  }
  return {
    items: all.slice(0, SPEC_CAP),
    available: all.length,
    truncated: all.length > SPEC_CAP,
  };
}

/** The variant tabs a product page shows (e.g. "اصالت کالا"), as cards. */
export interface ProductVariant {
  title: string;
  count: number;
  items: ProductCard[];
}

const VARIANT_GROUPS = 3;
const VARIANT_ITEMS = 5;

export function variantsOf(raw: RawProduct): ProductVariant[] {
  const list = Array.isArray(raw.variants) ? raw.variants : [];
  const out: ProductVariant[] = [];
  for (const group of list) {
    const title = short((group as any)?.title, 80);
    const items = Array.isArray((group as any)?.items) ? (group as any).items : [];
    if (!title || !items.length) continue;
    const cards: ProductCard[] = [];
    for (const item of items) {
      const card = toCard(item as RawProduct);
      if (card) cards.push(card);
      if (cards.length >= VARIANT_ITEMS) break;
    }
    if (cards.length) out.push({ title, count: items.length, items: cards });
    if (out.length >= VARIANT_GROUPS) break;
  }
  return out;
}

/** The category path Torob shows above the product, without its root. */
export function categoryPathOf(raw: RawProduct): { id: string; title: string }[] {
  const list = Array.isArray(raw.breadcrumbs) ? raw.breadcrumbs : [];
  const out: { id: string; title: string }[] = [];
  for (const step of list) {
    const id = str((step as any)?.cat_id ?? (step as any)?.id).trim();
    const title = short((step as any)?.title, 80);
    // The first crumb is always Torob itself (cat_id 0).
    if (!title || id === "0") continue;
    out.push({ id, title });
  }
  return out.slice(0, 6);
}

/**
 * Torob's own quick purchase filters for this product ("دارای ضمانت ترب",
 * "با اعتبار ترب‌پی"): the price it starts at and how many sellers behind it.
 * They are reported as sent, because the wording and the price are Torob's.
 */
export interface PurchaseOption {
  title: string;
  price_from_text: string | null;
  online_sellers: number | null;
  offline_sellers: number | null;
}

const PURCHASE_OPTION_CAP = 6;

export function purchaseOptionsOf(raw: RawProduct): PurchaseOption[] {
  const items = Array.isArray(raw.filters?.items) ? (raw.filters?.items as any[]) : [];
  const out: PurchaseOption[] = [];
  for (const item of items) {
    const title = short(item?.title, 80);
    if (!title) continue;
    const online = num(item?.online_shop_display_count, NaN);
    const offline = num(item?.offline_shop_display_count, NaN);
    out.push({
      title,
      price_from_text: short(item?.price_str, 60),
      online_sellers: Number.isFinite(online) ? Math.max(0, Math.round(online)) : null,
      offline_sellers: Number.isFinite(offline) ? Math.max(0, Math.round(offline)) : null,
    });
    if (out.length >= PURCHASE_OPTION_CAP) break;
  }
  return out;
}

/**
 * The full price window Torob knows for this product: its own cheapest and
 * dearest offer, straight from the details payload rather than from the
 * (partially truncated) seller list this server hands back.
 */
export function priceWindowOf(raw: RawProduct): { min: number | null; max: number | null } | null {
  const min = toman(raw.min_price);
  const max = toman(raw.max_price);
  if (min === null && max === null) return null;
  return { min, max };
}

// ----------------------------------------------------------------- endpoints

function searchKey(q: string, page: number, sort: string, category: string, shopType: string, filters: string): string {
  // Folded so two spellings of one query share one cache entry and one upstream
  // call ("آيفون" / "آیفون").
  return `s:${foldKey(q)}|${page}|${sort}|${category}|${shopType}|${filters}`;
}

export interface SearchOptions {
  q: string;
  page: number; // 1-based here, 0-based upstream
  sort: string;
  category?: string;
  brand?: string;
  city?: string;
  shopType?: string;
  /** Upstream filter params, already validated by the tool layer. */
  filters?: Record<string, string>;
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
  /**
   * The price group's own bounds for this result set (Torob sends the real
   * minimum and maximum as a filter, measured: 47,985 to 444,480,000 on
   * "هدفون"). It is the range of what is on this page set, not of the page.
   */
  price_bounds_toman: { min: number | null; max: number | null } | null;
  /**
   * Every brand this search offers, with the slug a `brand` filter needs. The
   * brand group in available_filters is only a preview, so this is the list to
   * read when the wanted brand is not in it.
   */
  brand_values: { name: string; slug: string }[];
  brand_values_truncated?: true;
  /** Categories Torob suggested for this wording, so an agent can narrow down. */
  suggested_categories: { id: string; title: string }[];
  /** Every filter group this search accepts, with its slug. */
  available_filters: FilterGroup[];
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

export interface FilterOption {
  /** The label the search UI shows. */
  name: string;
  /** The value to pass back in `filters` for this option. */
  value: string;
}

export interface FilterGroup {
  title: string;
  slug: string;
  type: string;
  /** How many values this group advertises. */
  values: number;
  /** The values to pass back in `filters`; absent when the group takes none. */
  options?: FilterOption[];
  /** True when `options` is a preview rather than the whole list. */
  options_truncated?: boolean;
  /** For a brand group, the endpoint that lists all its values. */
  values_url?: string;
}

// Groups whose items are a fixed set of choices ship their option list, so a
// caller can pass one back without a second call. Brand groups are a preview
// plus their own values endpoint (their full list is not inlined), and price
// groups are a range, not choices: they compile to price__gt / price__lt.
// Exported because the tool layer names the preview size when it reports the
// full brand list instead of the group's own excerpt.
export const OPTION_PREVIEW = 10;
const OPTION_CAP = 60;

function optionValueOf(item: unknown): string {
  // A brand item carries the slug a filter needs; a choice item carries value.
  if (item && typeof item === "object" && "value" in (item as object)) return str((item as any).value);
  return str((item as any)?.slug);
}

function filterGroupsOf(raw: RawSearch): FilterGroup[] {
  const out: FilterGroup[] = [];
  const brief = (g: any) => {
    const slug = str(g?.slug).trim();
    if (!slug) return null;
    const type = str(g?.type, "unknown");
    const items = Array.isArray(g?.items) ? g.items : [];
    const options: FilterOption[] = [];
    if (type !== "price") {
      for (const item of items) {
        const value = optionValueOf(item);
        const name =
          short((item as any)?.name ?? (item as any)?.name1 ?? (item as any)?.title ?? (item as any)?.name2, 80) ?? value;
        if (name || value) options.push({ name, value });
        if (options.length >= OPTION_CAP) break;
      }
    }
    // A brand group's list is a preview (values_url has the rest), so it is
    // never treated as the complete set when a caller's value is checked.
    const truncated = type === "brand" ? true : items.length > options.length;
    return {
      title: str(g?.title, slug),
      slug,
      type,
      values: items.length,
      ...(options.length ? { options: type === "brand" ? options.slice(0, OPTION_PREVIEW) : options } : {}),
      ...(options.length && truncated ? { options_truncated: true } : {}),
      ...(str(g?.url) ? { values_url: str(g.url) } : {}),
    } satisfies FilterGroup;
  };
  for (const group of [...(raw.filters1 ?? []), ...(raw.filters2 ?? []), ...(raw.attributes ?? [])]) {
    if (!group || typeof group !== "object") continue;
    const b = brief(group);
    if (b) out.push(b);
  }
  return out;
}

// The filter keys a response says it accepts: each group's own slug, plus the
// price group's price__gt / price__lt. `q` is the query itself and `sort` has
// its own argument, so neither is a filter key.
export function filterKeyMap(groups: FilterGroup[]): Map<string, FilterGroup> {
  const map = new Map<string, FilterGroup>();
  for (const g of groups) {
    if (g.slug === "q") continue;
    if (g.type === "price") {
      map.set("price__gt", g);
      map.set("price__lt", g);
      continue;
    }
    map.set(g.slug, g);
  }
  return map;
}

// The price group's own bounds: items are [{value, slug: "price__gt"}, {value,
// slug: "price__lt"}], which is Torob telling the UI where its slider ends.
// Read from the groups rather than from raw.min_price/max_price, because those
// two move between identical requests (measured on the same query: 1125 then
// 1200 results), while the bounds track the set that was actually returned.
export function priceBoundsOf(raw: RawSearch): { min: number | null; max: number | null } | null {
  const groups = [...(raw.filters1 ?? []), ...(raw.filters2 ?? [])];
  let min: number | null = null;
  let max: number | null = null;
  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const items = Array.isArray((group as any).items) ? (group as any).items : [];
    for (const item of items) {
      const slug = str((item as any)?.slug).trim();
      const value = toman((item as any)?.value);
      if (value === null) continue;
      if (slug === "price__gt") min = value;
      if (slug === "price__lt") max = value;
    }
  }
  return min === null && max === null ? null : { min, max };
}

// The brand chips of a search: {id, slug, name1, name2}. This is the complete
// list the search offers, whereas the brand group inside available_filters is a
// preview (OPTION_PREVIEW entries) whose full list lives behind values_url.
const BRAND_VALUE_CAP = 30;

export function brandValuesOf(raw: RawSearch): { values: { name: string; slug: string }[]; truncated: boolean } {
  const groups = Array.isArray(raw.attributes) ? raw.attributes : [];
  const values: { name: string; slug: string }[] = [];
  let total = 0;
  for (const group of groups) {
    if (str((group as any)?.type).trim() !== "brand") continue;
    const items = Array.isArray((group as any)?.items) ? (group as any).items : [];
    for (const item of items) {
      const slug = str((item as any)?.slug).trim();
      const name = short((item as any)?.name1 ?? (item as any)?.name2, 80);
      if (!slug || !name) continue;
      total += 1;
      if (values.length < BRAND_VALUE_CAP) values.push({ name, slug });
    }
    break;
  }
  return { values, truncated: total > values.length };
}

// The filter groups a search taught us, remembered for the same query and the
// same narrowing (category/city/shop type/brand). A later call in that exact
// context can be validated before spending an upstream request; any other
// context falls back to the fresh response, which is always the authority.
const filterGroupsMemory = new Map<string, FilterGroup[]>();
const FILTER_MEMORY_ENTRIES = 200;
const FILTER_MEMORY_PREFIX = "filters/";
const FILTER_MEMORY_TTL_SECONDS = 30 * 60;

export function filterMemoryKey(
  q: string,
  opts?: { category?: string; city?: string; shopType?: string; brand?: string }
): string {
  return [foldKey(q), opts?.category ?? "", opts?.city ?? "", opts?.shopType ?? "", opts?.brand ?? ""].join("|");
}

export function rememberFilterGroups(key: string, groups: FilterGroup[]): void {
  if (filterGroupsMemory.size >= FILTER_MEMORY_ENTRIES) {
    const oldest = filterGroupsMemory.keys().next();
    if (!oldest.done) filterGroupsMemory.delete(oldest.value);
  }
  filterGroupsMemory.set(key, groups);
  keepAlive(cacheSet(`${FILTER_MEMORY_PREFIX}${encodeURIComponent(key)}`, groups, FILTER_MEMORY_TTL_SECONDS));
}

export async function rememberedFilterGroups(key: string): Promise<FilterGroup[] | null> {
  const local = filterGroupsMemory.get(key);
  if (local) return local;
  const shared = await cacheGet(`${FILTER_MEMORY_PREFIX}${encodeURIComponent(key)}`);
  return Array.isArray(shared) ? (shared as FilterGroup[]) : null;
}

export async function searchProducts(opts: SearchOptions): Promise<SearchResult> {
  const raw = await searchRaw(opts);
  const result = projectSearch(raw, opts);
  rememberFilterGroups(
    filterMemoryKey(opts.q, { category: opts.category, city: opts.city, shopType: opts.shopType, brand: opts.brand }),
    result.available_filters
  );
  return result;
}

// The upstream payload, cached. Kept separate from the projection so the
// details path can reuse a search it already paid for instead of asking again.
async function searchRaw(opts: SearchOptions): Promise<RawSearch> {
  const filters = opts.filters ?? {};
  const key = searchKey(opts.q, opts.page, opts.sort, opts.category ?? "", opts.shopType ?? "", JSON.stringify(filters));
  return cached(key, TTL.search, () => {
    const params = new URLSearchParams({
      q: opts.q,
      // Torob pages upstream are 0-based; this server takes 1-based pages.
      page: String(Math.max(0, opts.page - 1)),
      size: "24",
      // Upstream's own sort vocabulary; the tool-facing names are stable.
      sort: SORT_PARAMS[opts.sort as Sort] ?? "",
    });
    if (opts.category) params.set("category", opts.category);
    if (opts.brand) params.set("brand", opts.brand);
    if (opts.city) params.set("city", opts.city);
    // Validated slugs, passed through as upstream expects them.
    for (const [k, v] of Object.entries(filters)) params.set(k, v);
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
  const brands = brandValuesOf(raw);

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
    price_bounds_toman: priceBoundsOf(raw),
    brand_values: brands.values,
    ...(brands.truncated ? { brand_values_truncated: true as const } : {}),
    suggested_categories: categoriesOf(raw.categories),
    // The filter groups and attributes this search would accept. Reporting
    // them is what lets an agent narrow down without a second discovery call,
    // and it is how a caller learns the real slugs before using `filters`.
    available_filters: filterGroupsOf(raw),
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

// A product id on its own is NOT a search term, and this was measured: feeding
// a search result's prk back as a query returns nothing, because the search
// endpoint matches names, not ids. The product's own name does work - a card
// carries name1, and a search for it returns the product again, usually first
// and always with a fresh details URL - so the name is what re-resolves an id
// on a cold isolate. The caller's own wording is tried after it.
//
// A name search can drift onto a similar product ("A57" vs "A37"), and almost
// is a wrong answer when the answer is a price. An exact id match is proof; a
// first row is accepted only when its folded name really is the remembered
// name, and the caller is told it was matched by name rather than by id.
interface FoundRow {
  row: RawProduct;
  matched_exact: boolean;
}

const NAME_TOKENS_RE = /[^\p{L}\p{N}]+/u;

function nameTokens(s: string): string[] {
  return foldKey(s)
    .split(NAME_TOKENS_RE)
    .filter((t) => t.length > 1);
}

function sameNameTokens(a: string[], b: string[]): boolean {
  if (a.length < 2 || b.length < 2) return false;
  const shared = a.filter((t) => b.includes(t)).length;
  const dice = (2 * shared) / (a.length + b.length);
  if (dice < 0.9) return false;
  const numeric = (ts: string[]) => ts.filter((t) => /\d/.test(t)).sort().join(",");
  return numeric(a) === numeric(b);
}

function nameMatches(knownName: string | null, row: RawProduct): boolean {
  const target = foldKey(knownName ?? "");
  if (!target) return false;
  const targetTokens = nameTokens(target);
  for (const candidate of [row.name1, row.name2]) {
    const folded = foldKey(candidate);
    if (!folded) continue;
    if (folded === target) return true;
    if (sameNameTokens(targetTokens, nameTokens(folded))) return true;
  }
  return false;
}

/** A shared cap on the extra upstream lookups one tool call may make. */
export interface LookupBudget {
  left: number;
}

function spend(budget: LookupBudget | undefined): boolean {
  if (!budget) return true;
  if (budget.left <= 0) return false;
  budget.left -= 1;
  return true;
}

async function rowForId(
  prk: string,
  knownName: string | null,
  budget: LookupBudget | undefined,
  ...queries: (string | null | undefined)[]
): Promise<FoundRow | null> {
  const attempts = queries
    .map((q) => str(q).trim())
    .filter((q, i, all) => q.length > 0 && all.indexOf(q) === i);
  for (const q of attempts) {
    if (!spend(budget)) return null;
    const raw = await searchRaw({ q, page: 1, sort: "popularity" });
    const rows = Array.isArray(raw.results) ? (raw.results as RawProduct[]) : [];
    const exact = rows.find((r) => str(r.random_key) === prk);
    if (exact) return { row: exact, matched_exact: true };
    const first = rows[0];
    if (first?.more_info_url && nameMatches(knownName, first)) return { row: first, matched_exact: false };
  }
  return null;
}

// What an isolate learns has to outlive it. A Worker spreads consecutive
// requests across many isolates, so an in-process map is a fast path and
// nothing more - a live test caught a call failing because it landed somewhere
// the search had never run. The Cache API is per-colo rather than per-isolate,
// so one isolate learning a product spares the others in that colo, and the
// entry carries both things it learned: the name and the details URL. It is a
// cache: a write that fails only costs one extra search, so failures are
// swallowed rather than raised - and the write goes through `waitUntil`, so it
// is not cut off when the response finishes.
const REMEMBERED_CACHE_PREFIX = "https://torob-mcp.internal/product/";
const REMEMBERED_TTL_SECONDS = 24 * 60 * 60;

async function cacheGet(key: string): Promise<unknown | undefined> {
  try {
    const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    if (!cache) return undefined;
    const hit = await cache.match(`${REMEMBERED_CACHE_PREFIX}${key}`);
    return hit ? await hit.json() : undefined;
  } catch {
    return undefined;
  }
}

async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    if (!cache) return;
    await cache.put(
      `${REMEMBERED_CACHE_PREFIX}${key}`,
      new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttlSeconds}` },
      })
    );
  } catch {
    /* best effort - the in-process map still has it */
  }
}

// What one isolate learned from a search row, read back: the product's name and
// the details URL that row came with. The in-process map is the fast path; the
// per-colo cache is what a *different* isolate can still read.
async function rememberedInfo(prk: string): Promise<{ name: string | null; url: string | null }> {
  const local = detailUrls.get(prk);
  if (local) return { name: local.name, url: local.url };
  const shared = (await cacheGet(prk)) as { name?: string; url?: string } | undefined;
  if (!shared) return { name: null, url: null };
  const name = short(shared.name, 160);
  const url = detailsUrlOf(shared.url);
  if (url) rememberResolved(prk, url, name);
  return { name, url };
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

export interface ProductDetailsOptions {
  /** The `details_url` a card carried, handed back by the caller. */
  detailsUrl?: unknown;
  /** The words the caller searched with, as a last-resort way back to the row. */
  query?: unknown;
  /**
   * Internal: a shared cap on the extra upstream lookups a batch (compare) may
   * spend resolving ids. Omitted means no cap beyond the normal path.
   */
  lookupBudget?: LookupBudget;
}

interface ResolvedProduct {
  prk: string;
  url: string;
  card: ProductCard | null;
  /** How the id was resolved; surfaced so a fuzzy match is never invisible. */
  resolvedBy: string;
  /** Set only by the last-resort direct call, so it is not paid for twice. */
  raw?: RawProduct;
}

/** The details URL for an id, built from the id alone. */
function prkOnlyDetailsUrl(prk: string): string {
  return `${TOROB_API}/v4/base-product/details/?prk=${encodeURIComponent(prk)}`;
}

// A product id is only half an address upstream: the details endpoint also wants
// the `search_id` of the row it was seen on, and that id exists nowhere else.
// Four sources can supply it, tried in this order.
async function detailsUrlForId(wanted: string, opts?: ProductDetailsOptions): Promise<ResolvedProduct> {
  const prk = idFrom(wanted);
  const budget = opts?.lookupBudget;

  // 1. Whatever this isolate, or another one in this colo, already learned.
  const known = await rememberedInfo(prk);
  if (known.url) return { prk, url: known.url, card: null, resolvedBy: "remembered" };

  // 2. The details_url the caller echoed back. This is the path that needs no
  // memory at all, which is why every card carries the URL.
  const provided = detailsUrlOf(opts?.detailsUrl);
  if (provided) {
    rememberDetailUrl({ random_key: prk, more_info_url: provided } as RawProduct);
    return { prk, url: provided, card: null, resolvedBy: "details-url" };
  }

  // 3. The name the id was learned under, then the caller's own wording: a prk
  // is not a search term, a name is.
  const found = await rowForId(prk, known.name, budget, str(opts?.query));
  if (found?.row.more_info_url) {
    return {
      prk,
      url: str(found.row.more_info_url),
      card: toCard(found.row),
      resolvedBy: found.matched_exact ? "exact-id" : "name-search",
    };
  }

  // 4. Last resort: ask the details endpoint for the id alone. Whether it
  // answers is upstream's business, which is why it is tried last - and when it
  // answers, the id in the response is checked so a different product is never
  // handed back as this one. A response with no id at all is accepted only when
  // it still projects to a product: an empty answer to the id-only call is not
  // a product, and accepting it would hide the honest "search first" error
  // below, which is the one a caller can act on.
  if (budget && budget.left <= 0) {
    throw new UpstreamError(
      `This call ran out of its shared lookup budget before it could open '${wanted}'. Open this product with ` +
        `product_details on its own - pass its details_url if you have one - or run search_products for it first.`,
      "usage"
    );
  }
  if (spend(budget)) {
    try {
      const raw = await detailsRaw(prkOnlyDetailsUrl(prk), prk);
      const answeredId = str(raw.random_key).trim();
      const card = toCard(raw);
      if (answeredId === prk || (!answeredId && card)) {
        return { prk, url: prkOnlyDetailsUrl(prk), card, raw, resolvedBy: "id-only" };
      }
    } catch {
      /* fall through to the honest error below */
    }
  }

  throw new UpstreamError(
    `No Torob product matched '${wanted}', and this server has no earlier record of it. Product ids expire ` +
      `and are not searchable on their own: call search_products with what the user asked for, then pass both ` +
      `the prk and the details_url from that fresh result.`,
    "usage"
  );
}

/**
 * Open a product. `source` is either a product id / product URL, or a search
 * result row passed whole.
 *
 * The id is resolved through the details URL this server saw when it handed
 * that id out; a caller that passes the card's `details_url` back needs no
 * memory at all, and a name search covers the case where both are gone (a fresh
 * isolate, a restart, a much older id).
 */
export async function productDetails(
  source: { more_info_url?: string; random_key?: string; prk?: string } | string,
  opts?: ProductDetailsOptions
): Promise<ProductDetails> {
  let resolved: ResolvedProduct;

  if (typeof source === "string") {
    const wanted = source.trim();
    if (!wanted) throw new UpstreamError("Empty product id.", "usage");
    resolved = await detailsUrlForId(wanted, opts);
  } else {
    const url = detailsUrlOf(source.more_info_url);
    if (!url) {
      throw new UpstreamError(
        "This product row carries no details URL. Re-run search_products and pass the fresh row.",
        "usage"
      );
    }
    const prk = str(source.random_key ?? source.prk).trim();
    rememberDetailUrl({ random_key: prk, more_info_url: url } as RawProduct);
    resolved = { prk, url, card: null, resolvedBy: "provided-row" };
  }

  const raw = resolved.raw ?? (await detailsRaw(resolved.url, resolved.prk));
  const offers = offersOf(raw);
  const base = resolved.card ?? toCard(raw);
  if (!base) {
    throw new UpstreamError("Torob returned a product page with no product in it.", "http");
  }

  const prices = offers.filter((o) => o.available && o.price_toman !== null).map((o) => o.price_toman as number);
  // "Best rated" is the highest score, not the first scored offer in a list
  // sorted cheapest-first (measured: the old pick put a 3.0 shop above a 5.0
  // one whenever the cheaper shop came first). Ties break on votes, then price.
  const bestRated =
    offers
      .filter((o) => o.available && o.shop_score !== null)
      .sort(
        (a, b) =>
          (b.shop_score as number) - (a.shop_score as number) ||
          b.shop_votes - a.shop_votes ||
          (a.price_toman ?? Number.POSITIVE_INFINITY) - (b.price_toman ?? Number.POSITIVE_INFINITY)
      )[0] ?? null;
  // Cheapest once stated postage is added. Free and unstated postage both cost
  // nothing extra here, which is why the note next to it says what it includes.
  const delivered =
    offers
      .filter((o) => o.available && o.delivered_price_toman !== null)
      .sort(
        (a, b) =>
          (a.delivered_price_toman as number) - (b.delivered_price_toman as number) ||
          (a.price_toman ?? Number.POSITIVE_INFINITY) - (b.price_toman ?? Number.POSITIVE_INFINITY)
      )[0] ?? null;

  // Everything below rides along in the payload this function already fetched:
  // the in-person shop list, the spec tables, the variant tabs, the category
  // path, the full price window and Torob's own quick purchase filters. None of
  // it costs an extra upstream request, which is why it is not behind a flag.
  const inPerson = inPersonSellersOf(raw);
  const specs = specsOf(raw);
  const priceWindow = priceWindowOf(raw);
  const variants = variantsOf(raw);
  const categoryPath = categoryPathOf(raw);
  const purchaseOptions = purchaseOptionsOf(raw);

  return {
    ...base,
    offers,
    offer_count: offers.length,
    price_spread_toman: prices.length > 1 ? Math.max(...prices) - Math.min(...prices) : null,
    cheapest_offer: offers.find((o) => o.available && o.price_toman !== null) ?? null,
    best_rated_offer: bestRated,
    cheapest_delivered_offer: delivered,
    resolved_by: resolved.resolvedBy,
    ...(priceWindow ? { price_range_toman: priceWindow } : {}),
    in_person_count: inPerson.count,
    in_person_sellers: inPerson.sellers,
    ...(inPerson.map_url ? { in_person_map_url: inPerson.map_url } : {}),
    ...(specs.items.length
      ? { specs: specs.items, ...(specs.truncated ? { specs_truncated: true, specs_available: specs.available } : {}) }
      : {}),
    ...(variants.length ? { variants } : {}),
    ...(categoryPath.length ? { category_path: categoryPath } : {}),
    ...(purchaseOptions.length ? { purchase_options: purchaseOptions } : {}),
    ...(raw.is_authentic === true ? { is_authentic: true } : {}),
    ...(raw.has_wiki === true ? { has_wiki: true } : {}),
    attribution: ATTRIBUTION,
  };
}

/**
 * Confirm that a product id is one Torob will answer for. Every tool that
 * opens a product by id needs the same proof: Torob's product endpoints take a
 * bare prk but answer nothing for an id they cannot resolve, and a prk alone
 * carries no search_id. Memory, the caller's details_url and a name search are
 * tried in that order - the same path product_details walks.
 */
async function confirmedPrk(prkInput: string, opts?: ProductDetailsOptions): Promise<string> {
  const wanted = str(prkInput).trim();
  if (!wanted) throw new UpstreamError("Empty product id.", "usage");
  const prk = idFrom(wanted);
  const provided = detailsUrlOf(opts?.detailsUrl);
  if (provided) rememberDetailUrl({ random_key: prk, more_info_url: provided } as RawProduct);
  if (detailUrls.has(prk)) return prk;
  const known = await rememberedInfo(prk);
  if (known.url) return prk;
  const found = await rowForId(prk, known.name, opts?.lookupBudget, str(opts?.query));
  if (found) return prk;
  throw new UpstreamError(
    `No record of product '${wanted}' on this server, and Torob cannot look up a product by id alone. ` +
      `Call search_products for what the user asked for first, then pass the prk and the details_url from ` +
      `that result.`,
    "usage"
  );
}

/**
 * Products Torob considers comparable to this one. This is the "that one is
 * too expensive - what else?" call, and it needs the same id resolution as
 * product_details.
 */
export async function similarProducts(
  prkInput: string,
  limit: number,
  opts?: ProductDetailsOptions
): Promise<ProductCard[]> {
  const prk = await confirmedPrk(prkInput, opts);
  const raw = await cached(`sim:${prk}`, TTL.similar, () =>
    torobGet<RawSearch>(
      `/v4/base-product/similar-base-product/?prk=${encodeURIComponent(prk)}&limit=24&source=torob_search`
    )
  );
  const rows = Array.isArray(raw.results) ? (raw.results as RawProduct[]) : [];
  for (const row of rows) rememberDetailUrl(row);
  return rows.map(toCard).filter((c): c is ProductCard => c !== null).slice(0, limit);
}

// ---------------------------------------------------- price and shop calls

/**
 * Torob's own price chart for a product: monthly points, each series carrying
 * its own label ("میانگین قیمت", "کمترین قیمت"). The upstream call takes only
 * the prk - the site adds a timestamp to defeat its CDN, which this server
 * deliberately does not do: the local TTL is what decides freshness, and a
 * cache-buster on every call would turn a free read into a fresh round trip.
 */
export async function productPriceChart(
  prkInput: string,
  months: number,
  opts?: ProductDetailsOptions
): Promise<PriceChart> {
  const prk = await confirmedPrk(prkInput, opts);
  const raw = await cached(`ch:${prk}`, TTL.chart, () =>
    torobGet<unknown>(`/v4/base-product/price-chart/?prk=${encodeURIComponent(prk)}`)
  );
  return priceChartOf(raw, months);
}

export interface PriceChangesResult {
  /** How many changes Torob has on record for this product. */
  count: number;
  changes: PriceChange[];
}

/** Torob's own feed of price changes for one product, newest first. */
export async function productPriceChanges(
  prkInput: string,
  limit: number,
  opts?: ProductDetailsOptions
): Promise<PriceChangesResult> {
  const prk = await confirmedPrk(prkInput, opts);
  const raw = await cached(`pc:${prk}:${limit}`, TTL.changes, () =>
    torobGet<unknown>(`/v4/base-product/price-history/?prk=${encodeURIComponent(prk)}&page=0&size=${limit}`)
  );
  return priceChangesOf(raw, limit);
}

/** When Torob last changed this product's prices, as its own timestamp. */
export async function productLastModified(prkInput: string, opts?: ProductDetailsOptions): Promise<string | null> {
  const prk = await confirmedPrk(prkInput, opts);
  const raw = (await cached(`lm:${prk}`, TTL.freshness, () =>
    torobGet<unknown>(`/v4/base-product/last-modified-date/?prk=${encodeURIComponent(prk)}`)
  )) as { last_modified_date?: unknown };
  return short(raw?.last_modified_date, 40);
}

// Shop ids are numeric upstream. Checking the shape here means a mistyped id
// gets a sentence about ids instead of a 404 from Torob.
function shopIdOf(v: unknown): string {
  const id = str(v).trim();
  if (!/^\d{1,12}$/.test(id)) {
    throw new UpstreamError(
      `'${id}' is not a Torob shop id. A shop id is the numeric shop_id on a product_details offer, ` +
        `or an id from find_shops.`,
      "usage"
    );
  }
  return id;
}

/** One shop's Torob profile page, projected. */
export async function shopProfile(shopIdInput: unknown): Promise<ShopProfile> {
  const id = shopIdOf(shopIdInput);
  const raw = await cached(`sh:${id}`, TTL.shop, () =>
    torobGet<unknown>(`/v4/internet-shop/details/?id=${encodeURIComponent(id)}`)
  );
  return shopProfileOf(raw, id);
}

export interface ShopCatalog {
  shop_id: string;
  /** How many products this shop has listed on Torob. */
  count: number;
  min_price_toman: number | null;
  max_price_toman: number | null;
  page: number;
  /** How many cards this upstream page held, before our own `limit`. */
  page_count: number;
  has_next_page: boolean;
  products: ProductCard[];
}

/** A shop's own catalogue, as search-style cards. */
export async function shopProducts(shopIdInput: unknown, page: number, limit: number): Promise<ShopCatalog> {
  const id = shopIdOf(shopIdInput);
  const raw = (await cached(`spl:${id}:${page}`, TTL.shopProducts, () =>
    torobGet<unknown>(`/v4/internet-shop/base-product/list/?shop_id=${encodeURIComponent(id)}&page=${Math.max(0, page - 1)}`)
  )) as any;
  const rows = Array.isArray(raw?.results) ? (raw.results as RawProduct[]) : [];
  // The same rule as a search: every card we hand out stays resolvable.
  for (const row of rows) rememberDetailUrl(row);
  return {
    shop_id: id,
    count: Math.max(0, Math.round(num(raw?.count, rows.length))),
    min_price_toman: toman(raw?.min_price),
    max_price_toman: toman(raw?.max_price),
    page,
    page_count: rows.length,
    has_next_page: typeof raw?.next === "string" && raw.next.length > 0,
    products: rows.map(toCard).filter((c): c is ProductCard => c !== null).slice(0, limit),
  };
}

export interface ShopSearchResult {
  count: number;
  page: number;
  has_next_page: boolean;
  shops: ShopSummary[];
}

/**
 * Torob's shop directory: a search over SHOPS, not products. Kept apart from
 * search_products on purpose - "موبایل" here means 11,124 businesses with that
 * word in their name, not products.
 */
export async function findShops(opts: {
  q?: string;
  city?: string;
  shopType?: string;
  page: number;
  limit: number;
}): Promise<ShopSearchResult> {
  const params = new URLSearchParams({
    page: String(Math.max(0, opts.page - 1)),
    size: "24",
    shop_type: opts.shopType ?? "all",
    show_blocks: "true",
    has_payment: "false",
  });
  if (opts.q) params.set("q", opts.q);
  if (opts.city) params.set("city", opts.city);
  const raw = (await cached(`shs:${params.toString()}`, TTL.shops, () =>
    torobGet<unknown>(`/v4/internet-shop/list/?${params.toString()}`)
  )) as { count?: unknown; next?: unknown };
  const { count, shops } = shopsOf(raw, opts.limit);
  return {
    count,
    page: opts.page,
    has_next_page: typeof raw?.next === "string" && raw.next.length > 0,
    shops,
  };
}

// Torob's image search takes a URL, not a file: the page's own upload path is
// for pictures a browser picked, while this endpoint is what the result page
// asks with. A card the agent already has an image URL for is therefore enough.
export interface ImageSearchResult {
  page: number;
  page_count: number;
  has_next_page: boolean;
  /** Torob's echo of the image it looked at. */
  uploaded_image_url: string | null;
  /** Set when Torob recognised the image as one specific product. */
  matched_product: ProductCard | null;
  /** What Torob says it saw in the picture, when it says anything. */
  detected_objects: string[];
  products: ProductCard[];
}

function detectedObjectsOf(raw: any): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    const text = short(v, 60);
    if (text && !out.includes(text)) out.push(text);
  };
  const sorted = raw?.detected_objects?.sorted;
  if (Array.isArray(sorted)) {
    for (const item of sorted) {
      if (typeof item === "string") push(item);
      else push(item?.name ?? item?.label ?? item?.title ?? item?.text ?? item?.class_name);
    }
  }
  if (typeof raw?.detected_objects?.initial === "string") push(raw.detected_objects.initial);
  return out.slice(0, 8);
}

export async function searchByImage(imageUrl: string, page: number, limit: number): Promise<ImageSearchResult> {
  const wanted = imageUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(wanted);
  } catch {
    throw new UpstreamError(
      `search_by_image needs an http(s) image URL - '${wanted}' is not a URL. Torob fetches the image itself, ` +
        `so the link has to be reachable from the internet.`,
      "usage"
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UpstreamError(
      `search_by_image only accepts http(s) image URLs; '${parsed.protocol}' is not one.`,
      "usage"
    );
  }
  const params = new URLSearchParams({ image_url: parsed.toString(), page: String(Math.max(0, page - 1)), size: "24", source: SOURCE });
  const raw = (await cached(`img:${page}:${parsed.toString()}`, TTL.image, () =>
    torobGet<unknown>(`/v4/base-product/search-by-image/?${params.toString()}`)
  )) as any;
  const rows = Array.isArray(raw?.results) ? (raw.results as RawProduct[]) : [];
  for (const row of rows) rememberDetailUrl(row);
  return {
    page,
    page_count: rows.length,
    has_next_page: typeof raw?.next === "string" && raw.next.length > 0,
    uploaded_image_url: short(raw?.uploaded_image_url, 300),
    matched_product: raw?.searched_product_info ? toCard(raw.searched_product_info) : null,
    detected_objects: detectedObjectsOf(raw),
    products: rows.map(toCard).filter((c): c is ProductCard => c !== null).slice(0, limit),
  };
}

/**
 * Torob's trending searches. The site sends `t=<now>` to defeat Torob's own
 * CDN; here the value is rounded to this server's TTL window, so the data
 * refreshes on the same rhythm as the cache without asking upstream for a
 * fresh copy on every call.
 */
export async function trendingSearches(limit: number): Promise<TrendItem[]> {
  const bucket = Math.floor(Date.now() / TTL.trends);
  const raw = await cached(`tr:${bucket}`, TTL.trends, () =>
    torobGet<unknown>(`/v4/search-trends/?t=${bucket}`)
  );
  return trendsOf(raw, limit);
}

/** The cities Torob's own users pick most, for a sensible default. */
export async function popularCities(): Promise<City[]> {
  const raw = (await cached("citypop", TTL.locations, () =>
    torobGet<unknown>("/v4/city/most-visited/list/")
  )) as unknown[];
  const out: City[] = [];
  for (const row of Array.isArray(raw) ? raw : []) {
    const id = str((row as any)?.id ?? (row as any)?.city_id).trim();
    const name = nameOf(row);
    if (id && name) out.push({ id, name, province_id: null });
  }
  return out;
}

// ------------------------------------------------- price chart and changes

export interface PricePoint {
  /** Torob's own label for that month, e.g. "۲۶ مرداد ۱۴۰۵". */
  date: string;
  value: number;
}

export interface PriceSeries {
  /** Torob's own series name, e.g. "میانگین قیمت" or "کمترین قیمت". */
  label: string;
  color: string | null;
  points: PricePoint[];
  latest: PricePoint | null;
  lowest: PricePoint | null;
  highest: PricePoint | null;
}

export interface PriceChart {
  series: PriceSeries[];
  /** How many monthly points Torob charts in total, before our own window. */
  points_available: number;
  window: { from: string | null; to: string | null; points: number };
}

// A chart point is {val, i}: the index is what ties it to its label, because
// the series is sparse in places. Matching on array position instead of `i`
// would shift every date by however many points are missing.
function pointsOf(entries: unknown, labels: string[]): PricePoint[] {
  const list = Array.isArray(entries) ? entries : [];
  const points: { i: number; point: PricePoint }[] = [];
  for (const entry of list) {
    const i = Math.round(num((entry as any)?.i, NaN));
    const value = num((entry as any)?.val, NaN);
    const label = Number.isFinite(i) ? labels[i] : undefined;
    if (!Number.isFinite(value) || !label) continue;
    points.push({ i, point: { date: label, value: Math.round(value) } });
  }
  points.sort((a, b) => a.i - b.i);
  return points.map((p) => p.point);
}

/** Project Torob's chart, keeping only the last `months` monthly points. */
export function priceChartOf(raw: unknown, months: number): PriceChart {
  const labels = Array.isArray((raw as any)?.labels) ? ((raw as any).labels as unknown[]).map((l) => str(l).trim()) : [];
  const dataSets = Array.isArray((raw as any)?.dataSets) ? ((raw as any).dataSets as any[]) : [];
  const series: PriceSeries[] = [];
  let available = 0;
  for (const set of dataSets) {
    const all = pointsOf(set?.entries, labels);
    available = Math.max(available, all.length);
    const points = all.slice(Math.max(0, all.length - months));
    if (!points.length) continue;
    const byValue = [...points].sort((a, b) => a.value - b.value);
    series.push({
      label: short(set?.label, 60) ?? "series",
      color: short(set?.color, 20),
      points,
      latest: points[points.length - 1] ?? null,
      lowest: byValue[0] ?? null,
      highest: byValue[byValue.length - 1] ?? null,
    });
  }
  const longest = series.reduce<PriceSeries | null>((a, b) => (a && a.points.length >= b.points.length ? a : b), null);
  return {
    series,
    points_available: available,
    window: {
      from: longest?.points[0]?.date ?? null,
      to: longest?.points[longest.points.length - 1]?.date ?? null,
      points: longest?.points.length ?? 0,
    },
  };
}

/** One entry of Torob's own price-change feed for a product. */
export interface PriceChange {
  title: string;
  description: string | null;
  time_ago: string | null;
}

export function priceChangesOf(raw: unknown, limit: number): { count: number; changes: PriceChange[] } {
  const results = Array.isArray((raw as any)?.results) ? ((raw as any).results as any[]) : [];
  const changes: PriceChange[] = [];
  for (const row of results) {
    const title = short(row?.title, 120);
    if (!title) continue;
    changes.push({
      title,
      description: short(row?.description, 200),
      time_ago: short(row?.timeago, 40),
    });
    if (changes.length >= limit) break;
  }
  return { count: Math.max(0, Math.round(num((raw as any)?.count, changes.length))), changes };
}

// ------------------------------------------------------------ shop profiles

export interface ShopProfile {
  shop_id: string;
  name: string | null;
  shop_type: string | null;
  city: string | null;
  province: string | null;
  address: string | null;
  website: string | null;
  logo: string | null;
  is_marketplace: boolean;
  /** Torob's own word for the shop's state, e.g. "فعال". */
  status: string | null;
  active_since: string | null;
  active_time: string | null;
  last_updated: string | null;
  score: number | null;
  score_percentile: number | null;
  /** Torob's own sentences about this shop, including any violation note. */
  score_notes: string[];
  trust_seal: { level: string | null; valid_until: string | null; notes: string[] };
  support: { schedule: string | null; badges: string[] } | null;
  payment: string[];
  delivery: string[];
  about: { title: string; text: string; link: string | null }[];
  guarantee: string | null;
  url: string;
}

function stringsOf(raw: unknown, cap = 5, n = 200): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const text = typeof item === "string" ? short(item, n) : short((item as any)?.title ?? (item as any)?.text, n);
    if (text) out.push(text);
    if (out.length >= cap) break;
  }
  return out;
}

/** A Torob shop page's own data, projected. */
export function shopProfileOf(raw: unknown, shopId: string): ShopProfile {
  const j = (raw ?? {}) as any;
  const domain = str(j.domain).trim();
  const redirect = str(j.website_redirect_url).trim();
  const website = /^https?:\/\//.test(redirect)
    ? redirect
    : /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)
      ? `https://${domain}`
      : null;
  const licenses = Array.isArray(j.licenses) ? (j.licenses as any[]) : [];
  const sealNotes: string[] = [];
  for (const license of licenses) {
    for (const part of [license?.title, license?.description_1, license?.description_2]) {
      const text = short(part, 160);
      if (text) sealNotes.push(text);
    }
  }
  const support = j.customer_support_info ?? null;
  return {
    shop_id: str(j.id, shopId),
    name: short(j.name, 100),
    shop_type: short(j.shop_type, 20),
    city: short(j.city, 60),
    province: short(j.province, 60),
    address: short(j.address, 300),
    website,
    logo: short(j.logo_512 ?? j.shop_logo, 300),
    is_marketplace: j.is_marketplace === true,
    status: short(j.block_description, 60),
    active_since: short(j.date_added, 60),
    active_time: short(j.active_time, 60),
    last_updated: short(j.last_updated, 80),
    score: num(j.shop_score, 0) > 0 ? Math.round(num(j.shop_score, 0) * 10) / 10 : null,
    score_percentile: Number.isFinite(num(j.score_percentile, NaN)) ? Math.round(num(j.score_percentile, 0)) : null,
    score_notes: stringsOf(j.score_info, 5, 200),
    trust_seal: {
      level: short(j.enamad_level, 60),
      valid_until: short(j.enamad_expire_date, 80),
      notes: sealNotes.slice(0, 4),
    },
    support: support
      ? { schedule: short(support.schedule, 120), badges: stringsOf(support.badges, 5, 80) }
      : null,
    payment: stringsOf(j.payment_info?.items, 5, 240),
    delivery: stringsOf(j.delivery_info?.items, 5, 240),
    about: (Array.isArray(j.additional_infos) ? j.additional_infos : [])
      .slice(0, 4)
      .map((info: any) => ({
        title: short(info?.title, 80) ?? "",
        text: short(info?.text, 320) ?? "",
        link: short(info?.link, 300),
      }))
      .filter((info: any) => info.title || info.text),
    guarantee: short(j.guarantee_info?.status, 20),
    url: `https://torob.com/shop/${str(j.id, shopId)}/`,
  };
}

/** A row of Torob's shop directory (its own search over shops). */
export interface ShopSummary {
  id: string;
  name: string;
  city: string | null;
  shop_type: string | null;
  is_marketplace: boolean;
  logo: string | null;
  url: string;
}

export function shopsOf(raw: unknown, limit: number): { count: number; shops: ShopSummary[] } {
  const results = Array.isArray((raw as any)?.results) ? ((raw as any).results as any[]) : [];
  const shops: ShopSummary[] = [];
  for (const row of results) {
    const id = str(row?.id).trim();
    const name = short(row?.name, 120);
    if (!id || !name) continue;
    shops.push({
      id,
      name,
      city: short(row?.city, 60),
      shop_type: short(row?.shop_type, 20),
      is_marketplace: row?.is_marketplace === true,
      logo: short(row?.shop_logo, 300),
      url: `https://torob.com/shop/${id}/`,
    });
    if (shops.length >= limit) break;
  }
  return { count: Math.max(0, Math.round(num((raw as any)?.count, shops.length))), shops };
}

// -------------------------------------------------------------- trends

/** One trending search, with a sample product when Torob sends one. */
export interface TrendItem {
  query: string;
  category_id: string | null;
  sample: ProductCard | null;
}

export function trendsOf(raw: unknown, limit: number): TrendItem[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: TrendItem[] = [];
  for (const row of list) {
    const query = short((row as any)?.query, 100);
    if (!query) continue;
    const sample = (row as any)?.partial_info ? toCard((row as any).partial_info) : null;
    out.push({ query, category_id: str((row as any)?.category_id).trim() || null, sample });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------- categories

export interface CategoryNode {
  id: string;
  title: string;
  slug: string | null;
  image: string | null;
  url: string | null;
  /** How many products Torob has under this category. */
  product_count: number;
  has_children: boolean;
  parent_id: string | null;
}

/**
 * Torob's category tree, one level at a time. There is no "list all
 * categories" endpoint - the tree is walked through this one, which is why a
 * parent id is required. The live payload nests under `categories` and carries
 * a product count, which is what makes the walk worth doing.
 */
export async function categoryChildren(
  id: string,
  limit: number
): Promise<{ parent: string; categories: CategoryNode[]; has_more: boolean }> {
  const parent = str(id).trim();
  if (!parent) throw new UpstreamError("browse_categories needs a category id. Use id '1' for the top level.", "usage");
  const raw = (await cached(`cat:${parent}:${limit}`, TTL.category, () =>
    torobGet<any>(`/v4/category/price-list-nested/?id=${encodeURIComponent(parent)}&page=0&size=${Math.min(30, Math.max(1, limit))}`)
  )) as { categories?: unknown; categories_count?: unknown };
  const list = Array.isArray(raw?.categories) ? raw.categories : [];
  const categories: CategoryNode[] = [];
  for (const c of list) {
    const cid = str(c?.id ?? c?.cat_id).trim();
    const title = short(c?.title ?? c?.name, 80);
    if (!cid || !title) continue;
    const count = num(c?.count, 0);
    categories.push({
      id: cid,
      title,
      slug: short(c?.slug, 120),
      image: short(c?.image, 300),
      url: str(c?.absolute_url).startsWith("/") ? `https://torob.com${str(c.absolute_url)}` : short(c?.absolute_url, 300),
      product_count: Math.max(0, Math.round(count)),
      has_children: count > 0,
      parent_id: parent,
    });
  }
  return { parent, categories, has_more: categories.length >= limit };
}

// ----------------------------------------------------------------- locations

export interface Province {
  id: string;
  name: string;
}

export interface City {
  id: string;
  name: string;
  province_id: string | null;
}

// Both location endpoints answer {count, next, previous, results:[{id, name}]}
// - verified live. The first attempt guessed `title` and silently returned an
// empty list, which is exactly the failure this projection exists to prevent:
// an endpoint that answers 200 with the wrong field name looks like "no such
// place", not like a bug.
function nameOf(row: any): string | null {
  return short(row?.name ?? row?.title, 80);
}

export async function provinces(): Promise<Province[]> {
  const raw = (await cached("prov", TTL.locations, () =>
    torobGet<any>("/v4/province/list/?size=200")
  )) as { results?: unknown };
  const out: Province[] = [];
  for (const p of Array.isArray(raw?.results) ? raw.results : []) {
    const id = str(p?.id ?? p?.province_id).trim();
    const name = nameOf(p);
    if (id && name) out.push({ id, name });
  }
  return out;
}

export async function cities(provinceId?: string, search?: string): Promise<City[]> {
  const params = new URLSearchParams({ size: "200" });
  if (provinceId) params.set("province", provinceId);
  if (search) params.set("search", search);
  const key = `city:${provinceId ?? ""}:${search ?? ""}`;
  const raw = (await cached(key, TTL.locations, () =>
    torobGet<any>(`/v4/city/list/?${params.toString()}`)
  )) as { results?: unknown };
  const out: City[] = [];
  for (const c of Array.isArray(raw?.results) ? raw.results : []) {
    const id = str(c?.id ?? c?.city_id).trim();
    const name = nameOf(c);
    if (!id || !name) continue;
    out.push({ id, name, province_id: str(c?.province_id ?? c?.province) || null });
  }
  return out;
}

// -------------------------------------------------------------------- offers

export interface SpecialOffer {
  /** The banner/deal group this item belongs to. */
  group: string | null;
  title: string | null;
  description: string | null;
  image: string | null;
  url: string | null;
}

/**
 * Torob's featured-deals page. This is merchandising, not shop data: the live
 * payload is grouped banners under `results[].data[]`, each with a link and an
 * image, and some point off-site (TorobPay). Kept clearly separate from the
 * seller-offers list on a product, and the destination is reported as-is so a
 * caller can see when it leaves torob.com.
 */
export async function specialOffers(limit: number): Promise<SpecialOffer[]> {
  const raw = (await cached("so", TTL.offers, () => torobGet<any>("/v4/special-offers/?page=0"))) as {
    name?: unknown;
    results?: { type?: unknown; data?: unknown }[];
  };
  const groupName = short(raw?.name, 120);
  const out: SpecialOffer[] = [];
  for (const group of Array.isArray(raw?.results) ? raw.results : []) {
    for (const o of Array.isArray(group?.data) ? group.data : []) {
      const url = str(o?.more_info_url ?? o?.api_url).trim();
      out.push({
        group: groupName ?? (num(group?.type, 0) ? `group ${Math.round(num(group.type, 0))}` : null),
        title: short(o?.title ?? o?.name1 ?? o?.text, 120),
        description: short(o?.description ?? o?.subtitle, 240),
        image: short(o?.desktop_image_url ?? o?.image_url, 300),
        url: url || null,
      });
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

// Types Torob sends that name a business listing rather than a wording for a
// product search (measured live: "phone" suggested phoneino.com and
// phonex1.ir with suggestion_type business_profile_query). They are dropped:
// a shop domain is not a query an agent should search Torob with.
const NON_PRODUCT_SUGGESTION_TYPES = new Set(["business_profile_query"]);

export async function suggestTerms(q: string): Promise<{ query: string; suggestions: string[]; dropped: number }> {
  const raw = await cached(`sg:${foldKey(q)}`, TTL.suggest, () =>
    torobGet<unknown>(`/suggestion2/?q=${encodeURIComponent(q)}&source=next_desktop`)
  );
  const out: string[] = [];
  let dropped = 0;
  if (Array.isArray(raw)) {
    for (const s of raw) {
      const text = short((s as any)?.text, 80);
      if (!text) continue;
      if (NON_PRODUCT_SUGGESTION_TYPES.has(str((s as any)?.suggestion_type))) {
        dropped += 1;
        continue;
      }
      out.push(text);
    }
  }
  return { query: q, suggestions: [...new Set(out)].slice(0, 10), dropped };
}
