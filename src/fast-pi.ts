/**
 * pi-mock fast path — in-process fake pi + synthetic ctx.
 *
 * No pi process, no RPC, no Docker. Extensions are loaded via dynamic import
 * against a fake `pi` object; UI side effects land in capture arrays you can
 * assert on directly.
 *
 * Used by createMock() when no brain is provided.
 */

import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type {
  CapturedNotification,
  CapturedStatusUpdate,
  CapturedWidget,
  CapturedUIOrigin,
  CapturedEditorOp,
} from "./rpc.js";

// ─── Types ───────────────────────────────────────────────────────────

export type FastEventHandler = (data: unknown) => void;

export interface FastEvents {
  on(event: string, fn: FastEventHandler): void;
  off(event: string, fn: FastEventHandler): void;
  emit(event: string, data?: unknown): void;
  listenerCount(event: string): number;
}

export interface FastCommandDef {
  description?: string;
  handler: (args: string, ctx: FastCtx) => unknown | Promise<unknown>;
  getArgumentCompletions?: (prefix: string) => unknown;
}

export interface FastToolDef {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((progress: unknown) => void) | undefined,
    ctx: FastCtx,
  ) => unknown | Promise<unknown>;
}

export interface FastCtxUI {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: string[] | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  setTitle(title: string): void;
  setFooter(): void;
  setHeader(): void;
  setWorkingMessage(): void;
  setHiddenThinkingLabel(): void;
  pasteToEditor(text: string): void;
  setEditorText(text: string): void;
  getEditorText(): string;
  setEditorComponent(): void;
  onTerminalInput(): () => void;
  select(): Promise<undefined>;
  confirm(): Promise<boolean>;
  input(): Promise<undefined>;
  editor(): Promise<undefined>;
  custom(): Promise<undefined>;
  theme: Record<string, unknown>;
  getAllThemes(): Record<string, unknown>[];
  getTheme(name: string): Record<string, unknown> | undefined;
  setTheme(name: string): void;
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
}

export interface FastSessionManager {
  getSessionFile(): string | undefined;
}

export interface FastCtx {
  hasUI: boolean;
  ui: FastCtxUI;
  sessionManager: FastSessionManager;
  newSession(options?: FastNewSessionOptions): Promise<{ cancelled: boolean }>;
  isIdle(): boolean;
}

export interface CapturedMessage {
  message: Record<string, unknown>;
  options?: Record<string, unknown>;
  timestamp: number;
}

export interface FastReplacementCtx extends FastCtx {
  sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>): Promise<void>;
  sendUserMessage(content: unknown, options?: Record<string, unknown>): Promise<void>;
}

export interface FastNewSessionOptions {
  parentSession?: string;
  setup?: (sessionManager: FastSessionManager) => unknown | Promise<unknown>;
  withSession?: (ctx: FastReplacementCtx) => unknown | Promise<unknown>;
}

export interface FastPi {
  events: FastEvents;
  on(event: string, fn: FastEventHandler): void;
  sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>): void;
  readonly sentMessages: CapturedMessage[];
  registerCommand(name: string, options: FastCommandDef): void;
  registerTool(tool: FastToolDef): void;
  getAllTools(): FastToolDef[];
  readonly commands: Map<string, FastCommandDef>;
  readonly tools: Map<string, FastToolDef>;
  readonly completions: Map<string, (prefix: string) => unknown>;
  readonly invocations: Map<string, (input: unknown, ctx: FastCtx) => unknown | Promise<unknown>>;
}

export interface FastCaptureBag {
  notifications: CapturedNotification[];
  statusUpdates: CapturedStatusUpdate[];
  widgets: CapturedWidget[];
  editorOps: CapturedEditorOp[];
}

export interface FastCaptureHooks {
  onNotification?: (n: CapturedNotification) => void;
  onStatusUpdate?: (s: CapturedStatusUpdate) => void;
  onWidget?: (w: CapturedWidget) => void;
  onEditorOp?: (op: CapturedEditorOp) => void;
}

