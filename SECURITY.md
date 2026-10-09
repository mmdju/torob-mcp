# Security Policy

Torob MCP is a read-only public service. There is nothing to log in to and no user data is stored.

- All 15 tools are read-only. No tool can change, delete or publish anything, and no shop is ever contacted.
- No API keys are needed to use the hosted endpoint.
- The server never signs in to Torob and never solves or evades a bot challenge - a challenge is reported as a clear, actionable error instead.
- Nothing about a caller is stored: no accounts, no request logs, no query history. The state the server does keep, and why: a short-lived response cache plus a map of product ids it handed out (both scoped to a single isolate); a per-colo cache holding a product's name and details URL for 24 hours and a query's filter groups for 30 minutes, so a second isolate does not pay for a lookup the first one made; and the rate limiter's per-client-IP counter in a Durable Object (below).
- **A local run also writes to your own disk**: `~/.torob-mcp/state.json` holds the same two things the per-colo cache holds - a product's name and its details URL - plus the marker saying Torob's wall is still up, so a restart does not spend a request finding that out again. No account, no credential, no query history, nothing about anyone else. `TOROB_MCP_HOME` moves it and `TOROB_MCP_STORE=off` stops it; deleting the file resets the server completely.
- Data comes from Torob's public web API, which is undocumented and can change without notice. This project is not affiliated with or endorsed by Torob.

## The Bot Challenge

Torob does not throttle with an HTTP 429. It answers a client that calls too often with **HTTP 490** and a captcha page where the JSON should be - and a challenge that wears a 200 status code is caught the same way, by content type.

This server treats a challenge as a cooldown, not a failure to retry:

- The first challenge is reported honestly and is **never retried**.
- It closes a **gate**. The rest of a burst fails immediately with a "retry in N minutes" message and spends **no upstream request at all**, so the traffic that caused the challenge is not extended by the retries behind it.
- The gate is shared through the store (`src/store.ts`): another isolate in the same colo, or the next run of the local server, reads the same state instead of spending a fresh request rediscovering a wall that is still up.
- The first stage is five minutes; a repeat challenge earns thirty. Measured 2026-10-04, a block took about twenty-seven minutes to clear, so the probe is spent once per stage rather than once per isolate. A real answer reopens the gate.
- Upstream calls are serialized with a 1.5s gap, and a challenged response is never cached.

**What the challenge is made on, measured 2026-10-09: the connection, not the request.** From an ordinary connection, five request shapes were all answered - the headers this server ships, a full Chrome header set, the site's own cookies, and no cookies at all - and so were twelve searches 1.5s apart. From Cloudflare's network the same calls were challenged on the third of the minute. A Worker's subrequests also carry Cloudflare's own `Cf-Worker` header, naming the worker, and a header of that name set in the fetch options does not replace it. Nothing here hides that, and nothing should: a hosted copy simply is a datacenter client, and Torob is entitled to score it that way.

**If that keeps happening to your deployment:** run the server yourself (`npx -y github:mmdju/torob-mcp`, where the calls come from your own connection), or set the `TOROB_API_BASE` variable to a relay you control - every upstream call, and every `details_url` the server hands to a caller, is built on that base. Two rules come with it, both enforced in `src/http.ts`: the value must be an **absolute https URL** (a plain-http relay would put every query, price and product id on the wire in the clear), and an unusable value **stops the server with the reason** instead of quietly falling back to Torob. The relay sees every query this server makes - it is your relay, and it should be as trusted as the code here.

## Rate Limiting

The hosted copy at `torob-mcp.mmdju3.workers.dev` answers at most **20 `POST /mcp` calls a minute per client IP**. Over the limit it returns **HTTP 429** with a JSON-RPC error body, a `retry-after` header and `x-ratelimit-limit` / `x-ratelimit-remaining`, so a client can see where it stands instead of guessing.

Twenty a minute is far above a real conversation: the fifteen tools take fifteen calls, plus the product and shop lookups a conversation leads to, which still lands inside the window. It is low enough that a script cannot use this service as an unmetered price API. The count is kept in a **Durable Object**, one per client IP, so it is exact and the same in every colo instead of being tracked separately by each - a weaker per-colo cache only stands in if that binding is ever missing, which can never fail the request it protects. Only `/mcp` is limited: the landing page, the connect page, the fonts and `/health` keep answering, so a browser is never locked out of the page that explains the limit.

**A self-hosted run has no limit.** The limiter lives in `src/rate-limit.ts` and is imported by `src/worker.ts` alone; the server core and the Node entry point do not know it exists.

What bounds the upstream load is the pacing and the gate above. A burst of parallel tool calls will not produce a burst of upstream requests - it will produce one request, a reported challenge, and then fast local refusals for the rest of that window, from whichever isolate or run hears about the challenge first.

## CORS

The endpoint is **keyless and read-only**, so it sends `Access-Control-Allow-Origin: *` and answers `OPTIONS` preflights. There are no cookies or credentials to leak; browser-based MCP clients (Inspector, web agents) need this to connect at all.

## Input handling

- Every tool **advertises** a closed schema (`additionalProperties: false`, added when the tool list is served), which is what tells a client what is accepted. The server itself coerces every argument rather than trusting its type, and validates the ones where a wrong value would silently change an answer: filter slugs and values against the groups that search really accepts, price bounds against each other, pages and limits clamped, URLs parsed rather than followed. An unknown property is ignored, not acted on.
- All arguments are coerced from unknown input, never trusted.
- Result lists are capped so a single call cannot ask for an unbounded upstream crawl.
- Upstream URLs are built from validated parameters, and the details URL is followed as returned by Torob rather than assembled from user input, so no caller-supplied string is ever used to redirect the fetch.

## Reporting a Vulnerability

Please do NOT open a public issue. Report privately via the
[Security tab](../../security/advisories/new)
(Advisories → Report a vulnerability).
