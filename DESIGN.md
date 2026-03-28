# TUI Observation & Control — Design

## Problem

pi-mock currently runs pi in `--mode rpc` (headless JSONL). This gives structured events and handles extension UI dialogs (select, confirm, input, editor), but:

1. **Dialog handling is dumb** — auto-cancels all dialogs instead of exposing them
2. **No TUI visibility** — can't see what pi renders, can't test `ctx.ui.custom()`
3. **No TUI interaction** — can't send keystrokes, navigate menus, type in editor

## Approach Evaluation

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| **A: PI_TUI_WRITE_LOG** | Zero deps, pi supports it | Need pty anyway for input; log is append-only ANSI stream | Partial |
| **B: PTY (node-pty)** | Real terminal, full fidelity, input + output | Native dep, local-only | **Chosen for TUI** |
| **C: AgentSession direct** | Most deterministic | Rebuilds half of pi-mock; tight coupling | Rejected |
| **D: Helper extension** | No pi modifications | custom() returns undefined in RPC; circular problem | Rejected |

## Architecture

### Layer 1: Dialog Handling (RPC mode, no new deps)

Enhance `rpc.ts` with a proper dialog queue:

```
ExtensionUIRequest arrives → stored in pendingDialogs map
                           → emitted to listeners
                           → waits for response (or auto-cancels on timeout)
```

Management API:
- `GET /_/dialogs` — list pending dialogs
- `POST /_/dialog/:id` — respond with `{value}`, `{confirmed}`, or `{cancelled}`
- `GET /_/dialogs/wait` — long-poll for next dialog

Mock interface:
- `mock.dialogs` — pending dialog list
- `mock.respondDialog(id, response)` — respond to a dialog
- `mock.waitForDialog(pred?, timeout?)` — wait for a dialog to appear

### Layer 2: TUI Mode with PTY (optional, local only)

When `mode: 'tui'` is specified:

```
pi-mock
  └─ node-pty (pseudo-terminal)
       └─ pi (TUI mode, real terminal)
            ├─ stdout → Screen buffer (ANSI parser)
            └─ stdin ← Keystroke injection
```

Components:
- **ScreenBuffer** (`screen.ts`) — Minimal VT100 emulator maintaining a character grid
- **PtyManager** (`pty.ts`) — Spawns pi in pty, feeds output to ScreenBuffer, accepts input

Management API:
- `GET /_/screen` — current screen text (plain text, stripped of ANSI)
- `GET /_/screen/size` — terminal dimensions
- `POST /_/keys` — send keystrokes/escape sequences
- `POST /_/type` — type text characters
- `POST /_/screen/wait` — wait for text/regex on screen

Mock interface:
- `mock.screen()` — get screen text
- `mock.sendKeys(...keys)` — send key sequences
- `mock.type(text)` — type text
- `mock.waitForText(text, timeout?)` — wait for text to appear on screen
- `mock.resize(cols, rows)` — resize terminal

### Layer 3: Deterministic Interaction Pattern

The key to determinism is **observe-then-act**:

```typescript
// Send a keystroke, then verify the result
await mock.sendKeys(Key.down);
await mock.waitForText("▸ Option 2"); // Wait for selection to move

// Type in the editor
await mock.type("hello world");
await mock.waitForText("hello world");

// Navigate and confirm
await mock.sendKeys(Key.enter);
await mock.waitForText("Confirmed");
```

This avoids timing issues because every action is followed by a verification step.

## Virtual Terminal (ScreenBuffer)

A minimal VT100 emulator that processes ANSI output:

**Handled:**
- Character output → grid write + cursor advance
- `\n`, `\r`, `\t`, `\b` — standard control characters
- CSI cursor movement: CUP, CUU, CUD, CUF, CUB, HVP, CHA, VPA
- CSI erase: ED (erase display), EL (erase line)
- CSI scroll: SU, SD, IL, DL
- CSI scroll region: DECSTBM
- SGR (colors) — parsed and skipped
- OSC, APC, DCS — parsed and skipped

**Not handled (unnecessary for text observation):**
- Character sets, alternate screen (could add later)
- Mouse events
- Kitty keyboard protocol responses

## Limitations

- **TUI mode is local-only** — Docker sandbox mode continues to use RPC
- **node-pty is optional** — TUI features throw if not installed
- **Screen buffer is approximate** — complex TUI layouts may not parse perfectly
- **No rendering fidelity** — we capture text, not pixels

## Dependencies

- `node-pty` — optional peer dependency for TUI mode
- No other new runtime dependencies
