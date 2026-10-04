# Architecture

How a question becomes an answer. No user data is stored anywhere in this path.

```mermaid
flowchart LR
    subgraph you [Your machine]
        agent[AI agent<br/>Cline / Cursor / Claude]
    end
    subgraph cf [Cloudflare Workers]
        worker[torob-mcp<br/>stateless, no database]
    end
    tr[(Torob public web API<br/>api.torob.com)]

    agent -->|POST /mcp<br/>Streamable HTTP, no key| worker
    worker -->|HTTPS + polite pacing<br/>reads only| tr
    tr -->|large JSON, seller lists| worker
    worker -->|small records<br/>toman, offers, URL| agent
```

What this means:

- **Stateless.** Every request stands alone - no sessions, no accounts, nothing to log in to.
- **Read-only.** All 14 tools carry `readOnlyHint`. Nothing here can change, delete or post anything, and no shop is ever contacted.
- **No storage.** The only memory is a short-lived response cache (minutes, per isolate, with a 12MB byte budget so one 1.4MB details payload cannot fill the isolate) and a small map of product ids this server handed out, so a `prk` can be resolved back to its seller list. A name and details URL learned from a search also travel through the per-colo Cache API, and the filter groups a query advertised are remembered for 30 minutes. Prices are re-read from Torob every time the cache expires.
- **Projected, not passed through.** A Torob search page is roughly 70KB of ranking metadata, experiment ids and ad plumbing. Every tool returns a compact record built by the server's projection layer instead.
- **Rate-limit aware.** Upstream calls are serialized with a gap, retried on transient failures with backoff, and abandoned fast on a hard failure - the MCP client usually times out before a long retry loop finishes. Torob does not throttle with a 429; a caller that goes too fast gets a bot challenge, handled below.
- **Metered on the hosted copy only.** `POST /mcp` on the deployed Worker allows 20 calls a minute per client IP and answers HTTP 429 with a `retry-after` past that, so the public service cannot be driven as an unmetered price API. The limiter is `src/rate-limit.ts`, imported by `src/worker.ts` alone: the server core has no such rule, and a self-hosted run is unlimited. The count lives in a Durable Object, one per client IP, so it is exact and the same in every colo; a per-colo cache stands in only if the binding is ever missing.
- **Challenges are not evaded.** Torob's edge answers some clients with a bot challenge. This server reads the JSON API only and never solves a challenge; a challenged response is reported as a clear, actionable error instead of being parsed into an empty result.

## The two-hop product path

Torob does not expose a product-by-id endpoint. A product id alone is **not** an address upstream - feeding a search result's id back as a search query returns nothing, because the search endpoint matches names, not ids.

What works is the `more_info_url` each search row carries: a ready-made absolute details URL that already contains the `search_id` needed to open the product. So:

1. `search_products` returns cards - each carrying its `details_url` - and remembers each row's details URL against its `prk`.
2. `product_details(prk, details_url)` opens the product with no lookup at all: the URL the caller echoes back carries what the endpoint needs, which is the only path that works on an isolate that never saw the search. It is asked for before anything is remembered (a remembered address can outlive the `search_id` inside it), and a URL that names a **different** product than the `prk` is refused instead of opened - the `prk` is what the question is about, and answering about one product with another's page is a wrong price.
3. Without the URL, the server falls back to what it remembers (in-process map, then the per-colo cache), then to searching by the product's **name** and matching the id again.
4. Last, it tries the details endpoint with the id alone. Whatever answered, `resolved_by` says which path it was - `remembered`, `details-url`, `exact-id`, `name-search` or `id-only` - so a name match is never presented as the exact id.

The seller list - the reason a Torob MCP exists - lives at `products_info.result[]` upstream ("فروشنده‌ها"). It is projected into a first-class `offers[]` array, not flattened into a string. The same response also carries the **in-person** shops (`products_in_store_info`, "فروشگاه‌های حضوری"), the spec tables and the variant tabs, so those reach the caller with no extra upstream request; only their size is capped by the projection.

The price tools are one hop each, keyed by the same `prk`: Torob's chart (`/v4/base-product/price-chart/`, monthly points, two labelled series), its change feed (`/v4/base-product/price-history/`) and the timestamp of its last price update (`/v4/base-product/last-modified-date/`). Each is cached (six hours for the chart, thirty minutes for the others) because a monthly series does not move faster than that. Two upstream families answer about shops rather than products: `/v4/internet-shop/details/` (the shop page's own data) and `/v4/internet-shop/list/` plus `/v4/internet-shop/base-product/list/` for the directory and a shop's catalogue. Image search takes an image URL rather than an upload (`/v4/base-product/search-by-image/`), so nothing a caller sends is stored, and the trending list is read from `/v4/search-trends/` on the same half-hour rhythm as its cache.

