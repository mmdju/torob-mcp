# Tool reference

Input/output reference for all **15 tools**. Types only - no internals. For conversation flows, see [examples/sample-calls.md](../examples/sample-calls.md). The response types are also kept in [card.d.ts](card.d.ts).

Every tool is **read-only** and needs **no credentials**. Result lists are **capped** (default 10; the maximum is per tool and stated in its table - 24 on a product search, 15 on `find_best_value`, 24 on the shop and image lists, 30 on most others). All prices are in **Toman**.

Which tool for what - the short version:

| The user says | Call |
|---|---|
| something vague, "قاب گوشی", "ارزون‌ترین" | `torob_suggest` |
| "show me X", "X in Y under Z", "what is there?" | `search_products` |
| "is this the same as that one?" (a specific product) | `product_details` |
| "is now a good time to buy?", "has it got cheaper?" | `price_history` |
| "that's too expensive, what else?" | `similar_products` |
| "which of these should I buy?" | `compare_products` |
| "best X under Y", "cheapest X" | `find_best_value` |
| "is this seller reliable?", "what else does this shop sell?" | `shop_profile` |
| "which shops are there?", "does فروشگاه X exist?" | `find_shops` |
| "what is this in the picture?" | `search_by_image` |
| "what is popular right now?" | `torob_trends` |
| "what categories are there?" | `browse_categories` |
| "what can I get delivered to X?" | `list_locations` |
| "anything on deal?" | `special_offers` |

Shared conventions:

- `limit` - how many items to return (default 10; the maximum belongs to the tool and is in its table below).
- `page` - 1-based page number. The maximum belongs to the tool: **50** on `search_products`, **20** on `find_shops`, on `search_by_image` and on a `shop_profile` catalogue. Deep pages cost an extra upstream request, and a clamped page comes back with `page_clamped`, `page_requested` and `page_note` naming the real maximum - on all four paged tools, not just the search.
- `prk` - Torob's product id, as a UUID. It comes from a `search_products` card and can be passed back as a bare id, a `/p/<id>/` path, or a full `torob.com` product URL. Torob cannot look a product up by id alone, so an id is only usable after this server has returned it - or with the `details_url` from the same card, which resolves it with no server-side memory at all.
- `shop_id` - a **numeric** shop id, from any offer in `product_details` or from `find_shops`. It is what `shop_profile` takes.
- `price_toman: null` means **not available** - out of stock upstream, or no price at all. It is never 0, and 0 is never free.
- `available: false` on a card or an offer is upstream's "not for sale right now".
- **In-person prices are the shops' own and can be old.** Every in-person row carries `last_price_change_date` (Torob's wording, e.g. `"۸ ماه و ۹ روز پیش"`), so say how old a shelf price is instead of presenting it as today's.
- **Torob's own labels travel as sent** - filter titles, series names (`"میانگین قیمت"`), shop notes, campaign names. Quote them rather than translating them into a claim.
- **Bot challenge.** Torob answers a client that calls too often with HTTP 490 instead of data. It clears on its own after a stretch with no calls at all - measured anywhere from a few minutes to half an hour. A challenged call is worth retrying later, not immediately; the server holds the rest of a burst for the whole cooldown so it does not deepen the block, and says how many minutes are left.

## `torob_suggest`

Vague or colloquial wording to **the search terms Torob itself suggests**. Call first when the user typed something colloquial, abbreviated, or in Persian you are not sure Torob spells that way.

| Param | Type | Required | Notes |
|---|---|---|---|
| `query` | string | **yes** | What the user actually typed, e.g. `قاب گوشی`. A نیم‌فاصله is searched as a space |

Returns: `suggestions` (array of strings, deduped, max 10), `next` telling you what to do with them, and - when Torob's autocomplete offered shop entries instead of search terms - a `note` saying how many such entries were dropped. An empty `suggestions` array is not a failure - it means Torob has no better wording, so pass the query to `search_products` as-is.

## `search_products`

Search Torob, get **compact cards**: the cheapest offer in Toman, the shop behind it, image, badges, product URL.

