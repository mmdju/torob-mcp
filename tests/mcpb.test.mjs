// The MCPB bundle is a packaging promise: that this repository can be handed to
// an MCPB host as one file, that the host will launch the same local server the
// npm package launches, and that nothing secret or irrelevant rides along.
//
// These gates are static on purpose - they need no build and no bundle, so they
// run in `npm test` on every push. What the *built* bundle contains is checked
// by `npm run build:mcpb` itself (it reads the archive back and fails on a
// missing or forbidden file), and that it actually runs is checked by hand with
// `node scripts/verify-mcpb.mjs`, which needs the network.
//
// The manifest schema is the one the pinned MCPB CLI ships, not a copy of it: a
// manifest that passes a schema this repository maintains itself would prove
// nothing about the format.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { VERSIONED_MANIFEST_SCHEMAS } from "@anthropic-ai/mcpb/schemas";
import { TOOLS } from "../dist/tools.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const manifest = JSON.parse(read("../manifest.json"));
const pkg = JSON.parse(read("../package.json"));
const ENTRY = "dist/index.js";

test("the manifest is valid against the current MCPB schema", () => {
  const schema = VERSIONED_MANIFEST_SCHEMAS[manifest.manifest_version];
  assert.ok(schema, `manifest_version ${manifest.manifest_version} is not one the CLI knows`);
  const result = schema.safeParse(manifest);
  assert.ok(
    result.success,
    `manifest.json does not validate: ${result.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
  );
});

test("it declares the version the project is on", () => {
  // package.json is the single version source: the server's VERSION and the
  // changelog are both held to it by tests/version-sync.test.mjs, and
  // scripts/build-mcpb.mjs writes the bundled manifest from it. This is the
  // gate that keeps the checked-in copy honest too.
  assert.equal(manifest.version, pkg.version);
});

test("it launches the existing local entry point, over stdio", () => {
  assert.equal(manifest.server.type, "node");
  assert.equal(manifest.server.entry_point, ENTRY);
  assert.ok(existsSync(new URL(`../${ENTRY}`, import.meta.url)), `${ENTRY} must be built before it can be launched`);
  assert.equal(manifest.server.mcp_config.command, "node");
  // ${__dirname} is the substitution an MCPB host performs, and the only reason
  // this works outside the repository: the bundle is installed wherever the host
  // puts it.
  assert.deepEqual(manifest.server.mcp_config.args, [`\${__dirname}/${ENTRY}`]);
});

test("nothing in it depends on a path that only exists on a developer machine", () => {
  const text = JSON.stringify(manifest);
  for (const bad of ["/home/", "C:\\", "D:\\", "../../", "/Users/", "/tmp/"]) {
    assert.ok(!text.includes(bad), `the manifest must not mention ${bad}`);
  }
});

test("every path it names is bundle-relative and exists in the repository", () => {
  for (const path of [manifest.server.entry_point]) {
    assert.ok(!path.startsWith("/") && !path.includes(".."), `${path} must be bundle-relative`);
    assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${path} does not exist`);
  }
  // Only if one is declared: a manifest with no icon is valid, a manifest with a
  // broken one is not, and the CLI's validate rejects an absolute or ${__dirname}
  // icon outright.
  if (manifest.icon) {
    assert.ok(existsSync(new URL(`../${manifest.icon}`, import.meta.url)), `${manifest.icon} does not exist`);
    assert.match(manifest.icon, /\.png$/, "the MCPB icon must be a PNG");
  }
});

test("the tools it declares are exactly the tools the server serves", () => {
  // A host shows these before the server is ever launched, so a name here that
  // the server does not have - or a tool it has but nobody declared - is the
  // same quiet wrongness as a stale README table.
  const declared = (manifest.tools ?? []).map((t) => t.name);
  const served = TOOLS.map((t) => t.name);
  assert.deepEqual([...declared].sort(), [...served].sort());
  for (const tool of manifest.tools ?? []) {
    assert.ok(tool.description?.length > 20, `${tool.name} needs a description a host can show`);
  }
});

test("it claims no configuration, because there is none to configure", () => {
  // Torob needs no key and this server never signs in. A user_config or a
  // sensitive field would be asking for a credential the server has no use for.
  assert.equal(manifest.user_config, undefined, "the server needs no credentials, so it must ask for none");
  assert.equal(manifest.server.mcp_config.env, undefined, "no secrets are wired into the bundle");
  assert.equal(manifest.server.mcp_config.platform_overrides, undefined, "node + a relative entry is portable on its own");
});

test("the node runtime it asks for is the one the dependencies ask for", () => {
  const sdk = JSON.parse(read("../node_modules/@modelcontextprotocol/sdk/package.json"));
  const required = String(sdk.engines?.node ?? "").replace(/[^\d.]/g, "");
  assert.ok(required, "the SDK should state a node engine range");
  assert.ok(
    manifest.compatibility.runtimes.node.includes(required),
    `the manifest asks for ${manifest.compatibility.runtimes.node}, the SDK needs ${sdk.engines.node}`
  );
});

test("the CLI is a pinned devDependency, not a global install", () => {
  // `npx -g @anthropic-ai/mcpb` would make the bundle depend on whatever a
  // machine happens to have, and on nothing at all in CI.
  const pinned = pkg.devDependencies?.["@anthropic-ai/mcpb"];
  assert.match(pinned ?? "", /^\d+\.\d+\.\d+$/, "the MCPB CLI must be pinned to an exact version");
});

test("the build script and the ignore file the CLI reads are both wired up", () => {
  assert.equal(pkg.scripts?.["build:mcpb"], "npm run build && node scripts/build-mcpb.mjs");
  assert.ok(existsSync(new URL("../scripts/build-mcpb.mjs", import.meta.url)));
  // .mcpbignore is read from the packed directory, so the staging step has to
  // carry it across; a secret pattern that never arrives protects nothing.
  const ignore = read("../.mcpbignore");
  for (const pattern of [".env", "*.pem", "*.key", "*.mcpb"]) {
    assert.ok(ignore.includes(pattern), `.mcpbignore must keep ${pattern} out`);
  }
});

test("the bundle is a build artifact, not something the repository tracks", () => {
  const gitignore = read("../.gitignore").split(/\r?\n/);
  assert.ok(gitignore.includes("*.mcpb"), "a generated .mcpb must not be committed");
  assert.ok(gitignore.includes("build/"), "the staging directory must not be committed");
  // Nor does it belong in the npm tarball: the bundle is built from a checkout,
  // which is the only place dist/ and the dependency tree both exist.
  const files = (pkg.files ?? []).map((f) => f.replace(/\/$/, ""));
  for (const not in ["manifest.json", ".mcpbignore"]) {
    assert.ok(!files.includes(not), `${not} has no place in the npm package`);
  }
});

test("the readme offers the bundle next to the ways that already exist", () => {
  const readme = read("../README.md");
  assert.match(readme, /npm run build:mcpb/, "how to build the bundle must be documented");
  assert.match(readme, /\.mcpb\b/, "what the bundle is must be documented");
  assert.match(readme, /torob-mcp\.mmdju3\.workers\.dev/, "the hosted endpoint must stay documented");
  // The hosted copy is a separate deployment and MCPB does not replace it.
  assert.match(readme, /local/i, "the bundle must be described as the local option");
});
