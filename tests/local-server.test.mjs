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
import { createServer } from "node:net";
import { VERSION } from "../dist/server.js";

let dir;

// A port nothing is listening on, rather than a fixed one that something else
// may have taken: this file runs beside the rest of the suite, and CI runs on
// a machine whose 3000 belongs to nobody's business but is not free.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

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

test("node dist/index.js --http answers GET and HEAD /mcp the way the Worker does", async () => {
  // The other transport, and until now the one nothing exercised: the Worker's
  // GET /mcp rule was ported here in 0.5.7 and the HEAD rule in 0.5.8, and
  // neither had a test on this side. A local run that answered 200 + HTML would
  // put the same reconnect loop on the user's own machine that burned the
  // hosted plan.
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/index.js", "--http"], {
    env: { ...process.env, TOROB_MCP_HOME: join(dir, "home-http"), PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    try {
      ready = (await fetch(`${base}/health`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  try {
    assert.ok(ready, `the local HTTP server never answered /health. stderr: ${stderr || "(empty)"}`);
    assert.equal((await (await fetch(`${base}/health`)).json()).version, VERSION);

    const refused = await fetch(`${base}/mcp`);
    assert.equal(refused.status, 405, "a client that never asked for HTML must get 405, not the page");
    assert.equal(refused.headers.get("allow"), "POST");

    const head = await fetch(`${base}/mcp`, { method: "HEAD" });
    assert.equal(head.status, 405, "a HEAD answers what a GET would");
    assert.equal(await head.text(), "", "with the headers and no body");

    const page = await fetch(`${base}/mcp`, { headers: { accept: "text/html" } });
    assert.equal(page.status, 200, "a browser still gets the connect page");
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);

    assert.equal((await fetch(`${base}/`)).status, 200, "and the landing page still answers");
    // The tools are not touched: this is the transport, not the tools.
  } finally {
    child.kill();
  }
});
