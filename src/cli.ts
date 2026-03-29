#!/usr/bin/env node
/**
 * pi-mock CLI
 *
 * Commands:
 *   start   — Start gateway + pi, stay running. Writes state file.
 *   run     — One-shot: start + prompt + print events + stop.
 *   prompt  — Send a prompt to a running session.
 *   events  — Print all RPC events.
 *   requests — Print all Anthropic API requests.
 *   proxy-log — Print all proxy activity.
 *   status  — Print session status.
 *   stop    — Graceful shutdown.
 *
 * Usage:
 *   pi-mock start --brain brain.js -e ./ext.ts --sandbox
 *   pi-mock prompt "do something"
 *   pi-mock events | jq
 *   pi-mock stop
 */

import { resolve } from "node:path";
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { pathToFileURL } from "node:url";
import { createMock, script, always, echo, type MockOptions } from "./mock.js";
import { type Brain, type BrainResponse } from "./anthropic.js";
import { type NetworkRule } from "./gateway.js";
import { createRecorder, replay } from "./record.js";

// ─── State file ──────────────────────────────────────────────────────

const DEFAULT_STATE_FILE = resolve(tmpdir(), "pi-mock.json");

interface StateFile {
  port: number;
  pid: number;
  token: string;
  startedAt: string;
}

function writeState(port: number, token: string, file: string) {
  const state: StateFile = { port, pid: process.pid, token, startedAt: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(state, null, 2));
}

function readState(file: string): StateFile {
  if (!existsSync(file)) {
    throw new Error(`No running session found (${file} not found). Start one with: pi-mock start`);
  }
  return JSON.parse(readFileSync(file, "utf-8"));
}

function cleanState(file: string) {
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}

// ─── HTTP client for management API ─────────────────────────────────

function mgmt(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {};
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    if (token) headers["x-pi-mock-token"] = token;
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: raw });
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Brain loading ──────────────────────────────────────────────────

async function loadBrain(brainArg: string): Promise<Brain> {
  // Built-in brains
  if (brainArg === "echo") return echo();
  if (brainArg === "always") return always({ type: "text", text: "OK" });

  // Load from file
  const absPath = resolve(brainArg);
  if (!existsSync(absPath)) {
    throw new Error(`Brain file not found: ${absPath}`);
  }

  // Auto-detect JSON transcript files → replay brain
  if (absPath.endsWith(".json")) {
    console.error(`[pi-mock] Loading transcript: ${absPath}`);
    return replay(absPath, {
      onDivergence: (index, expected, actual) => {
        console.error(
          `[pi-mock] ⚠ replay divergence at turn ${index}: ` +
          `expected ${expected.messageCount} messages, got ${actual.messageCount}`,
        );
      },
    });
  }

  const mod = await import(pathToFileURL(absPath).href);
  const exported = mod.default;

  if (typeof exported === "function") return exported;
  if (Array.isArray(exported)) return script(...(exported as BrainResponse[]));

  throw new Error(
    `Brain file must default-export a function or array of responses. Got: ${typeof exported}`,
  );
}

// ─── Arg parsing ─────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const args: Record<string, string | string[] | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--") || next.startsWith("-")) {
        args[key] = true;
      } else {
        // Repeatable: -e, --extension, --allow, --block
        if (["extension", "allow", "block"].includes(key)) {
          const existing = args[key];
          if (Array.isArray(existing)) {
            existing.push(next);
          } else {
            args[key] = [next];
          }
        } else {
          args[key] = next;
        }
        i++;
      }
    } else if (arg === "-o") {
      args["output"] = argv[++i];
    } else if (arg === "-e") {
      const next = argv[++i];
      const existing = args["extension"];
      if (Array.isArray(existing)) {
        existing.push(next);
      } else {
        args["extension"] = [next];
      }
    } else {
      positional.push(arg);
    }
  }

  return { args, positional };
}

// ─── Commands ────────────────────────────────────────────────────────

