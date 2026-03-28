# Task: Add TUI observation and control to pi-mock

## Context

pi-mock is an integration testing harness for [pi](https://github.com/badlogic/pi-mono) extensions. It spins up a real pi process, provides a mock Anthropic API (the "brain"), controls all network access via a proxy, and communicates with pi via RPC.

Currently pi-mock runs pi in `--mode rpc` (headless JSONL over stdin/stdout). This gives us structured events (tool calls, messages, tool results) and supports the Extension UI sub-protocol (select, confirm, input, editor dialogs). But we have NO visibility into the actual TUI — no visual rendering, no custom components.

**The goal: let the controlling agent (or test harness) observe and interact with pi's TUI programmatically, without tmux send-keys.**

## What pi already provides

### RPC mode (`--mode rpc`)
- Full JSONL event stream: `agent_start`, `message_update`, `tool_execution_*`, `agent_end`, etc.
- Extension UI dialogs work: `select`, `confirm`, `input`, `editor` → request/response over stdin/stdout
- Fire-and-forget UI: `notify`, `setStatus`, `setWidget`, `setTitle`
- Does NOT support `ctx.ui.custom()` (returns undefined)
- Deterministic, structured, no terminal parsing needed

### TUI mode (default, interactive)
- Full terminal rendering via `@mariozechner/pi-tui`
- Components: Text, Box, Container, Markdown, SelectList, SettingsList, Image, Editor
- Custom components via `ctx.ui.custom()`
- Keyboard input handling via `matchesKey(data, Key.up)` etc.
- Overlay system for dialogs
- Theming system
- Debug logging: `PI_TUI_WRITE_LOG=/tmp/tui-ansi.log` captures raw ANSI stream

### AgentSession (Node.js API)
- `@mariozechner/pi-coding-agent` exports `AgentSession` directly
- Can be used from Node.js without spawning a subprocess
- See `src/core/agent-session.ts`
- Docs mention: "If you're building a Node.js application, consider using AgentSession directly"

## What we need

### 1. Extension UI dialog handling (EASY — partially done)
pi-mock's `rpc.ts` already auto-cancels extension UI dialogs. Upgrade this:
- Expose dialogs to the management API so the controlling agent can RESPOND to them
- `GET /_/dialogs` — list pending dialogs
- `POST /_/dialog/:id` — respond to a dialog (value, confirmed, cancelled)
- This enables testing extensions that use `ctx.ui.select()`, `ctx.ui.confirm()`, etc.

### 2. TUI observation (MEDIUM)
Let the controlling agent see what pi's TUI looks like:
- **Option A**: Use `PI_TUI_WRITE_LOG` to capture the raw ANSI stream, expose it via API
- **Option B**: Run pi in TUI mode inside a pty (node-pty or similar), capture terminal buffer
- **Option C**: Use AgentSession directly and hook into the rendering pipeline
- **Option D**: Build a pi extension that mirrors TUI state to a file/socket

Evaluate which option is most practical. The agent needs to be able to "see" the screen — what text is displayed, what's selected, what status indicators are shown.

### 3. TUI interaction (HARD)
Let the controlling agent send keystrokes and interact with TUI components:
- Type in the editor
- Navigate menus (up/down/enter/escape)
- Trigger keyboard shortcuts
- Respond to custom component prompts

**Key constraint**: Must be deterministic. `tmux send-keys` is not deterministic because timing matters. We need something that's guaranteed to be processed.

Possible approaches:
- If using a pty: write to pty stdin (still has timing issues)
- If using AgentSession: call methods directly (most deterministic)
- If using RPC: the `prompt`, `steer`, `abort` commands already work; extend for UI interaction
- If using a helper extension: the extension receives input events and can trigger UI actions

## Existing codebase

```
pi-mock/src/
  gateway.ts   — Mock API + HTTP/HTTPS proxy + network rules
  rpc.ts       — JSONL client for pi's RPC mode
  sandbox.ts   — spawnLocal() and spawnSandbox() (Docker)
  mock.ts      — Composes gateway + rpc + sandbox, management HTTP API
  cli.ts       — CLI: start/prompt/events/stop etc.
  anthropic.ts — Response builders + SSE serializer
  index.ts     — Re-exports
```

The mock communicates with pi via `createRpcClient(proc)` which attaches to the child process's stdin/stdout. The gateway runs a management HTTP API on `/_/` prefix.

## Constraints

- pi is open source: https://github.com/badlogic/pi-mono
- We can read pi's source code to understand internals
- We should NOT fork or modify pi itself — pi-mock should work with stock pi
- The solution should work in both local and Docker sandbox modes
- Prefer deterministic approaches over timing-dependent ones

## Deliverables

1. A design doc explaining which approach you chose and why
2. Implementation of extension UI dialog handling via management API
3. Implementation of TUI observation (at minimum, a way to read current screen state)
4. Implementation of TUI interaction (at minimum, keyboard input injection)
5. Tests demonstrating the functionality works
