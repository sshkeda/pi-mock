/**
 * Fast-mode Mock — runs extensions entirely in-process.
 *
 * No pi process, no RPC, no gateway. Handlers are called directly against a
 * fake pi with a synthetic capturing ctx. ~1 ms per invocation.
 *
 * Methods that require a real pi process (run/prompt/steer/etc.) throw a clear
 * error directing the user to pass `brain` for full mode.
 */

import type {
  CapturedNotification,
  CapturedStatusUpdate,
  CapturedWidget,
  CapturedEditorOp,
} from "./rpc.js";
import type {
  CompletionItem,
  InvocationCapture,
  InvocationContextOverrides,
  Mock,
  MockOptions,
  SlashCommandInfo,
  SyntheticInvocationResult,
} from "./mock.js";
import {
  createFastPi,
  createSyntheticCtx,
  loadExtensionIntoFastPi,
  type FastCaptureBag,
  type FastCaptureHooks,
  type FastCtxDeps,
  type FastInvocationMeta,
  type FastPi,
} from "./fast-pi.js";

function requireBrain(method: string): never {
  throw new Error(
    `mock.${method}() requires a brain. Pass { brain } to createMock() to enable full mode.`,
  );
}

function isCompletionItem(value: unknown): value is CompletionItem {
  if (typeof value !== "object" || value === null) return false;
  if (!("label" in value)) return false;
  return typeof value.label === "string";
}

