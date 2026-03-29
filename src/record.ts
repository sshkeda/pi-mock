/**
 * Record/Replay — capture real API sessions, replay them deterministically.
 *
 * Record: brain that forwards requests to the real API, parses responses,
 * stores them as a transcript. The transcript doubles as a hand-writable
 * scenario format.
 *
 * Replay: brain that loads a transcript and plays back responses by index.
 *
 *   const rec = createRecorder({ model: "claude-sonnet-4-20250514" });
 *   const mock = await createMock({ brain: rec.brain, network: { default: "allow" } });
 *   await mock.run("do something");
 *   await rec.save("./session.json");
 *
 *   const mock2 = await createMock({ brain: replay("./session.json") });
 *   await mock2.run("do something");  // deterministic, free, fast
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  type Brain,
  type ApiRequest,
  type BrainResponse,
  type ResponseBlock,
  type TextBlock,
  type ThinkingBlock,
  type ToolCallBlock,
  text,
} from "./anthropic.js";

// ─── Transcript types ────────────────────────────────────────────────

export interface TranscriptUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

/** Request fingerprint for divergence detection (not the full request). */
export interface RequestFingerprint {
  model: string;
  messageCount: number;
  lastUserPrefix: string;
  toolCount?: number;
}

export interface TranscriptTurn {
  response: ResponseBlock[];
  usage?: TranscriptUsage;
  /** Optional request fingerprint — included in recordings, omitted in hand-written scenarios. */
  request?: RequestFingerprint;
}

export interface Transcript {
  version: 1;
  recorded?: string;
  meta?: {
    provider?: string;
    model?: string;
    prompt?: string;
  };
  turns: TranscriptTurn[];
}

// ─── SSE parsing ─────────────────────────────────────────────────────

interface SSEEvent {
  event?: string;
  data: string;
}

/** Parse raw SSE text into structured events. */
function parseSSEEvents(raw: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  let currentEvent: string | undefined;
  let dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      dataLines.push(line.slice(6));
    } else if (line.trim() === "" && dataLines.length > 0) {
      events.push({ event: currentEvent, data: dataLines.join("\n") });
      currentEvent = undefined;
      dataLines = [];
    }
  }

  // Handle trailing event without final newline
  if (dataLines.length > 0) {
    events.push({ event: currentEvent, data: dataLines.join("\n") });
  }

  return events;
}

// ─── Anthropic SSE → BrainResponse ──────────────────────────────────

interface ParsedResponse {
  blocks: ResponseBlock[];
  usage: TranscriptUsage;
}

function parseAnthropicSSE(raw: string): ParsedResponse {
  const events = parseSSEEvents(raw);
  const blocks: ResponseBlock[] = [];
  const pending = new Map<number, {
    type: "text" | "thinking" | "tool_use";
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    partialJson?: string;
  }>();

  const usage: TranscriptUsage = { input_tokens: 0, output_tokens: 0 };

  for (const evt of events) {
    if (evt.data === "[DONE]") break;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(evt.data);
    } catch {
      continue;
    }

    const type = parsed.type as string;

    if (type === "message_start") {
      const msg = parsed.message as Record<string, unknown>;
      const u = msg?.usage as Record<string, number> | undefined;
      if (u) {
        usage.input_tokens = u.input_tokens ?? 0;
        usage.output_tokens = u.output_tokens ?? 0;
        if (u.cache_read_input_tokens) usage.cache_read_tokens = u.cache_read_input_tokens;
        if (u.cache_creation_input_tokens) usage.cache_write_tokens = u.cache_creation_input_tokens;
      }
    } else if (type === "content_block_start") {
      const index = parsed.index as number;
      const block = parsed.content_block as Record<string, unknown>;
      const blockType = block.type as string;

      if (blockType === "text") {
        pending.set(index, { type: "text", text: "" });
      } else if (blockType === "thinking") {
        pending.set(index, { type: "thinking", thinking: "" });
      } else if (blockType === "tool_use") {
        pending.set(index, {
          type: "tool_use",
          id: block.id as string,
          name: block.name as string,
          partialJson: "",
        });
      }
    } else if (type === "content_block_delta") {
      const index = parsed.index as number;
      const delta = parsed.delta as Record<string, unknown>;
      const deltaType = delta.type as string;
      const p = pending.get(index);
      if (!p) continue;

      if (deltaType === "text_delta" && p.type === "text") {
        p.text = (p.text ?? "") + (delta.text as string);
      } else if (deltaType === "thinking_delta" && p.type === "thinking") {
        p.thinking = (p.thinking ?? "") + (delta.thinking as string);
      } else if (deltaType === "input_json_delta" && p.type === "tool_use") {
        p.partialJson = (p.partialJson ?? "") + (delta.partial_json as string);
      }
    } else if (type === "content_block_stop") {
      const index = parsed.index as number;
      const p = pending.get(index);
      if (!p) continue;

      if (p.type === "text") {
        blocks.push({ type: "text", text: p.text ?? "" } as TextBlock);
      } else if (p.type === "thinking") {
        blocks.push({ type: "thinking", thinking: p.thinking ?? "" } as ThinkingBlock);
      } else if (p.type === "tool_use") {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(p.partialJson ?? "{}");
        } catch { /* malformed JSON from API — store as-is */ }
        blocks.push({
          type: "tool_call",
          name: p.name ?? "unknown",
          input,
        } as ToolCallBlock);
      }

      pending.delete(index);
    } else if (type === "message_delta") {
      const u = parsed.usage as Record<string, number> | undefined;
      if (u) {
        if (u.input_tokens != null) usage.input_tokens = u.input_tokens;
        if (u.output_tokens != null) usage.output_tokens = u.output_tokens;
        if (u.cache_read_input_tokens != null) usage.cache_read_tokens = u.cache_read_input_tokens;
        if (u.cache_creation_input_tokens != null) usage.cache_write_tokens = u.cache_creation_input_tokens;
      }
    }
  }

  return { blocks, usage };
}

