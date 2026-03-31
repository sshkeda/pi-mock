# Changelog

## 1.1.0 (2026-03-31)

### Features

- **Interactive mode testing** — New `createInteractiveMock()` spawns pi in its default terminal UI mode via a pseudo-terminal (node-pty). Drive pi's interactive TUI programmatically with `type()`, `submit()`, `sendKey()`, and `waitForOutput()`.
- **Management HTTP API for interactive mode** — 12 endpoints (`/_/submit`, `/_/output`, `/_/send-key`, `/_/wait-for-output`, `/_/resize`, `/_/status`, etc.) for driving interactive sessions over HTTP, matching the regular mock's `/_/` pattern.
- **Process stats** — New `getProcessStats()` on both `Mock` and `InteractiveMock` for snapshotting pi's RSS memory and CPU usage via `ps`.
- **Docker test matrix** — `Dockerfile.test` and `test/docker-matrix.sh` for running the full test suite across Node 20/22/24.

### Bug Fixes

- **ANSI stripping** — Terminal output stripping now handles OSC sequences (`\x1b]...\x07`), extended CSI variants, and control characters. Previously only basic CSI sequences were stripped, leaving artifacts from pi's TUI hyperlinks and mode-setting escapes.
- **node-pty spawn-helper permissions** — Auto-detects and fixes the missing execute bit on node-pty's prebuild `spawn-helper` binary, which ships without +x in the npm tarball and causes `posix_spawnp failed` errors on first use.

### Other

- `node-pty` added as optional peer dependency (only needed for interactive mode).

## 1.0.1 (2026-03-29)

### Bug Fixes

- **Google SSE** — Only set `finishReason: "STOP"` on the last chunk, matching real API behavior. Previously every chunk said STOP, causing consumers to stop after the first block in multi-block responses.
- **Thinking blocks** — Non-Anthropic serializers (OpenAI, Google) now warn via `console.warn` when thinking blocks are dropped instead of silently discarding them. Also fixes ghost `{}` objects in `openaiResponsesToSSE` `response.completed` output.
- **Gateway cleanup** — `cleanup()` now closes the gateway HTTP server on SIGINT/SIGTERM, preventing server handle leaks that blocked process exit.
- **Google request parsing** — `parseGoogleRequest` now handles `functionCall` and `functionResponse` parts. Previously only text parts were extracted, so the brain couldn't see tool interactions.
- **OpenAI Responses parsing** — `parseOpenAIResponsesRequest` now preserves structured `function_call`/`function_call_output` items with correct `role: "tool"` instead of converting to lossy text strings.
- **Google model name** — Extract model from URL path (`/models/gemini-2.0-flash:...`) instead of always falling back to `"gemini"`.

## 1.0.0 (2026-03-29)

Initial public release.

### Features

- **Mock LLM API** — Intercepts Anthropic, OpenAI, and Google AI API calls with configurable brain functions
- **Response builders** — `text()`, `bash()`, `edit()`, `writeTool()`, `readTool()`, `toolCall()`, `thinking()`, `error()`
- **Brain helpers** — `script()`, `always()`, `echo()`, `createControllableBrain()`
- **Fault injection** — `flakyBrain()`, `failFirst()`, `failNth()`, `errorAfter()`, `intermittent()`
- **HTTP error simulation** — `httpError()`, `rateLimited()`, `overloaded()`, `serverError()`, `serviceUnavailable()`
- **Record & replay** — Record real API sessions, replay them deterministically
- **Network isolation** — Docker sandbox with iptables-based network control
- **HTTP/HTTPS proxy** — Forward proxy with configurable allow/block rules
- **RPC communication** — Full control over pi process via RPC
- **Agent control** — `steer()`, `followUp()`, `abort()`, `sendRpc()` for testing intervention flows
- **CLI** — `pi-mock start`, `run`, `record`, `prompt`, `events`, `requests`, `stop`
- **Multi-provider support** — Anthropic, OpenAI (Chat + Responses API), Google Gemini
- **Parallel testing** — Each mock gets its own gateway and container
