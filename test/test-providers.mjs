/**
 * Unit tests for multi-provider parsing, serialization, and error formatting.
 *
 * Tests providers.ts (499 lines) which previously had zero test coverage.
 * Covers: detectProvider, parseRequest, serializeResponse, serializeProviderError
 * for Anthropic, OpenAI Chat, OpenAI Responses, and Google Gemini.
 */
import {
  detectProvider,
  parseRequest,
  serializeResponse,
  serializeProviderError,
} from "../dist/providers.js";
import { text, bash, toolCall, thinking, error } from "../dist/index.js";

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

// ═══════════════════════════════════════════════════════════════════
// detectProvider
// ═══════════════════════════════════════════════════════════════════

await test("detectProvider — Anthropic", () => {
  assert(detectProvider("POST", "/v1/messages") === "anthropic", "/v1/messages");
  assert(detectProvider("POST", "/api/v1/messages") === "anthropic", "nested /messages");
});

await test("detectProvider — OpenAI Chat Completions", () => {
  assert(detectProvider("POST", "/v1/chat/completions") === "openai", "/v1/chat/completions");
});

await test("detectProvider — OpenAI Responses API", () => {
  assert(detectProvider("POST", "/v1/responses") === "openai-responses", "/v1/responses");
});

await test("detectProvider — Google Gemini", () => {
  assert(
    detectProvider("POST", "/v1beta/models/gemini-pro:generateContent") === "google",
    "generateContent",
  );
  assert(
    detectProvider("POST", "/v1beta/models/gemini-pro:streamGenerateContent") === "google",
    "streamGenerateContent",
  );
});

await test("detectProvider — unknown path", () => {
  assert(detectProvider("POST", "/v1/foo") === "unknown", "unknown");
  assert(detectProvider("GET", "/health") === "unknown", "health");
});

// ═══════════════════════════════════════════════════════════════════
// parseRequest — Anthropic (passthrough)
// ═══════════════════════════════════════════════════════════════════

await test("parseRequest — Anthropic passthrough", () => {
  const body = {
    model: "claude-sonnet-4-20250514",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 1024,
    stream: true,
  };
  const req = parseRequest("anthropic", body);
  assert(req.model === "claude-sonnet-4-20250514", `model: ${req.model}`);
  assert(req.messages.length === 1, `messages: ${req.messages.length}`);
  assert(req.max_tokens === 1024, `max_tokens: ${req.max_tokens}`);
});

// ═══════════════════════════════════════════════════════════════════
// parseRequest — OpenAI Chat Completions
// ═══════════════════════════════════════════════════════════════════

await test("parseRequest — OpenAI Chat Completions", () => {
  const body = {
    model: "gpt-4",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hello" },
    ],
    max_tokens: 2048,
    stream: true,
    tools: [{ type: "function", function: { name: "bash", description: "run bash" } }],
  };
  const req = parseRequest("openai", body);
  assert(req.model === "gpt-4", `model: ${req.model}`);
  assert(req.messages.length === 2, `messages: ${req.messages.length}`);
  assert(req.messages[0].role === "system", `role: ${req.messages[0].role}`);
  assert(req.max_tokens === 2048, `max_tokens: ${req.max_tokens}`);
  assert(req.stream === true, `stream: ${req.stream}`);
});

await test("parseRequest — OpenAI defaults", () => {
  const req = parseRequest("openai", {});
  assert(req.model === "unknown", `model default: ${req.model}`);
  assert(req.max_tokens === 4096, `max_tokens default: ${req.max_tokens}`);
  assert(Array.isArray(req.messages), "messages should be array");
});

// ═══════════════════════════════════════════════════════════════════
// parseRequest — OpenAI Responses API
// ═══════════════════════════════════════════════════════════════════