## The bot wall, and what the server does about it

Torob's edge answers a client that calls too often with **HTTP 490** and an arCAPTCHA page where the JSON should be. This is not a 429 and not a redirect, and it does not clear on retry.

Two measurements exist. On 2026-09-24 a burst was enough to trip it and the block then cleared after about five idle minutes. Re-measured on 2026-10-03/04 the trigger is far lower - one or two requests following a long idle - and one block took about twenty-seven minutes to clear; a Cloudflare Worker and the dev machine were challenged in the same hour, so no egress is exempt. And it punishes exactly what a naive client does next: retry.

So the server treats a challenge as a cooldown, not a failure to retry:

- The first challenge is reported honestly. It is never retried - solving it is not this server's job, and hammering while it is up is how a temporary block becomes a permanent one.
- It closes a **gate**. The rest of the burst fails immediately with a "retry in N minutes" message and **spends no upstream request at all**, so the traffic that caused the challenge is not extended by the retries behind it.
- The gate is **shared through the store** (`src/store.ts`), not held by one isolate: another isolate in the same colo, or the next run of the local server, reads the same state instead of spending a fresh request to rediscover a wall that is still up.
- Two stages, because the two measurements differ by more than an order of magnitude: five minutes for the first challenge, thirty once a repeat has said the short one was not enough. The probe that discovers the long stage is spent once per stage rather than once per isolate.
- A real answer reopens the gate - only for a call that started after it shut, so a response already in flight cannot undo a fresh challenge.
- Upstream calls are serialized one at a time: a 1.5s gap, and the slot is held until the attempt finishes, so a parallel burst cannot overlap. A challenged response is never cached.

## Reading a response that answers 200

The projection layer exists because a well-formed response can still be wrong in a way that reads as an answer. Four were found and fixed by live testing, not by reading code:

- **A product id is not an address upstream, and not a search term.** Handing a search result's `prk` back as a query returns nothing. The server remembers the details URL it handed out, and shares the product's name through the per-colo Cache API so a *different* isolate can still re-resolve it - but the card's `details_url` is the path that needs no memory at all, and a name match is reported as such rather than passed off as the same id.
- **A filter value is not a filter until upstream accepts it.** Torob ignores a slug or value it does not know and answers *unfiltered*, which reads as a filtered answer. Every search carries the filter groups it really accepts, with the values each takes, and a value outside that list is refused with the real ones.
- **Ids arrive as both numbers and strings.** Province and city ids are numeric; a string-only coercion dropped every row of a perfectly good response, and the tool reported "no provinces exist" while upstream had 30.
- **A field name guessed wrong returns an empty list, not an error.** `title` versus `name` on the location endpoints produced a clean `[]`. Every endpoint's shape was therefore verified against a live response before its tool shipped - and the projection now refuses the case outright: rows that exist and cannot be read raise an error, because only `results: []` means "there is nothing here".

## The local server

Everything above runs in two places. The hosted Worker (`src/worker.ts`) and the Node entry (`src/index.ts`) share `buildServer` and the same fourteen tools; the one difference that matters is **where what a run learns is kept**.

- `src/store.ts` is that place, behind a single interface. On Workers it is the Cache API, which is per-colo - so the colo whose egress Torob challenged carries that fact while another colo is not punished for it. On Node a backend is installed at startup by `src/store-node.ts`.
- The local backend writes `~/.torob-mcp/state.json`. `TOROB_MCP_HOME` moves the directory, `TOROB_MCP_STORE=off` turns the store off. It holds two things: a product's name and details URL, and the marker saying the wall is still up. Writes go through synchronously, because a lost write here is either an extra search or - worse - a fresh request spent rediscovering a wall that has not lifted.
- `src/store-node.ts` is imported by `src/index.ts` alone. The Worker bundles from `src/worker.ts`, so no `node:` import reaches it: `npx wrangler deploy --dry-run` followed by a search of the output for `node:` comes back empty.

```bash
node dist/index.js            # stdio - what an MCP client spawns
node dist/index.js --http     # Streamable HTTP on :3000/mcp
```

Or `npx -y github:mmdju/torob-mcp`, which builds through the `prepare` script on a checkout that has no `dist/` yet.

## The MCPB bundle

