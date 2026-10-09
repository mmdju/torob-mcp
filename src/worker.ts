// torob-mcp (Cloudflare Workers): stateless Streamable HTTP at /mcp.
// Keyless, so there is nothing to wire per request beyond a fresh Server.
//
// Torob's edge answers some clients with an arCAPTCHA page (HTTP 490) instead
// of JSON, and it scores a client by where the call comes from rather than by
// what it sends. Measured 2026-10-09: from an ordinary connection, five request
// shapes (this server's headers, a full Chrome set, the site's own cookies, and
// no cookies) all answered JSON, as did twelve searches 1.5s apart; from
// Cloudflare's network, three calls in a minute drew a 274KB challenge page.
// A Worker's subrequests also carry Cloudflare's `Cf-Worker` header, which
// names the worker and cannot be stripped. So a hosted copy will be challenged
// from time to time whatever this file does: http.ts turns a 490 into an
// actionable error rather than an empty result, keeps the calls behind it from
// spending requests, and can be pointed at a relay the operator controls with
// the TOROB_API_BASE variable below.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { FONT_BIN } from "./fonts.js";
import { setUpstreamBase } from "./http.js";
import { LANDING, MCP_PAGE } from "./landing.js";
import { OG_IMAGE } from "./og-image.js";
import {
  clientKeyOf,
  type DurableObjectNamespaceLike,
  RATE_LIMIT_WINDOW_MS,
  type RateLimitVerdict,
  rateLimitFor,
  verdictFor,
} from "./rate-limit.js";
import { buildServer, VERSION } from "./server.js";

// This hosted copy answers at most RATE_LIMIT_MAX (rate-limit.ts) /mcp calls a
// minute per client IP, so a script cannot use the public service as an unmetered
// price API. The count lives in the Durable Object below - one per client, so it
// is the same number whatever colo the call arrives in - and the module that
// holds it is imported by this file alone: the server core has no such limit,
// and neither has a self-hosted run.

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

// A caller that can read its own count does not have to guess where the line is.
function withRate(res: Response, verdict: RateLimitVerdict): Response {
  const headers = new Headers(res.headers);
  headers.set("x-ratelimit-limit", String(verdict.limit));
  headers.set("x-ratelimit-remaining", String(verdict.remaining));
  return new Response(res.body, { status: res.status, headers });
}

// 429 with a JSON-RPC error body, so an MCP client sees a reason rather than a
// transport failure it cannot explain. The limit is ours, not Torob's, and the
// message says so: nothing about this is upstream throttling.
function tooManyRequests(verdict: RateLimitVerdict): Response {
  return withCors(
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32029,
          message:
            `Too many requests: this service answers at most ${verdict.limit} /mcp calls a minute per client, ` +
            `and the window resets in ${verdict.retry_after_seconds} second(s). The limit belongs to this hosted ` +
            `copy - a self-hosted run has none.`,
        },
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(verdict.retry_after_seconds),
          "x-ratelimit-limit": String(verdict.limit),
          "x-ratelimit-remaining": "0",
        },
      }
    )
  );
}

// The third argument is the Worker's own ExecutionContext. A tool that learns a
// product shares it through the per-colo cache, and only `waitUntil` keeps that
// write alive after the response has been sent.
interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

// The binding wrangler.toml declares. Optional on purpose: the test suite and a
// deploy without the binding still run, because the limiter falls back to the
// colo cache rather than failing the request it was meant to protect.
interface WorkerEnv {
  RATE_LIMITER?: DurableObjectNamespaceLike;
  /** Optional relay for upstream calls - see setUpstreamBase in http.ts. */
  TOROB_API_BASE?: string;
}

// The parts of a Durable Object this file uses, typed structurally: the project
// deliberately has no Cloudflare types dependency (the Worker builds with the
// same tsconfig as the Node server).
interface RateLimiterStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

// One instance per client IP (`idFromName`), which makes the count exact and
// global where a per-colo cache is neither: measured against the live Worker, a
// fifty-call burst stayed at "19 remaining" on the cache version because the
// calls were spread over two colos. The window is kept in storage, so an
// eviction between two calls cannot hand the caller a fresh window mid-minute.
// It has no timers and no alarms: its entire job is to answer "how many so far".
export class RateLimiter {
  constructor(private readonly state: { storage: RateLimiterStorage }) {}

  async fetch(): Promise<Response> {
    const now = Date.now();
    const bucket = Math.floor(now / RATE_LIMIT_WINDOW_MS);
    const stored = (await this.state.storage.get<{ bucket?: number; count?: number }>("window")) ?? {};
    const used = stored.bucket === bucket ? Math.max(0, Math.round(Number(stored.count) || 0)) : 0;
    const verdict = verdictFor(used, now);
    if (verdict.allowed) await this.state.storage.put("window", { bucket, count: used + 1 });
    return Response.json(verdict);
  }
}

export default {
  async fetch(req: Request, env?: WorkerEnv, ctx?: WorkerContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      setUpstreamBase(env?.TOROB_API_BASE);
    } catch (err) {
      // A misconfigured relay must not look like Torob being down: name it.
      return withCors(
        new Response(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }), {
          status: 500,
          headers: { "content-type": "application/json" },
        })
      );
    }
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (req.method === "POST" && url.pathname === "/mcp") {
      // The limit covers this endpoint only. The landing page, the connect page,
      // the fonts and /health stay free, so a browser is never locked out of the
      // page that explains what happened.
      const verdict = await rateLimitFor(clientKeyOf(req), env?.RATE_LIMITER);
      if (!verdict.allowed) return tooManyRequests(verdict);
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
          return withRate(withCors(new Response(res.body, { status: res.status, headers })), verdict);
        }
        return withRate(withCors(res), verdict);
      } catch (err) {
        // SDK parses the body itself; surface the cause in logs
        // (Workers-safe: no node: imports) and always close both.
        console.error("torob-mcp /mcp error:", err instanceof Error ? err.message : String(err));
        try { await transport.close(); } catch { /* ignore */ }
        try { await server.close(); } catch { /* ignore */ }
        // Every answer to a /mcp POST reports the budget, this one included.
        return withRate(withCors(new Response("Bad request", { status: 400 })), verdict);
      }
    }
    if (req.method === "GET" && url.pathname === "/mcp") {
      // Same page, same CORS as the POST route: a browser client that probes
      // the endpoint with GET has to be able to read the answer.
      return withCors(new Response(MCP_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }));
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
