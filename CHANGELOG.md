# Changelog

Releases of the service (`https://torob-mcp.mmdju3.workers.dev/mcp`) and of the code in this repository. Dates are UTC.

## 0.4.1 - 2026-10-04

Answers that were wrong, and promises the docs made that the code did not keep. Everything below is on the hosted service as of this release.

### Fixed

- **`brand` sends the brand id Torob filters on, not its slug.** Torob ignores a slug or display name and answers unfiltered, so a filtered search used to come back as a full list that read as the answer. `available_filters` and `brand_values` now carry the id as `value` with the slug beside it to recognise the brand by, and a name or slug from an earlier answer is mapped onto the id.
- **A different brand or city is a different search.** The response cache left both out of its key, so a repeat search with the same words and a different brand or city came back from the first search's cache.
- **`find_best_value` names the real cheapest, and stops contradicting itself.** With nothing under budget it also sent the search's "Nothing matched" note - two answers that disagree in one response - and it called the *first* row in relevance order "the cheapest in stock". It now reports the actual cheapest and only says "nothing matched" when the search really matched nothing.
- **A torob.com product URL opens `price_history` and `similar_products` too.** Both refused an id the moment there was no memory of it, while `product_details` opened the same id through its last-resort lookup. They share that path now, so the documented input ("a prk from a card, or a torob.com product URL") works on all of them.
- **A product's name is remembered even when its URL is not**, and the name now actually drives a search. That rung of the resolution ladder was unreachable - no query was ever issued from it - so `resolved_by: exact-id` and `name-search` could not be reported at all, and a URL that stopped parsing left the id with no way back.
- **A brand wording the search cannot map is refused with the brands it does offer.** A word Torob ignores was sent anyway and the narrowing silently did not happen. A brand passed inside `filters` is taken over by the `brand` argument instead of being echoed back as an applied filter.
- **The filter groups a brand-bearing search teaches are read back.** The memory was written with the brand in its key and read without it, so a brand search never warmed the path that validates filters before spending a request.
- **An id-only answer for another product is never remembered as this one.** The probe's payload was cached under the id it was probed with *before* the id in it was checked, so a mismatched answer could be served later through the `details_url` path.
- **A 404 is reported at once.** The 4xx fast-fail threw inside the retry's own `try`, so it was retried anyway - four round trips and twelve seconds for a product that does not exist.
- **Lists that cannot be read are errors, not empty answers.** Rows whose fields this server does not recognise used to be dropped one by one until the result was `[]`, which reads as "there are no cities".
- **The caller's `details_url` is used before this server's own memory**, and a URL naming a *different* product than the `prk` is refused instead of opened: the `prk` is what the question is about.

### Changed

- **`search_products` and `search_by_image` cap `limit` at 24.** Upstream returns 24-26 cards a page whatever size is asked, so 30 was a promise the page could not keep.
- **A clamped page says so on all four paged tools.** `find_shops`, `search_by_image` and the `shop_profile` catalogue stop at 20 pages and used to clamp silently; the note now names the real maximum.
- **Provinces come back whole.** The default limit was 30 and Iran has 31, so the last province was dropped while the answer reported 30. Cities keep the smaller default, and a cut city list carries `total`, `truncated` and a `note`.
- **Numbers typed in Persian or Arabic-Indic digits are read**: `limit: ۱۰` is 10 instead of silently falling back to the default.
- **`browse_categories` says a full page means "possibly more"** - upstream sends no total - and no longer tells a caller to raise a limit already at its maximum.

### Documentation and tooling

- **`scripts/verify-live.mjs` takes its gap in seconds in either position**, so the command the architecture doc shows (`node scripts/verify-live.mjs 5`) runs instead of being read as a host name.
- **CI runs the unit suite on every push** (`.github/workflows/test.yml`). The `fa-text-utils` dependency now resolves over https, so a fresh clone and a runner both need no SSH key.
- **`SECURITY.md` says what is actually stored and how arguments are actually checked**: it no longer claims "nothing is persisted" beside its own Durable Object, nor that every argument is validated against a closed schema.
- **README fixes**: the red badge no longer claims to mean "the deployment drifted", the dependency count, the rate-limit wording, and - in the Persian README - a mistranslated bullet and a missing link to `docs/card.d.ts`.
- **`examples/python.py` reports tool errors as sentences** (they are not JSON), explains a 429 with its `retry-after`, and passes the card's `details_url` to `product_details`.
- **`docs/card.d.ts` carries every field the tools emit**, including the truncation signals and the shapes of a partial compare row and a failed delivery lookup.

