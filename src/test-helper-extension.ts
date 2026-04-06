/**
 * pi-mock test helper extension — auto-loaded BEFORE user extensions.
 *
 * Bridges gaps between pi's RPC protocol and what integration tests need:
 *
 * 1. Event bus emission — lets tests emit events on pi.events from outside
 *    (useful for triggering time-based behavior, e.g. TTL expiry)
 *
 * 2. Tool activation control — lets tests enable/disable tools dynamically
 *
 * 3. Argument completions — captures completion functions registered via
 *    the shared event bus pattern (see mock.getCompletions docs)
 *
 * All commands are prefixed with _mock_ to avoid collisions.
 */

// No imports needed — pi provides the ExtensionAPI at runtime via jiti.

export default function (pi: any) {
  // ── Completion registry (shared via event bus) ──
  // Extensions register their completion functions by emitting:
  //   pi.events.emit("_mock:register_completions", { name: "cmd", fn: completionFn })
  // The helper captures these so mock.getCompletions() can invoke them.
  const completionFns = new Map<string, (prefix: string) => any>();

  pi.events.on("_mock:register_completions", (data: { name: string; fn: (prefix: string) => any }) => {
    if (data?.name && typeof data.fn === "function") {
      completionFns.set(data.name, data.fn);
    }
  });

  // Also store the map on the event bus so extensions can register directly
  // if they prefer: (pi.events as any)._mockCompletionFns.set("cmd", fn)
  (pi.events as any)._mockCompletionFns = completionFns;

  // ─�� /_mock_emit_event <type> [json] ──
  // Emits an event on pi.events so extensions can react.
  // Usage: mock.emitEvent("clock:advance", { ms: 300000 })
  pi.registerCommand("_mock_emit_event", {
    description: "[pi-mock] Emit event on pi.events bus",
    handler: async (args: string) => {
      if (!args) return;
      const spaceIdx = args.indexOf(" ");
      const type = spaceIdx > 0 ? args.slice(0, spaceIdx) : args;
      const data = spaceIdx > 0 ? JSON.parse(args.slice(spaceIdx + 1)) : {};
      pi.events.emit(type, data);
    },
  });

  // ── /_mock_set_tools <tool1,tool2,...> ──
  // Activate specific tools. Pass "*" to restore all.
  pi.registerCommand("_mock_set_tools", {
    description: "[pi-mock] Set active tools",
    handler: async (args: string) => {
      if (!args || args.trim() === "*") {
        const all = pi.getAllTools().map((t: any) => t.name);
        pi.setActiveTools(all);
      } else {
        pi.setActiveTools(args.split(",").map((s: string) => s.trim()));
      }
    },
  });

  // ── /_mock_get_completions <command> [prefix] ──
  // Invokes a completion function previously registered via the event bus.
  // Emits results as a notification so mock.getCompletions() can capture them.
  pi.registerCommand("_mock_get_completions", {
    description: "[pi-mock] Get argument completions for a command",
    handler: async (args: string, ctx: any) => {
      if (!args) {
        ctx.ui.notify("_mock_completions:[]", "info");
        return;
      }
      const spaceIdx = args.indexOf(" ");
      const commandName = spaceIdx > 0 ? args.slice(0, spaceIdx) : args;
      const prefix = spaceIdx > 0 ? args.slice(spaceIdx + 1) : "";

      const fn = completionFns.get(commandName);
      if (!fn) {
        ctx.ui.notify("_mock_completions:[]", "info");
        return;
      }

      try {
        const completions = await fn(prefix);
        ctx.ui.notify(
          "_mock_completions:" + JSON.stringify(completions ?? []),
          "info",
        );
      } catch {
        ctx.ui.notify("_mock_completions:[]", "info");
      }
    },
  });
}
