/**
 * Issue verification tests — reproduce and verify specific bug fixes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMock, script, text, bash, flakyBrain, overloaded,
  createControllableBrain,
} from "../dist/index.js";

// ═══════════════════════════════════════════════════════════════════
// Issue 3: UTF-8 corruption via chunk.toString()
// ═══════════════════════════════════════════════════════════════════
test("UTF-8 multi-byte chars in brain response", async () => {
  const unicodeText = "日本語テスト 🎉🔥💀 Ñoño café résumé 中文 العربية";
  const mock = await createMock({
    brain: script(text(unicodeText)),
    startupTimeoutMs: 15000,
  });

  try {
    const events = await mock.run("respond with unicode", 30000);
    assert.ok(events.some(e => e.type === "agent_end"), "should complete");
    const msgEvents = events.filter(e => e.type === "message_end" && e.message?.role === "assistant");
    const content = msgEvents[0]?.message?.content;
    if (content && content.length > 0 && content[0].type === "text") {
      assert.ok(content[0].text.includes("日本語"), `unicode corrupted: ${content[0].text.slice(0, 50)}`);
    }
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Issue 3b: Large payload that might split across pipe chunks
// ═══════════════════════════════════════════════════════════════════
test("UTF-8 in large payload (force chunk splitting)", async () => {
  const bigText = "あ".repeat(20000) + " MARKER_END";
  const mock = await createMock({
    brain: script(text(bigText)),
    startupTimeoutMs: 15000,
  });

  try {
    const events = await mock.run("big unicode", 30000);
    assert.ok(events.some(e => e.type === "agent_end"), "should complete");
    const msgEvents = events.filter(e => e.type === "message_end" && e.message?.role === "assistant");
    const content = msgEvents[0]?.message?.content;
    if (content?.[0]?.type === "text") {
      const t = content[0].text;
      const replacements = (t.match(/\uFFFD/g) || []).length;
      assert.equal(replacements, 0, `found ${replacements} replacement characters — UTF-8 corruption!`);
      assert.ok(t.includes("MARKER_END"), "marker lost — payload was truncated or corrupted");
    }
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Issue 4: flakyBrain determinism (seeded PRNG)
// ═══════════════════════════════════════════════════════════════════
test("flakyBrain produces identical results with same seed", async () => {
  const brain = flakyBrain(() => text("ok"), { rate: 0.5 });
  const fakeReq = { model: "mock", messages: [], max_tokens: 100 };

  const run1 = [];
  for (let i = 0; i < 100; i++) {
    const r1 = await brain(fakeReq, i);
    run1.push(r1.type === "text" ? "ok" : "err");
  }

  const brain2 = flakyBrain(() => text("ok"), { rate: 0.5 });
  const run2 = [];
  for (let i = 0; i < 100; i++) {
    const r2 = await brain2(fakeReq, i);
    run2.push(r2.type === "text" ? "ok" : "err");
  }

  assert.equal(run1.join(""), run2.join(""), "Two flakyBrain runs with same default seed should be identical");
});

// ═══════════════════════════════════════════════════════════════════
// Issue 5: 500ms grace period timing on success vs error paths
// ═══════════════════════════════════════════════════════════════════
test("successful run returns fast (no 500ms grace)", async () => {
  const mock = await createMock({
    brain: script(text("fast")),
    startupTimeoutMs: 15000,
  });

  try {
    const t0 = Date.now();
    await mock.run("be fast", 30000);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 400, `took ${elapsed}ms — grace period is firing on success path!`);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Issue 6: waitForRequest — finds already-arrived requests
// ═══════════════════════════════════════════════════════════════════
test("waitForRequest finds request that already arrived", async () => {
  const cb = createControllableBrain();
  const mock = await createMock({
    brain: cb.brain,
    startupTimeoutMs: 15000,
  });

  try {
    await mock.prompt("test");
    const call = await cb.waitForCall(5000);

    const found = await Promise.race([
      mock.waitForRequest(undefined, 2000).then(() => true),
      new Promise(r => setTimeout(() => r(false), 2500)),
    ]).catch(() => false);

    call.respond(text("done"));
    await mock.drain(10000);

    assert.equal(found, true, "waitForRequest missed an already-arrived request");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Issue 7: waitForRequest cursor — repeated calls return next match
// ═══════════════════════════════════════════════════════════════════
test("waitForRequest returns different requests on repeated calls", async () => {
  const cb = createControllableBrain();
  const mock = await createMock({
    brain: cb.brain,
    startupTimeoutMs: 15000,
  });

  try {
    await mock.prompt("first");
    const call1 = await cb.waitForCall(5000);

    const r1 = await mock.waitForRequest(undefined, 2000);
    assert.equal(r1.index, 0, `first waitForRequest should return index 0, got ${r1.index}`);

    call1.respond(bash("echo hello"));
    const call2 = await cb.waitForCall(10000);

    const r2 = await mock.waitForRequest(undefined, 2000);
    assert.equal(r2.index, 1, `second waitForRequest should return index 1, got ${r2.index}`);

    call2.respond(text("done"));
    await mock.drain(10000);
  } finally {
    await mock.close();
  }
});