export interface FastInvocationMeta {
  kind: "command" | "tool";
  target: string;
  invocationId: string;
  sessionId: string;
  hasUI: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function hasKey<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  if (value === null || value === undefined) return false;
  if (typeof value !== "object" && typeof value !== "function") return false;
  return key in value;
}

function isRegistration(value: unknown): value is { name: string; fn: (...args: unknown[]) => unknown } {
  if (!hasKey(value, "name") || !hasKey(value, "fn")) return false;
  return typeof value.name === "string" && typeof value.fn === "function";
}

// ─── Fake pi ─────────────────────────────────────────────────────────

export function createFastPi(): FastPi {
  const listeners = new Map<string, Set<FastEventHandler>>();
  const commands = new Map<string, FastCommandDef>();
  const tools = new Map<string, FastToolDef>();
  const completions = new Map<string, (prefix: string) => unknown>();
  const invocations = new Map<string, (input: unknown, ctx: FastCtx) => unknown | Promise<unknown>>();
  const sentMessages: CapturedMessage[] = [];

  const events: FastEvents = {
    on(event, fn) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
    },
    emit(event, data) {
      const set = listeners.get(event);
      if (!set) return;
      for (const l of [...set]) l(data);
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };

  // Mirror test-helper-extension's shared registry behavior so extensions that
  // emit `_mock:register_completions` / `_mock:register_invocation` work here too.
  events.on("_mock:register_completions", (data) => {
    if (!isRegistration(data)) return;
    const fn = data.fn;
    completions.set(data.name, (prefix: string) => fn(prefix));
  });
  events.on("_mock:register_invocation", (data) => {
    if (!isRegistration(data)) return;
    const fn = data.fn;
    invocations.set(data.name, (input, ctx) => fn(input, ctx));
  });

  return {
    events,
    on(event: string, fn: FastEventHandler) {
      events.on(event, fn);
    },
    sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>) {
      sentMessages.push({ message, options, timestamp: Date.now() });
    },
    sentMessages,
    registerCommand(name, options) {
      commands.set(name, options);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    getAllTools() {
      return [...tools.values()];
    },
    commands,
    tools,
    completions,
    invocations,
  };
}

// ─── Synthetic ctx ───────────────────────────────────────────────────

export interface FastCtxDeps {
  sessionFilePath?: string;
  events: FastEvents;
  sendMessage?: (message: Record<string, unknown>, options?: Record<string, unknown>) => void;
}

