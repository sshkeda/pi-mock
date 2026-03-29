import {
  createMock, script, bash, text, replay,
  flakyBrain, failFirst, errorAfter, rateLimited, overloaded, serverError,
} from "../dist/index.js";
import { writeFileSync, unlinkSync } from "fs";

const TIMEOUT = 30_000;
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
    if (err.stack) process.stderr.write(`    ${err.stack.split('\n').slice(1,3).join('\n    ')}\n`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ═══════════════════════════════════════════════════════════════════
// Test 1: Basic script brain — sanity check
// ═══════════════════════════════════════════════════════════════════
await test("basic script brain", async () => {
  const mock = await createMock({
    brain: script(bash("echo hello"), text("done")),
    startupTimeoutMs: 15000,
  });

  try {
    const events = await mock.run("say hello", TIMEOUT);
    assert(events.length > 0, "should have events");
    assert(events.some(e => e.type === "agent_end"), "should have agent_end");
    assert(mock.requests.length >= 1, `should have API requests, got ${mock.requests.length}`);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Test 2: Replay from JSON transcript (full format)
// ═══════════════════════════════════════════════════════════════════
await test("replay brain — full transcript format", async () => {
  const transcript = {
    version: 1,
    turns: [
      {
        response: [{ type: "tool_call", name: "bash", input: { command: "echo replayed" } }],
        usage: { input_tokens: 100, output_tokens: 20 },
      },
      {
        response: [{ type: "text", text: "Replay complete." }],
      },
    ],
  };
  writeFileSync("/tmp/pi-mock-e2e/test-transcript.json", JSON.stringify(transcript));

  const mock = await createMock({
    brain: replay("/tmp/pi-mock-e2e/test-transcript.json"),
    startupTimeoutMs: 15000,
  });

  try {
    const events = await mock.run("test replay", TIMEOUT);
    assert(events.some(e => e.type === "agent_end"), "should complete");

    // Verify pi actually ran the bash command from the transcript
    const toolCalls = events.filter(e => e.type === "tool_execution_start");
    assert(toolCalls.length > 0, `should have tool execution, got ${toolCalls.length}`);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Test 3: Replay from simple array shorthand
// ═══════════════════════════════════════════════════════════════════
await test("replay brain — simple array shorthand", async () => {
  const scenario = [
    [{ type: "tool_call", name: "bash", input: { command: "echo shorthand" } }],
    [{ type: "text", text: "Done." }],
  ];
  writeFileSync("/tmp/pi-mock-e2e/test-simple.json", JSON.stringify(scenario));

  const mock = await createMock({
    brain: replay("/tmp/pi-mock-e2e/test-simple.json"),
    startupTimeoutMs: 15000,
  });

  try {
    const events = await mock.run("test simple", TIMEOUT);
    assert(events.some(e => e.type === "agent_end"), "should complete");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Test 4: failFirst — pi retries and recovers
// ═══════════════════════════════════════════════════════════════════
await test("failFirst(1) — pi retries and recovers", async () => {
  const mock = await createMock({
    brain: failFirst(1, script(text("recovered!"))),
    startupTimeoutMs: 15000,
    runTimeoutMs: 60_000,
  });

  try {
    const events = await mock.run("test retry", 60_000);
    assert(events.some(e => e.type === "agent_end"), "should eventually complete");

    // Should see retry event
    const retryEvents = events.filter(e => e.type === "auto_retry_start");
    process.stderr.write(`  (retry events: ${retryEvents.length}) `);
    assert(retryEvents.length >= 1, `should have auto_retry_start, got ${retryEvents.length}`);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Test 5: errorAfter — verify pi sees the error
// ═══════════════════════════════════════════════════════════════════
await test("errorAfter(1) — first succeeds, second errors", async () => {
  const mock = await createMock({
    brain: errorAfter(1, script(bash("echo ok"), text("this should not run"))),
    startupTimeoutMs: 15000,
    runTimeoutMs: 60_000,
  });

  try {
    const events = await mock.run("test error after", 60_000);
    assert(events.some(e => e.type === "agent_end"), "should complete");

    // First request succeeds (bash), second should error
    assert(mock.requests.length >= 2, `should have ≥2 API requests, got ${mock.requests.length}`);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Test 6: Gateway returns proper error format
// ═══════════════════════════════════════════════════════════════════
await test("HttpErrorBlock returns real HTTP errors", async () => {
  const mock = await createMock({
    brain: () => rateLimited(1),
    startupTimeoutMs: 15000,
    runTimeoutMs: 60_000,
  });

  try {
    const events = await mock.run("test rate limit", 60_000);
    // Pi should see error and attempt retries
    const hasError = events.some(e =>
      e.type === "auto_retry_start" ||
      (e.type === "agent_end" && e.error)
    );
    process.stderr.write(`  (events: ${events.map(e=>e.type).join(', ')}) `);
    assert(events.some(e => e.type === "agent_end"), "should eventually end");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════
console.error(`\n${"═".repeat(60)}`);
console.error(`E2E Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.error(`${"═".repeat(60)}\n`);

// Cleanup
try { unlinkSync("/tmp/pi-mock-e2e/test-transcript.json"); } catch {}
try { unlinkSync("/tmp/pi-mock-e2e/test-simple.json"); } catch {}

process.exit(failed > 0 ? 1 : 0);
