/**
 * Dummy extension for testing pi-mock's notification, status, widget,
 * and completion capture. Generic — not tied to any specific extension.
 *
 * Registers commands that exercise each ctx.ui method so tests can
 * verify pi-mock captures them correctly.
 *
 * NOTE: UI methods live on `ctx` (the second arg to command handlers),
 * NOT on `pi` (the ExtensionAPI).
 */

export default function (pi) {
  // ── /test-notify <message> [|type] ──
  // Fires a notification. Default type: "info".
  pi.registerCommand("test-notify", {
    description: "Fire a test notification",
    handler: async (args, ctx) => {
      const parts = (args || "hello").split("|");
      const message = parts[0].trim();
      const type = parts[1]?.trim() || "info";
      ctx.ui.notify(message, type);
    },
  });

  // ── /test-status <key> [text] ──
  // Sets a status bar entry. Omit text (or pass "clear") to remove it.
  pi.registerCommand("test-status", {
    description: "Set a status bar entry",
    handler: async (args, ctx) => {
      const parts = (args || "mykey online").split(" ");
      const key = parts[0];
      const text = parts.slice(1).join(" ") || undefined;
      ctx.ui.setStatus(key, text === "clear" ? undefined : text);
    },
  });

  // ── /test-widget <key> [line1|line2|...] ──
  // Sets a widget. Pass "clear" to remove it.
  pi.registerCommand("test-widget", {
    description: "Set a widget",
    handler: async (args, ctx) => {
      const parts = (args || "mywidget line1|line2").split(" ", 1);
      const key = parts[0];
      const rest = (args || "").slice(key.length).trim();
      if (rest === "clear") {
        ctx.ui.setWidget(key, undefined);
      } else {
        const lines = rest ? rest.split("|") : ["default line"];
        ctx.ui.setWidget(key, lines);
      }
    },
  });

  // ── /test-multi ──
  // Fires multiple side effects at once (notify + status + widget).
  pi.registerCommand("test-multi", {
    description: "Fire multiple UI side effects at once",
    handler: async (args, ctx) => {
      ctx.ui.notify("multi-notification", "warning");
      ctx.ui.setStatus("multi-key", "multi-status");
      ctx.ui.setWidget("multi-widget", ["widget-line-1", "widget-line-2"]);
    },
  });

  // ── /test-completable ──
  // A command with getArgumentCompletions for testing mock.getCompletions().
  const completableFn = (prefix) => {
    const all = [
      { label: "alpha", description: "First option" },
      { label: "beta", description: "Second option" },
      { label: "gamma", description: "Third option" },
    ];
    if (!prefix) return all;
    return all.filter(c => c.label.startsWith(prefix));
  };

  pi.registerCommand("test-completable", {
    description: "Command with argument completions",
    getArgumentCompletions: completableFn,
    handler: async (args, ctx) => {
      ctx.ui.notify(`completed: ${args || "none"}`, "info");
    },
  });

  // Register completions on the shared event bus so pi-mock can test them.
  // This is the standard pattern for making completions testable.
  pi.events.emit("_mock:register_completions", {
    name: "test-completable",
    fn: completableFn,
  });

  // ── /test-error-notify ──
  // Fires an error notification.
  pi.registerCommand("test-error-notify", {
    description: "Fire an error notification",
    handler: async (args, ctx) => {
      ctx.ui.notify(args || "something went wrong", "error");
    },
  });
}
