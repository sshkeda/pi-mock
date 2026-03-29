// Public API
export {
  createMock,
  script, always, echo,
  createControllableBrain,
  type Mock, type MockOptions,
  type ControllableBrain, type PendingCall,
} from "./mock.js";
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
export { createRpcClient, type RpcClient, type RpcEvent, type RpcResponse, type UIHandler } from "./rpc.js";
export { spawnLocal, spawnSandbox, hasDocker } from "./sandbox.js";
export {
  detectProvider,
  parseRequest,
  serializeResponse,
  serializeProviderError,
  type ProviderName,
} from "./providers.js";
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
