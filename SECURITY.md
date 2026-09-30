# Security Policy

Torob MCP is a read-only public service. There is nothing to log in to and no user data is stored.

- All 9 tools are read-only. No tool can change, delete or publish anything, and no shop is ever contacted.
- No API keys are needed to use the hosted endpoint.
- The server never signs in to Torob and never solves or evades a bot challenge - a challenge is reported as a clear, actionable error instead.
- Nothing is persisted server-side. The only state is a short-lived response cache and a small map of product ids the server handed out, both scoped to a single isolate.
- Data comes from Torob's public web API, which is undocumented and can change without notice. This project is not affiliated with or endorsed by Torob.

## The Bot Challenge

Torob does not throttle with an HTTP 429. It answers a client that calls too often with **HTTP 490** and a captcha page where the JSON should be - and a challenge that wears a 200 status code is caught the same way, by content type.

This server treats a challenge as a cooldown, not a failure to retry:

- The first challenge is reported honestly and is **never retried**.
- It opens a **circuit breaker** for that isolate. The rest of a burst fails immediately with a "retry in N minutes" message and spends **no upstream request at all**, so the traffic that caused the challenge is not extended by the retries behind it.
- The breaker expires on its own after five minutes; a fresh isolate gets a clean chance.
- Upstream calls are serialized with a 1.5s gap, and a challenged response is never cached.

## Rate Limiting

There is **no per-IP rate limit on `/mcp`**. The endpoint is keyless and read-only, and the pacing this server applies is to **Torob**, not to callers: a normal agent session asking one question every few seconds is never throttled here.

What bounds the load is the upstream gap and the circuit breaker above. A burst of parallel tool calls will not produce a burst of upstream requests - it will produce one request, a reported challenge, and then fast local refusals for the rest of that window.

## CORS

The endpoint is **keyless and read-only**, so it sends `Access-Control-Allow-Origin: *` and answers `OPTIONS` preflights. There are no cookies or credentials to leak; browser-based MCP clients (Inspector, web agents) need this to connect at all.

## Input handling

- Every argument is validated against a closed schema (`additionalProperties: false`).
- All arguments are coerced from unknown input, never trusted.
- Result lists are capped so a single call cannot ask for an unbounded upstream crawl.
- Upstream URLs are built from validated parameters, and the details URL is followed as returned by Torob rather than assembled from user input, so no caller-supplied string is ever used to redirect the fetch.

## Reporting a Vulnerability

Please do NOT open a public issue. Report privately via the
[Security tab](../../security/advisories/new)
(Advisories → Report a vulnerability).
