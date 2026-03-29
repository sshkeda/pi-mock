/**
 * Tests for steer(), followUp(), abort(), and sendRpc().
 */
import {
  createMock, script, text, bash,
  createControllableBrain,
} from "../dist/index.js";

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
    if (err.stack) process.stderr.write(`    ${err.stack.split('\n').slice(1, 3).join('\n    ')}\n`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ═══════════════════════════════════════════════════════════════════
// 1. steer() — inject message during active turn
// ═══════════════════════════════════════════════════════════════════
await test("steer() delivers message during active turn", async () => {
  const cb = createControllableBrain();
  const mock = await createMock({
    brain: cb.brain,
    startupTimeoutMs: 15000,
  });

  try {
    // Send initial prompt — pi makes a brain call
    await mock.prompt("start working");
    const call1 = await cb.waitForCall(5000);

    // While pi is "thinking" (brain hasn't responded yet), steer it
    await mock.steer("also consider edge cases");
    process.stderr.write(`  (steer sent) `);

    // Now respond to the first call with a tool call
    call1.respond(bash("echo hello"));

    // Pi will execute the tool, then make another brain call.
    // The steer message should be queued and delivered between tool calls.
    const call2 = await cb.waitForCall(10000);

    // Check that pi's second request includes more messages (the steer was injected)
    const msgCount = call2.request.messages?.length ?? 0;
    process.stderr.write(`  (2nd request msgs: ${msgCount}) `);
    assert(msgCount >= 3, `expected ≥3 messages (user + tool_result + steer), got ${msgCount}`);

    // Finish up
    call2.respond(text("done with steer test"));
    await mock.drain(TIMEOUT);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 2. followUp() — queue a message for after agent finishes
// ═══════════════════════════════════════════════════════════════════
await test("followUp() triggers new turn after agent finishes", async () => {
  let callCount = 0;
  const mock = await createMock({
    brain: () => {
      callCount++;
      return text(`response-${callCount}`);
    },
    startupTimeoutMs: 15000,
  });

  try {
    // Start a prompt
    await mock.prompt("first message");

    // Queue a follow-up while pi is working
    await mock.followUp("follow up message");
    process.stderr.write(`  (followUp queued) `);

    // Wait for both turns to complete — the follow-up triggers a second turn
    // First agent_end from the initial prompt
    await mock.waitFor(e => e.type === "agent_end", TIMEOUT);

    // The follow-up should trigger a second agent cycle
    const secondEnd = await mock.waitFor(
      e => e.type === "agent_end" && mock.events.filter(ev => ev.type === "agent_end").length >= 2,
      TIMEOUT,
    ).catch(() => null);

    process.stderr.write(`  (calls: ${callCount}) `);
    assert(callCount >= 2, `followUp should trigger second brain call, got ${callCount}`);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 3. abort() — cancel current turn
// ═══════════════════════════════════════════════════════════════════
await test("abort() stops active agent turn", async () => {
  const cb = createControllableBrain();
  const mock = await createMock({
    brain: cb.brain,
    startupTimeoutMs: 15000,
  });

  try {
    await mock.prompt("do something slow");
    const call = await cb.waitForCall(5000);
    process.stderr.write(`  (brain received call) `);

    // Abort while the brain is "thinking"
    await mock.abort();
    process.stderr.write(`  (abort sent) `);

    // Pi should emit agent_end
    const agentEnd = await mock.waitFor(e => e.type === "agent_end", 5000);
    assert(agentEnd, "should get agent_end after abort");
    process.stderr.write(`  (agent_end received) `);

    // Respond to the pending call to unblock the brain (it's still waiting)
    call.respond(text("too late"));
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 4. sendRpc() — raw RPC escape hatch
// ═══════════════════════════════════════════════════════════════════
await test("sendRpc() can call get_state", async () => {
  const mock = await createMock({
    brain: script(text("hello")),
    startupTimeoutMs: 15000,
  });

  try {
    const resp = await mock.sendRpc({ type: "get_state" });
    assert(resp.success, `get_state should succeed, got error: ${resp.error}`);
    assert(resp.data, "get_state should return data");

    const data = resp.data;
    process.stderr.write(`  (model: ${data.model?.id ?? "?"}, streaming: ${data.isStreaming}) `);
    assert(data.model, "should have model info");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 5. sendRpc() — get_session_stats
// ═══════════════════════════════════════════════════════════════════
await test("sendRpc() can call get_session_stats after a turn", async () => {
  const mock = await createMock({
    brain: script(text("hello")),
    startupTimeoutMs: 15000,
  });

  try {
    await mock.run("say hi", TIMEOUT);

    const resp = await mock.sendRpc({ type: "get_session_stats" });
    assert(resp.success, `get_session_stats should succeed, got: ${resp.error}`);

    const stats = resp.data;
    process.stderr.write(`  (messages: ${stats?.messageCount ?? "?"}) `);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════
console.error(`\n${"═".repeat(60)}`);
console.error(`Steer/FollowUp/Abort: ${passed} passed, ${failed} failed`);
console.error(`${"═".repeat(60)}\n`);
process.exit(failed > 0 ? 1 : 0);
