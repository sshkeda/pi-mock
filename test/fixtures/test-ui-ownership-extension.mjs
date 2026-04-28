import { Type } from "@sinclair/typebox";

export default function (pi) {
  let sharedCtx = null;

  function emit(targetCtx, label) {
    targetCtx.ui.setStatus("owner-status", label);
    targetCtx.ui.setWidget("owner-widget", [label]);
  }

  function runOwnerLogic({ label, useSharedIfPresent }, ctx) {
    if (ctx.hasUI) sharedCtx = ctx;
    const targetCtx = useSharedIfPresent && sharedCtx ? sharedCtx : ctx;
    emit(targetCtx, label);
  }

  pi.registerTool({
    name: "test_ui_owner",
    label: "test_ui_owner",
    description: "Test tool for synthetic UI ownership scenarios",
    parameters: Type.Object({
      label: Type.String(),
      useSharedIfPresent: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      runOwnerLogic(params, ctx);
      return {
        content: [{ type: "text", text: `emitted:${params.label}` }],
      };
    },
  });

  pi.events.emit("_mock:register_invocation", {
    name: "test_ui_owner",
    fn: async (params, ctx) => {
      runOwnerLogic(params, ctx);
      return { ok: true };
    },
  });

  pi.events.emit("_mock:register_invocation", {
    name: "test-ui-owner-command",
    fn: async (args, ctx) => {
      const useShared = String(args || "").includes("shared");
      const label = String(args || "").replace(" shared", "") || "command";
      runOwnerLogic({ label, useSharedIfPresent: useShared }, ctx);
      return { ok: true };
    },
  });

  pi.registerCommand("test-ui-owner-command", {
    description: "Test command for synthetic UI ownership scenarios",
    handler: async (args, ctx) => {
      const useShared = args.includes("shared");
      const label = args.replace(" shared", "") || "command";
      runOwnerLogic({ label, useSharedIfPresent: useShared }, ctx);
    },
  });

}
