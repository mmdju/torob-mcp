// torob-mcp tools. Fourteen read-only tools.
//
// The split that matters: a search card shows the CHEAPEST offer only, because
// that is the one number a shopper asks for. Every seller behind that number
// lives behind product_details. An agent that answers "where is this cheapest"
// from a search card would be naming a shop it never checked the reliability
// of, so the two are deliberately separate calls.
//
// The price tools follow the same rule one level up: price_history reports what
// a product has cost over years, product_details reports what it costs now and
// where, and shop_profile answers whether the shop behind one of those offers
// can be trusted at all.

import { ATTRIBUTION, SHOP_PAGE_MAX, SHOP_TYPES, SORTS, SORT_LABELS, type ShopType, type Sort } from "./config.js";
import { UpstreamError } from "./http.js";
import { clampLimit, clampPage, foldKey, formatToman, num, pageClampNote, str } from "./normalize.js";
import {
  OPTION_PREVIEW,
  type FilterGroup,
  type LookupBudget,
  type PriceChart,
  type ProductCard,
  type SearchResult,
  canonicalSlug,
  categoryChildren,
  cities,
  filterKeyMap,
  filterMemoryKey,
  findShops,
  popularCities,
  productDetails,
  productLastModified,
  productPriceChanges,
  productPriceChart,
  provinces,
  rememberedFilterGroups,
  searchByImage,
  searchProducts,
  shopProfile,
  shopProducts,
  similarProducts,
  specialOffers,
  suggestTerms,
  trendingSearches,
} from "./project.js";

