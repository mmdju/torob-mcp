# Changelog

All notable changes to this project are documented here.

## unreleased

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
