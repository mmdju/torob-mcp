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
import { breakerRemainingMs, expireWallForTests, forgetLocalWallForTests, resetBreakerForTests, setPaceForTests, setRetryDelayForTests } from "../dist/http.js";
import { installFileStore, uninstallFileStore } from "../dist/store-node.js";
import { setStoreBackend } from "../dist/store.js";
import { TOOLS } from "../dist/tools.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setPaceForTests(0);
setRetryDelayForTests(0);

const realFetch = globalThis.fetch;
let calls = 0;
let mode = "challenge";
// The gate is only worth testing with a real store behind it: the whole point
// is that it outlives the process that discovered the wall.
let storeDir = "";

before(() => {
  storeDir = mkdtempSync(join(tmpdir(), "torob-mcp-wall-"));
  installFileStore({ dir: storeDir });
  globalThis.fetch = async () => {
    calls++;
    if (mode === "challenge") return new Response("<html>arcaptcha</html>", { status: 490 });
    if (mode === "notfound") return new Response("gone", { status: 404 });
    return new Response(JSON.stringify({ results: [], count: 0, next: "" }), {
      headers: { "content-type": "application/json" },
    });
  };
});

after(() => {
  globalThis.fetch = realFetch;
  uninstallFileStore();
  rmSync(storeDir, { recursive: true, force: true });
});

// The local state is wiped by hand and so is the shared one - otherwise the
// challenge from one test would stop the next from spending a request at all,
// which is exactly the behaviour being tested.
beforeEach(async () => {
  await resetBreakerForTests();
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
    await assert.rejects(() => run("search_products", { query: q }), /challenged this server recently/);
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

  await resetBreakerForTests();
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

test("a 404 upstream is reported at once instead of being retried", async () => {
  // The retry loop exists for blips. A 4xx is the answer, not a blip: the same
  // status will come back on every attempt, and the throw that said so used to
  // land in the retry catch below it - four round trips and twelve seconds for
  // a product that does not exist.
  mode = "notfound";
  await assert.rejects(() => run("search_products", { query: "پیدا-نمی‌شود" }), /HTTP 404/);
  assert.equal(calls, 1, "a 4xx answer cannot change on a retry, so it must cost one call");
});

test("a challenge is remembered after the process that found it is gone", async () => {
  await assert.rejects(() => run("search_products", { query: "wall-memory" }));
  assert.equal(calls, 1);

  // What a fresh isolate, or the next run of the local server, sees: nothing
  // in memory at all - while the shared copy is left exactly where it was.
  forgetLocalWallForTests();
  assert.equal(breakerRemainingMs(), 0);

  // ...and the stored state still stops the call before it reaches Torob. This
  // is the difference between one wasted request and one per isolate.
  await assert.rejects(() => run("search_products", { query: "wall-memory-2" }), /challenged this server/);
  assert.equal(calls, 1, "a fresh isolate must not spend a request rediscovering the wall");
});

test("a burst that arrives together costs one upstream request", async () => {
  const results = await Promise.allSettled(
    ["a", "b", "c", "d"].map((q) => run("search_products", { query: q }))
  );
  assert.equal(calls, 1, "callers arriving together must queue behind the first challenge");
  assert.ok(
    results.every((r) => r.status === "rejected"),
    "every one of them must report the challenge rather than an empty answer"
  );
});

test("a repeat challenge earns the long stage instead of the short one", async () => {
  await assert.rejects(() => run("search_products", { query: "wall-stage" }));
  const stageOne = breakerRemainingMs();
  assert.ok(stageOne > 0, "the first challenge closes the gate");
  assert.ok(stageOne <= 5 * 60_000, "the first stage is the short one");

  // The stage lapses on its own, which is the only way to reach the second
  // stage without waiting half an hour - and the probe costs one request.
  await expireWallForTests();
  await assert.rejects(() => run("search_products", { query: "wall-stage-2" }));
  assert.equal(calls, 2, "one probe per stage");

  const stageTwo = breakerRemainingMs();
  assert.ok(stageTwo > stageOne, "a repeat challenge must not get the short stage again");
  assert.ok(stageTwo <= 30 * 60_000, "but it stays bounded");
});

test("a lapsed stage still carries its strike forward to whatever runs next", async () => {
  // Measured on the live service 2026-10-04: the gate kept answering "retry in
  // about 3 minute(s)" long after a first challenge - it was restarting the
  // short stage every time, because the process that reached the probe had no
  // memory of the strike. That is the wasted probe this gate exists to prevent.
  await assert.rejects(() => run("search_products", { query: "strike-a" }));
  assert.ok(breakerRemainingMs() > 0, "the first challenge closes the gate");

  // The stage runs out on its own, and this is no longer the process that saw
  // it: the local view is empty and only the store remembers.
  await expireWallForTests();
  forgetLocalWallForTests();
  assert.equal(breakerRemainingMs(), 0, "the gate is open, so the probe goes through");

  await assert.rejects(() => run("search_products", { query: "strike-b" }));
  assert.ok(
    breakerRemainingMs() > 5 * 60_000,
    `a repeat challenge must earn the long stage, not restart the short one (got ${breakerRemainingMs()}ms)`
  );
});

test("the record of a challenge outlives the stage it describes", async () => {
  // The other half of the same bug: the stored record carried a lifetime tied
  // to its own stage, so a first-stage record was gone seven minutes later -
  // by which time the probe that needs its strike count arrives and reads
  // nothing. A record that cannot be read cannot escalate anything.
  const writes = [];
  setStoreBackend({
    get: async () => undefined,
    set: async (key, _value, ttl) => {
      writes.push({ key, ttl });
    },
  });
  try {
    await assert.rejects(() => run("search_products", { query: "ttl-probe" }));
    const wall = writes.find((w) => w.key === "wall");
    assert.ok(wall, "a challenge must be written to the store");
    assert.ok(
      wall.ttl > (30 * 60_000) / 1000,
      `the record must outlive the longest stage; got ${wall.ttl}s`
    );
  } finally {
    // Put the real file backend back exactly as `before` left it.
    uninstallFileStore();
    installFileStore({ dir: storeDir });
  }
});

test("an answer that is not a challenge reopens the gate", async () => {
  await assert.rejects(() => run("search_products", { query: "wall-reopen" }));
  await expireWallForTests();

  mode = "ok";
  const out = await run("search_products", { query: "wall-reopen" });
  assert.equal(out.products.length, 0);
  assert.equal(breakerRemainingMs(), 0, "a real answer proves we are through");
});
