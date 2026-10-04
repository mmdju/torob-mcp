#!/usr/bin/env node
// Launcher for `npx torob-mcp` / `npx github:mmdju/torob-mcp`.
//
// It points at the built entry rather than being that entry, for one reason:
// npm links a package's bin while it is installing, which is *before* the
// `prepare` script has had a chance to build `dist/`. On Windows npm reads the
// target file to write its shims, so a bin aimed at a file that does not exist
// yet fails the whole install on a fresh clone. This file lives in the
// repository, so it is always there; the thing it launches may need a build
// first, and when it does that is reported as a sentence, not a stack trace.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const entry = new URL("../dist/index.js", import.meta.url);

if (!existsSync(fileURLToPath(entry))) {
  console.error(
    "torob-mcp: dist/index.js is missing, so the server has not been built yet. " +
      "Run `npm install` (its prepare script builds it) or `npm run build`."
  );
  process.exit(1);
}

await import(entry.href);
