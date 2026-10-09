// One polite HTTP entry point for the whole server.
//
// The thing that shapes this file: Torob does not throttle with HTTP 429. When
// it wants to prove you are not a bot it answers 490 and returns an arCAPTCHA
// page where the JSON should be. A client that treats that as "no results"
// silently reports an empty market, which is the worst possible answer to
// "where is this cheapest?" - so a 490 is recognised here and raised as an
// actionable error instead of being parsed, retried, or swallowed.
//
// The wall is rate/reputation based, and it reaches every egress we have
// measured: on 2026-10-04 a Cloudflare Worker and the dev machine were both
// challenged in the same hour, each after only one or two calls following a
// long idle. A 490 is therefore the answer, not a blip - it is never retried,
// and the gate below stops the calls behind it from spending a request to
// rediscover it.

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
import { storeGet, storeSet } from "./store.js";

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

// Where upstream calls go. The default is Torob's own API; an operator can point
// a deployment at a relay of their own with TOROB_API_BASE.
//
// The reason this exists, measured 2026-10-09: Torob's edge scores a client by
// *where it comes from*, not by what it sends. From an ordinary connection, five
// request shapes - the headers this server ships, a full Chrome header set, the
// site's own page cookies and no cookies at all - all answered JSON, and twelve
// searches 1.5s apart were all answered too. From Cloudflare's network the same
// calls were challenged after three: a scratch Worker running `wrangler dev
// --remote` got HTTP 490 with a 274KB arCAPTCHA page on its third search of the
// minute, while the identical next call from the machine beside it returned
// 49KB of JSON. A Worker subrequest also carries Cloudflare's own `Cf-Worker`
// header, which names the worker and cannot be removed (a header of the same
// name set in the fetch options arrives unchanged, beside it). Nothing here can
// hide that, so the honest escape hatch is a relay on a connection that is not
// scored as a bot: point this variable at it and every upstream call - and the
// `details_url` handed to callers - goes there instead.
let upstreamBase: string | null = null;

export const UPSTREAM_BASE_ENV = "TOROB_API_BASE";

