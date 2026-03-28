/**
 * Gateway — the single point of network control.
 *
 * One HTTP server that does three things:
 *   1. Mock Anthropic API  — POST /v1/messages → brain function
 *   2. HTTP forward proxy  — GET http://host/... → rule check → forward or block
 *   3. HTTPS tunnel proxy  — CONNECT host:443 → rule check → tunnel or block
 *
 * The sandbox can ONLY reach this server (iptables).
 * So the gateway IS the internet as far as the sandbox is concerned.
 */

import {
  createServer,
  request as httpRequest,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import {
  type Brain,
  type ApiRequest,
  type BrainResponse,
  toSSE,
  text as textBlock,
} from "./anthropic.js";

// ─── Types ───────────────────────────────────────────────────────────

export type NetworkAction = "allow" | "block";

export interface NetworkRule {
  /** Hostname — string for exact match (+ subdomain), RegExp for pattern. */
  match: string | RegExp;
  /** What to do. Default: "allow" */
  action?: NetworkAction;
}

export interface ProxyLogEntry {
  host: string;
  method: string;
  url?: string;
  action: NetworkAction;
  ts: number;
}

export interface GatewayConfig {
  /** Brain function — receives Anthropic API requests, returns mock responses. */
  brain: Brain;
  /** Network rules — first match wins. */
  rules?: NetworkRule[];
  /** Default action for hosts that don't match any rule. Default: "block" */
  default?: NetworkAction;
  /** Port. 0 = random (recommended). */
  port?: number;
  /** Handler for management routes (/_/ prefix). Return true if handled. */
  onManagement?: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
}

export interface Gateway {
  /** e.g. "http://127.0.0.1:54321" */
  readonly url: string;
  readonly port: number;
  /** Every Anthropic API request the brain saw. */
  readonly requests: ApiRequest[];
  /** Every proxy request (allowed + blocked). */
  readonly proxyLog: ProxyLogEntry[];
  /** Swap the brain mid-test. */
  setBrain(brain: Brain): void;
  /** Update network rules mid-test. */
  setRules(rules: NetworkRule[], defaultAction?: NetworkAction): void;
  /** Shut down. */
  close(): Promise<void>;
}

// ─── Implementation ──────────────────────────────────────────────────

export async function createGateway(config: GatewayConfig): Promise<Gateway> {
  let brain = config.brain;
  let rules = config.rules ?? [];
  let defaultAction: NetworkAction = config.default ?? "block";
  let requestIndex = 0;

  const requests: ApiRequest[] = [];
  const proxyLog: ProxyLogEntry[] = [];
  const sockets = new Set<Socket>();

  // ── Rule engine ──

  function resolve(host: string): NetworkAction {
    for (const rule of rules) {
      if (typeof rule.match === "string") {
        if (host === rule.match || host.endsWith(`.${rule.match}`)) {
          return rule.action ?? "allow";
        }
      } else if (rule.match.test(host)) {
        return rule.action ?? "allow";
      }
    }
    return defaultAction;
  }

  function log(host: string, method: string, action: NetworkAction, url?: string) {
    proxyLog.push({ host, method, action, url, ts: Date.now() });
  }

  // ── Handler: Anthropic API mock ──

  async function handleApi(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);

    let body: ApiRequest;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      res.writeHead(400);
      res.end("bad json");
      return;
    }

    requests.push(body);
    const idx = requestIndex++;

    let response: BrainResponse;
    try {
      response = await brain(body, idx);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[gateway] brain error on request #${idx}:`, msg);
      response = textBlock(`brain error: ${msg}`);
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(toSSE(response, body.model ?? "mock"));
    res.end();
  }

  // ── Handler: HTTP forward proxy ──

  async function handleHttpProxy(req: IncomingMessage, res: ServerResponse) {
    let targetUrl: URL;
    try {
      targetUrl = new URL(req.url!);
    } catch {
      res.writeHead(400);
      res.end("bad proxy url");
      return;
    }

    const host = targetUrl.hostname;
    const action = resolve(host);
    log(host, req.method ?? "GET", action, req.url);

    if (action === "block") {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end(`[pi-mock] blocked: ${host}`);
      return;
    }

    // Forward
    const fwd = httpRequest(
      req.url!,
      {
        method: req.method,
        headers: { ...req.headers, host: targetUrl.host },
      },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
      },
    );

    fwd.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
      }
      res.end(`[pi-mock] proxy error: ${err.message}`);
    });

    req.pipe(fwd);
  }

  // ── Handler: HTTPS CONNECT tunnel ──

  function handleConnect(req: IncomingMessage, socket: Socket, head: Buffer) {
    const [host, portStr] = (req.url ?? "").split(":");
    const port = parseInt(portStr) || 443;
    const action = resolve(host);
    log(host, "CONNECT", action, req.url);

    if (action === "block") {
      socket.write("HTTP/1.1 403 Blocked by pi-mock\r\n\r\n");
      socket.end();
      return;
    }

    const upstream = connect(port, host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    upstream.on("error", () => {
      if (socket.writable) {
        socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        socket.end();
      }
    });
    socket.on("error", () => upstream.destroy());
  }

  // ── Wire it up ──

  const server = createServer(async (req, res) => {
    // CORS
    if (req.method === "OPTIONS") {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "*",
      });
      res.end();
      return;
    }

    // Management routes (/_/ prefix)
    if (req.url?.startsWith("/_/") && config.onManagement) {
      return config.onManagement(req, res);
    }

    // Anthropic API — direct POST to /v1/messages
    if (req.method === "POST" && req.url?.endsWith("/messages")) {
      return handleApi(req, res);
    }

    // HTTP proxy — full URL in request line
    if (req.url?.startsWith("http://")) {
      return handleHttpProxy(req, res);
    }

    // Health / info
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ service: "pi-mock-gateway", requests: requests.length }));
  });

  server.on("connect", handleConnect);

  // Track sockets for force-close on shutdown
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  // Listen on 0.0.0.0 so Docker containers can reach us via host.docker.internal
  await new Promise<void>((resolve) => {
    server.listen(config.port ?? 0, "0.0.0.0", resolve);
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : 0;

  return {
    get url() {
      return `http://127.0.0.1:${actualPort}`;
    },
    get port() {
      return actualPort;
    },
    requests,
    proxyLog,
    setBrain(b) {
      brain = b;
    },
    setRules(r, d) {
      rules = r;
      if (d) defaultAction = d;
    },
    close() {
      // Force-close all open sockets (especially CONNECT tunnels)
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
