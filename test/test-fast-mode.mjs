import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createMock } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = resolve(__dirname, "fixtures/test-ui-ownership-extension.mjs");

test("fast mode: createMock without brain does not spawn a process", async () => {
  const before = Date.now();
  const mock = await createMock({ extensions: [EXT_PATH] });
  const elapsed = Date.now() - before;

  // Full-pi spawn takes 1-3 seconds. Fast mode should be <500ms.
  assert.ok(elapsed < 500, `fast mode createMock took ${elapsed}ms (expected <500ms)`);

  await mock.close();
});

test("fast mode: invokeTool works with synthetic overrides", async () => {
  const mock = await createMock({ extensions: [EXT_PATH] });
  try {
    const result = await mock.invokeTool(
      "test_ui_owner",
      { label: "fast-no-ui" },
      { hasUI: false, sessionId: "fast-session", invocationId: "fast-inv" },
    );

    assert.equal(result.ok, true);
    assert.equal(result.statusUpdates.length, 1);
    assert.equal(result.widgets.length, 1);
    assert.equal(result.statusUpdates[0].origin?.source, "synthetic-tool");
    assert.equal(result.statusUpdates[0].origin?.hasUI, false);
    assert.equal(result.statusUpdates[0].origin?.sessionId, "fast-session");
    assert.equal(result.statusUpdates[0].origin?.invocationId, "fast-inv");
    assert.equal(result.widgets[0].origin?.toolName, "test_ui_owner");
  } finally {
    await mock.close();
  }
});

test("fast mode: invokeCommand captures widgets and status with origin", async () => {
  const mock = await createMock({ extensions: [EXT_PATH] });
  try {
    const result = await mock.invokeCommand(
      "test-ui-owner-command",
      "fast-cmd-label",
      { hasUI: false, sessionId: "cmd-s", invocationId: "cmd-i" },
    );

    assert.equal(result.statusUpdates[0].origin?.source, "synthetic-command");
    assert.equal(result.statusUpdates[0].origin?.commandName, "test-ui-owner-command");
    assert.equal(result.widgets[0].origin?.sessionId, "cmd-s");
    assert.equal(mock.widgets.at(-1)?.origin?.invocationId, "cmd-i");
  } finally {
    await mock.close();
  }
});

test("fast mode: shared stale ctx routes to prior owner (same as full mode)", async () => {
  const mock = await createMock({ extensions: [EXT_PATH] });
  try {
    await mock.invokeTool(
      "test_ui_owner",
      { label: "establish-owner" },
      { hasUI: true, sessionId: "live-ui", invocationId: "owner-inv" },
    );

    const stale = await mock.invokeTool(
      "test_ui_owner",
      { label: "later-background", useSharedIfPresent: true },
      { hasUI: false, sessionId: "background-run", invocationId: "bg-inv" },
    );

    assert.equal(stale.statusUpdates[0].text, "later-background");
    assert.equal(stale.statusUpdates[0].origin?.sessionId, "live-ui");
    assert.equal(stale.statusUpdates[0].origin?.hasUI, true);
    assert.equal(stale.widgets[0].origin?.sessionId, "live-ui");
  } finally {
    await mock.close();
  }
});

test("fast mode: methods requiring brain throw with helpful error", async () => {
  const mock = await createMock({ extensions: [EXT_PATH] });
  try {
    await assert.rejects(
      () => mock.run("hi"),
      /run\(\) requires a brain/,
    );
    await assert.rejects(
      () => mock.prompt("hi"),
      /prompt\(\) requires a brain/,
    );
    assert.throws(() => mock.port, /port\(\) requires a brain/);
  } finally {
    await mock.close();
  }
});

test("fast mode: waitForNotification resolves from synthetic capture", async () => {
  const mock = await createMock({ extensions: [EXT_PATH] });
  try {
    const invokePromise = mock.invokeTool(
      "test_ui_owner",
      { label: "notify-me" },
      { hasUI: true },
    );
    const [, status] = await Promise.all([
      invokePromise,
      mock.waitForStatusUpdate((s) => s.text === "notify-me", 2000),
    ]);

    assert.equal(status.text, "notify-me");
    assert.equal(status.origin?.source, "synthetic-tool");
  } finally {
    await mock.close();
  }
});

test("fast mode: getCommands lists registered extension commands", async () => {
  const mock = await createMock({ extensions: [EXT_PATH] });
  try {
    const commands = await mock.getCommands();
    const names = commands.map((c) => c.name);
    assert.ok(names.includes("test-ui-owner-command"), `missing test-ui-owner-command, got: ${names.join(", ")}`);
    const entry = commands.find((c) => c.name === "test-ui-owner-command");
    assert.equal(entry?.source, "extension");
  } finally {
    await mock.close();
  }
});