// openWorldHint: false is declared (not left to the MCP default of true):
// results depend on Torob's live state, and the checklist for tools touching
// the outside world wants that explicit.
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export interface ToolDef {
  name: string;
  // Human-readable title per the MCP spec (distinct from the wire `name`).
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

const QUERY = { type: "string", description: "What the user asked for, in their own words. Persian or English." } as const;

function usageError(message: string): UpstreamError {
  return new UpstreamError(message, "usage");
}

// Torob's count is not stable: the same request repeated seconds apart came
// back 1125 then 1200 (and page 1: 1155 then 1200). The number travels, with
// this beside it, so an agent pages by has_next_page instead of quoting it.
const TOTAL_NOTE =
  "Torob's own count is approximate - it changes between identical requests - so page with has_next_page " +
  "rather than trusting the number.";

// A filter value must be one the search itself advertises; Torob ignores a
// value it does not know and answers unfiltered, and an unfiltered list read as
// a filtered one is a wrong price answer. "canonicalize" is used when the
// value is validated before the call (a display name can be mapped onto its
// value); "exact" is used against a fresh response, where only a value that
// was certainly sent in canonical form is accepted.
function validateFilters(
  wanted: Record<string, string>,
  groups: FilterGroup[],
  mode: "exact" | "canonicalize"
): Record<string, string> {
  const keys = filterKeyMap(groups);
  const accepted = [...new Set(groups.map((g) => g.slug))].filter((s) => s !== "q");
  const out: Record<string, string> = {};
  for (const [slug, value] of Object.entries(wanted)) {
    if (slug === "q") throw usageError("'q' is not a filter - pass the words as the query argument instead.");
    if (slug === "sort") {
      throw usageError(`'sort' is not passed through filters - use the sort argument instead (${SORTS.join(", ")}).`);
    }
    const group = keys.get(slug);
    if (!group) {
      throw usageError(
        `'${slug}' is not a filter this search accepts. This search accepts: ${accepted.join(", ")}. ` +
          `Run search_products first and read available_filters - Torob offers a different filter surface per query.`
      );
    }
    if (!value) throw usageError(`The filter '${slug}' needs a value.`);
    // A price bound is a number; text there would be ignored upstream.
    if (group.type === "price") {
      if (!/^\d+$/.test(value)) throw usageError(`'${slug}' takes a whole number of Toman; '${value}' is not one.`);
      out[slug] = mode === "canonicalize" ? String(Math.round(Number(value))) : value;
      continue;
    }
    // A toggle is enabled with "1"; "true" is not a value Torob reads.
    if (group.type === "toggle") {
      const t = value.toLowerCase();
      if (t === "1" || t === "0") {
        out[slug] = t;
        continue;
      }
      if (mode === "canonicalize" && ["true", "on", "yes"].includes(t)) {
        out[slug] = "1";
        continue;
      }
      throw usageError(`The filter '${slug}' is a toggle - pass "1" to enable it (or "0" to leave it off).`);
    }
    if (group.options && !group.options_truncated) {
      const byValue = group.options.find((o) => o.value === value);
      if (byValue) {
        out[slug] = byValue.value;
        continue;
      }
      const byName = mode === "canonicalize" ? group.options.find((o) => foldKey(o.name) === foldKey(value)) : undefined;
      if (byName) {
        out[slug] = byName.value;
        continue;
      }
      const shown = group.options
        .slice(0, 12)
        .map((o) => (o.name && o.name !== o.value ? `'${o.value}' (${o.name})` : `'${o.value}'`))
        .join(", ");
      throw usageError(
        `'${value}' is not a value '${slug}' accepts. Accepted values: ${shown}${group.options.length > 12 ? ", ..." : ""}.`
      );
    }
    // A truncated list (a brand preview) cannot be checked in full; pass it on.
    out[slug] = value;
  }
  return out;
}

// An empty result is never silently reported as "no such product": the query
// may simply be worded the way nobody else words it. Torob's own autocomplete
// is the cheapest way to find the wording that does match.
async function withSuggestions(query: string, found: ProductCard[]): Promise<Record<string, unknown>> {
  if (found.length) return {};
  let suggestions: string[] = [];
  try {
    suggestions = (await suggestTerms(query)).suggestions;
  } catch {
    // A failed suggestion lookup must not turn a plain empty result into an
    // error - the answer is still "nothing found", just without a hint.
  }
  if (!suggestions.length) return {};
  return {
    query_note:
      `Nothing matched '${query}' on Torob. These are the wordings Torob's own search suggests - ` +
      `retry with one of them. An empty result is not proof the product does not exist.`,
    suggested_queries: suggestions,
  };
}

// A brand reaches upstream as an id or not at all: Torob ignores a slug or a
// display name and answers unfiltered, and an unfiltered list read as a
// filtered one is a wrong price answer - the same trap `validateFilters` guards
// for every other filter. The brand group is always a preview (its full list
// lives at `values_url`), so an id that is not in the preview cannot be called
// wrong: it may be a real brand from that full list. A *word*, though, maps to
// nothing here, and passing it on would silently drop the narrowing.
// Returns the value to send; throws when the wording cannot be a value.
function settleBrand(brand: string, found: SearchResult): string {
  const group = found.available_filters.find((g) => g.type === "brand");
  if (!group) {
    // No brand group means this search has no brand dimension to narrow. An id
    // is still the value upstream reads (the group is what *advertises* the
    // dimension, not what makes the parameter work), so it passes; a word has
    // nothing here to be mapped through, and sending it would return every
    // brand's product as if the brand had been applied.
    if (/^\d+$/.test(brand)) return brand;
    throw usageError(
      `This search offers no brand filter, so '${brand}' cannot narrow it. Drop the brand argument, or search ` +
        `wording that has one.`
    );
  }
  const seen = [...found.brand_values, ...(group.options ?? [])];
  const byValue = seen.find((o) => o.value === brand);
  if (byValue) return byValue.value;
  const slug = canonicalSlug(brand);
  const byWording = seen.find((o) => o.slug === slug || foldKey(o.name) === foldKey(brand));
  if (byWording) return byWording.value;
  if (/^\d+$/.test(brand)) return brand;
  const shown = seen
    .slice(0, 12)
    .map((o) => (o.name && o.name !== o.value ? `${o.value} (${o.name})` : o.value))
    .join(", ");
  throw usageError(
    `'${brand}' is not a brand this search offers. The brands it shows are: ${shown}` +
      `${seen.length > 12 ? ", ..." : ""}. Pass one of those values, or a brand id from the group's ` +
      `values_url (brand_values lists what fits in this answer).`
  );
}

function sortOf(v: unknown): Sort {
  const s = str(v).trim() as Sort;
  return (SORTS as readonly string[]).includes(s) ? s : "popularity";
}

function shopTypeOf(v: unknown): ShopType | undefined {
  const s = str(v).trim() as ShopType;
  return (SHOP_TYPES as readonly string[]).includes(s) ? s : undefined;
}

// ---------------------------------------------------------------- search

const searchTool: ToolDef = {
  name: "search_products",
  title: "Search Torob products",
  description:
    "Search Torob and get compact product cards: the CHEAPEST offer in Toman, the shop behind it, " +
    "image, badges and the product URL. Call torob_suggest first when the wording is vague. " +
    "A card shows one price - the cheapest offer - not every seller; use product_details for those. " +
    "price_toman 0 or available false means out of stock, not free. " +
    "Every search returns available_filters: the filter groups this search really accepts, each with its " +
    "slug and the values it takes - pass those values back in `filters` (or use min_price_toman / " +
    "max_price_toman for a price window). A slug or value this search does not advertise is refused " +
    "instead of being sent on to be ignored.",
  inputSchema: {
    type: "object",
    properties: {
      query: QUERY,
      page: { type: "number", description: "1-based page, max 50. Deep pages cost an extra upstream request." },
      sort: {
        type: "string",
        enum: [...SORTS],
        description:
          "popularity (default) = most relevant, price = cheapest first, expensive = dearest first, " +
          "newest = newest first, sellers = most sellers.",
      },
      category: { type: "string", description: "Torob category id, e.g. from suggested_categories or browse_categories." },
      brand: {
        type: "string",
        description:
          "Brand id from the brand group of available_filters (options[].value) or brand_values[].value, " +
          "e.g. '17418' for MikroTik. Torob filters on the id and ignores a slug or display name; one this " +
          "query's earlier search showed is mapped onto its id.",
      },
      city: { type: "string", description: "Filter by delivery city id, e.g. from list_locations." },
      shop_type: { type: "string", enum: [...SHOP_TYPES], description: "offline = shops with a branch, online = online sellers." },
      min_price_toman: { type: "number", description: "Only show products at or above this price." },
      max_price_toman: { type: "number", description: "Only show products at or below this price." },
      filters: {
        type: "object",
        description:
          "Values from available_filters of an earlier search of the same query. Example: " +
          '{"available": "1", "storage": "1 tb"}. A slug or value this search does not advertise is ' +
          "refused with the real ones rather than silently ignored.",
        additionalProperties: { type: "string" },
      },
      limit: { type: "number", description: "How many cards to return (default 10, max 24 - one page carries that many)." },
    },
    required: ["query"],
  },
  async run(args) {
    const query = str(args.query).trim();
    if (!query) throw usageError("search_products needs a query - the words the user is looking for.");
    const page = clampPage(args.page);
    const sort = sortOf(args.sort);
    const shopType = shopTypeOf(args.shop_type);
    // Upstream hands back 24-26 cards whatever `size` is asked for, so 30 was a
    // promise the page could not keep: a caller asking for 30 got 24 with no
    // sign anything was short.
    const limit = clampLimit(args.limit, 10, 24);
    const category = str(args.category).trim() || undefined;
    const city = str(args.city).trim() || undefined;

    // The two price bounds are the same upstream filter the user cares about
    // most, so they get first-class parameters that compile to Torob's slugs.
    const applied: Record<string, string> = {};
    const minPrice = num(args.min_price_toman, 0);
    const maxPrice = num(args.max_price_toman, 0);
    if (minPrice > 0) applied.price__gt = String(Math.round(minPrice));
    if (maxPrice > 0) applied.price__lt = String(Math.round(maxPrice));
    if (minPrice > 0 && maxPrice > 0 && minPrice > maxPrice) {
      throw usageError(
        `min_price_toman (${Math.round(minPrice)}) is above max_price_toman (${Math.round(maxPrice)}), so nothing can match.`
      );
    }
    const extra = args.filters;
    const wanted: Record<string, string> = {};
    if (extra && typeof extra === "object" && !Array.isArray(extra)) {
      for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
        const slug = str(k).trim();
        if (slug) wanted[slug] = str(v).trim();
      }
    }
    // `brand` compiles to its own upstream parameter, so a brand handed over in
    // `filters` joins that path instead of being echoed back as a filter this
    // search applied - which, until it has been settled below, it may not be.
    const brandFromFilters = wanted.brand;
    if (brandFromFilters !== undefined) delete wanted.brand;

    const rememberedKey = filterMemoryKey(query, { category, city, shopType });
    // The loop this server promises: read available_filters, pass a value back.
    // When this exact query's filters were seen before, the check happens
    // before any upstream call. Either way the fresh response is checked in
    // full, because it is the only authority: a value a stale memory blessed
    // but this search does not advertise would be ignored upstream.
    let checked: Record<string, string> | null = null;
    if (Object.keys(wanted).length) {
      const remembered = await rememberedFilterGroups(rememberedKey);
      if (remembered) checked = validateFilters(wanted, remembered, "canonicalize");
    }
    Object.assign(applied, checked ?? wanted);

    // A brand filter wants the brand's id, not its slug or the name people say
    // (measured: brand=17418 narrowed routers to MikroTik, brand=mikrotik-میکروتیک
    // changed nothing). Map a name or slug through the brand group when this
    // query showed one; whatever is still not an id is settled against the
    // fresh response below, where the brands this search really offers are known.
    let brand = str(args.brand).trim() || brandFromFilters;
    if (brand) {
      const groups = await rememberedFilterGroups(rememberedKey);
      const brandGroup = groups?.find((g) => g.type === "brand");
      const slug = canonicalSlug(brand);
      const matched = brandGroup?.options?.find(
        (o) => o.value === brand || o.slug === slug || foldKey(o.name) === foldKey(brand)
      );
      if (matched) brand = matched.value;
    }

    const runSearch = (brandId: string | undefined) =>
      searchProducts({
        q: query,
        page,
        sort,
        category,
        brand: brandId,
        city,
        shopType,
        filters: Object.keys(applied).length ? applied : undefined,
      });

    const sentFilters = { ...applied };
    let found = await runSearch(brand);
    let rerun = false;

    if (Object.keys(wanted).length) {
      // The response that actually ran decides whether every value was real,
      // and maps a wording onto the value upstream reads. When that differs
      // from what this search was sent, the results above were fetched with a
      // filter Torob ignored - an unfiltered list wearing a filtered answer -
      // so they are searched again with the corrected values instead.
      const fresh = validateFilters(checked ?? wanted, found.available_filters, "canonicalize");
      for (const [slug, value] of Object.entries(fresh)) if (sentFilters[slug] !== value) rerun = true;
      Object.assign(applied, fresh);
    }

    if (brand) {
      const settled = settleBrand(brand, found);
      if (settled !== brand) {
        brand = settled;
        rerun = true;
      }
    }

    if (rerun) {
      found = await runSearch(brand);
      // The corrected run has to accept the same values: a brand narrows the
      // search, and the groups can differ once it does. No third run - a value
      // this response does not advertise is refused rather than re-searched,
      // and these are already the canonical forms it advertised before.
      if (Object.keys(wanted).length) {
        const sent = Object.fromEntries(Object.keys(wanted).map((slug) => [slug, applied[slug]]));
        Object.assign(applied, validateFilters(sent, found.available_filters, "exact"));
      }
    }

    return {
      query,
      sort,
      sort_meaning: SORT_LABELS[sort],
      filters_applied: Object.keys(applied).length ? applied : undefined,
      total_matches: found.total,
      total_matches_note: TOTAL_NOTE,
      page: found.page,
      page_count: found.page_count,
      has_next_page: found.has_next_page,
      price_range_toman: { min: found.min_price_toman, max: found.max_price_toman },
      ...(found.price_bounds_toman ? { price_bounds_toman: found.price_bounds_toman } : {}),
      products: found.products.slice(0, limit),
      available_filters: found.available_filters,
      // The brand group above is a preview; when the search offers more brands
      // than it shows, the full list (with the ids `brand` needs) travels here.
      ...(found.brand_values.length > OPTION_PREVIEW || found.brand_values_truncated
        ? {
            brand_values: found.brand_values,
            brand_values_note:
              "The brand group in available_filters is a preview; pass a brand's value (its id) as `brand`. " +
              (found.brand_values_truncated ? "There are more than shown - the group's values_url lists the rest." : ""),
          }
        : {}),
      ...(found.products.length > limit
        ? { truncated: true, returned: limit, note: `${found.products.length} cards were on this page; showing ${limit}.` }
        : {}),
      ...(pageClampNote(args.page)),
      ...(found.spellcheck && found.spellcheck.corrected
        ? { query_corrected: found.spellcheck.corrected, query_note: `Torob read '${found.spellcheck.original}' as '${found.spellcheck.corrected}'.` }
        : {}),
      ...(found.suggested_categories.length
        ? { suggested_categories: found.suggested_categories, category_note: "Pass one of these ids as `category` to narrow the search." }
        : {}),
      ...(await withSuggestions(query, found.products)),
      attribution: found.attribution,
    };
  },
};

