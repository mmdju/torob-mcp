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
| `torob_suggest` | vague wording to real search terms, categories, cities |
| `search_products` | browse products with the cheapest price in Toman |
| `product_details` | one product plus every seller offer, ranked by price |
| `compare_products` | 2-5 products side by side, on what actually differs |
| `find_best_value` | "best X under Y" - the strongest honest asking price |

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
- Not affiliated with or endorsed by Torob. Data comes from Torob's public
  web API.

## License

MIT. See [LICENSE](LICENSE).
