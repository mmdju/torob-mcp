// The local server's half of the shared store: one JSON file under the user's
// home directory. Node-only, imported by index.ts alone - the Worker's entry
// point never reaches this module, so nothing here is bundled for Workers.
//
// The write is through, not debounced, and that is deliberate. The two things
// worth keeping are a challenged marker and a product's details URL; losing the
// first costs a wasted upstream request (which is what extends a block) and
// losing the second costs an extra search. A synchronous write of a file this
// size is well under a millisecond, and there is no exit path where the last
// write is dropped.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setStoreBackend, type StoreBackend } from "./store.js";

type Row = { exp: number; v: unknown };

// The file is a convenience, not a database. Both caps are generous for what
// this store holds, and both are enforced on every write so it cannot grow
// without bound on a machine nobody is watching.
const MAX_ROWS = 5000;
const MAX_BYTES = 16 * 1024 * 1024;

let installedPath: string | null = null;

/** ~/.torob-mcp, or TOROB_MCP_HOME when set. */
export function defaultStoreDir(): string {
  const override = process.env.TOROB_MCP_HOME?.trim();
  return override ? override : join(homedir(), ".torob-mcp");
}

function dropExpired(rows: Map<string, Row>): void {
  const now = Date.now();
  for (const [key, row] of rows) {
    if (row.exp !== 0 && row.exp <= now) rows.delete(key);
  }
}

function load(file: string): Map<string, Row> {
  const rows = new Map<string, Row>();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      const row = value as Row;
      if (row && typeof row === "object" && "v" in row && typeof row.exp === "number") {
        rows.set(key, row);
      }
    }
    dropExpired(rows);
  } catch {
    // First run, a truncated file, or a file written by a newer version. None
    // of those are errors worth raising: the store only ever saves a lookup.
  }
  return rows;
}

/**
 * Install the file store as the shared backend.
 *
 * Returns the path it will write to, or null when the store could not be set
 * up - in which case the server simply runs the way it did before this existed,
 * relearning a product name once more instead of failing.
 */
export function installFileStore(opts?: { dir?: string }): string | null {
  if (installedPath) return installedPath;
  try {
    const dir = opts?.dir ?? defaultStoreDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "state.json");
    const rows = load(file);

    const save = (): void => {
      try {
        dropExpired(rows);
        while (rows.size > MAX_ROWS) {
          const oldest = rows.keys().next();
          if (oldest.done) break;
          rows.delete(oldest.value);
        }
        let text = "";
        for (;;) {
          text = JSON.stringify(Object.fromEntries(rows));
          if (Buffer.byteLength(text, "utf8") <= MAX_BYTES || rows.size === 0) break;
          const oldest = rows.keys().next();
          if (oldest.done) break;
          rows.delete(oldest.value);
        }
        // Write to a sibling first: a crash halfway through must not leave a
        // half-written file where the next run expects its memory.
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, text, "utf8");
        renameSync(tmp, file);
      } catch {
        /* best effort - an unwritable file costs one extra lookup, nothing more */
      }
    };

    const backend: StoreBackend = {
      async get(key) {
        const row = rows.get(key);
        if (!row) return undefined;
        if (row.exp !== 0 && row.exp <= Date.now()) {
          rows.delete(key);
          return undefined;
        }
        return row.v;
      },
      async set(key, value, ttlSeconds) {
        // Delete first so a rewrite moves the key to the end: insertion order
        // is what "oldest" means when a cap has to evict something.
        rows.delete(key);
        rows.set(key, { exp: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0, v: value });
        save();
      },
    };

    setStoreBackend(backend);
    installedPath = file;
    return file;
  } catch {
    setStoreBackend(null);
    return null;
  }
}

/** Drop the backend and forget where it was - used by tests. */
export function uninstallFileStore(): void {
  setStoreBackend(null);
  installedPath = null;
}

export function fileStorePath(): string | null {
  return installedPath;
}
