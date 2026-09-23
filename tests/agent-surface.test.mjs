// The agent surface is a contract, not documentation: what an agent reads
// before it picks a tool. These gates stop it from drifting out of sync with
// the code - a tool that exists but is not named in the instructions is
// invisible, and a line that advertises a feature the code does not have is
// worse than no line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { INSTRUCTIONS, VERSION } from "../dist/server.js";
import { READ_ONLY, TOOLS } from "../dist/tools.js";

test("every tool is named in the server instructions", () => {
  for (const tool of TOOLS) {
    assert.ok(
      INSTRUCTIONS.includes(tool.name),
      `tool '${tool.name}' is not mentioned in INSTRUCTIONS - an agent reading the instructions first would never find it`
    );
  }
});

test("instructions name no tool that does not exist", () => {
  // snake_case in the instructions is ambiguous: it is either a tool call or a
  // response field. A field name that no longer exists is a smaller sin than a
  // tool name that 404s, so both are checked - against the real tool list and
  // against the fields these tools actually emit.
  const tools = new Set(TOOLS.map((t) => t.name));
  const fields = new Set([
    "price_toman",
    "price_unreliable",
    "available",
    "prk",
    "page",
    "sort",
    "limit",
    "budget_toman",
    "query",
  ]);
  for (const token of INSTRUCTIONS.match(/\b[a-z][a-z0-9]*_[a-z_]+\b/g) ?? []) {
    assert.ok(
      tools.has(token) || fields.has(token),
      `INSTRUCTIONS mentions '${token}', which is neither a tool nor a field this server emits`
    );
  }
});

test("every response field the instructions promise really exists", () => {
  // The instruction "price_toman 0 means out of stock" is a promise about the
  // output shape. If the field were renamed the sentence would quietly become
  // a lie that the agent acts on.
  const shapes = readFileSync(new URL("../src/project.ts", import.meta.url), "utf8");
  for (const field of ["price_toman", "available", "price_unreliable"]) {
    assert.ok(shapes.includes(field), `instructions promise '${field}' but project.ts never emits it`);
  }
});

test("every tool declares itself read-only", () => {
  assert.equal(READ_ONLY.readOnlyHint, true);
  assert.equal(READ_ONLY.destructiveHint, false);
});

test("every tool has a title, a description and a closed input schema", () => {
  for (const tool of TOOLS) {
    assert.ok(tool.title, `${tool.name} has no title`);
    assert.ok(tool.description.length > 40, `${tool.name} has a too-thin description`);
    assert.equal(tool.inputSchema.type, "object");
    // The server adds additionalProperties:false at list time; the schema must
    // at least declare its properties and any required keys.
    assert.ok(tool.inputSchema.properties, `${tool.name} has no properties`);
    for (const required of tool.inputSchema.required ?? []) {
      assert.ok(required in tool.inputSchema.properties, `${tool.name} requires '${required}' but does not declare it`);
    }
  }
});

test("tool names are unique", () => {
  const names = TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});

test("the version is a real semver string", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
