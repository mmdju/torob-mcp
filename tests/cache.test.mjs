// The cache holds raw upstream payloads, and one product's raw details payload
// measures ~1.4MB. A count-only cap (1000 entries) could therefore hold
// gigabytes on a Worker isolate that only gets 128MB, so the byte budget is the
// guard that matters. These tests set a tiny budget and watch it work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheSet, cached, cachedGet, cacheStatsForTests, setCacheLimitsForTests } from "../dist/cache.js";

test.afterEach(() => setCacheLimitsForTests(null));

test("the entry cap evicts the oldest entry, not the newest", () => {
  setCacheLimitsForTests({ maxEntries: 2, maxBytes: 1024 * 1024 });
  cacheSet("a", { v: 1 }, 60000);
  cacheSet("b", { v: 2 }, 60000);
  cacheSet("c", { v: 3 }, 60000);
  assert.equal(cachedGet("a"), undefined);
  assert.deepEqual(cachedGet("c"), { v: 3 });
  assert.equal(cacheStatsForTests().entries, 2);
});

test("the byte cap evicts by size, not by entry count", () => {
  setCacheLimitsForTests({ maxEntries: 1000, maxBytes: 300 });
  const value = { text: "x".repeat(100) };
  cacheSet("a", value, 60000);
  cacheSet("b", value, 60000);
  cacheSet("c", value, 60000);
  assert.equal(cachedGet("a"), undefined);
  assert.deepEqual(cachedGet("c"), value);
  assert.ok(cacheStatsForTests().bytes <= 300);
});

test("a value bigger than the whole budget is not cached at all", () => {
  // Caching it would evict everything and still not fit. Skipping it costs one
  // repeat fetch; emptying the cache costs every request.
  setCacheLimitsForTests({ maxEntries: 1000, maxBytes: 200 });
  cacheSet("small", { v: 1 }, 60000);
  const afterSmall = cacheStatsForTests();
  cacheSet("huge", { text: "x".repeat(500) }, 60000);
  assert.deepEqual(cachedGet("small"), { v: 1 });
  assert.equal(cachedGet("huge"), undefined);
  // The oversized value did not evict what fit: the store is exactly as it
  // was before the attempt.
  assert.deepEqual(cacheStatsForTests(), afterSmall);
});

test("concurrent readers of one key share a single upstream call", async () => {
  setCacheLimitsForTests({ maxEntries: 10, maxBytes: 1024 });
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return { n: calls };
  };
  const [a, b] = await Promise.all([cached("k", 60000, fn), cached("k", 60000, fn)]);
  assert.equal(calls, 1);
  assert.deepEqual(a, { n: 1 });
  assert.deepEqual(b, { n: 1 });
  // A later reader is served from the store, not the network.
  assert.deepEqual(await cached("k", 60000, fn), { n: 1 });
  assert.equal(calls, 1);
});

test("a value the caller refuses is answered but never stored", async () => {
  // The details path opens a product by a URL the caller echoes back, and that
  // URL can name a different product than the id it was asked about. The answer
  // still reaches the caller - the page really was opened - but filing it under
  // the wrong id would serve it later as that product, at that product's price.
  setCacheLimitsForTests({ maxEntries: 10, maxBytes: 1024 });
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return { random_key: "other" };
  };
  const accept = (v) => v.random_key === "x";
  assert.deepEqual(await cached("d:x", 60000, fn, { accept }), { random_key: "other" }, "the caller is answered");
  assert.equal(cachedGet("d:x"), undefined, "but the value is not filed under the id it disagreed with");
  await cached("d:x", 60000, fn, { accept });
  assert.equal(calls, 2, "so the next reader pays for a fresh fetch instead of inheriting the mismatch");
});

test("a value the caller accepts is stored, and the option is optional", async () => {
  setCacheLimitsForTests({ maxEntries: 10, maxBytes: 1024 });
  assert.deepEqual(await cached("plain", 60000, async () => ({ n: 1 })), { n: 1 });
  assert.deepEqual(cachedGet("plain"), { n: 1 });
  assert.deepEqual(
    await cached("checked", 60000, async () => ({ n: 2 }), { accept: () => true }),
    { n: 2 }
  );
  assert.deepEqual(cachedGet("checked"), { n: 2 });
});
