// The upstream base is configurable so a deployment that Torob challenges can be
// pointed at a relay. Measured 2026-10-09: an ordinary connection answered every
// request shape and twelve searches 1.5s apart, while a Cloudflare Worker drew a
// challenge on its third call of the minute - and a Worker's subrequests carry
// Cloudflare's own `Cf-Worker` header, which cannot be stripped. These tests keep
// the switch honest: it moves every upstream call (including the URLs handed out
// to callers), and a value that cannot be used fails loudly.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setPaceForTests } from "../dist/http.js";
import { setUpstreamBase, upstreamBaseUrl, UPSTREAM_BASE_ENV } from "../dist/http.js";
import { torobGet } from "../dist/http.js";

// The pacing gap is a fact about Torob, not about these assertions.
setPaceForTests(0);

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setUpstreamBase(null);
});

/** Capture the URL each call goes to, and answer with a minimal JSON body. */
function capture() {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  };
  return seen;
}

test("with nothing configured, calls go to Torob's own API", async () => {
  const seen = capture();
  assert.equal(upstreamBaseUrl(), "https://api.torob.com");
  await torobGet("/v4/base-product/search/?q=x");
  assert.equal(seen[0], "https://api.torob.com/v4/base-product/search/?q=x");
});

test("a relay takes every upstream call", async () => {
  const seen = capture();
  setUpstreamBase("https://relay.example/");
  assert.equal(upstreamBaseUrl(), "https://relay.example");
  await torobGet("/v4/base-product/search/?q=x");
  assert.equal(seen[0], "https://relay.example/v4/base-product/search/?q=x");
});

test("a details_url handed out earlier follows the relay too", async () => {
  // The card's details_url is the one path that needs no server-side memory: a
  // caller passes it straight back. Left on Torob's host it would be the single
  // call that meets the wall the relay exists to avoid.
  const seen = capture();
  setUpstreamBase("https://relay.example");
  await torobGet("https://api.torob.com/v4/base-product/details/?search_id=s1&prk=abc");
  assert.equal(seen[0], "https://relay.example/v4/base-product/details/?search_id=s1&prk=abc");
});

test("a URL on some other host is left alone", async () => {
  const seen = capture();
  setUpstreamBase("https://relay.example");
  await torobGet("https://images.torob.com/base/images/a.jpg");
  assert.equal(seen[0], "https://images.torob.com/base/images/a.jpg");
});

test("the switch is reversible, and an empty value means Torob", async () => {
  const seen = capture();
  setUpstreamBase("https://relay.example");
  setUpstreamBase("");
  assert.equal(upstreamBaseUrl(), "https://api.torob.com");
  await torobGet("/v4/search-trends/");
  assert.equal(seen[0], "https://api.torob.com/v4/search-trends/");
});

test("a value that cannot be used is refused with the variable's name", () => {
  assert.throws(() => setUpstreamBase("relay.example"), new RegExp(UPSTREAM_BASE_ENV));
  assert.throws(() => setUpstreamBase("http://relay.example"), /must use https/);
  // Refused, and the base is untouched - a bad value must not half-apply.
  assert.equal(upstreamBaseUrl(), "https://api.torob.com");
});
