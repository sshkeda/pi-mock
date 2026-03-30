# Changelog

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