// ---------------------------------------------------------------- details

const detailsTool: ToolDef = {
  name: "product_details",
  title: "Product details with every seller offer",
  description:
    "One Torob product plus EVERY seller offer, sorted cheapest first, with each shop's score, vote count, " +
    "stated postage, guarantee, instalment providers, delivery and discount info. This is the call that " +
    "answers 'who sells this cheapest' and 'is that shop any good'. Pass the prk from a search_products " +
    "result plus that card's details_url, or a full torob.com product URL. " +
    "An offer with available false is out of stock; price_unreliable is Torob's own warning about that price. " +
    "cheapest_delivered_offer adds stated postage to the price; resolved_by says how the id was found.",
  inputSchema: {
    type: "object",
    properties: {
      prk: { type: "string", description: "Product id from a search_products card (or a torob.com /p/<id>/ URL)." },
      details_url: {
        type: "string",
        description:
          "The details_url from the same card. Pass it back with the prk and the product opens with no lookup: Torob's id alone is not an address.",
      },
      max_offers: { type: "number", description: "How many seller offers to return (default 10, max 30)." },
      max_in_person: {
        type: "number",
        description:
          "How many in-person shops to return (default 10, max 30). Torob carries them in the same response, so this costs nothing upstream.",
      },
    },
    required: ["prk"],
  },
  async run(args) {
    const prk = str(args.prk).trim();
    if (!prk) throw usageError("product_details needs a prk - the product id from a search_products card.");
    const maxOffers = clampLimit(args.max_offers, 10, 30);
    const maxInPerson = clampLimit(args.max_in_person, 10, 30);
    const found = await productDetails(prk, { detailsUrl: args.details_url });
    const cheapest = found.cheapest_offer;
    const best = found.best_rated_offer;

    const delivered = found.cheapest_delivered_offer;
    return {
      prk: found.prk,
      name_fa: found.name_fa,
      name_en: found.name_en,
      cheapest_price_toman: found.price_toman,
      available: found.available,
      image: found.image,
      badges: found.badges,
      url: found.url,
      resolved_by: found.resolved_by,
      offer_count: found.offer_count,
      // The number that makes this more than a search: how much the same
      // product costs depending on who you buy it from.
      price_spread_toman: found.price_spread_toman,
      cheapest_offer: cheapest,
      best_rated_offer: best,
      cheapest_delivered_offer: delivered,
      ...(best && cheapest && best.shop_name !== cheapest.shop_name
        ? {
            cheapest_vs_best_rated: `Cheapest is ${cheapest.shop_name} at ${cheapest.price_text}; the best rated available shop is ${best.shop_name} (score ${best.shop_score}, ${best.shop_votes} votes) at ${best.price_text}.`,
          }
        : {}),
      ...(delivered && cheapest && delivered.shop_name !== cheapest.shop_name
        ? {
            cheapest_vs_delivered:
              `Cheapest item price is ${cheapest.shop_name} at ${cheapest.price_text}; with stated postage added, ` +
              `${delivered.shop_name} at ${delivered.delivered_price_toman} Toman delivered is the lowest.`,
          }
        : {}),
      offers: found.offers.slice(0, maxOffers),
      ...(found.offers.length > maxOffers
        ? { offers_truncated: true, offers_returned: maxOffers, note: `${found.offer_count} offers exist; showing the ${maxOffers} cheapest.` }
        : {}),
      // The in-person shops ride along in the same payload, so this section
      // costs nothing upstream - but its prices are the shops' own and can be
      // months old, which is why every row carries its own last-change date.
      in_person_count: found.in_person_count,
      in_person_sellers: found.in_person_sellers.slice(0, maxInPerson),
      ...(found.in_person_count
        ? {
            in_person_note:
              "These are shops selling this product in person. Each price is the shop's own and can be old - " +
              "each row carries last_price_change_date so the age travels with the number.",
          }
        : {}),
      ...(found.in_person_sellers.length > maxInPerson
        ? {
            in_person_truncated: true,
            in_person_returned: maxInPerson,
            in_person_truncated_note: `${found.in_person_count} in-person shops exist; showing the ${maxInPerson} cheapest.`,
          }
        : {}),
      ...(found.in_person_map_url ? { in_person_map_url: found.in_person_map_url } : {}),
      ...(found.price_range_toman ? { price_range_toman: found.price_range_toman } : {}),
      ...(found.purchase_options ? { purchase_options: found.purchase_options } : {}),
      ...(found.specs
        ? {
            specs: found.specs,
            ...(found.specs_truncated ? { specs_truncated: true, specs_available: found.specs_available } : {}),
          }
        : {}),
      ...(found.variants ? { variants: found.variants } : {}),
      ...(found.category_path ? { category_path: found.category_path } : {}),
      ...(found.is_authentic ? { is_authentic: true } : {}),
      ...(found.has_wiki ? { has_wiki: true } : {}),
      attribution: found.attribution,
    };
  },
};