| Param | Type | Notes |
|---|---|---|
| `query` | string | Persian or English, e.g. `گوشی ایفون ۱۳`, `iphone 13`. A نیم‌فاصله is searched as a space - Torob's index stores the spaced form, so `لپ‌تاپ` would match nothing |
| `page` | number | 1-based, max 50 |
| `sort` | string | `popularity` (default, most relevant) · `price` (cheapest first) · `expensive` (dearest first) · `newest` (newest first) · `sellers` (most sellers) |
| `category` | string | Torob category id, from `suggested_categories` or `browse_categories` |
| `brand` | string | Brand **id** from the brand group of `available_filters` (`options[].value`, `brand_values[].value`, or the `id` of an entry in the full list at its `values_url`), e.g. `17418` for MikroTik. Torob filters on the id and ignores a slug or display name; a name or slug is mapped onto the id when this search shows the brand group, and a **word that maps to nothing is refused with the brands the search really offers** instead of being sent and silently dropped. A brand passed inside `filters` is taken over by this argument, so it is never echoed back as an applied filter |
| `city` | string | Delivery-city id, from `list_locations` |
| `shop_type` | string | `offline` (products that have an in-person seller) · `online` (online sellers) |
| `min_price_toman` | number | Only products at or above this price |
| `max_price_toman` | number | Only products at or below this price |
| `filters` | object | Values from `available_filters` of the same query, e.g. `{"available": "1", "storage": "1 tb"}`. A value the search does not offer is refused with the real ones |
| `limit` | number | How many cards (default 10, max 24 - upstream returns 24-26 rows a page whatever is asked) |

Returns: `total_matches`, `total_matches_note`, `page`, `page_count` (how many cards **this page** held before `limit` trimmed it - not how many pages exist), `has_next_page`, `price_range_toman` (`{min, max}`), `price_bounds_toman`, `products[]`, `available_filters`, `brand_values`, `filters_applied`, `sort_meaning`, `attribution`. `total_matches_note` is there because Torob's own count moves between identical requests - page with `has_next_page` instead of quoting the number.

Each card: `prk`, `name_fa`, `name_en`, `price_toman`, `price_text`, `available`, `shop_name`, `image`, `image_count`, `badges[]`, `url`, `is_adv`, `details_url`.

A card is **one price** - the cheapest offer - not every seller. For the seller list call `product_details`.

### `available_filters`

Every search returns the filter groups **that search really accepts** - measured: 30 groups on a typical query, including `price`, `brand`, `storage`, `ram`, `screen_size`, `battery`, `network`, `sim_card`, `torobpay`, `shop_type`, `stock_status`, `available`. Each entry has `title`, `slug`, `type`, `values` (how many), and - when the group takes fixed choices - `options[]` with each option's `{name, value}`. A group whose list is only a preview (the brand group always is) also carries `options_truncated: true` and a `values_url` for the full list; a price group has no options because it is a range.

This is the discovery step for narrowing a search: read the slugs, pass them back in `filters`. Torob ignores a slug it does not know and answers **unfiltered**, so an unknown slug here is **refused with the real ones** rather than silently dropped - otherwise a caller would read an unfiltered result as a filtered one.

A value from `options` is passed back as its `value`, not its display `name` - the server maps the name onto the value when it remembers the group. The groups are remembered per query for 30 minutes, so a repeat call is validated before any upstream request; a query the server has not seen validates against the fresh response instead.

`min_price_toman` / `max_price_toman` are first-class and compile to the `price__gt` / `price__lt` slugs; a reversed window is refused rather than returning nothing.

### `price_bounds_toman` and `brand_values`

Two things the filter groups cannot say in full:

- `price_bounds_toman` - the price group's own floor and ceiling **for the result set** (`{min, max}`), which is the range Torob's own slider spans (measured: 47,985 to 444,480,000 on "هدفون"). `price_range_toman` is Torob's looser min/max on the response; when the two disagree, the bounds are the tighter, real one.
- `brand_values` - the brands this search offers, as `{name, value, slug}`: `value` is the brand id `brand` accepts, `slug` is there to recognise the brand by (measured: `brand=17418` narrowed routers to MikroTik, while its slug `mikrotik-میکروتیک` came back unfiltered). It appears only when the search offers **more brands than the preview group shows** (10), because below that they are already in `available_filters`; `brand_values_note` says so, and the note adds that the group's `values_url` has the rest if even this list is short.

Honest-failure fields, present only when relevant:

