// Response shapes for torob-mcp. Kept in step with docs/tools.md by hand.
//
// Read-only: these are the types an agent can rely on. Optional fields are
// present only when they carry information - see tools.md for when.

/** All prices are Toman. `null` means "not available", never 0. */
export type Toman = number;

/** One seller offer for a product. `products_info` upstream ("فروشنده‌ها"). */
export interface Offer {
  shop_name: string;
  shop_city: string | null;
  shop_id: string | null;
  /** 0-5, or null only when Torob sends no score. */
  shop_score: number | null;
  /** Torob sends 0 for nearly every offer even when it sends a score. */
  shop_votes: number;
  price_toman: Toman | null;
  price_text: string | null;
  /** Struck-through price when the shop had a discount. */
  was_price_text: string | null;
  available: boolean;
  /** Torob's own warning that this price cannot be trusted. */
  price_unreliable: boolean;
  free_shipping: boolean | null;
  payment_on_delivery: boolean | null;
  same_day_delivery: string | null;
  url: string | null;
  /** Torob's own ad flag for this offer. */
  is_adv: boolean;
  /** Torob's postage line as sent, e.g. "هزینه ارسال ۷۰٫۰۰۰ تومان". */
  postage_text: string | null;
  /** Postage parsed from that line; null when it is free or unstated. */
  postage_fee_toman: Toman | null;
  /** price_toman + stated postage; equals the price when postage is free. */
  delivered_price_toman: Toman | null;
  /** "enabled" / "disabled" from Torob's guarantee_info. */
  guarantee: string | null;
  /** Instalment (BNPL) providers Torob lists for this offer, by name. */
  installment_providers: string[];
  /** Persian relative time, e.g. "۲ ساعت پیش". */
  last_price_change_date: string | null;
  /** Whether the shop has a public Torob profile page. */
  has_public_torob_profile: boolean | null;
  /** The shop's percentile on Torob, 0-100, when sent. */
  shop_score_percentile: number | null;
}

/** A product as it appears in search results: the cheapest offer only. */
export interface ProductCard {
  prk: string;
  name_fa: string | null;
  name_en: string | null;
  price_toman: Toman | null;
  /** May start with «از» ("from") when the price is a floor, not a fixed price. */
  price_text: string | null;
  available: boolean;
  shop_name: string | null;
  image: string | null;
  image_count: number;
  badges: string[];
  url: string;
  /** Torob's ad flag for this row. */
  is_adv: boolean;
  /** Torob's own details URL for this row; pass it back as `details_url`. */
  details_url: string | null;
}

/** One product plus its full seller list. */
export interface ProductDetails extends ProductCard {
  offers: Offer[];
  offer_count: number;
  /** Cheapest minus dearest available offer. */
  price_spread_toman: Toman | null;
  cheapest_offer: Offer | null;
  /** The highest shop_score among available offers; ties break on votes. */
  best_rated_offer: Offer | null;
  /** Cheapest once stated postage is added. */
  cheapest_delivered_offer: Offer | null;
  /** How the id was found: remembered, details-url, exact-id, name-search, id-only. */
  resolved_by: string;
  attribution: string;
}

/** A filter group this search accepts. Read the slugs and options off these. */
export interface FilterGroup {
  title: string;
  /** Pass this back in search_products' `filters` object. */
  slug: string;
  type: string;
  /** How many values the group has. */
  values: number;
  /** The values to pass back; absent when the group takes none (a range). */
  options?: { name: string; value: string }[];
  /** True when `options` is a preview rather than the whole list. */
  options_truncated?: boolean;
  /** For grouped filters like brand, the endpoint that lists every value. */
  values_url?: string;
}