async function cmdStart(argv: string[]) {
  const { args } = parseArgs(argv);
  const stateFile = (args["state"] as string) ?? DEFAULT_STATE_FILE;

  // Load brain
  const brainArg = (args["brain"] as string) ?? "echo";
  const brain = await loadBrain(brainArg);

  // Parse extensions
  const extensions = ((args["extension"] as string[]) ?? []).map((e) => resolve(e));

  // Parse network rules
  const rules: NetworkRule[] = [];
  for (const host of (args["allow"] as string[]) ?? []) {
    rules.push({ match: host, action: "allow" });
  }
  for (const host of (args["block"] as string[]) ?? []) {
    rules.push({ match: host, action: "block" });
  }

  const options: MockOptions = {
    brain,
    extensions,
    sandbox: !!args["sandbox"],
    network: {
      default: (args["network-default"] as string as "allow" | "block") ?? "block",
      rules,
    },
    cwd: args["cwd"] as string,
    port: args["port"] ? parseInt(args["port"] as string) : 0,
    piArgs: args["pi-args"] ? (args["pi-args"] as string).split(" ") : undefined,
    image: args["image"] as string,
    startupTimeoutMs: args["startup-timeout"]
      ? parseInt(args["startup-timeout"] as string)
      : undefined,
  };

  console.error("[pi-mock] Starting...");
  const mock = await createMock(options);
  writeState(mock.port, mock.token, stateFile);

  console.error(`[pi-mock] Ready`);
  console.error(`[pi-mock] Gateway:  http://127.0.0.1:${mock.port}`);
  console.error(`[pi-mock] State:    ${stateFile}`);
  console.error(`[pi-mock] Mode:     ${options.sandbox ? "docker sandbox" : "local"}`);
  console.error(`[pi-mock]`);
  console.error(`[pi-mock] Management API:`);
  console.error(`[pi-mock]   curl localhost:${mock.port}/_/prompt  -d '{"message":"..."}'`);
  console.error(`[pi-mock]   curl localhost:${mock.port}/_/events`);
  console.error(`[pi-mock]   curl localhost:${mock.port}/_/requests`);
  console.error(`[pi-mock]   curl localhost:${mock.port}/_/proxy-log`);
  console.error(`[pi-mock]   curl localhost:${mock.port}/_/status`);
  console.error(`[pi-mock]   curl -X POST localhost:${mock.port}/_/stop`);

  // Print port to stdout for capture: PORT=$(pi-mock start ... 2>/dev/null)
  console.log(mock.port);

  // Keep alive until stop
  await new Promise<void>((resolve) => {
    process.on("SIGINT", async () => {
      console.error("\n[pi-mock] Shutting down...");
      cleanState(stateFile);
      await mock.close();
      resolve();
    });
    process.on("SIGTERM", async () => {
      cleanState(stateFile);
      await mock.close();
      resolve();
    });
  });
}

async function cmdRecord(argv: string[]) {
  const { args, positional } = parseArgs(argv);
  const message = positional.join(" ");
  if (!message) {
    console.error("Usage: pi-mock record [options] <prompt message>");
    console.error("  --model <id>     Real model ID (e.g. claude-sonnet-4-20250514). Required.");
    console.error("  -o, --output <f> Output transcript path. Default: session.json");
    process.exit(1);
  }

  const model = args["model"] as string;
  if (!model) {
    console.error("[pi-mock] Error: --model is required for recording (e.g. --model claude-sonnet-4-20250514)");
    process.exit(1);
  }

  const output = (args["output"] as string) ?? (args["o"] as string) ?? "session.json";
  const extensions = ((args["extension"] as string[]) ?? []).map((e) => resolve(e));
  const timeout = args["timeout"] ? parseInt(args["timeout"] as string) : 300_000;

  const rules: NetworkRule[] = [];
  for (const host of (args["allow"] as string[]) ?? []) {
    rules.push({ match: host, action: "allow" });
  }

  const rec = createRecorder({
    model,
    apiKey: args["api-key"] as string | undefined,
    onTurn: (turn, index) => {
      const types = turn.response.map((b) => b.type).join(", ");
      console.error(`[pi-mock] Turn ${index}: [${types}]`);
    },
  });

  const mock = await createMock({
    brain: rec.brain,
    extensions,
    sandbox: !!args["sandbox"],
    network: {
      // Default to allow for recording — extensions need real network
      default: (args["network-default"] as string as "allow" | "block") ?? "allow",
      rules,
    },
    cwd: args["cwd"] as string,
    port: args["port"] ? parseInt(args["port"] as string) : 0,
    image: args["image"] as string,
  });

  try {
    console.error(`[pi-mock] Recording with model: ${model}`);
    console.error(`[pi-mock] Prompt: "${message}"`);
    const events = await mock.run(message, timeout);

    const outputPath = resolve(output);
    await rec.save(outputPath);
    console.error(`[pi-mock] Saved ${rec.transcript.turns.length} turns → ${outputPath}`);

    // Also output events to stdout
    console.log(JSON.stringify({
      events,
      transcript: outputPath,
      turns: rec.transcript.turns.length,
    }, null, 2));
  } finally {
    await mock.close();
  }
}

