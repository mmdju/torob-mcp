// npm test runs an explicit list of files, so a test that is written but not
// registered never runs - and looks like coverage. This gate is the reason the
// sibling projects kept theirs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const onDisk = readdirSync(new URL("../tests", import.meta.url)).filter((f) => f.endsWith(".test.mjs"));
const registered = [...pkg.scripts.test.matchAll(/tests\/([\w.-]+\.test\.mjs)/g)].map((m) => m[1]);

test("every test file on disk is registered in npm test", () => {
  const missing = onDisk.filter((f) => !registered.includes(f));
  assert.deepEqual(missing, [], `these tests exist but never run: ${missing.join(", ")}`);
});

test("npm test registers no file that does not exist", () => {
  const stale = registered.filter((f) => !onDisk.includes(f));
  assert.deepEqual(stale, [], `npm test lists missing files: ${stale.join(", ")}`);
});

test("there is at least one test", () => {
  assert.ok(onDisk.length > 0);
});