// ---------------------------------------------------------------- compare

interface CompareInput {
  prk: string;
  details_url?: string;
}

interface CompareRow {
  prk: string;
  name_fa?: string | null;
  name_en?: string | null;
  available?: boolean;
  cheapest_price_toman?: number | null;
  seller_count?: number;
  price_spread_toman?: number | null;
  cheapest_shop?: string | null;
  cheapest_shop_score?: number | null;
  best_rated_shop?: string | null;
  best_rated_score?: number | null;
  url?: string;
  error: string | null;
}

// Each item is a product id, or an object carrying it together with the
// details_url from the same card (which opens the product with no lookup).
function compareItems(v: unknown): CompareInput[] {
  if (!Array.isArray(v)) return [];
  const out: CompareInput[] = [];
  for (const item of v) {
    if (typeof item === "string") {
      const prk = item.trim();
      if (prk) out.push({ prk });
      continue;
    }
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const prk = str(record.prk).trim();
      if (!prk) continue;
      const details_url = str(record.details_url).trim() || undefined;
      out.push({ prk, details_url });
    }
  }
  return out;
}

const compareTool: ToolDef = {
  name: "compare_products",
  title: "Compare products across shops",
  description:
    "Open 2-5 Torob products by prk and put their seller offers side by side: cheapest price, number of " +
    "sellers, the price spread between shops, and the best rated seller. Each product can carry the " +
    "details_url from its card so it opens with no lookup. Use it when the user is choosing between " +
    "specific products rather than searching for one. Resolving ids costs upstream requests, so a " +
    "comparison shares one lookup budget - anything it cannot open comes back with an error in its own row.",
  inputSchema: {
    type: "object",
    properties: {
      prks: {
        type: "array",
        items: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                prk: { type: "string" },
                details_url: { type: "string", description: "The details_url from the same card." },
              },
              required: ["prk"],
            },
          ],
        },
        description:
          "2-5 products, each a product id or an object {prk, details_url}. Passing the details_url from the " +
          "same search card opens a product with no lookup at all.",
      },
    },
    required: ["prks"],
  },
  async run(args) {
    const items = compareItems(args.prks);
    if (items.length < 2) throw usageError("compare_products needs at least 2 prks to compare.");
    if (items.length > 5) throw usageError(`compare_products compares up to 5 products at once; ${items.length} were given.`);

    // One shared budget for the whole comparison: each extra upstream lookup
    // spends from it, so a cold 5-way compare cannot become a dozen paced calls
    // and a client timeout. Items it cannot open say so in their own row.
    const budget: LookupBudget = { left: 6 };
    const results: CompareRow[] = [];
    for (const item of items) {
      try {
        const found = await productDetails(item.prk, { detailsUrl: item.details_url, lookupBudget: budget });
        const cheapest = found.cheapest_offer;
        results.push({
          prk: found.prk,
          name_fa: found.name_fa,
          name_en: found.name_en,
          available: found.available,
          cheapest_price_toman: found.price_toman,
          seller_count: found.offer_count,
          price_spread_toman: found.price_spread_toman,
          cheapest_shop: cheapest?.shop_name ?? null,
          cheapest_shop_score: cheapest?.shop_score ?? null,
          best_rated_shop: found.best_rated_offer?.shop_name ?? null,
          best_rated_score: found.best_rated_offer?.shop_score ?? null,
          url: found.url,
          error: null,
        });
      } catch (err) {
        // One dead product must not hide the others: the failure travels
        // with that row, so a 3-way comparison still answers for the 2 that
        // resolved.
        results.push({
          prk: item.prk,
          error: err instanceof UpstreamError ? err.message : "Could not read this product.",
        });
      }
    }

    const ok = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    const withPrice = ok
      .map((r) => ({ name: r.name_fa ?? r.prk, price: r.cheapest_price_toman }))
      .filter((x): x is { name: string; price: number } => x.price !== null && x.price !== undefined);

    return {
      compared: ok.length,
      requested: items.length,
      products: results,
      ...(withPrice.length > 1
        ? {
            cheapest_overall: withPrice.reduce((a, b) => (a.price <= b.price ? a : b)),
            price_difference_toman: Math.max(...withPrice.map((x) => x.price)) - Math.min(...withPrice.map((x) => x.price)),
          }
        : {}),
      ...(failed.length
        ? { partial_failure: true, failed_note: `${failed.length} of ${items.length} products could not be read; see each row's error.` }
        : {}),
    };
  },
};

