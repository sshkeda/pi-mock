/**
 * Anthropic Messages API — SSE serialization.
 *
 * Converts simple response objects into the streaming event protocol
 * that pi's Anthropic provider expects.
 */

import { randomUUID } from "node:crypto";

// ─── What the brain returns ─────────────────────────────────────────

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  name: string;
  input: Record<string, unknown>;
}

export interface ErrorBlock {
  type: "error";
  message: string;
}

/** HTTP-level error — gateway returns actual HTTP status codes (429, 500, etc.) */
export interface HttpErrorBlock {
  type: "http_error";
  status: number;
  message?: string;
  headers?: Record<string, string>;
  /**
   * If true, include `x-should-retry: false` header to bypass the Anthropic SDK's
   * built-in retries (2 by default). This sends errors straight to pi's own retry
   * logic, which is usually what you want for testing.
   *
   * Set to false to test the full SDK retry chain (each error triggers 3 HTTP requests).
   * Default: true
   */
  bypassSdkRetry?: boolean;
}

export type ResponseBlock = TextBlock | ThinkingBlock | ToolCallBlock;
export type BrainResponse = ResponseBlock | ResponseBlock[] | ErrorBlock | HttpErrorBlock;

export type Brain = (
  request: ApiRequest,
  index: number,
) => BrainResponse | Promise<BrainResponse>;

// ─── Builders ────────────────────────────────────────────────────────

export const text = (content: string): TextBlock => ({ type: "text", text: content });

export const toolCall = (name: string, input: Record<string, unknown>): ToolCallBlock =>
  ({ type: "tool_call", name, input });

export const bash = (command: string, timeout?: number): ToolCallBlock =>
  toolCall("bash", timeout != null ? { command, timeout } : { command });

export const edit = (path: string, oldText: string, newText: string): ToolCallBlock =>
  toolCall("edit", { path, oldText, newText });

export const writeTool = (path: string, content: string): ToolCallBlock =>
  toolCall("write", { path, content });

export const readTool = (path: string): ToolCallBlock =>
  toolCall("read", { path });

export const thinking = (content: string): ThinkingBlock => ({ type: "thinking", thinking: content });

export const error = (message: string): ErrorBlock => ({ type: "error", message });

// ─── HTTP error builders (trigger real API error handling in pi) ─────

/** Generic HTTP error. Returns actual HTTP status code to trigger SDK/pi error handling. */
export const httpError = (
  status: number,
  message?: string,
  headers?: Record<string, string>,
): HttpErrorBlock => ({
  type: "http_error",
  status,
  message,
  headers,
});

/**
 * 429 Too Many Requests — triggers pi's rate limit retry logic.
 * Includes retry-after header so pi/SDK know how long to wait.
 */
export const rateLimited = (retryAfterSeconds = 1): HttpErrorBlock => ({
  type: "http_error",
  status: 429,
  message: "rate limit exceeded",
  headers: { "retry-after": String(retryAfterSeconds) },
});

/** 529 Overloaded — Anthropic-specific overload error. Triggers pi's retry logic. */
export const overloaded = (message = "overloaded_error"): HttpErrorBlock => ({
  type: "http_error",
  status: 529,
  message,
});

/** 500 Internal Server Error. */
export const serverError = (message = "internal server error"): HttpErrorBlock => ({
  type: "http_error",
  status: 500,
  message,
});

/** 503 Service Unavailable. */
export const serviceUnavailable = (message = "service temporarily unavailable"): HttpErrorBlock => ({
  type: "http_error",
  status: 503,
  message,
});

// ─── Incoming request shape ─────────────────────────────────────────

export interface ApiRequest {
  model: string;
  messages: Array<{
    role: string;
    content: string | Array<Record<string, unknown>>;
  }>;
  tools?: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
  system?: string | Array<{ type: string; text: string }>;
  max_tokens: number;
  stream?: boolean;
  /** Which provider format this request came from. Set by gateway. */
  _provider?: string;
  /** HTTP request headers from the client. Set by gateway. */
  _headers?: Record<string, string>;
  /** Raw unparsed request body. Set by gateway. */
  _raw?: unknown;
}

// ─── SSE serialization ──────────────────────────────────────────────

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function toSSE(response: BrainResponse, model: string): string {
  // Error
  if (!Array.isArray(response) && response.type === "error") {
    return sse("error", {
      type: "error",
      error: { type: "api_error", message: response.message },
    });
  }

  const blocks: ResponseBlock[] = Array.isArray(response) ? response : [response as ResponseBlock];
  const hasToolUse = blocks.some((b) => b.type === "tool_call");
  const msgId = `msg_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const out: string[] = [];

  // message_start
  out.push(sse("message_start", {
    type: "message_start",
    message: {
      id: msgId, type: "message", role: "assistant", content: [],
      model, stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 0 },
    },
  }));

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];

    if (b.type === "thinking") {
      out.push(sse("content_block_start", {
        type: "content_block_start", index: i,
        content_block: { type: "thinking", thinking: "" },
      }));
      out.push(sse("content_block_delta", {
        type: "content_block_delta", index: i,
        delta: { type: "thinking_delta", thinking: b.thinking },
      }));
      out.push(sse("content_block_stop", { type: "content_block_stop", index: i }));
    }

    if (b.type === "text") {
      out.push(sse("content_block_start", {
        type: "content_block_start", index: i,
        content_block: { type: "text", text: "" },
      }));
      out.push(sse("content_block_delta", {
        type: "content_block_delta", index: i,
        delta: { type: "text_delta", text: b.text },
      }));
      out.push(sse("content_block_stop", { type: "content_block_stop", index: i }));
    }

    if (b.type === "tool_call") {
      const toolUseId = `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      out.push(sse("content_block_start", {
        type: "content_block_start", index: i,
        content_block: { type: "tool_use", id: toolUseId, name: b.name, input: {} },
      }));
      out.push(sse("content_block_delta", {
        type: "content_block_delta", index: i,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) },
      }));
      out.push(sse("content_block_stop", { type: "content_block_stop", index: i }));
    }
  }

  out.push(sse("message_delta", {
    type: "message_delta",
    delta: { stop_reason: hasToolUse ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 50 },
  }));
  out.push(sse("message_stop", { type: "message_stop" }));

  return out.join("");
}
