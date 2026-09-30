# Tool reference

Input/output reference for all **9 tools**. Types only - no internals. For conversation flows, see [examples/sample-calls.md](../examples/sample-calls.md).

Every tool is **read-only** and needs **no credentials**. Result lists are **capped** (default 10, max 30). All prices are in **Toman**.

Which tool for what - the short version:

| The user says | Call |
|---|---|
| something vague, "قاب گوشی", "ارزون‌ترین" | `torob_suggest` |
| "show me X", "X in Y under Z", "what is there?" | `search_products` |
| "is this the same as that one?" (a specific product) | `product_details` |
| "that's too expensive, what else?" | `similar_products` |
| "which of these should I buy?" | `compare_products` |
| "best X under Y", "cheapest X" | `find_best_value` |
| "what categories are there?" | `browse_categories` |
| "what can I get delivered to X?" | `list_locations` |
| "anything on deal?" | `special_offers` |

Shared conventions:

- `limit` - how many items to return (default 10, max 30).
- `page` - 1-based page number, max 50. Deep pages cost an extra upstream request; a clamped page comes back with `page_clamped`, `page_requested` and `page_note`.
- `prk` - Torob's product id, as a UUID. It comes from a `search_products` card and can be passed back as a bare id, a `/p/<id>/` path, or a full `torob.com` product URL. Torob cannot look a product up by id alone, so an id is only usable after this server has returned it - or with the `details_url` from the same card, which resolves it with no server-side memory at all.
- `price_toman: null` means **not available** - out of stock upstream, or no price at all. It is never 0, and 0 is never free.
- `available: false` on a card or an offer is upstream's "not for sale right now".
- **Bot challenge.** Torob answers a client that calls too often with HTTP 490 instead of data. It clears on its own after a few idle minutes. A challenged call is worth retrying later, not immediately; the server holds the rest of a burst for five minutes so it does not deepen the block.

## `torob_suggest`

Vague or colloquial wording to **the search terms Torob itself suggests**. Call first when the user typed something colloquial, abbreviated, or in Persian you are not sure Torob spells that way.

| Param | Type | Required | Notes |
|---|---|---|---|
| `query` | string | **yes** | What the user actually typed, e.g. `قاب گوشی` |

Returns: `suggestions` (array of strings, deduped, max 10), `next` telling you what to do with them, and - when Torob's autocomplete offered shop entries instead of search terms - a `note` saying how many such entries were dropped. An empty `suggestions` array is not a failure - it means Torob has no better wording, so pass the query to `search_products` as-is.

## `search_products`

Search Torob, get **compact cards**: the cheapest offer in Toman, the shop behind it, image, badges, product URL.

| Param | Type | Notes |
|---|---|---|
| `query` | string | Persian or English, e.g. `گوشی ایفون ۱۳`, `iphone 13` |
| `page` | number | 1-based, max 50 |
| `sort` | string | `popularity` (default, most relevant) · `price` (cheapest first) · `expensive` (dearest first) · `newest` (newest first) · `sellers` (most sellers) |
| `category` | string | Torob category id, from `suggested_categories` or `browse_categories` |
| `brand` | string | Brand **slug** from the brand group of `available_filters` (`options[].value`, or the full list at its `values_url`), e.g. `apple-اپل`. A display name is mapped onto the slug when this search showed the brand group |
| `city` | string | Delivery-city id, from `list_locations` |
| `shop_type` | string | `offline` (has a branch) · `online` (online sellers) |
| `min_price_toman` | number | Only products at or above this price |
| `max_price_toman` | number | Only products at or below this price |
| `filters` | object | Values from `available_filters` of the same query, e.g. `{"available": "1", "storage": "1 tb"}`. A value the search does not offer is refused with the real ones |
| `limit` | number | How many cards (default 10, max 30) |

Returns: `total_matches`, `total_matches_note`, `page`, `page_count`, `has_next_page`, `price_range_toman` (`{min, max}`), `products[]`, `available_filters`, `filters_applied`, `sort_meaning`, `attribution`. `total_matches_note` is there because Torob's own count moves between identical requests - page with `has_next_page` instead of quoting the number.

Each card: `prk`, `name_fa`, `name_en`, `price_toman`, `price_text`, `available`, `shop_name`, `image`, `image_count`, `badges[]`, `url`, `is_adv`, `details_url`.

