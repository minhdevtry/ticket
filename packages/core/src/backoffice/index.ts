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
  RunContext,
  RunHandler,
  TriggerHandlers,
} from "./types";
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
  type RuleRunSummary,
  actions,
  whenColumn,
  whenCommentCreated,
  whenDone,
  whenEvent,
  whenResolved,
} from "./rules";
