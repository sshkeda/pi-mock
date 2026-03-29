# Changelog

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
