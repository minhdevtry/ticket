/**
 * `@vuihoc/bot-core/core` — hạ tầng mọi bot dùng.
 *
 * 0.1.0: logger, tool-error, MCP scaffold (stdio + HTTP), PII redactor, env
 * loader, channel-envelope, formatting chung, lazy SQLite + memo, test-preload.
 */
export {
  type LogLevel,
  type LogEntry,
  type IntakeLogger,
  getLogger,
  setLogger,
  redactSecrets,
  Logger,
} from "./logger";

export {
  type ToolFailure,
  type CodedError,
  type ToolFailureAlert,
  type ToolFailureOptions,
  setToolFailureAlert,
  setToolFailureOptions,
  getToolFailureOptions,
  newErrorCode,
  errorCodeFor,
  describeToolFailure,
} from "./tool-error";

// ── MCP scaffold ─────────────────────────────────────────────────────────────
export { type McpTool, type AnyMcpTool, defineTool } from "./mcp-tool";
export {
  type McpServerOptions,
  type IntakeMcpOptions,
  type HttpMcpOptions,
  createMcpServer,
  createIntakeMcpServer,
  runOnStdio,
  runOnHttp,
} from "./mcp-server";

// ── PII ──────────────────────────────────────────────────────────────────────
export { redactIncidentPII } from "./pii-redactor";

// ── env loader ─────────────────────────────────────────────────────────────
export {
  type LoadEnvResult,
  type EnvDefaultsResult,
  type LoadEnvDefaultsOptions,
  parseEnvContent,
  loadEnvFile,
  parseEnvFile,
  loadEnvDefaults,
} from "./env";

// ── channel envelope ─────────────────────────────────────────────────────────
export {
  type ChannelEnvelopeInfo,
  stripChannelEnvelope,
  extractChannelEnvelope,
} from "./channel-envelope";

// ── formatting (phần chung) ──────────────────────────────────────────────────
export {
  BOT_COMMENT_MARKER,
  LEGACY_BOT_COMMENT_MARKERS,
  KNOWN_BOT_HANDLES,
  markBotComment,
  isBotComment,
  getBotCommentMarker,
  setBotCommentMarker,
  cleanMediaTags,
  extractMediaAttachments,
  stripCommentHtml,
  formatIctTimestamp,
  formatIctDate,
  foldForComparison,
  looseIncludes,
  stripBotMentions,
} from "./formatting";

// ── storage: lazy db + memo ──────────────────────────────────────────────────
export { memoByKey, memoByPath } from "./memo";
export { type ApplySchema, type LazyDbOptions, type BindingDbReport, makeOpenLazyDb, openLazyDb, isDegradedDb, resolveDbPath, inspectBindingDb } from "./lazy-db";

// ── test preload helper ──────────────────────────────────────────────────────
export { type ScrubEnvOptions, scrubOutboundEnv } from "./test-preload-helper";
