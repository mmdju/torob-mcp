// State that has to outlive one isolate - and, for the local server, one run
// of the process.
//
// Two backends sit behind this one interface:
//
//   - Workers: the Cache API (`caches.default`). It is per-colo, so the colo
//     whose egress Torob challenged carries that fact while a different colo is
//     not punished for it. No binding is needed and it outlives the isolate
//     that wrote it.
//   - The local server: a file, installed by store-node.ts at startup. This is
//     not a nicety - a local server that forgets it was just challenged spends
//     a fresh upstream request finding out, and a fresh upstream request while
//     challenged is precisely what extends the block.
//
// Everything here is best effort. This layer can only ever save or cost one
// extra upstream request, so a failure must never be the reason a tool call
// fails: a read answers undefined, a write is swallowed.
//
// tests/store.test.mjs exercises both backends.

export type StoreBackend = {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
};

// A URL, because the Cache API keys on one. Kept on a private host: nothing
// here is ever fetched, it is only a name the edge stores bytes under.
const PREFIX = "https://torob-mcp.internal/state/";

let backend: StoreBackend | null = null;

/** Install a backend (the local server's file store), or pass null to clear it. */
export function setStoreBackend(next: StoreBackend | null): void {
  backend = next;
}

export function hasStoreBackend(): boolean {
  return backend !== null;
}

function cacheApi(): Cache | null {
  try {
    return (globalThis as { caches?: { default?: Cache } }).caches?.default ?? null;
  } catch {
    return null;
  }
}

export async function storeGet<T>(key: string): Promise<T | undefined> {
  if (backend) {
    try {
      return (await backend.get(key)) as T | undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const cache = cacheApi();
    if (!cache) return undefined;
    const hit = await cache.match(`${PREFIX}${key}`);
    return hit ? ((await hit.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

export async function storeSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (backend) {
    try {
      await backend.set(key, value, ttlSeconds);
    } catch {
      /* best effort - the in-process map still has it */
    }
    return;
  }
  try {
    const cache = cacheApi();
    if (!cache) return;
    await cache.put(
      `${PREFIX}${key}`,
      new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttlSeconds}` },
      })
    );
  } catch {
    /* best effort - the in-process map still has it */
  }
}