A card is **one price** - the cheapest offer - not every seller. For the seller list call `product_details`.

### `available_filters`

Every search returns the filter groups **that search really accepts** - measured: 30 groups on a typical query, including `price`, `brand`, `storage`, `ram`, `screen_size`, `battery`, `network`, `sim_card`, `torobpay`, `shop_type`, `stock_status`, `available`. Each entry has `title`, `slug`, `type`, `values` (how many), and - when the group takes fixed choices - `options[]` with each option's `{name, value}`. A group whose list is only a preview (the brand group always is) also carries `options_truncated: true` and a `values_url` for the full list; a price group has no options because it is a range.

This is the discovery step for narrowing a search: read the slugs, pass them back in `filters`. Torob ignores a slug it does not know and answers **unfiltered**, so an unknown slug here is **refused with the real ones** rather than silently dropped - otherwise a caller would read an unfiltered result as a filtered one.

A value from `options` is passed back as its `value`, not its display `name` - the server maps the name onto the value when it remembers the group. The groups are remembered per query for 30 minutes, so a repeat call is validated before any upstream request; a query the server has not seen validates against the fresh response instead.

`min_price_toman` / `max_price_toman` are first-class and compile to the `price__gt` / `price__lt` slugs; a reversed window is refused rather than returning nothing.

Honest-failure fields, present only when relevant:

- `query_note` + `suggested_queries` - nothing matched; these are the wordings Torob suggests. **An empty result is not proof the product does not exist.**
- `query_corrected` - Torob read the query differently and shows what it used.
- `suggested_categories` - category ids for this wording, each usable as `category` next call.
- `truncated` / `returned` - the page held more cards than `limit`.
- `page_clamped` / `page_requested` / `page_note` - the page number was out of range.

## `product_details`

One product plus **every seller offer**, sorted cheapest available first. This is the call that answers "who sells this cheapest" and "is that shop any good".

| Param | Type | Required | Notes |
|---|---|---|---|
| `prk` | string | **yes** | From a `search_products` card, or a torob.com product URL |
| `details_url` | string | no | The `details_url` from the same card. Pass it back and the product opens with no lookup at all - the path that works on a Worker isolate that never saw the search |
| `max_offers` | number | no | How many offers (default 10, max 30) |

Returns: the card fields, plus:

| Field | Notes |
|---|---|
| `offer_count` | How many sellers exist for this product |
| `price_spread_toman` | Cheapest minus dearest available offer - the same product at different prices |
| `cheapest_offer` | The full cheapest offer object |
| `best_rated_offer` | The **highest** `shop_score` among available offers; ties break on votes, then price |
| `cheapest_delivered_offer` | Cheapest once stated postage is added - not always the same shop as `cheapest_offer` |
| `cheapest_vs_best_rated` | A one-line plain summary, present when the two are different shops |
| `cheapest_vs_delivered` | A one-line plain summary, present when postage changes which shop is cheapest |
| `resolved_by` | How the id was found: `remembered`, `details-url`, `exact-id`, `name-search` or `id-only` |
| `offers[]` | The seller list, cheapest first |
| `offers_truncated` / `offers_returned` | More offers exist than shown |

