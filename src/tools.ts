// torob-mcp tools. Five read-only tools.
//
// The split that matters: a search card shows the CHEAPEST offer only, because
// that is the one number a shopper asks for. Every seller behind that number
// lives behind product_details. An agent that answers "where is this cheapest"
// from a search card would be naming a shop it never checked the reliability
// of, so the two are deliberately separate calls.

import { KNOWN_FILTER_SLUGS, SHOP_TYPES, SORTS, SORT_LABELS, type ShopType, type Sort } from "./config.js";
import { UpstreamError } from "./http.js";
import { clampLimit, clampPage, num, pageClampNote, str } from "./normalize.js";
import {
  type ProductCard,
  categoryChildren,
  cities,
  productDetails,
  provinces,
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
    "Every search returns available_filters: the filter groups this search really accepts, " +
    "with their slugs - pass those slugs back in `filters` to narrow it down.",
  inputSchema: {
    type: "object",
    properties: {
      query: QUERY,
      page: { type: "number", description: "1-based page, max 50. Deep pages cost an extra upstream request." },
      sort: { type: "string", enum: [...SORTS], description: "popularity (default) = most relevant, price = cheapest first, newest." },
      category: { type: "string", description: "Torob category id, e.g. from suggested_categories or browse_categories." },
      brand: { type: "string", description: "Filter by brand, e.g. 'apple'." },
      city: { type: "string", description: "Filter by delivery city id, e.g. from list_locations." },
      shop_type: { type: "string", enum: [...SHOP_TYPES], description: "offline = shops with a branch, online = online sellers." },
      min_price_toman: { type: "number", description: "Only show products at or above this price." },
      max_price_toman: { type: "number", description: "Only show products at or below this price." },
      filters: {
        type: "object",
        description:
          "Torob's own filter slugs, from available_filters of an earlier search. " +
          "Example: {\"price__lt\": \"50000000\", \"available\": \"1\", \"torobpay\": \"1\"}. " +
          "An unknown slug is refused with the real ones rather than silently ignored.",
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

    // The two price bounds are the same upstream filter the user cares about
    // most, so they get first-class parameters that compile to Torob's slugs.
    const filters: Record<string, string> = {};
    const minPrice = num(args.min_price_toman, 0);
    const maxPrice = num(args.max_price_toman, 0);
    if (minPrice > 0) filters.price__gt = String(Math.round(minPrice));
    if (maxPrice > 0) filters.price__lt = String(Math.round(maxPrice));
    if (minPrice > 0 && maxPrice > 0 && minPrice > maxPrice) {
      throw usageError(
        `min_price_toman (${Math.round(minPrice)}) is above max_price_toman (${Math.round(maxPrice)}), so nothing can match.`
      );
    }
    const extra = args.filters;
    if (extra && typeof extra === "object" && !Array.isArray(extra)) {
      for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
        const slug = str(k).trim();
        if (!slug) continue;
        if (!KNOWN_FILTER_SLUGS.includes(slug as (typeof KNOWN_FILTER_SLUGS)[number])) {
          // Torob ignores an unknown slug and answers with the unfiltered
          // list, which looks like a filtered result. Refuse instead.
          throw usageError(
            `'${slug}' is not a filter this search accepts. Known slugs: ${KNOWN_FILTER_SLUGS.join(", ")}. ` +
              `Run search_products first and read available_filters for this query - Torob offers different filters per query.`
          );
        }
        filters[slug] = str(v).trim();
      }
    }

    const found = await searchProducts({
      q: query,
      page,
      sort,
      category: str(args.category).trim() || undefined,
      brand: str(args.brand).trim() || undefined,
      city: str(args.city).trim() || undefined,
      shopType,
      filters: Object.keys(filters).length ? filters : undefined,
    });

    return {
      query,
      sort,
      sort_meaning: SORT_LABELS[sort],
      filters_applied: Object.keys(filters).length ? filters : undefined,
      total_matches: found.total,
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
    "delivery and discount info. This is the call that answers 'who sells this cheapest' and 'is that shop " +
    "any good'. Pass the prk from a search_products result, or a full torob.com product URL. " +
    "An offer with available false is out of stock; price_unreliable is Torob's own warning about that price.",
  inputSchema: {
    type: "object",
    properties: {
      prk: { type: "string", description: "Product id from a search_products card (or a torob.com /p/<id>/ URL)." },
      max_offers: { type: "number", description: "How many seller offers to return (default 10, max 30)." },
    },
    required: ["prk"],
  },
  async run(args) {
    const prk = str(args.prk).trim();
    if (!prk) throw usageError("product_details needs a prk - the product id from a search_products card.");
    const maxOffers = clampLimit(args.max_offers, 10, 30);
    const found = await productDetails(prk);
    const cheapest = found.cheapest_offer;
    const best = found.best_rated_offer;

    return {
      prk: found.prk,
      name_fa: found.name_fa,
      name_en: found.name_en,
      cheapest_price_toman: found.price_toman,
      available: found.available,
      image: found.image,
      badges: found.badges,
      url: found.url,
      offer_count: found.offer_count,
      // The number that makes this more than a search: how much the same
      // product costs depending on who you buy it from.
      price_spread_toman: found.price_spread_toman,
      cheapest_offer: cheapest,
      best_rated_offer: best,
      ...(best && cheapest && best.shop_name !== cheapest.shop_name
        ? {
            cheapest_vs_best_rated: `Cheapest is ${cheapest.shop_name} at ${cheapest.price_text}; the best rated available shop is ${best.shop_name} (score ${best.shop_score}, ${best.shop_votes} votes) at ${best.price_text}.`,
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

const compareTool: ToolDef = {
  name: "compare_products",
  title: "Compare products across shops",
  description:
    "Open 2-5 Torob products by prk and put their seller offers side by side: cheapest price, number of " +
    "sellers, the price spread between shops, and the best rated seller. Use it when the user is choosing " +
    "between specific products rather than searching for one.",
  inputSchema: {
    type: "object",
    properties: {
      prks: { type: "array", items: { type: "string" }, description: "2-5 product ids from search_products." },
    },
    required: ["prks"],
  },
  async run(args) {
    const list = Array.isArray(args.prks) ? args.prks.map((p) => str(p).trim()).filter(Boolean) : [];
    if (list.length < 2) throw usageError("compare_products needs at least 2 prks to compare.");
    if (list.length > 5) throw usageError(`compare_products compares up to 5 products at once; ${list.length} were given.`);

    const results = await Promise.all(
      list.map(async (prk) => {
        try {
          const found = await productDetails(prk);
          const cheapest = found.cheapest_offer;
          return {
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
          };
        } catch (err) {
          // One dead product must not hide the others: the failure travels
          // with that row, so a 3-way comparison still answers for the 2 that
          // resolved.
          return {
            prk,
            error: err instanceof UpstreamError ? err.message : "Could not read this product.",
          };
        }
      })
    );

    const ok = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    const withPrice = ok
      .map((r) => ({ name: r.name_fa ?? r.prk, price: r.cheapest_price_toman }))
      .filter((x): x is { name: string; price: number } => x.price !== null && x.price !== undefined);

    return {
      compared: ok.length,
      requested: list.length,
      products: results,
      ...(withPrice.length > 1
        ? {
            cheapest_overall: withPrice.reduce((a, b) => (a.price <= b.price ? a : b)),
            price_difference_toman: Math.max(...withPrice.map((x) => x.price)) - Math.min(...withPrice.map((x) => x.price)),
          }
        : {}),
      ...(failed.length
        ? { partial_failure: true, failed_note: `${failed.length} of ${list.length} products could not be read; see each row's error.` }
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
    "A price that is not a real ask is reported as such rather than treated as a bargain.",
  inputSchema: {
    type: "object",
    properties: {
      query: QUERY,
      budget_toman: { type: "number", description: "Maximum price in Toman. Leave unset to just rank by price." },
      sort: { type: "string", enum: [...SORTS], description: "popularity (default) or price (cheapest first)." },
      limit: { type: "number", description: "How many ranked picks to return (default 5, max 15)." },
    },
    required: ["query"],
  },
  async run(args) {
    const query = str(args.query).trim();
    if (!query) throw usageError("find_best_value needs a query - the item the user wants.");
    const budget = num(args.budget_toman, 0) > 0 ? Math.round(num(args.budget_toman, 0)) : null;
    const limit = clampLimit(args.limit, 5, 15);
    const sort = sortOf(args.sort) === "newest" ? "popularity" : sortOf(args.sort);

    const found = await searchProducts({ q: query, page: 1, sort });

    const buyable = found.products.filter((p) => p.available && p.price_toman !== null);
    const inBudget = budget === null ? buyable : buyable.filter((p) => (p.price_toman as number) <= budget);
    // Rank by price when the user named a budget, and keep relevance order
    // otherwise - "best" without a budget is usually "most relevant that is in
    // stock", not "the cheapest thing with an unclear name".
    const ranked = budget !== null ? [...inBudget].sort((a, b) => (a.price_toman as number) - (b.price_toman as number)) : inBudget;

    return {
      query,
      budget_toman: budget,
      total_matches: found.total,
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
    "so search_products or product_details must come first.",
  inputSchema: {
    type: "object",
    properties: {
      prk: { type: "string", description: "A product id from a search_products card or a product_details response." },
      limit: { type: "number", description: "How many similar products (default 10, max 24)." },
    },
    required: ["prk"],
  },
  async run(args) {
    const prk = str(args.prk).trim();
    if (!prk) throw usageError("similar_products needs a prk this server has already returned.");
    const limit = clampLimit(args.limit, 10, 24);
    const products = await similarProducts(prk, limit);
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
