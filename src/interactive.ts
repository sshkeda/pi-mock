/**
 * Interactive mode testing — drive pi's terminal UI programmatically.
 *
 * Spawns pi in its default interactive mode (no --mode rpc) using a
 * pseudo-terminal, so pi renders its full terminal UI. Tests can type
 * input, send key sequences, and wait for output patterns.
 *
 * Requires `node-pty` (optional peer dependency):
 *   npm install --save-dev node-pty
 *
 * Uses the same gateway/brain infrastructure as the regular mock,
 * so you get full control over API responses and network behavior.
 *
 * Exposes a management HTTP API on the gateway (/_/ prefix) for
 * driving the interactive session over HTTP, matching the pattern
 * used by the regular mock.
 */

import { type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdtempSync, writeFileSync, rmSync, accessSync, chmodSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import {
  createGateway,
  type Gateway,
  type NetworkRule,
  type NetworkAction,
  type ProxyLogEntry,
} from "./gateway.js";
import { type Brain, type ApiRequest } from "./anthropic.js";
import { readProcessStats, type ProcessStats } from "./process-stats.js";

// ─── Key sequences ──────────────────────────────────────────────────

export type KeyName =
  | "enter"
  | "return"
  | "tab"
  | "escape"
  | "backspace"
  | "delete"
  | "up"
  | "down"
  | "left"
  | "right"
  | "ctrl+a"
  | "ctrl+b"
  | "ctrl+c"
  | "ctrl+d"
  | "ctrl+e"
  | "ctrl+f"
  | "ctrl+g"
  | "ctrl+l"
  | "ctrl+n"
  | "ctrl+o"
  | "ctrl+p"
  | "ctrl+r"
  | "ctrl+s"
  | "ctrl+t"
  | "ctrl+u"
  | "ctrl+w";

const KEY_MAP: Record<KeyName, string> = {
  enter: "\r",
  return: "\r",
  tab: "\t",
  escape: "\x1b",
  backspace: "\x7f",
  delete: "\x1b[3~",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  "ctrl+a": "\x01",
  "ctrl+b": "\x02",
  "ctrl+c": "\x03",
  "ctrl+d": "\x04",
  "ctrl+e": "\x05",
  "ctrl+f": "\x06",
  "ctrl+g": "\x07",
  "ctrl+l": "\x0c",
  "ctrl+n": "\x0e",
  "ctrl+o": "\x0f",
  "ctrl+p": "\x10",
  "ctrl+r": "\x12",
  "ctrl+s": "\x13",
  "ctrl+t": "\x14",
  "ctrl+u": "\x15",
  "ctrl+w": "\x17",
};

/** Widened lookup for untyped HTTP API input. */
const KEY_LOOKUP = new Map(Object.entries(KEY_MAP));

// Structural type describing the minimal shape of @xterm/headless we rely on —
// avoids a hard TS dependency on a package that callers opt into.
interface TerminalLike {
  write(data: string, cb?: () => void): void;
  buffer: {
    active: {
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
}

// ─── Options ────────────────────────────────────────────────────────

export interface InteractiveMockOptions {
  /** Brain function — you are the model. */
  brain: Brain;
  /** Extension paths to load. */
  extensions?: string[];
  /** Provider pi should use when talking to the gateway. Default: "pi-mock" */
  piProvider?: string;
  /** Model pi should use when talking to the gateway. Default: "mock" */
  piModel?: string;
  /** Network rules. */
  network?: {
    default?: NetworkAction;
    rules?: NetworkRule[];
  };
  /** Working directory for pi. */
  cwd?: string;
  /** Path to pi binary. Default: "pi" */
  piBinary?: string;
  /** Extra pi CLI args (e.g. ["--verbose"]). */
  piArgs?: string[];
  /** Extra env vars. */
  env?: Record<string, string>;
  /** Gateway port. 0 = random (recommended). Default: 0 */
  port?: number;
  /** Max wait for pi to become ready (ms). Default: 15000 */
  startupTimeoutMs?: number;
  /** Gateway bind address. Default: "127.0.0.1" */
  gatewayHost?: string;
  /**
   * Terminal dimensions. Default: { cols: 120, rows: 40 }
   */
  terminal?: { cols?: number; rows?: number };
  /**
   * Pattern that indicates pi has started and is ready for input.
   * Matched against ANSI-stripped terminal output.
   * Default: /\d+\.\d+%\/\d+(\.\d+)?[kKmM]/ (matches pi's status bar, e.g. "0.0%/128k" or "0.0%/1.0M")
   */
  readyPattern?: string | RegExp;
}

// ─── InteractiveMock ────────────────────────────────────────────────

export interface InteractiveMock {
  /** Type raw text into pi's terminal stdin. */
  type(input: string): void;
  /** Type a message and press Enter (convenience for type + enter). */
  submit(message: string): void;
  /** Send a named key sequence. */
  sendKey(key: KeyName): void;
  /**
   * Wait for terminal output matching a pattern.
   * Strings are matched literally; RegExps are matched as-is.
   * Matches against ANSI-stripped output accumulated since creation or last clearOutput().
   * Returns the matched text.
   */
  waitForOutput(pattern: string | RegExp, timeoutMs?: number): Promise<string>;
  /** All terminal output accumulated so far (ANSI-stripped). */
  readonly output: string;
  /** Raw terminal output including ANSI escape sequences. */
  readonly rawOutput: string;
  /** Clear the output buffer (useful between interaction phases). */
  clearOutput(): void;
  /** Resize the terminal mid-test. */
  resize(cols: number, rows: number): void;
  /**
   * Render the current raw terminal output through a headless xterm and
   * return the visible screen as an array of lines (ANSI stripped). Useful
   * for asserting what the user actually SEES (after cursor positioning,
   * line overwriting, alternate screen, etc.), rather than the full scroll
   * history. Requires `@xterm/headless` as a peer dep.
   */
  visibleScreen(): Promise<string[]>;

  /** Replace the brain mid-test. */
  setBrain(brain: Brain): void;
  /** Update network rules mid-test. */
  setNetworkRules(rules: NetworkRule[], defaultAction?: NetworkAction): void;
  /** All API requests the brain saw. */
  readonly requests: ApiRequest[];
  /** Wait for the next brain request matching an optional predicate. */
  waitForRequest(
    pred?: (req: ApiRequest, index: number) => boolean,
    timeoutMs?: number,
  ): Promise<{ request: ApiRequest; index: number }>;
  /** Proxy log entries. */
  readonly proxyLog: ProxyLogEntry[];
  /** Gateway port. */
  readonly port: number;
  /** Gateway URL (http://127.0.0.1:PORT). */
  readonly url: string;
  /** Management API auth token. Required as x-pi-mock-token header or ?token= param. */
  readonly token: string;
  /**
   * Snapshot the pi process's resource usage (RSS memory, CPU time).
   * Returns null if the process has already exited.
   */
  getProcessStats(): ProcessStats | null;
  /** Shut down pi and the gateway. */
  close(): Promise<void>;
}

// ─── Agent dir setup ────────────────────────────────────────────────

function createAgentDir(gatewayUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-mock-interactive-"));

  const modelsJson = {
    providers: {
      "pi-mock": {
        baseUrl: `${gatewayUrl}/v1`,
        api: "anthropic-messages",
        apiKey: "mock-key",
        models: [{ id: "mock", name: "pi-mock" }],
      },
      anthropic: { baseUrl: `${gatewayUrl}/v1`, apiKey: "mock-key" },
      openai: { baseUrl: `${gatewayUrl}/v1`, apiKey: "mock-key" },
      google: { baseUrl: `${gatewayUrl}/v1beta`, apiKey: "mock-key" },
      groq: { baseUrl: `${gatewayUrl}/v1`, apiKey: "mock-key" },
      xai: { baseUrl: `${gatewayUrl}/v1`, apiKey: "mock-key" },
      openrouter: { baseUrl: `${gatewayUrl}/v1`, apiKey: "mock-key" },
      mistral: { baseUrl: `${gatewayUrl}/v1`, apiKey: "mock-key" },
      cerebras: { baseUrl: `${gatewayUrl}/v1`, apiKey: "mock-key" },
    },
  };
  writeFileSync(join(dir, "models.json"), JSON.stringify(modelsJson, null, 2));

  const settingsJson = {
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 100 },
  };
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settingsJson, null, 2));

  return dir;
}