await test("parseRequest — OpenAI Responses API (string input)", () => {
  const body = {
    model: "gpt-4",
    input: "hello world",
    max_output_tokens: 4096,
    instructions: "be helpful",
  };
  const req = parseRequest("openai-responses", body);
  assert(req.model === "gpt-4", `model: ${req.model}`);
  assert(req.messages.length === 1, `messages: ${req.messages.length}`);
  assert(req.messages[0].role === "user", `role: ${req.messages[0].role}`);
  assert(req.messages[0].content === "hello world", `content: ${req.messages[0].content}`);
  assert(req.system === "be helpful", `system: ${req.system}`);
  assert(req.max_tokens === 4096, `max_tokens: ${req.max_tokens}`);
});

await test("parseRequest — OpenAI Responses API (array input)", () => {
  const body = {
    model: "gpt-4",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "function_call", name: "bash", arguments: '{"command":"ls"}' },
      { type: "function_call_output", output: "file1.txt" },
    ],
  };
  const req = parseRequest("openai-responses", body);
  assert(req.messages.length === 3, `messages: ${req.messages.length}`);
  assert(req.messages[0].content === "hello", `first msg: ${req.messages[0].content}`);
  assert(req.messages[1].role === "assistant", `function_call role: ${req.messages[1].role}`);
  assert(req.messages[2].content === "file1.txt", `output: ${req.messages[2].content}`);
});

// ═══════════════════════════════════════════════════════════════════
// parseRequest — Google Gemini
// ═══════════════════════════════════════════════════════════════════

await test("parseRequest — Google Gemini", () => {
  const body = {
    contents: [
      { role: "user", parts: [{ text: "hello" }] },
      { role: "model", parts: [{ text: "hi there" }] },
    ],
    systemInstruction: { parts: [{ text: "be helpful" }] },
    generationConfig: { maxOutputTokens: 2048 },
  };
  const req = parseRequest("google", body);
  assert(req.messages.length === 2, `messages: ${req.messages.length}`);
  assert(req.messages[0].role === "user", `user role: ${req.messages[0].role}`);
  assert(req.messages[1].role === "assistant", `model→assistant: ${req.messages[1].role}`);
  assert(req.system === "be helpful", `system: ${req.system}`);
  assert(req.max_tokens === 2048, `max_tokens: ${req.max_tokens}`);
});

await test("parseRequest — Google Gemini defaults", () => {
  const req = parseRequest("google", {});
  assert(req.model === "gemini", `model default: ${req.model}`);
  assert(req.max_tokens === 8192, `max_tokens default: ${req.max_tokens}`);
});

// ═══════════════════════════════════════════════════════════════════
// serializeResponse — Anthropic SSE
// ═══════════════════════════════════════════════════════════════════

await test("serializeResponse — Anthropic text", () => {
  const { contentType, body } = serializeResponse("anthropic", text("hello"), "claude");
  assert(contentType === "text/event-stream", `contentType: ${contentType}`);
  assert(body.includes("message_start"), "has message_start");
  assert(body.includes("content_block_start"), "has content_block_start");
  assert(body.includes('"hello"'), "has text content");
  assert(body.includes("message_stop"), "has message_stop");
  assert(body.includes('"stop_reason":"end_turn"'), "stop_reason end_turn");
});

await test("serializeResponse — Anthropic tool_call", () => {
  const { body } = serializeResponse("anthropic", bash("ls -la"), "claude");
  assert(body.includes('"type":"tool_use"'), "has tool_use block");
  assert(body.includes('"name":"bash"'), "has bash name");
  assert(body.includes("input_json_delta"), "has input_json_delta");
  assert(body.includes('"stop_reason":"tool_use"'), "stop_reason tool_use");
});

await test("serializeResponse — Anthropic thinking block", () => {
  const { body } = serializeResponse("anthropic", thinking("let me think..."), "claude");
  assert(body.includes('"type":"thinking"'), "has thinking block");
  assert(body.includes("thinking_delta"), "has thinking_delta");
  assert(body.includes("let me think..."), "has thinking content");
});

