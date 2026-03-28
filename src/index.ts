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
  toSSE,
  type Brain,
  type BrainResponse,
  type ResponseBlock,
  type TextBlock,
  type ThinkingBlock,
  type ToolCallBlock,
  type ErrorBlock,
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
  type ProviderName,
} from "./providers.js";
