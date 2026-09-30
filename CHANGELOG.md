# Changelog

Releases of the service (`https://torob-mcp.mmdju3.workers.dev/mcp`) and of the code in this repository. Dates are UTC.

## unreleased

### Added

- Every product card now carries the `details_url` it came from, and `product_details` / `similar_products` accept it back as `details_url`. A caller that keeps both opens the product with no server-side memory involved: the id resolves on a Worker isolate that never saw the search, and no name search is spent on it.
- Writes to the per-colo cache go through the request's `waitUntil`, so a product name and details URL learned from a search are not cut off when the Worker response finishes.

### Fixed

- The id-only details call no longer reports an empty response as a product. It falls through to the honest "search for it first" error, which names the way to recover.

## 0.2.0 - 2026-09-24

Torob's search accepts a lot of filters, and a price-comparison source with no way to narrow a search is only half a tool. This release adds the rest of Torob's addressable surface, and fixes two failures where a perfectly good upstream response was reported as an empty one.

- **Search filters became real.** `min_price_toman` / `max_price_toman` are first-class parameters, and a `filters` object takes Torob's own slugs. Every search now returns **`available_filters`** - the filter groups that search actually accepts, with their slugs - so a caller can narrow down without a discovery call. An unknown slug is **refused with the real ones**: Torob ignores a slug it does not know and answers *unfiltered*, so a typo used to hand back a full list that read as a filtered answer. A reversed price window is refused for the same reason.
- **`similar_products`** - products Torob considers comparable to one you pass, for the "that one is too expensive, what else?" question.
- **`browse_categories`** - walks Torob's category tree one level at a time (start with id `1`), with each category's product count.
- **`list_locations`** - provinces, or a province's cities, as ids for the `city` filter.
- **`special_offers`** - the deals Torob is currently featuring. Merchandising, kept clearly separate from any product's seller list.
- **A product id now resolves across Worker isolates.** A Worker spreads requests over many isolates, so a product name learned by one was invisible to the next, and `product_details` / `similar_products` could fail for an id this server had just returned. Names are now shared through the per-colo Cache API, and the details URL the search row already carried is remembered directly.
- **Numeric ids are read correctly.** Torob sends province and city ids as *numbers*, and a string-only coercion silently dropped every row of a valid response - `list_locations` reported "no provinces exist" while upstream had 30. This was the most deceptive bug in the project: a wrong field name returns an empty list rather than an error, so it read as a real answer.
- **A bot challenge now opens a circuit breaker** for that isolate instead of being retried. The rest of a burst fails immediately with a "retry in N minutes" message and spends no upstream request, so the traffic that caused the challenge is not extended by the retries behind it. The upstream pacing gap is 1.5s, and the challenge message now says plainly that an immediate retry will not help.
- Fixed: `short()` overshot its length cap by two characters.

## 0.1.0 - 2026-09-24

First release.

- **Five tools** - `torob_suggest`, `search_products`, `product_details`, `compare_products`, `find_best_value`, plus the Cloudflare Worker itself: stateless Streamable HTTP at `POST /mcp`, CORS, `/health` and a landing page. A Node entry point runs stdio by default and `--http` for Streamable HTTP.
- **The seller list is the reason a Torob MCP exists**, so it is projected into a first-class `offers[]` array - cheapest available first, then by shop score, out-of-stock rows last - rather than flattened into a string. Each offer carries the shop, its city, its grade and vote count, the price, the struck-through price when discounted, free shipping, cash on delivery and same-day delivery.
- **`find_best_value`** ranks what is actually in stock under a Toman budget, and reports how many out-of-stock rows it excluded so an agent cannot quietly recommend something unavailable.
- **An empty search is not proof a product does not exist.** The response carries Torob's own suggestions for the wording, so a caller retries instead of telling the user it is unavailable.
- Read-only and keyless. The server never logs in, never solves bot challenges, and never contacts a shop.
