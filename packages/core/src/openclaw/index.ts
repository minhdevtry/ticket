/**
 * `@vuihoc/bot-core/openclaw` — bộ công cụ viết plugin OpenClaw.
 *
 * Nguồn (chỉ đọc, chép-thành-thư-viện): teacheragent `cm/lib/identity-token.ts`,
 * `cm/lib/identity-context.ts`, `cm/openclaw-plugin/cm-support/index.mjs`,
 * `docs/research/i4b-identity-transport.md`; intake `lib/telegram/buttons.ts`,
 * `openclaw-plugin/*`; Bot-Sales `plugins/{dinh-huong,nap-skill,iris-tuong-tac}`.
 *
 * KHÔNG phụ thuộc gói runtime OpenClaw; hình dạng hook được khai cục bộ ở
 * `hook-types.ts`. Chỉ phụ thuộc `node:crypto`/`node:fs` và `zod` (đã có ở core).
 */

// ── danh tính theo lượt (HMAC, hạn, chống replay) ────────────────────────────
export {
  IDENTITY_PARAM,
  DEFAULT_IDENTITY_TTL_MS,
  type IdentityTokenPayload,
  type TokenErrorCode,
  IdentityTokenFailure,
  type ReplayStore,
  InMemoryReplayStore,
  signIdentityToken,
  issueIdentityToken,
  verifyIdentityToken,
} from "./identity-token";

// ── lọc theo agentId ─────────────────────────────────────────────────────────
export {
  type AgentGateConfig,
  parseAgentIdFromSessionKey,
  resolveAgentId,
  isAgentInScope,
  parseAllowedAgentIds,
} from "./agent-gating";

// ── chèn ngữ cảnh (Codex một-lần / embedded mỗi-lượt) ────────────────────────
export {
  type HostRuntime,
  type SessionInjectionTracker,
  InMemorySessionInjectionTracker,
  type InjectContextInput,
  type InjectContextResult,
  injectContext,
} from "./context-injection";

// ── đọc Telegram bot token từ openclaw.json ──────────────────────────────────
export {
  type OpenClawConfigShape,
  readTelegramBotToken,
  loadTelegramBotToken,
} from "./telegram-token";

// ── hợp đồng file nút bấm chờ ────────────────────────────────────────────────
export {
  MAX_CALLBACK_DATA_BYTES,
  type TelegramButton,
  type PendingButtonsFile,
  type ButtonDropAlert,
  type PendingButtonsOptions,
  normalizeTelegramId,
  dropUnsendableButtons,
  savePendingButtons,
  readPendingButtons,
  clearPendingButtons,
} from "./pending-buttons";

// ── bootstrap guard (chống lộ onboarding bot mới) ────────────────────────────
export {
  type BootstrapSeverity,
  type BootstrapFinding,
  type WorkspaceFiles,
  auditBootstrapReadiness,
  isBootstrapSafe,
} from "./bootstrap-guard";

// ── deploy helpers (A2: sync workspace / splice config / build binary) ───────
export {
  type WorkspaceFile,
  type SyncAction,
  type SyncPlanEntry,
  type SpliceOptions,
  type BuildBinaryOptions,
  type CompileReadinessInput,
  type CompileReadinessIssue,
  planWorkspaceSync,
  summarizeSyncPlan,
  spliceConfigBlock,
  removeConfigBlock,
  mergeJsonConfig,
  buildBinaryCommand,
  checkCompileReadiness,
  isCompileReady,
} from "./deploy";

// ── kiểu hook cục bộ (không phụ thuộc runtime OpenClaw) ───────────────────────
export type {
  PluginHookContext,
  BeforeAgentRunEvent,
  BeforeToolCallEvent,
  BeforeToolCallResult,
  BeforePromptBuildEvent,
  BeforePromptBuildResult,
} from "./hook-types";