/** Returns the message when `value` is not usable, null when it is. */
function upstreamBaseProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${UPSTREAM_BASE_ENV} must be an absolute URL, got '${value}'.`;
  }
  if (url.protocol !== "https:") {
    return `${UPSTREAM_BASE_ENV} must use https: a plain-http relay would put every search, price and product id on the wire in the clear.`;
  }
  return null;
}

/**
 * Point upstream calls at `value`, or back at Torob's own API with null/empty.
 * Throws on a value that cannot be used, so a misconfigured deployment fails at
 * the first request with the reason instead of quietly calling Torob anyway.
 */
export function setUpstreamBase(value?: string | null): void {
  const raw = (value ?? "").trim();
  if (!raw) {
    upstreamBase = null;
    return;
  }
  const problem = upstreamBaseProblem(raw);
  if (problem) throw new Error(problem);
  const url = new URL(raw);
  upstreamBase = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The base every upstream call is built on: the relay when one is set, else Torob. */
export function upstreamBaseUrl(): string {
  return upstreamBase ?? TOROB_API;
}

/**
 * The URL for one path, which may itself be a URL this server handed out
 * earlier - a card's `details_url` is exactly that, and a caller passes it back
 * to open a product with no server-side memory involved. With a relay set, those
 * URLs have to go through the relay too; leaving one on Torob's own host would
 * hand the challenge back to the single call the relay was configured for.
 */
function upstreamUrlFor(path: string): string {
  if (!path.startsWith("http")) return `${upstreamBaseUrl()}${path}`;
  if (upstreamBase && /^https?:\/\/api\.torob\.com(\/|$)/.test(path)) {
    return path.replace(/^https?:\/\/api\.torob\.com/, upstreamBase);
  }
  return path;
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

// One upstream call at a time, and the slot is held until that attempt ends.
//
// A pacing gap alone was not enough. A gap shorter than a response time still
// lets two fetches overlap, and - more to the point - a caller arriving while
// the call ahead of it is being answered would spend its own request on a wall
// that has just gone up. Holding the slot across the fetch closes both, which
// is what makes "a challenged burst costs exactly one request" true even when
// an agent fires several calls at once.
let tail: Promise<void> = Promise.resolve();
let nextSlot = 0;

async function acquireSlot(): Promise<() => void> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => (release = resolve));
  try {
    await previous;
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + (testGapMs ?? MIN_GAP_MS);
    if (wait > 0) await sleep(wait);
    // Checked here rather than only before the queue: by the time this caller
    // holds the slot, the call ahead of it may already have been challenged.
    const waiting = await wallRemainingMs();
    if (waiting > 0) throw wallClosed(waiting);
    return release;
  } catch (err) {
    // The tail was advanced above, so it has to be resolved here or every
    // caller queued behind this one waits forever.
    release();
    throw err;
  }
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

// ------------------------------------------------------------ the wall
//
// Measured 2026-09-24: Torob's edge answers a client that calls too often with
// a challenge instead of data, and the block then cleared after about five idle
// minutes. Re-measured 2026-10-03/04: the trigger is far lower - one or two
// requests rather than a burst - and one block took about twenty-seven minutes
// to clear. Left alone, every one of those challenges is a full upstream round
// trip that also deepens the block: a retry storm against a wall that punishes
// retries.
//
// So the first challenge closes a gate: later calls fail immediately with an
// honest "wait N minutes" message and send nothing. Three things make that hold
// beyond the process that discovered it:
//
//   - the state lives in `store.ts`, so another isolate in the same colo, or
//     the next run of the local server, inherits it instead of spending a fresh
//     request to rediscover a wall that is still up;
//   - the slot above is held while the gate is checked, so calls arriving
//     together cost one request rather than one each;
//   - a success opens the gate again, so a short block is not served its full
//     sentence - subject to the check below, which keeps a response that was
//     already in flight when the challenge arrived from opening it early.
//
// Two stages, because the two measurements differ by more than an order of
// magnitude: a short first stage so a short block is not paid for in full, and
// a long second stage once a repeat challenge has said the short one was not
// enough. The probe that discovers the second stage is the only request either
// stage can waste, and it happens once per stage rather than once per isolate.
const STAGE1_MS = 5 * 60_000;
const STAGE2_MS = 30 * 60_000;
const WALL_KEY = "wall";
// The record's job is not just to hold the block - it is to carry the strike
// count forward to whatever comes after the block. Tying its lifetime to the
// stage defeated that: a first-stage record died after seven minutes, and a
// probe arriving a little later read nothing, started from zero strikes, and
// opened another first stage. Every challenge then looked like the first one,
// which is exactly the wasted probe this gate exists to prevent. So it lives
// comfortably past the longest stage.
const WALL_TTL_SECONDS = Math.ceil(STAGE2_MS / 1000) + 600;

interface WallState {
  /** When the gate reopens; 0 means it is open now. */
  until: number;
  /** When it closed, so an in-flight success is not mistaken for a way through. */
  openedAt: number;
  /** Consecutive challenges; decides which stage the next one gets. */
  strikes: number;
}

const WALL_OPEN: WallState = { until: 0, openedAt: 0, strikes: 0 };
let wall: WallState = { ...WALL_OPEN };

/** The gate's remaining time from this process's own view. Synchronous by design. */
export function breakerRemainingMs(): number {
  return Math.max(0, wall.until - Date.now());
}

/**
 * Forget only this process's view of the gate and leave the shared copy alone -
 * which is precisely what a fresh isolate, or the next run of the local server,
 * starts with.
 */
export function forgetLocalWallForTests(): void {
  wall = { ...WALL_OPEN };
}

/**
 * Forget the gate completely - the local state and the shared copy. The shared
 * copy matters: leaving it behind would have the next test, or the next
 * isolate, refuse to spend a request that something else needs to make.
 */
export async function resetBreakerForTests(): Promise<void> {
  wall = { ...WALL_OPEN };
  await storeSet(WALL_KEY, wall, 60);
}

/**
 * Let the gate lapse without forgetting what it learned - the state after a
 * stage has run out on its own. Without it the second stage could only be
 * reached by waiting half an hour.
 */
export async function expireWallForTests(): Promise<void> {
  wall = { ...wall, until: 0 };
  await storeSet(WALL_KEY, wall, 60);
}

/** The gate's remaining time after consulting the shared store. */
async function wallRemainingMs(): Promise<number> {
  const now = Date.now();
  if (wall.until <= now) {
    // Locally open - ask, because another isolate or the last run of this
    // process may know otherwise. Only an open gate is worth asking about: a
    // closed one is already the answer, and the check runs before every
    // upstream request.
    const shared = await storeGet<WallState>(WALL_KEY);
    // Adopt on *recency*, not on whether it is still blocking. A stage that has
    // lapsed still carries the strikes, and a rule of `until` alone discarded it
    // the moment it mattered - the probe after a stage then counted as a first
    // challenge and restarted the short stage forever.
    if (shared && typeof shared.until === "number" && typeof shared.openedAt === "number" && shared.openedAt > wall.openedAt) {
      wall = shared;
    }
  }
  return Math.max(0, wall.until - now);
}

function wallClosed(waiting: number): UpstreamError {
  return new UpstreamError(
    `Torob challenged this server recently, so no call was made. It clears on its own - retry in ` +
      `about ${Math.ceil(waiting / 60_000)} minute(s). Nothing was searched, so no result below is ` +
      `missing because of this.`,
    "challenged"
  );
}

async function openWall(): Promise<void> {
  const now = Date.now();
  const strikes = wall.strikes + 1;
  const ms = strikes <= 1 ? STAGE1_MS : STAGE2_MS;
  wall = { until: now + ms, openedAt: now, strikes };
  await storeSet(WALL_KEY, wall, WALL_TTL_SECONDS);
}

async function closeWallIfEarned(startedAt: number): Promise<void> {
  if (wall.until === 0 && wall.strikes === 0) return;
  // A response that was already in flight when the challenge arrived proves
  // nothing about today's wall - only a call that started after it closed does.
  if (wall.openedAt > startedAt) return;
  wall = { ...WALL_OPEN };
  await storeSet(WALL_KEY, wall, 60 * 60);
}

/**
 * Call the Torob API and return parsed JSON.
 *
 * @param path Absolute URL, or a path relative to the API base.
 */
export async function torobGet<T = unknown>(path: string, opts?: { retries?: number }): Promise<T> {
  const url = upstreamUrlFor(path);
  const retries = opts?.retries ?? MAX_RETRIES;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Waits for the call ahead, holds the pacing gap and re-checks the gate
    // while holding it - so a caller queued behind a challenge never reaches
    // fetch, and one challenged burst costs exactly one upstream request.
    const release = await acquireSlot();
    // Set when this attempt's answer is the caller's problem rather than a blip
    // - a 4xx. The `throw` below happens inside this same `try`, so without the
    // flag the catch would treat it as a retryable failure and spend the whole
    // retry budget on an answer that will not change (measured: a 404 costing
    // four round trips and twelve seconds).
    let fatal = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const startedAt = Date.now();
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
        // a permanent one. The first one also closes the gate, so the calls
        // behind it in a burst fail without spending an upstream request.
        if (looksLikeChallenge(res, body)) {
          await openWall();
          throw new UpstreamError(CHALLENGED_MSG, "challenged", { status: res.status });
        }

        // An answer that is not a challenge is the edge letting us through, so
        // the gate opens again - but only for a call that started after it shut.
        await closeWallIfEarned(startedAt);

        if (!res.ok) {
          lastError = new UpstreamError(
            `Torob answered HTTP ${res.status}. ${res.status === 404 ? "That product or category does not exist upstream." : "Retry shortly."}`,
            "http",
            { status: res.status }
          );
          // 4xx is the caller's fault, not a blip: 404 for a deleted product must
          // not be retried three times, and other 4xx are the same class.
          if (res.status < 500 && res.status !== 429) {
            fatal = true;
            throw lastError;
          }
          if (attempt < retries) {
            // Back off without holding the slot: the slot is there so two
            // fetches cannot overlap, not so one caller's retry delay can stall
            // every other call behind it. Resolving twice is a no-op, so the
            // finally below stays correct.
            release();
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
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if (fatal) throw err;
      if (err instanceof UpstreamError && (err.kind === "challenged" || err.kind === "usage")) throw err;
      lastError = err;
      if (attempt < retries) {
        // Same as the 5xx path above: the backoff is this caller's problem, not
        // the whole isolate's.
        release();
        await sleep(retryDelay(attempt));
        continue;
      }
    } finally {
      // Always, including when the attempt above was abandoned mid-flight: the
      // next caller is queued behind this promise, and never resolving it would
      // hang every call that follows.
      release();
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
