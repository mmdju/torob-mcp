#!/usr/bin/env node
// Packs the local server as an MCPB bundle (`build/torob-mcp.mcpb`).
//
// This is a packaging layer and nothing else: it stages the entry point MCPB
// should already launch (`dist/index.js`, stdio by default), the production
// dependency tree that entry needs, and the manifest - then hands the folder to
// the official `mcpb` CLI. No MCP logic is reimplemented here, and nothing about
// the hosted Worker, the tools or the Torob pacing is touched.
//
// Three things it deliberately does NOT copy, and why:
//   - dist/worker.js, dist/rate-limit.js, dist/og-image.js, dist/fonts.js. Only
//     the Worker entry imports them, and they are the Cloudflare deployment,
//     not a local MCP server. The import walk below is what decides that, so a
//     new import cannot quietly add one back.
//   - src/, tests/, scripts/, docs/, landing/, assets/, .github/, .wrangler/.
//     None of it runs.
//   - Anything a developer machine happens to have. `.env*`, `.dev.vars`, keys
//     and certificates never reach the staging directory: the copy list is
//     built from the import graph and from npm's own production tree, never
//     from "everything except a deny-list".
//
// It runs entirely offline: no `npm install`, no git, no network. The dependency
// tree is read out of the node_modules that `npm ci` already produced, and the
// CLI is the pinned devDependency. Usage: node scripts/build-mcpb.mjs
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");
const entry = "dist/index.js";
const stageDir = join(root, "build", "mcpb");
const artifact = join(root, "build", "torob-mcp.mcpb");

function fail(step, detail) {
  console.error(`FAILED: ${step}`);
  if (detail) console.error(detail.trim());
  process.exit(1);
}

// `npm` is a .cmd on Windows and cannot be spawned as a bare executable, and
// temp/repo paths can contain spaces - so the command line is quoted here and
// left to a shell, the way scripts/verify-pack.mjs already does it.
const shellRun = (line, cwd = root) => {
  const res = spawnSync(line, { cwd, encoding: "utf8", shell: true });
  if (res.status !== 0) fail(line, `${res.stderr || res.stdout || ""}`);
  return res.stdout ?? "";
};

// The CLI's own entry point, resolved through its package.json `bin` so this
// never depends on a global install or on a .cmd shim. The package does not
// export ./package.json, so the directory is found by walking up from its
// published entry point instead.
const require = createRequire(import.meta.url);
function mcpbPackageRoot() {
  let dir = dirname(require.resolve("@anthropic-ai/mcpb"));
  for (;;) {
    const file = join(dir, "package.json");
    if (existsSync(file)) {
      const found = JSON.parse(readFileSync(file, "utf8"));
      if (found.name === "@anthropic-ai/mcpb") return { dir, found };
    }
    const up = dirname(dir);
    if (up === dir) fail("resolve mcpb", "the pinned @anthropic-ai/mcpb was not found in node_modules");
    dir = up;
  }
}
const { dir: mcpbDir, found: mcpbPkg } = mcpbPackageRoot();
const mcpbBin = mcpbPkg.bin;
const mcpbCli = resolve(mcpbDir, typeof mcpbBin === "string" ? mcpbBin : mcpbBin.mcpb);
const mcpb = (...args) => {
  const res = spawnSync(process.execPath, [mcpbCli, ...args], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  process.stdout.write(res.stdout ?? "");
  process.stderr.write(res.stderr ?? "");
  if (res.status !== 0) fail(`mcpb ${args[0]}`, res.stderr || res.stdout || "");
  return res.stdout ?? "";
};

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// 1. The build. `dist/` is gitignored, so a clone that has not built yet must be
//    told so in a sentence rather than through a stack trace from deep inside
//    the import walk.
if (!existsSync(join(root, entry))) {
  fail(
    "build",
    `${entry} is missing, so the server has not been built yet. Run \`npm run build\` (or \`npm install\`, whose prepare script builds it).`
  );
}

// 2. A clean staging directory. Rebuilt from scratch every run so a deleted
//    source file cannot survive in the bundle.
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

// 3. dist/, narrowed to what the entry point actually reaches. Walking the
//    import graph rather than listing files is what keeps the Worker-only
//    modules out: an import that cannot be resolved is a build failure here,
//    not a broken bundle in somebody's MCPB host.
const SPECIFIER = /(?:^|[\s;}])(?:import|export)[^'"()]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;

function readSpecifiers(file) {
  const found = new Set();
  const source = readFileSync(file, "utf8");
  for (const m of source.matchAll(SPECIFIER)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) found.add(spec);
  }
  return found;
}

const staged = [];
const seen = new Set();
// Kept at dist/ inside the bundle, because that is the path the manifest's
// entry_point and mcp_config both point at.
const distInStage = join(stageDir, "dist");

function stageDistFile(relativePath) {
  if (seen.has(relativePath)) return;
  seen.add(relativePath);
  // Resolved and re-checked against dist/ so a relative import can never reach
  // outside it, whatever the source file says.
  const from = resolve(distDir, relativePath);
  if (!from.startsWith(distDir + sep)) {
    fail("stage dist", `${relativePath} resolves outside dist/`);
  }
  if (!existsSync(from) || !statSync(from).isFile()) {
    fail("stage dist", `${relativePath} is imported by index.js but is not in dist/`);
  }
  const to = join(distInStage, relativePath);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  staged.push(`dist/${relativePath.split(sep).join("/")}`);
  for (const spec of readSpecifiers(from)) {
    if (spec.startsWith("./") || spec.startsWith("../")) {
      stageDistFile(relative(distDir, resolve(dirname(from), spec)));
    }
    // Bare specifiers are packages: staged separately from npm's own tree.
    // `node:` and anything else bare is left to the runtime.
  }
}

