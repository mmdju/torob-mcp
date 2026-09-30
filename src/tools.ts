// torob-mcp tools. Nine read-only tools.
//
// The split that matters: a search card shows the CHEAPEST offer only, because
// that is the one number a shopper asks for. Every seller behind that number
// lives behind product_details. An agent that answers "where is this cheapest"
// from a search card would be naming a shop it never checked the reliability
// of, so the two are deliberately separate calls.

import { SHOP_TYPES, SORTS, SORT_LABELS, type ShopType, type Sort } from "./config.js";
import { UpstreamError } from "./http.js";
import { clampLimit, clampPage, foldKey, num, pageClampNote, str } from "./normalize.js";
import {
  type FilterGroup,
  type LookupBudget,
  type ProductCard,
  categoryChildren,
  cities,
  filterKeyMap,
  filterMemoryKey,
  productDetails,
  provinces,
  rememberedFilterGroups,
  searchProducts,
  similarProducts,
  specialOffers,
  suggestTerms,
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
          "Brand slug from the brand group of available_filters (options[].value, or its values_url list), " +
          "e.g. 'apple-اپل'. A display name like 'apple' is not a slug and Torob ignores it.",
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
      limit: { type: "number", description: "How many cards to return (default 10, max 30)." },
    },
    required: ["query"],
  },
  async run(args) {
    const query = str(args.query).trim();
    if (!query) throw usageError("search_products needs a query - the words the user is looking for.");
    const page = clampPage(args.page);
    const sort = sortOf(args.sort);
    const shopType = shopTypeOf(args.shop_type);
    const limit = clampLimit(args.limit);
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
    // The loop this server promises: read available_filters, pass a value back.
    // When this exact query's filters were seen before, the check happens
    // before any upstream call. Otherwise the search itself runs and its own
    // response becomes the authority. Either way a filter that would be
    // ignored upstream is refused instead of returning an unfiltered list.
    let checked: Record<string, string> | null = null;
    if (Object.keys(wanted).length) {
      const remembered = await rememberedFilterGroups(filterMemoryKey(query, { category, city, shopType }));
      if (remembered) checked = validateFilters(wanted, remembered, "canonicalize");
    }
    Object.assign(applied, checked ?? wanted);

    // A brand filter wants the slug Torob uses, not the name people say
    // (measured: brand=apple changed nothing, brand=apple-اپل narrowed the
    // list). Map a name through the brand group when this query showed one.
    let brand = str(args.brand).trim() || undefined;
    if (brand) {
      const groups = await rememberedFilterGroups(filterMemoryKey(query, { category, city, shopType }));
      const brandGroup = groups?.find((g) => g.type === "brand");
      const matched = brandGroup?.options?.find((o) => o.value === brand || foldKey(o.name) === foldKey(brand));
      if (matched) brand = matched.value;
    }

    const found = await searchProducts({
      q: query,
      page,
      sort,
      category,
      brand,
      city,
      shopType,
      filters: Object.keys(applied).length ? applied : undefined,
    });

    if (Object.keys(wanted).length && !checked) {
      // Cold path: the search has already run, so the response itself decides
      // whether every value was real. A value that is not in the form the
      // search advertised (a display name, say) is refused here rather than
      // returned as if the filter had been applied.
      Object.assign(applied, validateFilters(wanted, found.available_filters, "exact"));
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
      products: found.products.slice(0, limit),
      available_filters: found.available_filters,
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
    },
    required: ["prk"],
  },
  async run(args) {
    const prk = str(args.prk).trim();
    if (!prk) throw usageError("product_details needs a prk - the product id from a search_products card.");
    const maxOffers = clampLimit(args.max_offers, 10, 30);
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
                  `${buyable.length ? buyable[0].price_text : "none available"}. Widen the search or raise the budget.`,
            ...(await withSuggestions(query, [])),
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
      ...(found.has_more
        ? { has_more: true, note: "There are more children than shown; raise limit to see them all." }
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
      limit: { type: "number", description: "How many to return (default 30, max 200)." },
    },
    required: [],
  },
  async run(args) {
    const provinceId = str(args.province_id).trim();
    const search = str(args.search).trim();
    const limit = clampLimit(args.limit, 30, 200);

    if (!provinceId && search) {
      // A name with no province is still answerable: search every city.
      const found = await cities(undefined, search);
      return { mode: "cities", search, count: Math.min(found.length, limit), cities: found.slice(0, limit) };
    }
    if (!provinceId) {
      const found = await provinces();
      return { mode: "provinces", count: Math.min(found.length, limit), provinces: found.slice(0, limit) };
    }
    const found = await cities(provinceId, search || undefined);
    return {
      mode: "cities",
      province_id: provinceId,
      ...(search ? { search } : {}),
      count: Math.min(found.length, limit),
      cities: found.slice(0, limit),
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

export const TOOLS: ToolDef[] = [
  suggestTool,
  searchTool,
  detailsTool,
  similarTool,
  compareTool,
  bestValueTool,
  categoriesTool,
  locationsTool,
  offersTool,
];

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}
