/**
 * Multi-provider API format translation.
 *
 * Translates between our universal BrainResponse and the wire formats
 * for Anthropic, OpenAI, and Google Generative AI.
 *
 * Each provider needs:
 *   1. parseRequest()  — incoming API request → normalized ApiRequest
 *   2. serializeResponse() — BrainResponse → provider-specific SSE/JSON
 */

import { randomUUID } from "node:crypto";
import type { ApiRequest, BrainResponse, ResponseBlock } from "./anthropic.js";
import { toSSE as anthropicToSSE } from "./anthropic.js";

// ─── Provider detection ──────────────────────────────────────────────

export type ProviderName = "anthropic" | "openai" | "openai-responses" | "google" | "unknown";

/**
 * Detect which provider format a request is using, based on URL path.
 */
export function detectProvider(method: string, path: string): ProviderName {
  // Anthropic: POST /v1/messages
  if (path.endsWith("/messages")) return "anthropic";

  // OpenAI: POST /v1/chat/completions (Chat Completions API)
  if (path.includes("/chat/completions")) return "openai";

  // OpenAI: POST /v1/responses (Responses API — used by pi for OpenAI models)
  if (path.endsWith("/responses")) return "openai-responses";

  // Google: POST /v1beta/models/...:generateContent or :streamGenerateContent
  if (path.includes(":generateContent") || path.includes(":streamGenerateContent")) return "google";

  return "unknown";
}

// ─── Anthropic (re-export existing) ──────────────────────────────────

export { anthropicToSSE };

// ─── OpenAI Chat Completions ─────────────────────────────────────────

export function parseOpenAIRequest(body: Record<string, unknown>): ApiRequest {
  const messages = (body.messages as Array<Record<string, unknown>>) ?? [];
  return {
    model: (body.model as string) ?? "unknown",
    messages: messages.map((m) => ({
      role: (m.role as string) ?? "user",
      content: m.content as string | Array<Record<string, unknown>>,
    })),
    tools: (body.tools as ApiRequest["tools"]) ?? undefined,
    max_tokens: (body.max_tokens as number) ?? (body.max_completion_tokens as number) ?? 4096,
    stream: (body.stream as boolean) ?? true,
  };
}

