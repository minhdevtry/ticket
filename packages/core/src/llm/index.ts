/**
 * `@vuihoc/bot-core/llm`: cách chuẩn để mọi bot nói chuyện với LLM (mặc định MiniMax qua endpoint
 * tương thích Anthropic Messages hoặc OpenAI Chat). Gồm client (`createLlm`), vòng lặp tool
 * (`runToolLoop`), trích dữ liệu có cấu trúc (`extract`), trace lên itsaplan, báo token/chi phí,
 * và cấu hình từ env (`llmEnv`). Trong handler hậu cần dùng `ctx.llm` và `runAgentLoop`.
 *
 * Thiết kế: `docs/rfc/0001-bot-kit.md`; hướng dẫn: `docs/how-to/call-llm.md`.
 */
export type {
  JsonSchema,
  Llm,
  LlmApi,
  LlmAssistantMessage,
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmStopReason,
  LlmToolCall,
  LlmToolChoice,
  LlmToolMessage,
  LlmToolSpec,
  LlmUsage,
  LlmUsageEvent,
  LlmUserMessage,
} from "./types";
export {
  LlmAbortError,
  LlmApiError,
  LlmConfigError,
  LlmError,
  LlmNetworkError,
  LlmResponseError,
  LlmTimeoutError,
} from "./errors";
export { type CreateLlmOptions, createLlm } from "./client";
export {
  type AnyLlmTool,
  type LlmTool,
  type ToolExecution,
  type ToolLoopFinishReason,
  type ToolLoopOptions,
  type ToolLoopResult,
  type ToolLoopStep,
  type ToolRunContext,
  ZERO_USAGE,
  addUsage,
  defineLlmTool,
  runToolLoop,
  toolParameters,
  toolSpec,
} from "./tool-loop";
export {
  type ExtractOptions,
  type ExtractResult,
  LlmExtractError,
  extract,
  parseJsonLoose,
} from "./extract";
export { type LlmPricing, UsageMeter, estimateCost } from "./usage";
export { type LlmTracer, type LlmTracerOptions, type TraceSink, createLlmTracer } from "./trace";
export { type LlmConfigValues, llmEnv, llmFromConfig } from "./env";
export {
  type AgentLoopOptions,
  type LlmRunContext,
  requireLlm,
  runAgentLoop,
  toRunUsage,
  withSignal,
} from "./agent";
