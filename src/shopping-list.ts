// Compare exact products already selected by the user. No fuzzy matching,
// account access, cart writes, or new Torob endpoints.
import { ATTRIBUTION } from "./config.js";
import { UpstreamError } from "./http.js";
import { clampLimit, clampPage, short } from "./normalize.js";
import { detailsUrlOf, productDetails, type Offer } from "./project.js";
import type { ToolDef } from "./tools.js";

interface Item { prk: string; details_url: string; quantity: number }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseItems(value: unknown): Item[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw new UpstreamError("Provide 1-10 exact items from search_products.", "usage");
  }
  const seen = new Set<string>();
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UpstreamError("Each item needs prk and details_url from the same search card.", "usage");
    const row = raw as Record<string, unknown>;
    const prk = typeof row.prk === "string" ? row.prk.trim().toLowerCase() : "";
    const url = detailsUrlOf(row.details_url);
    const parsed = url ? new URL(url) : null;
    const quantity = row.quantity ?? 1;
    if (!UUID.test(prk) || !parsed || parsed.port || parsed.username || parsed.password ||
      parsed.pathname !== "/v4/base-product/details/" || parsed.searchParams.get("prk")?.toLowerCase() !== prk) {
      throw new UpstreamError("Each item needs a UUID prk and matching Torob details_url from search_products.", "usage");
    }
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      throw new UpstreamError("Item quantity must be an integer from 1 to 100.", "usage");
    }
    if (seen.has(prk)) throw new UpstreamError("Duplicate product id: combine its quantities into one item.", "usage");
    seen.add(prk);
    parsed.searchParams.set("prk", prk);
    return { prk, details_url: parsed.toString(), quantity };
  });
}

export const shoppingListTool: ToolDef = {
  name: "compare_shopping_list",
  title: "Compare shops for a shopping list",
  description: "Find shops carrying most or all of 1-10 exact products selected with search_products. Pass each card's prk and matching details_url; confirm variants first. Rank by distinct-item coverage, then quantity-adjusted subtotal in Toman. Exclude unavailable, unknown-stock, unpriced and price-unreliable offers. Return missing items and purchase links for browser handoff. Shipping and quantity availability need checkout verification. Never logs in, favorites, orders or pays.",
  inputSchema: {
    type: "object",
    properties: {
      items: {
        type: "array", minItems: 1, maxItems: 10,
        items: {
          type: "object", additionalProperties: false,
          properties: {
            prk: { type: "string", description: "Exact product UUID from search_products." },
            details_url: { type: "string", description: "Matching details_url from that same card." },
            quantity: { type: "integer", minimum: 1, maximum: 100, default: 1 },
          },
          required: ["prk", "details_url"],
        },
      },
      limit: { type: "number", description: "Shops per page (default 3, max 5)." },
      page: { type: "number", description: "Shop result page, 1-based (default 1, max 50)." },
    },
    required: ["items"],
  },
  async run(args) {
    // Validate the entire list before spending the first upstream request.
    const items = parseItems(args.items);
    const limit = clampLimit(args.limit, 3, 5);
    const page = clampPage(args.page);
    const products = [];
    const shops = new Map<string, { name: string; offers: Map<string, Offer> }>();
    for (const item of items) {
      const url = `https://torob.com/p/${item.prk}/`;
      try {
        // The matching details URL avoids name searches or extra resolution calls.
        const product = await productDetails(item.prk, { detailsUrl: item.details_url, lookupBudget: { left: 0 } });
        if (product.prk.toLowerCase() !== item.prk) throw new UpstreamError("Torob returned a different product; search again before comparing.", "usage");
        const eligible = new Map<string, Offer>();
        for (const offer of product.offers) {
          if (!product.available || !offer.available || !offer.availability_confirmed || offer.price_unreliable ||
            !offer.shop_id || !/^\d+$/.test(offer.shop_id) || offer.price_toman === null ||
            !Number.isSafeInteger(offer.price_toman) || offer.price_toman <= 0 ||
            !Number.isSafeInteger(offer.price_toman * item.quantity)) continue;
          const previous = eligible.get(offer.shop_id);
          if (!previous || offer.price_toman < (previous.price_toman ?? Infinity)) eligible.set(offer.shop_id, offer);
        }
        for (const [id, offer] of eligible) {
          const shop = shops.get(id) ?? { name: offer.shop_name, offers: new Map<string, Offer>() };
          shop.offers.set(item.prk, offer);
          shops.set(id, shop);
        }
        products.push({ prk: item.prk, name: product.name_fa, url, quantity: item.quantity, status: "ok", eligible_shop_count: eligible.size, excluded_offers: product.offers.length - [...eligible.values()].length });
      } catch (error) {
        products.push({ prk: item.prk, url, quantity: item.quantity, status: "error", error: short(error instanceof UpstreamError ? error.message : "Could not read this product. Retry product_details before comparing.", 220) });
      }
    }
    const ranked = [...shops].map(([shop_id, shop]) => {
      const lines = items.flatMap((item) => {
        const offer = shop.offers.get(item.prk);
        return offer ? [{ prk: item.prk, quantity: item.quantity, unit_price_toman: offer.price_toman!, line_total_toman: offer.price_toman! * item.quantity, listing_title: offer.listing_title, buy_url: offer.buy_url, shop_score: offer.shop_score, shop_votes: offer.shop_votes, is_adv: offer.is_adv, price_updated: offer.last_price_change_date }] : [];
      });
      const subtotal = lines.reduce((sum, line) => sum + line.line_total_toman, 0);
      if (!Number.isSafeInteger(subtotal)) throw new UpstreamError("Basket subtotal exceeds the supported integer range.", "usage");
      return { shop_id, shop_name: shop.name, url: `https://torob.com/shop/${shop_id}/`, covered_items: lines.length, total_items: items.length, complete: lines.length === items.length, subtotal_toman: subtotal, shipping_included: false, missing_prks: items.filter((item) => !shop.offers.has(item.prk)).map((item) => item.prk), lines };
    }).sort((a, b) => b.covered_items - a.covered_items || a.subtotal_toman - b.subtotal_toman || a.shop_id.localeCompare(b.shop_id));
    return {
      comparison_complete: products.every((p) => p.status === "ok"),
      items: products,
      shop_count: ranked.length, page,
      has_next_page: page * limit < ranked.length,
      shops: ranked.slice((page - 1) * limit, page * limit),
      favorites_url: "https://torob.com/user/favorites/",
      note: "Subtotals exclude shipping. Stock is merchant-reported; quantities, listing variants, warranty and final prices must be checked at checkout. Failed items are unknown, not unavailable. Open product links to favorite in your logged-in browser; no favorites, carts or orders were changed.",
      attribution: ATTRIBUTION,
    };
  },
};
