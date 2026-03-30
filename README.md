# pi-mock

[![npm version](https://img.shields.io/npm/v/pi-mock.svg)](https://www.npmjs.com/package/pi-mock)
[![license](https://img.shields.io/npm/l/pi-mock.svg)](https://github.com/sshkeda/pi-mock/blob/main/LICENSE)

Integration testing harness for [pi](https://github.com/badlogic/pi-mono) extensions.

Spins up a real `pi` process with a mock LLM API, full network control, and RPC communication. CLI-first — designed to be easy for AI agents to use.

## How it works

One gateway server that wears three hats:

1. **Mock LLM API** — `POST /v1/messages` → your brain function decides the response (Anthropic format, with OpenAI/Google response translation)
2. **HTTP forward proxy** — `GET http://...` → check network rules → forward, block, or intercept
3. **HTTPS tunnel proxy** — `CONNECT host:443` → check network rules → tunnel or block (intercept not supported)

With Docker sandbox mode, iptables blocks all outbound traffic except to the gateway. The gateway IS the internet.

## Prerequisites

Requires [pi](https://github.com/mariozechner/pi-mono) installed globally:

```bash
npm install -g @mariozechner/pi-coding-agent
```

For Docker sandbox mode, [Docker](https://docs.docker.com/get-docker/) must be installed.

## Install

```bash
npm install pi-mock
```

## CLI Usage

### Start a session

```bash
# Start with echo brain (default) — stays running
pi-mock start -e ./my-extension.ts &

# Start with custom brain
pi-mock start --brain ./brain.js -e ./my-extension.ts &

# Start with Docker sandbox (full network isolation)
pi-mock start --brain ./brain.js -e ./ext.ts --sandbox &

# Allow specific hosts through the proxy
pi-mock start --brain ./brain.js --allow registry.npmjs.org --allow github.com &
```

### Interact with a running session

```bash
# Send a prompt — waits for completion, returns cycle events
pi-mock prompt "run ls in the current directory"

# Inspect state
pi-mock events                    # All RPC events
pi-mock events --since 10         # Events since index 10
pi-mock requests                  # All API requests the brain saw
pi-mock proxy-log                 # Every proxy request (host, action, timestamp)
pi-mock status                    # Current state summary

# Shut down
pi-mock stop
```

### One-shot mode

```bash
# Start → prompt → print results → stop (all in one)
pi-mock run --brain ./brain.js -e ./ext.ts "do something"
```

### Record & Replay

Record a real API session, then replay it deterministically:

```bash
# Record — forwards to real API, saves transcript
pi-mock record --model claude-sonnet-4-20250514 -e ./ext.ts -o session.json "build a todo app"

# Replay — uses saved transcript as brain (free, fast, deterministic)
pi-mock run --brain session.json -e ./ext.ts "build a todo app"
```

Or hand-write a scenario as JSON:

```bash
echo '[{"type":"tool_call","name":"bash","input":{"command":"ls"}}]' > scenario.json
pi-mock run --brain scenario.json -e ./ext.ts "list files"
```

### Management API

The gateway exposes authenticated HTTP endpoints. Read the token from the state file:

```bash
# Start in background — port is printed to stdout
pi-mock start --brain echo &
STATE=$(cat "$(node -e "process.stdout.write(require('os').tmpdir())")/pi-mock.json")
PORT=$(echo $STATE | jq -r .port)
TOKEN=$(echo $STATE | jq -r .token)

curl -H "x-pi-mock-token: $TOKEN" localhost:$PORT/_/prompt   -d '{"message": "hello"}'
curl -H "x-pi-mock-token: $TOKEN" localhost:$PORT/_/events
curl -H "x-pi-mock-token: $TOKEN" localhost:$PORT/_/requests
curl -H "x-pi-mock-token: $TOKEN" localhost:$PORT/_/proxy-log
curl -H "x-pi-mock-token: $TOKEN" localhost:$PORT/_/status
curl -H "x-pi-mock-token: $TOKEN" localhost:$PORT/_/network  -d '{"rules": [{"match": "npmjs.org"}], "default": "block"}'
curl -H "x-pi-mock-token: $TOKEN" localhost:$PORT/_/intercept -d '{"host": "api.example.com", "body": "{\"ok\":true}"}'
curl -H "x-pi-mock-token: $TOKEN" localhost:$PORT/_/intercepts
curl -H "x-pi-mock-token: $TOKEN" -X POST localhost:$PORT/_/stop
```

## Brain Files

A brain is a JS module that default-exports a function or array:

```javascript
// brain.js — scripted responses
import { bash, text } from "pi-mock";
export default [bash("ls"), text("done")];
```

```javascript
// brain.js — custom logic
import { text, bash } from "pi-mock";
export default (req, index) => {
  if (index === 0) return bash("echo hello");
  return text("All done!");
};
```

JSON files are auto-detected as transcripts (see [Record & Replay](#record--replay-1)).

Built-in brains: `echo` (default), `always`.

## Programmatic API

```typescript
import { createMock, script, bash, text } from "pi-mock";

const mock = await createMock({
  brain: script(bash("ls"), text("done")),
  extensions: ["./my-extension.ts"],
  sandbox: true,
  network: {
    default: "block",
    rules: [
      { match: "registry.npmjs.org" },
      { match: /\.github\.com$/, action: "allow" },
    ],
  },
});

const events = await mock.run("do something");

mock.requests;     // API requests the brain saw
mock.proxyLog;     // Every proxy request (host, action, timestamp)
mock.events;       // All RPC events
mock.stderr;       // Pi's stderr output lines
mock.port;         // Gateway port
mock.url;          // Gateway URL (http://127.0.0.1:PORT)
mock.token;        // Management API auth token

// Mid-test mutations
mock.setBrain(newBrain);
mock.setNetworkRules([...]);

// Multiple prompts
const events2 = await mock.run("now try this");

// Steer/follow-up/abort — test extension intervention flows
await mock.prompt("start working");
await mock.steer("also consider edge cases");  // delivered between tool calls
await mock.followUp("now do part 2");           // triggers new turn after agent finishes
await mock.abort();                             // cancel current turn

// Wait for specific events or brain requests
const toolEvent = await mock.waitFor(e => e.type === "tool_call");
const { request, index } = await mock.waitForRequest((req, i) => i === 0);

// Test helper methods
await mock.setAutoRetry(false);                 // disable pi's auto-retry on transient errors
await mock.emitEvent("clock:advance", { ms: 300_000 }); // emit on pi's extension event bus
await mock.invokeCommand("my-command", "args"); // invoke an extension command (no LLM turn)
await mock.setActiveTools(["bash", "read"]);    // restrict active tools
await mock.setActiveTools("*");                 // restore all tools

// Raw RPC escape hatch — any command pi supports
const state = await mock.sendRpc({ type: "get_state" });
const stats = await mock.sendRpc({ type: "get_session_stats" });

await mock.close();
```

## Record & Replay

Record a real API session and replay it for deterministic, free, fast testing.

### Recording

```typescript
import { createMock, createRecorder } from "pi-mock";

const rec = createRecorder({ model: "claude-sonnet-4-20250514" });
const mock = await createMock({
  brain: rec.brain,
  extensions: ["./my-extension.ts"],
  network: { default: "allow" }, // extensions need real network during recording
});

await mock.run("build a todo app");
await rec.save("./session.json");  // saves transcript
await mock.close();
```

### Replaying

```typescript
import { createMock, replay } from "pi-mock";

const mock = await createMock({
  brain: replay("./session.json"),
  extensions: ["./my-extension.ts"],
  sandbox: true, // full isolation — no network needed
});

await mock.run("build a todo app"); // deterministic, free, fast
await mock.close();
```

### Transcript Format

Transcripts are JSON. Three formats are supported — use whichever fits:

**Full format** (from recording):
```json
{
  "version": 1,
  "recorded": "2026-03-28T...",
  "meta": { "provider": "anthropic", "model": "claude-sonnet-4-20250514" },
  "turns": [
    {
      "response": [
        { "type": "tool_call", "name": "bash", "input": { "command": "ls" } }
      ],
      "usage": { "input_tokens": 1500, "output_tokens": 200 },
      "request": { "model": "claude-sonnet-4-20250514", "messageCount": 3, "lastUserPrefix": "build a..." }
    },
    {
      "response": [{ "type": "text", "text": "Done!" }]
    }
  ]
}
```

**Array of turns** (hand-written):
```json
[
  { "response": [{ "type": "tool_call", "name": "bash", "input": { "command": "ls" } }] },
  { "response": [{ "type": "text", "text": "Done!" }] }
]
```

**Simple shorthand** (hand-written, minimal):
```json
[
  [{ "type": "tool_call", "name": "bash", "input": { "command": "ls" } }],
  [{ "type": "text", "text": "Done!" }]
]
```

Recorded transcripts include request fingerprints for **divergence detection** — if the replay agent sends different requests than were recorded, pi-mock logs a warning.

## Fault Injection

Simulate real-world API failures to test pi's error handling, retry logic, and extension resilience.

### Error Builders

```typescript
import { httpError, rateLimited, overloaded, serverError, serviceUnavailable } from "pi-mock";

rateLimited(5)              // 429 Too Many Requests + retry-after: 5s
overloaded()                // 529 Overloaded (Anthropic-specific)
serverError()               // 500 Internal Server Error
serviceUnavailable()        // 503 Service Unavailable
httpError(502, "bad gw")    // Any HTTP error
```

Errors return proper provider-specific error bodies (Anthropic, OpenAI, Google formats) so the SDKs parse them correctly. By default, `x-should-retry: false` is included to bypass the Anthropic SDK's built-in retries — errors go straight to pi's own retry logic.

### Brain Wrappers

Compose with any existing brain:

```typescript
import { flakyBrain, errorAfter, failFirst, failNth, intermittent } from "pi-mock";
import { script, bash, text, rateLimited, overloaded } from "pi-mock";

const inner = script(bash("ls"), text("done"));

// 20% of requests fail with overloaded error (deterministic — seeded PRNG)
flakyBrain(inner, { rate: 0.2 })
flakyBrain(inner, { rate: 0.3, error: rateLimited(5), seed: 123 })

// Succeed 3 times, then error forever (API dies mid-session)
errorAfter(3, inner)
errorAfter(3, inner, serverError())

// Fail 2 times, then recover (tests retry → recovery)
failFirst(2, inner)
failFirst(2, inner, rateLimited(1))

// Only request #3 fails (transient single failure)
failNth(2, inner)

// Custom pattern: fail, fail, succeed, repeat
intermittent(inner, { pattern: [false, false, true] })
```

`flakyBrain` uses a seeded PRNG (default seed: 42) for reproducible test results. Pass `seed` to get a different but still deterministic sequence.

### Example: Test retry recovery

```typescript
import { createMock, failFirst, script, text } from "pi-mock";

const mock = await createMock({
  brain: failFirst(1, script(text("recovered!"))),
});

const events = await mock.run("test retry");

// pi should retry once and recover
const retries = events.filter(e => e.type === "auto_retry_start");
console.log(`Retried ${retries.length} time(s)`); // 1

await mock.close();
```

## Steer, Follow-up & Abort

Test extensions that intervene during agent turns (like pi-manager's steer or pi-council's follow-up):

```typescript
import { createMock, createControllableBrain, text, bash } from "pi-mock";

const cb = createControllableBrain();
const mock = await createMock({ brain: cb.brain });

// Start a prompt
await mock.prompt("build a todo app");

// Brain receives the call — hold it while we steer
const call = await cb.waitForCall();

// Filtered waiting — useful when multiple clients hit the brain concurrently
const gptCall = await cb.waitForCall({ model: "gpt-4" }, 3000);
const claudeCall = await cb.waitForCall(req => req.model.includes("claude"), 3000);

// Inspect buffered calls
cb.pending(); // snapshot of unresponded calls

// Steer mid-turn (delivered between tool calls)
await mock.steer("use TypeScript, not JavaScript");

// Release the brain
call.respond(bash("mkdir todo-app"));

// ... pi executes tool, makes another brain call with steer injected
const call2 = await cb.waitForCall();
call2.respond(text("done"));
await mock.drain();

// Follow-up: triggers a new turn after agent finishes
await mock.prompt("hello");
await mock.followUp("also check for errors");
// Both turns will execute

// Abort: cancel the current turn
await mock.prompt("start something long");
await cb.waitForCall();
await mock.abort();
// Pi emits agent_end immediately

// Raw RPC: any command pi supports
const state = await mock.sendRpc({ type: "get_state" });
console.log(state.data.model); // { provider: "pi-mock", id: "mock" }
```

## Network Isolation (Docker Sandbox)

With `--sandbox`, pi runs in a Docker container with `--cap-add=NET_ADMIN`:

```bash
# iptables inside the container:
iptables -P OUTPUT DROP
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -d $GATEWAY_IP -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
ip6tables -P OUTPUT DROP
```

Even if code ignores `HTTP_PROXY`/`HTTPS_PROXY`, iptables drops the packets. The only IP the container can reach is the gateway.

Network rules control what the proxy allows through:

```bash
pi-mock start --sandbox --network-default block --allow registry.npmjs.org --allow github.com
```

### HTTP Intercepts

Intercept rules return custom responses instead of forwarding to the real server (HTTP only, not HTTPS):

```typescript
import { createMock, script, text } from "pi-mock";

const mock = await createMock({
  brain: script(text("done")),
  network: {
    default: "block",
    rules: [
      // Static response
      {
        match: "api.example.com",
        action: "intercept",
        response: { status: 200, body: '{"ok": true}', headers: { "Content-Type": "application/json" } },
      },
      // Dynamic handler
      {
        match: "data.example.com",
        action: "intercept",
        handler: (host, method, path, headers) => ({
          status: 200,
          body: `intercepted ${method} ${path}`,
        }),
      },
    ],
  },
});
```

Intercepts can also be managed at runtime via the management API:

```bash
# Add/update an intercept
curl -H "x-pi-mock-token: $TOKEN" localhost:$PORT/_/intercept \
  -d '{"host": "api.example.com", "body": "{\"mock\": true}", "status": 200}'

# List current intercepts
curl -H "x-pi-mock-token: $TOKEN" localhost:$PORT/_/intercepts

# Remove an intercept
curl -H "x-pi-mock-token: $TOKEN" localhost:$PORT/_/intercept \
  -d '{"host": "api.example.com", "remove": true}'
```

## Parallel Testing

Each mock gets its own gateway (random port) and container. Run as many as you want:

```bash
pi-mock start --brain brain1.js --state /tmp/test1.json &
pi-mock start --brain brain2.js --state /tmp/test2.json &

pi-mock prompt --state /tmp/test1.json "test scenario A"
pi-mock prompt --state /tmp/test2.json "test scenario B"
```

## Response Builders

```typescript
import {
  text, bash, edit, writeTool, readTool, toolCall, thinking, error,
  httpError, rateLimited, overloaded, serverError, serviceUnavailable,
} from "pi-mock";

// Content responses
text("hello")                           // Text response
thinking("let me consider...")          // Thinking block
bash("ls -la")                          // Bash tool call
bash("sleep 30", 5)                     // Bash with timeout
edit("file.ts", "old", "new")           // Edit tool call
writeTool("file.ts", "content")         // Write tool call
readTool("file.ts")                     // Read tool call
toolCall("custom", { key: "value" })    // Any tool call
error("something went wrong")           // SSE error event (200 status)

// HTTP errors (real status codes — trigger pi's retry logic)
httpError(502, "bad gateway")           // Any HTTP error
rateLimited(5)                          // 429 + retry-after header
overloaded()                            // 529 (Anthropic-specific)
serverError()                           // 500
serviceUnavailable()                    // 503

// Multiple blocks in one response
[thinking("hmm..."), bash("ls"), text("done")]
```

## Brain Helpers

```typescript
import {
  script, always, echo, createControllableBrain,
  flakyBrain, errorAfter, failFirst, failNth, intermittent,
  createRecorder, replay,
} from "pi-mock";

// Basic
script(bash("ls"), text("done"))   // Returns responses in order
always(text("hello"))              // Same response forever
echo()                             // Echoes back the user's message

// Controllable (step through requests manually)
const cb = createControllableBrain();
// ... cb.waitForCall() → call.respond(text("hi"))
// ... cb.waitForCall({ model: "gpt-4" }) → filtered waiting
// ... cb.pending() → inspect buffered calls

// Fault injection
flakyBrain(inner, { rate: 0.2 })   // Random failures (seeded PRNG)
errorAfter(3, inner)               // Die after 3 successes
failFirst(2, inner)                // Fail 2x then recover
failNth(1, inner)                  // Only request #1 fails
intermittent(inner, { pattern })   // Custom fail/succeed cycle

// Record & replay
createRecorder({ model: "..." })   // Record real API → transcript
replay("./session.json")           // Replay transcript as brain
```

## Limitations & Security

### Network

- **Sandbox mode binds to `0.0.0.0`** — The gateway must listen on all interfaces so the Docker container can reach it via `host.docker.internal`. This means the mock LLM API and HTTP proxy are accessible from your local network while running. The management API (`/_/` endpoints) is token-protected, but the proxy itself is not. Run sandbox mode on trusted networks only, or add host firewall rules to restrict the gateway port.
- **HTTPS intercept is not supported** — Network rules with `action: "intercept"` only work for plain HTTP requests. HTTPS `CONNECT` tunnels cannot be intercepted without MITM (no fake certificates). Intercept rules on HTTPS hosts will be treated as `"block"` with a warning logged.
- **Sandbox runs as root** — The Docker container runs as root with `NET_ADMIN` capability (needed for iptables). The working directory is mounted read-write at `/work`. This is a testing tool, not a security sandbox.

### Providers

- **pi always sends Anthropic-format requests** — The mock spawns pi with the `pi-mock` provider using the `anthropic-messages` API. The gateway translates responses into the correct format for each provider, but the incoming request from pi is always Anthropic-shaped.
- **Record/replay is Anthropic and OpenAI only** — `createRecorder()` supports forwarding to Anthropic and OpenAI. Google is not yet supported for recording. The raw request from pi is Anthropic-format, so OpenAI recording may have issues with tool schema translation.
- **`script()` returns a fallback on exhaustion** — If a `script()` brain runs out of responses, it returns `text("(script exhausted)")` instead of throwing. Check for this in assertions if your test expects exact response counts.
- **`replay()` throws on exhaustion** — If a `replay()` brain is called more times than there are recorded turns, it throws an error. This prevents false-positive tests by failing loudly when the test diverges from the recording.

### Compatibility

- **Tested with pi `>=0.62.0`** — The Dockerfile pins `@mariozechner/pi-coding-agent@0.62`. Newer versions should work but aren't guaranteed. If pi's RPC protocol or event shapes change, tests may break.
- **macOS and Linux only** — Docker sandbox mode relies on iptables and `host.docker.internal`. Windows (native, not WSL2) is untested.

## License

MIT
