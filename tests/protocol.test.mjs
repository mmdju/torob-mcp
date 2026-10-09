// The protocol layer is the one part of the server nothing else exercises:
// every other file calls a tool's run() directly, which skips buildServer's
// dispatch entirely - so "Unknown tool", the JSON envelope, and the conversion
// of a thrown error into isError could all rot without a single test failing.
//
// fetch is stubbed for the whole file. Without it a test that reaches upstream
// would spend a real request against Torob, which is the one thing this suite
// must never do while the wall is up - the stub is the safety net, not a
// convenience.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/server.js";
import { setPaceForTests, setRetryDelayForTests } from "../dist/http.js";

setPaceForTests(0);
setRetryDelayForTests(0);

const realFetch = globalThis.fetch;
let fetchCalls = 0;

afterEach(() => {
  globalThis.fetch = realFetch;
  fetchCalls = 0;
});

const SEARCH_BODY = {
  results: [
    {
      random_key: "prk-proto",
      name1: "گوشی آزمایشی",
      price: 1000,
      price_text: "۱٫۰۰۰ تومان",
      web_client_absolute_url: "/p/prk-proto/",
      more_info_url: "https://api.torob.com/v4/base-product/details/?search_id=s1&prk=prk-proto",
    },
  ],
  count: 1,
  next: "",
};

async function connected() {
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response(JSON.stringify(SEARCH_BODY), {
      headers: { "content-type": "application/json" },
    });
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "protocol-test", version: "0" });
  await client.connect(clientTransport);
  return { client, server };
}

async function using(fn) {
  const { client, server } = await connected();
  try {
    return await fn(client);
  } finally {
    try {
      await client.close();
    } catch {
      /* already closed */
    }
    try {
      await server.close();
    } catch {
      /* already closed */
    }
  }
}

test("tools/list over the wire offers the fifteen tools without touching upstream", async () => {
  await using(async (client) => {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 15);
    assert.equal(fetchCalls, 0, "listing the tools must never cost an upstream request");
  });
});

test("an unknown tool is an isError answer that names what is available", async () => {
  await using(async (client) => {
    const result = await client.callTool({ name: "no-such-tool", arguments: {} });
    assert.equal(result.isError, true, "an unknown tool must be reported, not thrown past the caller");
    const text = result.content.map((c) => c.text ?? "").join("");
    assert.match(text, /Unknown tool/);
    assert.match(text, /search_products/, "the message has to say what does exist");
    assert.equal(fetchCalls, 0, "an unknown tool must not reach upstream");
  });
});

test("a tool error arrives as a sentence in isError, not as JSON the caller must parse", async () => {
  await using(async (client) => {
    // details_url for a *different* product than the prk is refused before any
    // upstream call: the id is what the question is about.
    const result = await client.callTool({
      name: "product_details",
      arguments: {
        prk: "aaaaaaaa-1111-2222-3333-444444444444",
        details_url: "https://api.torob.com/v4/base-product/details/?search_id=s1&prk=bbbbbbbb-1111-2222-3333-444444444444",
      },
    });
    assert.equal(result.isError, true, "a refused call must come back as isError");
    const text = result.content.map((c) => c.text ?? "").join("");
    assert.match(text, /different product/);
    assert.throws(() => JSON.parse(text), SyntaxError, "an error must be prose, never JSON");
    assert.equal(fetchCalls, 0, "the refusal happens before anything is asked of Torob");
  });
});

test("a successful call comes back as parseable JSON in one text block", async () => {
  await using(async (client) => {
    const result = await client.callTool({ name: "search_products", arguments: { query: "گوشی" } });
    assert.notEqual(result.isError, true, `unexpected error: ${JSON.stringify(result)}`);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.products.length, 1);
    assert.equal(payload.products[0].prk, "prk-proto");
    assert.equal(fetchCalls, 1, "exactly one upstream call for one search");
  });
});
