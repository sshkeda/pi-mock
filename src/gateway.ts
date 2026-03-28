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
import { readFileSync } from "node:fs";
import {
  type Brain,
  type ApiRequest,
  type BrainResponse,
  text as textBlock,
} from "./anthropic.js";
import {
  detectProvider,
  parseRequest,
  serializeResponse,
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
  /** If this was an LLM API request, which provider format. */
  provider?: ProviderName;
  ts: number;
}

export interface GatewayConfig {
  brain: Brain;
  rules?: NetworkRule[];
  default?: NetworkAction;
  port?: number;
  /** Directory for CA + host cert files. Required for HTTPS intercept. */
  certDir?: string;
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

// ─── TLS Certificate Authority for HTTPS interception ────────────────

export interface CertAuthority {
  /** CA private key PEM */
  key: string;
  /** CA certificate PEM */
  cert: string;
  /** Path to CA cert file (for mounting into containers) */
  certPath: string;
}

/**
 * Generate a CA key + cert. Per-host server certs are signed by this CA.
 * Install the CA cert as trusted in the sandbox → TLS just works, no -k needed.
 */
function generateCA(dir: string): CertAuthority | null {
  try {
    const keyPath = `${dir}/pi-mock-ca.key`;
    const certPath = `${dir}/pi-mock-ca.crt`;

    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" ` +
        `-days 365 -nodes -subj "/CN=pi-mock CA" 2>/dev/null`,
      { encoding: "utf-8" },
    );

    const key = readFileSync(keyPath, "utf-8");
    const cert = readFileSync(certPath, "utf-8");
    return { key, cert, certPath };
  } catch {
    return null;
  }
}

/** Cache of per-host certs signed by the CA */
const hostCertCache = new Map<string, { key: string; cert: string }>();

/**
 * Generate a server cert for a specific hostname, signed by our CA.
 * Curl, Node, and everything else trusts it if the CA is installed.
 */