- `query_note` + `suggested_queries` - nothing matched; these are the wordings Torob suggests. **An empty result is not proof the product does not exist.**
- `query_corrected` - Torob read the query differently and shows what it used.
- `suggested_categories` - category ids for this wording, each usable as `category` next call.
- `truncated` / `returned` - the page held more cards than `limit`.
- `page_clamped` / `page_requested` / `page_note` - the page number was out of range.

## `product_details`

One product plus **every seller offer**, sorted cheapest available first, and **the shops that sell it in person**. This is the call that answers "who sells this cheapest", "is that shop any good" and "can I get it near me today".

| Param | Type | Required | Notes |
|---|---|---|---|
| `prk` | string | **yes** | From a `search_products` card, or a torob.com product URL |
| `details_url` | string | no | The `details_url` from the same card. Pass it back and the product opens with no lookup at all - the path that works on a Worker isolate that never saw the search. It is checked against `prk`: a URL carrying a different product is refused rather than opened |
| `max_offers` | number | no | How many offers (default 10, max 30) |
| `max_in_person` | number | no | How many in-person shops (default 10, max 30). They come in the same response, so this costs no extra request |

Returns: the card fields, plus:

| Field | Notes |
|---|---|
| `offer_count` | How many sellers exist for this product |
| `price_spread_toman` | Cheapest minus dearest available offer - the same product at different prices |
| `price_range_toman` | Torob's own cheapest and dearest price for the product, before the seller list is sliced (`{min, max}`) |
| `cheapest_offer` | The full cheapest offer object |
| `best_rated_offer` | The **highest** `shop_score` among available offers; ties break on votes, then price |
| `cheapest_delivered_offer` | Cheapest once stated postage is added - not always the same shop as `cheapest_offer` |
| `cheapest_vs_best_rated` | A one-line plain summary, present when the two are different shops |
| `cheapest_vs_delivered` | A one-line plain summary, present when postage changes which shop is cheapest |
| `resolved_by` | How the id was found: `remembered`, `details-url`, `exact-id`, `name-search` or `id-only` |
| `offers[]` | The seller list, cheapest first |
| `offers_truncated` / `offers_returned` | More offers exist than shown |

Each offer: `shop_name`, `shop_city`, `shop_id`, `shop_score` (0-5 or null), `shop_votes`, `price_toman`, `price_text`, `was_price_text` (struck-through price when discounted), `available`, `price_unreliable` (Torob's own warning), `free_shipping`, `payment_on_delivery`, `same_day_delivery`, `url` (the shop's page on torob.com), `buy_url` (Torob's own click-through, an `api.torob.com` redirect), `shop_note` (Torob's own sentence about the seller, when it sends one), `is_adv`, `postage_text` / `postage_fee_toman`, `delivered_price_toman`, `guarantee` (`enabled` / `disabled`), `installment_providers[]`, `last_price_change_date`, `has_public_torob_profile`, `shop_score_percentile`.

- `postage_text` is Torob's own line ("هزینه ارسال رایگان" or a Toman amount); `postage_fee_toman` is that number parsed, `null` when postage is free or unstated, and `delivered_price_toman` is the price with it added.
- `resolved_by: "name-search"` means the id was re-found through the product's name, not matched exactly - say so rather than presenting it as the same id.
- `price_unreliable: true` is **Torob saying that price cannot be trusted**. Say so; do not present it as a bargain.
- `shop_score` is `null` only when Torob sends no score. Torob sends a score for nearly every offer but almost never the vote count behind it, so `shop_votes` is often 0 even when `shop_score` is 5.
- `shop_id` is what `shop_profile` takes next.
- `url` is the shop's stable page on torob.com; `buy_url` is the link Torob's own buy button uses, an `api.torob.com` redirect with tracking and a session id on it. Give the user `url`, and reach for `buy_url` only when they are about to click through.

### The in-person shops

`in_person_count` is how many shops Torob lists for this product in a physical store; `in_person_sellers[]` is the cheapest `max_in_person` of them, and `in_person_map_url` is Torob's own map for them when it sends one. `in_person_note` says it plainly: these prices are the shops' own and can be old. When the list is cut, `in_person_truncated` / `in_person_returned` / `in_person_truncated_note` say so.

