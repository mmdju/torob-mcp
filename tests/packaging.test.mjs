// A package that installs cleanly and then cannot start is the failure this
// file exists to catch. Two details make it easy to hit: `dist/` is gitignored,
// so a `files` list that forgets it ships no code at all; and npm links a bin
// *before* the prepare script builds, so a bin aimed straight at `dist/` breaks
// the install itself on Windows.
//
// The private flag is asserted too. Publishing is a separate, deliberate
// decision - this test is the thing that has to be edited to allow it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("the package declares a bin that exists on disk", () => {
  const target = pkg.bin?.["torob-mcp"];
  assert.equal(typeof target, "string", "the package must declare a torob-mcp bin");
  assert.ok(existsSync(new URL(`../${target}`, import.meta.url)), `${target} is missing`);
});

test("the launcher is a program in its own right", () => {
  const shim = read("../bin/torob-mcp.js");
  assert.ok(shim.startsWith("#!"), "a launcher without a shebang is not executable");
  assert.match(shim, /dist\/index\.js/, "the launcher must point at the built entry");
  // It has to exist in the repository, not only after a build - that is the
  // whole reason it is not the built entry itself.
  assert.ok(shim.includes("not been built yet"), "a missing build must be a sentence, not a stack trace");
});

test("the built entry carries a shebang too", () => {
  assert.ok(read("../dist/index.js").startsWith("#!"), "dist/index.js should be runnable directly");
});

test("the files whitelist ships dist, bin and docs - and only those", () => {
  const files = (pkg.files ?? []).map((f) => f.replace(/\/$/, ""));
  assert.ok(files.includes("dist"), `files must include dist: ${files.join(", ")}`);
  assert.ok(files.includes("bin"), `files must include bin: ${files.join(", ")}`);
  for (const forbidden of ["src", "tests", "scripts", "landing", "assets", ".github", ".wrangler"]) {
    assert.ok(!files.includes(forbidden), `${forbidden} has no place in a package`);
  }
});

test("a git checkout builds itself", () => {
  // `npx github:mmdju/torob-mcp` runs prepare against a checkout with no dist/.
  // Without it the one-line install ships a launcher that cannot find anything.
  assert.ok(pkg.scripts?.prepare, "prepare must build dist for a git checkout");
  assert.match(pkg.scripts.prepare, /build/, "prepare must run the build");
});

test("publishing is still a deliberate act", () => {
  assert.equal(
    pkg.private,
    true,
    "npm publish is a separate decision; publishing is opened by editing this, on purpose"
  );
});

test("the readme offers every way to connect", () => {
  const readme = read("../README.md");
  assert.match(readme, /torob-mcp\.mmdju3\.workers\.dev/, "the hosted endpoint must be documented");
  assert.match(readme, /github:mmdju\/torob-mcp/, "the one-line git install must be documented");
  assert.match(readme, /dist\/index\.js/, "running a clone must be documented");
  assert.match(readme, /fa-text-utils/, "the git dependency must be named, it needs git on the machine");
});