async function cmdRun(argv: string[]) {
  const { args, positional } = parseArgs(argv);
  const message = positional.join(" ");
  if (!message) {
    console.error("Usage: pi-mock run [options] <prompt message>");
    process.exit(1);
  }

  // Load brain
  const brainArg = (args["brain"] as string) ?? "echo";
  const brain = await loadBrain(brainArg);

  const extensions = ((args["extension"] as string[]) ?? []).map((e) => resolve(e));

  const rules: NetworkRule[] = [];
  for (const host of (args["allow"] as string[]) ?? []) {
    rules.push({ match: host, action: "allow" });
  }
  for (const host of (args["block"] as string[]) ?? []) {
    rules.push({ match: host, action: "block" });
  }

  const timeout = args["timeout"] ? parseInt(args["timeout"] as string) : 120_000;

  const mock = await createMock({
    brain,
    extensions,
    sandbox: !!args["sandbox"],
    network: {
      default: (args["network-default"] as string as "allow" | "block") ?? "block",
      rules,
    },
    cwd: args["cwd"] as string,
    port: args["port"] ? parseInt(args["port"] as string) : 0,
    image: args["image"] as string,
  });

  try {
    console.error(`[pi-mock] Running: "${message}"`);
    const events = await mock.run(message, timeout);
    // Output events as JSON to stdout
    console.log(JSON.stringify({ events, requests: mock.requests, proxyLog: mock.proxyLog }, null, 2));
  } finally {
    await mock.close();
  }
}

async function cmdPrompt(argv: string[]) {
  const { args, positional } = parseArgs(argv);
  const stateFile = (args["state"] as string) ?? DEFAULT_STATE_FILE;
  const message = positional.join(" ");

  if (!message) {
    console.error("Usage: pi-mock prompt <message>");
    process.exit(1);
  }

  const state = readState(stateFile);
  const timeout = args["timeout"] ? parseInt(args["timeout"] as string) : undefined;
  const { status, data } = await mgmt(state.port, "POST", "/_/prompt", { message, timeout }, state.token);

  if (status !== 200) {
    console.error(`Error: ${JSON.stringify(data)}`);
    process.exit(1);
  }

  console.log(JSON.stringify(data, null, 2));
}