// ---------------------------------------------------------------- best value

const bestValueTool: ToolDef = {
  name: "find_best_value",
  title: "Best value under a budget",
  description:
    "Search Torob for the user's item and rank what is actually buyable under a budget in Toman. " +
    "Out-of-stock rows are excluded, and the result says so if nothing fits. " +
    "A price that is not a real ask is reported as such rather than treated as a bargain. " +
    "With include_delivery it also reads stated postage for the top picks and reports the delivered price.",
  inputSchema: {
    type: "object",
    properties: {
      query: QUERY,
      budget_toman: { type: "number", description: "Maximum price in Toman. Leave unset to just rank by price." },
      sort: { type: "string", enum: [...SORTS], description: "popularity (default) or price (cheapest first); the other sorts work too." },
      include_delivery: {
        type: "boolean",
        description:
          "Also read stated postage for the cheapest picks (up to 3) and report the delivered price. " +
          "Costs extra upstream requests; off by default.",
      },
      limit: { type: "number", description: "How many ranked picks to return (default 5, max 15)." },
    },
    required: ["query"],
  },
  async run(args) {
    const query = str(args.query).trim();
    if (!query) throw usageError("find_best_value needs a query - the item the user wants.");
    const budget = num(args.budget_toman, 0) > 0 ? Math.round(num(args.budget_toman, 0)) : null;
    const limit = clampLimit(args.limit, 5, 15);
    const sort = sortOf(args.sort);
    const includeDelivery = args.include_delivery === true;

    const found = await searchProducts({ q: query, page: 1, sort });

    const buyable = found.products.filter((p) => p.available && p.price_toman !== null);
    const inBudget = budget === null ? buyable : buyable.filter((p) => (p.price_toman as number) <= budget);
    // Rank by price when the user named a budget, and keep relevance order
    // otherwise - "best" without a budget is usually "most relevant that is in
    // stock", not "the cheapest thing with an unclear name".
    const ranked = budget !== null ? [...inBudget].sort((a, b) => (a.price_toman as number) - (b.price_toman as number)) : inBudget;
    // "The cheapest in stock" has to mean the cheapest one. `buyable` keeps
    // relevance order, so its first entry is the most relevant, not the dearest
    // or the cheapest - only sorting says which is which.
    const cheapestInStock = buyable.length
      ? [...buyable].sort((a, b) => (a.price_toman as number) - (b.price_toman as number))[0]
      : null;

    const output: Record<string, unknown> = {
      query,
      budget_toman: budget,
      total_matches: found.total,
      total_matches_note: TOTAL_NOTE,
      // "Nothing under budget" and "nothing at all" are different answers.
      out_of_stock_excluded: found.products.length - buyable.length,
      matches_in_budget: inBudget.length,
      best_value: ranked[0] ?? null,
      picks: ranked.slice(0, limit),
      ...(ranked.length === 0
        ? {
            budget_note:
              budget === null
                ? "Nothing in these results is in stock right now."
                : `Nothing in stock was found under ${budget.toLocaleString("en-US")} Toman. The cheapest in stock was ` +
                  `${cheapestInStock ? cheapestInStock.price_text : "none available"}. Widen the search or raise the budget.`,
            // Nothing was picked, but the search itself may have matched: only
            // an empty result set earns the "Nothing matched" wording, or the
            // answer would contradict its own budget_note in one response.
            ...(await withSuggestions(query, found.products)),
          }
        : {}),
      attribution: found.attribution,
    };

    if (includeDelivery && ranked.length) {
      // Postage lives on the seller list, not on a search card, so the cheapest
      // picks are read one by one - capped, and the answer says the cap.
      const enriched: Record<string, unknown>[] = [];
      for (const pick of ranked.slice(0, 3)) {
        try {
          const details = await productDetails(pick.prk, { detailsUrl: pick.details_url ?? undefined });
          enriched.push({
            prk: pick.prk,
            name_fa: details.name_fa,
            cheapest_price_toman: details.price_toman,
            cheapest_delivered_offer: details.cheapest_delivered_offer,
          });
        } catch {
          enriched.push({ prk: pick.prk, delivery_error: "The seller offers for this one could not be read." });
        }
      }
      output.delivered = enriched;
      output.delivery_note = `Postage was read for the ${enriched.length} cheapest pick(s); it counts where Torob states it.`;
    }

    return output;
  },
};

