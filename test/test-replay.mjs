/**
 * Tests for record/replay — transcript normalization, replay brain,
 * divergence detection, and exhaustion handling.
 *
 * Does NOT require a real API key — tests the replay/parsing side only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { replay } from "../dist/index.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TMP = "/tmp/pi-mock-replay-test";
mkdirSync(TMP, { recursive: true });

/** Fake API request for calling brain functions. */
function fakeReq(msg = "hello", msgCount = 1) {
  return {
    model: "mock",
    messages: [{ role: "user", content: msg }],
    max_tokens: 1024,
    _msgCount: msgCount,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Transcript format: full object
// ═══════════════════════════════════════════════════════════════════

test("replay — full transcript format", async () => {
  const path = join(TMP, "full.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      recorded: "2026-03-29T00:00:00Z",
      meta: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      turns: [
        { response: [{ type: "tool_call", name: "bash", input: { command: "ls" } }] },
        { response: [{ type: "text", text: "Done!" }] },
      ],
    }),
  );

  const brain = replay(path);

  const r1 = await brain(fakeReq(), 0);
  assert.ok(!Array.isArray(r1), "single block should not be array");
  assert.equal(r1.type, "tool_call");
  assert.equal(r1.name, "bash");

  const r2 = await brain(fakeReq(), 1);
  assert.equal(r2.type, "text");
  assert.equal(r2.text, "Done!");
});

// ═══════════════════════════════════════════════════════════════════
// Transcript format: array of turns
// ═══════════════════════════════════════════════════════════════════

test("replay — array of TranscriptTurn objects", async () => {
  const path = join(TMP, "turns.json");
  writeFileSync(
    path,
    JSON.stringify([
      { response: [{ type: "text", text: "first" }] },
      { response: [{ type: "text", text: "second" }] },
    ]),
  );

  const brain = replay(path);
  const r1 = await brain(fakeReq(), 0);
  assert.equal(r1.text, "first");
  const r2 = await brain(fakeReq(), 1);
  assert.equal(r2.text, "second");
});

// ═══════════════════════════════════════════════════════════════════
// Transcript format: simple array shorthand
// ═══════════════════════════════════════════════════════════════════

test("replay — simple array shorthand (array of arrays)", async () => {
  const path = join(TMP, "simple.json");
  writeFileSync(
    path,
    JSON.stringify([
      [{ type: "tool_call", name: "bash", input: { command: "echo hi" } }],
      [{ type: "text", text: "all done" }],
    ]),
  );

  const brain = replay(path);
  const r1 = await brain(fakeReq(), 0);
  assert.equal(r1.type, "tool_call");
  assert.equal(r1.name, "bash");

  const r2 = await brain(fakeReq(), 1);
  assert.equal(r2.type, "text");
  assert.equal(r2.text, "all done");
});

// ═══════════════════════════════════════════════════════════════════
// Transcript format: flat array of single blocks
// ═══════════════════════════════════════════════════════════════════

test("replay — flat array of ResponseBlocks", async () => {
  const path = join(TMP, "flat.json");
  writeFileSync(
    path,
    JSON.stringify([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ]),
  );

  const brain = replay(path);
  const r1 = await brain(fakeReq(), 0);
  assert.equal(r1.text, "one");
  const r2 = await brain(fakeReq(), 1);
  assert.equal(r2.text, "two");
});

// ═══════════════════════════════════════════════════════════════════
// Multiple blocks in one turn
// ═══════════════════════════════════════════════════════════════════

test("replay — multi-block turn returns array", async () => {
  const path = join(TMP, "multi.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      turns: [
        {
          response: [
            { type: "thinking", thinking: "hmm" },
            { type: "tool_call", name: "bash", input: { command: "ls" } },
            { type: "text", text: "done" },
          ],
        },
      ],
    }),
  );

  const brain = replay(path);
  const r1 = await brain(fakeReq(), 0);
  assert.ok(Array.isArray(r1), "multi-block should be array");
  assert.equal(r1.length, 3);
  assert.equal(r1[0].type, "thinking");
  assert.equal(r1[1].type, "tool_call");
  assert.equal(r1[2].type, "text");
});

// ═══════════════════════════════════════════════════════════════════
// Exhaustion
// ═══════════════════════════════════════════════════════════════════

