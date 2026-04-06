/**
 * Lightweight RPC client for pi's --mode rpc.
 *
 * Works with any ChildProcess that speaks JSONL on stdin/stdout.
 * No dependency on pi — just the wire protocol.
 */

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

// ─── Types ───────────────────────────────────────────────────────────

/** Any JSON event from pi's stdout. */
export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

/** RPC command response (type: "response"). */
export interface RpcResponse extends RpcEvent {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

/** Extension UI request that needs a reply. */
export interface ExtensionUIRequest extends RpcEvent {
  type: "extension_ui_request";
  id: string;
  method: string;
}

/** Handler for extension UI dialogs. Return the response payload. */
export type UIHandler = (req: ExtensionUIRequest) => Record<string, unknown> | undefined;

/** Captured notification from ctx.ui.notify(). */
export interface CapturedNotification {
  message: string;
  notifyType: "info" | "warning" | "error";
  timestamp: number;
}

/** Captured status update from ctx.ui.setStatus(). */
export interface CapturedStatusUpdate {
  key: string;
  text: string | undefined;
  timestamp: number;
}

/** Captured widget update from ctx.ui.setWidget(). */
export interface CapturedWidget {
  key: string;
  lines: string[] | undefined;
  placement?: "aboveEditor" | "belowEditor";
  timestamp: number;
}

export interface RpcClient {
  /** All events received so far. */
  readonly events: RpcEvent[];
  /** All notifications captured from ctx.ui.notify(). */
  readonly notifications: CapturedNotification[];
  /** All status updates captured from ctx.ui.setStatus(). */
  readonly statusUpdates: CapturedStatusUpdate[];
  /** All widget updates captured from ctx.ui.setWidget(). */
  readonly widgets: CapturedWidget[];
  /** Send a raw RPC command and wait for its response. */
  send(cmd: Record<string, unknown>, timeoutMs?: number): Promise<RpcResponse>;
  /** Wait for an event matching a predicate. Scans existing events from scanFrom first. */
  waitFor(pred: (e: RpcEvent) => boolean, timeoutMs?: number, scanFrom?: number): Promise<RpcEvent>;
  /** Wait for a notification matching a predicate. */
  waitForNotification(pred?: (n: CapturedNotification) => boolean, timeoutMs?: number): Promise<CapturedNotification>;
  /** Wait for a status update matching a predicate. */
  waitForStatusUpdate(pred?: (s: CapturedStatusUpdate) => boolean, timeoutMs?: number): Promise<CapturedStatusUpdate>;
  /** Subscribe to every event. Returns unsubscribe function. */
  on(listener: (e: RpcEvent) => void): () => void;
  /** Set handler for extension UI requests. */
  setUIHandler(handler: UIHandler): void;
  /** Write raw JSON to stdin (fire-and-forget). */
  write(obj: Record<string, unknown>): void;
}

// ─── Create ──────────────────────────────────────────────────────────

export function createRpcClient(proc: ChildProcess): RpcClient {
  const events: RpcEvent[] = [];
  const notifications: CapturedNotification[] = [];
  const statusUpdates: CapturedStatusUpdate[] = [];
  const widgets: CapturedWidget[] = [];
  const notificationListeners = new Set<(n: CapturedNotification) => void>();
  const statusListeners = new Set<(s: CapturedStatusUpdate) => void>();
  const listeners = new Set<(e: RpcEvent) => void>();
  let uiHandler: UIHandler | undefined;

  // Pending command responses keyed by id
  const pending = new Map<
    string,
    { resolve: (r: RpcResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  // ── JSONL parser on stdout ──
  // Uses manual \n splitting — NOT readline (which splits on U+2028/2029).
  // Uses StringDecoder to correctly handle multi-byte UTF-8 sequences
  // split across pipe chunks (without it, chunk.toString() corrupts them
  // into U+FFFD replacement characters).
  const decoder = new StringDecoder("utf8");
  let buf = "";

  proc.stdout!.on("data", (chunk: Buffer) => {
    buf += decoder.write(chunk);
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;

      let ev: RpcEvent;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }

      events.push(ev);

      // Dispatch response to pending command
      if (ev.type === "response" && typeof (ev as RpcResponse).id === "string") {
        const p = pending.get((ev as RpcResponse).id!);
        if (p) {
          pending.delete((ev as RpcResponse).id!);
          clearTimeout(p.timer);
          p.resolve(ev as RpcResponse);
        }
      }

      // Auto-respond to extension UI requests
      if (ev.type === "extension_ui_request") {
        const uiReq = ev as ExtensionUIRequest;
        const dialogMethods = new Set(["select", "confirm", "input", "editor"]);

        if (uiReq.method === "notify") {
          // Capture notification
          const n: CapturedNotification = {
            message: (uiReq as any).message ?? "",
            notifyType: (uiReq as any).notifyType ?? "info",
            timestamp: Date.now(),
          };
          notifications.push(n);
          for (const l of notificationListeners) l(n);
          // Acknowledge (pi doesn't block on this, but send response for completeness)
          write({ type: "extension_ui_response", id: uiReq.id, cancelled: true });
        } else if (uiReq.method === "setStatus") {
          // Capture status update
          const s: CapturedStatusUpdate = {
            key: (uiReq as any).statusKey ?? "",
            text: (uiReq as any).statusText,
            timestamp: Date.now(),
          };
          statusUpdates.push(s);
          for (const l of statusListeners) l(s);
          write({ type: "extension_ui_response", id: uiReq.id, cancelled: true });
        } else if (uiReq.method === "setWidget") {
          // Capture widget update
          const w: CapturedWidget = {
            key: (uiReq as any).widgetKey ?? "",
            lines: (uiReq as any).widgetLines,
            placement: (uiReq as any).widgetPlacement,
            timestamp: Date.now(),
          };
          widgets.push(w);
          write({ type: "extension_ui_response", id: uiReq.id, cancelled: true });
        } else if (uiReq.method === "setTitle" || uiReq.method === "set_editor_text") {
          // Acknowledge informational UI requests
          write({ type: "extension_ui_response", id: uiReq.id, cancelled: true });
        } else if (dialogMethods.has(uiReq.method)) {
          let payload: Record<string, unknown> | undefined;
          if (uiHandler) {
            payload = uiHandler(uiReq);
          }
          // Default: cancel
          if (!payload) {
            payload = { cancelled: true };
          }
          write({ type: "extension_ui_response", id: uiReq.id, ...payload });
        }
      }

      // Notify listeners
      for (const l of listeners) l(ev);
    }
  });

  // Clean up pending on exit
  proc.on("exit", (code) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`pi exited with code ${code}`));
    }
    pending.clear();
  });

  // ── Write to stdin ──

  function write(obj: Record<string, unknown>) {
    if (proc.stdin?.writable) {
      proc.stdin.write(JSON.stringify(obj) + "\n");
    }
  }

  // ── Public API ──

  const client: RpcClient = {
    events,
    notifications,
    statusUpdates,
    widgets,

    write,

    setUIHandler(handler) {
      uiHandler = handler;
    },

    send(cmd, timeoutMs = 30_000) {
      const id = randomUUID().slice(0, 8);
      return new Promise<RpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC timeout (${timeoutMs}ms) for command: ${cmd.type}`));
        }, timeoutMs);

        pending.set(id, { resolve, reject, timer });
        write({ ...cmd, id });
      });
    },

    waitFor(pred, timeoutMs = 60_000, scanFrom = 0) {
      return new Promise<RpcEvent>((resolve, reject) => {
        // Scan existing events first — fixes race where event arrives
        // between prompt() resolving and waitFor() subscribing
        for (let i = scanFrom; i < events.length; i++) {
          if (pred(events[i])) return resolve(events[i]);
        }

        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`waitFor timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        function check(e: RpcEvent) {
          if (pred(e)) {
            clearTimeout(timer);
            listeners.delete(check);
            resolve(e);
          }
        }

        listeners.add(check);
      });
    },

    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    waitForNotification(pred, timeoutMs = 30_000) {
      return new Promise<CapturedNotification>((resolve, reject) => {
        // Scan existing
        for (const n of notifications) {
          if (!pred || pred(n)) return resolve(n);
        }

        const timer = setTimeout(() => {
          notificationListeners.delete(check);
          reject(new Error(`waitForNotification timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        function check(n: CapturedNotification) {
          if (!pred || pred(n)) {
            clearTimeout(timer);
            notificationListeners.delete(check);
            resolve(n);
          }
        }
        notificationListeners.add(check);
      });
    },

    waitForStatusUpdate(pred, timeoutMs = 30_000) {
      return new Promise<CapturedStatusUpdate>((resolve, reject) => {
        // Scan existing
        for (const s of statusUpdates) {
          if (!pred || pred(s)) return resolve(s);
        }

        const timer = setTimeout(() => {
          statusListeners.delete(check);
          reject(new Error(`waitForStatusUpdate timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        function check(s: CapturedStatusUpdate) {
          if (!pred || pred(s)) {
            clearTimeout(timer);
            statusListeners.delete(check);
            resolve(s);
          }
        }
        statusListeners.add(check);
      });
    },
  };

  return client;
}
