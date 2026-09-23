// torob-mcp tools. Five read-only tools.
//
// The split that matters: a search card shows the CHEAPEST offer only, because
// that is the one number a shopper asks for. Every seller behind that number
// lives behind product_details. An agent that answers "where is this cheapest"
// from a search card would be naming a shop it never checked the reliability
// of, so the two are deliberately separate calls.

import { SHOP_TYPES, SORTS, SORT_LABELS, type ShopType, type Sort } from "./config.js";
import { UpstreamError } from "./http.js";
import { clampLimit, clampPage, num, pageClampNote, str } from "./normalize.js";
import {
  type ProductCard,
  productDetails,
  searchProducts,
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
    "price_toman 0 or available false means out of stock, not free.",
  inputSchema: {
    type: "object",
    properties: {
      query: QUERY,
      page: { type: "number", description: "1-based page, max 50. Deep pages cost an extra upstream request." },
      sort: { type: "string", enum: [...SORTS], description: "popularity (default) = most relevant, price = cheapest first, newest." },
      category: { type: "string", description: "Torob category id, when the user narrowed to a category." },
      brand: { type: "string", description: "Filter by brand, e.g. 'apple'." },
      city: { type: "string", description: "Filter by delivery city." },
      shop_type: { type: "string", enum: [...SHOP_TYPES], description: "offline = shops with a branch, online = online sellers." },
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

    const found = await searchProducts({
      q: query,
      page,
      sort,
      category: str(args.category).trim() || undefined,
      brand: str(args.brand).trim() || undefined,
      city: str(args.city).trim() || undefined,
      shopType,
    });

    return {
      query,
      sort,
      sort_meaning: SORT_LABELS[sort],
      total_matches: found.total,
      page: found.page,
      page_count: found.page_count,
      has_next_page: found.has_next_page,
      price_range_toman: { min: found.min_price_toman, max: found.max_price_toman },
      products: found.products.slice(0, limit),
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

export const TOOLS: ToolDef[] = [suggestTool, searchTool, detailsTool, compareTool, bestValueTool];

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}
