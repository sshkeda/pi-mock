/**
 * Gateway — the single point of network control.
 *
 * One HTTP server that does three things:
 *   1. Mock LLM API  — POST to Anthropic/OpenAI/Google endpoints → brain function
 *   2. HTTP forward proxy  — GET http://host/... → allow, block, or intercept
 *   3. HTTPS tunnel proxy  — CONNECT host:443   → allow or block
 *
 * All LLM providers are redirected here via models.json base URL overrides.
 * No MITM, no fake certs. Simple HTTP to the gateway.
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
  type HttpErrorBlock,
} from "./anthropic.js";
import {
  detectProvider,
  parseRequest,
  serializeResponse,
  serializeProviderError,
  type ProviderName,
} from "./providers.js";

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

export type InterceptHandler = (
  host: string,
  method: string,
  path: string,
  headers: Record<string, string>,
) => InterceptResponse | Promise<InterceptResponse>;

export interface NetworkRule {
  match: string | RegExp;
  action?: NetworkAction;
  response?: InterceptResponse;
  handler?: InterceptHandler;
}

export interface ProxyLogEntry {
  host: string;
  method: string;
  url?: string;
  action: NetworkAction;
  provider?: ProviderName;
  ts: number;
}

export interface GatewayConfig {
  brain: Brain;
  rules?: NetworkRule[];
  default?: NetworkAction;
  port?: number;
  /** Bind address. Default: "127.0.0.1". Use "0.0.0.0" for Docker sandbox access. */
  host?: string;
  onManagement?: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
}

export interface Gateway {
  readonly url: string;
  readonly port: number;
  readonly requests: ApiRequest[];
  readonly proxyLog: ProxyLogEntry[];
  setBrain(brain: Brain): void;
  setRules(rules: NetworkRule[], defaultAction?: NetworkAction): void;
  /** Subscribe to brain requests. Returns unsubscribe. */
  onRequest(listener: (req: ApiRequest, index: number) => void): () => void;
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
  const requestListeners = new Set<(req: ApiRequest, index: number) => void>();

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

  // ── Intercept response ──

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

  // ── Handler: LLM API mock (multi-provider) ──

  async function handleLlmApi(req: IncomingMessage, res: ServerResponse, provider: ProviderName) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);

    let rawBody: Record<string, unknown>;
    try {
      rawBody = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      res.writeHead(400);
      res.end("bad json");
      return;
    }

    const apiReq = parseRequest(provider, rawBody);
    apiReq._provider = provider;
    apiReq._headers = Object.fromEntries(
      Object.entries(req.headers)
        .filter(([, v]) => typeof v === "string")
        .map(([k, v]) => [k, v as string]),
    );
    apiReq._raw = rawBody;

    requests.push(apiReq);
    const idx = requestIndex++;
    for (const l of requestListeners) l(apiReq, idx);

    let response: BrainResponse;
    try {
      response = await brain(apiReq, idx);
    } catch (err: unknown) {
      // Brain threw an exception — return a proper HTTP 500 error so pi's retry
      // logic kicks in. Previously this returned text("brain error: ...") which
      // sent a 200 and pi tried to act on the error text as normal output.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[gateway] brain error on request #${idx} (${provider}):`, msg);
      response = {
        type: "http_error" as const,
        status: 500,
        message: `brain error: ${msg}`,
      };
    }

    // HttpErrorBlock — return actual HTTP error status code.
    // This triggers the Anthropic SDK's error handling → pi's retry logic.
    if (!Array.isArray(response) && (response as HttpErrorBlock).type === "http_error") {
      const httpErr = response as HttpErrorBlock;
      const { contentType: errCt, body: errBody } = serializeProviderError(
        provider,
        httpErr.status,
        httpErr.message ?? "error",
      );
      const headers: Record<string, string> = {
        "Content-Type": errCt,
        ...(httpErr.headers ?? {}),
      };
      // By default, tell the Anthropic SDK not to retry so errors go straight
      // to pi's own retry logic. This makes fault injection predictable.
      if (httpErr.bypassSdkRetry !== false && !headers["x-should-retry"]) {
        headers["x-should-retry"] = "false";
      }
      res.writeHead(httpErr.status, headers);
      res.end(errBody);
      return;
    }

    const { contentType, body } = serializeResponse(provider, response, apiReq.model ?? "mock");

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(body);
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
        rule, host, req.method ?? "GET",
        targetUrl.pathname + targetUrl.search, hdrs,
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
    const { action } = resolve(host);
    log(host, "CONNECT", action, req.url);

    if (action === "block") {
      socket.write("HTTP/1.1 403 Blocked by pi-mock\r\n\r\n");
      socket.end();
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
    // LLM API — detect provider from URL path
    if (req.method === "POST") {
      const provider = detectProvider(req.method, req.url ?? "");
      if (provider !== "unknown") {
        return handleLlmApi(req, res, provider);
      }
    }
    // HTTP proxy — full URL in request line
    if (req.url?.startsWith("http://")) {
      return handleHttpProxy(req, res);
    }
    // Health
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ service: "pi-mock-gateway", requests: requests.length }));
  });

  server.on("connect", handleConnect);
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => {
    server.listen(config.port ?? 0, config.host ?? "127.0.0.1", resolve);
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : 0;

  return {
    get url() { return `http://127.0.0.1:${actualPort}`; },
    get port() { return actualPort; },
    requests,
    proxyLog,
    setBrain(b) { brain = b; },
    setRules(r, d) { rules = r; if (d) defaultAction = d; },
    onRequest(listener) {
      requestListeners.add(listener);
      return () => requestListeners.delete(listener);
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