## 0.4.0 - 2026-10-01

Five tools a shopper asks for and the service could not answer: what this product used to cost, whether the shop behind an offer is any good, which shops sell it in person, what the picture the user sent is, and what people are searching right now. The rest of Torob's product page - spec tables, variant tabs, the full price window - now travels with the details call that already paid for it.

### Added

- **`price_history`** answers "is now a good time to buy?". It returns Torob's own price chart for one product: monthly points going back years, each series with Torob's label (the average price and the lowest price it has charted), the lowest and highest figure in the window, when Torob last changed this product's prices, and - with `include_changes` - the newest price moves across its shops. Measured on a live product: 54 monthly points from شهریور ۱۴۰۱, lowest 689,999 Toman against an average of 1,243,456.
- **`shop_profile`** is the "is this seller any good?" call: the shop's trust seal (enamad) level and validity, its score and percentile, how long it has been active, Torob's own notes about it - including any violation note, sent as Torob words it - plus city, address, website, payment and delivery options, support hours and logo. `shop_id` comes from any offer in `product_details`. With `include_products` it also lists that shop's own catalogue (measured: 412 products for one seller), cheapest first.
- **`find_shops`** searches Torob's shop directory rather than its products: by name, by city id, and narrowed to online or in-person sellers, each row carrying the id `shop_profile` needs. Deliberately separate from `search_products`: "موبایل" there means 11,124 businesses with that word in their name, not products.
- **`search_by_image`** takes a public image URL and returns the products Torob matches to it, as cards. Torob fetches the picture itself, so there is no upload here - and when it recognises the image as one specific product, `matched_product` names it. An empty result says so honestly: it is not proof the product does not exist.
- **`torob_trends`** returns the wordings Torob's shoppers are searching right now, each with one sample product carrying its `prk` and `details_url`. It is a separate surface from `special_offers`, which stays the merchandising feed.
- **`product_details` reports the shops that sell the product in person** (`in_person_sellers`, `in_person_count`, `in_person_map_url`): name, city, address, the shop's own price, whether it is open now, and how long ago that price last moved. It rides along in the same response the call already fetched, so it costs no extra upstream request - and because a shelf price can be months old (measured: "۸ ماه و ۹ روز پیش"), every row carries `last_price_change_date` instead of presenting itself as today's price.
- **`product_details` also reports what the product page shows**: the spec tables (`specs`, with Torob's group headers and its `title` group markers dropped), the variant tabs (`variants`), the category path, `price_range_toman` (Torob's own cheapest and dearest, before the seller list is sliced) and `purchase_options` - Torob's quick filters such as the guarantee and TorobPay offers, with the price each starts at and how many sellers are behind it.
- **`search_products` reports `price_bounds_toman`** - the price group's own floor and ceiling for the result set Torob answered with (measured: 47,985 to 444,480,000 on "هدفون") - and `brand_values`, the brand slugs `brand` accepts, but only when the search offers more brands than the preview group shows.
- **`list_locations` reports `popular_cities`** (تهران، مشهد، اصفهان، تبریز، شیراز) alongside the provinces, so a city id does not have to be guessed.
- **The hosted Worker answers at most 20 `/mcp` calls a minute per client IP.** A real conversation is about four - a whole sweep of the tools, one at a time with a pause between - so nobody talking to it notices; a script looking for an unmetered price API is turned away with HTTP 429, a `retry-after` header and a JSON-RPC error that says the limit belongs to this hosted copy. The limiter (`src/rate-limit.ts`) is imported by `src/worker.ts` alone: the server core has no such rule, so a self-hosted run stays unlimited.
- **The worker now serves a real site.** `GET /` is a Persian, RTL landing page (dark theme, QR hand-off, live status and version) and `GET /mcp` is the page a browser gets instead of a JSON error: the address to paste, the three steps, and a copy button. Both are generated from `landing/*.html` by `scripts/gen-landing.mjs`, so the page has one owner and the two transports cannot drift apart.
- The Doran text face ships inside the worker as `/doran-<weight>.woff2`, so the page looks the same on a machine with no Persian font installed.

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
