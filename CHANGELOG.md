# Changelog

All notable changes to this project are documented here.

## unreleased

### Added

- Every product card and offer row now carries the `details_url` it came from, and `product_details` / `similar_products` accept it back as `details_url`. A caller that keeps both opens the product with no server-side memory involved: the id resolves on an isolate that never saw the search, and no name search is spent on it.
- Writes to the per-colo cache go through the request's `waitUntil`, so a product name and details URL learned from a search are not cut off when the Worker response finishes.

### Fixed

- The id-only details call no longer reports an empty response as a product. It falls through to the honest "search for it first" error, which names the way to recover.

## 0.2.0

### Added

- Search filters. `min_price_toman` / `max_price_toman` as first-class parameters, plus a `filters` object for Torob's own slugs. Every search now returns `available_filters` - the filter groups that search really accepts, with their slugs - so a caller can narrow down without a discovery call. An unknown slug is refused with the real ones, because Torob ignores an unknown slug and answers unfiltered.
- `similar_products` - products Torob considers comparable to one you pass, for the "that one is too expensive, what else?" question.
- `browse_categories` - walks Torob's category tree one level at a time (start with id `1`), with each category's product count.
- `list_locations` - provinces, or a province's cities, for the `city` filter.
- `special_offers` - the deals Torob is currently featuring. Merchandising, kept clearly separate from a product's seller list.

### Fixed

- Product ids now resolve across Worker isolates. A Worker spreads requests over many isolates, so a product name learned by one was invisible to the next and `product_details` / `similar_products` could fail for an id this server had just returned. Names are now shared through the per-colo Cache API.
- Numeric ids are read correctly. Torob sends province and city ids as numbers, and the string-only coercion silently dropped every row of a valid response - the tools reported "no provinces exist" while upstream had 30.
- `short()` no longer overshoots its length cap by two characters.

### Changed

- A bot challenge now opens a circuit breaker for that isolate. The rest of a burst fails immediately with a "retry in N minutes" message and spends no upstream request, instead of retrying into a longer block. It expires on its own; a fresh isolate gets a clean chance.
- The upstream pacing gap is 1.5s, and the challenge message now says plainly that an immediate retry will not help.

## 0.1.0

First release.

### Added

- `torob_suggest` - turns colloquial wording into the search terms Torob itself suggests.
- `search_products` - product search with compact cards: cheapest offer in Toman, shop, image, badges, product URL.
- `product_details` - one product plus every seller offer, cheapest first, with shop score, city, delivery and Torob's own `price_unreliable` warning.
- `compare_products` - 2-5 products side by side, on seller count, price spread and best-rated shop.
- `find_best_value` - ranks what is actually in stock under a Toman budget.
- Cloudflare Worker with stateless Streamable HTTP at `POST /mcp`, CORS, `/health` and a landing page.
- Node entry point: stdio by default, `--http` for Streamable HTTP.
- Read-only and keyless. The server never logs in, never solves bot challenges, never contacts a shop.

### Notes

- All prices are Toman. A price of 0 upstream means out of stock and is reported as `available: false`, never as a price.
- A search card carries the cheapest offer only; the full seller list is behind `product_details`.
- An empty search result is not proof a product does not exist - the response carries Torob's own suggestions for that wording.
