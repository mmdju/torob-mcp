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

import { ATTRIBUTION, MIN_SHOP_VOTES, SORT_PARAMS, TOROB_API, TTL, type Sort } from "./config.js";
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
const OPTION_PREVIEW = 10;
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

  return {
    ...base,
    offers,
    offer_count: offers.length,
    price_spread_toman: prices.length > 1 ? Math.max(...prices) - Math.min(...prices) : null,
    cheapest_offer: offers.find((o) => o.available && o.price_toman !== null) ?? null,
    best_rated_offer: bestRated,
    cheapest_delivered_offer: delivered,
    resolved_by: resolved.resolvedBy,
    attribution: ATTRIBUTION,
  };
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
  const wanted = prkInput.trim();
  if (!wanted) throw new UpstreamError("Empty product id.", "usage");
  const prk = idFrom(wanted);
  // similar-base-product takes a bare prk, but only for a product this server
  // has actually seen: the endpoint answers nothing for an id it cannot
  // resolve. So the id is confirmed first - by memory, by the details_url the
  // caller echoed back, or by re-finding the product through a name search on a
  // cold isolate.
  const provided = detailsUrlOf(opts?.detailsUrl);
  if (provided) rememberDetailUrl({ random_key: prk, more_info_url: provided } as RawProduct);
  let confirmed = detailUrls.has(prk);
  if (!confirmed) {
    const known = await rememberedInfo(prk);
    confirmed = known.url !== null;
    if (!confirmed) {
      const found = await rowForId(prk, known.name, opts?.lookupBudget, str(opts?.query));
      confirmed = found !== null;
    }
  }
  if (!confirmed) {
    throw new UpstreamError(
      `No record of product '${wanted}' on this server, and Torob cannot look up a product by id alone. ` +
        `Call search_products for what the user asked for first, then call similar_products with the prk and ` +
        `the details_url from that result.`,
      "usage"
    );
  }
  const raw = await cached(`sim:${prk}`, TTL.similar, () =>
    torobGet<RawSearch>(
      `/v4/base-product/similar-base-product/?prk=${encodeURIComponent(prk)}&limit=24&source=torob_search`
    )
  );
  const rows = Array.isArray(raw.results) ? (raw.results as RawProduct[]) : [];
  for (const row of rows) rememberDetailUrl(row);
  return rows.map(toCard).filter((c): c is ProductCard => c !== null).slice(0, limit);
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
