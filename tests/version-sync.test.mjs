// The version is published in three places: package.json, the server's
// VERSION, and the docs. A deployment that reports a different version than
// the repo is the thing this catches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VERSION } from "../dist/server.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("package.json and the server agree on the version", () => {
  assert.equal(pkg.version, VERSION);
});

test("the public docs advertise the same version", () => {
  // Only run when the docs mirror is present; a source-only checkout has none.
  let readme;
  try {
    readme = readFileSync(new URL("../../torob-mcp-public/CHANGELOG.md", import.meta.url), "utf8");
  } catch {
    return; // docs mirror not cloned here
  }
  assert.ok(readme.includes(VERSION), `CHANGELOG does not mention version ${VERSION}`);
});