`npm run build:mcpb` packages that same Node entry as `build/torob-mcp.mcpb`, the single file an MCPB host installs. The whole design is one sentence: **the bundle contains no second implementation of the MCP server.** It stages `dist/index.js` and the modules that file imports, copies the dependencies that file needs, and lets the host run `node ${__dirname}/dist/index.js` - the entry point `node dist/index.js` has always launched, over the same stdio transport, with `buildServer` and the same fourteen tools behind it. The tools, the projection layer, the Torob integration, the pacing and the bot-wall gate are therefore identical in all three deployments, and a fix to a tool is a fix in all of them.

```mermaid
flowchart TB
    clone[(clone)] --> build["npm run build:mcpb<br/>scripts/build-mcpb.mjs"]
    build --> stage["build/mcpb/ staging<br/>dist/ import closure + production deps"]
    stage --> cli["mcpb validate + pack<br/>@anthropic-ai/mcpb, pinned"]
    cli --> bundle[("build/torob-mcp.mcpb")]
    bundle --> host[MCPB host installs it]
    host --> entry["node dist/index.js<br/>stdio, inside the unpacked bundle"]
    entry --> server["buildServer()<br/>src/server.ts"]
    server --> tools[the 14 tools]
    server --> torob[(Torob public web API)]
```

Three decisions in that script are worth keeping in mind:

- **The bundle is staged, not copied.** `dist/` holds both the Node build and the Worker build, so the script follows the entry point's static relative-import closure and copies only what it reaches. That walk is what excludes `worker.js`, the rate limiter and the landing-page assets - a new import cannot quietly add one back, and an import that does not resolve is a build failure rather than a broken bundle in somebody's host. The dependency tree comes from npm's own `npm ls --omit=dev` answer, minus what npm reports as `extraneous`, because the bundle runs `node` outside any install.
- **The version is written, not maintained twice.** `manifest.json` is the template, and the packed copy takes its `version` from `package.json` - the single version source `tests/version-sync.test.mjs` already holds the server and the changelog to, so a bundle cannot claim a version the project is not on. The tool *names* are not rewritten; they are checked instead, statically against `TOOLS` by `tests/mcpb.test.mjs` and at runtime against the served tool list by `scripts/verify-mcpb.mjs`, because a manifest advertising a tool the server does not have is the failure a host shows the user.
- **The artifact is read back.** The official CLI validates and packs, then the script unpacks what it just wrote and fails on a missing required file, a version mismatch, or a forbidden one - `.env*`, `.dev.vars`, `.git`, keys, certificates, lockfiles, `node_modules/.bin`, or a Worker-only module. The staging list is built from the import graph rather than "everything except a deny-list", so a file that nothing imports cannot reach the bundle in the first place.

The bundle declares **no `user_config`**, no `env` block and no platform overrides, because the server needs no credential: Torob requires none and this server never signs in. The two environment variables a local run honours - `TOROB_MCP_HOME` and `TOROB_MCP_STORE=off` - belong to the host's environment, not to the bundle, and behave exactly as they do for `node dist/index.js`. The 20 calls/minute limit stays where it was, on the hosted Worker, so an MCPB run has no limit of ours; Torob's own pacing and bot wall still apply.

## Verify it yourself

`node scripts/verify-live.mjs` (needs Node.js 18+, nothing to install).

It drives the real endpoint the way an MCP client does. It paces its calls - Torob challenges a burst, so a check that hammers every tool in a second is testing the wrong thing - and reports a challenge as the finding it is **without failing the run**: the wall is upstream's answer to a fast caller, not a broken deployment. Pass a gap in seconds to slow it further: `node scripts/verify-live.mjs 5`, or `node scripts/verify-live.mjs <url> 5` to point it elsewhere.

A red badge on the [Test workflow](../.github/workflows/test.yml) means the code failed its own suite. The scheduled [Live verify](../.github/workflows/verify.yml) badge means the endpoint stopped answering its contract - health, version, landing, handshake, tool list - **or** that Torob renamed something a live check reads, since those checks fail the run too. A challenge is the one live failure that never reddens it.

`node scripts/verify-pack.mjs` is the packaging half of the same idea: it packs the project, installs the tarball into a throwaway project and drives the installed bin through a handshake, so a `files` list that forgot `dist/` fails as a broken package rather than as a silent one. It needs the network and git, so it is run by hand and is not part of `npm test`.

`node scripts/verify-mcpb.mjs` is the bundle's version of that check: it unpacks `build/torob-mcp.mcpb` into an empty directory, launches it exactly as the manifest says, and drives a handshake, a tool list and one real `torob_suggest` call - a bundle can be well formed and still not start. Also run by hand, for the same reason.

[examples/python.py](../examples/python.py) is a copy-paste client for the same endpoint.
