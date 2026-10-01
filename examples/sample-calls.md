# Sample calls

Conversation flows, end to end. See [tools.md](../docs/tools.md) for the full
input/output reference.

## "قاب گوشی ارزون بخرم"

Wording first, then the buy.

```
torob_suggest   { "query": "قاب گوشی" }
→ suggestions: ["قاب گوشی", "قاب گوشی سامسونگ", "قاب ایفون 13", ...]

search_products { "query": "قاب ایفون 13", "sort": "price", "limit": 5 }
→ total_matches: 1200
  best: قاب سیلیکونی … 99000 تومان (در ۱۹ فروشگاه)

product_details { "prk": "f6fbe3b3-…", "max_offers": 5 }
→ offer_count: 19
  price_spread_toman: 240000
  cheapest_offer:  { shop_name: "…", price_toman: 99000, shop_score: 5 }
```

The search card said "cheapest is 99000". The details call is what tells the
user *who* sells it and how much the price varies between shops.

## "این گوشی رو کجا ارزون‌تره؟"

```
search_products  { "query": "آیفون 13 پرو" }
→ pick the prk the user means

product_details  { "prk": "57ea65ae-…" }
→ offer_count: 31
  price_spread_toman: 78100000
  cheapest_offer: استور آرمین — 105,900,000 تومان
  best_rated_offer: موبایل شاد — 113,500,000 تومان

cheapest_vs_best_rated:
  "Cheapest is استور آرمین at 105,900,000 تومان; the best rated available shop
   is موبایل شاد (score 5, 0 votes) at 113,500,000 تومان."
```

A 78,100,000 Toman spread on one product is the whole point of a
price-comparison source, and no single search card shows it.

## "بین این دوتا کدومو بگیرم؟"

```
compare_products { "prks": ["prk-1", "prk-2"] }
→ compared: 2
  cheapest_overall: { name: "…", price: 799000 }
  price_difference_toman: 113811000
  products: [ { seller_count: 1, … }, { seller_count: 64, … } ]
```

`seller_count` matters as much as price: 64 sellers means the price is
competitive, one seller means it is whatever that shop decided.

## "زیر ۱۰ میلیون یه هدفون خوب هست؟"

```
find_best_value { "query": "هدفون", "budget_toman": 10000000, "limit": 3 }
→ matches_in_budget: 23
  out_of_stock_excluded: 0
  best_value: { name_fa: "هدفون بی‌سیم مدل P47", price_toman: 238970, shop_name: "…" }
```

`out_of_stock_excluded` is reported so the agent does not have to count the
dead rows itself, and cannot quietly recommend something unavailable.

## "فقط از فروشگاه‌های آنلاین بخر"

The first search tells you which filters *this* search accepts, so you never
guess a slug.

```
search_products { "query": "ماشین اصلاح مو", "limit": 3 }
→ available_filters: [ { title: "نوع فروشگاه", slug: "shop_type", … }, … 30 groups ]

search_products { "query": "ماشین اصلاح مو", "shop_type": "online" }
→ products: [ … ]   # only online sellers
```

If you pass a slug or a value that does not exist, the call is **refused with
the real ones** rather than quietly answering unfiltered - `available_filters`
carries each group's accepted `options`, and Torob itself ignores a slug or
value it does not know, so a typo there would otherwise look like a filtered
result.

## "چی الان تخفیف خورده؟"

```
special_offers { "limit": 5 }
→ offers: [ { name: "پیشنهاد شگفت‌انگیز", results: [ … ] }, … ]
```

Featured deals are merchandising, not a product's seller list - keep the two
apart, so "on deal" never gets mixed up with "cheap".

## Nothing found

```
search_products { "query": "شارژر بیسوس" }
→ products: []
  query_note: "Nothing matched 'شارژر بیسوس' on Torob. These are the wordings
               Torob's own search suggests - retry with one of them. An empty
               result is not proof the product does not exist."
  suggested_queries: ["شارژر بیسوس اصل", "شارژر بیسوسType-C", ...]
```

Retry with a suggestion. This is why the response carries one: an empty list
alone reads as "no such product", which is a claim nobody verified.

## Two things worth not doing

- **Do not name a shop from a search card.** The card's `shop_name` is who is
  cheapest right now, not a recommendation. Call `product_details` for the
  score and the rest of the list.
- **Do not present a `price_unreliable` offer as a bargain.** Torob is saying
  it cannot vouch for that number; pass the warning on.