test("replay — exhausted transcript throws error", async () => {
  const path = join(TMP, "short.json");
  writeFileSync(path, JSON.stringify([{ type: "text", text: "only one" }]));

  const brain = replay(path);
  const r1 = await brain(fakeReq(), 0);
  assert.equal(r1.text, "only one");

  let threw = false;
  try {
    await brain(fakeReq(), 1);
  } catch (err) {
    threw = true;
    assert.ok(err.message.includes("exhausted"), `error should mention exhausted: ${err.message}`);
  }
  assert.ok(threw, "replay should throw when exhausted");
});

// ═══════════════════════════════════════════════════════════════════
// Divergence detection
// ═══════════════════════════════════════════════════════════════════

test("replay — divergence callback fires on mismatch", async () => {
  const path = join(TMP, "diverge.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      turns: [
        {
          response: [{ type: "text", text: "ok" }],
          request: {
            model: "claude-sonnet-4-20250514",
            messageCount: 5,
            lastUserPrefix: "build a todo app",
          },
        },
      ],
    }),
  );

  const divergences = [];
  const brain = replay(path, {
    onDivergence: (index, expected, actual) => {
      divergences.push({ index, expected, actual });
    },
  });

  await brain(fakeReq("different prompt", 1), 0);

  assert.equal(divergences.length, 1);
  assert.equal(divergences[0].index, 0);
  assert.equal(divergences[0].expected.messageCount, 5);
});

test("replay — no divergence when fingerprint matches", async () => {
  const path = join(TMP, "nodiv.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      turns: [
        {
          response: [{ type: "text", text: "ok" }],
          request: {
            model: "mock",
            messageCount: 1,
            lastUserPrefix: "hello",
          },
        },
      ],
    }),
  );

  const divergences = [];
  const brain = replay(path, {
    onDivergence: (index, expected, actual) => {
      divergences.push({ index });
    },
  });

  await brain(fakeReq("hello"), 0);
  assert.equal(divergences.length, 0);
});

test("replay — no divergence when no fingerprint in transcript", async () => {
  const path = join(TMP, "nofp.json");
  writeFileSync(
    path,
    JSON.stringify([{ response: [{ type: "text", text: "ok" }] }]),
  );

  const divergences = [];
  const brain = replay(path, {
    onDivergence: () => divergences.push(true),
  });

  await brain(fakeReq("anything"), 0);
  assert.equal(divergences.length, 0);
});

// ═══════════════════════════════════════════════════════════════════
// In-memory transcript (no file)
// ═══════════════════════════════════════════════════════════════════

test("replay — accepts Transcript object directly", async () => {
  const brain = replay({
    version: 1,
    turns: [{ response: [{ type: "text", text: "in-memory" }] }],
  });

  const r = await brain(fakeReq(), 0);
  assert.equal(r.text, "in-memory");
});

test("replay — accepts array of turns directly", async () => {
  const brain = replay([
    { response: [{ type: "text", text: "arr-1" }] },
    { response: [{ type: "text", text: "arr-2" }] },
  ]);

  const r1 = await brain(fakeReq(), 0);
  assert.equal(r1.text, "arr-1");
  const r2 = await brain(fakeReq(), 1);
  assert.equal(r2.text, "arr-2");
});

// ═══════════════════════════════════════════════════════════════════
// Empty transcript
// ═══════════════════════════════════════════════════════════════════

test("replay — empty transcript throws on first call", async () => {
  const brain = replay({ version: 1, turns: [] });
  let threw = false;
  try {
    await brain(fakeReq(), 0);
  } catch (err) {
    threw = true;
    assert.ok(err.message.includes("exhausted"), `error should mention exhausted: ${err.message}`);
  }
  assert.ok(threw, "empty replay should throw on first call");
});

// ═══════════════════════════════════════════════════════════════════
// Usage preservation
// ═══════════════════════════════════════════════════════════════════

test("replay — preserves tool_call input correctly", async () => {
  const path = join(TMP, "toolinput.json");
  const complexInput = {
    command: "echo 'hello world'",
    timeout: 30,
    nested: { key: "value", arr: [1, 2, 3] },
  };
  writeFileSync(
    path,
    JSON.stringify([
      [{ type: "tool_call", name: "bash", input: complexInput }],
    ]),
  );

  const brain = replay(path);
  const r = await brain(fakeReq(), 0);
  assert.equal(r.type, "tool_call");
  assert.deepEqual(r.input, complexInput);
});

// ═══════════════════════════════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════════════════════════════
test.after(() => {
  try { rmSync(TMP, { recursive: true }); } catch {}
});