export interface SearchResponse {
  query: string;
  sort: "popularity" | "price" | "expensive" | "newest" | "sellers";
  sort_meaning: string;
  /** Present only when a filter was actually applied. */
  filters_applied?: Record<string, string>;
  total_matches: number;
  /** Torob's own count is approximate; page with has_next_page. */
  total_matches_note: string;
  page: number;
  page_count: number;
  has_next_page: boolean;
  price_range_toman: { min: Toman | null; max: Toman | null };
  products: ProductCard[];
  /** The filter groups this search really accepts - 30 on a typical query. */
  available_filters: FilterGroup[];
  attribution: string;
  /** Present when nothing matched: an empty result is not proof of absence. */
  query_note?: string;
  suggested_queries?: string[];
  /** Present when the page was out of range. */
  page_clamped?: boolean;
  page_requested?: number;
  page_note?: string;
}

export interface DetailsResponse {
  prk: string;
  name_fa: string | null;
  cheapest_price_toman: Toman | null;
  available: boolean;
  url: string;
  offer_count: number;
  price_spread_toman: Toman | null;
  cheapest_offer: Offer | null;
  best_rated_offer: Offer | null;
  cheapest_delivered_offer: Offer | null;
  resolved_by: string;
  /** Present when the cheapest and the best-rated are different shops. */
  cheapest_vs_best_rated?: string;
  /** Present when postage changes which shop is cheapest overall. */
  cheapest_vs_delivered?: string;
  offers: Offer[];
  attribution: string;
}

export interface CompareRow {
  prk: string;
  name_fa?: string | null;
  name_en?: string | null;
  available?: boolean;
  cheapest_price_toman?: Toman | null;
  seller_count?: number;
  price_spread_toman?: Toman | null;
  cheapest_shop?: string | null;
  cheapest_shop_score?: number | null;
  best_rated_shop?: string | null;
  best_rated_score?: number | null;
  url?: string;
  /** Present when this one product could not be read; the rest still answer. */
  error?: string;
}

export interface CompareResponse {
  compared: number;
  requested: number;
  products: CompareRow[];
  cheapest_overall?: { name: string; price: Toman };
  price_difference_toman?: Toman;
  partial_failure?: boolean;
  failed_note?: string;
}

export interface BestValueResponse {
  query: string;
  budget_toman: Toman | null;
  total_matches: number;
  /** Torob's own count is approximate; page with has_next_page. */
  total_matches_note: string;
  out_of_stock_excluded: number;
  matches_in_budget: number;
  best_value: ProductCard | null;
  picks: ProductCard[];
  /** Present with include_delivery: the cheapest picks with their postage. */
  delivered?: { prk: string; name_fa: string | null; cheapest_price_toman: Toman | null; cheapest_delivered_offer: Offer | null }[];
  delivery_note?: string;
  attribution: string;
  /** Present when nothing fit: says what the cheapest in-stock result was. */
  budget_note?: string;
  suggested_queries?: string[];
}

export interface SuggestResponse {
  query: string;
  suggestions: string[];
  next: string;
  /** Present when shop entries were dropped from the autocomplete answer. */
  note?: string;
}

export interface SimilarResponse {
  prk: string;
  found: number;
  products: ProductCard[];
  note: string;
}

export interface CategoryNode {
  id: string;
  title: string;
  slug: string | null;
  image: string | null;
  url: string | null;
  /** Products upstream has under this category. */
  product_count: number;
  /** Derived from product_count: whether it is worth walking into. */
  has_children: boolean;
  parent_id: string | null;
}

export interface CategoriesResponse {
  parent_id: string;
  count: number;
  categories: CategoryNode[];
  next: string;
  has_more?: boolean;
  note?: string;
}

export interface LocationsResponse {
  mode: "provinces" | "cities";
  count: number;
  provinces?: { id: string; name: string }[];
  cities?: { id: string; name: string; province_id: string | null }[];
  province_id?: string;
  search?: string;
  next?: string;
}

/** A featured banner. Merchandising, not shop data - some point off torob.com. */
export interface SpecialOffer {
  group: string | null;
  title: string | null;
  description: string | null;
  image: string | null;
  url: string | null;
}

export interface OffersResponse {
  count: number;
  offers: SpecialOffer[];
  note: string;
}