Each row: `shop_name`, `shop_id`, `city`, `address`, `note` (the shop's own line, e.g. "تست و تحویل در حضور مشتری"), `price_toman`, `price_text`, `price_unreliable`, `is_open` (Torob's current state), `hours_status` / `hours_today` (its own words, e.g. `"بسته"` and `"تا ۰۹:۰۰ امروز"`), `last_price_change_date`, `fast_delivery`, `score` / `score_note` (Torob's own grade for that shop in this list - the badge the site shows - and its line under it), `url` (the shop's torob.com page).

There is deliberately no coordinate here: measured on a live product, none of the 84 in-person rows carried one. The coordinates live behind the map endpoint, whose link this server hands out as `in_person_map_url`.

### Specs, variants, category path, purchase options

All of it rides along in the same response, so none of it costs an extra request:

- `specs[]` - the product's own tables, flattened to `{group, key, value}`. Torob marks a table section with the literal value `"title"`; those markers are dropped, never handed back as a spec. `specs_truncated` + `specs_available` appear when there were more than 24 pairs.
- `variants[]` - the variant tabs a product page shows (e.g. `"اصالت کالا"`), each `{title, count, items[]}` with up to 5 cards.
- `category_path[]` - the categories above the product, without Torob's own root crumb.
- `purchase_options[]` - Torob's quick purchase filters (guarantee, TorobPay credit), each with its own wording and `{price_from_text, online_sellers, offline_sellers}`.
- `is_authentic` / `has_wiki` - Torob's own flips, present only when true. An absent `is_authentic` is **not** a claim that a product is fake.

## `product_guide`

Torob's own write-up of one product: what the model is, its strengths and weaknesses, what buyers said and who it suits - the article the site shows on the product page above the specs. This is the "should I buy this?" reading when a price chart alone does not answer it. It is text, not a seller list.

| Param | Type | Required | Notes |
|---|---|---|---|
| `prk` | string | **yes** | From a `search_products` card, or a torob.com product URL |
| `details_url` | string | no | The `details_url` from the same card, so the id resolves with no lookup |
| `max_chars` | number | no | How much text to return (default 4000, max 8000) |

Returns:

| Field | Notes |
|---|---|
| `prk` | The product the guide is about |
| `title` | The name the guide titles it with |
| `sections[]` | `{heading, text}` - Torob's own headings (`نقاط قوت`, `نقاط ضعف`, `نظر خریداران`, `منابع` …), with `heading: null` for text before the first one |
| `text_length` | How many characters the whole guide holds, before the cap |
| `truncated` + `note` | The answer carries only the first part of the guide; raise `max_chars` for the rest |
| `guide_url` | The product page, where the guide is rendered |

- The headings and the wording are Torob's own: quote them rather than paraphrasing a verdict into your own words.
- Not every product has a guide. An empty `sections[]` is Torob having nothing to say about this product, not a failure - and not an invitation to write a summary instead. `product_details` still answers about its price and sellers.
- No markup is returned: the HTML is turned into headings and text, with entities decoded.

## `price_history`

Torob's own price chart for one product: month-by-month points, when the price last moved, and - on request - the newest changes across its shops. "Is now a good time to buy?"

| Param | Type | Required | Notes |
|---|---|---|---|
| `prk` | string | **yes** | From a `search_products` card, or a torob.com product URL |
| `details_url` | string | no | The `details_url` from the same card, so the id resolves with no lookup |
| `months` | number | no | How many monthly points to return, newest last (default 12, max 54) |
| `include_changes` | boolean | no | Also read the newest price changes. **Costs one extra upstream request** |
| `changes_limit` | number | no | How many changes with `include_changes` (default 5, max 20) |

Returns:

