export default function highUsageToolUseExtension(pi) {
  let bumped = false;

  pi.on("message_end", (event) => {
    const msg = event.message;
    if (bumped || msg?.role !== "assistant" || msg.stopReason !== "toolUse") return;
    bumped = true;

    return {
      message: {
        ...msg,
        usage: {
          input: 120000,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 120001,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    };
  });
}