// ─── OpenAI Chat Completions SSE → BrainResponse ────────────────────

function parseOpenAISSE(raw: string): ParsedResponse {
  const events = parseSSEEvents(raw);
  let textContent = "";
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  const usage: TranscriptUsage = { input_tokens: 0, output_tokens: 0 };

  for (const evt of events) {
    if (evt.data === "[DONE]") break;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(evt.data);
    } catch {
      continue;
    }

    const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
    if (!choices?.[0]) continue;

    const delta = choices[0].delta as Record<string, unknown> | undefined;
    if (!delta) continue;

    if (typeof delta.content === "string") {
      textContent += delta.content;
    }

    const tc = delta.tool_calls as Array<Record<string, unknown>> | undefined;
    if (tc) {
      for (const call of tc) {
        const idx = call.index as number;
        const fn = call.function as Record<string, unknown> | undefined;
        if (!toolCalls.has(idx)) {
          toolCalls.set(idx, {
            id: (call.id as string) ?? "",
            name: fn?.name as string ?? "",
            args: "",
          });
        }
        const entry = toolCalls.get(idx)!;
        if (fn?.name) entry.name = fn.name as string;
        if (fn?.arguments) entry.args += fn.arguments as string;
      }
    }

    const u = parsed.usage as Record<string, number> | undefined;
    if (u) {
      usage.input_tokens = u.prompt_tokens ?? 0;
      usage.output_tokens = u.completion_tokens ?? 0;
    }
  }

  const blocks: ResponseBlock[] = [];
  if (textContent) {
    blocks.push({ type: "text", text: textContent } as TextBlock);
  }
  for (const [, call] of toolCalls) {
    let input: Record<string, unknown> = {};
    try { input = JSON.parse(call.args || "{}"); } catch { /* */ }
    blocks.push({ type: "tool_call", name: call.name, input } as ToolCallBlock);
  }

  return { blocks, usage };
}

// ─── Provider forwarding ─────────────────────────────────────────────

type RecordProvider = "anthropic" | "openai";

function detectRecordProvider(model: string): RecordProvider {
  if (/^(claude|anthropic)/i.test(model)) return "anthropic";
  if (/^(gpt|o[134]-|openai|chatgpt)/i.test(model)) return "openai";
  // Default to anthropic (pi's primary provider)
  return "anthropic";
}