| Field | Notes |
|---|---|
| `series[]` | One entry per series Torob charts: `label` (Torob's own, e.g. `"میانگین قیمت"` / `"کمترین قیمت"`), `color`, `points[]` (`{date, value}` in Toman, oldest first), `latest`, `lowest`, `highest` |
| `window` | `{from, to, points}` - the dates the returned points cover |
| `points_available` | How many monthly points Torob charts in total, before `months` |
| `reading` | One plain sentence built from those numbers - the lowest and highest figure charted, and the latest point of every series |
| `last_modified` | Torob's own timestamp for this product's last price update |
| `last_modified_note` | Why that timestamp is not a promise: prices move after it |
| `changes[]` / `changes_count` | With `include_changes`: the newest entries, each `{title, description, time_ago}` in Torob's words |
| `note` | Present only when Torob charts no history yet |

- **The series labels are Torob's, not this server's.** Quote them; do not turn a chart into a forecast.
- `points_available` larger than `window.points` means the chart is longer than the window you asked for - raise `months` instead of inventing what came before.
- The chart is monthly and cached for six hours; the freshness line and the change feed for thirty minutes.

## `similar_products`

Products Torob considers comparable to the one you pass. This is the "that one is too expensive, what else?" call.

| Param | Type | Required | Notes |
|---|---|---|---|
| `prk` | string | **yes** | A product id this server has already returned |
| `details_url` | string | no | The `details_url` from the same card; proves the id is real without any lookup |
| `limit` | number | no | How many (default 10, max 24) |

Returns `prk`, `found`, `products[]` (cards, same shape as search), and a `note` saying whether to call `product_details` next. Cards carry the cheapest offer only.

The product must be one this server has already returned. Torob cannot look a product up by id alone, so the id is confirmed first from what this server knows - and the error says to search first rather than failing silently.

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
| `query` | string | **yes** | The item the user wants. A نیم‌فاصله is searched as a space |
| `budget_toman` | number | no | Maximum price in Toman. Unset = just rank in stock |
| `sort` | string | no | Any of `popularity`, `price`, `expensive`, `newest`, `sellers` (default `popularity`) |
| `include_delivery` | boolean | no | Also read stated postage for the cheapest picks (up to 3) and report the delivered price. Costs extra upstream requests |
| `limit` | number | no | How many picks (default 5, max 15) |

Returns: `budget_toman`, `total_matches`, `total_matches_note`, `matches_in_budget`, `out_of_stock_excluded`, `best_value`, `picks[]`, `attribution`. With `include_delivery`, also `delivered[]` (each `{prk, name_fa, cheapest_price_toman, cheapest_delivered_offer}`) and `delivery_note`.

With a budget the picks are sorted by price; without one they keep relevance order, because "best" without a number usually means "most relevant that is actually in stock".

When nothing fits, `best_value` is `null` and `budget_note` says so - including what the cheapest in-stock result actually was, so the answer is not a dead end. `suggested_queries` may also be present.

## `shop_profile`

One Torob shop as Torob itself profiles it - trust, contact terms and (on request) everything it sells. This is the "is this seller any good?" call.

| Param | Type | Required | Notes |
|---|---|---|---|
| `shop_id` | string | **yes** | The numeric `shop_id` from a `product_details` offer, or from `find_shops` |
| `include_products` | boolean | no | Also list the shop's own catalogue. **Costs one extra upstream request** |
| `page` | number | no | Catalogue page, 1-based (default 1, max 20) |
| `limit` | number | no | How many catalogue cards (default 10, max 24) |

Returns the profile:

| Field | Notes |
|---|---|
| `shop_id`, `name`, `shop_type`, `city`, `province`, `address` | Who and where the shop is |
| `website`, `logo`, `is_marketplace`, `url` | Its own site, its logo, and its torob.com page |
| `status`, `active_since`, `active_time`, `last_updated` | Torob's own words (e.g. `"فعال"`, `"۵ ماه و ۳ هفته"`) |
| `score`, `score_percentile` | Torob's score and where the shop sits against the rest |
| `score_notes[]` | Torob's own sentences about this shop - **including any violation note**; quote them as sent |
| `trust_seal` | `{level, valid_until, notes[]}` - the enamad seal's level, its validity and its notes |
| `support` | `{schedule, badges[]}` - support hours and what it offers |
| `payment[]`, `delivery[]`, `about[]` | Payment and delivery terms, and the shop's own intro blocks |
| `guarantee` | Torob's guarantee status for this shop |

With `include_products`: `catalogue_count` (how many products the shop lists), `catalogue_price_range_toman` (`{min, max}`), `catalogue_products[]` (the same card shape as a search), `catalogue_page`, `catalogue_has_next_page`, and `catalogue_truncated` / `catalogue_note` when the page held more than `limit`.

An empty `payment` or `delivery` means Torob sent none for that shop, not that the shop offers none. A shop with `score_notes` containing a violation line should be reported with it.

## `find_shops`

Find a **shop** - a business, not a product - by name, and optionally narrowed by city and type.

| Param | Type | Required | Notes |
|---|---|---|---|
| `query` | string | no | A shop name or part of one, e.g. `زوبین کالا`, `موبایل` |
| `city` | string | no | Delivery city id from `list_locations` - narrows to shops that deliver there (measured: 11,124 shops down to 7,182) |
| `shop_type` | string | no | `offline` (in-person sellers) · `online` |
| `page` | number | no | 1-based (default 1, max 20) |
| `limit` | number | no | How many (default 10, max 24) |

Returns `total_shops`, `page`, `has_next_page`, `shops[]` (each `id`, `name`, `city`, `shop_type`, `is_marketplace`, `logo`, `url`) and a `note`. **This is not a product list**: `search_products` is where products live, and a shop id here is what `shop_profile` wants next. A shop's own city can differ from the city filter, because the filter is about delivery.

## `search_by_image`

Find products from a picture. Pass a public image URL; Torob fetches it itself.

| Param | Type | Required | Notes |
|---|---|---|---|
| `image_url` | string | **yes** | A public `http(s)` URL. Nothing is uploaded from here, so the link has to be reachable from the internet |
| `page` | number | no | 1-based (default 1, max 20) |
| `limit` | number | no | How many cards (default 10, max 24 - the image search pages 24 at a time) |

Returns `image_url` (Torob's echo of what it looked at), `page`, `has_next_page`, `products[]` (cards), `matched_product` when Torob recognised the image as one specific product, `detected_objects[]` when it says what it saw, and a `note`.

Rules that are enforced: a non-URL or a non-`http(s)` URL is refused with a sentence, and an empty match says plainly that it is **not proof the product does not exist** - the picture may be unreachable, too small, or simply not in Torob's catalogue.

## `torob_trends`

What Torob's shoppers are searching **right now**.

| Param | Type | Required | Notes |
|---|---|---|---|
| `limit` | number | no | How many trending searches (default 10, max 30) |

Returns `count`, `trends[]` and a `note`. Each trend is `{query, category_id, sample}`, where `sample` is one product that wording currently returns - with the same card shape as a search, so its `prk` and `details_url` can be opened straight away.

This is **what people type**, not what Torob is promoting: for the featured deals use `special_offers`. Refreshed every 30 minutes.

## `browse_categories`

List the sub-categories of a category id, one level at a time. Torob has no "all categories" call, so this walks the tree.

| Param | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Parent category id. **`1` is the top level** |
| `limit` | number | no | How many children (default 20, max 30). **Enforced on the answer**: this endpoint ignores `size` upstream, so the cap is applied here - `count` describes what came back, and `has_more` says whether it may have been more |

Returns `parent_id`, `count`, `categories[]`, and `next` telling you where to go next. Each category: `id`, `title`, `slug`, `image`, `url`, `product_count`, `has_children`, `parent_id`.

`has_children` is derived from `product_count`, so it means "worth walking into" rather than "has sub-categories". A category id is also accepted by `search_products` as `category`.

## `list_locations`

Provinces, or a province's cities. City ids are what `search_products` accepts as `city`.

| Param | Type | Required | Notes |
|---|---|---|---|
| `province_id` | string | no | Given → that province's cities; omitted → the provinces |
| `search` | string | no | Filter by name, e.g. `تهران` |
| `limit` | number | no | How many (default 30 for cities, **all** provinces, max 200) |

Returns `mode` (`provinces` or `cities`), `count`, and `provinces[]` / `cities[]` with `id` and `name`. With only a `search` and no province, it searches cities nationwide. When a list is longer than `limit` (cities can be), the answer also carries `total`, `truncated` and a `note` saying how many were left out - `count` is what came back, not the whole set.

In provinces mode it also returns `popular_cities` - the cities Torob's own visitors pick most (تهران، مشهد، اصفهان، تبریز، شیراز) - so a city id does not have to be guessed. That hint costs one extra upstream request, cached for a day, and is omitted if it cannot be read.

## `special_offers`

The deals Torob is currently featuring. **This is merchandising, not shop data** - the banners point at campaigns, some off torob.com (TorobPay). It is not the seller list for a product; for that use `product_details`.

| Param | Type | Required | Notes |
|---|---|---|---|
| `limit` | number | no | How many (default 10, max 30) |

Returns `count` and `offers[]`: `group` (the campaign the banner belongs to), `title`, `description`, `image`, `url`. Refreshed every ten minutes.
