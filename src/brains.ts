/**
 * Brain helpers — composable brain factories for common test patterns.
 *
 * Brains are functions that receive an API request and return a response.
 * These helpers create brains for scripted sequences, controllable step-through,
 * echo responses, and more.
 */

import {
  type Brain,
  type ApiRequest,
  type BrainResponse,
  text,
} from "./anthropic.js";

// ─── Brain helpers ───────────────────────────────────────────────────

/** Brain that returns responses in order, then a default. */
export function script(...responses: BrainResponse[]): Brain {
  let i = 0;
  return () => (i < responses.length ? responses[i++] : text("(script exhausted)"));
}

/** Brain that repeats the same response forever. */
export function always(response: BrainResponse): Brain {
  return () => response;
}

/** Default brain — always responds with a simple text message. */
export function echo(): Brain {
  return (req) => {
    const lastMsg = req.messages?.[req.messages.length - 1];
    const content =
      typeof lastMsg?.content === "string"
        ? lastMsg.content
        : JSON.stringify(lastMsg?.content ?? "no message");
    return text(`Echo: ${content}`);
  };
}

// ─── Controllable brain ──────────────────────────────────────────────

export interface PendingCall {
  /** The API request pi sent. */
  request: ApiRequest;
  /** Which call this is (0-indexed). */
  index: number;
  /** Release the brain with this response. */
  respond(response: BrainResponse): void;
}

/** Filter predicate for waitForCall. */
export type CallFilter = (request: ApiRequest, index: number) => boolean;

export interface ControllableBrain {
  /** The brain function — pass this to createMock({ brain: cb.brain }). */
  brain: Brain;

  /** Wait for the next brain call. Blocks until pi makes an API request. */
  waitForCall(timeoutMs?: number): Promise<PendingCall>;

  /**
   * Wait for a brain call matching a filter. Non-matching calls stay
   * buffered for other waiters — no head-of-line blocking.
   *
   * ```typescript
   * // Filter by model name
   * const call = await cb.waitForCall({ model: "gpt-4" }, 3000);
   *
   * // Filter by predicate
   * const call = await cb.waitForCall(req => req.model.includes("claude"), 3000);
   * ```
   */
  waitForCall(filter: CallFilter | { model?: string; _provider?: string }, timeoutMs?: number): Promise<PendingCall>;

  /** Snapshot of pending (buffered, unresponded) calls. Useful for debugging. */
  pending(): PendingCall[];
}

/**
 * Create a brain where each call blocks until you explicitly respond.
 * Gives tests full control over timing and interleaving.
 *
 * Supports filtered waiting — when multiple clients hit the brain
 * concurrently, you can wait for a specific one by model name or
 * custom predicate. Non-matching calls stay buffered for other waiters.
 *
 * ```typescript
 * const cb = createControllableBrain();
 * const mock = await createMock({ brain: cb.brain, ... });
 * await mock.prompt("do something");
 * const call = await cb.waitForCall();
 * console.log(call.request.messages); // inspect what pi sent
 * call.respond(text("hello"));        // release the brain
 *
 * // Filtered — wait for a specific model
 * const gptCall = await cb.waitForCall({ model: "gpt-4" }, 3000);
 * const claudeCall = await cb.waitForCall(req => req.model.includes("claude"), 3000);
 * ```
 */
export function createControllableBrain(): ControllableBrain {
  type Entry = {
    request: ApiRequest;
    index: number;
    resolve: (response: BrainResponse) => void;
  };

  type Waiter = {
    filter: CallFilter | null;
    resolve: (call: PendingCall) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };

  // Queue of calls waiting for a response
  const pending: Entry[] = [];

  // Queue of waiters waiting for a call
  const waiters: Waiter[] = [];

  function wrap(entry: Entry): PendingCall {
    return {
      request: entry.request,
      index: entry.index,
      respond: (response: BrainResponse) => entry.resolve(response),
    };
  }

  /** Normalize a filter arg into a predicate or null (match-all). */
  function normalizeFilter(
    filter: CallFilter | { model?: string; _provider?: string } | null | undefined,
  ): CallFilter | null {
    if (!filter) return null;
    if (typeof filter === "function") return filter;
    // Object shorthand: { model?, _provider? }
    return (req: ApiRequest) => {
      if (filter.model !== undefined && req.model !== filter.model) return false;
      if (filter._provider !== undefined && req._provider !== filter._provider) return false;
      return true;
    };
  }

  const brain: Brain = (request, index) => {
    return new Promise<BrainResponse>((resolve) => {
      const entry: Entry = { request, index, resolve };

      // Try to deliver to the first matching waiter
      for (let i = 0; i < waiters.length; i++) {
        const w = waiters[i];
        if (!w.filter || w.filter(request, index)) {
          waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(wrap(entry));
          return;
        }
      }

      // No matching waiter — buffer the call
      pending.push(entry);
    });
  };

  return {
    brain,

    waitForCall(
      filterOrTimeout?: number | CallFilter | { model?: string; _provider?: string },
      timeoutMs?: number,
    ): Promise<PendingCall> {
      // Overload resolution: waitForCall(3000) vs waitForCall(filter, 3000)
      let filter: CallFilter | null;
      let timeout: number;
      if (typeof filterOrTimeout === "number" || filterOrTimeout === undefined) {
        filter = null;
        timeout = filterOrTimeout ?? 30_000;
      } else {
        filter = normalizeFilter(filterOrTimeout);
        timeout = timeoutMs ?? 30_000;
      }

      return new Promise<PendingCall>((resolve, reject) => {
        // Scan pending for the first matching call
        for (let i = 0; i < pending.length; i++) {
          const entry = pending[i];
          if (!filter || filter(entry.request, entry.index)) {
            pending.splice(i, 1);
            return resolve(wrap(entry));
          }
        }

        // No match yet — register a filtered waiter
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === resolve);
          if (idx >= 0) waiters.splice(idx, 1);
          const desc = filter ? " (with filter)" : "";
          reject(new Error(`waitForCall timeout after ${timeout}ms${desc}`));
        }, timeout);

        waiters.push({ filter, resolve, reject, timer });
      });
    },

    pending(): PendingCall[] {
      return pending.map(wrap);
    },
  };
}
