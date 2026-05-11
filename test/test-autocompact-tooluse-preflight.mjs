import { test } from "node:test";
import assert from "node:assert/strict";
import { createMock, createControllableBrain, bash, text } from "../dist/index.js";

const TIMEOUT = 60_000;
const HIGH_USAGE_EXTENSION = new URL("./fixtures/high-usage-tooluse-extension.mjs", import.meta.url).pathname;

function firstTextBlock(req) {
  const textBlock = req?.messages?.[0]?.content?.find?.((part) => part.type === "text");
  const text = textBlock?.text;
  assert.equal(typeof text, "string", "request should contain a first user text block");
  return text;
}

function isCompactionRequest(req) {
  const text = firstTextBlock(req);
  return text.includes("<conversation>") && text.includes("The messages above are a conversation to summarize");
}

test("auto-compaction preflights between tool-use calls before continuing", async (t) => {
  const cb = createControllableBrain();
  const mock = await createMock({
    brain: cb.brain,
    extensions: [HIGH_USAGE_EXTENSION],
    startupTimeoutMs: 15_000,
    runTimeoutMs: TIMEOUT,
  });

  try {
    const modelsResponse = await mock.sendRpc({ type: "get_available_models" });
    assert.equal(modelsResponse.success, true, modelsResponse.error);
    const model = modelsResponse.data.models.find((m) => m.provider === "pi-mock" && m.id === "mock");
    assert.ok(model, "pi-mock/mock model should be available");
    t.diagnostic(`model contextWindow=${model.contextWindow}; threshold=${model.contextWindow - 16384}`);

    await mock.prompt("trigger tool-use compaction preflight");

    const first = await cb.waitForCall(TIMEOUT);
    assert.equal(first.index, 0);
    first.respond(bash("echo tool-result"));

    const second = await cb.waitForCall(TIMEOUT);
    assert.equal(second.index, 1);

    assert.ok(
      isCompactionRequest(second.request),
      "after an over-threshold toolUse message, Pi should compact before sending the normal continuation request",
    );

    second.respond(text("## Goal\nsummary"));

    const third = await cb.waitForCall(TIMEOUT);
    assert.equal(third.index, 2);
    assert.ok(!isCompactionRequest(third.request), "after compaction, Pi should resume the normal continuation request");
    third.respond(text("done"));

    const events = await mock.drain(TIMEOUT);
    assert.ok(events.some((event) => event.type === "compaction_start"), "compaction_start should be emitted");
    assert.ok(events.some((event) => event.type === "compaction_end"), "compaction_end should be emitted");
    assert.ok(events.some((event) => event.type === "agent_end"), "agent should finish after compacting and continuing");
  } finally {
    await mock.close();
  }
});