// ---------------------------------------------------------------- suggest

const suggestTool: ToolDef = {
  name: "torob_suggest",
  title: "Turn vague wording into a Torob query",
  description:
    "Call this first when the user's wording is colloquial, abbreviated or in Persian but you are unsure how " +
    "Torob spells it. Returns the wordings Torob's own search suggests for that text. " +
    "It fixes spelling and phrasing, not the budget or the comparison - that is search_products' job.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The words the user actually typed, e.g. 'قاب گوشی' or 'آیفون 13 ارزون'." },
    },
    required: ["query"],
  },
  async run(args) {
    const query = str(args.query).trim();
    if (!query) throw usageError("torob_suggest needs the words the user typed.");
    const found = await suggestTerms(query);
    return {
      query,
      suggestions: found.suggestions,
      next: found.suggestions.length
        ? "Pass one of these wordings to search_products."
        : "Torob has no suggestions for this text - pass the query to search_products as-is.",
      ...(found.dropped
        ? {
            note: `${found.dropped} Torob listing(s) for a shop or business were left out; what remains is wording for a product search.`,
          }
        : {}),
    };
  },
};

// ---------------------------------------------------------------- similar

const similarTool: ToolDef = {
  name: "similar_products",
  title: "Products similar to this one",
  description:
    "Products Torob considers comparable to the one you pass, cheapest first as cards. " +
    "This is the 'that one is too expensive, what else?' call. " +
    "The product must be one this server has already returned - Torob cannot look up a product by id alone, " +
    "so search_products or product_details must come first, and the details_url from that result should come " +
    "back with the prk.",
  inputSchema: {
    type: "object",
    properties: {
      prk: { type: "string", description: "A product id from a search_products card or a product_details response." },
      details_url: {
        type: "string",
        description:
          "The details_url from the same card. Pass it back with the prk and no record of the product is needed on this server.",
      },
      limit: { type: "number", description: "How many similar products (default 10, max 24)." },
    },
    required: ["prk"],
  },
  async run(args) {
    const prk = str(args.prk).trim();
    if (!prk) throw usageError("similar_products needs a prk this server has already returned.");
    const limit = clampLimit(args.limit, 10, 24);
    const products = await similarProducts(prk, limit, { detailsUrl: args.details_url });
    return {
      prk,
      found: products.length,
      products,
      ...(products.length === 0
        ? { note: "Torob lists no comparable products for this one." }
        : { note: "Cards carry the cheapest offer only; call product_details on any of them for the seller list." }),
    };
  },
};

// ---------------------------------------------------------------- categories

const categoriesTool: ToolDef = {
  name: "browse_categories",
  title: "Browse Torob's category tree",
  description:
    "List the sub-categories of a Torob category id, one level at a time. Torob has no 'all categories' call, " +
    "so this walks the tree: start with id '1' for the top level, then pass a child's id to go deeper. " +
    "Category ids are also accepted by search_products as `category`, and search results return the ones " +
    "relevant to that query as suggested_categories.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Parent category id. '1' is the top level." },
      limit: { type: "number", description: "How many children to return (default 20, max 30)." },
    },
    required: ["id"],
  },
  async run(args) {
    const id = str(args.id).trim();
    if (!id) throw usageError("browse_categories needs a category id. Start with '1' for the top level.");
    const limit = clampLimit(args.limit, 20, 30);
    const found = await categoryChildren(id, limit);
    return {
      parent_id: found.parent,
      count: found.categories.length,
      categories: found.categories,
      // A full page means "possibly more", never "definitely more": upstream
      // sends no total here, so a category with exactly `limit` children looks
      // the same as one with twice as many. The note says which kind of answer
      // it is, and does not tell anyone to raise a limit already at its max.
      ...(found.has_more
        ? {
            has_more: true,
            note:
              limit < 30
                ? "This page is full, so more children may exist - raise limit (max 30) to see them."
                : "This page is full at the largest page this tool asks for (30); Torob may have sent only part of the children.",
          }
        : {}),
      next: found.categories.length
        ? "Pass any child's id back as `id` to go one level deeper, or as `category` to search_products."
        : "This category has no children - pass it as `category` to search_products.",
    };
  },
};

// ----------------------------------------------------------------- locations

const locationsTool: ToolDef = {
  name: "list_locations",
  title: "List Iranian provinces and cities",
  description:
    "List Torob's provinces, or the cities of one province, optionally filtered by name. " +
    "City ids are what search_products accepts as `city` to see what is deliverable to a place. " +
    "Without a province this returns the provinces; with one it returns that province's cities.",
  inputSchema: {
    type: "object",
    properties: {
      province_id: { type: "string", description: "Province id, to list its cities instead of the provinces." },
      search: { type: "string", description: "Filter by name, e.g. 'تهران'." },
      limit: { type: "number", description: "How many to return (cities default 30, max 200; provinces come back whole, all 31)." },
    },
    required: [],
  },
  async run(args) {
    const provinceId = str(args.province_id).trim();
    const search = str(args.search).trim();
    // Provinces are a fixed list of 31, and a default of 30 used to drop the
    // last one while reporting the answer as complete. Cities run into
    // thousands, so they keep the smaller default.
    const limit = provinceId || search ? clampLimit(args.limit, 30, 200) : clampLimit(args.limit, 200, 200);

    if (!provinceId && search) {
      // A name with no province is still answerable: search every city.
      const found = await cities(undefined, search);
      return {
        mode: "cities",
        search,
        count: Math.min(found.length, limit),
        cities: found.slice(0, limit),
        ...(found.length > limit ? { total: found.length, truncated: true, note: `Showing ${limit} of ${found.length} - raise limit (max 200) for the rest.` } : {}),
      };
    }
    if (!provinceId) {
      const found = await provinces();
      // The five cities Torob's own users pick most, so an agent does not have
      // to ask the user for a city id it could have guessed. One extra upstream
      // request, cached for a day.
      let popular: { id: string; name: string; province_id: string | null }[] = [];
      try {
        popular = await popularCities();
      } catch {
        // A failed hint must not turn a plain province list into an error.
      }
      return {
        mode: "provinces",
        count: Math.min(found.length, limit),
        provinces: found.slice(0, limit),
        ...(popular.length ? { popular_cities: popular } : {}),
      };
    }
    const found = await cities(provinceId, search || undefined);
    return {
      mode: "cities",
      province_id: provinceId,
      ...(search ? { search } : {}),
      count: Math.min(found.length, limit),
      cities: found.slice(0, limit),
      ...(found.length > limit ? { total: found.length, truncated: true, note: `Showing ${limit} of ${found.length} - raise limit (max 200) for the rest.` } : {}),
      next: "Pass a city id as `city` to search_products to see what is deliverable there.",
    };
  },
};