stageDistFile("index.js");
console.log(`staged ${staged.length} built modules from dist/ (${staged.join(", ")})`);

// 4. The production dependency tree, copied out of the node_modules npm ci
//    already produced. `npm ls --omit=dev` is npm's own answer to "what does
//    this package need at runtime", which is exactly what the MCPB docs tell a
//    bundle author to ship. The second call is what drops the packages npm
//    reports as extraneous (optional platform binaries left behind by wrangler)
//    instead of trusting a hand-written allow-list.
const tree = JSON.parse(
  shellRun("npm ls --omit=dev --all --json").replace(/^\uFEFF/, "")
);
const required = new Set();
(function collect(deps) {
  for (const [name, node] of Object.entries(deps ?? {})) {
    if (node.extraneous) continue;
    required.add(name);
    collect(node.dependencies);
  }
})(tree.dependencies);

let packages = 0;
for (const line of shellRun("npm ls --omit=dev --all --parseable")
  .split(/\r?\n/)
  .slice(1)) {
  const from = line.trim();
  if (!from) continue;
  const rel = relative(join(root, "node_modules"), from).split(sep).join("/");
  const top = rel.startsWith("@") ? rel.split("/").slice(0, 2).join("/") : rel.split("/")[0];
  if (!required.has(top)) continue;
  cpSync(from, join(stageDir, "node_modules", rel), { recursive: true });
  packages++;
}
if (packages === 0) fail("stage dependencies", "npm ls reported no production packages to copy");
console.log(`staged ${packages} production packages into node_modules/`);

// 5. package.json. dist/*.js are ES modules, so without `"type": "module"` at
//    the bundle root Node reads the entry as CommonJS and the very first import
//    is a SyntaxError. The dependency list travels with it so the bundle says
//    what it contains.
writeFileSync(
  join(stageDir, "package.json"),
  `${JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      license: pkg.license,
      type: "module",
      dependencies: pkg.dependencies,
    },
    null,
    2
  )}\n`
);

// 6. The manifest, with the version taken from package.json. package.json is
//    the project's single version source (tests/version-sync.test.mjs holds the
//    server and the changelog to it), so the bundle is written from it rather
//    than from a third hand-maintained copy. manifest.json still carries the
//    version so `mcpb validate manifest.json` works in a clone.
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
manifest.version = pkg.version;
writeFileSync(join(stageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
cpSync(join(root, ".mcpbignore"), join(stageDir, ".mcpbignore"));

// 7. The official CLI does the validating and the packing.
mcpb("validate", stageDir);
mcpb("pack", stageDir, artifact);

// 8. Then read the archive back, because a pack that succeeds is not the same
//    as a bundle that runs. Unpacking through the CLI also means the check sees
//    exactly what a host will see, `.mcpbignore` and the CLI's own exclusions
//    included.
const unpacked = join(root, "build", "unpacked");
try {
  rmSync(unpacked, { recursive: true, force: true });
  mcpb("unpack", artifact, unpacked);

  const expected = [
    "manifest.json",
    "package.json",
    entry,
    "dist/server.js",
    "dist/tools.js",
    "dist/project.js",
    "node_modules/@modelcontextprotocol/sdk/package.json",
    "node_modules/fa-text-utils/package.json",
  ];
  for (const file of expected) {
    if (!existsSync(join(unpacked, file))) fail("bundle contents", `missing ${file}`);
  }

  // Everything below is either a secret or a thing that has no business being
  // in a local MCP server's bundle. Repository-shaped names are anchored to the
  // bundle root: a dependency is perfectly entitled to its own src/ directory.
  const forbidden = [
    /(^|\/)\.env(\..*)?$/,
    /(^|\/)\.dev\.vars$/,
    /(^|\/)\.git(\/|$)/,
    /^node_modules\/\.bin(\/|$)/,
    /^(tests?|scripts?|src|landing|assets|\.github|\.wrangler)(\/|$)/,
    /(^|\/)(tsconfig\.json|package-lock\.json)$/,
    /\.pem$/,
    /\.key$/,
    /\.(mcpb|tgz|log|map)$/,
    /^dist\/(worker|rate-limit|og-image|fonts)\.js$/,
  ];

  const walk = (dir, prefix = "") => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      for (const pattern of forbidden) {
        if (pattern.test(rel)) fail("bundle contents", `forbidden file in the bundle: ${rel}`);
      }
      if (item.isDirectory()) walk(join(dir, item.name), rel);
    }
  };
  walk(unpacked);

  // The version in the archive is the one the project is on.
  const packed = JSON.parse(readFileSync(join(unpacked, "manifest.json"), "utf8"));
  if (packed.version !== pkg.version) {
    fail("bundle contents", `manifest says ${packed.version}, package.json says ${pkg.version}`);
  }

  console.log(`verified ${artifact}`);
} finally {
  rmSync(unpacked, { recursive: true, force: true });
}
