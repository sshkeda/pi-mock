/**
 * Tests for pi-mock's UI capture features:
 *   - notifications (ctx.ui.notify)
 *   - status updates (ctx.ui.setStatus)
 *   - widget updates (ctx.ui.setWidget)
 *   - slash command output capture (invokeCommand returns side effects)
 *   - waitForNotification / waitForStatusUpdate
 *   - getCommands (slash command discovery)
 *   - getCompletions (argument completions)
 *
 * Uses a generic test extension (test/fixtures/test-ui-extension.mjs)
 * that registers commands exercising each ctx.ui method.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createMock, script, text } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = resolve(__dirname, "fixtures/test-ui-extension.mjs");
const TIMEOUT = 30_000;

function makeMock() {
  return createMock({
    brain: script(text("ok")),
    extensions: [EXT_PATH],
    startupTimeoutMs: 15_000,
  });
}

// ═══════════════════════════════════════════════════════════════════
// 1. Notification capture — invokeCommand returns notifications
// ═══════════════════════════════════════════════════════════════════
test("invokeCommand captures notifications", async () => {
  const mock = await makeMock();
  try {
    const result = await mock.invokeCommand("test-notify", "hello world");
    assert.ok(result.notifications.length >= 1, "should capture at least 1 notification");
    const n = result.notifications.find(n => n.message === "hello world");
    assert.ok(n, "should capture the exact notification message");
    assert.equal(n.notifyType, "info", "default type should be info");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 2. Notification types — warning, error
// ═══════════════════════════════════════════════════════════════════
test("notification types are captured correctly", async () => {
  const mock = await makeMock();
  try {
    await mock.invokeCommand("test-notify", "warn msg|warning");
    await mock.invokeCommand("test-error-notify", "err msg");

    const warn = mock.notifications.find(n => n.message === "warn msg");
    assert.ok(warn, "should have warning notification");
    assert.equal(warn.notifyType, "warning");

    const err = mock.notifications.find(n => n.message === "err msg");
    assert.ok(err, "should have error notification");
    assert.equal(err.notifyType, "error");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 3. Status update capture
// ═══════════════════════════════════════════════════════════════════
test("invokeCommand captures status updates", async () => {
  const mock = await makeMock();
  try {
    const result = await mock.invokeCommand("test-status", "mykey online");
    assert.ok(result.statusUpdates.length >= 1, "should capture status update");
    const s = result.statusUpdates.find(s => s.key === "mykey");
    assert.ok(s, "should capture status with correct key");
    assert.equal(s.text, "online");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 4. Status clear (text = undefined)
// ═══════════════════════════════════════════════════════════════════
test("status clear sets text to undefined", async () => {
  const mock = await makeMock();
  try {
    await mock.invokeCommand("test-status", "mykey online");
    const result = await mock.invokeCommand("test-status", "mykey clear");
    const s = result.statusUpdates.find(s => s.key === "mykey");
    assert.ok(s, "should have status update");
    assert.equal(s.text, undefined, "cleared status should have undefined text");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 5. Widget capture
// ═══════════════════════════════════════════════════════════════════
test("widget updates are captured", async () => {
  const mock = await makeMock();
  try {
    await mock.invokeCommand("test-widget", "dash hello|world");
    assert.ok(mock.widgets.length >= 1, "should capture widget");
    const w = mock.widgets.find(w => w.key === "dash");
    assert.ok(w, "should find widget by key");
    assert.deepEqual(w.lines, ["hello", "world"]);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 6. Multiple side effects from one command
// ═══════════════════════════════════════════════════════════════════
test("invokeCommand captures multiple side effects", async () => {
  const mock = await makeMock();
  try {
    const result = await mock.invokeCommand("test-multi");
    assert.ok(result.notifications.length >= 1, "should have notification");
    assert.ok(result.statusUpdates.length >= 1, "should have status update");

    // Also check the global arrays
    assert.ok(
      mock.notifications.some(n => n.message === "multi-notification"),
      "global notifications should include multi-notification"
    );
    assert.ok(
      mock.statusUpdates.some(s => s.key === "multi-key" && s.text === "multi-status"),
      "global statusUpdates should include multi-key"
    );
    assert.ok(
      mock.widgets.some(w => w.key === "multi-widget"),
      "global widgets should include multi-widget"
    );
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 7. waitForNotification — resolves on match
// ═══════════════════════════════════════════════════════════════════
test("waitForNotification resolves when notification matches", async () => {
  const mock = await makeMock();
  try {
    // Fire notification then wait (should resolve from existing)
    await mock.invokeCommand("test-notify", "target-msg");
    const n = await mock.waitForNotification(
      n => n.message === "target-msg",
      5_000,
    );
    assert.equal(n.message, "target-msg");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 8. waitForNotification — times out when no match
// ═══════════════════════════════════════════════════════════════════
test("waitForNotification times out on no match", async () => {
  const mock = await makeMock();
  try {
    await assert.rejects(
      () => mock.waitForNotification(n => n.message === "never", 500),
      /timeout/i,
    );
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 9. waitForStatusUpdate — resolves on match
// ═══════════════════════════════════════════════════════════════════
test("waitForStatusUpdate resolves when status matches", async () => {
  const mock = await makeMock();
  try {
    await mock.invokeCommand("test-status", "health ok");
    const s = await mock.waitForStatusUpdate(
      s => s.key === "health",
      5_000,
    );
    assert.equal(s.key, "health");
    assert.equal(s.text, "ok");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 10. waitForStatusUpdate — times out when no match
// ═══════════════════════════════════════════════════════════════════
test("waitForStatusUpdate times out on no match", async () => {
  const mock = await makeMock();
  try {
    await assert.rejects(
      () => mock.waitForStatusUpdate(s => s.key === "never", 500),
      /timeout/i,
    );
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 11. getCommands — lists registered commands
// ═══════════════════════════════════════════════════════════════════
test("getCommands returns registered slash commands", async () => {
  const mock = await makeMock();
  try {
    const commands = await mock.getCommands();
    assert.ok(Array.isArray(commands), "should return array");
    assert.ok(commands.length > 0, "should have commands");

    // Our test extension registers these
    const names = commands.map(c => c.name);
    assert.ok(names.includes("test-notify"), "should include test-notify");
    assert.ok(names.includes("test-status"), "should include test-status");
    assert.ok(names.includes("test-completable"), "should include test-completable");

    // Each command should have structure
    const cmd = commands.find(c => c.name === "test-notify");
    assert.ok(cmd.description, "should have description");
    assert.ok(cmd.source, "should have source");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 12. Notifications accumulate across multiple commands
// ═══════════════════════════════════════════════════════════════════
test("notifications accumulate globally across commands", async () => {
  const mock = await makeMock();
  try {
    await mock.invokeCommand("test-notify", "first");
    await mock.invokeCommand("test-notify", "second");
    await mock.invokeCommand("test-notify", "third");

    assert.ok(mock.notifications.length >= 3, `should have 3+ notifications, got ${mock.notifications.length}`);
    const msgs = mock.notifications.map(n => n.message);
    assert.ok(msgs.includes("first"));
    assert.ok(msgs.includes("second"));
    assert.ok(msgs.includes("third"));
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 13. invokeCommand on unknown command — errors cleanly
// ═══════════════════════════════════════════════════════════════════
test("invokeCommand on unknown command does not crash", async () => {
  const mock = await makeMock();
  try {
    // Unknown commands are handled by pi — may error or do nothing,
    // but should not crash the mock
    try {
      await mock.invokeCommand("nonexistent-command-xyz");
    } catch {
      // Expected — some pi versions reject unknown commands
    }
    // Mock should still be alive
    const events = await mock.run("still alive", TIMEOUT);
    assert.ok(events.some(e => e.type === "agent_end"), "should still work after bad command");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 14. Notifications have timestamps
// ═══════════════════════════════════════════════════════════════════
test("captured notifications have timestamps", async () => {
  const mock = await makeMock();
  try {
    const before = Date.now();
    await mock.invokeCommand("test-notify", "timed");
    const after = Date.now();

    const n = mock.notifications.find(n => n.message === "timed");
    assert.ok(n, "should have notification");
    assert.ok(n.timestamp >= before && n.timestamp <= after + 100,
      `timestamp ${n.timestamp} should be between ${before} and ${after}`);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 15. waitForNotification without predicate — returns first
// ═══════════════════════════════════════════════════════════════════
test("waitForNotification without predicate returns first notification", async () => {
  const mock = await makeMock();
  try {
    await mock.invokeCommand("test-notify", "any-msg");
    const n = await mock.waitForNotification(undefined, 5_000);
    assert.ok(n.message, "should have a message");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 16. LLM turn still works after UI commands
// ═══════════════════════════════════════════════════════════════════
test("LLM turns work correctly after invokeCommand", async () => {
  const mock = await makeMock();
  try {
    await mock.invokeCommand("test-notify", "before-llm");
    await mock.invokeCommand("test-status", "state active");

    const events = await mock.run("do something", TIMEOUT);
    assert.ok(events.some(e => e.type === "agent_end"), "LLM turn should complete");
    assert.ok(mock.requests.length >= 1, "should have API request");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 17. getCompletions — returns argument completions
// ═══════════════════════════════════════════════════════════════════
test("getCompletions returns filtered completions", async () => {
  const mock = await makeMock();
  try {
    // No prefix — all completions
    const all = await mock.getCompletions("test-completable");
    assert.ok(Array.isArray(all), "should return array");
    assert.equal(all.length, 3, "should have 3 completions");
    assert.ok(all.some(c => c.label === "alpha"));
    assert.ok(all.some(c => c.label === "beta"));
    assert.ok(all.some(c => c.label === "gamma"));

    // With prefix — filtered
    const filtered = await mock.getCompletions("test-completable", "al");
    assert.equal(filtered.length, 1, "should filter to 1");
    assert.equal(filtered[0].label, "alpha");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 18. getCompletions — unknown command returns empty array
// ═══════════════════════════════════════════════════════════════════
test("getCompletions for unknown command returns empty", async () => {
  const mock = await makeMock();
  try {
    const result = await mock.getCompletions("nonexistent-xyz");
    assert.ok(Array.isArray(result), "should return array");
    assert.equal(result.length, 0, "should be empty");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 19. getCompletions — command without completions returns empty
// ═══════════════════════════════════════════════════════════════════
test("getCompletions for command without completions returns empty", async () => {
  const mock = await makeMock();
  try {
    // test-notify exists but has no getArgumentCompletions
    const result = await mock.getCompletions("test-notify");
    assert.ok(Array.isArray(result), "should return array");
    assert.equal(result.length, 0, "should be empty");
  } finally {
    await mock.close();
  }
});