// -------------------------------------------------------------------- offers

const offersTool: ToolDef = {
  name: "special_offers",
  title: "Torob's current special offers",
  description:
    "The deals Torob is featuring right now - merchandising, not shop data. Useful for 'anything cheap " +
    "right now?' and seasonal campaigns. It is NOT the seller list for a product: for that, use " +
    "product_details. A small fixed list, refreshed every ten minutes.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "How many offers (default 10, max 30)." },
    },
    required: [],
  },
  async run(args) {
    const limit = clampLimit(args.limit, 10, 30);
    const offers = await specialOffers(limit);
    return {
      count: offers.length,
      offers,
      note: "Torob's featured deals. For one product's sellers, use product_details instead.",
    };
  },
};

// ----------------------------------------------------------- price history

// The decision aid behind price_history, built only from the numbers Torob
// charts - no interpretation of which series "should" win, and no claim about
// the future. Persian series labels are Torob's own and travel as sent.
function priceReading(chart: PriceChart): string | null {
  const points = chart.series.flatMap((s) => s.points);
  if (!points.length) return null;
  const lowest = points.reduce((a, b) => (b.value < a.value ? b : a));
  const highest = points.reduce((a, b) => (b.value > a.value ? b : a));
  const latest = chart.series
    .filter((s) => s.latest)
    .map((s) => `${s.label} ${formatToman(s.latest?.value ?? null)} Toman (${s.latest?.date})`)
    .join("; ");
  return (
    `Over the newest ${chart.window.points} monthly point(s) (${chart.window.from} to ${chart.window.to}) the lowest ` +
    `figure Torob charts is ${formatToman(lowest.value)} Toman (${lowest.date}) and the highest ${formatToman(highest.value)} ` +
    `(${highest.date}). Latest: ${latest}.`
  );
}

const priceHistoryTool: ToolDef = {
  name: "price_history",
  title: "Price history and trend for one product",
  description:
    "Torob's own price chart for a product: monthly points going back years, each series carrying Torob's own label " +
    "(the average and the lowest price it has charted), when the price was last updated, and - with include_changes - " +
    "the newest price changes across its shops. This is the 'is now a good time to buy?' call: compare today's price " +
    "with the lowest this product has been. Pass the prk from a search_products card together with that card's details_url.",
  inputSchema: {
    type: "object",
    properties: {
      prk: { type: "string", description: "Product id from a search_products card (or a torob.com /p/<id>/ URL)." },
      details_url: {
        type: "string",
        description: "The details_url from the same card, so the id resolves with no lookup.",
      },
      months: {
        type: "number",
        description: "How many monthly points to return, newest last (default 12, max 54).",
      },
      include_changes: {
        type: "boolean",
        description: "Also read Torob's newest price changes for this product. Costs one extra upstream request.",
      },
      changes_limit: { type: "number", description: "How many changes with include_changes (default 5, max 20)." },
    },
    required: ["prk"],
  },
  async run(args) {
    const prk = str(args.prk).trim();
    if (!prk) throw usageError("price_history needs a prk - the product id from a search_products card.");
    const months = clampLimit(args.months, 12, 54);
    const changesLimit = clampLimit(args.changes_limit, 5, 20);
    const opts = { detailsUrl: args.details_url };

    const chart = await productPriceChart(prk, months, opts);
    const lastModified = await productLastModified(prk, opts);
    const changes = args.include_changes === true ? await productPriceChanges(prk, changesLimit, opts) : null;

    return {
      prk,
      window: chart.window,
      points_available: chart.points_available,
      series: chart.series,
      ...(chart.points_available > chart.window.points
        ? {
            window_note: `Torob charts ${chart.points_available} monthly point(s) for this product; showing the newest ${chart.window.points}. Raise months to see more.`,
          }
        : {}),
      reading: priceReading(chart),
      last_modified: lastModified,
      last_modified_note:
        "Torob's own last price update for this product. Prices can move after it - confirm on torob.com before buying.",
      ...(changes
        ? {
            changes_count: changes.count,
            changes: changes.changes,
            ...(changes.changes.length
              ? { changes_note: "Newest first. Each entry is one shop's move, not this product's price everywhere." }
              : { changes_note: "Torob lists no price changes for this product." }),
          }
        : {}),
      ...(chart.series.length ? {} : { note: "Torob charts no price history for this product yet." }),
      attribution: ATTRIBUTION,
    };
  },
};

// ------------------------------------------------------------- shop profile

const shopProfileTool: ToolDef = {
  name: "shop_profile",
  title: "A seller's Torob profile and catalogue",
  description:
    "One Torob shop as Torob itself profiles it: trust seal (enamad) level and validity, score and percentile, how long " +
    "it has been active, Torob's own notes about it (including any violation note), city and address, payment and " +
    "delivery options, support hours and website. This is the 'is this seller any good?' call - pass the shop_id from a " +
    "product_details offer. With include_products it also lists that shop's own catalogue as cards, cheapest first.",
  inputSchema: {
    type: "object",
    properties: {
      shop_id: { type: "string", description: "Numeric shop id, from a product_details offer or from find_shops." },
      include_products: {
        type: "boolean",
        description: "Also list this shop's own catalogue. Costs one extra upstream request.",
      },
      page: { type: "number", description: "Catalogue page, 1-based (default 1)." },
      limit: { type: "number", description: "How many catalogue cards (default 10, max 24)." },
    },
    required: ["shop_id"],
  },
  async run(args) {
    const shopId = str(args.shop_id).trim();
    if (!shopId) throw usageError("shop_profile needs a shop_id - the numeric id on a product_details offer.");
    const profile = await shopProfile(shopId);

    let catalogue: Record<string, unknown> = {};
    if (args.include_products === true) {
      const page = clampPage(args.page, 20);
      const limit = clampLimit(args.limit, 10, 24);
      const found = await shopProducts(shopId, page, limit);
      catalogue = {
        catalogue_count: found.count,
        catalogue_page: found.page,
        catalogue_has_next_page: found.has_next_page,
        catalogue_price_range_toman: { min: found.min_price_toman, max: found.max_price_toman },
        catalogue_products: found.products,
        ...(found.products.length < found.page_count
          ? {
              catalogue_truncated: true,
              catalogue_note: `${found.page_count} cards were on this catalogue page; showing ${found.products.length}. Raise limit or page on.`,
            }
          : {}),
        // This pager stops at 20 while the shared convention promises 50, so a
        // clamped page has to say so here too - a silent clamp reads as an
        // empty shelf at page 21.
        ...(pageClampNote(args.page, 20)),
      };
    }

    return {
      ...profile,
      ...catalogue,
      next: args.include_products
        ? "For one product's seller list, call product_details; for the rest of this shop's catalogue, page on."
        : "Pass this shop_id with include_products for its catalogue, or use the offer's product in product_details.",
      attribution: ATTRIBUTION,
    };
  },
};

