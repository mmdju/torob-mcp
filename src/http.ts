// One polite HTTP entry point for the whole server.
//
// The thing that shapes this file: Torob does not throttle with HTTP 429. When
// it wants to prove you are not a bot it answers 490 and returns an arCAPTCHA
// page where the JSON should be. A client that treats that as "no results"
// silently reports an empty market, which is the worst possible answer to
// "where is this cheapest?" - so a 490 is recognised here and raised as an
// actionable error instead of being parsed, retried, or swallowed.
//
// The wall is IP-reputation based, and a Cloudflare Worker's own egress is not
// challenged (measured: 8 sequential live searches, all 200). A 490 therefore
// means something changed - a rate spike, a different egress, or a policy
// change - not a transient blip. It is never retried.

import {
  CHALLENGED_MSG,
  FETCH_TIMEOUT_MS,
  MAX_RETRIES,
  MIN_GAP_MS,
  RETRY_DELAY_MS,
  SOURCE,
  TOROB_API,
  UA,
} from "./config.js";

// Tests stub fetch with fake challenge pages; waiting 2s x N retries per test
// would make the suite crawl. Tests set this to a few ms.
let testRetryDelay: number | null = null;
export function setRetryDelayForTests(ms: number | null): void {
  testRetryDelay = ms;
}
const retryDelay = (attempt: number) =>
  testRetryDelay ?? RETRY_DELAY_MS * (attempt + 1);

// Tests also shrink the pacing gap.
let testGapMs: number | null = null;
export function setPaceForTests(ms: number | null): void {
  testGapMs = ms;
}

export class UpstreamError extends Error {
  kind: "challenged" | "http" | "network" | "usage";
  status?: number;
  constructor(message: string, kind: UpstreamError["kind"], opts?: { status?: number }) {
    super(message);
    this.kind = kind;
    if (opts?.status !== undefined) this.status = opts.status;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Serialized pacing: every call waits its turn and then holds the slot, so
// parallel tool calls cannot produce a burst even if the agent fires many.
let nextSlot = 0;
async function pace(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + (testGapMs ?? MIN_GAP_MS);
  if (wait > 0) await sleep(wait);
}

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// Torob identifies its JSON API by the content type it answers with. A 200 that
// returns HTML is a challenge wearing a success code, so the body is checked,
// not just the status.
function looksLikeChallenge(res: Response, body: string): boolean {
  if (res.status === 490) return true;
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("json")) return false;
  return /arcaptcha|ربات هستید|captcha/i.test(body.slice(0, 4000));
}

/**
 * Call the Torob API and return parsed JSON.
 *
 * @param path Absolute URL, or a path relative to the API base.
 * @param opts.searchId Attached to the cache key so two searches with the same
 *   text but different tracking ids do not collide.
 */
export async function torobGet<T = unknown>(
  path: string,
  opts?: { retries?: number; searchId?: string }
): Promise<T> {
  const url = path.startsWith("http") ? path : `${TOROB_API}${path}`;
  const retries = opts?.retries ?? MAX_RETRIES;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    await pace();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          Referer: "https://torob.com/",
          Origin: "https://torob.com",
          source: SOURCE,
        },
        signal: controller.signal,
      });
      const body = await res.text();

      // A challenge is never retried: solving it is not this server's job and
      // hammering the endpoint while it is up is how a temporary block becomes
      // a permanent one.
      if (looksLikeChallenge(res, body)) {
        throw new UpstreamError(CHALLENGED_MSG, "challenged", { status: res.status });
      }

      if (!res.ok) {
        lastError = new UpstreamError(
          `Torob answered HTTP ${res.status}. ${res.status === 404 ? "That product or category does not exist upstream." : "Retry shortly."}`,
          "http",
          { status: res.status }
        );
        // 4xx is the caller's fault, not a blip: 404 for a deleted product must
        // not be retried three times, and other 4xx are the same class.
        if (res.status < 500 && res.status !== 429) throw lastError;
        if (attempt < retries) {
          await sleep(retryDelay(attempt));
          continue;
        }
        throw lastError;
      }

      try {
        return JSON.parse(body) as T;
      } catch {
        throw new UpstreamError(
          "Torob returned a success status with a body that is not JSON. The API shape may have changed.",
          "http",
          { status: res.status }
        );
      }
    } catch (err) {
      if (err instanceof UpstreamError && (err.kind === "challenged" || err.kind === "usage")) throw err;
      lastError = err;
      if (attempt < retries) {
        await sleep(retryDelay(attempt));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastError instanceof UpstreamError) throw lastError;
  const aborted = errText(lastError).includes("abort");
  throw new UpstreamError(
    aborted
      ? `Torob did not answer within ${FETCH_TIMEOUT_MS / 1000}s. Retry shortly.`
      : `Could not reach Torob: ${errText(lastError)}`,
    "network"
  );
}
