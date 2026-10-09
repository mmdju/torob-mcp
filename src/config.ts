// Endpoints, pacing and cache lifetimes. Everything here was verified against
// the live API from a deployed worker with scripts/probe-api.mjs.

import { HOUR, MIN } from "./cache.js";

export const PORT = 3000;

export const TOROB_API = "https://api.torob.com";
export const TOROB_SITE = "https://torob.com";

// A real desktop Chrome UA, matching the web client. Torob identifies clients
// by this header, so a bare node-fetch shape gets a different answer.
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// The web client tags every API call with the surface it came from. The API
// accepts calls without it, but sending the real value keeps us on the same
// path the browser uses.
export const SOURCE = "next_desktop";

// Cap for inbound MCP-over-HTTP bodies. 1MB is ~60x a normal tools/call
// payload; anything bigger is a mistake or an attack.
export const MAX_BODY_BYTES = 1_000_000;

// Torob answers a challenged client with HTTP 490 and an arCAPTCHA page rather
// than JSON - not a 429, and not a redirect. The gap below just keeps us
// from inviting one; a 490 is turned into an actionable error, never a retry
// storm, because a challenge does not solve itself.
export const MAX_RETRIES = 3;
export const RETRY_DELAY_MS = 2000;

// One upstream request may hang at most this long, so a dead connection cannot
// hold a tool call open until the platform's own timeout.
export const FETCH_TIMEOUT_MS = 15_000;

// Torob's own ranking already reflects what the search was for. The tool-facing
// names are stable; SORT_PARAMS is what upstream actually accepts, read off the
// live `sort` filter group ("", price, -price, -date, -supply).
export const SORTS = ["popularity", "price", "expensive", "newest", "sellers"] as const;
export type Sort = (typeof SORTS)[number];

export const SORT_PARAMS: Record<Sort, string> = {
  popularity: "",
  price: "price",
  expensive: "-price",
  newest: "-date",
  sellers: "-supply",
};

// shop_type narrows results to sellers shipping online vs having a physical
// branch. Anything else upstream is ignored silently, so it is not offered.
export const SHOP_TYPES = ["offline", "online"] as const;
export type ShopType = (typeof SHOP_TYPES)[number];

// The shop directories (find_shops, shop_profile's catalogue) page 0-based
// upstream. The public tools stay 1-based like every other pager here.
export const SHOP_PAGE_MAX = 20;

// Torob accepts an arbitrary query string on the search endpoint and advertises
// a different filter surface per query (measured: 30 groups on "phone" -
// price, brand, storage, ram, screen_size, battery, network, sim_card,
// rom_country, register_status, active_status, stock_status, shop_type,
// available, torobpay, sort, category, q - and the same response binds each
// group to its values). A hard-coded list cannot keep up with that: it refused
// filters Torob genuinely applies (storage=1 tb narrows ~1200 results to 17).
// Filters are therefore validated against the search's own response - see
// project.ts (filter groups + memory) and tools.ts (validation).

// The gap between upstream calls, and the floor under it - not the trigger.
// Measured 2026-10-04: after a long idle exactly one call answered, and the
// next one 45-113 seconds later was challenged, so no gap this side of minutes
// buys safety on its own. The number here keeps concurrent tool calls from
// stacking up; the gate in http.ts is what stops a wall from being probed.
export const MIN_GAP_MS = 1500;

