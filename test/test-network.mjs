/**
 * Tests for gateway network rules — proxy allow/block/intercept.
 *
 * Tests the gateway's rule engine, HTTP forward proxy, and HTTPS CONNECT tunnel
 * without needing Docker. Creates a real gateway and makes HTTP requests through it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../dist/gateway.js";
import { text } from "../dist/index.js";
import { request as httpRequest } from "node:http";
import { createServer } from "node:http";

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

test("block by default — HTTP proxy returns 403", async () => {
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "block",
    rules: [],
  });
  try {
    const res = await proxyGet(gw.port, "http://example.com/test");
    assert.equal(res.status, 403);
    assert.ok(res.body.includes("blocked"), `body: ${res.body}`);
    assert.equal(gw.proxyLog.length, 1);
    assert.equal(gw.proxyLog[0].action, "block");
    assert.equal(gw.proxyLog[0].host, "example.com");
  } finally {
    await gw.close();
  }
});

test("allow rule — exact host match", async () => {
  const echo = await startEchoServer();
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "block",
    rules: [{ match: "127.0.0.1", action: "allow" }],
  });
  try {
    const res = await proxyGet(gw.port, `${echo.url}/hello`);
    assert.equal(res.status, 200);
    assert.equal(res.body, "echo:/hello");
    assert.equal(gw.proxyLog[0].action, "allow");
  } finally {
    await gw.close();
    echo.close();
  }
});

test("allow rule — subdomain match", async () => {
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "block",
    rules: [{ match: "npmjs.org", action: "allow" }],
  });
  try {
    await proxyGet(gw.port, "http://registry.npmjs.org/test").catch(() => null);
    assert.equal(gw.proxyLog.length, 1);
    assert.equal(gw.proxyLog[0].action, "allow");
    assert.equal(gw.proxyLog[0].host, "registry.npmjs.org");
  } finally {
    await gw.close();
  }
});

test("block rule — explicit block overrides default allow", async () => {
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "allow",
    rules: [{ match: "evil.com", action: "block" }],
  });
  try {
    const res = await proxyGet(gw.port, "http://evil.com/malware");
    assert.equal(res.status, 403);
    assert.equal(gw.proxyLog[0].action, "block");
  } finally {
    await gw.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Rule matching — regex
// ═══════════════════════════════════════════════════════════════════

test("regex rule — matches host pattern", async () => {
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "block",
    rules: [{ match: /\.github\.com$/, action: "allow" }],
  });
  try {
    await proxyGet(gw.port, "http://api.github.com/repos").catch(() => null);
    assert.equal(gw.proxyLog.length, 1);
    assert.equal(gw.proxyLog[0].action, "allow");

    await proxyGet(gw.port, "http://github.com/test").catch(() => null);
    assert.equal(gw.proxyLog[1].action, "block");
  } finally {
    await gw.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Rule matching — intercept (synthetic response)
// ═══════════════════════════════════════════════════════════════════

test("intercept rule — static response", async () => {
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
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.mocked, true);
    assert.equal(res.headers["content-type"], "application/json");
    assert.equal(gw.proxyLog[0].action, "intercept");
  } finally {
    await gw.close();
  }
});

test("intercept rule — handler function", async () => {
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
    assert.equal(res.status, 201);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.host, "dynamic.example.com");
    assert.equal(parsed.method, "GET");
    assert.equal(parsed.path, "/api/v1/users");
  } finally {
    await gw.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// HTTPS CONNECT tunnel
// ═══════════════════════════════════════════════════════════════════

test("CONNECT — blocked by default", async () => {
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "block",
    rules: [],
  });
  try {
    const res = await proxyConnect(gw.port, "evil.com");
    assert.equal(res.status, 403);
    assert.equal(gw.proxyLog.length, 1);
    assert.equal(gw.proxyLog[0].action, "block");
    assert.equal(gw.proxyLog[0].method, "CONNECT");
  } finally {
    await gw.close();
  }
});

test("CONNECT — allowed by rule", async () => {
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "block",
    rules: [{ match: "github.com", action: "allow" }],
  });
  try {
    const res = await proxyConnect(gw.port, "github.com");
    assert.equal(res.status, 200);
    assert.equal(gw.proxyLog[0].action, "allow");
  } finally {
    await gw.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// setRules — dynamic rule updates
// ═══════════════════════════════════════════════════════════════════

test("setRules — dynamically change rules", async () => {
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "block",
    rules: [],
  });
  try {
    const res1 = await proxyGet(gw.port, "http://example.com/a");
    assert.equal(res1.status, 403);

    gw.setRules([{ match: "example.com", action: "allow" }]);

    await proxyGet(gw.port, "http://example.com/b").catch(() => null);
    const lastLog = gw.proxyLog[gw.proxyLog.length - 1];
    assert.equal(lastLog.action, "allow");
  } finally {
    await gw.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Rule priority — first match wins
// ═══════════════════════════════════════════════════════════════════

test("rule priority — first match wins", async () => {
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "allow",
    rules: [
      { match: "api.example.com", action: "block" },
      { match: "example.com", action: "allow" },
    ],
  });
  try {
    const res = await proxyGet(gw.port, "http://api.example.com/test");
    assert.equal(res.status, 403);

    await proxyGet(gw.port, "http://www.example.com/test").catch(() => null);
    const lastLog = gw.proxyLog[gw.proxyLog.length - 1];
    assert.equal(lastLog.action, "allow");
  } finally {
    await gw.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// onRequest listener
// ═══════════════════════════════════════════════════════════════════

test("onRequest — notifies on LLM requests, unsubscribe works", async () => {
  const received = [];
  const gw = await createGateway({
    brain: () => text("hello"),
    default: "block",
  });
  try {
    const unsub = gw.onRequest((req, index) => {
      received.push({ model: req.model, index });
    });

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

    assert.equal(received.length, 1);
    assert.equal(received[0].index, 0);

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

    assert.equal(received.length, 1, "after unsub should still be 1");
    assert.equal(gw.requests.length, 2);
  } finally {
    await gw.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// Default "allow" mode
// ═══════════════════════════════════════════════════════════════════

test("default allow — no rules, traffic flows", async () => {
  const echo = await startEchoServer();
  const gw = await createGateway({
    brain: () => text("unused"),
    default: "allow",
    rules: [],
  });
  try {
    const res = await proxyGet(gw.port, `${echo.url}/path`);
    assert.equal(res.status, 200);
    assert.equal(res.body, "echo:/path");
    assert.equal(gw.proxyLog[0].action, "allow");
  } finally {
    await gw.close();
    echo.close();
  }
});
