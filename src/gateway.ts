/**
 * Gateway — the single point of network control.
 *
 * One HTTP server that does four things:
 *   1. Mock Anthropic API  — POST /v1/messages → brain function
 *   2. HTTP forward proxy  — GET http://host/... → forward, block, or intercept
 *   3. HTTPS tunnel proxy  — CONNECT host:443   → tunnel, block, or MITM intercept
 *   4. Intercept responses — serve fake content for any host/path
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
import * as tls from "node:tls";
import { execSync } from "node:child_process";
import {
  type Brain,
  type ApiRequest,
  type BrainResponse,
  toSSE,
  text as textBlock,
} from "./anthropic.js";

// ─── Types ───────────────────────────────────────────────────────────

export type NetworkAction = "allow" | "block" | "intercept";

export interface InterceptResponse {
  /** HTTP status code. Default: 200 */
  status?: number;
  /** Response headers. */
  headers?: Record<string, string>;
  /** Response body. */
  body: string;
}

/** Intercept handler — receives request info, returns a response. */
export type InterceptHandler = (
  host: string,
  method: string,
  path: string,
  headers: Record<string, string>,
) => InterceptResponse | Promise<InterceptResponse>;

export interface NetworkRule {
  /** Hostname — string for exact match (+ subdomain), RegExp for pattern. */
  match: string | RegExp;
  /** What to do. Default: "allow" */
  action?: NetworkAction;
  /** Static response for "intercept" action. */
  response?: InterceptResponse;
  /** Dynamic handler for "intercept" action (takes priority over response). */
  handler?: InterceptHandler;
}

export interface ProxyLogEntry {
  host: string;
  method: string;
  url?: string;
  action: NetworkAction;
  ts: number;
}

export interface GatewayConfig {
  brain: Brain;
  rules?: NetworkRule[];
  default?: NetworkAction;
  port?: number;
  onManagement?: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
}

export interface Gateway {
  readonly url: string;
  readonly port: number;
  readonly requests: ApiRequest[];
  readonly proxyLog: ProxyLogEntry[];
  setBrain(brain: Brain): void;
  setRules(rules: NetworkRule[], defaultAction?: NetworkAction): void;
  close(): Promise<void>;
}

// ─── Self-signed TLS cert (generated once via openssl) ───────────────

interface TlsCert {
  key: string;
  cert: string;
}

