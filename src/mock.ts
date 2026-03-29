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
  type RpcResponse,
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
  /**
   * Steer the agent mid-turn — message is delivered after the current tool call completes.
   * Use this to test extensions like pi-manager that inject guidance during active turns.
   */
  steer(message: string): Promise<void>;
  /**
   * Queue a follow-up message — delivered after the agent finishes current work.
   * Triggers a new agent turn with this message. Use to test multi-turn extension flows.
   */
  followUp(message: string): Promise<void>;
  /**
   * Abort the current agent turn. The agent stops what it's doing and emits agent_end.
   */
  abort(): Promise<void>;
  /**
   * Send a raw RPC command to pi. Escape hatch for any RPC command pi supports
   * (get_session_stats, set_auto_retry, set_model, etc.)
   */
  sendRpc(command: Record<string, unknown>, timeoutMs?: number): Promise<RpcResponse>;
  /** Replace the brain mid-test. */
  setBrain(brain: Brain): void;
  /** Update network rules mid-test. */
  setNetworkRules(rules: NetworkRule[], defaultAction?: NetworkAction): void;
  /** All API requests the brain saw (all providers). */
  readonly requests: ApiRequest[];
  /** Every proxy request (host, action, timestamp). */
  readonly proxyLog: ProxyLogEntry[];
  /** Wait for the next brain request. Resolves with the request + index. */
  waitForRequest(pred?: (req: ApiRequest, index: number) => boolean, timeoutMs?: number): Promise<{ request: ApiRequest; index: number }>;
  /** All RPC events from pi. */
  readonly events: RpcEvent[];
  /** Pi's stderr output lines. */
  readonly stderr: string[];
  /** Gateway port. */
  readonly port: number;
  /** Gateway URL (http://127.0.0.1:PORT). */
  readonly url: string;
  /** Management API auth token. Required as x-pi-mock-token header or ?token= param. */
  readonly token: string;
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

  // Management API auth token — prevents sandbox from calling /_/ endpoints
  const { randomUUID } = await import("node:crypto");
  const mgmtToken = randomUUID();

  // Will be set after RPC client is created
  let rpc: RpcClient;

  // ── Management API handler (wired into gateway) ──

  async function onManagement(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, "http://localhost");
    const path = url.pathname;

    res.setHeader("Content-Type", "application/json");

    // Auth check — reject requests without the token
    const authHeader = req.headers["x-pi-mock-token"] ?? url.searchParams.get("token");
    if (authHeader !== mgmtToken) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }

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
    get token() {
      return mgmtToken;
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

    async steer(message) {
      const resp = await rpc.send({ type: "steer", message });
      if (!resp.success) {
        throw new Error(`Steer rejected: ${resp.error ?? "unknown"}`);
      }
    },

    async followUp(message) {
      const resp = await rpc.send({ type: "follow_up", message });
      if (!resp.success) {
        throw new Error(`Follow-up rejected: ${resp.error ?? "unknown"}`);
      }
    },

    async abort() {
      const resp = await rpc.send({ type: "abort" });
      if (!resp.success) {
        throw new Error(`Abort rejected: ${resp.error ?? "unknown"}`);
      }
    },

    sendRpc(command, timeoutMs) {
      return rpc.send(command, timeoutMs);
    },

    async drain(timeoutMs = defaultRunTimeout) {
      const start = eventCursor;
      let scanFrom = start;
      while (true) {
        const agentEnd = await rpc.waitFor(
          (e) => e.type === "agent_end",
          timeoutMs,
          scanFrom,
        );
        const messages = (agentEnd as Record<string, unknown>).messages as Array<Record<string, unknown>> | undefined;
        const lastAssistant = messages ? [...messages].reverse().find((m: Record<string, unknown>) => m.role === "assistant") : undefined;
        if (!lastAssistant || lastAssistant.stopReason !== "error") break;
        const retryStarted = await rpc
          .waitFor((e) => e.type === "auto_retry_start", 500, scanFrom)
          .then(() => true)
          .catch(() => false);
        if (!retryStarted) break;
        scanFrom = rpc.events.length;
      }
      return rpc.events.slice(start);
    },

    async run(message, timeoutMs = defaultRunTimeout) {
      const start = rpc.events.length;
      eventCursor = start;
      await this.prompt(message);

      // Wait for agent_end, handling pi's auto-retry loop.
      // Pi emits agent_end → (async) auto_retry_start → delay → agent_start → ... → agent_end.
      // We need to keep waiting through retry cycles until we get a final agent_end.
      let scanFrom = start;
      while (true) {
        const agentEnd = await rpc.waitFor(
          (e) => e.type === "agent_end",
          timeoutMs,
          scanFrom,
        );

        // Check if pi might retry: only if the last assistant message was an error.
        // Successful runs (stopReason: "stop" or "toolUse") return instantly — no grace wait.
        const messages = (agentEnd as Record<string, unknown>).messages as Array<Record<string, unknown>> | undefined;
        const lastAssistant = messages ? [...messages].reverse().find((m: Record<string, unknown>) => m.role === "assistant") : undefined;
        if (!lastAssistant || lastAssistant.stopReason !== "error") break;

        // Error path: pi's retry logic runs asynchronously after agent_end.
        // Scan from BEFORE the agent_end event to catch auto_retry_start that
        // arrived in the same stdout chunk (fixes same-tick race condition).
        const retryStarted = await rpc
          .waitFor((e) => e.type === "auto_retry_start", 500, scanFrom)
          .then(() => true)
          .catch(() => false);

        if (!retryStarted) break; // Error but no retry (disabled or max reached)

        // Retry started — update scanFrom to find the NEXT agent_end
        scanFrom = rpc.events.length;
      }

      return rpc.events.slice(start);
    },

    waitFor(pred, timeoutMs) {
      return rpc.waitFor(pred, timeoutMs);
    },

    waitForRequest(pred, timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        // Scan existing requests first — same pattern as rpc.waitFor().
        // Without this, requests that arrived before waitForRequest() is called are missed.
        for (let i = 0; i < gw.requests.length; i++) {
          if (!pred || pred(gw.requests[i], i)) {
            return resolve({ request: gw.requests[i], index: i });
          }
        }

        const timer = setTimeout(() => {
          unsub();
          reject(new Error(`waitForRequest timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        const unsub = gw.onRequest((req, index) => {
          if (!pred || pred(req, index)) {
            clearTimeout(timer);
            unsub();
            resolve({ request: req, index });
          }
        });
      });
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

// ─── Controllable brain ──────────────────────────────────────────────

export interface PendingCall {
  /** The API request pi sent. */
  request: ApiRequest;
  /** Which call this is (0-indexed). */
  index: number;
  /** Release the brain with this response. */
  respond(response: BrainResponse): void;
}

/** Filter predicate for waitForCall. */
export type CallFilter = (request: ApiRequest, index: number) => boolean;

export interface ControllableBrain {
  /** The brain function — pass this to createMock({ brain: cb.brain }). */
  brain: Brain;

  /** Wait for the next brain call. Blocks until pi makes an API request. */
  waitForCall(timeoutMs?: number): Promise<PendingCall>;

  /**
   * Wait for a brain call matching a filter. Non-matching calls stay
   * buffered for other waiters — no head-of-line blocking.
   *
   * ```typescript
   * // Filter by model name
   * const call = await cb.waitForCall({ model: "gpt-4" }, 3000);
   *
   * // Filter by predicate
   * const call = await cb.waitForCall(req => req.model.includes("claude"), 3000);
   * ```
   */
  waitForCall(filter: CallFilter | { model?: string; _provider?: string }, timeoutMs?: number): Promise<PendingCall>;

  /** Snapshot of pending (buffered, unresponded) calls. Useful for debugging. */
  pending(): PendingCall[];
}

/**
 * Create a brain where each call blocks until you explicitly respond.
 * Gives tests full control over timing and interleaving.
 *
 * Supports filtered waiting — when multiple clients hit the brain
 * concurrently, you can wait for a specific one by model name or
 * custom predicate. Non-matching calls stay buffered for other waiters.
 *
 * ```typescript
 * const cb = createControllableBrain();
 * const mock = await createMock({ brain: cb.brain, ... });
 * await mock.prompt("do something");
 * const call = await cb.waitForCall();
 * console.log(call.request.messages); // inspect what pi sent
 * call.respond(text("hello"));        // release the brain
 *
 * // Filtered — wait for a specific model
 * const gptCall = await cb.waitForCall({ model: "gpt-4" }, 3000);
 * const claudeCall = await cb.waitForCall(req => req.model.includes("claude"), 3000);
 * ```
 */
export function createControllableBrain(): ControllableBrain {
  type Entry = {
    request: ApiRequest;
    index: number;
    resolve: (response: BrainResponse) => void;
  };

  type Waiter = {
    filter: CallFilter | null;
    resolve: (call: PendingCall) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };

  // Queue of calls waiting for a response
  const pending: Entry[] = [];

  // Queue of waiters waiting for a call
  const waiters: Waiter[] = [];

  function wrap(entry: Entry): PendingCall {
    return {
      request: entry.request,
      index: entry.index,
      respond: (response: BrainResponse) => entry.resolve(response),
    };
  }

  /** Normalize a filter arg into a predicate or null (match-all). */
  function normalizeFilter(
    filter: CallFilter | { model?: string; _provider?: string } | null | undefined,
  ): CallFilter | null {
    if (!filter) return null;
    if (typeof filter === "function") return filter;
    // Object shorthand: { model?, _provider? }
    return (req: ApiRequest) => {
      if (filter.model !== undefined && req.model !== filter.model) return false;
      if (filter._provider !== undefined && req._provider !== filter._provider) return false;
      return true;
    };
  }

  const brain: Brain = (request, index) => {
    return new Promise<BrainResponse>((resolve) => {
      const entry: Entry = { request, index, resolve };

      // Try to deliver to the first matching waiter
      for (let i = 0; i < waiters.length; i++) {
        const w = waiters[i];
        if (!w.filter || w.filter(request, index)) {
          waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(wrap(entry));
          return;
        }
      }

      // No matching waiter — buffer the call
      pending.push(entry);
    });
  };

  return {
    brain,

    waitForCall(
      filterOrTimeout?: number | CallFilter | { model?: string; _provider?: string },
      timeoutMs?: number,
    ): Promise<PendingCall> {
      // Overload resolution: waitForCall(3000) vs waitForCall(filter, 3000)
      let filter: CallFilter | null;
      let timeout: number;
      if (typeof filterOrTimeout === "number" || filterOrTimeout === undefined) {
        filter = null;
        timeout = filterOrTimeout ?? 30_000;
      } else {
        filter = normalizeFilter(filterOrTimeout);
        timeout = timeoutMs ?? 30_000;
      }

      return new Promise<PendingCall>((resolve, reject) => {
        // Scan pending for the first matching call
        for (let i = 0; i < pending.length; i++) {
          const entry = pending[i];
          if (!filter || filter(entry.request, entry.index)) {
            pending.splice(i, 1);
            return resolve(wrap(entry));
          }
        }

        // No match yet — register a filtered waiter
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === resolve);
          if (idx >= 0) waiters.splice(idx, 1);
          const desc = filter ? " (with filter)" : "";
          reject(new Error(`waitForCall timeout after ${timeout}ms${desc}`));
        }, timeout);

        waiters.push({ filter, resolve, reject, timer });
      });
    },

    pending(): PendingCall[] {
      return pending.map(wrap);
    },
  };
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
