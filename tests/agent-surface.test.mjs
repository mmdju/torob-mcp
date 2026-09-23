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
  // snake_case in the instructions is ambiguous: it is either a tool call, a
  // response field, or an upstream slug the server deliberately refuses. All
  // three are checked, because a name an agent cannot use is a small lie.
  const tools = new Set(TOOLS.map((t) => t.name));
  const fields = new Set([
    "price_toman",
    "price_unreliable",
    "available",
    "available_filters",
    "min_price_toman",
    "max_price_toman",
    "budget_toman",
    "suggested_categories",
    "prk",
  ]);
  for (const token of INSTRUCTIONS.match(/\b[a-z][a-z0-9]*_[a-z_]+\b/g) ?? []) {
    assert.ok(
      tools.has(token) || fields.has(token) || token === "filters",
      `INSTRUCTIONS mentions '${token}', which is neither a tool nor a field this server emits`
    );
  }
});

test("every filter slug the instructions promise is one the server accepts", () => {
  // The instructions tell an agent to read slugs off available_filters and
  // pass them back. A slug the server then refuses would be a loop that can
  // never succeed.
  assert.match(INSTRUCTIONS, /available_filters/);
  const schema = TOOLS.find((t) => t.name === "search_products").inputSchema;
  assert.ok(schema.properties.filters, "search_products must accept a filters object");
  assert.ok(schema.properties.min_price_toman, "search_products must accept a price floor");
  assert.ok(schema.properties.max_price_toman, "search_products must accept a price ceiling");
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
