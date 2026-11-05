#!/usr/bin/env node
// Proves the package ships what it runs, end to end.
//
// `npm pack --dry-run` shows a list of files; this shows the list is enough: it
// packs, installs the tarball into a throwaway project the way npm would, and
// drives the installed bin through a real MCP handshake. That catches the two
// failures a dry run cannot - a `files` list that omits something dist/ needs,
// and a bin that points at a file the tarball does not contain.
//
// It needs the network (a fresh install pulls the dependencies) and git (one of
// them is a git repository), so it is run by hand and deliberately not wired
// into `npm test` or CI. Usage: node scripts/verify-pack.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(step, detail) {
  console.error(`FAILED: ${step}`);
  if (detail) console.error(detail.trim());
  process.exit(1);
}

// One command string, quoted here rather than left to a shell: `npm` is a .cmd
// on Windows, which cannot be spawned as a bare executable, and temp paths can
// contain spaces.
const shellRun = (line, cwd) => {
  const res = spawnSync(line, { cwd, encoding: "utf8", shell: true });
  if (res.status !== 0) fail(line, `${res.stderr || res.stdout || ""}`);
  return res.stdout ?? "";
};

const work = mkdtempSync(join(tmpdir(), "torob-mcp-pack-"));
try {
  // 1. Pack. `prepare` runs first, so dist/ in the tarball is this build.
  shellRun(`npm pack --pack-destination "${work}"`, root);
  const packed = readdirSync(work).filter((f) => f.endsWith(".tgz"));
  if (packed.length !== 1) fail("npm pack", `expected one tarball, got: ${packed.join(", ") || "none"}`);
  const tarball = join(work, packed[0]);
  console.log(`packed ${packed[0]}`);

  // 2. Install it into a project that has nothing else.
  const project = join(work, "consumer");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "consumer", private: true }, null, 2));
  shellRun(`npm install --no-audit --no-fund "${tarball}"`, project);
  console.log("installed into a clean project");

  // 3. Drive the installed bin through a real handshake.
  const entry = join(project, "node_modules", "torob-mcp", "bin", "torob-mcp.js");
  const child = spawn(process.execPath, [entry], { cwd: project, stdio: ["pipe", "pipe", "pipe"] });

  let buffer = "";
  let stderr = "";
  const pending = new Map();
  child.stderr.on("data", (c) => (stderr += String(c)));
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const settle = pending.get(msg.id);
      if (settle) {
        pending.delete(msg.id);
        settle(msg);
      }
    }
  });

  const request = (id, method, params) =>
    new Promise((settle, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no answer to ${method}. stderr: ${stderr || "(empty)"}`)),
        15000
      );
      pending.set(id, (msg) => {
        clearTimeout(timer);
        settle(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  try {
    const init = await request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "verify-pack", version: "0" },
    });
    if (init.error) fail("initialize", JSON.stringify(init.error));
    if (init.result?.serverInfo?.name !== "torob-mcp") fail("initialize", JSON.stringify(init.result));

    const list = await request(2, "tools/list", {});
    if (list.error) fail("tools/list", JSON.stringify(list.error));
    const count = list.result?.tools?.length;
    if (count !== 15) fail("tools/list", `got ${count} tools, expected 15`);
    console.log("the installed bin answered initialize and listed 15 tools");
  } finally {
    child.stdin.end();
    child.kill();
  }

  console.log("package verified: it ships what it runs");
} finally {
  rmSync(work, { recursive: true, force: true });
}
