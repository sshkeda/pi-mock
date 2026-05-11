/**
 * Autocompaction budget tests.
 *
 * These tests exercise Pi's real native compaction path through pi-mock. They
 * prove the smart cut-point behavior we want from pi-autocompact: if the native
 * compaction input would overflow the summarizer model, Pi summarizes the
 * largest chronological prefix that fits and keeps the remaining messages raw.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMock, script, text } from "../dist/index.js";

const TIMEOUT = 60_000;

function writeHugeUserOnlySession({ messageCount = 40, charsPerMessage = 20_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-autocompact-characterization-"));
  const sessionFile = join(dir, "session.jsonl");
  const now = new Date().toISOString();
  let parentId = null;
  const entries = [{ type: "session", version: 3, id: "autocompact-characterization", timestamp: now, cwd: dir }];

  for (let i = 0; i < messageCount; i++) {
    const id = `user-${String(i).padStart(3, "0")}`;
    entries.push({
      type: "message",
      id,
      parentId,
      timestamp: now,
      message: {
        role: "user",
        content: [{
          type: "text",
          text: `AUTOCOMPACT_USER_${i}_START\n${"x".repeat(charsPerMessage)}\nAUTOCOMPACT_USER_${i}_END`,
        }],
        timestamp: Date.now() + i,
      },
    });
    parentId = id;
  }

  writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return { dir, sessionFile };
}

function firstTextBlock(req) {
  const text = req?.messages?.[0]?.content?.find?.((part) => part.type === "text")?.text;
  assert.equal(typeof text, "string", "compaction request should contain a user text prompt");
  return { text, chars: text.length, estimatedTokens: Math.ceil(text.length / 4) };
}

async function getMockModel(mock) {
  const modelsResponse = await mock.sendRpc({ type: "get_available_models" });
  assert.equal(modelsResponse.success, true, modelsResponse.error);
  const model = modelsResponse.data.models.find((m) => m.provider === "pi-mock" && m.id === "mock");
  assert.ok(model, "pi-mock/mock model should be available");
  return model;
}

test("compaction slides the cut point so the summarizer request fits", async (t) => {
  const { dir, sessionFile } = writeHugeUserOnlySession();
  const mock = await createMock({
    brain: script(text("## Goal\nsummary")),
    sessionFile,
    startupTimeoutMs: 15_000,
    runTimeoutMs: TIMEOUT,
  });

  try {
    const model = await getMockModel(mock);
    const compactResponse = await mock.sendRpc({ type: "compact" });
    assert.equal(compactResponse.success, true, compactResponse.error);
    assert.equal(mock.requests.length, 1, "manual compaction should make one summarization request");

    const req = mock.requests[0];
    const { text: promptText, chars, estimatedTokens } = firstTextBlock(req);
    const maxOutputTokens = req.max_tokens ?? 0;
    const estimatedTotalTokens = estimatedTokens + maxOutputTokens;
    const contextWindow = model.contextWindow;

    t.diagnostic(
      `compaction prompt=${chars} chars ≈ ${estimatedTokens} tokens; max_tokens=${maxOutputTokens}; estimated total≈${estimatedTotalTokens}; contextWindow=${contextWindow}; usage=${(estimatedTotalTokens / contextWindow).toFixed(2)}x`,
    );

    assert.ok(promptText.includes("<conversation>"), "request should be the compaction summarization prompt");
    assert.ok(promptText.includes("AUTOCOMPACT_USER_0_START"), "oldest history should still be summarized first");
    assert.ok(promptText.includes("AUTOCOMPACT_USER_21_END"), "largest fitting chronological prefix should be included");
    assert.ok(!promptText.includes("AUTOCOMPACT_USER_22_START"), "first over-budget message should be kept raw, not summarized");
    assert.ok(!promptText.includes("AUTOCOMPACT_USER_35_END"), "recent overflow tail should be kept raw, not forced into the summary prompt");
    assert.ok(estimatedTotalTokens <= contextWindow, `summarizer request should fit: total≈${estimatedTotalTokens}, contextWindow=${contextWindow}`);
    assert.equal(compactResponse.data.firstKeptEntryId, "user-022", "first raw kept entry should slide earlier to the first unsummarized message");
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("under-budget compaction keeps native behavior", async () => {
  const { dir, sessionFile } = writeHugeUserOnlySession({ messageCount: 80, charsPerMessage: 2_000 });
  const mock = await createMock({
    brain: script(text("## Goal\nsmall summary")),
    sessionFile,
    startupTimeoutMs: 15_000,
    runTimeoutMs: TIMEOUT,
  });

  try {
    const compactResponse = await mock.sendRpc({ type: "compact" });
    assert.equal(compactResponse.success, true, compactResponse.error);
    assert.equal(mock.requests.length, 1, "under-budget compaction should still use native summarizer request");
    const { text: promptText } = firstTextBlock(mock.requests[0]);
    assert.ok(promptText.includes("AUTOCOMPACT_USER_0_START"));
    assert.ok(promptText.includes("AUTOCOMPACT_USER_40_END"));
    assert.ok(!promptText.includes("AUTOCOMPACT_USER_41_START"));
    assert.equal(compactResponse.data.firstKeptEntryId, "user-041", "native cut point should be unchanged when summary prompt fits");
    assert.ok(compactResponse.data?.summary?.includes("small summary"), "native compaction result should be returned");
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
