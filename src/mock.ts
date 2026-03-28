/**
 * pi-mock — integration test harness for pi extensions.
 *
 * Composes gateway + rpc + sandbox into one object.
 * Exposes a management HTTP API (/_/) for CLI control.
 *
 *   createMock() → Mock
 *     - gateway: mock Anthropic API + HTTP/HTTPS proxy
 *     - rpc: JSONL communication with pi
 *     - sandbox: local child process or Docker container
 */

import { type IncomingMessage, type ServerResponse } from "node:http";
import { type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import {
  createGateway,
  type NetworkRule,
  type NetworkAction,
  type ProxyLogEntry,
  type InterceptResponse,
} from "./gateway.js";
import {
  createRpcClient,
  type RpcClient,
  type RpcEvent,
  type UIHandler,
} from "./rpc.js";
import {
  spawnLocal,
  spawnSandbox,
  hasDocker,
} from "./sandbox.js";
import {
  type Brain,
  type ApiRequest,
  type BrainResponse,
  text,
} from "./anthropic.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface MockOptions {
  /** Brain function — you are the model. */
  brain: Brain;
  /** Extension paths to load. */
  extensions?: string[];
  /** Use Docker sandbox for network isolation. Default: false */
  sandbox?: boolean;
  /** Network rules. Only meaningful with sandbox: true for full isolation. */
  network?: {
    default?: NetworkAction;
    rules?: NetworkRule[];
  };
  /** Working directory for pi. */
  cwd?: string;
  /** Path to pi binary (local mode). Default: "pi" */
  piBinary?: string;
  /** Extra pi CLI args. */
  piArgs?: string[];
  /** Extra env vars. */
  env?: Record<string, string>;
  /** Gateway port. 0 = random (recommended). Default: 0 */
  port?: number;
  /** Max wait for pi to start (ms). Default: 15000 */
  startupTimeoutMs?: number;
  /** Default timeout for run() (ms). Default: 120000 */
  runTimeoutMs?: number;
  /** Handler for extension UI dialogs. Default: cancel all. */
  uiHandler?: UIHandler;
  /** Docker image name. Default: auto-build "pi-mock-sandbox" */
  image?: string;
  /** Extra Docker volumes. */
  volumes?: string[];
}

export interface Mock {
  /** Send a prompt, wait for full agent cycle, return events from this cycle. */
  run(message: string, timeoutMs?: number): Promise<RpcEvent[]>;
  /** Send a prompt (fire-and-forget). */
  prompt(message: string): Promise<void>;
  /** Wait for current agent cycle to finish. Returns events since last prompt. */
  drain(timeoutMs?: number): Promise<RpcEvent[]>;
  /** Wait for an event matching a predicate. */
  waitFor(pred: (e: RpcEvent) => boolean, timeoutMs?: number): Promise<RpcEvent>;
  /** Replace the brain mid-test. */
  setBrain(brain: Brain): void;
  /** Update network rules mid-test. */
  setNetworkRules(rules: NetworkRule[], defaultAction?: NetworkAction): void;
  /** All Anthropic API requests the brain saw. */
  readonly requests: ApiRequest[];
  /** Every proxy request (host, action, timestamp). */
  readonly proxyLog: ProxyLogEntry[];
  /** All RPC events from pi. */
  readonly events: RpcEvent[];
  /** Pi's stderr output lines. */
  readonly stderr: string[];
  /** Gateway port. */
  readonly port: number;
  /** Gateway URL (http://127.0.0.1:PORT). */
  readonly url: string;
  /** Shut everything down. */
  close(): Promise<void>;
}

// ─── Startup polling ─────────────────────────────────────────────────

async function waitForReady(rpc: RpcClient, proc: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 50;
  let lastError: string | undefined;

  while (Date.now() < deadline) {
    // Check if process died
    if (proc.exitCode !== null) {
      throw new Error(`pi exited with code ${proc.exitCode} during startup`);
    }

    try {
      const resp = await rpc.send({ type: "get_state" }, 2000);
      if (resp.success) return;
      lastError = resp.error ?? "get_state returned success=false";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 500);
  }

  throw new Error(
    `pi failed to start within ${timeoutMs}ms. Last error: ${lastError ?? "unknown"}`,
  );
}

// ─── Create Mock ─────────────────────────────────────────────────────

