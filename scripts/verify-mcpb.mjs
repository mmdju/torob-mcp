#!/usr/bin/env node
// Proves the MCPB bundle runs from a clean install location, end to end.
//
// `npm run build:mcpb` proves the archive is well formed and holds what it needs.
// This proves the thing a host actually does with it: unpack it somewhere with
// no repository above it, launch the entry point exactly as the manifest's
// mcp_config says, complete a real MCP handshake over stdio, list the tools and
// call one read-only tool.
//
// The tool call reaches Torob, so it needs the network - which is why this is
// run by hand the way scripts/verify-live.mjs and scripts/verify-pack.mjs are,
// and not wired into `npm test`. A bot challenge is reported as the finding it
// is instead of failing the run: it is upstream's answer to a caller, and the
// bundle's job was to get this far. Usage: node scripts/verify-mcpb.mjs
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "build", "torob-mcp.mcpb");

function fail(step, detail) {
  console.error(`FAILED: ${step}`);
  if (detail) console.error(detail.trim());
  process.exit(1);
}

if (!existsSync(bundle)) {
  fail("build", `${bundle} does not exist. Run \`npm run build:mcpb\` first.`);
}

// The CLI is spawned through a shell on purpose: `mcpb` is a .cmd on Windows and
// cannot be spawned as a bare executable.
const shellRun = (line, cwd) => {
  const res = spawnSync(line, { cwd, encoding: "utf8", shell: true });
  if (res.status !== 0) fail(line, `${res.stderr || res.stdout || ""}`);
  return res.stdout ?? "";
};

const work = mkdtempSync(join(tmpdir(), "torob-mcp-mcpb-"));
try {
  // 1. Unpack outside the repository, so nothing can resolve through src/ or a
  //    developer's node_modules by accident.
  const install = join(work, "installed");
  shellRun(`npx --no-install mcpb unpack "${bundle}" "${install}"`, root);
  const manifest = JSON.parse(readFileSync(join(install, "manifest.json"), "utf8"));
  console.log(`unpacked ${manifest.name}@${manifest.version} into a clean directory`);

  // 2. Launch it the way the manifest says, with ${__dirname} resolved to the
  //    install directory - which is the substitution a host performs.
  const entry = manifest.server.mcp_config.args
    .join(" ")
    .replaceAll("${__dirname}", install);
  const command = manifest.server.mcp_config.command;
  const home = join(work, "home");
  const child = spawn(command, [entry], {
    cwd: work,
    env: { ...process.env, TOROB_MCP_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  let stderr = "";
  const pending = new Map();
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
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
        20000
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
      clientInfo: { name: "verify-mcpb", version: "0" },
    });
    if (init.error) fail("initialize", JSON.stringify(init.error));
    if (init.result?.serverInfo?.name !== "torob-mcp") fail("initialize", JSON.stringify(init.result));
    if (init.result?.serverInfo?.version !== manifest.version) {
      fail("initialize", `the server reports ${init.result?.serverInfo?.version}, the manifest says ${manifest.version}`);
    }
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const list = await request(2, "tools/list", {});
    if (list.error) fail("tools/list", JSON.stringify(list.error));
    const tools = list.result?.tools ?? [];
    console.log(`initialize answered ${init.result.serverInfo.name}@${init.result.serverInfo.version}`);
    console.log(`tools/list returned ${tools.length} tools, all read-only: ${tools.every((t) => t.annotations?.readOnlyHint === true)}`);

    // The declared names in the manifest and the served names have to be the
    // same set: a manifest that promises a tool the server does not have is a
    // lie a host would show the user.
    const declared = (manifest.tools ?? []).map((t) => t.name).sort();
    const served = tools.map((t) => t.name).sort();
    if (JSON.stringify(declared) !== JSON.stringify(served)) {
      fail("tools/list", `the manifest declares ${declared.join(", ")} but the server serves ${served.join(", ")}`);
    }

    // 3. One safe, read-only call. `torob_suggest` is the cheapest one there is
    //    - a public autocomplete call - and it exercises the whole path: store,
    //    pacing, cache, projection, and the answer coming back as JSON.
    const call = await request(3, "tools/call", {
      name: "torob_suggest",
      arguments: { query: "لپ تاپ" },
    });
    if (call.error) fail("tools/call", JSON.stringify(call.error));
    const text = call.result?.content?.[0]?.text ?? "";
    if (call.result?.isError) {
      if (/bot challenge/i.test(text)) {
        console.log(`\nreported, not failed: Torob answered with a bot challenge.\n${text.trim()}`);
      } else {
        fail("tools/call", text);
      }
    } else {
      const data = JSON.parse(text);
      const found = (data.suggestions ?? []).length;
      if (!found) fail("tools/call", `no suggestions came back: ${text.slice(0, 400)}`);
      console.log(`tools/call torob_suggest returned ${found} suggestions, e.g. "${data.suggestions[0]}"`);
    }

    if (!existsSync(home)) fail("store", "the unpacked bundle did not create its local store directory");
    console.log("\nbundle verified: it ships what it runs, and runs it from a clean directory");
  } finally {
    child.stdin.end();
    child.kill();
    // Wait for the process to actually be gone: on Windows the directory cannot
    // be removed while it still holds a handle to its working directory.
    await new Promise((settle) => child.once("exit", settle));
  }
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
