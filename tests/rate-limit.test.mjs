// The hosted Worker answers at most twenty /mcp calls a minute per client, and
// only /mcp: the pages and /health stay open, because a browser locked out of the
// page that explains the limit is worse than the limit. The server core has no
// such rule, which is what the last test here pins down.
//
// Node has no Cache API, so these exercise the in-process fallback - the same
// path `npm run dev` takes when the cache is unavailable.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../dist/worker.js";
import { checkRateLimit, clientKeyOf, RATE_LIMIT_MAX, rateLimitFor, resetRateLimitForTests } from "../dist/rate-limit.js";
import { RateLimiter } from "../dist/worker.js";

test.afterEach(() => resetRateLimitForTests());

const at = 1_700_000_000_000; // any fixed instant: the window must be exact in tests

test("twenty calls a minute are allowed and the twenty-first is not", async () => {
  for (let i = 0; i < RATE_LIMIT_MAX; i++) {
    const verdict = await checkRateLimit("1.2.3.4", at);
    assert.equal(verdict.allowed, true, `call ${i + 1} should be allowed`);
    assert.equal(verdict.remaining, RATE_LIMIT_MAX - i - 1);
  }
  const blocked = await checkRateLimit("1.2.3.4", at);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retry_after_seconds >= 1 && blocked.retry_after_seconds <= 60, `retry-after was ${blocked.retry_after_seconds}`);
});

test("another client has its own window", async () => {
  for (let i = 0; i < RATE_LIMIT_MAX; i++) await checkRateLimit("1.2.3.4", at);
  const other = await checkRateLimit("5.6.7.8", at);
  assert.equal(other.allowed, true);
  assert.equal(other.remaining, RATE_LIMIT_MAX - 1);
});

test("the window rolls over after a minute", async () => {
  for (let i = 0; i < RATE_LIMIT_MAX; i++) await checkRateLimit("1.2.3.4", at);
  assert.equal((await checkRateLimit("1.2.3.4", at)).allowed, false);
  const nextMinute = await checkRateLimit("1.2.3.4", at + 60_000);
  assert.equal(nextMinute.allowed, true);
  assert.equal(nextMinute.remaining, RATE_LIMIT_MAX - 1);
});

test("the client key is the address Cloudflare reports", () => {
  const cf = new Request("https://torob-mcp.test/mcp", { headers: { "cf-connecting-ip": "9.9.9.9" } });
  assert.equal(clientKeyOf(cf), "9.9.9.9");
  const proxied = new Request("https://torob-mcp.test/mcp", { headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" } });
  assert.equal(clientKeyOf(proxied), "9.9.9.9");
  // No header at all is still a bucket rather than a crash.
  assert.equal(clientKeyOf(new Request("https://torob-mcp.test/mcp")), "unknown");
});

test("POST /mcp is the only path the limit touches", async () => {
  const post = (ip) =>
    worker.fetch(new Request("https://torob-mcp.test/mcp", { method: "POST", headers: { "cf-connecting-ip": ip }, body: "{}" }));
  for (let i = 0; i < RATE_LIMIT_MAX; i++) {
    const res = await post("9.9.9.9");
    assert.notEqual(res.status, 429, `POST ${i + 1} was limited early`);
    assert.equal(res.headers.get("x-ratelimit-limit"), String(RATE_LIMIT_MAX));
  }
  const blocked = await post("9.9.9.9");
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
  const body = await blocked.json();
  assert.match(body.error.message, /at most 20 \/mcp calls a minute/);
  assert.match(body.error.message, /self-hosted run has none/);

  // Everything else keeps answering for the same client.
  const health = await worker.fetch(new Request("https://torob-mcp.test/health", { headers: { "cf-connecting-ip": "9.9.9.9" } }));
  assert.equal(health.status, 200);
  const landing = await worker.fetch(new Request("https://torob-mcp.test/", { headers: { "cf-connecting-ip": "9.9.9.9" } }));
  assert.equal(landing.status, 200);
  const page = await worker.fetch(new Request("https://torob-mcp.test/mcp", { headers: { "cf-connecting-ip": "9.9.9.9" } }));
  assert.equal(page.status, 200);

  // A different client is unaffected by that.
  assert.notEqual((await post("8.8.8.8")).status, 429);
});

// The deployed Worker counts in a Durable Object instead: one instance per
// client, so the number is the same whatever colo the call arrives in. The
// cache-based counters above are only its fallback.
function fakeStorage() {
  const map = new Map();
  return {
    async get(key) {
      return map.get(key);
    },
    async put(key, value) {
      map.set(key, value);
    },
  };
}

const verdictOf = async (limiter) => (await limiter.fetch()).json();

test("the object counts exactly and keeps counting after an eviction", async () => {
  const storage = fakeStorage();
  const limiter = new RateLimiter({ storage });
  for (let i = 0; i < RATE_LIMIT_MAX; i++) {
    const verdict = await verdictOf(limiter);
    assert.equal(verdict.allowed, true, `call ${i + 1} should be allowed`);
    assert.equal(verdict.remaining, RATE_LIMIT_MAX - i - 1);
  }
  const blocked = await verdictOf(limiter);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retry_after_seconds >= 1 && blocked.retry_after_seconds <= 60);

  // A new object over the same storage - an eviction, or the same client
  // arriving in another colo - must not hand out a fresh window.
  const afterEviction = await verdictOf(new RateLimiter({ storage }));
  assert.equal(afterEviction.allowed, false);
});

test("the object is asked first, and the local counter is the fallback", async () => {
  const seen = [];
  const working = {
    idFromName: (name) => name,
    get: () => ({
      fetch: async (url) => {
        seen.push(url);
        return new Response(JSON.stringify({ allowed: false, limit: 20, remaining: 0, retry_after_seconds: 30 }), {
          headers: { "content-type": "application/json" },
        });
      },
    }),
  };
  const verdict = await rateLimitFor("1.2.3.4", working);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.retry_after_seconds, 30);
  assert.match(seen[0], /torob-mcp\.internal/);

  // A limiter that cannot reach its object must not fail the request it was
  // meant to protect: the counter answers instead.
  const broken = { idFromName: () => "x", get: () => ({ fetch: async () => { throw new Error("no such object"); } }) };
  const fellBack = await rateLimitFor("5.5.5.5", broken);
  assert.equal(fellBack.allowed, true);
  assert.equal(fellBack.remaining, RATE_LIMIT_MAX - 1);
  const nonsense = { idFromName: () => "x", get: () => ({ fetch: async () => new Response("not json") }) };
  assert.equal((await rateLimitFor("6.6.6.6", nonsense)).allowed, true);
});

test("the Node HTTP server has no limiter", async () => {
  // index.ts imports the server core, not rate-limit.ts: if that ever changes,
  // a self-hosted run would start refusing its own calls after 20 a minute.
  const fs = await import("node:fs/promises");
  const index = await fs.readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(index, /rate-limit/, "index.ts must not import the Worker-only limiter");
  const core = await fs.readFile(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.doesNotMatch(core, /rate-limit/, "server.ts must not know about the limiter");
});