// ─── Helper extension path ──────────────────────────────────────────

function getHelperExtensionPath(): string {
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), "test-helper-extension.ts"),
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "test-helper-extension.ts"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

// ─── ANSI / terminal sequence stripping ─────────────────────────────

function stripAnsi(str: string): string {
  return (
    str
      // OSC sequences: ESC ] ... BEL  or  ESC ] ... ST
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
      // CSI sequences: ESC [ (params) (final byte)
      .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, "")
      // ESC followed by single character (charset, mode set, etc.)
      .replace(/\x1b[^\x1b[(\]]/g, "")
      // Remaining control characters (except \n, \r, \t)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
  );
}

// ─── Regex escaping ─────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Pattern parsing (for management API) ───────────────────────────

/** Parse a string as literal text or /regex/flags. */
function parsePattern(raw: string): string | RegExp {
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(raw);
  if (m && m[1]) return new RegExp(m[1], m[2] ?? "");
  return raw;
}

// ─── HTTP body reader ───────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// ─── Dynamic node-pty loader ────────────────────────────────────────

/**
 * node-pty ships a `spawn-helper` binary in its prebuilds, but the
 * npm tarball sometimes drops the execute bit (known packaging bug).
 * Without +x, posix_spawnp fails silently. We detect and fix this
 * at load time so users never have to debug it.
 */
