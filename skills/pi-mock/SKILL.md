---
name: pi-mock
description: Integration testing harness for Pi extensions and Pi itself. Use when testing or debugging Pi slash commands, extension hooks/tools, provider adapter request shapes, TUI/interactive behavior, notifications/status/widgets, network isolation, record/replay, or regressions that should launch a real Pi process. Prefer pi-mock over ad hoc manual Pi sessions for extension tests.
---

# pi-mock

Use the local pi-mock repo at `/Users/sshkeda/GitHub/pi-mock` to write deterministic integration tests for Pi extensions and Pi behavior.

Before non-trivial work, skim `/Users/sshkeda/GitHub/pi-mock/README.md` for the current API. If you edit pi-mock source itself, run `npm --prefix /Users/sshkeda/GitHub/pi-mock run build` before consuming `dist/`.

## When to use

Use pi-mock for:

- Pi extension regression tests, especially slash commands and custom tools.
- Interactive/TUI behavior that needs a real PTY: menus, key presses, rendering, crashes.
- Capturing `ctx.ui.notify()`, `ctx.ui.setStatus()`, and `ctx.ui.setWidget()` side effects.
- Provider adapter tests via `piProvider` + `piModel` against the mock gateway.
- Network isolation, proxy rules, record/replay, retries, and fault injection.

Do not rely on manual Pi sessions when a regression can be captured with pi-mock.

## Import paths in sibling repos

For repos next to `pi-mock`, import from the built local package:

```js
import { createInteractiveMock, createMock, script, text, bash } from "../../pi-mock/dist/index.js";
```

Adjust `../../` based on the test file location. Example from `repo/test/foo.mjs` to sibling `../pi-mock`: `../../pi-mock/dist/index.js`.

## Interactive/TUI regression template

Use `createInteractiveMock()` when the test must launch real interactive Pi and send keys.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInteractiveMock, script, text } from "../../pi-mock/dist/index.js";

const TIMEOUT = 30_000;
const EXTENSION = new URL("../index.ts", import.meta.url).pathname;

test("my command interactive regression", async () => {
  // Use a temp cwd to mimic installed-extension usage outside the extension repo.
  const cwd = mkdtempSync(join(tmpdir(), "pi-mock-test-"));
  const mock = await createInteractiveMock({
    brain: script(text("unused")),
    extensions: [EXTENSION],
    piProvider: "anthropic",
    piModel: "claude-sonnet-4-20250514",
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 30 },
    cwd,
  });

  try {
    mock.submit("/my-command");
    await mock.waitForOutput("Expected menu text", TIMEOUT);

    mock.sendKey("down");
    mock.sendKey("enter");

    await mock.waitForOutput("Expected final notification", TIMEOUT);
    assert.doesNotMatch(mock.output, /Theme not initialized|Unhandled|Error:/);
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
```

Common interactive helpers:

- `mock.submit("/cmd args")` — type command and press Enter.
- `mock.type("raw text")` — type without Enter.
- `mock.sendKey("down" | "up" | "enter" | "escape" | ...)` — send named key.
- `await mock.waitForOutput("text" | /regex/, timeoutMs)` — wait for terminal output.
- `mock.clearOutput()` — reset captured output between phases.
- `await mock.visibleScreen()` — assert visible terminal state when scrollback is misleading.
- Always `await mock.close()` in `finally`.

## Non-interactive extension tests

Use `createMock()` for faster RPC-style tests that do not need real TUI rendering.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMock, script, text } from "../../pi-mock/dist/index.js";

const EXTENSION = new URL("../index.ts", import.meta.url).pathname;

test("slash command notification", async () => {
  const mock = await createMock({
    brain: script(text("unused")),
    extensions: [EXTENSION],
  });

  try {
    const result = await mock.invokeCommand("my-command", "args");
    assert.equal(result.notifications[0].message, "Command executed");
  } finally {
    await mock.close();
  }
});
```

Use synthetic invocation for testing extension logic with context overrides (`hasUI`, `sessionId`, `invocationId`) after registering via `pi.events.emit("_mock:register_invocation", ...)` in the extension.

## Provider adapter tests

To exercise Pi's real provider adapter request shape against the mock gateway, pass both provider and model:

```js
const mock = await createMock({
  brain: script(text("ok")),
  piProvider: "openai",
  piModel: "gpt-4.1-mini",
});
```

Then inspect `mock.requests` or `await mock.waitForRequest(...)`.

## Best practices

- Prefer exact deterministic signals: output text, captured side effects, events, requests, process exit, and proxy logs.
- For TUI crash regressions, assert the expected UI renders and assert known crash text is absent.
- Use `cwd: mkdtempSync(...)` for installed-extension realism when module roots matter.
- Keep timeouts explicit (`20_000` startup, `30_000` interaction is typical).
- Close mocks in `finally`; remove temporary directories.
- Run the target repo's test script after editing, e.g. `npm run test:interactive`.
