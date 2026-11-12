// The upstream base is configurable so a deployment that Torob challenges can be
// pointed at a relay. Measured 2026-10-09: an ordinary connection answered every
// request shape and twelve searches 1.5s apart, while a Cloudflare Worker drew a
// challenge on its third call of the minute - and a Worker's subrequests carry
// Cloudflare's own `Cf-Worker` header, which cannot be stripped. Measured
// 2026-10-12: the lever only changes which address Torob sees, and an address
// that is already blocked stays blocked - these tests keep the switch honest,
// not effective: it moves every upstream call (including the URLs handed out to
// callers), and a value that cannot be used fails loudly.
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

test("a URL outside the configured upstream is refused before fetching", async () => {
  const seen = capture();
  setUpstreamBase("https://relay.example");
  await assert.rejects(() => torobGet("https://images.torob.com/base/images/a.jpg"), /upstream origin/);
  assert.equal(seen.length, 0);
});

test("redirects are not followed or retried", async () => {
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    assert.equal(options.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "https://attacker.example/" } });
  };
  await assert.rejects(() => torobGet("/v4/search-trends/"), /redirect/);
  assert.equal(calls, 1);
});

test("an oversized streaming response is cancelled without retrying", async () => {
  let calls = 0;
  let cancelled = false;
  globalThis.fetch = async () => {
    calls++;
    let chunks = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (chunks++ < 20) controller.enqueue(new Uint8Array(1024 * 1024));
        else controller.close();
      },
      cancel() { cancelled = true; },
    }));
  };
  await assert.rejects(() => torobGet("/v4/search-trends/"), /response.*limit/i);
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});

test("upstream URLs reject credentials, HTTP and unexpected ports", async () => {
  const seen = capture();
  for (const url of ["http://api.torob.com/v4/", "https://api.torob.com:444/v4/", "https://user:pass@api.torob.com/v4/"]) {
    await assert.rejects(() => torobGet(url), /upstream origin/);
  }
  assert.equal(seen.length, 0);
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