function generateSelfSignedCert(): TlsCert | null {
  try {
    const result = execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout /dev/stdout -out /dev/stdout -days 365 -nodes -subj "/CN=pi-mock" 2>/dev/null`,
      { encoding: "utf-8" },
    );
    const key = result.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/);
    const cert = result.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
    if (key && cert) return { key: key[0], cert: cert[0] };
  } catch {
    // openssl not available
  }
  return null;
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

  // Generate once for all HTTPS MITM intercepts.
  // Sandbox sets NODE_TLS_REJECT_UNAUTHORIZED=0 so clients accept it.
  const tlsCert = generateSelfSignedCert();

  // ── Rule engine ──

  interface RuleMatch {
    action: NetworkAction;
    rule?: NetworkRule;
  }

  function resolve(host: string): RuleMatch {
    for (const rule of rules) {
      if (typeof rule.match === "string") {
        if (host === rule.match || host.endsWith(`.${rule.match}`)) {
          return { action: rule.action ?? "allow", rule };
        }
      } else if (rule.match.test(host)) {
        return { action: rule.action ?? "allow", rule };
      }
    }
    return { action: defaultAction };
  }

  function log(host: string, method: string, action: NetworkAction, url?: string) {
    proxyLog.push({ host, method, action, url, ts: Date.now() });
  }

  // ── Intercept response resolution ──

  async function getInterceptResponse(
    rule: NetworkRule | undefined,
    host: string,
    method: string,
    path: string,
    headers: Record<string, string>,
  ): Promise<InterceptResponse> {
    if (rule?.handler) return rule.handler(host, method, path, headers);
    if (rule?.response) return rule.response;
    return { status: 200, body: `[pi-mock] intercepted: ${host}${path}` };
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
    const { action, rule } = resolve(host);
    log(host, req.method ?? "GET", action, req.url);

    if (action === "block") {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end(`[pi-mock] blocked: ${host}`);
      return;
    }

    if (action === "intercept") {
      const hdrs = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, String(v)]),
      );
      const resp = await getInterceptResponse(
        rule,
        host,
        req.method ?? "GET",
        targetUrl.pathname + targetUrl.search,
        hdrs,
      );
      res.writeHead(resp.status ?? 200, { "Content-Type": "text/html", ...resp.headers });
      res.end(resp.body);
      return;
    }

    // Forward to real server
    const fwd = httpRequest(
      req.url!,
      { method: req.method, headers: { ...req.headers, host: targetUrl.host } },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
      },
    );
    fwd.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`[pi-mock] proxy error: ${err.message}`);
    });
    req.pipe(fwd);
  }

  // ── Handler: HTTPS CONNECT tunnel ──

  function handleConnect(req: IncomingMessage, socket: Socket, head: Buffer) {
    const [host, portStr] = (req.url ?? "").split(":");
    const port = parseInt(portStr) || 443;
    const { action, rule } = resolve(host);
    log(host, "CONNECT", action, req.url);

    if (action === "block") {
      socket.write("HTTP/1.1 403 Blocked by pi-mock\r\n\r\n");
      socket.end();
      return;
    }

    if (action === "intercept") {
      if (!tlsCert) {
        socket.write("HTTP/1.1 502 HTTPS intercept unavailable (no openssl)\r\n\r\n");
        socket.end();
        return;
      }

      // MITM: accept the CONNECT, terminate TLS ourselves, serve fake response.
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

      const tlsSocket = new tls.TLSSocket(socket, {
        isServer: true,
        secureContext: tls.createSecureContext({ key: tlsCert.key, cert: tlsCert.cert }),
      });

      let httpBuf = "";
      tlsSocket.on("data", async (chunk: Buffer) => {
        httpBuf += chunk.toString();
        if (!httpBuf.includes("\r\n\r\n")) return; // wait for full headers

        const [requestLine] = httpBuf.split("\r\n");
        const [method = "GET", path = "/"] = requestLine.split(" ");

        const headers: Record<string, string> = {};
        for (const line of httpBuf.split("\r\n").slice(1)) {
          if (!line) break;
          const i = line.indexOf(":");
          if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }

        try {
          const resp = await getInterceptResponse(rule, host, method, path, headers);
          const bodyBuf = Buffer.from(resp.body);
          const respHeaders = {
            "Content-Type": "text/html",
            "Content-Length": String(bodyBuf.length),
            Connection: "close",
            ...resp.headers,
          };
          const headerStr = Object.entries(respHeaders)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n");
          tlsSocket.write(`HTTP/1.1 ${resp.status ?? 200} OK\r\n${headerStr}\r\n\r\n`);
          tlsSocket.write(bodyBuf);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          tlsSocket.write(
            `HTTP/1.1 500 Error\r\nContent-Length: ${Buffer.byteLength(msg)}\r\nConnection: close\r\n\r\n${msg}`,
          );
        }
        tlsSocket.end();
      });

      tlsSocket.on("error", () => socket.destroy());
      return;
    }

    // Allow — tunnel to real server
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
    if (req.method === "OPTIONS") {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "*",
      });
      res.end();
      return;
    }
    if (req.url?.startsWith("/_/") && config.onManagement) {
      return config.onManagement(req, res);
    }
    if (req.method === "POST" && req.url?.endsWith("/messages")) {
      return handleApi(req, res);
    }
    if (req.url?.startsWith("http://")) {
      return handleHttpProxy(req, res);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ service: "pi-mock-gateway", requests: requests.length }));
  });

  server.on("connect", handleConnect);
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

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
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