await test("serializeResponse — Anthropic multiple blocks", () => {
  const response = [thinking("hmm"), bash("ls"), text("done")];
  const { body } = serializeResponse("anthropic", response, "claude");
  assert(body.includes("thinking_delta"), "has thinking");
  assert(body.includes('"name":"bash"'), "has bash");
  assert(body.includes('"done"'), "has text");
});

await test("serializeResponse — Anthropic error", () => {
  const { body } = serializeResponse("anthropic", error("something broke"), "claude");
  assert(body.includes("api_error"), "has error type");
  assert(body.includes("something broke"), "has error message");
});

// ═══════════════════════════════════════════════════════════════════
// serializeResponse — OpenAI Chat Completions SSE
// ═══════════════════════════════════════════════════════════════════

await test("serializeResponse — OpenAI Chat text", () => {
  const { contentType, body } = serializeResponse("openai", text("hello"), "gpt-4");
  assert(contentType === "text/event-stream", `contentType: ${contentType}`);
  assert(body.includes("chat.completion.chunk"), "has chunk object type");
  assert(body.includes('"role":"assistant"'), "has assistant role");
  assert(body.includes('"content":"hello"'), "has content");
  assert(body.includes('"finish_reason":"stop"'), "finish_reason stop");
  assert(body.includes("[DONE]"), "has [DONE]");
});

await test("serializeResponse — OpenAI Chat tool_call", () => {
  const { body } = serializeResponse("openai", bash("echo hi"), "gpt-4");
  assert(body.includes('"tool_calls"'), "has tool_calls");
  assert(body.includes('"name":"bash"'), "has bash name");
  assert(body.includes('"finish_reason":"tool_calls"'), "finish_reason tool_calls");
});

await test("serializeResponse — OpenAI Chat error", () => {
  const { body } = serializeResponse("openai", error("oops"), "gpt-4");
  assert(body.includes("mock_error"), "has error code");
  assert(body.includes("oops"), "has error message");
});

// ═══════════════════════════════════════════════════════════════════
// serializeResponse — OpenAI Responses API SSE
// ═══════════════════════════════════════════════════════════════════

await test("serializeResponse — OpenAI Responses text", () => {
  const { contentType, body } = serializeResponse("openai-responses", text("hello"), "gpt-4");
  assert(contentType === "text/event-stream", `contentType: ${contentType}`);
  assert(body.includes("response.created"), "has response.created");
  assert(body.includes("response.output_text.delta"), "has text delta");
  assert(body.includes("response.output_text.done"), "has text done");
  assert(body.includes("response.completed"), "has response.completed");
  assert(body.includes('"hello"'), "has text content");
});

await test("serializeResponse — OpenAI Responses tool_call", () => {
  const { body } = serializeResponse("openai-responses", bash("ls"), "gpt-4");
  assert(body.includes("response.function_call_arguments.delta"), "has fn args delta");
  assert(body.includes("response.function_call_arguments.done"), "has fn args done");
  assert(body.includes('"name":"bash"'), "has bash name");
  assert(body.includes('"type":"function_call"'), "has function_call type");
});

await test("serializeResponse — OpenAI Responses error", () => {
  const { body } = serializeResponse("openai-responses", error("broken"), "gpt-4");
  assert(body.includes("server_error"), "has error code");
  assert(body.includes("broken"), "has error message");
});

// ═══════════════════════════════════════════════════════════════════
// serializeResponse — Google Gemini SSE
// ═══════════════════════════════════════════════════════════════════

await test("serializeResponse — Google Gemini text", () => {
  const { contentType, body } = serializeResponse("google", text("hello"), "gemini-pro");
  assert(contentType === "text/event-stream", `contentType: ${contentType}`);
  assert(body.includes('"candidates"'), "has candidates");
  assert(body.includes('"role":"model"'), "has model role");
  assert(body.includes('"text":"hello"'), "has text in parts");
  assert(body.includes('"finishReason":"STOP"'), "has STOP finish");
});

