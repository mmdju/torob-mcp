// Tiny TTL cache with in-flight request coalescing and a byte budget. Enough
// for a single-user local server; the same code is what the Worker uses per
// isolate.
//
// The byte budget is the part that is not optional: one product's raw details
// payload measures ~1.4MB, so a count-only cap (1000 entries) could hold
// gigabytes, while a Worker isolate only gets 128MB. Entries are evicted
// oldest-first until both caps hold, and a single entry larger than the whole
// budget is not cached at all.

type Entry = { value: unknown; expires: number; bytes: number };

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;

let maxEntries = DEFAULT_MAX_ENTRIES;
let maxBytes = DEFAULT_MAX_BYTES;
let totalBytes = 0;

// Tests set a tiny budget so eviction is observable without building real
// megabytes. `null` restores the defaults.
export function setCacheLimitsForTests(opts: { maxEntries?: number; maxBytes?: number } | null): void {
  maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
}

export function cacheStatsForTests(): { entries: number; bytes: number } {
  return { entries: store.size, bytes: totalBytes };
}

// UTF-8 byte length of the value as it would be stored. TextEncoder exists on
// both runtimes (Workers and Node) and keeps the measurement honest for the
// Persian text this cache mostly holds.
const encoder = new TextEncoder();
function bytesOf(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : encoder.encode(json).length;
  } catch {
    return 0;
  }
}

function evictFor(incoming: number): void {
  while (store.size > 0 && (store.size >= maxEntries || totalBytes + incoming > maxBytes)) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    const entry = store.get(oldest.value);
    if (entry) totalBytes -= entry.bytes;
    store.delete(oldest.value);
  }
}

function put(key: string, value: unknown, ttlMs: number): void {
  const bytes = bytesOf(value);
  // A single value bigger than the whole budget would evict everything and
  // still not fit; skip it rather than emptying the cache for it.
  if (bytes > maxBytes) return;
  const existing = store.get(key);
  if (existing) {
    totalBytes -= existing.bytes;
    store.delete(key);
  }
  evictFor(bytes);
  store.set(key, { value, expires: Date.now() + ttlMs, bytes });
  totalBytes += bytes;
}

export async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expires > now) return hit.value as T;
  const ongoing = inflight.get(key);
  if (ongoing) return ongoing as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  const value = await p;
  put(key, value, ttlMs);
  return value;
}

export const MIN = 60_000;
export const HOUR = 3_600_000;

export function cachedGet<T>(key: string): T | undefined {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  return undefined;
}

export function cacheSet(key: string, value: unknown, ttlMs: number): void {
  put(key, value, ttlMs);
}
