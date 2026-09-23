// The circuit breaker is what stops a burst from becoming a longer block, so
// it is tested as behaviour rather than as an implementation detail: a
// challenged response must cost exactly one upstream call, and the calls
// behind it must cost none.
//
// This file installs its own global fetch for the whole run. Node's test runner
// executes these files in one process, so the stub is installed in a `before`
// hook and the original is restored in `after` - otherwise it would answer for
// the other test files too.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { breakerRemainingMs, resetBreakerForTests, setPaceForTests, setRetryDelayForTests } from "../dist/http.js";
import { TOOLS } from "../dist/tools.js";

setPaceForTests(0);
setRetryDelayForTests(0);

const realFetch = globalThis.fetch;
let calls = 0;
let mode = "challenge";

before(() => {
  globalThis.fetch = async () => {
    calls++;
    if (mode === "challenge") return new Response("<html>arcaptcha</html>", { status: 490 });
    return new Response(JSON.stringify({ results: [], count: 0, next: "" }), {
      headers: { "content-type": "application/json" },
    });
  };
});

after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  resetBreakerForTests();
  calls = 0;
  mode = "challenge";
});

const run = (name, args) => TOOLS.find((t) => t.name === name).run(args);

test("a challenge is reported honestly and is not retried", async () => {
  await assert.rejects(() => run("search_products", { query: "x" }), /bot challenge/);
  // One request. Retrying a challenge is what deepens the block.
  assert.equal(calls, 1, "a challenge must cost exactly one upstream call");
});

test("the breaker stops the rest of a burst from calling upstream at all", async () => {
  await assert.rejects(() => run("search_products", { query: "x" }));
  const afterFirst = calls;
  assert.equal(afterFirst, 1);

  // Everything behind it fails without spending a request - which is the whole
  // point: the burst that caused the challenge is not extended by the retries.
  for (const q of ["y", "z", "w"]) {
    await assert.rejects(() => run("search_products", { query: q }), /challenged this worker recently/);
  }
  assert.equal(calls, afterFirst, "calls during the cooldown must not reach Torob");
});

test("the cooldown message says when to come back, not just that it failed", async () => {
  await assert.rejects(() => run("search_products", { query: "x" }));
  await assert.rejects(() => run("search_products", { query: "x" }), /retry in about \d+ minute/);
});

test("the breaker expires, so a later call gets a clean chance", async () => {
  await assert.rejects(() => run("search_products", { query: "x" }));
  assert.ok(breakerRemainingMs() > 0, "breaker should be open after a challenge");
  assert.ok(breakerRemainingMs() <= 5 * 60_000, "breaker should not last longer than its window");

  resetBreakerForTests();
  assert.equal(breakerRemainingMs(), 0);

  // With the breaker cleared and upstream healthy again, the call goes through.
  mode = "ok";
  const out = await run("search_products", { query: "x" });
  assert.equal(out.products.length, 0);
});

test("an empty result upstream is not treated as a challenge", async () => {
  mode = "ok";
  const out = await run("search_products", { query: "x" });
  assert.deepEqual(out.products, []);
  assert.equal(breakerRemainingMs(), 0);
});
