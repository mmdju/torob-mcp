# Torob MCP - Price comparison intelligence for AI agents

![Torob MCP banner](assets/torob-mcp.png)

[![Live verify](https://github.com/mmdju/torob-mcp/actions/workflows/verify.yml/badge.svg)](https://github.com/mmdju/torob-mcp/actions/workflows/verify.yml)
![15 tools](https://img.shields.io/badge/tools-15-blue)
![read-only](https://img.shields.io/badge/access-read--only-brightgreen)
![no API key](https://img.shields.io/badge/API%20key-not%20needed-lightgrey)
![MIT](https://img.shields.io/badge/license-MIT-yellow.svg)

**Real Torob knowledge for AI agents.** Search **Iran's price-comparison engine** from any MCP client (Cline, Cursor, Claude Desktop...): **prices in Toman**, every seller's offer on one product, price history, Torob's own product guides, shop profiles, today's deals. **Read-only, no API key, no login** - and answers measured in kilobytes instead of the ~70KB search page they came from.

**Live endpoint:** `https://torob-mcp.mmdju3.workers.dev/mcp` (Streamable HTTP, stateless) - opening the bare address in a browser shows [the site](https://torob-mcp.mmdju3.workers.dev/). `GET /mcp` gives a browser the connect page and every other client a `405` - the answer the MCP transport asks for, so no client reads the page as a stream that opened and ended.

> [!IMPORTANT]
> **The hosted copy is not the main version - it is a quick-test demo.** It runs on Cloudflare, and Torob challenges some addresses outright, so it is **rate limited (20 `/mcp` calls a minute per client IP)** and **paused from time to time**. For real use, run the main version on your own machine (below): no limit of ours, and its calls come from your own connection. See [Status](#status).

**[نسخه فارسی](README_FA.md)** · **[Examples](examples/sample-calls.md)** · **[Tool reference](docs/tools.md)** · **[Changelog](CHANGELOG.md)**

## Connect in 30 seconds

Any MCP client, **one URL**. Cline / Cursor / Claude Desktop (`mcp.json` style):

```json
{
  "mcpServers": {
    "torob": { "url": "https://torob-mcp.mmdju3.workers.dev/mcp" }
  }
}
```

Then just talk: **"ارزون‌ترین آیفون ۱۳ کجاست؟"**, **"هدفون زیر ۱۰ میلیون"**, **"این گوشی رو کجا بخرم بهتره؟"**, **"چی تخفیف خورده؟"**.

No client at hand? The whole protocol is one POST - a real call:

```bash
curl -sS https://torob-mcp.mmdju3.workers.dev/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_products","arguments":{"query":"هدفون بی سیم","limit":2}}}'
```

And the answer that comes back inside that one message, trimmed to its bones:

```json
{
  "query": "هدفون بی سیم",
  "total_matches": 412,
  "total_matches_note": "Torob's own count is approximate - it changes between identical requests - so page with has_next_page rather than trusting the number.",
  "price_range_toman": { "min": 98000, "max": 2500000 },
  "products": [
    {
      "prk": "prk-a1b2c3d4-0000-4000-8000-000000000001",
      "name_fa": "هدفون بی‌سیم مدل P47",
      "price_toman": 238970,
      "available": true,
      "shop_name": "فروشگاه لوازم دیجیتال",
      "url": "https://torob.com/p/prk-a1b2c3d4-0000-4000-8000-000000000001/",
      "details_url": "https://api.torob.com/v4/base-product/details/?search_id=s1&prk=prk-a1b2c3d4-0000-4000-8000-000000000001"
    },
    {
      "prk": "prk-a1b2c3d4-0000-4000-8000-000000000002",
      "name_fa": "هدفون بلوتوثی مدل P9",
      "price_toman": 410000,
      "available": true,
      "shop_name": "پخش عمومی صوت",
      "url": "https://torob.com/p/prk-a1b2c3d4-0000-4000-8000-000000000002/"
    }
  ],
  "attribution": "Data comes from Torob's public web API. Prices, stock and seller offers change constantly - always confirm on torob.com before buying."
}
```

Agents running in a browser work too - the endpoint answers CORS preflights (`OPTIONS /mcp`).

### Or run it on your own machine

The same fifteen tools as a **local process** - no endpoint of ours, no rate limit of ours. What a run learns goes in `~/.torob-mcp/state.json`: the product names and links it found, and the wall it is waiting out. A restart keeps both; deleting that file starts you over.

One line - the first run is slower because npm builds it, and `git` must be installed, since one dependency (`fa-text-utils`) is fetched from a git repository:

```json
{
  "mcpServers": {
    "torob": { "command": "npx", "args": ["-y", "github:mmdju/torob-mcp"] }
  }
}
```

Or from a clone, if you would rather run code you can read:

```bash
git clone https://github.com/mmdju/torob-mcp.git
cd torob-mcp && npm install      # the prepare script builds dist/
```

```json
{
  "mcpServers": {
    "torob": { "command": "node", "args": ["/path/to/torob-mcp/dist/index.js"] }
  }
}
```
### Using it well

- **All prices are in Toman** (1 Toman = 10 Rial). Prices, stock and shop grades **move constantly** - always link the product URL so the user can confirm before buying.
- **A search card is one price - the cheapest offer.** `product_details` is the call that lists every seller, and its `price_spread_toman` is the whole reason a price-comparison source exists. It also returns the shops that sell **in person**, with each shelf price's age - so say how old it is.
- **A seller's `url` is the shop's page on torob.com.** The buy button's link is a tracked `api.torob.com` redirect that travels separately as `buy_url` - keep `url` in the answer, reach for `buy_url` only when the user is about to click through.
- **`price_history` is the honesty check on a price.** Compare today's cheapest offer with what Torob charts; the series labels are Torob's own, so quote them rather than inventing a trend.
- **`price_toman: null` means not available**, never 0 - and **0 is never free**: Torob's own "not for sale" comes back as `available: false`. **`price_unreliable: true`** is Torob saying the price cannot be trusted: pass the warning on, do not present it as a bargain.
- **A shop grade needs its vote count.** `shop_score: 5` with `shop_votes: 0` is normal and means "no votes yet", not "five-star shop".
- **An empty result is not proof a product does not exist.** The response carries `query_note` and Torob's own `suggested_queries` - retry with one of those instead of telling the user it is unavailable.
- **An unknown filter slug or value is refused with the real ones** (`available_filters` carries every group's accepted values). Torob ignores what it does not know and answers **unfiltered**, which is exactly why this server refuses first.
- **Torob answers a client that calls too fast with a bot challenge instead of data.** The server reports it plainly, never solves or evades it, and holds the rest of a burst for the whole cooldown. Details in [SECURITY.md](SECURITY.md).
- Results are **capped** (default 10, each tool's own maximum in [docs/tools.md](docs/tools.md)) to protect agent context, and Persian wording is folded (Arabic yeh/kaf, mixed digits, ZWNJ) when names are compared - the query reaches Torob exactly as typed.
- **[examples/sample-calls.md](examples/sample-calls.md)** has eleven copy-paste flows, **[docs/tools.md](docs/tools.md)** every parameter and filter slug, and **[docs/card.d.ts](docs/card.d.ts)** the response types.

## The MCPB bundle

The local server as **one file**. **MCP** is the protocol an agent and a server speak. **MCPB** is the package that server arrives in - the single file a host installs to get a local MCP server with no build step, no `git`, and no `node_modules` of its own to assemble. The format and the extension were both renamed from DXT; this repository ships `.mcpb`.

### Two ways to reach the same fourteen tools

MCPB is the **local** route. It does not replace the hosted deployment, and nothing below changes it.

```mermaid
flowchart LR
    subgraph local [MCPB - on your machine]
        host[MCPB host] -->|installs the bundle| b[torob-mcp.mcpb]
        b -->|node, stdio| srv[dist/index.js<br/>the local MCP server]
        srv --> t14[the same 14 tools]
    end
    subgraph remote [Hosted - unchanged]
        agent[AI agent] -->|POST /mcp<br/>Streamable HTTP, no key| worker[torob-mcp<br/>Cloudflare Worker]
    end
    t14 --> tr[(Torob public web API)]
    worker --> tr
```

- **Remote** - one URL, no install, shared infrastructure, and the 20 calls/minute limit described under [Status](#status).
- **MCPB** - no endpoint of ours in the loop and no limit of ours. Torob's own pacing and bot wall still apply, because the calls are still Torob's.

### Build and install

```bash
git clone https://github.com/mmdju/torob-mcp.git
cd torob-mcp
npm ci               # or npm install - the prepare script builds dist/
npm run build:mcpb   # -> build/torob-mcp.mcpb
```

`build/torob-mcp.mcpb` is the artifact. A host that speaks MCPB installs it through its own bundle import - point it at that file - and then runs it as the manifest says. There is no registry entry, no update channel and no prebuilt file published from this repository: **you build it**, so what you install is the code in the clone you can read.

To look inside before installing anything:

```bash
npx mcpb info build/torob-mcp.mcpb
# File: torob-mcp.mcpb
# Size: 4031.82 KB
# WARNING: Not signed
```

It is **not signed**, and nothing here pretends otherwise: the build does not sign, `mcpb sign` needs a key this project does not have, and a host that requires a signature will refuse the bundle.

### What the build actually does

`npm run build:mcpb` runs `tsc` and then `node scripts/build-mcpb.mjs`. The script:

1. **Stages `build/mcpb/` from scratch**, so a file deleted from the source cannot survive in a bundle.
2. **Walks the entry point's imports.** It starts at `dist/index.js` and follows static relative imports, copying each module it reaches - eleven of them. `dist/` holds both builds, the Node one and the Worker one, so this walk is what keeps `worker.js`, `rate-limit.js`, `og-image.js` and `fonts.js` out; an import that cannot be resolved is a build failure, not a broken bundle in somebody's host.
3. **Copies the production dependency tree** out of the `node_modules` npm already produced, using npm's own answer to "what does this package need at runtime" (`npm ls --omit=dev`) and skipping what npm reports as `extraneous`. The bundle runs `node` outside any install, so it has to carry them.
4. **Writes two files of its own**: a minimal `package.json` - `"type": "module"` is not optional, since `dist/*.js` are ES modules and Node would otherwise read the entry as CommonJS and fail on its first import - and the manifest with its `version` taken from `package.json`. `.mcpbignore` travels with the staging folder.
5. **Hands the folder to the official CLI.** `@anthropic-ai/mcpb` is pinned to an exact version as a devDependency and resolved out of `node_modules`, so the artifact never depends on what a machine happens to have installed globally. The CLI validates (`mcpb validate`) and packs (`mcpb pack`).
6. **Reads the archive back.** It unpacks what it just wrote (`mcpb unpack`) and then checks that every required file is there - `manifest.json`, `package.json`, the entry, `dist/server.js`, `dist/tools.js`, `dist/project.js`, and both runtime dependencies - that the manifest's version equals `package.json`'s, and that nothing forbidden came along: `.env*`, `.dev.vars`, `.git`, `node_modules/.bin`, `tsconfig.json`, `package-lock.json`, `*.pem`, `*.key`, `*.mcpb`, `*.tgz`, `*.log`, `*.map`, or one of the Worker-only modules. Any of those fails the build rather than shipping.

It needs a `node_modules` that already exists. It installs nothing itself, uses no network, and calls no git. Result: about 12MB unpacked, under 4MB packed, nearly all of it the MCP SDK and its dependencies. `build/` is gitignored - the bundle is an artifact, not a source file.

### What is in the bundle

```text
build/torob-mcp.mcpb
├── manifest.json        name, version, description, compatibility, the 14 tool names
├── package.json         minimal: type: module, plus the runtime dependency list
├── dist/                the eleven modules dist/index.js imports
│   ├── index.js         the local entry point - stdio by default, --http optional
│   ├── server.js        buildServer() - the code the Worker runs too
│   ├── tools.js         the fourteen tools
│   ├── project.js       the projection layer
│   └── …
└── node_modules/        the production dependency tree (95 packages)
```

Deliberately absent: `src/`, `tests/`, `scripts/`, `docs/`, `landing/`, `assets/`, `.github/`, `.wrangler/`, the Worker build, `.env*`, keys, certificates, lockfiles and `node_modules/.bin`. On top of that the CLI drops `.git`, `*.d.ts` and source maps itself, and `.mcpbignore` is a second line of defence - written out even though the staging list already excludes those paths, so that a change to the staging code cannot ship a secret by accident and so that `mcpb pack .` in a clone is safe too.

### It is the same server, not a second one

This is the decision worth knowing: **the bundle contains no second implementation of anything.** It launches `dist/index.js` - the entry point `node dist/index.js` has always launched - over stdio, with `${__dirname}` resolved to wherever the host unpacked it.

```text
                MCPB
                  │
                  ▼
        ${__dirname}/dist/index.js
                  │
                  ▼
       buildServer()  ← src/server.ts, shared with the Worker
                  │
          ┌───────┴───────┐
          ▼               ▼
    the 14 tools     Torob public web API
```

So the tools, the projection layer, the Torob integration, the pacing and the bot-wall gate are all the same code in every deployment. Local, MCPB and hosted cannot drift apart, because there is only one copy of the logic - and a fix for a tool is a fix everywhere, with no bundle to rebuild by hand.

The manifest's `server` block is the whole of it:

```json
{
  "type": "node",
  "entry_point": "dist/index.js",
  "mcp_config": { "command": "node", "args": ["${__dirname}/dist/index.js"] }
}
```

### Configuration: there is none

The manifest declares **no `user_config`**, and an MCPB host will not prompt you for anything. That is the correct state, not an omission: Torob needs no key, this server never signs in, and a prompt would be asking for a credential that has no use. The manifest also carries no `env` block, no `platform_overrides`, and no secrets.

Two environment variables remain optional, and both already existed for a local run - they belong to the host's environment, not to the bundle:

| Variable | Default | What it does |
|---|---|---|
| `TOROB_MCP_HOME` | `~/.torob-mcp` | Where the local store keeps `state.json` |
| `TOROB_MCP_STORE=off` | store on | Turns the store off |

The store holds two things: a product's name and details URL, and the marker saying Torob's wall is still up. Deleting the file resets the server completely.

### Verify it

```bash
npm test                        # the suite, including the MCPB manifest gates
npm run typecheck               # tsc --noEmit
npm run build:mcpb              # build, pack, then re-read the archive
node scripts/verify-mcpb.mjs    # launch the packed bundle for real
```

- **`npm test`** runs `tests/mcpb.test.mjs` next to everything else: the manifest is validated against the schema the pinned CLI ships - not a copy of it - its version is held to `package.json`, its entry point and `mcp_config` are checked against the file the local server actually launches, its declared tool names must equal `TOOLS`, and no `user_config`, `env` block, absolute path or developer-machine path is allowed in it.
- **`npm run build:mcpb`** also runs on every push in CI ([![Test](https://github.com/mmdju/torob-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/mmdju/torob-mcp/actions/workflows/test.yml)), since the suite above checks the manifest and only the build checks the artifact.
- **`node scripts/verify-mcpb.mjs`** is the one that proves the artifact *runs*. It unpacks the bundle into an empty directory outside the repository, launches it exactly as `mcp_config` says, completes an `initialize` handshake, checks the version the server reports against the manifest, lists the tools and compares them with the declared names, then makes one real read-only call - `torob_suggest`, the cheapest one there is - against Torob. A bot challenge is reported as the finding it is instead of failing the run. It needs the network, so it is run by hand.

### Security notes for the bundle

- **It runs as you.** A host launches a real `node` process; whatever the server does, it does with your permissions and your network access. A bundle is a distribution format, not a sandbox.
- **It carries no credentials**, because there are none to carry - no key, no account, no token, and no `.env` for a host to fill in. If this server ever needed one, the honest place for it would be an MCPB `user_config` prompt, not a file in the archive.
- **The build refuses to ship a secret.** The staging list is built from the import graph and npm's own production tree, never from "everything except a deny-list", and the packed archive is read back for `.env*`, `.dev.vars`, keys, certificates and repository metadata before the build is allowed to pass.
- **It is the same read-only server.** All 14 tools keep `readOnlyHint`; nothing can order, message or contact a shop. Torob's bot wall is still reported rather than solved, and the 20/minute limit stays where it was - on the hosted Worker only, so an MCPB run has no limit of ours.
- **The bundle is unsigned**, as `mcpb info` says. Verify it the way this repository verifies it: build it from a clone you can read, then run `node scripts/verify-mcpb.mjs`.

## How it works

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

- **Stateless.** Every request stands alone - no sessions, no accounts, nothing to log in to.
- **Read-only.** All 15 tools carry `readOnlyHint`. Nothing can change, delete or order anything.
- **Projected, not passed through.** A Torob search page is roughly 70KB of ranking metadata and experiment plumbing; every tool returns a compact record instead, with the seller list as a first-class `offers[]` array.
- **No user data.** What the server does keep: a short-lived response cache and a small map of product ids it handed out.
- **Rate-aware by necessity.** Upstream calls run one at a time with a 1.5s gap, and a challenge closes a gate the whole server shares instead of opening a retry storm.
- **Undocumented upstream.** Torob's API can change without notice, which is exactly why the [verify script](scripts/verify-live.mjs) exists.

## Trust, verified

Don't take my word for it - check the live server yourself:

```bash
node scripts/verify-live.mjs   # needs Node.js 18+, nothing to install
```

It drives the real endpoint the way an MCP client does and compares the version the live service reports against the newest release here, so a deployment that lags these docs cannot stay quiet. The same script runs **hourly in CI** ([![Live verify](https://github.com/mmdju/torob-mcp/actions/workflows/verify.yml/badge.svg)](https://github.com/mmdju/torob-mcp/actions/workflows/verify.yml)); a **bot challenge is reported without failing the run**, because it is upstream's answer to a fast caller rather than a broken deploy. The unit suite - the badge that means the *code* is healthy - runs on every push ([![Test](https://github.com/mmdju/torob-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/mmdju/torob-mcp/actions/workflows/test.yml)). Full path, including why a product id is not an address upstream: [docs/architecture.md](docs/architecture.md). Copy-paste client: [examples/python.py](examples/python.py).

## Run it yourself

```bash
npm install      # two runtime dependencies: the MCP SDK and a small Persian text helper
npm test         # builds, then runs every test in the repo
npm run build:mcpb  # packs the local server as one build/torob-mcp.mcpb
npm run dev      # the same Worker the live service runs, on your machine
npm run probe    # re-checks every upstream endpoint this server reads
```

Nothing to configure: no account, no key, no database, no bindings. `npm run build && npx wrangler deploy` puts your own copy on your own Cloudflare account.

## Status

**There are two versions, and the one to use is the one on your machine.**

- **The main version** is this repository, run by you: `npx -y github:mmdju/torob-mcp`, or a clone plus `node dist/index.js`. It has **no limit of ours**, and its calls come from your own connection.
- **A quick-test copy** is hosted for a first look at `https://torob-mcp.mmdju3.workers.dev/mcp` - free, read-only, keyless, **at most 20 `/mcp` calls a minute per client IP** (HTTP 429 with `retry-after` past that), and **Torob pauses it from time to time**. Both stops say so in their own text and name the main version, so nobody is left thinking the tools are broken.

Why it gets paused: Torob answers some addresses with a challenge page instead of data, and **what it judges is the address, not what a client sends** (measured 2026-10-09: every request shape answered from one connection, while a Cloudflare Worker drew the challenge page on its third call of the minute - a Worker's subrequests carry Cloudflare's `Cf-Worker` header, which cannot be removed). An address can also be blocked outright with nothing wrong at all (measured 2026-10-12: one request answered in full, the next 40 seconds later challenged, still challenged after five idle minutes) - so **some addresses are simply refused, and no header or setting here fixes that**. If your own copy keeps being challenged, the only thing you can change is where the calls come from: run it locally, or point `TOROB_API_BASE` at a relay you control (every upstream call, and every `details_url` it hands out, goes through that base) - worth trying, not a guarantee. The measurements are in the [changelog](CHANGELOG.md), the behaviour in [SECURITY.md](SECURITY.md).

## Data source

Torob's public web API (**undocumented, may change without notice**). This project is **not affiliated with or endorsed by Torob**.

## License

MIT - see [LICENSE](LICENSE). Security notes in [SECURITY.md](SECURITY.md). Persian version in [README_FA.md](README_FA.md).

*If this is useful, a star helps other builders find it.*