async function cmdEvents(argv: string[]) {
  const { args } = parseArgs(argv);
  const stateFile = (args["state"] as string) ?? DEFAULT_STATE_FILE;
  const since = args["since"] ? parseInt(args["since"] as string) : 0;
  const state = readState(stateFile);
  const { data } = await mgmt(state.port, "GET", `/_/events?since=${since}`, undefined, state.token);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdRequests(argv: string[]) {
  const { args } = parseArgs(argv);
  const stateFile = (args["state"] as string) ?? DEFAULT_STATE_FILE;
  const state = readState(stateFile);
  const { data } = await mgmt(state.port, "GET", "/_/requests", undefined, state.token);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdProxyLog(argv: string[]) {
  const { args } = parseArgs(argv);
  const stateFile = (args["state"] as string) ?? DEFAULT_STATE_FILE;
  const state = readState(stateFile);
  const { data } = await mgmt(state.port, "GET", "/_/proxy-log", undefined, state.token);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdStatus(argv: string[]) {
  const { args } = parseArgs(argv);
  const stateFile = (args["state"] as string) ?? DEFAULT_STATE_FILE;
  const state = readState(stateFile);
  const { data } = await mgmt(state.port, "GET", "/_/status", undefined, state.token);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdStop(argv: string[]) {
  const { args } = parseArgs(argv);
  const stateFile = (args["state"] as string) ?? DEFAULT_STATE_FILE;
  const state = readState(stateFile);

  try {
    await mgmt(state.port, "POST", "/_/stop", undefined, state.token);
    console.error("[pi-mock] Stopped.");
  } catch {
    console.error("[pi-mock] Session not responding. Cleaning up state file.");
  }

  cleanState(stateFile);
}

function printHelp() {
  console.log(`pi-mock — integration testing harness for pi extensions

Commands:
  start [options]           Start gateway + pi. Stays running.
  record [options] <prompt> Record a real API session → transcript JSON.
  run [options] <prompt>    One-shot: start → prompt → print events → stop.
  prompt <message>          Send a prompt to a running session.
  events                    Print all RPC events as JSON.
  requests                  Print all Anthropic API requests as JSON.
  proxy-log                 Print all proxy activity as JSON.
  status                    Print session status.
  stop                      Graceful shutdown.

Start/Run options:
  --brain <file|echo>       Brain: JS file (default export) or built-in name. Default: echo
  -e, --extension <path>    Extension to load (repeatable).
  --sandbox                 Use Docker container with network isolation.
  --network-default <action> Default network action: allow|block. Default: block
  --allow <host>            Allow network access to host (repeatable).
  --block <host>            Block network access to host (repeatable).
  --port <n>                Gateway port. 0 = random. Default: 0
  --cwd <dir>               Working directory for pi.
  --image <name>            Docker image. Default: auto-build "pi-mock-sandbox"
  --startup-timeout <ms>    Max wait for pi to start. Default: 15000

Record options:
  --model <id>              Real model ID (required). e.g. claude-sonnet-4-20250514
  -o, --output <file>       Transcript output path. Default: session.json
  --api-key <key>           API key (default: from ANTHROPIC_API_KEY / OPENAI_API_KEY)

Other options:
  --state <file>            State file path. Default: /tmp/pi-mock.json
  --timeout <ms>            Prompt/run timeout. Default: 120000
  --since <n>               For events: only show events since index N.

Brain file format (JS or JSON):
  Default-export a function (req, index) => BrainResponse, or an array of BrainResponse.

  // brain.js
  import { bash, text } from "pi-mock";
  export default [bash("ls"), text("done")];

Examples:
  pi-mock start --brain echo -e ./my-ext.ts &
  pi-mock prompt "run ls in the current directory"
  pi-mock events | jq '.events[] | select(.type == "tool_call")'
  pi-mock proxy-log | jq '.log[] | select(.action == "block")'
  pi-mock stop

  pi-mock run --brain ./brain.js -e ./ext.ts "do something"

  # Record a real session, then replay it
  pi-mock record --model claude-sonnet-4-20250514 -e ./ext.ts -o session.json "build a todo app"
  pi-mock run --brain session.json -e ./ext.ts "build a todo app"

  # Hand-write a scenario as JSON
  echo '[{"type":"tool_call","name":"bash","input":{"command":"ls"}}]' > scenario.json
  pi-mock run --brain scenario.json -e ./ext.ts "list files"
`);
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  try {
    switch (command) {
      case "start":
        await cmdStart(rest);
        break;
      case "record":
        await cmdRecord(rest);
        break;
      case "run":
        await cmdRun(rest);
        break;
      case "prompt":
        await cmdPrompt(rest);
        break;
      case "events":
        await cmdEvents(rest);
        break;
      case "requests":
        await cmdRequests(rest);
        break;
      case "proxy-log":
        await cmdProxyLog(rest);
        break;
      case "status":
        await cmdStatus(rest);
        break;
      case "stop":
        await cmdStop(rest);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`[pi-mock] Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
