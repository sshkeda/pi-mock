/**
 * Tests for gateway network rules — proxy allow/block/intercept.
 *
 * Tests the gateway's rule engine, HTTP forward proxy, and HTTPS CONNECT tunnel
 * without needing Docker. Creates a real gateway and makes HTTP requests through it.
 */
import { createGateway } from "../dist/gateway.js";
import { text } from "../dist/index.js";
import { request as httpRequest } from "node:http";
import { createServer } from "node:http";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  process.stderr.write(`\n━━━ ${name} `);
  try {
    await fn();
    passed++;
    process.stderr.write(`✅ PASS\n`);
  } catch (err) {
    failed++;
    process.stderr.write(`❌ FAIL: ${err.message}\n`);
    if (err.stack) process.stderr.write(`    ${err.stack.split("\n").slice(1, 3).join("\n    ")}\n`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

/** Make an HTTP request through the gateway as a forward proxy. */
function proxyGet(gwPort, targetUrl) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: gwPort,
        method: "GET",
        path: targetUrl,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Make an HTTP CONNECT request (HTTPS tunnel initiation). */
function proxyConnect(gwPort, host, port = 443) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: "127.0.0.1",
      port: gwPort,
      method: "CONNECT",
      path: `${host}:${port}`,
    });
    req.on("connect", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Start a tiny HTTP server that echoes back a message. */
function startEchoServer() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`echo:${req.url}`);
    });
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      resolve({ port, url: `http://127.0.0.1:${port}`, close: () => srv.close() });
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// Rule matching — string match (exact + subdomain)
// ═══════════════════════════════════════════════════════════════════

await test("block by default — HTTP proxy returns 403", async () => {
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "block",
    rules: [],
  });
  try {
    const res = await proxyGet(gw.port, "http://example.com/test");
    assert(res.status === 403, `expected 403, got ${res.status}`);
    assert(res.body.includes("blocked"), `body: ${res.body}`);

    // Verify proxy log recorded it
    assert(gw.proxyLog.length === 1, `proxyLog: ${gw.proxyLog.length}`);
    assert(gw.proxyLog[0].action === "block", `action: ${gw.proxyLog[0].action}`);
    assert(gw.proxyLog[0].host === "example.com", `host: ${gw.proxyLog[0].host}`);
  } finally {
    await gw.close();
  }
});

await test("allow rule — exact host match", async () => {
  const echo = await startEchoServer();
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "block",
    rules: [{ match: "127.0.0.1", action: "allow" }],
  });
  try {
    const res = await proxyGet(gw.port, `${echo.url}/hello`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body === "echo:/hello", `body: ${res.body}`);
    assert(gw.proxyLog[0].action === "allow", `action: ${gw.proxyLog[0].action}`);
  } finally {
    await gw.close();
    echo.close();
  }
});

await test("allow rule — subdomain match", async () => {
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "block",
    rules: [{ match: "npmjs.org", action: "allow" }],
  });
  try {
    // This won't actually resolve, but we can check the proxy log for the action
    // We use a non-routable target — the action decision happens before forwarding
    const res = await proxyGet(gw.port, "http://registry.npmjs.org/test").catch(() => null);
    // The request may fail (DNS/connection), but the proxy log should show "allow"
    assert(gw.proxyLog.length === 1, `proxyLog: ${gw.proxyLog.length}`);
    assert(gw.proxyLog[0].action === "allow", `action: ${gw.proxyLog[0].action}`);
    assert(gw.proxyLog[0].host === "registry.npmjs.org", `host: ${gw.proxyLog[0].host}`);
  } finally {
    await gw.close();
  }
});

await test("block rule — explicit block overrides default allow", async () => {
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "allow",
    rules: [{ match: "evil.com", action: "block" }],
  });
  try {
    const res = await proxyGet(gw.port, "http://evil.com/malware");
    assert(res.status === 403, `expected 403, got ${res.status}`);
    assert(gw.proxyLog[0].action === "block", `action: ${gw.proxyLog[0].action}`);
  } finally {
    await gw.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Rule matching — regex
// ═══════════════════════════════════════════════════════════════════

await test("regex rule — matches host pattern", async () => {
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "block",
    rules: [{ match: /\.github\.com$/, action: "allow" }],
  });
  try {
    // api.github.com should match
    await proxyGet(gw.port, "http://api.github.com/repos").catch(() => null);
    assert(gw.proxyLog.length === 1, `proxyLog: ${gw.proxyLog.length}`);
    assert(gw.proxyLog[0].action === "allow", `action: ${gw.proxyLog[0].action}`);

    // github.com (no subdomain) should NOT match the regex
    await proxyGet(gw.port, "http://github.com/test").catch(() => null);
    assert(gw.proxyLog[1].action === "block", `plain github.com: ${gw.proxyLog[1].action}`);
  } finally {
    await gw.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Rule matching — intercept (synthetic response)
// ═══════════════════════════════════════════════════════════════════

await test("intercept rule — static response", async () => {
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "block",
    rules: [
      {
        match: "api.example.com",
        action: "intercept",
        response: { status: 200, body: '{"mocked":true}', headers: { "Content-Type": "application/json" } },
      },
    ],
  });
  try {
    const res = await proxyGet(gw.port, "http://api.example.com/data");
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const parsed = JSON.parse(res.body);
    assert(parsed.mocked === true, `body: ${res.body}`);
    assert(res.headers["content-type"] === "application/json", `ct: ${res.headers["content-type"]}`);
    assert(gw.proxyLog[0].action === "intercept", `action: ${gw.proxyLog[0].action}`);
  } finally {
    await gw.close();
  }
});

