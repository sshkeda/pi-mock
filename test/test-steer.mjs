/**
 * Tests for steer(), followUp(), abort(), and sendRpc().
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMock, script, text, bash,
  createControllableBrain,
} from "../dist/index.js";

const TIMEOUT = 30_000;

// ═══════════════════════════════════════════════════════════════════
// 1. steer() — inject message during active turn
// ═══════════════════════════════════════════════════════════════════
test("steer() delivers message during active turn", async () => {
  const cb = createControllableBrain();
  const mock = await createMock({
    brain: cb.brain,
    startupTimeoutMs: 15000,
  });

  try {
    await mock.prompt("start working");
    const call1 = await cb.waitForCall(5000);

    await mock.steer("also consider edge cases");

    call1.respond(bash("echo hello"));

    const call2 = await cb.waitForCall(10000);

    const msgCount = call2.request.messages?.length ?? 0;
    assert.ok(msgCount >= 3, `expected ≥3 messages (user + tool_result + steer), got ${msgCount}`);

    call2.respond(text("done with steer test"));
    await mock.drain(TIMEOUT);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 2. followUp() — queue a message for after agent finishes
// ═══════════════════════════════════════════════════════════════════
test("followUp() triggers new turn after agent finishes", async () => {
  let callCount = 0;
  const mock = await createMock({
    brain: () => {
      callCount++;
      return text(`response-${callCount}`);
    },
    startupTimeoutMs: 15000,
  });

  try {
    await mock.prompt("first message");
    await mock.followUp("follow up message");

    await mock.waitFor(e => e.type === "agent_end", TIMEOUT);

    await mock.waitFor(
      e => e.type === "agent_end" && mock.events.filter(ev => ev.type === "agent_end").length >= 2,
      2000,
    ).catch(() => null);

    assert.ok(callCount >= 2, `followUp should trigger second brain call, got ${callCount}`);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 3. abort() — cancel current turn
// ═══════════════════════════════════════════════════════════════════
test("abort() stops active agent turn", async () => {
  const cb = createControllableBrain();
  const mock = await createMock({
    brain: cb.brain,
    startupTimeoutMs: 15000,
  });

  try {
    await mock.prompt("do something slow");
    const call = await cb.waitForCall(5000);

    await mock.abort();

    const agentEnd = await mock.waitFor(e => e.type === "agent_end", 5000);
    assert.ok(agentEnd, "should get agent_end after abort");

    call.respond(text("too late"));
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 4. sendRpc() — raw RPC escape hatch
// ═══════════════════════════════════════════════════════════════════
test("sendRpc() can call get_state", async () => {
  const mock = await createMock({
    brain: script(text("hello")),
    startupTimeoutMs: 15000,
  });

  try {
    const resp = await mock.sendRpc({ type: "get_state" });
    assert.ok(resp.success, `get_state should succeed, got error: ${resp.error}`);
    assert.ok(resp.data, "get_state should return data");
    assert.ok(resp.data.model, "should have model info");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 5. sendRpc() — get_session_stats
// ═══════════════════════════════════════════════════════════════════
test("sendRpc() can call get_session_stats after a turn", async () => {
  const mock = await createMock({
    brain: script(text("hello")),
    startupTimeoutMs: 15000,
  });

  try {
    await mock.run("say hi", TIMEOUT);

    const resp = await mock.sendRpc({ type: "get_session_stats" });
    assert.ok(resp.success, `get_session_stats should succeed, got: ${resp.error}`);
  } finally {
    await mock.close();
  }
});
