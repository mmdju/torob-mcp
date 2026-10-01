// torob-mcp (Cloudflare Workers): stateless Streamable HTTP at /mcp.
// Keyless, so there is nothing to wire per request beyond a fresh Server.
//
// Torob's edge answers some clients with an arCAPTCHA page (HTTP 490) instead
// of JSON. A Worker's own egress is not challenged - measured with 8 sequential
// live searches, all 200 - so a 490 reaching this file means something changed
// upstream and http.ts turns it into an actionable error rather than an empty
// result.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { FONT_BIN } from "./fonts.js";
import { LANDING, MCP_PAGE } from "./landing.js";
import { OG_IMAGE } from "./og-image.js";
import { buildServer, VERSION } from "./server.js";

// Parity with index.ts: browser MCP clients need CORS, and the endpoint is
// keyless read-only, so a permissive allow-origin leaks nothing.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version, authorization",
  "Access-Control-Max-Age": "86400",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

// The third argument is the Worker's own ExecutionContext. A tool that learns a
// product shares it through the per-colo cache, and only `waitUntil` keeps that
// write alive after the response has been sent.
interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async fetch(req: Request, _env?: unknown, ctx?: WorkerContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (req.method === "POST" && url.pathname === "/mcp") {
      const server = buildServer(ctx);
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await server.connect(transport);
        const res = await transport.handleRequest(req);
        // Plain text/event-stream decodes as latin-1 in naive clients
        // (PowerShell included) - the charset keeps Persian titles intact.
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("text/event-stream") && !ct.includes("charset")) {
          const headers = new Headers(res.headers);
          headers.set("content-type", `${ct}; charset=utf-8`);
          return withCors(new Response(res.body, { status: res.status, headers }));
        }
        return withCors(res);
      } catch (err) {
        // SDK parses the body itself; surface the cause in logs
        // (Workers-safe: no node: imports) and always close both.
        console.error("torob-mcp /mcp error:", err instanceof Error ? err.message : String(err));
        try { await transport.close(); } catch { /* ignore */ }
        try { await server.close(); } catch { /* ignore */ }
        return withCors(new Response("Bad request", { status: 400 }));
      }
    }
    if (req.method === "GET" && url.pathname === "/mcp") {
      return new Response(MCP_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (req.method === "GET" && url.pathname === "/health") {
      // The version is part of health on purpose: the docs advertise the
      // version the CHANGELOG names, so a deployment that lags the repo must
      // be visible to a single curl instead of only to an MCP initialize
      // handshake.
      return withCors(Response.json({ ok: true, service: "torob-mcp", version: VERSION }));
    }
    if (req.method === "GET" && url.pathname === "/og.png") {
      return withCors(
        // .buffer is a plain ArrayBuffer over the decoded bytes; the cast
        // goes through unknown because newer TS versions no longer treat a
        // Uint8Array's backing buffer as assignable.
        new Response(OG_IMAGE.buffer as unknown as ArrayBuffer, {
          headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
        })
      );
    }
    // The landing page's own text face, so the site looks the same on a device
    // that has no Persian font installed.
    const font = url.pathname.match(/^\/doran-(\d{3})\.woff2$/);
    if (req.method === "GET" && font && FONT_BIN[Number(font[1])]) {
      return withCors(
        new Response(FONT_BIN[Number(font[1])].buffer as unknown as ArrayBuffer, {
          headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" },
        })
      );
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return new Response(LANDING, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
      });
    }
    return withCors(new Response("Not found. POST /mcp for MCP.", { status: 404 }));
  },
};
