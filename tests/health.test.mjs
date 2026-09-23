// The health endpoint is what a deployment is checked with, so it must answer
// without touching Torob and must report the version the docs advertise.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../dist/worker.js";
import { VERSION } from "../dist/server.js";

test("GET /health answers with the service and version", async () => {
  const res = await worker.fetch(new Request("https://torob-mcp.test/health"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "torob-mcp");
  assert.equal(body.version, VERSION);
});

test("GET / serves the landing page", async () => {
  const res = await worker.fetch(new Request("https://torob-mcp.test/"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const html = await res.text();
  assert.match(html, /torob-mcp/);
});

test("GET /og.png serves a whole PNG, not a truncated one", async () => {
  const res = await worker.fetch(new Request("https://torob-mcp.test/og.png"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  const bytes = new Uint8Array(await res.arrayBuffer());
  // PNG magic number.
  assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  // Decoding the embedded base64 with a per-call argument conversion
  // (Uint8Array.from(str, fn)) silently truncated this to 72 bytes - a valid
  // header with no image behind it. The size and the trailing IEND chunk are
  // what catch that.
  assert.ok(bytes.length > 1000, `og image is only ${bytes.length} bytes - the base64 decode is truncating`);
  // A whole PNG ends with a zero-length IEND chunk: 00 00 00 00 "IEND" + CRC.
  assert.deepEqual([...bytes.slice(-8, -4)], [0x49, 0x45, 0x4e, 0x44], "PNG does not end with an IEND chunk");
  assert.deepEqual([...bytes.slice(-12, -8)], [0x00, 0x00, 0x00, 0x00], "IEND chunk length should be zero");
});

test("an unknown path is a 404 that says where the MCP endpoint is", async () => {
  const res = await worker.fetch(new Request("https://torob-mcp.test/nope"));
  assert.equal(res.status, 404);
  assert.match(await res.text(), /POST \/mcp/);
});

test("OPTIONS answers the CORS preflight", async () => {
  const res = await worker.fetch(new Request("https://torob-mcp.test/mcp", { method: "OPTIONS" }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("the landing page is Persian and RTL", async () => {
  const res = await worker.fetch(new Request("https://torob-mcp.test/"));
  const html = await res.text();
  assert.match(html, /dir="rtl"/);
  assert.match(html, /مقایسه/);
});
