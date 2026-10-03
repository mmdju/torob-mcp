// The landing page shows the project's GitHub face: a GitHub button with a
// live stars badge, and stars/forks tiles in the stats panel fed by the same
// api.github.com fetch. This pins that wiring so a landing regen cannot drop it.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../dist/worker.js";

const landing = async () => {
  const res = await worker.fetch(new Request("https://torob-mcp.test/"));
  assert.equal(res.status, 200);
  return res.text();
};

test("the first button links to GitHub and carries a live stars badge", async () => {
  const html = await landing();
  assert.match(html, /href="https:\/\/github\.com\/mmdju\/torob-mcp"/);
  assert.match(html, /id="stars"/);
});

test("the stats panel has live stars and forks tiles", async () => {
  const html = await landing();
  assert.match(html, /id="stStars"/);
  assert.match(html, /id="stForks"/);
});

test("one GitHub fetch feeds the badge and both tiles", async () => {
  const html = await landing();
  assert.match(html, /api\.github\.com\/repos\/mmdju\/torob-mcp/);
  assert.match(html, /stargazers_count/);
  assert.match(html, /forks_count/);
});
