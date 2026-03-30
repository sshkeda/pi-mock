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
 * All commands are prefixed with _mock_ to avoid collisions.
 */

// No imports needed — pi provides the ExtensionAPI at runtime via jiti.

export default function (pi: any) {
  // ── /_mock_emit_event <type> [json] ──
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
}
