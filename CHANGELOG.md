# Changelog

Releases of the service (`https://torob-mcp.mmdju3.workers.dev/mcp`) and of the code in this repository. Dates are UTC.

## 0.3.0 - 2026-10-01

The filters, the seller list and the sorts, all brought in line with what Torob actually accepts - plus an id resolution path that survives a fresh Worker isolate and a cache that can no longer grow without bound.

### Added

- **`available_filters` now carries the values.** Each group ships the choices it accepts (`options`, each `{name, value}`), a `values_url` for the brand list, and `options_truncated` when the list is a preview. A `filters` value is checked against the search that really ran: a value the search does not offer is refused **with the ones it does**, because Torob ignores an unknown value and answers unfiltered.
- **Filter groups are remembered per query**, so a second call with the same words is validated before any upstream request; the fresh response stays the authority for everything else. A display name from the list (e.g. «۱ ترابایت») is mapped onto the value Torob takes (`1 tb`) when the group is known.
- **`sort` now uses Torob's own vocabulary.** `newest` sent a parameter Torob did not read; the real orderings are `popularity`, `price` (cheapest first), `expensive` (dearest first), `newest` (newest first) and `sellers` (most sellers).
- **The offer list carries what the shop stated**: `postage_text` / `postage_fee_toman`, `delivered_price_toman`, `guarantee`, `installment_providers`, `is_adv`, `last_price_change_date`, `has_public_torob_profile`, `shop_score_percentile`. `product_details` reports `cheapest_delivered_offer` and, when it differs, `cheapest_vs_delivered`.
- **`best_rated_offer` is now the highest score**, not the first scored offer in the cheapest-first list (measured: the old pick could put a 3.0 shop above a 5.0 one). Ties break on votes, then price.
- **`resolved_by` says how a product id was found**: `remembered`, `details-url`, `exact-id`, `name-search` or `id-only`, so a name match is never presented as the same id.
- **`compare_products` accepts `{prk, details_url}`** for each product, and the whole comparison shares one lookup budget, so a cold 5-way compare cannot turn into a dozen paced upstream calls. Anything it cannot open comes back as an error in its own row.
- **`find_best_value` gained `include_delivery`**: it reads the stated postage for the cheapest picks (up to 3) and reports the delivered price.
- Every search and `find_best_value` call reports `total_matches_note`: Torob's count moves between identical requests (measured: 1125 then 1200 seconds apart), so page with `has_next_page` instead of quoting it.
- `GET /mcp` answers with the landing page instead of a bare 404, and the page lists all nine tools.

### Fixed

- **The filter surface is no longer a hard-coded list.** The old snapshot could not keep up with Torob (30 groups on a typical query) and refused filters Torob genuinely applies (`storage=1 tb` narrows ~1200 results to 17).
- **A brand name is mapped onto Torob's brand slug** when the search showed the brand group. A display name like `apple` is not a slug and Torob ignores it; measured: `brand=apple` changed nothing while `brand=apple-اپل` narrowed the list.
- **The response cache has a byte budget** (12MB, 1000 entries) and evicts oldest-first; a single payload larger than the whole budget is not cached at all. One product's raw details payload measures ~1.4MB, and a count-only cap could hold gigabytes on a Worker isolate that gets 128MB.
- Every product card now carries the `details_url` it came from, and `product_details` / `similar_products` accept it back as `details_url`. A caller that keeps both opens the product with no server-side memory involved: the id resolves on a Worker isolate that never saw the search, and no name search is spent on it.
- Writes to the per-colo cache go through the request's `waitUntil`, so a product name and details URL learned from a search are not cut off when the Worker response finishes.
- The id-only details call no longer reports an empty response as a product. It falls through to the honest "search for it first" error, which names the way to recover.
- `torob_suggest` drops the autocomplete entries that carry a `business_profile_query` instead of a search term, and says in `note` that it did, so a shop link is never returned as a suggested query.

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
