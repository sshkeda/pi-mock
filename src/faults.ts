/**
 * Fault injection — brain wrappers that simulate real-world API failures.
 *
 * These test pi's error handling, retry logic, and extension resilience.
 *
 * Key behavior note: The Anthropic SDK retries failed requests 2 times internally
 * before pi's own retry logic kicks in. By default, HttpErrorBlock responses include
 * `x-should-retry: false` to bypass SDK retries, so errors go straight to pi.
 * Set `bypassSdkRetry: false` on the error to test the full SDK retry chain.
 *
 *   flakyBrain(inner, { rate: 0.3 })     — 30% random failure rate
 *   errorAfter(3, inner)                  — 3 successes then errors forever
 *   failFirst(2, inner)                   — 2 errors then inner takes over
 *   failNth(3, inner)                     — only request #3 fails (0-indexed)
 */

import {
  type Brain,
  type BrainResponse,
  type HttpErrorBlock,
  overloaded,
} from "./anthropic.js";

// ─── Seeded PRNG (mulberry32) ────────────────────────────────────────

/**
 * Mulberry32 — fast 32-bit seeded PRNG. Returns values in [0, 1).
 * Deterministic given the same seed. Used instead of Math.random()
 * so test results are reproducible.
 */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Types ───────────────────────────────────────────────────────────

export interface FlakyOptions {
  /** Failure rate, 0–1. Default: 0.2 (20%) */
  rate?: number;
  /** Error to return on failure. Default: overloaded() */
  error?: HttpErrorBlock;
  /** PRNG seed for reproducible results. Default: 42 */
  seed?: number;
}

// ─── Brain wrappers ──────────────────────────────────────────────────

/**
 * Randomly fail a fraction of requests. Tests retry resilience.
 *
 * ```typescript
 * // 30% of requests return 429
 * flakyBrain(script(bash("ls"), text("done")), { rate: 0.3, error: rateLimited() })
 *
 * // 20% overloaded (default)
 * flakyBrain(myBrain, { rate: 0.2 })
 * ```
 */
export function flakyBrain(inner: Brain, options?: FlakyOptions): Brain {
  const rate = options?.rate ?? 0.2;
  const err = options?.error ?? overloaded();
  const random = mulberry32(options?.seed ?? 42);

  return (request, index) => {
    if (random() < rate) return err;
    return inner(request, index);
  };
}

/**
 * Succeed for the first `n` requests, then error forever.
 * Tests what happens when the API dies mid-session.
 *
 * Note: `n` counts HTTP requests, not logical turns. If the Anthropic SDK
 * retries (default: 2x), each "turn" may consume multiple request slots.
 * Use bypassSdkRetry: false on the error to control this.
 *
 * ```typescript
 * // Works for 3 requests, then 529 overloaded forever
 * errorAfter(3, script(bash("ls"), text("ok"), text("great")))
 *
 * // Works for 5 requests, then 429
 * errorAfter(5, myBrain, rateLimited(10))
 * ```
 */
export function errorAfter(n: number, inner: Brain, error?: HttpErrorBlock): Brain {
  const err = error ?? overloaded();
  let count = 0;

  return (request, index) => {
    if (count++ >= n) return err;
    return inner(request, index);
  };
}

/**
 * Fail the first `n` requests, then delegate to inner brain.
 * Tests retry recovery — pi should retry and eventually succeed.
 *
 * With default bypassSdkRetry (true), each failed request goes directly
 * to pi's retry logic. So failFirst(2, inner) means pi retries twice
 * before succeeding on the 3rd attempt.
 *
 * ```typescript
 * // Fail twice (pi retries), then succeed
 * failFirst(2, script(bash("ls"), text("done")))
 *
 * // Fail 3 times with 429, then succeed
 * failFirst(3, myBrain, rateLimited(1))
 * ```
 */
export function failFirst(n: number, inner: Brain, error?: HttpErrorBlock): Brain {
  const err = error ?? overloaded();
  let count = 0;

  return (request, index) => {
    if (count++ < n) return err;
    // After failing, inner brain starts fresh from index 0
    return inner(request, index - n);
  };
}

/**
 * Fail only the Nth request (0-indexed). All others pass through.
 * Tests recovery from a single transient failure mid-session.
 *
 * ```typescript
 * // Third request (index 2) fails, everything else works
 * failNth(2, script(bash("ls"), text("ok"), bash("cat"), text("done")))
 * ```
 */
export function failNth(n: number, inner: Brain, error?: HttpErrorBlock): Brain {
  const err = error ?? overloaded();
  let count = 0;

  return (request, index) => {
    const current = count++;
    if (current === n) return err;
    // Adjust index for inner brain — skip the failed slot
    const innerIndex = current > n ? index - 1 : index;
    return inner(request, innerIndex);
  };
}

/**
 * Cycle between errors and successes. Useful for testing intermittent failures.
 *
 * ```typescript
 * // Alternates: fail, succeed, fail, succeed...
 * intermittent(inner, { pattern: [false, true] })
 *
 * // Fail 2, succeed 1, repeat
 * intermittent(inner, { pattern: [false, false, true] })
 * ```
 */
export function intermittent(
  inner: Brain,
  options: { pattern: boolean[]; error?: HttpErrorBlock },
): Brain {
  const err = options.error ?? overloaded();
  const pattern = options.pattern;
  let count = 0;
  let errorsSeen = 0;

  return (request, index) => {
    const shouldSucceed = pattern[count % pattern.length];
    count++;
    if (!shouldSucceed) {
      errorsSeen++;
      return err;
    }
    // Adjust index for inner brain — skip the error slots so script() cursors stay in sync
    return inner(request, index - errorsSeen);
  };
}
