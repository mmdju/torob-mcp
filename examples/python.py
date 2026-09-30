"""Minimal client for the hosted Torob MCP service (stdlib only).

No install: python examples/python.py

Talks Streamable HTTP the same way verify-live.mjs does: initialize,
list tools, call search_products + product_details, print compact cards.
Copy it into your own project and adapt freely (MIT).
"""
import json
import os
import sys
import time
import urllib.request

ENDPOINT = os.environ.get("TOROB_MCP_URL", "https://torob-mcp.mmdju.workers.dev/mcp")

# Torob challenges a client that calls too fast, so pace the calls.
GAP = 2.0


def rpc(method, params=None, rid=1):
    body = json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}).encode()
    req = urllib.request.Request(
        ENDPOINT,
        data=body,
        headers={
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
            "user-agent": "torob-mcp-client/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        text = res.read().decode("utf-8", "replace")
    payload = next(
        (line[5:].strip() for line in reversed(text.splitlines()) if line.startswith("data:")),
        text,
    )
    return json.loads(payload)


def call(name, arguments, rid):
    res = rpc("tools/call", {"name": name, "arguments": arguments}, rid=rid)
    time.sleep(GAP)
    return json.loads(res["result"]["content"][0]["text"])


def card_text(card):
    price = f"{card['price_toman']:,} Toman" if card.get("price_toman") else "not available"
    title = card.get("name_fa") or ""
    print(f"- {title} | {price} | {card.get('shop_name') or 'no shop'}")
    print(f"  {card.get('url')}")


def main():
    # Windows consoles default to cp1252 - Persian titles need UTF-8.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    init = rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                              "clientInfo": {"name": "py-client", "version": "1.0.0"}})
    print("server:", init["result"]["serverInfo"]["name"], init["result"]["serverInfo"]["version"])
    rpc("notifications/initialized", {}, rid=2)
    time.sleep(GAP)

    tools = rpc("tools/list", {}, rid=3)["result"]["tools"]
    print(f"tools: {len(tools)}")
    time.sleep(GAP)

    search = call("search_products", {"query": "قاب ایفون 13", "sort": "price", "limit": 3}, rid=4)
    items = search.get("products") or []
    for card in items:
        card_text(card)

    if not items:
        print("no results, stopping early")
        return

    # The seller list is the reason a Torob MCP exists - it needs its own call.
    prk = items[0]["prk"]
    details = call("product_details", {"prk": prk, "max_offers": 5}, rid=5)
    offers = details.get("offers") or []
    print(f"\ndetails prk={prk} | offers: {len(offers)} | spread: {details.get('price_spread_toman')}")
    for offer in offers:
        print(f"  {offer.get('shop_name')}: {offer.get('price_toman')} Toman"
              f" | score {offer.get('shop_score')} ({offer.get('shop_votes')} votes)")

    # A card carries the cheapest offer only; 0 upstream means out of stock,
    # never free - the server reports that as available: false, not a price.
    for card in items:
        assert not (card.get("price_toman") == 0 and card.get("available")), \
            "a 0 price was reported as available!"


if __name__ == "__main__":
    main()