// Lifetimes are set against the wall above, not against freshness alone.
// Measured 2026-10-04: after a long idle Torob answers exactly one call and
// challenges the next, and a block takes about half an hour to clear. A cache
// that expires in eight minutes holds nothing through a block - every question
// the user repeats becomes a fresh upstream request, and the second one is
// walled. These numbers buy the repeats inside one window while keeping a price
// at most half an hour old, which is the bound the attribution note states.
export const TTL = {
  suggest: 6 * HOUR, // autocomplete vocabulary barely moves
  search: 30 * MIN, // long enough to outlive a block, short enough to stay honest
  product: 20 * MIN, // seller offers and stock are the volatile part
  category: 30 * MIN,
  similar: 30 * MIN,
  locations: 24 * HOUR, // province/city lists are administrative facts
  offers: 30 * MIN,
  // The chart is monthly, so an hourly refresh is already finer than the data.
  chart: 6 * HOUR,
  changes: 30 * MIN, // "۸ ساعت پیش" is the unit here, so half an hour is enough
  freshness: 30 * MIN,
  shop: 6 * HOUR, // a shop's profile changes slowly (seal, address, hours)
  shopProducts: 30 * MIN, // a catalogue's prices move like the market's
  shops: 60 * MIN, // the directory of businesses barely moves inside an hour
  trends: 60 * MIN, // what shoppers search shifts over hours, not minutes
  image: 30 * MIN,
  // The guide is an article that changes when Torob rewrites it, not a price:
  // six hours matches the chart and keeps a one-call tool cheap to repeat.
  guide: 6 * HOUR,
};

export const ATTRIBUTION =
  "Data comes from Torob's public web API. Prices, stock and seller offers change " +
  "constantly, and an answer may be served from what this server fetched up to half " +
  "an hour ago - always confirm on torob.com before buying. This server is not " +
  "affiliated with or endorsed by Torob.";

// The wall is not a rate limit and cannot be retried through: it is an
// anti-bot challenge. Say so plainly instead of returning an empty list that
// an agent would read as "no such product". Measured: it clears on its own
// after a stretch with no calls at all - five idle minutes in September, about
// twenty-seven in October - so the message says that rather than telling the
// caller to give up, and the gate in http.ts keeps the calls behind the first
// challenge from hammering while it waits.
//
// Measured 2026-10-09: what decides a challenge is where the call comes from, not
// what it carries. From an ordinary connection every request shape was answered
// (this server's headers, a full Chrome set, the site's own cookies, and none),
// and twelve searches 1.5s apart were all answered; from Cloudflare's network
// three calls in a minute drew the 490, and a Worker's subrequests carry
// Cloudflare's own `Cf-Worker` header, which cannot be stripped. That is why the
// message names the egress and points at the two real ways out: run the server
// yourself, or send it through a relay (TOROB_API_BASE).
export const CHALLENGED_MSG =
  "Torob answered with a bot challenge (HTTP 490) instead of data, because its edge judged " +
  "this client a bot. This is not a rate limit and an immediate retry will not clear it - " +
  "it clears after a stretch with no calls at all, measured anywhere from a few minutes to " +
  "half an hour. Wait, then retry the same call; or ask the user to search on torob.com and " +
  "share the product URL. What decides it is where the call comes from rather than what it " +
  "sends: measured 2026-10-09, an ordinary connection answered every request shape and twelve " +
  "searches 1.5s apart, while a Cloudflare Worker was challenged on its third call of the " +
  "minute - a Worker's subrequests carry Cloudflare's `Cf-Worker` header, which cannot be " +
  "removed. To stop seeing this: run this server yourself (npx -y github:mmdju/torob-mcp), or " +
  "set TOROB_API_BASE to a relay on a connection Torob does not score as a bot.";

// Torob reports a shop score for essentially every offer but almost never
// reports the vote count behind it (measured: 30 of 30 offers had
// shop_score 5 and shop_votes_count 0 on a live product). A vote floor would
// therefore null out nearly every real score and hide the only reliability
// signal this server has. The score is passed through as sent, with the vote
// count beside it, and a missing or zero score stays null rather than being
// invented.
export const MIN_SHOP_VOTES = 0;

export const SORT_LABELS: Record<Sort, string> = {
  popularity: "most relevant",
  price: "cheapest first",
  expensive: "dearest first",
  newest: "newest first",
  sellers: "most sellers",
};
