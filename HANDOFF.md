# pi-mock Handoff

## What is this

A testing harness for [pi](https://github.com/badlogic/pi-mono) extensions. Spins up a real pi process inside a Docker container, mocks all LLM API calls via a "brain" function, controls network access via iptables, and exposes a CLI + management HTTP API to observe everything.

**15/15 e2e tests pass in Docker sandbox mode.** It's being actively used by another agent to test pi extensions.

## Architecture

One gateway HTTP server wearing three hats:
1. **Mock LLM API** — Detects provider format from URL path, calls brain function, serializes response in correct wire format (Anthropic Messages, OpenAI Responses, OpenAI Chat Completions, Google Generative AI)
2. **HTTP forward proxy** — Allow, block, or intercept (serve fake content) for HTTP requests
3. **HTTPS tunnel proxy** — Allow or block CONNECT tunnels

All LLM providers are redirected to the gateway via `models.json` base URL overrides in `PI_CODING_AGENT_DIR`. No MITM, no fake certs. The brain function returns universal `text()`/`bash()`/`toolCall()`/`error()` blocks — the gateway translates to the correct provider format.

Docker sandbox: iptables drops all outbound except to gateway IP:port. IPv6 blocked.

## Files

```
src/
  anthropic.ts   — Response builders (text, bash, toolCall, etc.) + Anthropic SSE serializer
  providers.ts   — Multi-provider: detectProvider(), parseRequest(), serializeResponse()
                   Supports: anthropic, openai (chat completions), openai-responses, google
  gateway.ts     — Mock LLM handler + HTTP proxy + HTTPS tunnel + intercept support
  rpc.ts         — JSONL client for pi's --mode rpc (manual \n splitting, UI dialog auto-cancel)
  sandbox.ts     — spawnLocal() + spawnSandbox() + models.json generation for all providers
  mock.ts        — Composes gateway+rpc+sandbox, management HTTP API (/_/ endpoints)
  cli.ts         — CLI: start/run/prompt/events/requests/proxy-log/status/stop
  index.ts       — Re-exports
Dockerfile              — node:22-slim + iptables + pi
docker-entrypoint.sh    — iptables setup (port-restricted, fail-closed)
```

## Current state

### What works (tested e2e in Docker)
- Text responses, tool calls, multi-block (text+tool), error propagation
- Tool execution inside container (root, isolated hostname)
- iptables blocks direct connections
- Google subprocess (gemini-2.0-flash) routes through brain
- OpenAI subprocess (gpt-4o, Responses API) routes through brain
- Anthropic subprocess (claude-sonnet-4) routes through brain
- Management API: /_/prompt, /_/events, /_/requests, /_/proxy-log, /_/status, /_/intercept, /_/network, /_/stop
- Network intercepts (serve fake HTTP content for specific hosts)

### Bugs to fix (council-identified, priority order)

1. **`run()` race condition** (mock.ts ~line 412) — After `prompt()` resolves, `waitFor()` subscribes for FUTURE events only. If `agent_end` fires between prompt completing and waitFor registering, it's missed → 120s timeout on a 50ms test. Fix: register listener BEFORE sending prompt, or have waitFor scan existing events from the start index.

2. **Google `finishReason` wrong for tool calls** (providers.ts, `googleToSSE()`) — Emits `"STOP"` for tool_call blocks. Should be `"FUNCTION_CALL"`. One-line fix.

3. **OpenAI Chat Completions `tool_calls` all use `index: 0`** (providers.ts, `openaiToSSE()`) — When brain returns multiple tool calls, they all get `index: 0`. Real API uses incrementing indices. Fix: track a counter in the loop.

4. **Management API reachable from inside sandbox** — Code inside the container can call `/_/stop`, `/_/network`, etc. to reconfigure or kill the harness. Fix options: require a secret header/token, or check request origin.

### Security fixes (in docker-entrypoint.sh)

**Already written but not yet tested/committed:**
- iptables now restricts to gateway PORT, not entire host IP (`-p tcp --dport $GATEWAY_PORT`)
- Fail-closed: exits with error if gateway IP or port can't be resolved
- These changes are in `docker-entrypoint.sh` on disk but need rebuild + retest

**Still TODO:**
- Container runs as root with NET_ADMIN — code inside can `iptables -F` to drop all rules. Fix: drop to non-root user after entrypoint sets iptables. Needs design (su-exec or similar).

### Features requested by real user (other agent testing pi extensions)

1. **Delayed brain responses** — `text("answer", { delayMs: 2000 })` or similar. Currently brain responds instantly. User had to hack `toolCall("bash", { command: "sleep 5" })` to simulate slow models.

2. **Fault injection mid-stream** — `error("connection reset", { after: 3 })` sends 3 good SSE chunks then drops. Real APIs fail mid-stream.

3. **Per-request brain routing** — Brain sees all requests but can't easily tell which subprocess/member is calling. Need a way to identify the caller (pi args, custom header, etc.).

4. **`mock.waitForRequest()`** — Await the next brain call instead of setTimeout. "Wait until pi has made its first API call, then do something."

5. **Assertion helpers** — `mock.toolCalls()`, `mock.expectToolCall("bash")`, `mock.lastToolCall()`, etc.

6. **Streaming chunk control** — Split SSE into N chunks with delays. Currently entire response is one `res.write()`.

### Backlog (not needed now)

- Passthrough mode (forward to real APIs while logging)
- Record/replay mode (capture real API traces for replay)
- HTTPS intercept (only allow/block works for CONNECT tunnels)
- vitest/jest lifecycle integration
- Non-root container user with capability dropping

## How to test

```bash
# Build
npm run build

# Build Docker image
docker build -t pi-mock-sandbox .

# Start in Docker sandbox mode
node dist/cli.js start --brain /path/to/brain.js --state /tmp/test.json --sandbox &

# Wait for ready
while [ ! -f /tmp/test.json ]; do sleep 0.5; done
PORT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/test.json','utf-8')).port)")

# Send prompt
curl -s localhost:$PORT/_/prompt -d '{"message":"hello","timeout":15000}'

# Observe
curl -s localhost:$PORT/_/events | jq
curl -s localhost:$PORT/_/requests | jq
curl -s localhost:$PORT/_/proxy-log | jq
curl -s localhost:$PORT/_/status | jq

# Stop
curl -s -X POST localhost:$PORT/_/stop
```

## Brain file format

```javascript
import { bash, text, toolCall, error } from "pi-mock";

export default (req, index) => {
  // req.messages — conversation so far
  // req._provider — "anthropic", "openai-responses", "google"
  // req.model — "mock", "gpt-4o", "gemini-2.0-flash", etc.
  // index — call count

  if (index === 0) return bash("ls -la");
  return text("Done.");
};
```

## Key design decisions to preserve

1. **No MITM** — models.json base URL overrides, not fake certs. This was tried and abandoned (HTTP/2 broke it, cert trust was fragile).
2. **One port** — Gateway + proxy + management API all on one port. Don't add a second.
3. **Brain is provider-agnostic** — Returns universal blocks, gateway serializes per provider.
4. **Docker is optional** — `--sandbox` flag. Local mode for fast iteration.
5. **CLI-first** — Designed for AI agents to use via bash + curl + jq.
