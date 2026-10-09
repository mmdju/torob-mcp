// The local server is the delivery path this release is about, and it is the
// one thing no other test file touches: everything else imports dist/ modules
// directly, which says nothing about whether `node dist/index.js` starts,
// installs its store, and speaks MCP.
//
// It never calls Torob - initialize and tools/list are answered from the code,
// so this runs in a fraction of a second and cannot trip the wall.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "torob-mcp-local-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("node dist/index.js serves MCP over stdio and creates its store", async () => {
  // Deliberately absent: the directory existing afterwards is what proves the
  // file store was installed before anything else ran.
  const home = join(dir, "home");
  const child = spawn(process.execPath, ["dist/index.js"], {
    env: { ...process.env, TOROB_MCP_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  let stderr = "";
  const pending = new Map();

  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
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
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
  const request = (id, method, params) =>
    new Promise((resolve, reject) => {
      // Generous on purpose: this file runs beside eighteen others, and a cold
      // `node dist/index.js` spawn under that load can take a few seconds before
      // it answers. A tight budget failed here while the server was fine, which
      // is how a real break later gets mistaken for the usual flake.
      const timer = setTimeout(
        () => reject(new Error(`no answer to ${method} within 15s. stderr: ${stderr || "(empty)"}`)),
        15_000
      );
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });

  try {
    const init = await request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "local-server-test", version: "0" },
    });
    assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init.error)}`);
    assert.equal(init.result.serverInfo.name, "torob-mcp");

    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const list = await request(2, "tools/list", {});
    assert.equal(list.error, undefined, `tools/list failed: ${JSON.stringify(list.error)}`);
    assert.equal(list.result.tools.length, 15, "the local server offers the same fifteen tools");
    assert.ok(
      list.result.tools.every((t) => t.annotations?.readOnlyHint === true),
      "and every one of them is still read-only"
    );

    assert.ok(existsSync(home), "the local server must create its store directory before serving");
  } finally {
    child.stdin.end();
    child.kill();
  }
});
