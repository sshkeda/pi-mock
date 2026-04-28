// Public API
export {
  createMock,
  type Mock, type MockOptions, type ProcessStats,
  type SlashCommandInfo, type CompletionItem,
  type InvocationContextOverrides, type InvocationCapture, type SyntheticInvocationResult,
  type CapturedNotification, type CapturedStatusUpdate, type CapturedWidget, type CapturedUIOrigin,
  type CapturedEditorOp,
} from "./mock.js";
export {
  script, always, echo,
  estimateRequestTokens,
  withContextWindowLimit,
  createControllableBrain,
  type ControllableBrain, type PendingCall, type CallFilter,
  type ContextWindowOptions,
} from "./brains.js";
export {
  text,
  thinking,
  toolCall,
  bash,
  edit,
  writeTool,
  readTool,
  error,
  httpError,
  rateLimited,
  overloaded,
  serverError,
  serviceUnavailable,
  toSSE,
  type Brain,
  type BrainResponse,
  type ResponseBlock,
  type TextBlock,
  type ThinkingBlock,
  type ToolCallBlock,
  type ErrorBlock,
  type HttpErrorBlock,
  type ApiRequest,
} from "./anthropic.js";
export {
  createGateway,
  type Gateway,
  type GatewayConfig,
  type NetworkRule,
  type NetworkAction,
  type InterceptResponse,
  type InterceptHandler,
  type ProxyLogEntry,
} from "./gateway.js";
export {
  createRpcClient,
  type RpcClient, type RpcEvent, type RpcResponse, type UIHandler,
  type CapturedUIOrigin as RpcCapturedUIOrigin,
  type CapturedNotification as RpcCapturedNotification,
  type CapturedStatusUpdate as RpcCapturedStatusUpdate,
  type CapturedWidget as RpcCapturedWidget,
} from "./rpc.js";
export { spawnLocal, spawnSandbox, hasDocker } from "./sandbox.js";
export {
  detectProvider,
  parseRequest,
  serializeResponse,
  serializeProviderError,
  type ProviderName,
} from "./providers.js";
export {
  createInteractiveMock,
  type InteractiveMock,
  type InteractiveMockOptions,
  type KeyName,
} from "./interactive.js";
export {
  flakyBrain,
  errorAfter,
  failFirst,
  failNth,
  intermittent,
  type FlakyOptions,
} from "./faults.js";
export {
  createRecorder,
  replay,
  type Recorder,
  type RecorderOptions,
  type Transcript,
  type TranscriptTurn,
  type TranscriptUsage,
  type RequestFingerprint,
} from "./record.js";
export {
  createFastPi,
  createSyntheticCtx,
  loadExtensionIntoFastPi,
  type FastPi,
  type FastCtx,
  type FastCtxUI,
  type FastEvents,
  type FastEventHandler,
  type FastCommandDef,
  type FastToolDef,
  type FastCaptureBag,
  type FastInvocationMeta,
} from "./fast-pi.js";
export { createFastMock } from "./fast-mock.js";