function fixSpawnHelperPermissions(): void {
  try {
    // Resolve node-pty's install dir via import.meta.resolve (ESM-compatible).
    // import.meta.resolve returns a file:// URL string.
    const ptyPkgUrl = import.meta.resolve("node-pty/package.json");
    const ptyDir = dirname(fileURLToPath(ptyPkgUrl));
    const helper = join(
      ptyDir,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    try {
      accessSync(helper, constants.X_OK);
    } catch {
      chmodSync(helper, 0o755);
    }
  } catch {
    // Best effort — if the helper doesn't exist (Windows, or build/ layout), skip.
  }
}

async function loadPtySpawn(): Promise<typeof import("node-pty").spawn> {
  try {
    fixSpawnHelperPermissions();
    const mod = await import("node-pty");
    return mod.spawn;
  } catch {
    throw new Error(
      "Interactive mode requires the 'node-pty' package.\n" +
        "Install it with: npm install --save-dev node-pty\n\n" +
        "node-pty allocates a pseudo-terminal so pi renders its full\n" +
        "interactive UI, enabling realistic end-to-end testing.",
    );
  }
}

// ─── Create ─────────────────────────────────────────────────────────

export async function createInteractiveMock(
  options: InteractiveMockOptions,
): Promise<InteractiveMock> {
  if (options.piProvider && options.piProvider !== "pi-mock" && !options.piModel) {
    throw new Error("createInteractiveMock(): piModel is required when piProvider is not \"pi-mock\".");
  }

  const ptySpawn = await loadPtySpawn();

  let closed = false;
  let requestCursor = 0;
  const cols = options.terminal?.cols ?? 120;
  const rows = options.terminal?.rows ?? 40;
  const mgmtToken = randomUUID();

  // Mutable output buffer — shared between PTY listener, public API, and management handler
  let outputBuf = "";
  const outputListeners = new Set<() => void>();
  let exited = false;

  // ── Pattern matching helper (defined early so management handler can use it) ──

  function waitForPattern(
    pattern: string | RegExp,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const re =
        typeof pattern === "string"
          ? new RegExp(escapeRegex(pattern))
          : pattern;

      const clean = stripAnsi(outputBuf);
      const existing = re.exec(clean);
      if (existing) return resolve(existing[0]);

      if (exited) {
        return reject(
          new Error(
            `pi exited before output matched. Pattern: ${String(pattern)}\n` +
              `Output: ${stripAnsi(outputBuf).slice(-500)}`,
          ),
        );
      }

      const timer = setTimeout(() => {
        outputListeners.delete(check);
        reject(
          new Error(
            `waitForOutput timeout after ${timeoutMs}ms. ` +
              `Pattern: ${String(pattern)}\n` +
              `Recent output:\n${stripAnsi(outputBuf).slice(-500)}`,
          ),
        );
      }, timeoutMs);

      function check() {
        if (exited) {
          clearTimeout(timer);
          outputListeners.delete(check);
          reject(
            new Error(
              `pi exited before output matched. Pattern: ${String(pattern)}\n` +
                `Output: ${stripAnsi(outputBuf).slice(-500)}`,
            ),
          );
          return;
        }

        const clean = stripAnsi(outputBuf);
        const match = re.exec(clean);
        if (match) {
          clearTimeout(timer);
          outputListeners.delete(check);
          resolve(match[0]);
        }
      }

      outputListeners.add(check);
    });
  }

  // Forward-declared so management handler can reference it
  let gw: Gateway;
  let pty: IPty;

  // ── Management API handler ──

  async function onManagement(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, "http://localhost");
    const path = url.pathname;

    res.setHeader("Content-Type", "application/json");

    // Auth check
    const authHeader =
      req.headers["x-pi-mock-token"] ?? url.searchParams.get("token");
    if (authHeader !== mgmtToken) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }

    try {
      // POST /_/type — type raw text
      if (req.method === "POST" && path === "/_/type") {
        const body = await readBody(req);
        const parsed = JSON.parse(body);
        if (!parsed.text) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "missing text" }));
          return;
        }
        pty.write(parsed.text);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /_/submit — type message + enter, optionally wait for output
      if (req.method === "POST" && path === "/_/submit") {
        const body = await readBody(req);
        const parsed = JSON.parse(body);
        if (!parsed.message) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "missing message" }));
          return;
        }
        pty.write(parsed.message + "\r");
        if (parsed.waitFor) {
          const timeout =
            typeof parsed.timeout === "number" ? parsed.timeout : 30_000;
          const matched = await waitForPattern(
            parsePattern(parsed.waitFor),
            timeout,
          );
          res.writeHead(200);
          res.end(JSON.stringify({ matched }));
        } else {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        }
        return;
      }

      // POST /_/send-key — send a named key sequence
      if (req.method === "POST" && path === "/_/send-key") {
        const body = await readBody(req);
        const parsed = JSON.parse(body);
        const seq = KEY_LOOKUP.get(String(parsed.key));
        if (!seq) {
          res.writeHead(400);
          res.end(
            JSON.stringify({
              error: `unknown key: ${parsed.key}`,
              validKeys: Object.keys(KEY_MAP),
            }),
          );
          return;
        }
        pty.write(seq);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // GET /_/output — ANSI-stripped terminal output
      if (req.method === "GET" && path === "/_/output") {
        const stripped = stripAnsi(outputBuf);
        res.writeHead(200);
        res.end(JSON.stringify({ output: stripped, length: stripped.length }));
        return;
      }

      // GET /_/raw-output — raw terminal output with ANSI codes
      if (req.method === "GET" && path === "/_/raw-output") {
        res.writeHead(200);
        res.end(
          JSON.stringify({ output: outputBuf, length: outputBuf.length }),
        );
        return;
      }

      // POST /_/clear-output — clear the output buffer
      if (req.method === "POST" && path === "/_/clear-output") {
        outputBuf = "";
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /_/wait-for-output — wait for a pattern in terminal output
      if (req.method === "POST" && path === "/_/wait-for-output") {
        const body = await readBody(req);
        const parsed = JSON.parse(body);
        if (!parsed.pattern) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "missing pattern" }));
          return;
        }
        const timeout =
          typeof parsed.timeout === "number" ? parsed.timeout : 30_000;
        const matched = await waitForPattern(
          parsePattern(parsed.pattern),
          timeout,
        );
        res.writeHead(200);
        res.end(JSON.stringify({ matched }));
        return;
      }

      // POST /_/resize — resize the terminal
      if (req.method === "POST" && path === "/_/resize") {
        const body = await readBody(req);
        const parsed = JSON.parse(body);
        if (typeof parsed.cols !== "number" || typeof parsed.rows !== "number") {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "cols and rows must be numbers" }));
          return;
        }
        pty.resize(parsed.cols, parsed.rows);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // GET /_/requests — all API requests
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

      // GET /_/status — current session status
      if (req.method === "GET" && path === "/_/status") {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            port: gw.port,
            mode: "interactive",
            requests: gw.requests.length,
            proxyHits: gw.proxyLog.length,
            outputLength: outputBuf.length,
            exited,
          }),
        );
        return;
      }

      // POST /_/stop — graceful shutdown
      if (req.method === "POST" && path === "/_/stop") {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        setImmediate(() => mock.close());
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) res.writeHead(500);
      res.end(JSON.stringify({ error: msg }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  }

  // ── 1. Start gateway ──

  gw = await createGateway({
    brain: options.brain,
    rules: options.network?.rules,
    default: options.network?.default ?? "block",
    port: options.port,
    host: options.gatewayHost ?? "127.0.0.1",
    onManagement,
  });

  // ── 2. Create agent dir with models.json ──

  const tmpDir = createAgentDir(gw.url);

  // ── 3. Build pi args (NO --mode rpc — interactive mode) ──

  const provider = options.piProvider ?? "pi-mock";
  const model = options.piModel ?? "mock";

  const args: string[] = [
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--provider",
    provider,
    "--model",
    model,
    ...(options.piArgs ?? []),
  ];

  args.push("-e", getHelperExtensionPath());
  for (const ext of options.extensions ?? []) {
    args.push("-e", resolve(ext));
  }

  // ── 4. Build environment ──

  const gwPort = gw.port;
  const proxyUrl = `http://127.0.0.1:${gwPort}`;
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    PI_CODING_AGENT_DIR: tmpDir,
    PI_OFFLINE: "1",
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    ALL_PROXY: proxyUrl,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    ...(options.env ?? {}),
  };

  // ── 5. Spawn pi with PTY ──

  const piBinary = options.piBinary ?? "pi";
  try {
    pty = ptySpawn(piBinary, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: options.cwd ?? process.cwd(),
      env,
    });
  } catch (err) {
    await gw.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }

  // ── 6. Wire output capture ──

  pty.onData((data) => {
    outputBuf += data;
    for (const l of outputListeners) l();
  });

  pty.onExit(() => {
    exited = true;
    for (const l of outputListeners) l();
  });

  // ── 7. Wait for pi to be ready ──

  const readyPattern = options.readyPattern ?? /\d+\.\d+%\/\d+(\.\d+)?[kKmM]/;
  const startupTimeout = options.startupTimeoutMs ?? 15_000;

  try {
    await waitForPattern(readyPattern, startupTimeout);
  } catch {
    pty.kill();
    await gw.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    throw new Error(
      `pi did not become ready within ${startupTimeout}ms.\n` +
        `Terminal output:\n${stripAnsi(outputBuf).slice(-500)}\n\n` +
        "Ensure pi is installed: npm install -g @mariozechner/pi-coding-agent\n" +
        "Or adjust readyPattern / startupTimeoutMs options.",
    );
  }

  // ── 8. Cleanup hooks ──

  function cleanup() {
    if (closed) return;
    closed = true;
    try {
      pty.kill();
    } catch {
      /* already dead */
    }
    gw.close().catch(() => {});
  }

  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // ── 9. Public API ──

  const mock: InteractiveMock = {
    type(input) {
      pty.write(input);
    },

    submit(message) {
      pty.write(message + "\r");
    },

    sendKey(key) {
      const seq = KEY_MAP[key];
      pty.write(seq);
    },

    waitForOutput(pattern, timeoutMs = 30_000) {
      return waitForPattern(pattern, timeoutMs);
    },

    get output() {
      return stripAnsi(outputBuf);
    },

    get rawOutput() {
      return outputBuf;
    },

    clearOutput() {
      outputBuf = "";
    },

    resize(c, r) {
      pty.resize(c, r);
    },

    async visibleScreen() {
      let headless: unknown;
      try {
        // Resolve optional peers from the caller's cwd first. This matters when
        // pi-mock is consumed via `file:../pi-mock`: Node resolves a bare dynamic
        // import from pi-mock's real path, not the consumer's node_modules.
        const req = createRequire(join(process.cwd(), "package.json"));
        const resolved = req.resolve("@xterm/headless");
        headless = await import(pathToFileURL(resolved).href);
      } catch {
        try {
          // @ts-expect-error — optional peer dep; typed structurally via TerminalLike below.
          headless = await import("@xterm/headless");
        } catch {
          throw new Error(
            "visibleScreen() requires the '@xterm/headless' peer dependency.\n" +
              "Install it with: npm install --save-dev @xterm/headless",
          );
        }
      }
      if (!headless || typeof headless !== "object") {
        throw new Error("@xterm/headless did not export a module object");
      }
      const mod = headless as Record<string, unknown>;
      const fromDefault = mod.default && typeof mod.default === "object" ? (mod.default as Record<string, unknown>) : undefined;
      const TerminalCtor = (mod.Terminal ?? fromDefault?.Terminal) as undefined | (new (opts: Record<string, unknown>) => TerminalLike);
      if (typeof TerminalCtor !== "function") throw new Error("@xterm/headless did not export a Terminal class");
      const term = new TerminalCtor({ cols, rows, allowProposedApi: true });
      await new Promise<void>((resolve) => term.write(outputBuf, resolve));
      const lines: string[] = [];
      for (let i = 0; i < rows; i++) {
        lines.push(term.buffer.active.getLine(i)?.translateToString(true) ?? "");
      }
      return lines;
    },

    setBrain(b) {
      gw.setBrain(b);
    },

    setNetworkRules(r, d) {
      gw.setRules(r, d);
    },

    get requests() {
      return gw.requests;
    },

    waitForRequest(pred, timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        for (let i = requestCursor; i < gw.requests.length; i++) {
          if (!pred || pred(gw.requests[i], i)) {
            requestCursor = i + 1;
            return resolve({ request: gw.requests[i], index: i });
          }
        }

        const timer = setTimeout(() => {
          unsub();
          reject(new Error(`waitForRequest timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        const unsub = gw.onRequest((req, index) => {
          if (!pred || pred(req, index)) {
            requestCursor = index + 1;
            clearTimeout(timer);
            unsub();
            resolve({ request: req, index });
          }
        });
      });
    },

    get proxyLog() {
      return gw.proxyLog;
    },

    get port() {
      return gw.port;
    },

    get url() {
      return gw.url;
    },

    get token() {
      return mgmtToken;
    },

    getProcessStats() {
      if (exited || !pty.pid) return null;
      return readProcessStats(pty.pid);
    },

    async close() {
      if (closed) return;
      closed = true;
      process.removeListener("exit", cleanup);
      process.removeListener("SIGINT", cleanup);
      process.removeListener("SIGTERM", cleanup);

      try {
        pty.kill();
      } catch {
        /* already dead */
      }

      if (!exited) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            try {
              pty.kill("SIGKILL");
            } catch {
              /* already dead */
            }
            resolve();
          }, 3000);

          pty.onExit(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }

      await gw.close();

      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };

  return mock;
}
