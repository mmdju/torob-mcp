// The shared store is what lets the local server remember across a restart
// both the product names it found and the wall Torob had put up. Either is
// lost the moment the file is not written, so the file is what is tested here:
// written, read back after a restart, expired on schedule, and survived when
// damaged.
//
// Every other test file runs with no backend at all, which is the state a
// Worker's isolate is in - so this file is also what proves that "no store"
// still behaves the way it always did.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setStoreBackend, storeGet, storeSet } from "../dist/store.js";
import { installFileStore, uninstallFileStore } from "../dist/store-node.js";
import { setPaceForTests, setRetryDelayForTests } from "../dist/http.js";
import { TOOLS } from "../dist/tools.js";

setPaceForTests(0);
setRetryDelayForTests(0);

const originalFetch = globalThis.fetch;

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "torob-mcp-store-"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  uninstallFileStore();
  setStoreBackend(null);
  rmSync(dir, { recursive: true, force: true });
});

test("with no backend and no Cache API nothing is remembered", async () => {
  setStoreBackend(null);
  assert.equal(await storeGet("anything"), undefined);
  // A write that cannot happen is swallowed, never raised: this layer can only
  // ever cost one extra lookup, so it must not be why a tool call fails.
  await storeSet("anything", { a: 1 }, 60);
  assert.equal(await storeGet("anything"), undefined);
});

test("what one run learns is still there for the next run", async () => {
  const file = installFileStore({ dir });
  await storeSet("product/abc", { name: "گوشی", url: "https://torob.com/p/abc/" }, 60 * 60);
  await storeSet("wall", { until: 123, openedAt: 45, strikes: 2 }, 1800);
  assert.ok(file && existsSync(file), "the store must leave a file behind");

  // A restart: drop the backend, then install against the same directory.
  uninstallFileStore();
  assert.equal(await storeGet("product/abc"), undefined, "nothing survives without a backend");

  const again = installFileStore({ dir });
  assert.equal(again, file, "the same directory resolves to the same file");
  assert.deepEqual(await storeGet("product/abc"), {
    name: "گوشی",
    url: "https://torob.com/p/abc/",
  });
  assert.deepEqual(await storeGet("wall"), { until: 123, openedAt: 45, strikes: 2 });
  assert.equal(await storeGet("never-written"), undefined);
});

test("an entry is gone once its own TTL says so", async () => {
  // Written as a file rather than through the API so the moment of expiry is
  // decided by the test, not by however long a write took.
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      stale: { exp: Date.now() - 1000, v: "yesterday" },
      live: { exp: Date.now() + 60_000, v: "today" },
      immortal: { exp: 0, v: "no expiry set" },
    }),
    "utf8"
  );
  installFileStore({ dir });
  assert.equal(await storeGet("stale"), undefined, "an expired entry is dropped on read");
  assert.equal(await storeGet("live"), "today");
  assert.equal(await storeGet("immortal"), "no expiry set", "exp 0 means it never expires");
  assert.equal(await storeGet("never-written"), undefined);
});

test("a damaged file starts clean instead of failing the server", async () => {
  const file = installFileStore({ dir });
  writeFileSync(file, "{ not json at all", "utf8");
  uninstallFileStore();

  const again = installFileStore({ dir });
  assert.equal(again, file);
  assert.equal(await storeGet("anything"), undefined, "unreadable is treated as empty, not fatal");
  await storeSet("fresh", 1, 60);
  assert.equal(await storeGet("fresh"), 1, "and the store still works afterwards");
});

test("the file it writes holds what the next run reads", async () => {
  const file = installFileStore({ dir });
  await storeSet("k", { nested: [1, 2, 3] }, 60);
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(onDisk.k.v, { nested: [1, 2, 3] });
  assert.ok(onDisk.k.exp > Date.now(), "a live entry carries the moment it dies");
  assert.ok(existsSync(file), "and no temporary file is left behind");
});

test("what a search learns is still there for the run after it", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        results: [
          {
            random_key: "prk-store",
            name1: "گوشی ایفون ۱۳",
            price: 50000000,
            price_text: "۵۰٫۰۰۰٫۰۰۰ تومان",
            web_client_absolute_url: "/p/prk-store/",
            more_info_url: "https://api.torob.com/v4/base-product/details/?search_id=s1&prk=prk-store",
          },
        ],
        count: 1,
        next: "",
      }),
      { headers: { "content-type": "application/json" } }
    );

  installFileStore({ dir });
  await TOOLS.find((t) => t.name === "search_products").run({ query: "ایفون ۱۳" });

  const learned = await storeGet("product/prk-store");
  assert.ok(learned, "a search row's name and address must be remembered");
  assert.equal(learned.name, "گوشی ایفون ۱۳");
  assert.equal(
    learned.url,
    "https://api.torob.com/v4/base-product/details/?search_id=s1&prk=prk-store"
  );

  // A restart: nothing in memory, the file still knows. This is the difference
  // between opening the product in one hop and searching for it again.
  uninstallFileStore();
  installFileStore({ dir });
  assert.deepEqual(await storeGet("product/prk-store"), learned);
});