Each offer: `shop_name`, `shop_city`, `shop_id`, `shop_score` (0-5 or null), `shop_votes`, `price_toman`, `price_text`, `was_price_text` (struck-through price when discounted), `available`, `price_unreliable` (Torob's own warning), `free_shipping`, `payment_on_delivery`, `same_day_delivery`, `url`, `is_adv`, `postage_text` / `postage_fee_toman`, `delivered_price_toman`, `guarantee` (`enabled` / `disabled`), `installment_providers[]`, `last_price_change_date`, `has_public_torob_profile`, `shop_score_percentile`.

- `postage_text` is Torob's own line ("هزینه ارسال رایگان" or a Toman amount); `postage_fee_toman` is that number parsed, `null` when postage is free or unstated, and `delivered_price_toman` is the price with it added.
- `resolved_by: "name-search"` means the id was re-found through the product's name, not matched exactly - say so rather than presenting it as the same id.

- `price_unreliable: true` is **Torob saying that price cannot be trusted**. Say so; do not present it as a bargain.
- `shop_score` is `null` only when Torob sends no score. Torob sends a score for nearly every offer but almost never the vote count behind it, so `shop_votes` is often 0 even when `shop_score` is 5.

## `compare_products`

Open 2-5 products by `prk` and put them side by side.

| Param | Type | Required | Notes |
|---|---|---|---|
| `prks` | array | **yes** | 2-5 products, each a product id or an object `{prk, details_url}` |

Returns: `products[]` (one row per id: `cheapest_price_toman`, `seller_count`, `price_spread_toman`, `cheapest_shop`, `cheapest_shop_score`, `best_rated_shop`, `best_rated_score`, `url`, plus `error` on failure), `compared`, `requested`, `cheapest_overall`, `price_difference_toman`.

Resolving ids costs upstream requests, so a whole comparison shares one lookup budget - a cold 5-way compare cannot become a dozen paced calls.

**Partial failure is reported, not hidden:** one unreadable product comes back as a row with an `error` and the response sets `partial_failure`, so a 3-way comparison still answers for the 2 that resolved.

## `find_best_value`

Rank what is **actually buyable** under a budget.

| Param | Type | Required | Notes |
|---|---|---|---|
| `query` | string | **yes** | The item the user wants |
| `budget_toman` | number | no | Maximum price in Toman. Unset = just rank in stock |
| `sort` | string | no | Any of `popularity`, `price`, `expensive`, `newest`, `sellers` (default `popularity`) |
| `include_delivery` | boolean | no | Also read stated postage for the cheapest picks (up to 3) and report the delivered price. Costs extra upstream requests |
| `limit` | number | no | How many picks (default 5, max 15) |

Returns: `budget_toman`, `total_matches`, `total_matches_note`, `matches_in_budget`, `out_of_stock_excluded`, `best_value`, `picks[]`, `attribution`. With `include_delivery`, also `delivered[]` (each `{prk, name_fa, cheapest_price_toman, cheapest_delivered_offer}`) and `delivery_note`.

With a budget the picks are sorted by price; without one they keep relevance order, because "best" without a number usually means "most relevant that is actually in stock".

When nothing fits, `best_value` is `null` and `budget_note` says so - including what the cheapest in-stock result actually was, so the answer is not a dead end. `suggested_queries` may also be present.

## `similar_products`

Products Torob considers comparable to the one you pass. This is the "that one is too expensive, what else?" call.

| Param | Type | Required | Notes |
|---|---|---|---|
| `prk` | string | **yes** | A product id this server has already returned |
| `details_url` | string | no | The `details_url` from the same card; proves the id is real without any lookup |
| `limit` | number | no | How many (default 10, max 24) |

Returns `prk`, `found`, `products[]` (cards, same shape as search), and a `note` saying whether to call `product_details` next. Cards carry the cheapest offer only.

The product must be one this server has already returned. Torob cannot look a product up by id alone, so the id is confirmed first from what this server knows - and the error says to search first rather than failing silently.

## `browse_categories`

List the sub-categories of a category id, one level at a time. Torob has no "all categories" call, so this walks the tree.

| Param | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Parent category id. **`1` is the top level** |
| `limit` | number | no | How many children (default 20, max 30) |

Returns `parent_id`, `count`, `categories[]`, and `next` telling you where to go next. Each category: `id`, `title`, `slug`, `image`, `url`, `product_count`, `has_children`, `parent_id`.

`has_children` is derived from `product_count`, so it means "worth walking into" rather than "has sub-categories". A category id is also accepted by `search_products` as `category`.

## `list_locations`

Provinces, or a province's cities. City ids are what `search_products` accepts as `city`.

| Param | Type | Required | Notes |
|---|---|---|---|
| `province_id` | string | no | Given → that province's cities; omitted → the provinces |
| `search` | string | no | Filter by name, e.g. `تهران` |
| `limit` | number | no | How many (default 30, max 200) |

Returns `mode` (`provinces` or `cities`), `count`, and `provinces[]` / `cities[]` with `id` and `name`. With only a `search` and no province, it searches cities nationwide.

## `special_offers`

The deals Torob is currently featuring. **This is merchandising, not shop data** - the banners point at campaigns, some off torob.com (TorobPay). It is not the seller list for a product; for that use `product_details`.

| Param | Type | Required | Notes |
|---|---|---|---|
| `limit` | number | no | How many (default 10, max 30) |

Returns `count` and `offers[]`: `group` (the campaign the banner belongs to), `title`, `description`, `image`, `url`. Refreshed every ten minutes.
