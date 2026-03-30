/**
 * Unit tests for multi-provider parsing, serialization, and error formatting.
 *
 * Tests providers.ts which previously had zero test coverage.
 * Covers: detectProvider, parseRequest, serializeResponse, serializeProviderError
 * for Anthropic, OpenAI Chat, OpenAI Responses, and Google Gemini.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectProvider,
  parseRequest,
  serializeResponse,
  serializeProviderError,
} from "../dist/providers.js";
import { text, bash, toolCall, thinking, error } from "../dist/index.js";

// ═══════════════════════════════════════════════════════════════════
// detectProvider
// ═══════════════════════════════════════════════════════════════════

test("detectProvider — Anthropic", () => {
  assert.equal(detectProvider("POST", "/v1/messages"), "anthropic", "/v1/messages");
  assert.equal(detectProvider("POST", "/api/v1/messages"), "anthropic", "nested /messages");
});

test("detectProvider — OpenAI Chat Completions", () => {
  assert.equal(detectProvider("POST", "/v1/chat/completions"), "openai", "/v1/chat/completions");
});

test("detectProvider — OpenAI Responses API", () => {
  assert.equal(detectProvider("POST", "/v1/responses"), "openai-responses", "/v1/responses");
});

test("detectProvider — Google Gemini", () => {
  assert.equal(
    detectProvider("POST", "/v1beta/models/gemini-pro:generateContent"),
    "google",
    "generateContent",
  );
  assert.equal(
    detectProvider("POST", "/v1beta/models/gemini-pro:streamGenerateContent"),
    "google",
    "streamGenerateContent",
  );
});

test("detectProvider — unknown path", () => {
  assert.equal(detectProvider("POST", "/v1/foo"), "unknown", "unknown");
  assert.equal(detectProvider("GET", "/health"), "unknown", "health");
});

// ═══════════════════════════════════════════════════════════════════
// parseRequest — Anthropic (passthrough)
// ═══════════════════════════════════════════════════════════════════

test("parseRequest — Anthropic passthrough", () => {
  const body = {
    model: "claude-sonnet-4-20250514",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 1024,
    stream: true,
  };
  const req = parseRequest("anthropic", body);
  assert.equal(req.model, "claude-sonnet-4-20250514");
  assert.equal(req.messages.length, 1);
  assert.equal(req.max_tokens, 1024);
});

// ═══════════════════════════════════════════════════════════════════
// parseRequest — OpenAI Chat Completions
// ═══════════════════════════════════════════════════════════════════

test("parseRequest — OpenAI Chat Completions", () => {
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
  assert.equal(req.model, "gpt-4");
  assert.equal(req.messages.length, 2);
  assert.equal(req.messages[0].role, "system");
  assert.equal(req.max_tokens, 2048);
  assert.equal(req.stream, true);
});

test("parseRequest — OpenAI defaults", () => {
  const req = parseRequest("openai", {});
  assert.equal(req.model, "unknown");
  assert.equal(req.max_tokens, 4096);
  assert.ok(Array.isArray(req.messages), "messages should be array");
});

// ═══════════════════════════════════════════════════════════════════
// parseRequest — OpenAI Responses API
// ═══════════════════════════════════════════════════════════════════

test("parseRequest — OpenAI Responses API (string input)", () => {
  const body = {
    model: "gpt-4",
    input: "hello world",
    max_output_tokens: 4096,
    instructions: "be helpful",
  };
  const req = parseRequest("openai-responses", body);
  assert.equal(req.model, "gpt-4");
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].role, "user");
  assert.equal(req.messages[0].content, "hello world");
  assert.equal(req.system, "be helpful");
  assert.equal(req.max_tokens, 4096);
});

test("parseRequest — OpenAI Responses API (array input)", () => {
  const body = {
    model: "gpt-4",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "function_call", name: "bash", arguments: '{"command":"ls"}' },
      { type: "function_call_output", output: "file1.txt" },
    ],
  };
  const req = parseRequest("openai-responses", body);
  assert.equal(req.messages.length, 3);
  assert.equal(req.messages[0].content, "hello");
  assert.equal(req.messages[1].role, "assistant");
  assert.ok(Array.isArray(req.messages[1].content), "function_call content should be structured array");
  assert.equal(req.messages[1].content[0].type, "function_call");
  assert.equal(req.messages[1].content[0].name, "bash");
  assert.equal(req.messages[2].role, "tool");
  assert.ok(Array.isArray(req.messages[2].content), "function_call_output content should be structured array");
  assert.equal(req.messages[2].content[0].output, "file1.txt");
});

// ═══════════════════════════════════════════════════════════════════
// parseRequest — Google Gemini
// ═══════════════════════════════════════════════════════════════════

test("parseRequest — Google Gemini", () => {
  const body = {
    contents: [
      { role: "user", parts: [{ text: "hello" }] },
      { role: "model", parts: [{ text: "hi there" }] },
    ],
    systemInstruction: { parts: [{ text: "be helpful" }] },
    generationConfig: { maxOutputTokens: 2048 },
  };
  const req = parseRequest("google", body);
  assert.equal(req.messages.length, 2);
  assert.equal(req.messages[0].role, "user");
  assert.equal(req.messages[1].role, "assistant");
  assert.equal(req.system, "be helpful");
  assert.equal(req.max_tokens, 2048);
});

test("parseRequest — Google Gemini defaults", () => {
  const req = parseRequest("google", {});
  assert.equal(req.model, "gemini");
  assert.equal(req.max_tokens, 8192);
});

// ═══════════════════════════════════════════════════════════════════
// serializeResponse — Anthropic SSE
// ═══════════════════════════════════════════════════════════════════

test("serializeResponse — Anthropic text", () => {
  const { contentType, body } = serializeResponse("anthropic", text("hello"), "claude");
  assert.equal(contentType, "text/event-stream");
  assert.ok(body.includes("message_start"), "has message_start");
  assert.ok(body.includes("content_block_start"), "has content_block_start");
  assert.ok(body.includes('"hello"'), "has text content");
  assert.ok(body.includes("message_stop"), "has message_stop");
  assert.ok(body.includes('"stop_reason":"end_turn"'), "stop_reason end_turn");
});

test("serializeResponse — Anthropic tool_call", () => {
  const { body } = serializeResponse("anthropic", bash("ls -la"), "claude");
  assert.ok(body.includes('"type":"tool_use"'), "has tool_use block");
  assert.ok(body.includes('"name":"bash"'), "has bash name");
  assert.ok(body.includes("input_json_delta"), "has input_json_delta");
  assert.ok(body.includes('"stop_reason":"tool_use"'), "stop_reason tool_use");
});

test("serializeResponse — Anthropic thinking block", () => {
  const { body } = serializeResponse("anthropic", thinking("let me think..."), "claude");
  assert.ok(body.includes('"type":"thinking"'), "has thinking block");
  assert.ok(body.includes("thinking_delta"), "has thinking_delta");
  assert.ok(body.includes("let me think..."), "has thinking content");
});

test("serializeResponse — Anthropic multiple blocks", () => {
  const response = [thinking("hmm"), bash("ls"), text("done")];
  const { body } = serializeResponse("anthropic", response, "claude");
  assert.ok(body.includes("thinking_delta"), "has thinking");
  assert.ok(body.includes('"name":"bash"'), "has bash");
  assert.ok(body.includes('"done"'), "has text");
});

test("serializeResponse — Anthropic error", () => {
  const { body } = serializeResponse("anthropic", error("something broke"), "claude");
  assert.ok(body.includes("api_error"), "has error type");
  assert.ok(body.includes("something broke"), "has error message");
});

// ═══════════════════════════════════════════════════════════════════
// serializeResponse — OpenAI Chat Completions SSE
// ═══════════════════════════════════════════════════════════════════

test("serializeResponse — OpenAI Chat text", () => {
  const { contentType, body } = serializeResponse("openai", text("hello"), "gpt-4");
  assert.equal(contentType, "text/event-stream");
  assert.ok(body.includes("chat.completion.chunk"), "has chunk object type");
  assert.ok(body.includes('"role":"assistant"'), "has assistant role");
  assert.ok(body.includes('"content":"hello"'), "has content");
  assert.ok(body.includes('"finish_reason":"stop"'), "finish_reason stop");
  assert.ok(body.includes("[DONE]"), "has [DONE]");
});

test("serializeResponse — OpenAI Chat tool_call", () => {
  const { body } = serializeResponse("openai", bash("echo hi"), "gpt-4");
  assert.ok(body.includes('"tool_calls"'), "has tool_calls");
  assert.ok(body.includes('"name":"bash"'), "has bash name");
  assert.ok(body.includes('"finish_reason":"tool_calls"'), "finish_reason tool_calls");
});

test("serializeResponse — OpenAI Chat error", () => {
  const { body } = serializeResponse("openai", error("oops"), "gpt-4");
  assert.ok(body.includes("mock_error"), "has error code");
  assert.ok(body.includes("oops"), "has error message");
});

// ═══════════════════════════════════════════════════════════════════
// serializeResponse — OpenAI Responses API SSE
// ═══════════════════════════════════════════════════════════════════

test("serializeResponse — OpenAI Responses text", () => {
  const { contentType, body } = serializeResponse("openai-responses", text("hello"), "gpt-4");
  assert.equal(contentType, "text/event-stream");
  assert.ok(body.includes("response.created"), "has response.created");
  assert.ok(body.includes("response.output_text.delta"), "has text delta");
  assert.ok(body.includes("response.output_text.done"), "has text done");
  assert.ok(body.includes("response.completed"), "has response.completed");
  assert.ok(body.includes('"hello"'), "has text content");
});

test("serializeResponse — OpenAI Responses tool_call", () => {
  const { body } = serializeResponse("openai-responses", bash("ls"), "gpt-4");
  assert.ok(body.includes("response.function_call_arguments.delta"), "has fn args delta");
  assert.ok(body.includes("response.function_call_arguments.done"), "has fn args done");
  assert.ok(body.includes('"name":"bash"'), "has bash name");
  assert.ok(body.includes('"type":"function_call"'), "has function_call type");
});

test("serializeResponse — OpenAI Responses error", () => {
  const { body } = serializeResponse("openai-responses", error("broken"), "gpt-4");
  assert.ok(body.includes("server_error"), "has error code");
  assert.ok(body.includes("broken"), "has error message");
});

// ═══════════════════════════════════════════════════════════════════
// serializeResponse — Google Gemini SSE
// ═══════════════════════════════════════════════════════════════════

test("serializeResponse — Google Gemini text", () => {
  const { contentType, body } = serializeResponse("google", text("hello"), "gemini-pro");
  assert.equal(contentType, "text/event-stream");
  assert.ok(body.includes('"candidates"'), "has candidates");
  assert.ok(body.includes('"role":"model"'), "has model role");
  assert.ok(body.includes('"text":"hello"'), "has text in parts");
  assert.ok(body.includes('"finishReason":"STOP"'), "has STOP finish");
});

test("serializeResponse — Google Gemini tool_call", () => {
  const { body } = serializeResponse("google", bash("echo test"), "gemini-pro");
  assert.ok(body.includes('"functionCall"'), "has functionCall");
  assert.ok(body.includes('"name":"bash"'), "has bash name");
});

test("serializeResponse — Google Gemini error", () => {
  const { body } = serializeResponse("google", error("bad"), "gemini-pro");
  assert.ok(body.includes('"code":500'), "has error code");
  assert.ok(body.includes('"status":"INTERNAL"'), "has INTERNAL status");
  assert.ok(body.includes("bad"), "has error message");
});

// ═══════════════════════════════════════════════════════════════════
// serializeProviderError — HTTP error body formatting
// ═══════════════════════════════════════════════════════════════════

test("serializeProviderError — Anthropic 429", () => {
  const { contentType, body } = serializeProviderError("anthropic", 429, "rate limited");
  assert.equal(contentType, "application/json");
  const parsed = JSON.parse(body);
  assert.equal(parsed.type, "error");
  assert.equal(parsed.error.type, "rate_limit_error");
  assert.equal(parsed.error.message, "rate limited");
});

test("serializeProviderError — Anthropic 529", () => {
  const { body } = serializeProviderError("anthropic", 529, "overloaded");
  const parsed = JSON.parse(body);
  assert.equal(parsed.error.type, "overloaded_error");
});

test("serializeProviderError — Anthropic 500", () => {
  const { body } = serializeProviderError("anthropic", 500, "server error");
  const parsed = JSON.parse(body);
  assert.equal(parsed.error.type, "api_error");
});

test("serializeProviderError — OpenAI 429", () => {
  const { body } = serializeProviderError("openai", 429, "rate limited");
  const parsed = JSON.parse(body);
  assert.equal(parsed.error.type, "rate_limit_error");
  assert.equal(parsed.error.code, "429");
});

test("serializeProviderError — OpenAI 500", () => {
  const { body } = serializeProviderError("openai", 500, "server error");
  const parsed = JSON.parse(body);
  assert.equal(parsed.error.type, "server_error");
});

test("serializeProviderError — OpenAI Responses 429", () => {
  const { body } = serializeProviderError("openai-responses", 429, "rate limited");
  const parsed = JSON.parse(body);
  assert.equal(parsed.error.type, "rate_limit_error");
});

test("serializeProviderError — Google 429", () => {
  const { body } = serializeProviderError("google", 429, "rate limited");
  const parsed = JSON.parse(body);
  assert.equal(parsed.error.code, 429);
  assert.equal(parsed.error.status, "RESOURCE_EXHAUSTED");
});

test("serializeProviderError — Google 500", () => {
  const { body } = serializeProviderError("google", 500, "internal");
  const parsed = JSON.parse(body);
  assert.equal(parsed.error.status, "INTERNAL");
});

test("serializeProviderError — Google 403", () => {
  const { body } = serializeProviderError("google", 403, "forbidden");
  const parsed = JSON.parse(body);
  assert.equal(parsed.error.status, "PERMISSION_DENIED");
});

// ═══════════════════════════════════════════════════════════════════
// serializeResponse — fallback to Anthropic for unknown provider
// ═══════════════════════════════════════════════════════════════════

test("serializeResponse — unknown provider falls back to Anthropic", () => {
  const { body } = serializeResponse("unknown", text("fallback"), "model");
  assert.ok(body.includes("message_start"), "uses Anthropic format");
  assert.ok(body.includes("fallback"), "has content");
});