function getHostCert(
  ca: CertAuthority,
  host: string,
  tmpDir: string,
): { key: string; cert: string } | null {
  const cached = hostCertCache.get(host);
  if (cached) return cached;

  try {
    const hostKeyPath = `${tmpDir}/${host}.key`;
    const hostCsrPath = `${tmpDir}/${host}.csr`;
    const hostCertPath = `${tmpDir}/${host}.crt`;
    const caKeyPath = `${tmpDir}/pi-mock-ca.key`;
    const caCertPath = `${tmpDir}/pi-mock-ca.crt`;

    // Generate host key + CSR
    execSync(
      `openssl req -newkey rsa:2048 -keyout "${hostKeyPath}" -out "${hostCsrPath}" ` +
        `-nodes -subj "/CN=${host}" 2>/dev/null`,
    );

    // Sign with CA (with SAN so modern TLS clients accept it)
    execSync(
      `openssl x509 -req -in "${hostCsrPath}" -CA "${caCertPath}" -CAkey "${caKeyPath}" ` +
        `-CAcreateserial -out "${hostCertPath}" -days 365 ` +
        `-extfile <(echo "subjectAltName=DNS:${host}") 2>/dev/null`,
      { shell: "/bin/bash" },
    );

    const key = readFileSync(hostKeyPath, "utf-8");
    const cert = readFileSync(hostCertPath, "utf-8");
    const entry = { key, cert };
    hostCertCache.set(host, entry);
    return entry;
  } catch {
    return null;
  }
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

  // Generate CA for HTTPS MITM intercepts.
  // The CA cert is installed as trusted in the sandbox, so TLS works normally.
  const ca = config.certDir ? generateCA(config.certDir) : null;

  // ── Known LLM API hosts ── auto-intercepted and routed through the brain

  const LLM_HOSTS: Record<string, ProviderName> = {
    "api.anthropic.com": "anthropic",
    "api.openai.com": "openai",
    "generativelanguage.googleapis.com": "google",
    "api.groq.com": "openai",       // Groq uses OpenAI-compatible format
    "api.x.ai": "openai",            // xAI uses OpenAI-compatible format
    "openrouter.ai": "openai",       // OpenRouter uses OpenAI-compatible format
    "api.mistral.ai": "openai",      // Mistral uses OpenAI-compatible format
    "api.cerebras.ai": "openai",     // Cerebras uses OpenAI-compatible format
  };

  function isLlmHost(host: string): ProviderName | null {
    if (LLM_HOSTS[host]) return LLM_HOSTS[host];
    // Check subdomains
    for (const [domain, provider] of Object.entries(LLM_HOSTS)) {
      if (host.endsWith(`.${domain}`)) return provider;
    }
    return null;
  }

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

    // Normalize request from provider format to our universal ApiRequest
    const apiReq = parseRequest(provider, rawBody);
    (apiReq as ApiRequest & { _provider?: string })._provider = provider;
    (apiReq as ApiRequest & { _raw?: unknown })._raw = rawBody;

    requests.push(apiReq);
    const idx = requestIndex++;

    let response: BrainResponse;
    try {
      response = await brain(apiReq, idx);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[gateway] brain error on request #${idx} (${provider}):`, msg);
      response = textBlock(`brain error: ${msg}`);
    }

    // Serialize response in the provider's format
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
    const httpLlmProvider = isLlmHost(host);
    log(host, req.method ?? "GET", httpLlmProvider ? "intercept" : action, req.url);

    if (action === "block" && !httpLlmProvider) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end(`[pi-mock] blocked: ${host}`);
      return;
    }

    // LLM API over HTTP — parse and route through brain
    if (httpLlmProvider && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
      try {
        const rawBody = JSON.parse(Buffer.concat(chunks).toString());
        const provider = detectProvider(req.method, targetUrl.pathname) || httpLlmProvider;
        const apiReq = parseRequest(provider, rawBody);
        apiReq._provider = provider;
        apiReq._raw = rawBody;
        requests.push(apiReq);
        const idx = requestIndex++;
        let brainResp: BrainResponse;
        try {
          brainResp = await brain(apiReq, idx);
        } catch (err: unknown) {
          brainResp = textBlock(`brain error: ${err instanceof Error ? err.message : String(err)}`);
        }
        const { contentType, body } = serializeResponse(provider, brainResp, apiReq.model);
        res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(body);
        res.end();
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
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

    // Check if this is a known LLM API host — always intercept these
    // regardless of the default network action
    const llmProvider = isLlmHost(host);

    log(host, "CONNECT", llmProvider ? "intercept" : action, req.url);

    // Block — but NOT if it's a known LLM host (those get intercepted)
    if (action === "block" && !llmProvider) {
      socket.write("HTTP/1.1 403 Blocked by pi-mock\r\n\r\n");
      socket.end();
      return;
    }

    // MITM intercept — for explicit intercept rules OR known LLM API hosts
    if (action === "intercept" || llmProvider) {
      if (!ca || !config.certDir) {
        socket.write("HTTP/1.1 502 HTTPS intercept unavailable (no CA)\r\n\r\n");
        socket.end();
        return;
      }

      const hostCert = getHostCert(ca, host, config.certDir);
      if (!hostCert) {
        socket.write("HTTP/1.1 502 Failed to generate cert for host\r\n\r\n");
        socket.end();
        return;
      }

      // Tag the log entry with provider info
      proxyLog[proxyLog.length - 1].provider = llmProvider ?? undefined;

      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

      const tlsSocket = new tls.TLSSocket(socket, {
        isServer: true,
        secureContext: tls.createSecureContext({ key: hostCert.key, cert: hostCert.cert }),
      });

      // Accumulate the full HTTP request (headers + body)
      let httpBuf = Buffer.alloc(0);
      let headersParsed = false;
      let contentLength = 0;
      let headersEndIndex = 0;

      tlsSocket.on("data", async (chunk: Buffer) => {
        httpBuf = Buffer.concat([httpBuf, chunk]);

        // Parse headers once
        if (!headersParsed) {
          const headerEnd = httpBuf.indexOf("\r\n\r\n");
          if (headerEnd === -1) return;
          headersParsed = true;
          headersEndIndex = headerEnd + 4;

          const headerStr = httpBuf.subarray(0, headerEnd).toString();
          const clMatch = headerStr.match(/content-length:\s*(\d+)/i);
          contentLength = clMatch ? parseInt(clMatch[1]) : 0;
        }

        // Wait for full body
        const bodyReceived = httpBuf.length - headersEndIndex;
        if (bodyReceived < contentLength) return;

        const headerStr = httpBuf.subarray(0, headersEndIndex - 4).toString();
        const bodyStr = httpBuf.subarray(headersEndIndex, headersEndIndex + contentLength).toString();

        const [requestLine] = headerStr.split("\r\n");
        const [method = "GET", path = "/"] = requestLine.split(" ");

        const headers: Record<string, string> = {};
        for (const line of headerStr.split("\r\n").slice(1)) {
          if (!line) break;
          const i = line.indexOf(":");
          if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }

        try {
          // If this is a known LLM API, route through the brain
          if (llmProvider && bodyStr) {
            const rawBody = JSON.parse(bodyStr);
            const provider = detectProvider(method, path) || llmProvider;
            const apiReq = parseRequest(provider, rawBody);
            apiReq._provider = provider;
            apiReq._raw = rawBody;

            requests.push(apiReq);
            const idx = requestIndex++;

            let brainResp: BrainResponse;
            try {
              brainResp = await brain(apiReq, idx);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              brainResp = textBlock(`brain error: ${msg}`);
            }

            const { contentType, body: respBody } = serializeResponse(provider, brainResp, apiReq.model);
            const respBuf = Buffer.from(respBody);
            const respHeaders = {
              "Content-Type": contentType,
              "Transfer-Encoding": "chunked",
              Connection: "close",
            };
            const respHeaderStr = Object.entries(respHeaders)
              .map(([k, v]) => `${k}: ${v}`)
              .join("\r\n");
            tlsSocket.write(`HTTP/1.1 200 OK\r\n${respHeaderStr}\r\n\r\n`);
            tlsSocket.write(respBuf);
          } else {
            // Regular intercept — serve static/handler response
            const resp = await getInterceptResponse(rule, host, method, path, headers);
            const bodyBuf = Buffer.from(resp.body);
            const respHeaders = {
              "Content-Type": "text/html",
              "Content-Length": String(bodyBuf.length),
              Connection: "close",
              ...resp.headers,
            };
            const respHeaderStr = Object.entries(respHeaders)
              .map(([k, v]) => `${k}: ${v}`)
              .join("\r\n");
            tlsSocket.write(`HTTP/1.1 ${resp.status ?? 200} OK\r\n${respHeaderStr}\r\n\r\n`);
            tlsSocket.write(bodyBuf);
          }
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
    // LLM API — detect provider from URL path
    if (req.method === "POST") {
      const provider = detectProvider(req.method, req.url ?? "");
      if (provider !== "unknown") {
        return handleLlmApi(req, res, provider);
      }
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
