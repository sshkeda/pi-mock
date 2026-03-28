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

export type ProviderName = "anthropic" | "openai" | "google" | "unknown";

/**
 * Detect which provider format a request is using, based on URL path.
 */
export function detectProvider(method: string, path: string): ProviderName {
  // Anthropic: POST /v1/messages
  if (path.endsWith("/messages")) return "anthropic";

  // OpenAI: POST /v1/chat/completions
  if (path.includes("/chat/completions")) return "openai";

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
                    index: 0,
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

  for (const b of blocks) {
    if (b.type === "text") {
      out.push(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: b.text }], role: "model" },
              finishReason: "STOP",
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
              finishReason: "STOP",
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
    case "google":
      return { contentType: "text/event-stream", body: googleToSSE(response, model) };
    default:
      // Fallback to Anthropic
      return { contentType: "text/event-stream", body: anthropicToSSE(response, model) };
  }
}

export function parseRequest(
  provider: ProviderName,
  body: Record<string, unknown>,
): ApiRequest {
  switch (provider) {
    case "openai":
      return parseOpenAIRequest(body);
    case "google":
      return parseGoogleRequest(body);
    case "anthropic":
    default:
      return body as unknown as ApiRequest;
  }
}
