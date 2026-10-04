// Per-client request limit for the deployed Worker only.
//
// Why this is not in the server core: the limit defends one public service from
// being used as a free price API by a script, which is a fact about our
// deployment rather than about how the tools behave. tools.ts, project.ts,
// server.ts and the Node entry point know nothing about it, so a local run
// (`npm start`, `npm run dev`) stays unlimited.
//
// Where the count lives is the whole design. A per-colo cache - the store the
// server uses to share products between isolates - turned out to be useless for
// this: measured against the live Worker, fifty calls in a burst left it at
// "19 remaining", because Cloudflare spread those calls over two colos and each
// colo counted its own. A limit that a burst walks straight through is worse
// than no limit, because it looks like protection.
//
// So the count lives in a Durable Object, one per client (`idFromName`), which
// is a single instance for the whole world: whatever colo the request lands in,
// it reaches the same counter, and the numbers are exact. The window is kept in
// the object's own storage so an eviction mid-minute cannot reset it.
//
// Two fallbacks keep this from ever taking the service down: a colo cache, and
// an in-process map for runtimes with no Cache API at all (Node: the tests, and
// `npm start`). Both are weaker than the object and never fatal - the object is
// tried first, and any failure falls through to them.

// Twenty calls a minute is far above a real conversation - the fourteen tools
// take fourteen calls, plus the product and shop lookups a conversation leads
// to - and low enough that a script scraping prices through this service has to
// wait it out.
export const RATE_LIMIT_MAX = 20;
export const RATE_LIMIT_WINDOW_MS = 60_000;

const CACHE_PREFIX = "https://torob-mcp.internal/rate/";

export interface RateLimitVerdict {
  allowed: boolean;
  limit: number;
  /** Calls left in this window, 0 when the caller is over it. */
  remaining: number;
  /** Seconds until the window rolls over; 0 while the caller is under it. */
  retry_after_seconds: number;
}

// Who the caller is, as Cloudflare sees it. X-Forwarded-For is a fallback for a
// run that is not on Cloudflare; with neither header every caller shares one
// bucket, which is the safe direction to be wrong in.
export function clientKeyOf(req: Request): string {
  const direct = req.headers.get("cf-connecting-ip")?.trim();
  if (direct) return direct;
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

/** The parts of the Durable Object API this file uses, typed structurally. */
export interface DurableObjectStub {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

/**
 * Count one call for `key`: the Durable Object when the Worker is given one,
 * otherwise the weaker local counters. Never throws - a limiter that fails the
 * request it was meant to protect against is worse than a limiter that misses.
 */
export async function rateLimitFor(
  key: string,
  namespace?: DurableObjectNamespaceLike,
  now: number = Date.now()
): Promise<RateLimitVerdict> {
  if (namespace) {
    try {
      const stub = namespace.get(namespace.idFromName(`client:${key}`));
      const res = await stub.fetch("https://torob-mcp.internal/check", { method: "POST" });
      const body = (await res.json()) as Partial<RateLimitVerdict>;
      if (typeof body?.allowed === "boolean" && typeof body.remaining === "number") {
        return {
          allowed: body.allowed,
          limit: body.limit ?? RATE_LIMIT_MAX,
          remaining: body.remaining,
          retry_after_seconds: body.retry_after_seconds ?? 0,
        };
      }
    } catch {
      /* fall through to the colo cache and the in-process map */
    }
  }
  return checkRateLimit(key, now);
}

// ------------------------------------------------------------ local fallbacks

const memory = new Map<string, { count: number; expires: number }>();

/** Tests keep one process; without this the counter would leak between them. */
export function resetRateLimitForTests(): void {
  memory.clear();
}

function cacheStore(): Cache | undefined {
  return (globalThis as { caches?: { default?: Cache } }).caches?.default;
}

async function readCount(key: string, now: number): Promise<number> {
  const cache = cacheStore();
  if (cache) {
    try {
      const hit = await cache.match(`${CACHE_PREFIX}${key}`);
      return hit ? Math.max(0, Math.round(Number(await hit.text()) || 0)) : 0;
    } catch {
      /* fall through to the in-process map */
    }
  }
  const entry = memory.get(key);
  if (!entry) return 0;
  if (entry.expires <= now) {
    memory.delete(key);
    return 0;
  }
  return entry.count;
}

async function writeCount(key: string, count: number, now: number): Promise<void> {
  const ttlSeconds = Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);
  memory.set(key, { count, expires: now + RATE_LIMIT_WINDOW_MS });
  const cache = cacheStore();
  if (!cache) return;
  try {
    await cache.put(
      `${CACHE_PREFIX}${key}`,
      new Response(String(count), { headers: { "cache-control": `public, max-age=${ttlSeconds}` } })
    );
  } catch {
    /* the in-process map still has it */
  }
}

/** The verdict for a fixed one-minute bucket, shared by the object and the fallbacks. */
export function verdictFor(used: number, now: number): RateLimitVerdict {
  if (used >= RATE_LIMIT_MAX) {
    const bucket = Math.floor(now / RATE_LIMIT_WINDOW_MS);
    const resetInMs = (bucket + 1) * RATE_LIMIT_WINDOW_MS - now;
    return { allowed: false, limit: RATE_LIMIT_MAX, remaining: 0, retry_after_seconds: Math.max(1, Math.ceil(resetInMs / 1000)) };
  }
  return { allowed: true, limit: RATE_LIMIT_MAX, remaining: RATE_LIMIT_MAX - used - 1, retry_after_seconds: 0 };
}

/**
 * Count one call from `key` in whichever store this runtime has. The window is a
 * fixed minute bucket, not a sliding one: cheaper, and a caller who arrives at
 * the end of a bucket can spend two minutes' worth across the boundary, which
 * only matters to someone deliberately riding the edge.
 */
export async function checkRateLimit(key: string, now: number = Date.now()): Promise<RateLimitVerdict> {
  const bucket = Math.floor(now / RATE_LIMIT_WINDOW_MS);
  const windowKey = `${bucket}/${key}`;
  const used = await readCount(windowKey, now);
  const verdict = verdictFor(used, now);
  if (verdict.allowed) await writeCount(windowKey, used + 1, now);
  return verdict;
}
