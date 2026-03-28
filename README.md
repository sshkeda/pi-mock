# pi-mock

Integration testing harness for [pi](https://github.com/badlogic/pi-mono) extensions.

Spins up a real `pi` process with a mock Anthropic API, full network control, and RPC communication. CLI-first — designed to be easy for AI agents to use.

## How it works

One gateway server that wears three hats:

1. **Mock Anthropic API** — `POST /v1/messages` → your brain function decides the response
2. **HTTP forward proxy** — `GET http://...` → check network rules → forward or block
3. **HTTPS tunnel proxy** — `CONNECT host:443` → check network rules → tunnel or block

With Docker sandbox mode, iptables blocks all outbound traffic except to the gateway. The gateway IS the internet.

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
pi-mock requests                  # All Anthropic API requests the brain saw
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

### Management API

The gateway exposes HTTP endpoints — use `curl` directly:

```bash
PORT=$(pi-mock start --brain echo 2>/dev/null &; sleep 3; cat /tmp/pi-mock.json | jq -r .port)

curl localhost:$PORT/_/prompt   -d '{"message": "hello"}'
curl localhost:$PORT/_/events
curl localhost:$PORT/_/requests
curl localhost:$PORT/_/proxy-log
curl localhost:$PORT/_/status
curl localhost:$PORT/_/network  -d '{"rules": [{"match": "npmjs.org"}], "default": "block"}'
curl -X POST localhost:$PORT/_/stop
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

mock.requests;     // Anthropic API requests the brain saw
mock.proxyLog;     // Every proxy request (host, action, timestamp)
mock.events;       // All RPC events

// Mid-test mutations
mock.setBrain(newBrain);
mock.setNetworkRules([...]);

// Multiple prompts
const events2 = await mock.run("now try this");

await mock.close();
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
import { text, bash, edit, writeTool, readTool, toolCall, error } from "pi-mock";

text("hello")                           // Text response
bash("ls -la")                          // Bash tool call
bash("sleep 30", 5)                     // Bash with timeout
edit("file.ts", "old", "new")           // Edit tool call
writeTool("file.ts", "content")         // Write tool call
readTool("file.ts")                     // Read tool call
toolCall("custom", { key: "value" })    // Any tool call
error("something went wrong")           // Error response

// Multiple blocks in one response
[bash("ls"), text("done")]
```

## Brain Helpers

```typescript
import { script, always, echo } from "pi-mock";

script(bash("ls"), text("done"))   // Returns responses in order
always(text("hello"))              // Same response forever
echo()                             // Echoes back the user's message
```

## License

MIT