export function createSyntheticCtx(
  meta: FastInvocationMeta,
  bag: FastCaptureBag,
  hooks?: FastCaptureHooks,
  deps?: FastCtxDeps,
): FastCtx {
  const origin: CapturedUIOrigin = {
    source: meta.kind === "tool" ? "synthetic-tool" : "synthetic-command",
    invocationId: meta.invocationId,
    sessionId: meta.sessionId,
    hasUI: meta.hasUI,
    commandName: meta.kind === "command" ? meta.target : undefined,
    toolName: meta.kind === "tool" ? meta.target : undefined,
  };

  const ui: FastCtxUI = {
    notify(message, type = "info") {
      const entry: CapturedNotification = {
        message,
        notifyType: type,
        timestamp: Date.now(),
        origin,
      };
      bag.notifications.push(entry);
      hooks?.onNotification?.(entry);
    },
    setStatus(key, text) {
      const entry: CapturedStatusUpdate = {
        key,
        text,
        timestamp: Date.now(),
        origin,
      };
      bag.statusUpdates.push(entry);
      hooks?.onStatusUpdate?.(entry);
    },
    setWidget(key, content, options) {
      const entry: CapturedWidget = {
        key,
        lines: content,
        placement: options?.placement,
        timestamp: Date.now(),
        origin,
      };
      bag.widgets.push(entry);
      hooks?.onWidget?.(entry);
    },
    setTitle() {},
    setFooter() {},
    setHeader() {},
    setWorkingMessage() {},
    setHiddenThinkingLabel() {},
    pasteToEditor(text) {
      const entry: CapturedEditorOp = {
        method: "pasteToEditor",
        text,
        timestamp: Date.now(),
        origin,
      };
      bag.editorOps.push(entry);
      hooks?.onEditorOp?.(entry);
    },
    setEditorText(text) {
      const entry: CapturedEditorOp = {
        method: "setEditorText",
        text,
        timestamp: Date.now(),
        origin,
      };
      bag.editorOps.push(entry);
      hooks?.onEditorOp?.(entry);
    },
    getEditorText() {
      return "";
    },
    setEditorComponent() {},
    onTerminalInput() {
      return () => {};
    },
    async select() {
      return undefined;
    },
    async confirm() {
      return false;
    },
    async input() {
      return undefined;
    },
    async editor() {
      return undefined;
    },
    async custom() {
      return undefined;
    },
    theme: {},
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {},
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded() {},
  };

  return {
    hasUI: meta.hasUI,
    ui,
    sessionManager: {
      getSessionFile() {
        return deps?.sessionFilePath;
      },
    },
    async newSession(options?: FastNewSessionOptions) {
      await options?.setup?.(this.sessionManager);
      deps?.events.emit("session_start", {
        type: "session_start",
        reason: "new",
        previousSessionFile: deps?.sessionFilePath,
        parentSession: options?.parentSession,
      });
      if (options?.withSession) {
        const replacementCtx = createSyntheticCtx(
          { ...meta, invocationId: `${meta.invocationId}:replacement` },
          bag,
          hooks,
          deps,
        ) as FastReplacementCtx;
        replacementCtx.sendMessage = async (message, messageOptions) => {
          deps?.sendMessage?.(message, messageOptions);
        };
        replacementCtx.sendUserMessage = async (content, messageOptions) => {
          deps?.sendMessage?.(
            { role: "user", content },
            { ...messageOptions, triggerTurn: true },
          );
        };
        await options.withSession(replacementCtx);
      }
      return { cancelled: false };
    },
    isIdle() {
      return true;
    },
  };
}

// ─── Extension loader ────────────────────────────────────────────────

type ExtensionSetup = (pi: FastPi) => unknown | Promise<unknown>;

function isSetup(value: unknown): value is ExtensionSetup {
  return typeof value === "function";
}

async function loadViaNativeImport(extPath: string): Promise<unknown> {
  const url = pathToFileURL(extPath).href;
  const mod = await import(url);
  return hasKey(mod, "default") ? mod.default : mod;
}

async function loadViaJiti(extPath: string): Promise<unknown> {
  const require = createRequire(import.meta.url);
  const jitiPkg: unknown = require("jiti");
  if (!hasKey(jitiPkg, "createJiti") || typeof jitiPkg.createJiti !== "function") {
    throw new Error("jiti missing createJiti export");
  }
  const jiti: unknown = jitiPkg.createJiti(import.meta.url, { interopDefault: true });
  if (!hasKey(jiti, "import") || typeof jiti.import !== "function") {
    throw new Error("jiti instance missing import()");
  }
  const loader = jiti.import;
  const mod: unknown = await loader(extPath, { default: true });
  if (hasKey(mod, "default")) return mod.default;
  return mod;
}

export async function loadExtensionIntoFastPi(pi: FastPi, extensionPath: string): Promise<void> {
  const isTs = extensionPath.endsWith(".ts") || extensionPath.endsWith(".tsx");

  let setup: unknown;
  if (isTs) {
    setup = await loadViaJiti(extensionPath);
  } else {
    try {
      setup = await loadViaNativeImport(extensionPath);
    } catch (err) {
      // Fallback: some .mjs files import .ts — try jiti
      setup = await loadViaJiti(extensionPath);
    }
  }

  if (!isSetup(setup)) {
    throw new Error(
      `Extension ${extensionPath} does not export a default function. Fast mode expects \`export default function(pi) { ... }\`.`,
    );
  }

  await setup(pi);
}
