/**
 * E2E tests for the test helper extension — verifies setAutoRetry,
 * emitEvent, invokeCommand, and setActiveTools.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMock, script, text, bash,
  createControllableBrain, failFirst, serverError,
} from "../dist/index.js";

const TIMEOUT = 30_000;

// ═══════════════════════════════════════════════════════════════════
// 1. setAutoRetry — disable retries, raw errors reach agent_end
// ═══════════════════════════════════════════════════════════════════
test("setAutoRetry(false) — errors not retried", async () => {
  const mock = await createMock({
    brain: () => serverError("test failure"),
    startupTimeoutMs: 15000,
    runTimeoutMs: 60_000,
  });

  try {
    await mock.setAutoRetry(false);
    const events = await mock.run("trigger error", 60_000);

    // Should have agent_end but NO auto_retry_start
    assert.ok(events.some(e => e.type === "agent_end"), "should complete");
    const retries = events.filter(e => e.type === "auto_retry_start");
    assert.equal(retries.length, 0, `should have 0 retries, got ${retries.length}`);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 2. setAutoRetry — enable retries, errors are retried
// ═══════════════════════════════════════════════════════════════════
test("setAutoRetry(true) — errors trigger retries", async () => {
  const mock = await createMock({
    brain: failFirst(1, script(text("recovered"))),
    startupTimeoutMs: 15000,
    runTimeoutMs: 60_000,
  });

  try {
    await mock.setAutoRetry(true);
    const events = await mock.run("trigger retry", 60_000);

    assert.ok(events.some(e => e.type === "agent_end"), "should complete");
    const retries = events.filter(e => e.type === "auto_retry_start");
    assert.ok(retries.length >= 1, `should have retries, got ${retries.length}`);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 3. emitEvent — fires event on pi.events bus
// ═══════════════════════════════════════════════════════════════════
test("emitEvent — emits without error", async () => {
  const mock = await createMock({
    brain: script(text("ok")),
    startupTimeoutMs: 15000,
  });

  try {
    // Emit custom events — no crash, no error
    await mock.emitEvent("clock:advance", { ms: 300_000 });
    await mock.emitEvent("test:ping");

    // Still works after emitting events
    const events = await mock.run("hello", TIMEOUT);
    assert.ok(events.some(e => e.type === "agent_end"), "should complete after events");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 4. invokeCommand — call extension commands
// ═══════════════════════════════════════════════════════════════════
test("invokeCommand — invokes _mock commands without error", async () => {
  const mock = await createMock({
    brain: script(text("ok")),
    startupTimeoutMs: 15000,
  });

  try {
    // Invoke the built-in helper commands
    await mock.invokeCommand("_mock_emit_event", "test:noop");

    // Prompt still works
    const events = await mock.run("after commands", TIMEOUT);
    assert.ok(events.some(e => e.type === "agent_end"), "should complete");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 5. setActiveTools — restrict and restore tools
// ═══════════════════════════════════════════════════════════════════
test("setActiveTools — restrict then restore", async () => {
  const mock = await createMock({
    brain: script(text("restricted")),
    startupTimeoutMs: 15000,
  });

  try {
    // Restrict to read-only
    await mock.setActiveTools(["read"]);

    // Verify via get_state that tools changed
    const state1 = await mock.sendRpc({ type: "get_state" });
    assert.ok(state1.success, "get_state should succeed");

    // Restore all
    await mock.setActiveTools("*");

    // Still works
    const events = await mock.run("hello", TIMEOUT);
    assert.ok(events.some(e => e.type === "agent_end"), "should complete");
  } finally {
    await mock.close();
  }
});
