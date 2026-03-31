/**
 * E2E tests for interactive mode — drives pi's terminal UI via PTY.
 *
 * Prerequisites:
 *   - pi installed: npm install -g @mariozechner/pi-coding-agent
 *   - node-pty installed: npm install --save-dev node-pty
 *
 * Tests are skipped automatically if either is missing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

// ─── Prerequisite check ─────────────────────────────────────────────

let createInteractiveMock, text, script, bash;
let skipReason = "";

try {
  const pty = await import("node-pty");
  // Verify PTY actually works (fails in sandboxed/restricted environments)
  const probe = pty.spawn("/bin/echo", ["ok"], { name: "xterm", cols: 80, rows: 24 });
  await new Promise((resolve, reject) => {
    probe.onExit(() => resolve());
    setTimeout(() => { probe.kill(); reject(new Error("probe timeout")); }, 3000);
  });
} catch (err) {
  if (err.message.includes("MODULE_NOT_FOUND") || err.message.includes("Cannot find")) {
    skipReason = "node-pty not installed (npm install --save-dev node-pty)";
  } else {
    skipReason = `PTY unavailable in this environment: ${err.message}`;
  }
}

if (!skipReason) {
  try {
    const mod = await import("../dist/index.js");
    createInteractiveMock = mod.createInteractiveMock;
    text = mod.text;
    script = mod.script;
    bash = mod.bash;
  } catch (err) {
    skipReason = `Failed to import pi-mock: ${err.message}`;
  }
}

// ─── HTTP client for management API ─────────────────────────────────

function mgmt(port, method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const headers = {};
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    if (token) headers["x-pi-mock-token"] = token;
    const req = request(
      { hostname: "127.0.0.1", port, method, path, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
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

const TIMEOUT = 60_000;

// ═══════════════════════════════════════════════════════════════════
// 1. Basic interactive flow — submit prompt, verify brain gets request
// ═══════════════════════════════════════════════════════════════════
test("interactive: basic submit and brain request", { skip: skipReason || false }, async () => {
  const mock = await createInteractiveMock({
    brain: script(text("Hello from interactive mock!")),
    startupTimeoutMs: 15_000,
  });

  try {
    // Submit a prompt
    mock.submit("say hello");

    // The brain should receive the request
    const { request: req } = await mock.waitForRequest(undefined, TIMEOUT);
    assert.ok(req.messages.length > 0, "brain should receive messages");

    const lastMsg = req.messages[req.messages.length - 1];
    assert.equal(lastMsg.role, "user", "last message should be from user");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 2. Output capture — verify terminal output contains brain response
// ═══════════════════════════════════════════════════════════════════
test("interactive: output contains brain response text", { skip: skipReason || false }, async () => {
  const mock = await createInteractiveMock({
    brain: script(text("The answer is 42.")),
    startupTimeoutMs: 15_000,
  });

  try {
    mock.submit("what is the answer");
    await mock.waitForOutput("42", TIMEOUT);
    assert.ok(mock.output.includes("42"), "stripped output should contain '42'");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 3. Management API — /_/status
// ═══════════════════════════════════════════════════════════════════
test("interactive: /_/status returns session info", { skip: skipReason || false }, async () => {
  const mock = await createInteractiveMock({
    brain: script(text("ok")),
    startupTimeoutMs: 15_000,
  });

  try {
    const { status, data } = await mgmt(mock.port, "GET", "/_/status", undefined, mock.token);
    assert.equal(status, 200);
    assert.equal(data.mode, "interactive");
    assert.equal(data.port, mock.port);
    assert.equal(typeof data.outputLength, "number");
    assert.equal(data.exited, false);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 4. Management API — /_/submit + /_/output
// ═══════════════════════════════════════════════════════════════════
test("interactive: /_/submit and /_/output via HTTP", { skip: skipReason || false }, async () => {
  const mock = await createInteractiveMock({
    brain: script(text("HTTP response works!")),
    startupTimeoutMs: 15_000,
  });

  try {
    // Submit via HTTP
    const submitRes = await mgmt(mock.port, "POST", "/_/submit", { message: "test http" }, mock.token);
    assert.equal(submitRes.status, 200);
    assert.equal(submitRes.data.ok, true);

    // Wait for brain to process
    await mock.waitForRequest(undefined, TIMEOUT);

    // Wait for output to contain the response
    await mock.waitForOutput("HTTP response works", TIMEOUT);

    // Fetch output via HTTP
    const outputRes = await mgmt(mock.port, "GET", "/_/output", undefined, mock.token);
    assert.equal(outputRes.status, 200);
    assert.ok(outputRes.data.output.includes("HTTP response works"), "output should contain brain response");
    assert.equal(typeof outputRes.data.length, "number");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 5. Management API — /_/submit with waitFor
// ═══════════════════════════════════════════════════════════════════
test("interactive: /_/submit with waitFor returns matched text", { skip: skipReason || false }, async () => {
  const mock = await createInteractiveMock({
    brain: script(text("Result: success")),
    startupTimeoutMs: 15_000,
  });

  try {
    const { status, data } = await mgmt(
      mock.port,
      "POST",
      "/_/submit",
      { message: "do it", waitFor: "success", timeout: TIMEOUT },
      mock.token,
    );
    assert.equal(status, 200);
    assert.equal(data.matched, "success");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 6. Management API — /_/requests
// ═══════════════════════════════════════════════════════════════════
test("interactive: /_/requests returns brain API calls", { skip: skipReason || false }, async () => {
  const mock = await createInteractiveMock({
    brain: script(text("done")),
    startupTimeoutMs: 15_000,
  });

  try {
    mock.submit("check requests");
    await mock.waitForRequest(undefined, TIMEOUT);

    const { status, data } = await mgmt(mock.port, "GET", "/_/requests", undefined, mock.token);
    assert.equal(status, 200);
    assert.ok(data.requests.length >= 1, `should have >=1 request, got ${data.requests.length}`);
    assert.ok(data.requests[0].messages, "request should have messages");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 7. Management API — /_/type + /_/send-key
// ═══════════════════════════════════════════════════════════════════
test("interactive: /_/type and /_/send-key", { skip: skipReason || false }, async () => {
  const mock = await createInteractiveMock({
    brain: script(text("typed input received")),
    startupTimeoutMs: 15_000,
  });

  try {
    // Type text via HTTP
    const typeRes = await mgmt(mock.port, "POST", "/_/type", { text: "hello from http" }, mock.token);
    assert.equal(typeRes.status, 200);
    assert.equal(typeRes.data.ok, true);

    // Send enter via HTTP to submit the typed text
    const keyRes = await mgmt(mock.port, "POST", "/_/send-key", { key: "enter" }, mock.token);
    assert.equal(keyRes.status, 200);
    assert.equal(keyRes.data.ok, true);

    // Brain should receive the request
    await mock.waitForRequest(undefined, TIMEOUT);
    assert.ok(mock.requests.length >= 1, "brain should have received request");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 8. Management API — /_/send-key with invalid key
// ═══════════════════════════════════════════════════════════════════
test("interactive: /_/send-key rejects unknown keys", { skip: skipReason || false }, async () => {
  const mock = await createInteractiveMock({
    brain: script(text("ok")),
    startupTimeoutMs: 15_000,
  });

  try {
    const { status, data } = await mgmt(mock.port, "POST", "/_/send-key", { key: "invalid-key" }, mock.token);
    assert.equal(status, 400);
    assert.ok(data.error.includes("unknown key"), `error should mention unknown key: ${data.error}`);
    assert.ok(Array.isArray(data.validKeys), "should list valid keys");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 9. Management API — /_/clear-output
// ═══════════════════════════════════════════════════════════════════
test("interactive: /_/clear-output resets buffer", { skip: skipReason || false }, async () => {
  const mock = await createInteractiveMock({
    brain: script(text("ok")),
    startupTimeoutMs: 15_000,
  });

  try {
    // Output should have startup text
    assert.ok(mock.output.length > 0, "should have startup output");

    // Clear via HTTP
    const clearRes = await mgmt(mock.port, "POST", "/_/clear-output", undefined, mock.token);
    assert.equal(clearRes.status, 200);

    // Output should be empty
    const outputRes = await mgmt(mock.port, "GET", "/_/output", undefined, mock.token);
    assert.equal(outputRes.data.length, 0, "output should be empty after clear");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 10. Management API — auth required
// ═══════════════════════════════════════════════════════════════════
test("interactive: management API rejects requests without token", { skip: skipReason || false }, async () => {
  const mock = await createInteractiveMock({
    brain: script(text("ok")),
    startupTimeoutMs: 15_000,
  });

  try {
    // No token
    const { status: s1 } = await mgmt(mock.port, "GET", "/_/status");
    assert.equal(s1, 403);

    // Wrong token
    const { status: s2 } = await mgmt(mock.port, "GET", "/_/status", undefined, "wrong-token");
    assert.equal(s2, 403);

    // Correct token works
    const { status: s3 } = await mgmt(mock.port, "GET", "/_/status", undefined, mock.token);
    assert.equal(s3, 200);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 11. Management API — /_/wait-for-output with regex
// ═══════════════════════════════════════════════════════════════════
test("interactive: /_/wait-for-output supports regex patterns", { skip: skipReason || false }, async () => {
  const mock = await createInteractiveMock({
    brain: script(text("count: 7 items found")),
    startupTimeoutMs: 15_000,
  });

  try {
    mock.submit("count items");

    // Wait for a regex pattern via HTTP (inline /regex/ syntax)
    const { status, data } = await mgmt(
      mock.port,
      "POST",
      "/_/wait-for-output",
      { pattern: "/\\d+ items/", timeout: TIMEOUT },
      mock.token,
    );
    assert.equal(status, 200);
    assert.ok(data.matched.includes("items"), `should match regex, got: ${data.matched}`);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 12. Management API — /_/resize
// ═══════════════════════════════════════════════════════════════════
test("interactive: /_/resize changes terminal dimensions", { skip: skipReason || false }, async () => {
  const mock = await createInteractiveMock({
    brain: script(text("ok")),
    startupTimeoutMs: 15_000,
  });

  try {
    const { status } = await mgmt(mock.port, "POST", "/_/resize", { cols: 80, rows: 24 }, mock.token);
    assert.equal(status, 200);

    // Bad input
    const { status: badStatus } = await mgmt(mock.port, "POST", "/_/resize", { cols: "big" }, mock.token);
    assert.equal(badStatus, 400);
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 13. Brain switching mid-session
// ═══════════════════════════════════════════════════════════════════
test("interactive: setBrain switches brain mid-session", { skip: skipReason || false }, async () => {
  let brainCallCount = 0;
  const mock = await createInteractiveMock({
    brain: () => {
      brainCallCount++;
      return text("brain-1");
    },
    startupTimeoutMs: 15_000,
  });

  try {
    // First prompt uses brain-1
    mock.submit("first prompt");
    await mock.waitForOutput("brain-1", TIMEOUT);
    const firstCount = brainCallCount;
    assert.ok(firstCount >= 1, "brain-1 should be called");

    // Switch brain
    let brain2Calls = 0;
    mock.setBrain(() => {
      brain2Calls++;
      return text("brain-2");
    });

    mock.clearOutput();
    mock.submit("second prompt");
    await mock.waitForOutput("brain-2", TIMEOUT);
    assert.ok(brain2Calls >= 1, "brain-2 should be called after switch");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 14. Programmatic API — clearOutput resets buffer
// ═══════════════════════════════════════════════════════════════════
test("interactive: clearOutput resets programmatic output", { skip: skipReason || false }, async () => {
  const mock = await createInteractiveMock({
    brain: script(text("ok")),
    startupTimeoutMs: 15_000,
  });

  try {
    assert.ok(mock.output.length > 0, "startup output should exist");
    assert.ok(mock.rawOutput.length > 0, "raw output should exist");

    mock.clearOutput();

    assert.equal(mock.output.length, 0, "output should be empty");
    assert.equal(mock.rawOutput.length, 0, "rawOutput should be empty");
  } finally {
    await mock.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// 15. Management API — /_/stop
// ═══════════════════════════════════════════════════════════════════
test("interactive: /_/stop shuts down cleanly", { skip: skipReason || false }, async () => {
  const mock = await createInteractiveMock({
    brain: script(text("ok")),
    startupTimeoutMs: 15_000,
  });

  const port = mock.port;
  const token = mock.token;

  const { status, data } = await mgmt(port, "POST", "/_/stop", undefined, token);
  assert.equal(status, 200);
  assert.equal(data.ok, true);

  // Give it time to shut down
  await new Promise((r) => setTimeout(r, 1000));

  // Subsequent requests should fail (connection refused)
  try {
    await mgmt(port, "GET", "/_/status", undefined, token);
    assert.fail("should have thrown connection error");
  } catch {
    // Expected — server is down
  }
});