export function openaiToSSE(response: BrainResponse, model: string): string {
  if (!Array.isArray(response) && response.type === "error") {
    return `data: ${JSON.stringify({
      error: { message: response.message, type: "api_error", code: "mock_error" },
    })}\n\n`;
  }

  const blocks: ResponseBlock[] = Array.isArray(response) ? response : [response as ResponseBlock];
  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const out: string[] = [];

  // Warn about dropped thinking blocks — OpenAI Chat Completions has no thinking wire format
  const thinkingCount = blocks.filter(b => b.type === "thinking").length;
  if (thinkingCount > 0) {
    console.warn(`[pi-mock] ${thinkingCount} thinking block(s) dropped — OpenAI Chat Completions has no thinking wire format`);
  }

  // Role chunk
  out.push(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    })}\n\n`,
  );

  let toolCallIndex = 0;
  for (const b of blocks) {
    if (b.type === "text") {
      out.push(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { content: b.text }, finish_reason: null }],
        })}\n\n`,
      );
    }

    if (b.type === "tool_call") {
      const toolCallId = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      out.push(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolCallIndex++,
                    id: toolCallId,
                    type: "function",
                    function: { name: b.name, arguments: JSON.stringify(b.input) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
    }
  }

  // Finish chunk
  const hasToolUse = blocks.some((b) => b.type === "tool_call");
  out.push(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: hasToolUse ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    })}\n\n`,
  );

  out.push("data: [DONE]\n\n");
  return out.join("");
}

// ─── Google Generative AI ────────────────────────────────────────────

export function parseGoogleRequest(body: Record<string, unknown>): ApiRequest {
  const contents = (body.contents as Array<Record<string, unknown>>) ?? [];
  const messages = contents.map((c) => {
    const parts = (c.parts as Array<Record<string, unknown>>) ?? [];
    const textParts = parts
      .filter((p) => typeof p.text === "string")
      .map((p) => p.text as string);
    return {
      role: (c.role as string) === "model" ? "assistant" : "user",
      content: textParts.join("") as string | Array<Record<string, unknown>>,
    };
  });

  // Extract system instruction
  const systemInstruction = body.systemInstruction as Record<string, unknown> | undefined;
  let system: string | undefined;
  if (systemInstruction?.parts) {
    const sysParts = systemInstruction.parts as Array<Record<string, unknown>>;
    system = sysParts
      .filter((p) => typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
  }

  // Extract model from generationConfig or default
  const model = (body.model as string) ?? "gemini";

  return {
    model,
    messages,
    system,
    max_tokens: ((body.generationConfig as Record<string, unknown>)?.maxOutputTokens as number) ?? 8192,
    stream: true,
  };
}

export function googleToSSE(response: BrainResponse, _model: string): string {
  if (!Array.isArray(response) && response.type === "error") {
    return `data: ${JSON.stringify({
      error: { code: 500, message: response.message, status: "INTERNAL" },
    })}\n\n`;
  }

  const blocks: ResponseBlock[] = Array.isArray(response) ? response : [response as ResponseBlock];
  const out: string[] = [];

  // Filter to emittable blocks; warn about dropped thinking blocks
  const emittable = blocks.filter(b => b.type === "text" || b.type === "tool_call");
  const droppedCount = blocks.length - emittable.length;
  if (droppedCount > 0) {
    console.warn(`[pi-mock] ${droppedCount} thinking block(s) dropped — Google format has no thinking wire format`);
  }

  for (let i = 0; i < emittable.length; i++) {
    const b = emittable[i];
    const isLast = i === emittable.length - 1;

    if (b.type === "text") {
      out.push(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: b.text }], role: "model" },
              ...(isLast ? { finishReason: "STOP" } : {}),
            },
          ],
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 50,
            totalTokenCount: 150,
          },
        })}\n\n`,
      );
    }

    if (b.type === "tool_call") {
      out.push(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: b.name,
                      args: b.input,
                    },
                  },
                ],
                role: "model",
              },
              ...(isLast ? { finishReason: "STOP" } : {}),
            },
          ],
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 50,
            totalTokenCount: 150,
          },
        })}\n\n`,
      );
    }
  }

  return out.join("");
}

// ─── OpenAI Responses API (pi's default for OpenAI models) ──────────

export function parseOpenAIResponsesRequest(body: Record<string, unknown>): ApiRequest {
  const input = body.input;
  let messages: ApiRequest["messages"] = [];

  if (typeof input === "string") {
    messages = [{ role: "user", content: input }];
  } else if (Array.isArray(input)) {
    for (const item of input as Array<Record<string, unknown>>) {
      if (item.type === "message") {
        const content = item.content as Array<Record<string, unknown>> | undefined;
        const textParts = content?.filter(c => c.type === "input_text" || c.type === "output_text")
          .map(c => c.text as string);
        messages.push({ role: (item.role as string) ?? "user", content: textParts?.join("") ?? "" });
      } else if (item.type === "function_call") {
        messages.push({ role: "assistant", content: `[tool_call: ${item.name}(${item.arguments})]` });
      } else if (item.type === "function_call_output") {
        messages.push({ role: "user", content: (item.output as string) ?? "" });
      } else if (typeof item.role === "string") {
        // Plain message with role + content
        const content = item.content;
        if (typeof content === "string") {
          messages.push({ role: item.role, content });
        } else if (Array.isArray(content)) {
          const texts = (content as Array<Record<string, unknown>>)
            .filter(c => c.type === "input_text" || c.type === "output_text" || c.type === "text")
            .map(c => (c.text as string) ?? "");
          messages.push({ role: item.role, content: texts.join("") });
        }
      }
    }
  }

  return {
    model: (body.model as string) ?? "unknown",
    messages,
    system: body.instructions as string | undefined,
    tools: (body.tools as ApiRequest["tools"]) ?? undefined,
    max_tokens: (body.max_output_tokens as number) ?? 16384,
    stream: (body.stream as boolean) ?? true,
  };
}

function respSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function openaiResponsesToSSE(response: BrainResponse, model: string): string {
  if (!Array.isArray(response) && response.type === "error") {
    return respSSE("error", { type: "error", code: "server_error", message: response.message });
  }

  const blocks: ResponseBlock[] = Array.isArray(response) ? response : [response as ResponseBlock];
  const responseId = `resp_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const out: string[] = [];
  let seq = 0;

  // Warn about dropped thinking blocks — OpenAI Responses API has no thinking wire format
  const thinkingCount = blocks.filter(b => b.type === "thinking").length;
  if (thinkingCount > 0) {
    console.warn(`[pi-mock] ${thinkingCount} thinking block(s) dropped — OpenAI Responses API has no thinking wire format`);
  }

  out.push(respSSE("response.created", {
    type: "response.created",
    response: { id: responseId, status: "in_progress", model, output: [], usage: null },
    sequence_number: seq++,
  }));

  for (const b of blocks) {
    const itemId = `item_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    if (b.type === "text") {
      out.push(respSSE("response.output_item.added", {
        type: "response.output_item.added",
        item: { type: "message", id: itemId, role: "assistant", content: [] },
        sequence_number: seq++,
      }));
      out.push(respSSE("response.content_part.added", {
        type: "response.content_part.added",
        part: { type: "output_text", text: "" },
        sequence_number: seq++,
      }));
      out.push(respSSE("response.output_text.delta", {
        type: "response.output_text.delta", delta: b.text, sequence_number: seq++,
      }));
      out.push(respSSE("response.output_text.done", {
        type: "response.output_text.done", text: b.text, sequence_number: seq++,
      }));
      out.push(respSSE("response.output_item.done", {
        type: "response.output_item.done",
        item: { type: "message", id: itemId, role: "assistant", content: [{ type: "output_text", text: b.text }] },
        sequence_number: seq++,
      }));
    }

    if (b.type === "tool_call") {
      const callId = `call_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const argsJson = JSON.stringify(b.input);

      out.push(respSSE("response.output_item.added", {
        type: "response.output_item.added",
        item: { type: "function_call", id: itemId, call_id: callId, name: b.name, arguments: "" },
        sequence_number: seq++,
      }));
      out.push(respSSE("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta", delta: argsJson, sequence_number: seq++,
      }));
      out.push(respSSE("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done", arguments: argsJson, sequence_number: seq++,
      }));
      out.push(respSSE("response.output_item.done", {
        type: "response.output_item.done",
        item: { type: "function_call", id: itemId, call_id: callId, name: b.name, arguments: argsJson },
        sequence_number: seq++,
      }));
    }
  }

  out.push(respSSE("response.completed", {
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      model,
      output: blocks
        .filter((b) => b.type === "text" || b.type === "tool_call")
        .map((b) => {
          if (b.type === "text") return { type: "message", role: "assistant", content: [{ type: "output_text", text: b.text }] };
          if (b.type === "tool_call") return { type: "function_call", name: b.name, arguments: JSON.stringify(b.input) };
          return {};
        }),
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    },
    sequence_number: seq++,
  }));

  return out.join("");
}

