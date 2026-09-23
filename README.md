# torob-mcp

MCP server for [Torob](https://torob.com) (ترب), Iran's price-comparison engine.
Read-only, no API key.

The source lives in the private repo `mmdju/torob-mcp-private`. This repository is
the public, docs-only showcase: tool reference, architecture and examples, with
no source code.

- [English docs](README.md) · [مستندات فارسی](README_FA.md)
- [Tool reference](docs/tools.md)
- [Architecture](docs/architecture.md)
- [Sample calls](examples/sample-calls.md)

## What it does

Torob aggregates offers from many shops into one product page. This server puts
that behind a handful of read-only tools, so an agent can answer "where is this
cheapest, and is that seller any good?" without scraping a single page.

| Tool | For |
|---|---|
| `torob_suggest` | vague wording to real search terms |
| `search_products` | browse products with the cheapest price in Toman, plus every filter the search accepts |
| `product_details` | one product plus every seller offer, ranked by price |
| `similar_products` | "that one is too expensive, what else?" |
| `compare_products` | 2-5 products side by side, on what actually differs |
| `find_best_value` | "best X under Y" - the strongest honest asking price |
| `browse_categories` | walk Torob's category tree |
| `list_locations` | province and city ids, for delivery filtering |
| `special_offers` | the deals Torob is featuring right now |

## Quick start

```json
{
  "mcpServers": {
    "torob": { "url": "https://torob-mcp.mmdju.workers.dev/mcp" }
  }
}
```

See [examples/mcp.json](examples/mcp.json) for the Claude Desktop and Cursor
shapes. Nothing to install and no key to obtain: the endpoint is public and
read-only.

## Honest limits

- Prices move constantly. Every product and offer carries its Torob URL so the
  user can confirm before buying.
- A search card shows the *cheapest* offer, not every offer. `product_details`
  is the call that lists all sellers.
- `price: 0` means out of stock upstream, not free. It is reported as
  `available: false`.
- Torob gates parts of its site behind a bot wall; this server reads only the
  JSON API and never solves or evades a challenge.
- Torob answers a client that calls too quickly with a challenge instead of
  data. It clears on its own after a few idle minutes; this server says so
  plainly and holds the rest of a burst rather than retrying into a longer
  block.
- An unknown filter slug is refused with the real ones, because Torob ignores an
  unknown slug and answers unfiltered.
- Not affiliated with or endorsed by Torob. Data comes from Torob's public
  web API.

## License

MIT. See [LICENSE](LICENSE).