await test("serializeResponse — Google Gemini tool_call", () => {
  const { body } = serializeResponse("google", bash("echo test"), "gemini-pro");
  assert(body.includes('"functionCall"'), "has functionCall");
  assert(body.includes('"name":"bash"'), "has bash name");
});

await test("serializeResponse — Google Gemini error", () => {
  const { body } = serializeResponse("google", error("bad"), "gemini-pro");
  assert(body.includes('"code":500'), "has error code");
  assert(body.includes('"status":"INTERNAL"'), "has INTERNAL status");
  assert(body.includes("bad"), "has error message");
});

// ═══════════════════════════════════════════════════════════════════
// serializeProviderError — HTTP error body formatting
// ═══════════════════════════════════════════════════════════════════

await test("serializeProviderError — Anthropic 429", () => {
  const { contentType, body } = serializeProviderError("anthropic", 429, "rate limited");
  assert(contentType === "application/json", `ct: ${contentType}`);
  const parsed = JSON.parse(body);
  assert(parsed.type === "error", `type: ${parsed.type}`);
  assert(parsed.error.type === "rate_limit_error", `error type: ${parsed.error.type}`);
  assert(parsed.error.message === "rate limited", `msg: ${parsed.error.message}`);
});

await test("serializeProviderError — Anthropic 529", () => {
  const { body } = serializeProviderError("anthropic", 529, "overloaded");
  const parsed = JSON.parse(body);
  assert(parsed.error.type === "overloaded_error", `error type: ${parsed.error.type}`);
});

await test("serializeProviderError — Anthropic 500", () => {
  const { body } = serializeProviderError("anthropic", 500, "server error");
  const parsed = JSON.parse(body);
  assert(parsed.error.type === "api_error", `error type: ${parsed.error.type}`);
});

await test("serializeProviderError — OpenAI 429", () => {
  const { body } = serializeProviderError("openai", 429, "rate limited");
  const parsed = JSON.parse(body);
  assert(parsed.error.type === "rate_limit_error", `error type: ${parsed.error.type}`);
  assert(parsed.error.code === "429", `code: ${parsed.error.code}`);
});

await test("serializeProviderError — OpenAI 500", () => {
  const { body } = serializeProviderError("openai", 500, "server error");
  const parsed = JSON.parse(body);
  assert(parsed.error.type === "server_error", `error type: ${parsed.error.type}`);
});

await test("serializeProviderError — OpenAI Responses 429", () => {
  const { body } = serializeProviderError("openai-responses", 429, "rate limited");
  const parsed = JSON.parse(body);
  assert(parsed.error.type === "rate_limit_error", `type: ${parsed.error.type}`);
});

await test("serializeProviderError — Google 429", () => {
  const { body } = serializeProviderError("google", 429, "rate limited");
  const parsed = JSON.parse(body);
  assert(parsed.error.code === 429, `code: ${parsed.error.code}`);
  assert(parsed.error.status === "RESOURCE_EXHAUSTED", `status: ${parsed.error.status}`);
});

await test("serializeProviderError — Google 500", () => {
  const { body } = serializeProviderError("google", 500, "internal");
  const parsed = JSON.parse(body);
  assert(parsed.error.status === "INTERNAL", `status: ${parsed.error.status}`);
});

await test("serializeProviderError — Google 403", () => {
  const { body } = serializeProviderError("google", 403, "forbidden");
  const parsed = JSON.parse(body);
  assert(parsed.error.status === "PERMISSION_DENIED", `status: ${parsed.error.status}`);
});

// ═══════════════════════════════════════════════════════════════════
// serializeResponse — fallback to Anthropic for unknown provider
// ═══════════════════════════════════════════════════════════════════

await test("serializeResponse — unknown provider falls back to Anthropic", () => {
  const { body } = serializeResponse("unknown", text("fallback"), "model");
  assert(body.includes("message_start"), "uses Anthropic format");
  assert(body.includes("fallback"), "has content");
});

// ═══════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════
console.error(`\n${"═".repeat(60)}`);
console.error(`Provider tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.error(`${"═".repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
