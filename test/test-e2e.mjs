/**
 * End-to-end tests — spin up real pi processes with mock brains.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMock, script, bash, text, replay,
  flakyBrain, failFirst, errorAfter, rateLimited, overloaded, serverError,
} from "../dist/index.js";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";

mkdirSync("/tmp/pi-mock-e2e", { recursive: true });

const TIMEOUT = 30_000;

// ═══════════════════════════════════════════════════════════════════
// Test 1: Basic script brain — sanity check
// ═══════════════════════════════════════════════════════════════════
test("basic script brain", async () => {
  const mock = await createMock({
    brain: script(bash("echo hello"), text("done")),
    startupTimeoutMs: 15000,
  });

  try {
    const events = await mock.run("say hello", TIMEOUT);
    assert.ok(events.length > 0, "should have events");
    assert.ok(events.some(e => e.type === "agent_end"), "should have agent_end");
    assert.ok(mock.requests.length >= 1, `should have API requests, got ${mock.requests.length}`);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Test 2: Replay from JSON transcript (full format)
// ═══════════════════════════════════════════════════════════════════
test("replay brain — full transcript format", async () => {
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
    assert.ok(events.some(e => e.type === "agent_end"), "should complete");

    const toolCalls = events.filter(e => e.type === "tool_execution_start");
    assert.ok(toolCalls.length > 0, `should have tool execution, got ${toolCalls.length}`);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Test 3: Replay from simple array shorthand
// ═══════════════════════════════════════════════════════════════════
test("replay brain — simple array shorthand", async () => {
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
    assert.ok(events.some(e => e.type === "agent_end"), "should complete");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Test 4: failFirst — pi retries and recovers
// ═══════════════════════════════════════════════════════════════════
test("failFirst(1) — pi retries and recovers", async () => {
  const mock = await createMock({
    brain: failFirst(1, script(text("recovered!"))),
    startupTimeoutMs: 15000,
    runTimeoutMs: 60_000,
  });

  try {
    const events = await mock.run("test retry", 60_000);
    assert.ok(events.some(e => e.type === "agent_end"), "should eventually complete");

    const retryEvents = events.filter(e => e.type === "auto_retry_start");
    assert.ok(retryEvents.length >= 1, `should have auto_retry_start, got ${retryEvents.length}`);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Test 5: errorAfter — verify pi sees the error
// ═══════════════════════════════════════════════════════════════════
test("errorAfter(1) — first succeeds, second errors", async () => {
  const mock = await createMock({
    brain: errorAfter(1, script(bash("echo ok"), text("this should not run"))),
    startupTimeoutMs: 15000,
    runTimeoutMs: 60_000,
  });

  try {
    const events = await mock.run("test error after", 60_000);
    assert.ok(events.some(e => e.type === "agent_end"), "should complete");
    assert.ok(mock.requests.length >= 2, `should have ≥2 API requests, got ${mock.requests.length}`);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Test 6: Gateway returns proper error format
// ═══════════════════════════════════════════════════════════════════
test("HttpErrorBlock returns real HTTP errors", async () => {
  const mock = await createMock({
    brain: () => rateLimited(1),
    startupTimeoutMs: 15000,
    runTimeoutMs: 60_000,
  });

  try {
    const events = await mock.run("test rate limit", 60_000);
    assert.ok(events.some(e => e.type === "agent_end"), "should eventually end");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// Test 7: Use pi's OpenAI provider adapter against the mock gateway
// ═══════════════════════════════════════════════════════════════════
test("piProvider=openai sends OpenAI Responses requests to the gateway", async () => {
  const mock = await createMock({
    brain: () => text("ok"),
    piProvider: "openai",
    piModel: "gpt-4.1-mini",
    startupTimeoutMs: 15000,
  });

  try {
    const events = await mock.run("hello from openai", TIMEOUT);
    assert.ok(events.some(e => e.type === "agent_end"), "should complete");

    const req = mock.requests.at(-1);
    assert.ok(req, "should capture provider request");
    assert.equal(req._provider, "openai-responses");
    assert.equal(req.model, "gpt-4.1-mini");
    assert.ok(req.messages.length >= 1, "should include at least one message");
  } finally {
    await mock.close();
  }
});

// Cleanup
// ═══════════════════════════════════════════════════════════════════
test.after(() => {
  try { unlinkSync("/tmp/pi-mock-e2e/test-transcript.json"); } catch {}
  try { unlinkSync("/tmp/pi-mock-e2e/test-simple.json"); } catch {}
});
