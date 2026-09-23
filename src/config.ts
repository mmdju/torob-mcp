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

// Torob's own ranking already reflects what the search was for; these are the
// sort keys it accepts upstream.
export const SORTS = ["popularity", "price", "newest"] as const;
export type Sort = (typeof SORTS)[number];

// shop_type narrows results to sellers shipping online vs having a physical
// branch. Anything else upstream is ignored silently, so it is not offered.
export const SHOP_TYPES = ["offline", "online"] as const;
export type ShopType = (typeof SHOP_TYPES)[number];

// Torob accepts an arbitrary query string on the search endpoint; the filter
// slugs below were read off a live response (filters1 had 13 groups, filters2
// had 5 toggles, attributes had 12 groups including brand). Rather than
// hard-code a list that upstream can change under us, filters are passed as
// (slug, value) pairs and any slug the response did not offer is refused with
// the real ones - the same rule this workspace uses for unknown categories and
// cities. A silently-ignored filter would look like a filtered result.
export const KNOWN_FILTER_SLUGS = [
  "price__gt",
  "price__lt",
  "available",
  "offline",
  "torobpay",
  "has_warranty",
  "has_discount",
  "seller_type",
  "brand",
  "category",
] as const;

// The gap between upstream calls. Torob's edge challenges a client that
// arrives too fast - measured: a worker answering normally, then answering 490
// after a burst of probes, and recovering after roughly five idle minutes. The
// number here is deliberately unhurried; a 429-free but challenged response is
// worse for the user than a slow answer.
export const MIN_GAP_MS = 1500;

export const TTL = {
  suggest: 6 * HOUR, // autocomplete vocabulary barely moves
  search: 8 * MIN, // prices move, result sets do not
  product: 5 * MIN, // seller offers and stock are the volatile part
  category: 30 * MIN,
  similar: 15 * MIN,
  locations: 24 * HOUR, // province/city lists are administrative facts
  offers: 10 * MIN,
};

export const ATTRIBUTION =
  "Data comes from Torob's public web API. Prices, stock and seller offers change " +
  "constantly - always confirm on torob.com before buying. This server is not " +
  "affiliated with or endorsed by Torob.";

// The wall is not a rate limit and cannot be retried through: it is an
// anti-bot challenge. Say so plainly instead of returning an empty list that
// an agent would read as "no such product". Measured: it clears on its own
// after a few idle minutes, so the message says that rather than telling the
// caller to give up - and the server's circuit breaker stops the rest of a
// burst from hammering while it waits.
export const CHALLENGED_MSG =
  "Torob answered with a bot challenge (HTTP 490) instead of data, because too many calls " +
  "arrived too quickly. This is not a rate limit and an immediate retry will not clear it - " +
  "it clears after a few minutes of no calls. Wait, then retry the same call; or ask the " +
  "user to search on torob.com and share the product URL.";

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
  newest: "newest first",
};
