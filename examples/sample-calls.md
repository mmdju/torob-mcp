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
→ count: 5
  offers: [ { group: "پیشنهادهای ویژه", title: "خرید قسطی", description: "…",
              image: "https://…", url: "https://torobpay.com/?…" }, … ]
  note: "Torob's featured deals. For one product's sellers, use product_details instead."
```

Featured deals are merchandising, not a product's seller list - keep the two
apart, so "on deal" never gets mixed up with "cheap".

## "الان بخرم یا صبر کنم؟"

The chart is the part a price list cannot answer.

```
price_history { "prk": "ca10472a-…", "details_url": "…", "months": 12 }
→ window: { from: "۲۵ شهریور ۱۴۰۴", to: "۲۶ مرداد ۱۴۰۵", points: 12 }
  points_available: 54
  series: [ { label: "کمترین قیمت", latest: { date: "۲۶ مرداد ۱۴۰۵", value: 689999 } },
            { label: "میانگین قیمت", latest: { date: "۲۶ مرداد ۱۴۰۵", value: 1243456 } } ]
  reading: "Over the newest 12 monthly point(s) … the lowest figure Torob charts
            is 689٬999 Toman (۲۶ مرداد ۱۴۰۵) and the highest …"
  last_modified: "2026-09-30T20:33:05+00:00"
```

The series labels are Torob's own (average and lowest), so quote them. Today's
price comes from `product_details` - putting the two side by side is the honest
"buy now or wait" answer.

## "این محصول به درد من می‌خوره؟"

The chart says what it cost; Torob's own guide says what it is.

```
product_guide { "prk": "ca10472a-…", "details_url": "…" }
→ title: "هدفون جی بی ال مدل Tune 510 BT"
  sections: [ { heading: "نقاط قوت", text: "…" },
              { heading: "نقاط ضعف", text: "…" },
              { heading: "نظر خریداران", text: "…" } ]
  text_length: 3395
  guide_url: "https://torob.com/p/ca10472a-…/"
```

The headings and the wording are Torob's own, so quote them instead of turning
them into a verdict of your own. A product with no guide comes back with an
empty `sections[]` and a note saying so - that is Torob having nothing to say,
not a reason to write a review yourself.

## "این فروشنده معتبره؟"

Every offer carries a `shop_id`; that is the door into the shop's own profile.

```
product_details { "prk": "ca10472a-…", "max_offers": 3 }
→ cheapest_offer: { shop_name: "زوبین کالا", shop_id: "365234", price_toman: 689999 }

shop_profile { "shop_id": "365234" }
→ trust_seal: { level: "نماد بدون ستاره", valid_until: "اعتبار تا تاریخ ۱۴۰۶/۰۶/۱۷" }
  score: 4.9, active_time: "۵ ماه و ۳ هفته", status: "فعال"
  score_notes: [ "امتیاز: ۴.۹ از ۵", "…", "۲ پیگیری سفارش خاتمه یافته با وضعیت تخلف فروشگاه" ]

shop_profile { "shop_id": "365234", "include_products": true, "limit": 5 }
→ catalogue_count: 412
  catalogue_price_range_toman: { min: 47376, max: 18000000 }
```

`score_notes` is Torob's own text - including a violation note when there is
one. Report it as sent instead of smoothing it over.

## "حضوری هم می‌شه خرید؟"

The in-person shops ride along in the details response, so this costs no extra
call - but every shelf price carries its own age.

```
product_details { "prk": "ca10472a-…", "max_in_person": 3 }
→ in_person_count: 36
  in_person_sellers: [ { shop_name: "شهاب دیجیتال", city: "مشهد",
                         price_text: "۸۹۰٫۰۰۰ تومان", is_open: false,
                         hours_today: "تا ۰۹:۰۰ امروز",
                         last_price_change_date: "۸ ماه و ۹ روز پیش" }, … ]
  in_person_note: "These are shops selling this product in person. Each price is
                   the shop's own and can be old - …"
```

Say the age out loud ("قیمتش مال ۸ ماه پیشه") rather than presenting a shelf
price as today's.

## "این عکس چیه؟"

A picture link is enough - Torob fetches the image itself.

```
search_by_image { "image_url": "https://image.torob.com/base/images/8_/oJ/…jpg", "limit": 3 }
→ products: [ { name_fa: "هدفون بی‌سیم جی‌بی‌ال JBL Tune 530BT", price_text: "۱۱٫۰۲۰٫۰۰۰ تومان" }, … ]
  matched_product: { prk: "84069e65-…" }
```

`matched_product` is Torob recognising the exact item; the rest of the list is
what it considers similar. An empty match is not proof the product is missing.

## "مردم الان چی سرچ می‌کنن؟"

```
torob_trends { "limit": 5 }
→ trends: [ { query: "قیمت طلا 18", sample: { name_fa: "انگشتر طلا ۱۸ عیار", price_toman: 48543000 } }, … ]
```

A wording to seed a search with when the user has none of their own. Each
sample card keeps its `prk` and `details_url`, so it can be opened directly.

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