// --------------------------------------------------------------- find shops

const findShopsTool: ToolDef = {
  name: "find_shops",
  title: "Find a Torob shop by name or city",
  description:
    "Search Torob's SHOP directory - businesses, not products: by name, by city id, and narrowed to online or " +
    "in-person sellers. Every row carries the id to pass to shop_profile. Use it when the user names a store or asks " +
    "what shops there are; asking about products stays in search_products.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "A shop name or part of one, e.g. 'زوبین کالا' or 'موبایل'." },
      city: { type: "string", description: "Delivery city id from list_locations, to narrow to one city." },
      shop_type: { type: "string", enum: [...SHOP_TYPES], description: "offline = in-person sellers, online = online sellers." },
      page: { type: "number", description: "1-based page (default 1)." },
      limit: { type: "number", description: "How many shops (default 10, max 24)." },
    },
    required: [],
  },
  async run(args) {
    const query = str(args.query).trim() || undefined;
    const city = str(args.city).trim() || undefined;
    const shopType = shopTypeOf(args.shop_type);
    const page = clampPage(args.page, SHOP_PAGE_MAX);
    const limit = clampLimit(args.limit, 10, 24);

    const found = await findShops({ q: query, city, shopType, page, limit });
    return {
      query: query ?? null,
      ...(city ? { city } : {}),
      ...(shopType ? { shop_type: shopType } : {}),
      total_shops: found.count,
      page: found.page,
      has_next_page: found.has_next_page,
      shops: found.shops,
      ...(found.shops.length === 0
        ? { note: "No shop matched. Try a shorter name, or drop the city filter - the directory covers online and in-person sellers." }
        : { note: "A shop id is what shop_profile needs; this list is not a product list." }),
      // The directory pages to SHOP_PAGE_MAX, not to the 50 the shared
      // convention promises, so a clamped page says so.
      ...(pageClampNote(args.page, SHOP_PAGE_MAX)),
    };
  },
};

// ---------------------------------------------------------- search by image

const searchByImageTool: ToolDef = {
  name: "search_by_image",
  title: "Find products from a picture",
  description:
    "Find products from an image: pass a public http(s) image URL and Torob returns the products it matches, as cards. " +
    "Torob fetches the image itself - there is no upload here - so the link has to be reachable from the internet. " +
    "When Torob recognises the picture as one specific product, matched_product names it.",
  inputSchema: {
    type: "object",
    properties: {
      image_url: { type: "string", description: "A public http(s) URL of the picture to search Torob with." },
      page: { type: "number", description: "1-based page (default 1)." },
      limit: { type: "number", description: "How many cards (default 10, max 24 - one page carries that many)." },
    },
    required: ["image_url"],
  },
  async run(args) {
    const imageUrl = str(args.image_url).trim();
    if (!imageUrl) throw usageError("search_by_image needs an image_url - a public link to the picture.");
    const page = clampPage(args.page, 20);
    const limit = clampLimit(args.limit, 10, 24);

    const found = await searchByImage(imageUrl, page, limit);
    return {
      image_url: found.uploaded_image_url ?? imageUrl,
      page: found.page,
      has_next_page: found.has_next_page,
      // Same as the shop directory: this pager stops at 20, so a clamped page
      // has to say so rather than look like an empty page.
      ...(pageClampNote(args.page, 20)),
      ...(found.matched_product ? { matched_product: found.matched_product } : {}),
      ...(found.detected_objects.length ? { detected_objects: found.detected_objects } : {}),
      products: found.products,
      ...(found.products.length === 0
        ? {
            note:
              "Torob matched nothing to this image. It may be unreachable, too small, or simply not in its catalogue - " +
              "an empty answer is not proof the product does not exist.",
          }
        : { note: "Cards carry the cheapest offer only; call product_details for the sellers behind one." }),
      attribution: ATTRIBUTION,
    };
  },
};

// ------------------------------------------------------------------ trends

const trendsTool: ToolDef = {
  name: "torob_trends",
  title: "What Torob shoppers are searching right now",
  description:
    "Torob's own trending searches: the wordings shoppers are using right now, each with one sample product " +
    "(carrying its prk and details_url, so it can be opened straight away). Use it for 'what is popular right now', " +
    "or to seed a search when the user has no wording of their own. For Torob's featured deals - a different thing - " +
    "use special_offers.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "How many trending searches (default 10, max 30)." },
    },
    required: [],
  },
  async run(args) {
    const limit = clampLimit(args.limit, 10, 30);
    const trends = await trendingSearches(limit);
    return {
      count: trends.length,
      trends,
      note: "Each item is a wording people search with, plus one product it currently returns.",
    };
  },
};

export const TOOLS: ToolDef[] = [
  suggestTool,
  searchTool,
  detailsTool,
  priceHistoryTool,
  similarTool,
  compareTool,
  bestValueTool,
  shopProfileTool,
  findShopsTool,
  searchByImageTool,
  trendsTool,
  categoriesTool,
  locationsTool,
  offersTool,
];

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}
