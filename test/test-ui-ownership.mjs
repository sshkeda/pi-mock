import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createMock, script, text } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = resolve(__dirname, "fixtures/test-ui-ownership-extension.mjs");

function makeMock() {
  return createMock({
    brain: script(text("ok")),
    extensions: [EXT_PATH],
    startupTimeoutMs: 15_000,
  });
}

test("invokeTool supports synthetic hasUI=false capture with origin metadata", async () => {
  const mock = await makeMock();
  try {
    const result = await mock.invokeTool(
      "test_ui_owner",
      { label: "first-no-ui" },
      { hasUI: false, sessionId: "session-a", invocationId: "inv-a" },
    );

    assert.equal(result.ok, true);
    assert.equal(result.statusUpdates.length, 1);
    assert.equal(result.widgets.length, 1);
    assert.equal(result.statusUpdates[0].origin?.source, "synthetic-tool");
    assert.equal(result.statusUpdates[0].origin?.hasUI, false);
    assert.equal(result.statusUpdates[0].origin?.sessionId, "session-a");
    assert.equal(result.statusUpdates[0].origin?.invocationId, "inv-a");
    assert.equal(result.widgets[0].origin?.toolName, "test_ui_owner");
  } finally {
    await mock.close();
  }
});

test("later hasUI=true synthetic invocation captures a distinct session owner", async () => {
  const mock = await makeMock();
  try {
    await mock.invokeTool(
      "test_ui_owner",
      { label: "background" },
      { hasUI: false, sessionId: "bg-session", invocationId: "bg-inv" },
    );

    const interactive = await mock.invokeTool(
      "test_ui_owner",
      { label: "interactive" },
      { hasUI: true, sessionId: "ui-session", invocationId: "ui-inv" },
    );

    assert.equal(interactive.statusUpdates[0].origin?.sessionId, "ui-session");
    assert.equal(interactive.statusUpdates[0].origin?.hasUI, true);
    assert.equal(interactive.widgets[0].origin?.sessionId, "ui-session");
  } finally {
    await mock.close();
  }
});

test("shared stale UI context routes updates to the prior interactive owner, not the current no-UI execution", async () => {
  const mock = await makeMock();
  try {
    await mock.invokeTool(
      "test_ui_owner",
      { label: "establish-owner" },
      { hasUI: true, sessionId: "live-ui", invocationId: "owner-inv" },
    );

    const stale = await mock.invokeTool(
      "test_ui_owner",
      { label: "later-background", useSharedIfPresent: true },
      { hasUI: false, sessionId: "background-run", invocationId: "bg-inv-2" },
    );

    assert.equal(stale.statusUpdates[0].text, "later-background");
    assert.equal(stale.statusUpdates[0].origin?.sessionId, "live-ui");
    assert.equal(stale.statusUpdates[0].origin?.hasUI, true);
    assert.equal(stale.statusUpdates[0].origin?.invocationId, "owner-inv");
    assert.equal(stale.widgets[0].origin?.sessionId, "live-ui");
    assert.notEqual(stale.widgets[0].origin?.sessionId, "background-run");
  } finally {
    await mock.close();
  }
});

test("invokeCommand also supports synthetic context overrides and widget capture", async () => {
  const mock = await makeMock();
  try {
    const result = await mock.invokeCommand(
      "test-ui-owner-command",
      "cmd-label",
      { hasUI: false, sessionId: "cmd-session", invocationId: "cmd-inv" },
    );

    assert.equal(result.statusUpdates[0].origin?.source, "synthetic-command");
    assert.equal(result.statusUpdates[0].origin?.commandName, "test-ui-owner-command");
    assert.equal(result.widgets[0].origin?.sessionId, "cmd-session");
    assert.equal(mock.widgets.at(-1)?.origin?.invocationId, "cmd-inv");
  } finally {
    await mock.close();
  }
});