function getApiKey(provider: RecordProvider): string {
  const envKeys: Record<RecordProvider, string[]> = {
    anthropic: ["ANTHROPIC_API_KEY"],
    openai: ["OPENAI_API_KEY"],
  };

  for (const key of envKeys[provider] ?? []) {
    const val = process.env[key];
    if (val) return val;
  }

  throw new Error(
    `No API key found for ${provider}. Set ${envKeys[provider]?.[0] ?? "API_KEY"} environment variable.`,
  );
}

const PROVIDER_ENDPOINTS: Record<RecordProvider, string> = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
};

async function forwardToProvider(
  provider: RecordProvider,
  rawBody: Record<string, unknown>,
  model: string,
  apiKey: string,
): Promise<ParsedResponse> {
  // Replace mock model with real model
  const body = { ...rawBody, model, stream: true };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (provider === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
  } else if (provider === "openai") {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const endpoint = PROVIDER_ENDPOINTS[provider];
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`${provider} API error ${response.status}: ${errText.slice(0, 500)}`);
  }

  const sseText = await response.text();

  if (provider === "anthropic") {
    return parseAnthropicSSE(sseText);
  } else {
    return parseOpenAISSE(sseText);
  }
}

// ─── Request fingerprint ─────────────────────────────────────────────

function fingerprint(req: ApiRequest): RequestFingerprint {
  const messages = req.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  let lastUserPrefix = "";
  if (lastUser) {
    const content =
      typeof lastUser.content === "string"
        ? lastUser.content
        : JSON.stringify(lastUser.content);
    lastUserPrefix = content.slice(0, 200);
  }

  return {
    model: req.model,
    messageCount: messages.length,
    lastUserPrefix,
    toolCount: req.tools?.length,
  };
}

// ─── Recorder ────────────────────────────────────────────────────────

export interface RecorderOptions {
  /** Real model ID to forward to (e.g. "claude-sonnet-4-20250514"). */
  model: string;
  /** Provider. Auto-detected from model name if not specified. */
  provider?: RecordProvider;
  /** API key. Default: reads from ANTHROPIC_API_KEY / OPENAI_API_KEY. */
  apiKey?: string;
  /** Include request fingerprints for divergence detection. Default: true */
  includeRequests?: boolean;
  /** Called after each turn is recorded. */
  onTurn?: (turn: TranscriptTurn, index: number) => void;
}

export interface Recorder {
  /** The brain function — pass to createMock({ brain: rec.brain }). */
  brain: Brain;
  /** The accumulated transcript. */
  transcript: Transcript;
  /** Save transcript to a JSON file. */
  save(path: string): Promise<void>;
}

/**
 * Create a recording brain that forwards requests to a real API.
 *
 * ```typescript
 * const rec = createRecorder({ model: "claude-sonnet-4-20250514" });
 * const mock = await createMock({
 *   brain: rec.brain,
 *   network: { default: "allow" }, // extensions need real network
 * });
 * await mock.run("implement a todo app");
 * await rec.save("./session.json");
 * await mock.close();
 * ```
 */
export function createRecorder(options: RecorderOptions): Recorder {
  const provider = options.provider ?? detectRecordProvider(options.model);
  const apiKey = options.apiKey ?? getApiKey(provider);
  const includeRequests = options.includeRequests !== false;

  const transcript: Transcript = {
    version: 1,
    recorded: new Date().toISOString(),
    meta: {
      provider,
      model: options.model,
    },
    turns: [],
  };

  const brain: Brain = async (request, _index) => {
    const raw = (request._raw as Record<string, unknown>) ?? {};

    // Forward to real API
    const { blocks, usage } = await forwardToProvider(
      provider,
      raw,
      options.model,
      apiKey,
    );

    // Store in transcript
    const turn: TranscriptTurn = {
      response: blocks,
      usage,
    };
    if (includeRequests) {
      turn.request = fingerprint(request);
    }

    transcript.turns.push(turn);
    options.onTurn?.(turn, transcript.turns.length - 1);

    // Return to gateway for serialization to pi
    return blocks.length === 1 ? blocks[0] : blocks;
  };

  return {
    brain,
    transcript,
    async save(path: string) {
      writeFileSync(path, JSON.stringify(transcript, null, 2));
    },
  };
}

// ─── Replay ──────────────────────────────────────────────────────────

