// The version is published in three places: package.json, the server's
// VERSION, and the changelog. A deployment that reports a different version
// than the repo is the thing this catches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VERSION } from "../dist/server.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("package.json and the server agree on the version", () => {
  assert.equal(pkg.version, VERSION);
});

test("the changelog advertises the same version", () => {
  // The changelog lives in this repository, next to the code it describes.
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  assert.ok(changelog.includes(VERSION), `CHANGELOG does not mention version ${VERSION}`);
});
