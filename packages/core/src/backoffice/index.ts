/**
 * `@vuihoc/bot-core/backoffice` — tầng hậu cần ("back office") của một bot:
 *  - handler theo trigger của run itsaplan (`mention`, `delegation`, `field`,
 *    `schedule`, `manual`, `status`, `event`), nhận `RunContext` có kiểu;
 *  - luật "sự kiện → điều kiện → hành động" trên webhook;
 *  - tracker bị khoá vào một dự án.
 *
 * Dùng qua `defineBot({ backoffice })` + `createBot` (`@vuihoc/bot-core/bot`).
 * Thiết kế: `docs/rfc/0001-bot-kit.md`; giải thích: `docs/explanation/bot-kit.md`.
 */
// Export tường minh (không `export *`): thêm/bớt một tên trong API công khai phải là một quyết
// định có chủ đích, không phải hệ quả của việc thêm `export` vào một file nội bộ.
export type {
  BackofficeDefinition,
  BackofficeRunOptions,
  HandlerResult,
  MissedPolicy,
  RunContext,
  RunHandler,
  ScheduleContext,
  ScheduleHandler,
  ScheduleJob,
  ScheduleOptions,
  TriggerHandlers,
} from "./types";
export { type CronSchedule, DEFAULT_TIMEZONE, assertTimezone, parseCron } from "./cron";
export { MAX_DURATION_MS, parseDuration } from "./duration";
export {
  BOT_STORE_SCHEMA_VERSION,
  BotStore,
  type BotStoreOptions,
  BotStoreVersionError,
  type CronClaim,
  type KeySet,
  MemoryKeySet,
  type TimerArmOutcome,
  type TimerArmSpec,
  type TimerRow,
  type TimerState,
} from "./store";
export {
  BotScheduler,
  type BotSchedulerHealth,
  type BotSchedulerOptions,
  type ScheduleEntry,
} from "./scheduler";
export {
  type EnsureRuleWebhookResult,
  WebhookPermissionError,
  ensureRuleWebhook,
} from "./webhook-registration";
export { type MentionComment, parseMentionPrompt } from "./mention";
export {
  type CommentOptions,
  type CommentResult,
  OutOfProjectError,
  type ProjectRef,
  RunAbortedError,
  type ScopedTracker,
  type ScopedTrackerOptions,
  type TrackerComment,
  type TrackerPriority,
  createScopedTracker,
  idempotencyMarker,
} from "./tracker";
export { type DispatcherDeps, createRunDispatcher, fail, retryLater, skip } from "./dispatch";
export {
  type AfterOptions,
  type CancelToken,
  type CloseAfterOptions,
  type Rule,
  type RuleAction,
  RuleBuilder,
  type RuleColumn,
  type RuleCondition,
  type RuleContext,
  RuleEngine,
  type RuleEngineOptions,
  type RuleEvent,
  type RuleRunStatus,
  type ReporterResolver,
  type RuleRunSummary,
  type RuleTimers,
  type TimerAction,
  type TimerContext,
  type TimerFireResult,
  type TimerGuard,
  actions,
  whenColumn,
  whenCommentCreated,
  whenDone,
  whenEvent,
  whenResolved,
} from "./rules";
