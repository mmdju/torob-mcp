// Shared MCP server factory: used by index.ts (Node transports) and
// worker.ts (Workers). No node: imports here - must stay portable.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { UpstreamError } from "./http.js";
import { setWaitUntil, type WaitUntil } from "./project.js";
import { READ_ONLY, TOOLS } from "./tools.js";

export const VERSION = "0.5.6";

// Server-level guidance: cheaper than repeating it in every tool description,
// and it steers the agent before it picks a tool at all. It is the first thing
// an agent reads, so it has to name every tool AND stay true.
// tests/agent-surface.test.mjs gates both.
export const INSTRUCTIONS = [
  "Torob (Iran's price-comparison engine) price intelligence. Read-only, no API key needed.",
  "All prices are in Toman.",
  "Pick the entry point: torob_suggest when the wording is vague, search_products to browse, " +
  "product_details for one product's seller list and the shops selling it in person, price_history for whether " +
  "now is a good time to buy, similar_products for 'what else is like this', " +
  "compare_products to put 2-5 products side by side, find_best_value for any question with a budget " +
  "or the word 'best', shop_profile when the seller itself is the question, find_shops to locate a shop by name " +
  "or city, search_by_image when the user shares a picture link, torob_trends for what shoppers are searching " +
  "right now, browse_categories to walk the category tree, list_locations for province and city " +
  "ids, special_offers for the deals Torob is featuring, product_guide for Torob's own write-up of one model.",
  "A search card carries the CHEAPEST offer only, not every seller. To answer 'who sells this' or " +
  "'is that shop reliable' call product_details - that is where the full seller list, shop scores and " +
  "vote counts live - and shop_profile for the shop behind any offer's shop_id.",
  "product_details also returns what Torob already knows and a card does not: the in_person_sellers selling this " +
  "product in a physical shop, with city, address, price and whether the shop is open, plus the spec tables, the " +
  "variant tabs and Torob's own price_range_toman. An in-person price is that shop's own and can be months old, " +
  "so read its last_price_change_date out loud rather than presenting a shelf price as today's.",
  "price_history answers 'is now a good time to buy': Torob's own monthly chart for one product, its lowest and " +
  "highest charted figures, when the price was last updated, and - with include_changes - the newest moves across " +
  "its shops. The series labels are Torob's; quote them as such instead of inventing a trend.",
  "search_by_image takes a public image URL and nothing else, and its matched_product names the one product Torob " +
  "recognised in the picture, when it recognised one. shop_profile's include_products lists a shop's own " +
  "catalogue; pair it with the shop_id from a product_details offer.",
  "product_guide reads Torob's own guide for one product - what the model is, its strengths and weaknesses, what " +
  "buyers said and who it suits - for the 'should I buy this?' question a price chart alone does not answer. It " +
  "is text, not a seller list, and not every product has one: an empty answer is Torob having no guide, so never " +
  "compose a summary of your own in its place.",
  "Every search returns available_filters - the filter groups that search really accepts, with their " +
  "slugs and the values each takes. Pass those values back in filters, or use min_price_toman / " +
  "max_price_toman for a price window. Torob ignores a slug or value it does not know and answers " +
  "unfiltered, so anything the fresh search does not advertise is refused here instead.",
  "Torob's total_matches is its own count and is approximate - it changes between identical requests. " +
  "Page with has_next_page instead of quoting the number.",
  "A product id resolves by exact match. When only a name search can re-find it, product_details says " +
  "resolved_by rather than presenting the match as the same id.",
  "Product ids are only usable after this server has returned them: Torob cannot look up a product by id " +
  "alone. Search for the product first, then pass both the prk and the details_url from that card back to " +
  "product_details or similar_products - the URL makes the id resolve with no memory involved.",
  "price_toman 0, or available false, means out of stock - never free. An offer flagged price_unreliable " +
  "is Torob's own warning about that number; say so instead of treating it as a bargain.",
  "An empty result is not proof a product does not exist - the wording may simply be wrong. When a search " +
  "returns nothing, call torob_suggest and retry with what it suggests.",
  "Torob pages are paginated (page 1-based, max 50) and deep pages cost an extra upstream request.",
  "Torob's edge answers bursts of calls with a bot challenge (HTTP 490). It clears after a stretch " +
  "with no calls at all - minutes to half an hour - so a challenged error is worth retrying later, " +
  "never immediately.",
  "Prices and stock move constantly, and an answer can be served from what this server fetched up to " +
  "half an hour ago: when the freshness of a number is what the user is deciding on, call it recent " +
  "rather than current, and always keep the product URL in the answer so they can confirm on torob.com " +
  "before buying.",
  "This server never logs in, never solves bot challenges, and never contacts a shop. It reads the public " +
  "web API only.",
].join(" ");

export function buildServer(ctx?: WaitUntil): Server {
  const server = new Server(
    { name: "torob-mcp", version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: { ...t.inputSchema, additionalProperties: false },
      annotations: { ...READ_ONLY, title: t.title },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool '${req.params.name}'. Available: ${TOOLS.map((t) => t.name).join(", ")}.` }],
        isError: true,
      };
    }
    try {
      const args = (req.params.arguments || {}) as Record<string, unknown>;
      // Anything a tool writes to the per-colo cache has to outlive this
      // response, and in a Worker only `waitUntil` can promise that.
      setWaitUntil(ctx ? (promise) => ctx.waitUntil(promise) : null);
      const data = await tool.run(args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const message =
        err instanceof UpstreamError
          ? err.message
          : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
      return { content: [{ type: "text", text: message }], isError: true };
    }
  });

  return server;
}