export async function createMock(options: MockOptions): Promise<Mock> {
  let closed = false;
  let eventCursor = 0; // tracks start of current cycle for drain()

  // Live network rules — separate from options so /_/intercept can mutate them
  let activeRules: NetworkRule[] = [...(options.network?.rules ?? [])];
  let activeDefault: NetworkAction = options.network?.default ?? "block";

  // Will be set after RPC client is created
  let rpc: RpcClient;

  // ── Management API handler (wired into gateway) ──

  async function onManagement(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, "http://localhost");
    const path = url.pathname;

    res.setHeader("Content-Type", "application/json");

    try {
      // POST /_/prompt — send prompt, wait for agent_end, return cycle events
      if (req.method === "POST" && path === "/_/prompt") {
        const body = await readBody(req);
        const { message, timeout } = JSON.parse(body);
        if (!message) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "missing message" }));
          return;
        }
        const events = await mock.run(message, timeout);
        res.writeHead(200);
        res.end(JSON.stringify({ events }));
        return;
      }

      // GET /_/events — all RPC events (with optional ?since=N)
      if (req.method === "GET" && path === "/_/events") {
        const since = parseInt(url.searchParams.get("since") ?? "0");
        res.writeHead(200);
        res.end(JSON.stringify({ events: rpc.events.slice(since), total: rpc.events.length }));
        return;
      }

      // GET /_/requests — all Anthropic API requests
      if (req.method === "GET" && path === "/_/requests") {
        res.writeHead(200);
        res.end(JSON.stringify({ requests: gw.requests }));
        return;
      }

      // GET /_/proxy-log — all proxy activity
      if (req.method === "GET" && path === "/_/proxy-log") {
        res.writeHead(200);
        res.end(JSON.stringify({ log: gw.proxyLog }));
        return;
      }

      // GET /_/status — current state
      if (req.method === "GET" && path === "/_/status") {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            port: gw.port,
            events: rpc.events.length,
            requests: gw.requests.length,
            proxyHits: gw.proxyLog.length,
            piAlive: proc.exitCode === null,
          }),
        );
        return;
      }

      // POST /_/network — replace all network rules
      if (req.method === "POST" && path === "/_/network") {
        const body = await readBody(req);
        const parsed = JSON.parse(body);
        activeRules = (parsed.rules ?? []).map(
          (r: { match: string; action?: string; response?: InterceptResponse }) => ({
            match: r.match,
            action: r.action,
            response: r.response,
          }),
        );
        if (parsed.default) activeDefault = parsed.default;
        gw.setRules(activeRules, activeDefault);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, rules: activeRules.length }));
        return;
      }

      // POST /_/intercept — add/update/remove an intercept for a host
      // Body: { host, body, status?, headers? } to set, { host, remove: true } to remove
      if (req.method === "POST" && path === "/_/intercept") {
        const body = await readBody(req);
        const { host, remove, ...response } = JSON.parse(body);
        if (!host) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "missing host" }));
          return;
        }

        const idx = activeRules.findIndex(
          (r) => typeof r.match === "string" && r.match === host,
        );

        if (remove) {
          if (idx >= 0) activeRules.splice(idx, 1);
        } else {
          const rule: NetworkRule = {
            match: host,
            action: "intercept" as const,
            response: { status: response.status ?? 200, headers: response.headers, body: response.body ?? "" },
          };
          if (idx >= 0) activeRules[idx] = rule;
          else activeRules.unshift(rule);
        }

        gw.setRules(activeRules, activeDefault);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, rules: activeRules.length }));
        return;
      }

      // GET /_/intercepts — list current intercept rules
      if (req.method === "GET" && path === "/_/intercepts") {
        const intercepts = activeRules
          .filter((r) => r.action === "intercept")
          .map((r) => ({ host: r.match, response: r.response }));
        res.writeHead(200);
        res.end(JSON.stringify({ intercepts }));
        return;
      }

      // POST /_/stop — graceful shutdown
      if (req.method === "POST" && path === "/_/stop") {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        // Shut down after response is sent
        setImmediate(() => mock.close());
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) res.writeHead(500);
      res.end(JSON.stringify({ error: msg }));
      return;
    }

    // Unknown management route
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  }

  // ── 1. Start gateway ──

  const gw = await createGateway({
    brain: options.brain,
    rules: options.network?.rules,
    default: options.network?.default ?? "block",
    port: options.port,
    onManagement,
  });

  // ── 2. Spawn pi ──

  let proc: ChildProcess;
  let stderr: string[];
  let tmpDir: string;

  try {
    const sandboxConfig = {
      gatewayPort: gw.port,
      extensions: options.extensions,
      cwd: options.cwd,
      piArgs: options.piArgs,
      env: options.env,
      piBinary: options.piBinary,
      volumes: options.volumes,
      image: options.image,
    };

    if (options.sandbox) {
      if (!hasDocker()) {
        throw new Error(
          "Docker is required for sandbox mode but is not available. " +
            "Install Docker or use sandbox: false for local mode.",
        );
      }
      ({ process: proc, stderr, tmpDir } = spawnSandbox(sandboxConfig));
    } else {
      ({ process: proc, stderr, tmpDir } = spawnLocal(sandboxConfig));
    }
  } catch (err) {
    await gw.close();
    throw err;
  }

  // ── 3. Attach RPC client ──

  rpc = createRpcClient(proc);
  if (options.uiHandler) rpc.setUIHandler(options.uiHandler);

  // ── 4. Wait for ready ──

  try {
    await waitForReady(rpc, proc, options.startupTimeoutMs ?? 15_000);
  } catch (err) {
    proc.kill();
    await gw.close();
    throw err;
  }

  // ── 5. Cleanup hooks ──

  function cleanup() {
    if (closed) return;
    closed = true;
    try {
      proc.kill();
    } catch {
      /* already dead */
    }
  }

  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // ── 6. Public API ──

  const defaultRunTimeout = options.runTimeoutMs ?? 120_000;

  const mock: Mock = {
    get requests() {
      return gw.requests;
    },
    get proxyLog() {
      return gw.proxyLog;
    },
    get events() {
      return rpc.events;
    },
    stderr,
    get port() {
      return gw.port;
    },
    get url() {
      return gw.url;
    },

    setBrain(b) {
      gw.setBrain(b);
    },
    setNetworkRules(r, d) {
      gw.setRules(r, d);
    },

    async prompt(message) {
      eventCursor = rpc.events.length;
      const resp = await rpc.send({ type: "prompt", message });
      if (!resp.success) {
        throw new Error(`Prompt rejected: ${resp.error ?? "unknown"}`);
      }
    },

    async drain(timeoutMs = defaultRunTimeout) {
      const start = eventCursor;
      await rpc.waitFor(
        (e) => e.type === "agent_end" && rpc.events.indexOf(e) >= start,
        timeoutMs,
      );
      return rpc.events.slice(start);
    },

    async run(message, timeoutMs = defaultRunTimeout) {
      const start = rpc.events.length;
      eventCursor = start;
      await this.prompt(message);
      await rpc.waitFor(
        (e) => e.type === "agent_end" && rpc.events.indexOf(e) >= start,
        timeoutMs,
      );
      return rpc.events.slice(start);
    },

    waitFor(pred, timeoutMs) {
      return rpc.waitFor(pred, timeoutMs);
    },

    async close() {
      if (closed) return;
      closed = true;
      process.removeListener("exit", cleanup);
      process.removeListener("SIGINT", cleanup);
      process.removeListener("SIGTERM", cleanup);

      // Kill pi process
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already dead */
      }

      // Wait briefly for graceful exit, then force kill
      await Promise.race([
        new Promise<void>((resolve) => {
          if (proc.exitCode !== null) return resolve();
          proc.on("exit", () => resolve());
        }),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {
              /* already dead */
            }
            resolve();
          }, 3000);
        }),
      ]);

      // Close gateway (force-closes all sockets)
      await gw.close();

      // Clean up temp agent dir
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };

  return mock;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// ─── Brain helpers ───────────────────────────────────────────────────

/** Brain that returns responses in order, then a default. */
export function script(...responses: BrainResponse[]): Brain {
  let i = 0;
  return () => (i < responses.length ? responses[i++] : text("(script exhausted)"));
}

/** Brain that repeats the same response forever. */
export function always(response: BrainResponse): Brain {
  return () => response;
}

/** Default brain — always responds with a simple text message. */
export function echo(): Brain {
  return (req) => {
    const lastMsg = req.messages?.[req.messages.length - 1];
    const content =
      typeof lastMsg?.content === "string"
        ? lastMsg.content
        : JSON.stringify(lastMsg?.content ?? "no message");
    return text(`Echo: ${content}`);
  };
}
