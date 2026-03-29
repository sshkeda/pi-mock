/**
 * Tests for record/replay — transcript normalization, replay brain,
 * divergence detection, and exhaustion handling.
 *
 * Tests record.ts which previously had minimal coverage (only through e2e).
 * Does NOT require a real API key — tests the replay/parsing side only.
 */
import { replay, text, bash, toolCall, thinking } from "../dist/index.js";
import { writeFileSync, mkdirSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  process.stderr.write(`\n━━━ ${name} `);
  try {
    await fn();
    passed++;
    process.stderr.write(`✅ PASS\n`);
  } catch (err) {
    failed++;
    process.stderr.write(`❌ FAIL: ${err.message}\n`);
    if (err.stack) process.stderr.write(`    ${err.stack.split("\n").slice(1, 3).join("\n    ")}\n`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

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

await test("replay — full transcript format", async () => {
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
  assert(!Array.isArray(r1), "single block should not be array");
  assert(r1.type === "tool_call", `r1 type: ${r1.type}`);
  assert(r1.name === "bash", `r1 name: ${r1.name}`);

  const r2 = await brain(fakeReq(), 1);
  assert(r2.type === "text", `r2 type: ${r2.type}`);
  assert(r2.text === "Done!", `r2 text: ${r2.text}`);
});

// ═══════════════════════════════════════════════════════════════════
// Transcript format: array of turns
// ═══════════════════════════════════════════════════════════════════

await test("replay — array of TranscriptTurn objects", async () => {
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
  assert(r1.text === "first", `r1: ${r1.text}`);
  const r2 = await brain(fakeReq(), 1);
  assert(r2.text === "second", `r2: ${r2.text}`);
});

// ═══════════════════════════════════════════════════════════════════
// Transcript format: simple array shorthand
// ═══════════════════════════════════════════════════════════════════

await test("replay — simple array shorthand (array of arrays)", async () => {
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
  assert(r1.type === "tool_call", `r1 type: ${r1.type}`);
  assert(r1.name === "bash", `r1 name: ${r1.name}`);

  const r2 = await brain(fakeReq(), 1);
  assert(r2.type === "text", `r2 type: ${r2.type}`);
  assert(r2.text === "all done", `r2 text: ${r2.text}`);
});

// ═══════════════════════════════════════════════════════════════════
// Transcript format: flat array of single blocks
// ═══════════════════════════════════════════════════════════════════

await test("replay — flat array of ResponseBlocks", async () => {
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
  assert(r1.text === "one", `r1: ${r1.text}`);
  const r2 = await brain(fakeReq(), 1);
  assert(r2.text === "two", `r2: ${r2.text}`);
});

// ═══════════════════════════════════════════════════════════════════
// Multiple blocks in one turn
// ═══════════════════════════════════════════════════════════════════

await test("replay — multi-block turn returns array", async () => {
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
  assert(Array.isArray(r1), "multi-block should be array");
  assert(r1.length === 3, `blocks: ${r1.length}`);
  assert(r1[0].type === "thinking", `block 0: ${r1[0].type}`);
  assert(r1[1].type === "tool_call", `block 1: ${r1[1].type}`);
  assert(r1[2].type === "text", `block 2: ${r1[2].type}`);
});

// ═══════════════════════════════════════════════════════════════════
// Exhaustion
// ═══════════════════════════════════════════════════════════════════

await test("replay — exhausted transcript throws error", async () => {
  const path = join(TMP, "short.json");
  writeFileSync(path, JSON.stringify([{ type: "text", text: "only one" }]));

  const brain = replay(path);
  const r1 = await brain(fakeReq(), 0);
  assert(r1.text === "only one", `r1: ${r1.text}`);

  // Second call — exhausted, should throw
  let threw = false;
  try {
    await brain(fakeReq(), 1);
  } catch (err) {
    threw = true;
    assert(err.message.includes("exhausted"), `error should mention exhausted: ${err.message}`);
  }
  assert(threw, "replay should throw when exhausted");
});

// ═══════════════════════════════════════════════════════════════════
// Divergence detection
// ═══════════════════════════════════════════════════════════════════

await test("replay — divergence callback fires on mismatch", async () => {
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

  // Send request with different messageCount than recorded
  await brain(fakeReq("different prompt", 1), 0);

  assert(divergences.length === 1, `divergences: ${divergences.length}`);
  assert(divergences[0].index === 0, `index: ${divergences[0].index}`);
  assert(divergences[0].expected.messageCount === 5, `expected msgs: ${divergences[0].expected.messageCount}`);
  process.stderr.write(`  (divergence detected at turn 0) `);
});

await test("replay — no divergence when fingerprint matches", async () => {
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
  assert(divergences.length === 0, `should not diverge: ${divergences.length}`);
});

await test("replay — no divergence when no fingerprint in transcript", async () => {
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
  assert(divergences.length === 0, `should not diverge without fingerprint`);
});

// ═══════════════════════════════════════════════════════════════════
// In-memory transcript (no file)
// ═══════════════════════════════════════════════════════════════════

await test("replay — accepts Transcript object directly", async () => {
  const brain = replay({
    version: 1,
    turns: [{ response: [{ type: "text", text: "in-memory" }] }],
  });

  const r = await brain(fakeReq(), 0);
  assert(r.text === "in-memory", `text: ${r.text}`);
});

await test("replay — accepts array of turns directly", async () => {
  const brain = replay([
    { response: [{ type: "text", text: "arr-1" }] },
    { response: [{ type: "text", text: "arr-2" }] },
  ]);

  const r1 = await brain(fakeReq(), 0);
  assert(r1.text === "arr-1", `r1: ${r1.text}`);
  const r2 = await brain(fakeReq(), 1);
  assert(r2.text === "arr-2", `r2: ${r2.text}`);
});

// ═══════════════════════════════════════════════════════════════════
// Empty transcript
// ═══════════════════════════════════════════════════════════════════

await test("replay — empty transcript throws on first call", async () => {
  const brain = replay({ version: 1, turns: [] });
  let threw = false;
  try {
    await brain(fakeReq(), 0);
  } catch (err) {
    threw = true;
    assert(err.message.includes("exhausted"), `error should mention exhausted: ${err.message}`);
  }
  assert(threw, "empty replay should throw on first call");
});

// ═══════════════════════════════════════════════════════════════════
// Usage preservation
// ═══════════════════════════════════════════════════════════════════

await test("replay — preserves tool_call input correctly", async () => {
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
  assert(r.type === "tool_call", `type: ${r.type}`);
  assert(JSON.stringify(r.input) === JSON.stringify(complexInput), "input should match exactly");
});

// ═══════════════════════════════════════════════════════════════════
// Cleanup + Summary
// ═══════════════════════════════════════════════════════════════════
try {
  rmSync(TMP, { recursive: true });
} catch {}

console.error(`\n${"═".repeat(60)}`);
console.error(`Replay tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.error(`${"═".repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
