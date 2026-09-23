// Shared MCP server factory: used by index.ts (Node transports) and
// worker.ts (Workers). No node: imports here - must stay portable.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { UpstreamError } from "./http.js";
import { READ_ONLY, TOOLS } from "./tools.js";

export const VERSION = "0.1.0";

// Server-level guidance: cheaper than repeating it in every tool description,
// and it steers the agent before it picks a tool at all. It is the first thing
// an agent reads, so it has to name every tool AND stay true.
// tests/agent-surface.test.mjs gates both.
export const INSTRUCTIONS = [
  "Torob (Iran's price-comparison engine) price intelligence. Read-only, no API key needed.",
  "All prices are in Toman.",
  "Pick the entry point: torob_suggest when the wording is vague, search_products to browse, " +
  "product_details for one product's seller list, compare_products to put 2-5 products side by side, " +
  "find_best_value for any question with a budget or the word 'best'.",
  "A search card carries the CHEAPEST offer only, not every seller. To answer 'who sells this' or " +
  "'is that shop reliable' call product_details - that is where the full seller list, shop scores and " +
  "vote counts live.",
  "price_toman 0, or available false, means out of stock - never free. An offer flagged price_unreliable " +
  "is Torob's own warning about that number; say so instead of treating it as a bargain.",
  "An empty result is not proof a product does not exist - the wording may simply be wrong. When a search " +
  "returns nothing, call torob_suggest and retry with what it suggests.",
  "Torob pages are paginated (page 1-based, max 50) and deep pages cost an extra upstream request.",
  "Prices and stock move constantly: always keep the product URL in the answer so the user can confirm " +
  "on torob.com before buying.",
  "This server never logs in, never solves bot challenges, and never contacts a shop. It reads the public " +
  "web API only.",
].join(" ");

export function buildServer(): Server {
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