// ─── Unified serializer ──────────────────────────────────────────────

export function serializeResponse(
  provider: ProviderName,
  response: BrainResponse,
  model: string,
): { contentType: string; body: string } {
  switch (provider) {
    case "anthropic":
      return { contentType: "text/event-stream", body: anthropicToSSE(response, model) };
    case "openai":
      return { contentType: "text/event-stream", body: openaiToSSE(response, model) };
    case "openai-responses":
      return { contentType: "text/event-stream", body: openaiResponsesToSSE(response, model) };
    case "google":
      return { contentType: "text/event-stream", body: googleToSSE(response, model) };
    default:
      return { contentType: "text/event-stream", body: anthropicToSSE(response, model) };
  }
}

// ─── Provider-specific error serialization ───────────────────────────

/**
 * Format an HTTP error body the way each provider's real API would.
 * This ensures the Anthropic/OpenAI/Google SDKs parse the error correctly
 * and include meaningful error messages that pi's retry logic can match.
 */
export function serializeProviderError(
  provider: ProviderName,
  status: number,
  message: string,
): { contentType: string; body: string } {
  switch (provider) {
    case "anthropic":
      return {
        contentType: "application/json",
        body: JSON.stringify({
          type: "error",
          error: {
            type: anthropicErrorType(status),
            message,
          },
        }),
      };

    case "openai":
    case "openai-responses":
      return {
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            message,
            type: openaiErrorType(status),
            code: String(status),
          },
        }),
      };

    case "google":
      return {
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: status,
            message,
            status: googleErrorStatus(status),
          },
        }),
      };

    default:
      return {
        contentType: "application/json",
        body: JSON.stringify({ type: "error", error: { type: "api_error", message } }),
      };
  }
}

function anthropicErrorType(status: number): string {
  switch (status) {
    case 400: return "invalid_request_error";
    case 401: return "authentication_error";
    case 403: return "permission_error";
    case 404: return "not_found_error";
    case 429: return "rate_limit_error";
    case 529: return "overloaded_error";
    default: return status >= 500 ? "api_error" : "invalid_request_error";
  }
}

function openaiErrorType(status: number): string {
  switch (status) {
    case 401: return "authentication_error";
    case 429: return "rate_limit_error";
    default: return status >= 500 ? "server_error" : "invalid_request_error";
  }
}

function googleErrorStatus(status: number): string {
  switch (status) {
    case 400: return "INVALID_ARGUMENT";
    case 401: return "UNAUTHENTICATED";
    case 403: return "PERMISSION_DENIED";
    case 404: return "NOT_FOUND";
    case 429: return "RESOURCE_EXHAUSTED";
    default: return status >= 500 ? "INTERNAL" : "UNKNOWN";
  }
}

export function parseRequest(
  provider: ProviderName,
  body: Record<string, unknown>,
): ApiRequest {
  switch (provider) {
    case "openai":
      return parseOpenAIRequest(body);
    case "openai-responses":
      return parseOpenAIResponsesRequest(body);
    case "google":
      return parseGoogleRequest(body);
    case "anthropic":
    default:
      return { ...body } as unknown as ApiRequest;
  }
}
