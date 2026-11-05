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

test("GET /doran-400.woff2 serves the landing page's own font", async () => {
  const res = await worker.fetch(new Request("https://torob-mcp.test/doran-400.woff2"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "font/woff2");
  const bytes = new Uint8Array(await res.arrayBuffer());
  // A woff2 file starts with the signature "wOF2".
  assert.deepEqual([...bytes.slice(0, 4)], [0x77, 0x4f, 0x46, 0x32]);
  assert.ok(bytes.length > 10000, `font is only ${bytes.length} bytes`);
});

test("an unknown font weight is not served", async () => {
  const res = await worker.fetch(new Request("https://torob-mcp.test/doran-999.woff2"));
  assert.equal(res.status, 404);
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

// The transport rule: GET on the MCP endpoint streams `text/event-stream` or
// answers 405 - nothing else. Answering 200 + HTML did not read as an error to
// a client, it read as a stream that opened and immediately ended, and the
// official TypeScript SDK reconnects to that forever with its attempt counter
// pinned at 0: 232,748 requests on 2026-10-08 and 233,327 on 2026-10-10, past
// this plan's 100,000/day. The 405 is the fix, so the 405 is the test.
test("GET /mcp refuses a stream request the way the transport spec asks", async () => {
  const stream = await worker.fetch(
    new Request("https://torob-mcp.test/mcp", { headers: { accept: "text/event-stream" } })
  );
  assert.equal(stream.status, 405, "an SSE client must be turned away, not fed HTML");
  assert.equal(stream.headers.get("allow"), "POST");
  assert.equal(stream.headers.get("cache-control"), "no-store");
  assert.equal(stream.headers.get("access-control-allow-origin"), "*");

  // No Accept header at all: curl, a bot, and the polling clients that send */*.
  const bare = await worker.fetch(new Request("https://torob-mcp.test/mcp"));
  assert.equal(bare.status, 405, "a client that never asked for HTML must not get HTML");
});

test("GET /mcp still serves the human connect page to a browser", async () => {
  const res = await worker.fetch(
    new Request("https://torob-mcp.test/mcp", { headers: { accept: "text/html,application/xhtml+xml" } })
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(res.headers.get("cache-control") || "", /public, max-age=\d+/, "the page must stay cacheable");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const html = await res.text();
  // The address to paste, with the scheme, is what a visitor came here for.
  assert.match(html, /https:\/\/torob-mcp\.mmdju3\.workers\.dev\/mcp/);
  assert.match(html, /کپی/);
  // The four Doran weights are served from /doran-*.woff2, not carried twice.
  assert.ok(html.length < 60_000, `GET /mcp is ${html.length} bytes - the fonts belong at /doran-*.woff2`);
  assert.ok(!html.includes("base64,d09GMg"), "the page must link the fonts, not embed them");
  assert.match(html, /\/doran-\d{3}\.woff2/);
});

test("HEAD /mcp answers what GET would, with the headers and no body", async () => {
  // A proxy or a health check that probes with HEAD used to fall through to
  // 404, which reads as "this is not an MCP endpoint" when it is one.
  const refused = await worker.fetch(new Request("https://torob-mcp.test/mcp", { method: "HEAD" }));
  assert.equal(refused.status, 405, "a HEAD must get the same status a GET would");
  assert.equal(refused.headers.get("allow"), "POST");
  assert.equal(await refused.text(), "", "and no body");

  const page = await worker.fetch(
    new Request("https://torob-mcp.test/mcp", { method: "HEAD", headers: { accept: "text/html" } })
  );
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(await page.text(), "", "the connect page is not sent twice");
});

test("the landing page is Persian and RTL", async () => {
  const res = await worker.fetch(new Request("https://torob-mcp.test/"));
  const html = await res.text();
  assert.match(html, /dir="rtl"/);
  assert.match(html, /مقایسه/);
});