export async function createFastMock(options: MockOptions): Promise<Mock> {
  const pi = createFastPi();
  for (const extPath of options.extensions ?? []) {
    await loadExtensionIntoFastPi(pi, extPath);
  }

  const notifications: CapturedNotification[] = [];
  const statusUpdates: CapturedStatusUpdate[] = [];
  const widgets: CapturedWidget[] = [];
  const editorOps: CapturedEditorOp[] = [];
  const notifListeners = new Set<(n: CapturedNotification) => void>();
  const statusListeners = new Set<(s: CapturedStatusUpdate) => void>();
  let invocationCounter = 0;

  // Single shared bag — every synthetic ctx writes here directly.
  // Per-invocation results are cursor slices, so writes that hit a stale
  // shared ctx (i.e. sharedCtx from a prior invocation) still show up in the
  // current invocation's return — matching full-mode semantics.
  const captures: FastCaptureBag = { notifications, statusUpdates, widgets, editorOps };

  const ctxDeps: FastCtxDeps = {
    sessionFilePath: options.sessionFile,
    events: pi.events,
    sendMessage: (message, messageOptions) => {
      pi.sendMessage(message, messageOptions);
    },
  };

  const hooks: FastCaptureHooks = {
    onNotification(n) {
      for (const l of notifListeners) l(n);
    },
    onStatusUpdate(s) {
      for (const l of statusListeners) l(s);
    },
  };

  function mkMeta(
    kind: "command" | "tool",
    target: string,
    overrides: InvocationContextOverrides | undefined,
  ): FastInvocationMeta {
    invocationCounter++;
    return {
      kind,
      target,
      invocationId: overrides?.invocationId ?? `fast-${kind}-${invocationCounter}`,
      sessionId: overrides?.sessionId ?? `fast-session-${invocationCounter}`,
      hasUI: overrides?.hasUI ?? true,
    };
  }

  interface CaptureCursor {
    notifications: number;
    statusUpdates: number;
    widgets: number;
    editorOps: number;
  }

  function cursor(): CaptureCursor {
    return {
      notifications: notifications.length,
      statusUpdates: statusUpdates.length,
      widgets: widgets.length,
      editorOps: editorOps.length,
    };
  }

  function sliceFrom(start: CaptureCursor): FastCaptureBag {
    return {
      notifications: notifications.slice(start.notifications),
      statusUpdates: statusUpdates.slice(start.statusUpdates),
      widgets: widgets.slice(start.widgets),
      editorOps: editorOps.slice(start.editorOps),
    };
  }

  const extensionSource: SlashCommandInfo["source"] = "extension";

  const mock: Mock = {
    get requests() {
      return [];
    },
    get proxyLog() {
      return [];
    },
    get events() {
      return [];
    },
    get notifications() {
      return notifications;
    },
    get statusUpdates() {
      return statusUpdates;
    },
    get widgets() {
      return widgets;
    },
    get editorOps() {
      return editorOps;
    },
    get sentMessages() {
      return pi.sentMessages;
    },
    get stderr() {
      return [];
    },
    get port() {
      return requireBrain("port");
    },
    get url() {
      return requireBrain("url");
    },
    get token() {
      return requireBrain("token");
    },

    setBrain() {
      requireBrain("setBrain");
    },
    setNetworkRules() {
      requireBrain("setNetworkRules");
    },

    async prompt() {
      requireBrain("prompt");
    },
    async promptExpectReject() {
      return requireBrain("promptExpectReject");
    },
    async run() {
      return requireBrain("run");
    },
    async drain() {
      return requireBrain("drain");
    },
    async waitFor() {
      return requireBrain("waitFor");
    },
    async waitForRequest() {
      return requireBrain("waitForRequest");
    },
    async steer() {
      requireBrain("steer");
    },
    async followUp() {
      requireBrain("followUp");
    },
    async abort() {
      requireBrain("abort");
    },
    async sendRpc() {
      return requireBrain("sendRpc");
    },

    async setAutoRetry() {
      requireBrain("setAutoRetry");
    },

    async emitEvent(type, data) {
      pi.events.emit(type, data);
    },

    async invokeCommand(name, args, overrides): Promise<InvocationCapture> {
      const cmd = pi.commands.get(name);
      const invocation = pi.invocations.get(name);
      if (!cmd && !invocation) {
        throw new Error(`invokeCommand(${name}) failed: command not found`);
      }
      const meta = mkMeta("command", name, overrides);
      const ctx = createSyntheticCtx(meta, captures, hooks, ctxDeps);
      const start = cursor();
      try {
        if (cmd) {
          await cmd.handler(args ?? "", ctx);
        } else if (invocation) {
          await invocation(args ?? "", ctx);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`invokeCommand(${name}) failed: ${msg}`);
      }
      return sliceFrom(start);
    },

    async invokeTool(name, params = {}, overrides): Promise<SyntheticInvocationResult> {
      const tool = pi.tools.get(name);
      const invocation = pi.invocations.get(name);
      if (!tool && !invocation) {
        return {
          ok: false,
          error: `Tool not found: ${name}`,
          notifications: [],
          statusUpdates: [],
          widgets: [],
        };
      }
      const meta = mkMeta("tool", name, overrides);
      const ctx = createSyntheticCtx(meta, captures, hooks, ctxDeps);
      const start = cursor();
      try {
        let result: unknown;
        if (tool) {
          result = await tool.execute(meta.invocationId, params, undefined, undefined, ctx);
        } else if (invocation) {
          result = await invocation(params, ctx);
        }
        return {
          ok: true,
          result,
          ...sliceFrom(start),
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          ...sliceFrom(start),
        };
      }
    },

    async waitForNotification(pred, timeoutMs = 5000): Promise<CapturedNotification> {
      for (const n of notifications) {
        if (!pred || pred(n)) return n;
      }
      return new Promise((resolve, reject) => {
        const listener = (n: CapturedNotification): void => {
          if (!pred || pred(n)) {
            clearTimeout(timer);
            notifListeners.delete(listener);
            resolve(n);
          }
        };
        const timer = setTimeout(() => {
          notifListeners.delete(listener);
          reject(new Error(`waitForNotification timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        notifListeners.add(listener);
      });
    },

    async waitForStatusUpdate(pred, timeoutMs = 5000): Promise<CapturedStatusUpdate> {
      for (const s of statusUpdates) {
        if (!pred || pred(s)) return s;
      }
      return new Promise((resolve, reject) => {
        const listener = (s: CapturedStatusUpdate): void => {
          if (!pred || pred(s)) {
            clearTimeout(timer);
            statusListeners.delete(listener);
            resolve(s);
          }
        };
        const timer = setTimeout(() => {
          statusListeners.delete(listener);
          reject(new Error(`waitForStatusUpdate timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        statusListeners.add(listener);
      });
    },

    async getCommands(): Promise<SlashCommandInfo[]> {
      const result: SlashCommandInfo[] = [];
      for (const [name, def] of pi.commands) {
        result.push({ name, description: def.description, source: extensionSource });
      }
      return result;
    },

    async getCompletions(command, prefix = ""): Promise<CompletionItem[]> {
      const cmd = pi.commands.get(command);
      const eventFn = pi.completions.get(command);
      const fn = cmd?.getArgumentCompletions ?? eventFn;
      if (!fn) return [];
      const raw: unknown = await Promise.resolve(fn(prefix));
      if (!Array.isArray(raw)) return [];
      const out: CompletionItem[] = [];
      for (const item of raw) {
        if (isCompletionItem(item)) out.push(item);
      }
      return out;
    },

    async setActiveTools() {
      requireBrain("setActiveTools");
    },

    async getRegisteredTools() {
      requireBrain("getRegisteredTools");
      return [];
    },

    async getActiveTools() {
      requireBrain("getActiveTools");
      return [];
    },

    async getRegisteredCommands() {
      requireBrain("getRegisteredCommands");
      return [];
    },

    async switchSession() {
      requireBrain("switchSession");
      return undefined;
    },

    getProcessStats() {
      return null;
    },

    async close() {
      notifListeners.clear();
      statusListeners.clear();
    },
  };

  return mock;
}
