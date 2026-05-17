---
name: pi-mock
description: Integration testing harness for Pi extensions and Pi itself. Use when testing or debugging Pi slash commands, extension hooks/tools, provider adapter request shapes, TUI/interactive behavior, notifications/status/widgets, network isolation, record/replay, or regressions that should launch a real Pi process. Prefer pi-mock over ad hoc manual Pi sessions for extension tests.
---

# pi-mock

Use the local pi-mock repo at `/Users/sshkeda/gh/pi-mock` to write deterministic integration tests for Pi extensions and Pi behavior.

Before non-trivial work, skim `/Users/sshkeda/gh/pi-mock/README.md` for the current API. If you edit pi-mock source itself, run `npm --prefix /Users/sshkeda/gh/pi-mock run build` before consuming `dist/`.

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
- `await mock.screenshot({ path: "./artifacts/screen.svg" })` — save the currently visible terminal as an SVG artifact; requires `@xterm/headless`.
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

- Treat pi-mock as an end-to-end Pi product harness, not a narrow request-shape checker. Use it to test complete user experience flows: what the user types, what the TUI shows, what tools run, what follow-up turns happen, what context the model receives, and what cleanup occurs.
- Start from the product invariant and user-visible story. Example: “a slow tool should feel like bash: wait briefly, move to background, show pending, return control, then resume the agent with the result.” Then assert every observable step in that story.
- Test the behavior the code depends on, not just intended happy-path usage. If a model could pass a surprising flag, malformed args, repeated tool calls, stale IDs, or racey timing, encode that as a pi-mock regression.
- Cover both fast and slow paths. For auto-background behavior, test: fast completes inline with no pending UI; slow promotes after threshold; background result resumes the conversation; errors clean up; cancellation/close does not leave stale UI.
- Model edge cases explicitly: success, failure, timeout, retry, duplicate completion, stale follow-up, no-op update, user sends a new message while a job is pending, extension reload, and process exit.
- Use deterministic event logs when ordering matters. Temporary test extensions can write lifecycle events to a temp file, e.g. `tool:start`, `pending:start`, `message:queued`, `provider:next-turn`, `pending:finish`. Assert ordering instead of relying on sleep guesses.
- Use dynamic `brain(req)` functions to simulate realistic model behavior across turns. The brain can first call a tool, later acknowledge a follow-up, later refuse, later call another tool, etc. This lets tests cover the whole agent loop, not just one API call.
- Inspect provider requests when relevant, but keep it as one evidence source among many. Provider payload inspection is useful for proving what the model was asked to react to; it is not the point of the test by itself.
- Assert UI and context together when possible: terminal output, pending widgets, custom messages, tool results, model follow-up requests, and final assistant text should all line up with the intended UX.
- Prefer temporary throwaway extensions for high-value regressions. A test can generate a tiny extension in `mkdtempSync(...)` that instruments exactly the lifecycle under test without polluting product code.
- For TUI crash regressions, assert the expected UI renders and assert known crash text is absent.
- Use `cwd: mkdtempSync(...)` for installed-extension realism when module roots matter.
- Keep timeouts explicit (`20_000` startup, `30_000` interaction is typical). For auto-background behavior, expose a test-only threshold env/option so tests use e.g. 100ms instead of waiting 30s.
- Close mocks in `finally`; remove temporary directories.
- Run the target repo's test script after editing, e.g. `npm run test:interactive`.

## High-power pattern: full integration lifecycle tests

Use this when testing background jobs, steer/follow-up messages, MCP/tool result injection, pending UI, custom tools, slash commands, provider handoff, or anything where correctness is a sequence of events rather than one function return.

Template shape:

1. Create a temp cwd with a tiny instrumented extension.
2. Extension logs important lifecycle events to a temp file.
3. `brain(req)` behaves like a mini model: first calls the tool/command path, later reacts to follow-up context, later emits final text.
4. The test drives Pi like a user with `mock.submit(...)` / keys.
5. Assert user-visible output and internal ordering.

```js
const mock = await createInteractiveMock({
  extensions: [extensionPath],
  brain: (req) => {
    // Use req as evidence about what the model sees and decide the next model action.
    // Example flow: first request -> toolCall(...); later request -> text("saw result").
  },
  cwd: tempDir,
  startupTimeoutMs: 20_000,
  terminal: { cols: 100, rows: 30 },
});

try {
  mock.submit("run the user scenario");
  await mock.waitForOutput("expected user-visible state", 30_000);
  await mock.waitForOutput("expected final model response", 30_000);

  const events = readFileSync(eventsPath, "utf8").trim().split("\n");
  assertOrdering(events, [
    "tool:start",
    "pending:start",
    "message:queued-or-observed",
    "model:reacted",
    "pending:finish",
  ]);
} finally {
  await mock.close();
  rmSync(tempDir, { recursive: true, force: true });
}
```

The goal is to prove the whole Pi experience works: user input, tool lifecycle, UI state, model turns, injected context, cleanup, and final response. Use provider request inspection when it answers a real UX question, but do not reduce pi-mock to string matching provider payloads.

## Race/chaos testing checklist

When testing concurrency, file locks, leases, session coordination, or crash recovery:

- Model intermediate states explicitly, not just normal completed states. Example: for a `mkdir(lockDir)` + `write(owner.json)` protocol, add a regression for a fresh ownerless lock directory.
- Add deterministic tests for every protocol state: no lock, fresh lock, stale lock, corrupt owner file, missing owner file, owner process killed, active lease not expired, expired lease, and conflicting expected head/version.
- Use real spawned processes where process death matters; `createMock().close()` is graceful and may not reproduce `SIGKILL` behavior.
- After pi-mock tests pass, run one installed-extension dogfood command with the real `pi` CLI for high-risk interprocess races. pi-mock is the regression harness; real CLI dogfood is a smoke test for scheduling/startup gaps the test did not model yet.
- If dogfood finds a race, first reduce it to a deterministic pi-mock regression, then fix the product code.
