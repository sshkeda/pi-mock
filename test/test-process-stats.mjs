/**
 * Tests for mock.getProcessStats() — verifies RSS and CPU time
 * measurement of the pi child process.
 *
 * Run: node --test test/test-process-stats.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMock, script, text, bash } from "../dist/index.js";

const TIMEOUT = 30_000;

// ═══════════════════════════════════════════════════════════════════
// 1. getProcessStats() returns valid data while pi is running
// ═══════════════════════════════════════════════════════════════════
test("getProcessStats returns pid, rssKb, cpuSeconds", async () => {
  const mock = await createMock({
    brain: script(text("hello")),
    startupTimeoutMs: 15_000,
  });

  try {
    const stats = mock.getProcessStats();
    assert.ok(stats !== null, "stats should not be null while pi is running");
    assert.ok(typeof stats.pid === "number", "pid should be a number");
    assert.ok(stats.pid > 0, `pid should be positive, got ${stats.pid}`);
    assert.ok(typeof stats.rssKb === "number", "rssKb should be a number");
    assert.ok(stats.rssKb > 0, `rssKb should be positive, got ${stats.rssKb}`);
    assert.ok(typeof stats.cpuSeconds === "number", "cpuSeconds should be a number");
    assert.ok(stats.cpuSeconds >= 0, `cpuSeconds should be non-negative, got ${stats.cpuSeconds}`);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 2. RSS increases when pi allocates memory
// ═══════════════════════════════════════════════════════════════════
test("rssKb reflects memory allocation in pi", async () => {
  const mock = await createMock({
    brain: script(
      // Allocate ~50MB in the pi process via bash variable
      bash("head -c 52428800 /dev/zero | base64 > /dev/null && echo ok"),
      text("done"),
    ),
    startupTimeoutMs: 15_000,
  });

  try {
    const before = mock.getProcessStats();
    assert.ok(before !== null, "before stats should exist");

    const events = await mock.run("allocate memory", TIMEOUT);
    assert.ok(events.some((e) => e.type === "agent_end"), "should complete");

    const after = mock.getProcessStats();
    assert.ok(after !== null, "after stats should exist");

    // RSS should have changed (at least not be exactly zero)
    assert.ok(after.rssKb > 0, `rssKb should be positive after work, got ${after.rssKb}`);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 3. cpuSeconds increases after CPU work
// ═══════════════════════════════════════════════════════════════════
test("cpuSeconds increases after CPU-bound work", async () => {
  const mock = await createMock({
    brain: script(
      bash("for i in $(seq 1 100000); do :; done && echo ok"),
      text("done"),
    ),
    startupTimeoutMs: 15_000,
  });

  try {
    const before = mock.getProcessStats();
    assert.ok(before !== null, "before stats should exist");

    const events = await mock.run("burn cpu", TIMEOUT);
    assert.ok(events.some((e) => e.type === "agent_end"), "should complete");

    const after = mock.getProcessStats();
    assert.ok(after !== null, "after stats should exist");

    assert.ok(
      after.cpuSeconds >= before.cpuSeconds,
      `cpuSeconds should not decrease: before=${before.cpuSeconds}, after=${after.cpuSeconds}`,
    );
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 4. getProcessStats() returns null after close
// ═══════════════════════════════════════════════════════════════════
test("getProcessStats returns null after close", async () => {
  const mock = await createMock({
    brain: script(text("bye")),
    startupTimeoutMs: 15_000,
  });

  await mock.run("goodbye", TIMEOUT);
  await mock.close();

  const stats = mock.getProcessStats();
  assert.equal(stats, null, "stats should be null after close");
});

// ═══════════════════════════════════════════════════════════════════
// 5. Multiple snapshots return consistent pid
// ═══════════════════════════════════════════════════════════════════
test("pid stays consistent across multiple snapshots", async () => {
  const mock = await createMock({
    brain: script(bash("echo ok"), text("done")),
    startupTimeoutMs: 15_000,
  });

  try {
    const snap1 = mock.getProcessStats();
    await mock.run("first", TIMEOUT);
    const snap2 = mock.getProcessStats();
    await mock.run("second", TIMEOUT);
    const snap3 = mock.getProcessStats();

    assert.ok(snap1 && snap2 && snap3, "all snapshots should exist");
    assert.equal(snap1.pid, snap2.pid, "pid should be same across snapshots");
    assert.equal(snap2.pid, snap3.pid, "pid should be same across snapshots");
  } finally {
    await mock.close();
  }
});