await test("intercept rule — handler function", async () => {
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "block",
    rules: [
      {
        match: "dynamic.example.com",
        action: "intercept",
        handler: (host, method, path) => ({
          status: 201,
          body: JSON.stringify({ host, method, path }),
        }),
      },
    ],
  });
  try {
    const res = await proxyGet(gw.port, "http://dynamic.example.com/api/v1/users");
    assert(res.status === 201, `expected 201, got ${res.status}`);
    const parsed = JSON.parse(res.body);
    assert(parsed.host === "dynamic.example.com", `host: ${parsed.host}`);
    assert(parsed.method === "GET", `method: ${parsed.method}`);
    assert(parsed.path === "/api/v1/users", `path: ${parsed.path}`);
  } finally {
    await gw.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// HTTPS CONNECT tunnel
// ═══════════════════════════════════════════════════════════════════

await test("CONNECT — blocked by default", async () => {
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "block",
    rules: [],
  });
  try {
    const res = await proxyConnect(gw.port, "evil.com");
    assert(res.status === 403, `expected 403, got ${res.status}`);
    assert(gw.proxyLog.length === 1, `proxyLog: ${gw.proxyLog.length}`);
    assert(gw.proxyLog[0].action === "block", `action: ${gw.proxyLog[0].action}`);
    assert(gw.proxyLog[0].method === "CONNECT", `method: ${gw.proxyLog[0].method}`);
  } finally {
    await gw.close();
  }
});

await test("CONNECT — allowed by rule", async () => {
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "block",
    rules: [{ match: "github.com", action: "allow" }],
  });
  try {
    // We can't complete a real TLS handshake, but we can verify the CONNECT
    // gets a 200 response (connection established). The tunnel will fail after
    // since there's no real TLS server, but the rule matched "allow".
    const res = await proxyConnect(gw.port, "github.com");
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(gw.proxyLog[0].action === "allow", `action: ${gw.proxyLog[0].action}`);
  } finally {
    await gw.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// setRules — dynamic rule updates
// ═══════════════════════════════════════════════════════════════════

await test("setRules — dynamically change rules", async () => {
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "block",
    rules: [],
  });
  try {
    // Initially blocked
    const res1 = await proxyGet(gw.port, "http://example.com/a");
    assert(res1.status === 403, `initially blocked: ${res1.status}`);

    // Update rules to allow
    gw.setRules([{ match: "example.com", action: "allow" }]);

    // Now allowed (will fail on DNS but action should be "allow")
    await proxyGet(gw.port, "http://example.com/b").catch(() => null);
    const lastLog = gw.proxyLog[gw.proxyLog.length - 1];
    assert(lastLog.action === "allow", `after setRules: ${lastLog.action}`);
  } finally {
    await gw.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Rule priority — first match wins
// ═══════════════════════════════════════════════════════════════════

await test("rule priority — first match wins", async () => {
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "allow",
    rules: [
      { match: "api.example.com", action: "block" },
      { match: "example.com", action: "allow" },
    ],
  });
  try {
    // api.example.com matches first rule → block
    const res = await proxyGet(gw.port, "http://api.example.com/test");
    assert(res.status === 403, `api.example.com blocked: ${res.status}`);

    // www.example.com matches second rule (subdomain of example.com) → allow
    await proxyGet(gw.port, "http://www.example.com/test").catch(() => null);
    const lastLog = gw.proxyLog[gw.proxyLog.length - 1];
    assert(lastLog.action === "allow", `www.example.com allowed: ${lastLog.action}`);
  } finally {
    await gw.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// onRequest listener
// ═══════════════════════════════════════════════════════════════════

await test("onRequest — notifies on LLM requests, unsubscribe works", async () => {
  const received = [];
  const gw = await createGateway({
    brain: () => text("hello"),
    default: "block",
  });
  try {
    const unsub = gw.onRequest((req, index) => {
      received.push({ model: req.model, index });
    });

    // Make an LLM request (POST to /v1/messages)
    await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: gw.port,
          method: "POST",
          path: "/v1/messages",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
      req.write(JSON.stringify({ model: "test-model", messages: [], max_tokens: 100, stream: true }));
      req.end();
    });

    assert(received.length === 1, `received: ${received.length}`);
    assert(received[0].index === 0, `index: ${received[0].index}`);

    // Unsubscribe and verify no more notifications
    unsub();

    await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: gw.port,
          method: "POST",
          path: "/v1/messages",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
      req.write(JSON.stringify({ model: "test-2", messages: [], max_tokens: 100, stream: true }));
      req.end();
    });

    assert(received.length === 1, `after unsub: ${received.length} (should still be 1)`);
    assert(gw.requests.length === 2, `total requests: ${gw.requests.length}`);
  } finally {
    await gw.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Default "allow" mode
// ═══════════════════════════════════════════════════════════════════

await test("default allow — no rules, traffic flows", async () => {
  const echo = await startEchoServer();
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "allow",
    rules: [],
  });
  try {
    const res = await proxyGet(gw.port, `${echo.url}/path`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body === "echo:/path", `body: ${res.body}`);
    assert(gw.proxyLog[0].action === "allow", `action: ${gw.proxyLog[0].action}`);
  } finally {
    await gw.close();
    echo.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════
console.error(`\n${"═".repeat(60)}`);
console.error(`Network tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.error(`${"═".repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
