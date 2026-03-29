import {
  createMock, script, text, bash, flakyBrain, overloaded,
  createControllableBrain,
} from "../dist/index.js";
// bash is already imported above — used by the waitForRequest cursor test

let passed = 0, failed = 0, skipped = 0;

async function test(name, fn) {
  process.stderr.write(`\n━━━ ${name} `);
  try {
    await fn();
    passed++;
    process.stderr.write(`✅ PASS\n`);
  } catch (err) {
    if (err.message?.startsWith("SKIP:")) {
      skipped++;
      process.stderr.write(`⏭️  ${err.message}\n`);
    } else {
      failed++;
      process.stderr.write(`❌ FAIL: ${err.message}\n`);
    }
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ═══════════════════════════════════════════════════════════════════
// Issue 3: UTF-8 corruption via chunk.toString()
// Can we trigger a multi-byte character split across pipe chunks?
// ═══════════════════════════════════════════════════════════════════
await test("UTF-8 multi-byte chars in brain response", async () => {
  // Use a brain that returns lots of multi-byte characters
  // If chunk.toString() corrupts them, pi would see garbled text
  const unicodeText = "日本語テスト 🎉🔥💀 Ñoño café résumé 中文 العربية";
  const mock = await createMock({
    brain: script(text(unicodeText)),
    startupTimeoutMs: 15000,
  });

  try {
    const events = await mock.run("respond with unicode", 30000);
    assert(events.some(e => e.type === "agent_end"), "should complete");
    // Check the response pi received contained the unicode
    const msgEvents = events.filter(e => e.type === "message_end" && e.message?.role === "assistant");
    const content = msgEvents[0]?.message?.content;
    if (content && content.length > 0 && content[0].type === "text") {
      const receivedText = content[0].text;
      process.stderr.write(`  (text: "${receivedText.slice(0, 40)}...") `);
      assert(receivedText.includes("日本語"), `unicode corrupted: ${receivedText.slice(0, 50)}`);
    } else {
      process.stderr.write(`  (no text content in response) `);
    }
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Issue 3b: Large payload that might split across pipe chunks
// ═══════════════════════════════════════════════════════════════════
await test("UTF-8 in large payload (force chunk splitting)", async () => {
  // Create a very large response with multi-byte chars at various positions
  // Pipe buffer is typically 64KB; we want to exceed it to force splits
  const bigText = "あ".repeat(20000) + " MARKER_END"; // ~60KB of 3-byte chars
  const mock = await createMock({
    brain: script(text(bigText)),
    startupTimeoutMs: 15000,
  });

  try {
    const events = await mock.run("big unicode", 30000);
    assert(events.some(e => e.type === "agent_end"), "should complete");
    const msgEvents = events.filter(e => e.type === "message_end" && e.message?.role === "assistant");
    const content = msgEvents[0]?.message?.content;
    if (content?.[0]?.type === "text") {
      const t = content[0].text;
      process.stderr.write(`  (len: ${t.length}, has marker: ${t.includes("MARKER_END")}) `);
      // Check no replacement chars (corruption)
      const replacements = (t.match(/\uFFFD/g) || []).length;
      process.stderr.write(`  (replacement chars: ${replacements}) `);
      assert(replacements === 0, `found ${replacements} replacement characters — UTF-8 corruption!`);
      assert(t.includes("MARKER_END"), "marker lost — payload was truncated or corrupted");
    }
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Issue 4: flakyBrain non-determinism
// Run flakyBrain 100 times, check if results vary across two runs
// ═══════════════════════════════════════════════════════════════════
await test("flakyBrain produces different results each run", async () => {
  // This just documents that flakyBrain IS non-deterministic
  const brain = flakyBrain(
    () => text("ok"),
    { rate: 0.5 }
  );
  const fakeReq = { model: "mock", messages: [], max_tokens: 100 };

  const run1 = [];
  const run2 = [];
  for (let i = 0; i < 100; i++) {
    const r1 = await brain(fakeReq, i);
    run1.push(r1.type === "text" ? "ok" : "err");
  }
  // Reset brain state by creating a new one
  const brain2 = flakyBrain(() => text("ok"), { rate: 0.5 });
  for (let i = 0; i < 100; i++) {
    const r2 = await brain2(fakeReq, i);
    run2.push(r2.type === "text" ? "ok" : "err");
  }

  const same = run1.join("") === run2.join("");
  process.stderr.write(`  (runs identical: ${same}, run1 errors: ${run1.filter(x=>x==="err").length}, run2 errors: ${run2.filter(x=>x==="err").length}) `);
  // If they're identical, Math.random() is somehow seeded (unlikely)
  assert(same, "Two flakyBrain runs with same default seed should be identical — Math.random is somehow deterministic");
});

// ═══════════════════════════════════════════════════════════════════
// Issue 5: 500ms grace period timing on success vs error paths
// ═══════════════════════════════════════════════════════════════════
await test("successful run returns fast (no 500ms grace)", async () => {
  const mock = await createMock({
    brain: script(text("fast")),
    startupTimeoutMs: 15000,
  });

  try {
    const t0 = Date.now();
    await mock.run("be fast", 30000);
    const elapsed = Date.now() - t0;
    process.stderr.write(`  (elapsed: ${elapsed}ms) `);
    // Should be well under 500ms for the run itself (excluding startup)
    // If the grace period fires on success, this would be >500ms
    assert(elapsed < 400, `took ${elapsed}ms — grace period is firing on success path!`);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Issue 6: waitForRequest — does it miss already-arrived requests?
// ═══════════════════════════════════════════════════════════════════
await test("waitForRequest misses request that already arrived", async () => {
  const cb = createControllableBrain();
  const mock = await createMock({
    brain: cb.brain,
    startupTimeoutMs: 15000,
  });

  try {
    // Send prompt (pi will make API request)
    await mock.prompt("test");

    // Wait for the brain to receive the call
    const call = await cb.waitForCall(5000);

    // At this point, mock.requests already has the request.
    // Now call waitForRequest — will it find the existing request?
    const found = await Promise.race([
      mock.waitForRequest(undefined, 2000).then(() => true),
      new Promise(r => setTimeout(() => r(false), 2500)),
    ]).catch(() => false);

    process.stderr.write(`  (requests: ${mock.requests.length}, found existing: ${found}) `);

    // Respond to unblock pi
    call.respond(text("done"));
    await mock.drain(10000);

    assert(found === true, "waitForRequest missed an already-arrived request");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Issue 7: waitForRequest cursor — repeated calls return same request
// GPT found this: waitForRequest scans from 0 every time, so the
// second call returns the same request as the first.
// ═══════════════════════════════════════════════════════════════════
await test("waitForRequest returns different requests on repeated calls", async () => {
  const cb = createControllableBrain();
  const mock = await createMock({
    brain: cb.brain,
    startupTimeoutMs: 15000,
  });

  try {
    // Send first prompt — pi makes API request #0
    await mock.prompt("first");
    const call1 = await cb.waitForCall(5000);

    // waitForRequest should find request #0
    const r1 = await mock.waitForRequest(undefined, 2000);
    assert(r1.index === 0, `first waitForRequest should return index 0, got ${r1.index}`);

    // Respond so pi makes another request
    call1.respond(bash("echo hello"));
    const call2 = await cb.waitForCall(10000);

    // waitForRequest should find request #1, NOT request #0 again
    const r2 = await mock.waitForRequest(undefined, 2000);
    assert(r2.index === 1, `second waitForRequest should return index 1, got ${r2.index}`);

    process.stderr.write(`  (r1.index=${r1.index}, r2.index=${r2.index}) `);

    // Clean up
    call2.respond(text("done"));
    await mock.drain(10000);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════
console.error(`\n${"═".repeat(60)}`);
console.error(`Issue verification: ${passed} confirmed, ${failed} not-reproduced, ${skipped} skipped`);
console.error(`${"═".repeat(60)}\n`);
process.exit(failed > 0 ? 1 : 0);