/**
 * Load a transcript and replay responses by index.
 *
 * Accepts two formats:
 *
 * 1. **Full transcript** (from recording or hand-written):
 *    ```json
 *    { "version": 1, "turns": [{ "response": [...] }, ...] }
 *    ```
 *
 * 2. **Simple array** (hand-written shorthand):
 *    ```json
 *    [
 *      [{ "type": "tool_call", "name": "bash", "input": { "command": "ls" } }],
 *      [{ "type": "text", "text": "Done." }]
 *    ]
 *    ```
 *
 * ```typescript
 * const mock = await createMock({
 *   brain: replay("./session.json"),
 *   extensions: ["./ext.ts"],
 *   sandbox: true,
 * });
 * ```
 */
export function replay(
  pathOrTranscript: string | Transcript | TranscriptTurn[] | BrainResponse[],
  options?: {
    /** Warn on request fingerprint divergence. Default: true */
    warnOnDivergence?: boolean;
    /** Called when a request diverges from the recorded fingerprint. */
    onDivergence?: (index: number, expected: RequestFingerprint, actual: RequestFingerprint) => void;
  },
): Brain {
  let turns: TranscriptTurn[];

  if (typeof pathOrTranscript === "string") {
    const raw = JSON.parse(readFileSync(pathOrTranscript, "utf-8"));
    turns = normalizeTranscript(raw);
  } else if (Array.isArray(pathOrTranscript)) {
    turns = normalizeTranscript(pathOrTranscript);
  } else {
    turns = (pathOrTranscript as Transcript).turns;
  }

  const warnOnDivergence = options?.warnOnDivergence !== false;
  let cursor = 0;

  return (request, _index) => {
    if (cursor >= turns.length) {
      return text("(replay exhausted — no more recorded responses)");
    }

    const turn = turns[cursor];

    // Divergence detection
    if (warnOnDivergence && turn.request) {
      const actual = fingerprint(request);
      const expected = turn.request;

      const diverged =
        actual.messageCount !== expected.messageCount ||
        !actual.lastUserPrefix.startsWith(expected.lastUserPrefix.slice(0, 50));

      if (diverged) {
        if (options?.onDivergence) {
          options.onDivergence(cursor, expected, actual);
        } else {
          console.error(
            `[pi-mock] replay divergence at turn ${cursor}: ` +
            `expected ${expected.messageCount} messages, got ${actual.messageCount}`,
          );
        }
      }
    }

    cursor++;
    const response = turn.response;
    return response.length === 1 ? response[0] : response;
  };
}

// ─── Format normalization ────────────────────────────────────────────

/**
 * Normalize various transcript formats into TranscriptTurn[].
 *
 * Supports:
 * - Full Transcript object: { version, turns: [...] }
 * - Array of TranscriptTurn: [{ response: [...] }, ...]
 * - Simple array of BrainResponse: [[{type:"text",...}], ...]
 * - Mixed: [{type:"text",...}, ...] (each element is a single response)
 */
function normalizeTranscript(raw: unknown): TranscriptTurn[] {
  // Full transcript object
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (obj.version && Array.isArray(obj.turns)) {
      return (obj.turns as TranscriptTurn[]).map(normalizeTurn);
    }
  }

  // Array
  if (!Array.isArray(raw)) {
    throw new Error("Invalid transcript: expected object with 'turns' or array");
  }

  // Detect format: is this an array of TranscriptTurns or an array of BrainResponses?
  if (raw.length === 0) return [];

  const first = raw[0];

  // Array of TranscriptTurn objects: [{ response: [...] }, ...]
  if (first && typeof first === "object" && !Array.isArray(first) && "response" in first) {
    return (raw as TranscriptTurn[]).map(normalizeTurn);
  }

  // Array of BrainResponse arrays: [[{type:"text",...}], ...]
  // Or array of single ResponseBlocks: [{type:"text",...}, ...]
  return raw.map((item): TranscriptTurn => {
    if (Array.isArray(item)) {
      return { response: item as ResponseBlock[] };
    }
    if (item && typeof item === "object" && "type" in item) {
      return { response: [item as ResponseBlock] };
    }
    throw new Error(`Invalid transcript entry: ${JSON.stringify(item).slice(0, 100)}`);
  });
}

function normalizeTurn(turn: TranscriptTurn): TranscriptTurn {
  // Ensure response is always an array
  if (!Array.isArray(turn.response)) {
    turn.response = [turn.response as unknown as ResponseBlock];
  }
  return turn;
}
