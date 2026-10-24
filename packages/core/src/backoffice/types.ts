/**
 * Kiểu của tầng hậu cần (back office): handler theo trigger và luật sự kiện.
 */
import type { IntakeLogger } from "../core/logger";
import type { Clock } from "../intake/ports";
import type { ItsaplanIssue } from "../itsaplan";
import type { AgentRunOutcome, AgentRunTrigger, ClaimedAgentRun, RunTrace } from "../itsaplan";
import type { MentionComment } from "./mention";
import type { CommentOptions, CommentResult, ScopedTracker } from "./tracker";
import type { Rule } from "./rules";

/** Kết quả handler được phép trả: chuỗi (= success + output), `void`, hoặc outcome đầy đủ. */
// biome-ignore lint/suspicious/noConfusingVoidType: handler async không trả gì là hợp lệ
export type HandlerResult = AgentRunOutcome | string | undefined | void;

/** Ngữ cảnh một run mà handler nhận được. */
export interface RunContext<C = unknown> {
  readonly run: ClaimedAgentRun;
  readonly trigger: AgentRunTrigger | (string & {});
  readonly bot: { readonly id: string; readonly project: string; readonly agent?: string };
  /** Cấu hình đã kiểm tra của bot (từ `defineBot({ env })`). */
  readonly config: C;
  readonly logger: IntakeLogger;
  /** Bị huỷ khi mất lease, hết hạn run hoặc bot đang tắt cưỡng bức. Truyền cho `fetch`/LLM. */
  readonly signal: AbortSignal;
  readonly trace: RunTrace;
  /** Tracker khoá vào dự án của bot. */
  readonly tracker: ScopedTracker;
  readonly clock: Clock;
  /** Khoá ổn định của run (`agent-run:<id>`). */
  readonly idempotencyKey: string;
  /**
   * Comment đã phân tích. Có giá trị với mọi trigger nhưng chỉ có nghĩa cho `mention`
   * (các trigger khác: `raw`/`text` là chính prompt).
   */
  readonly comment: MentionComment;
  /** Issue của run (đọc một lần rồi nhớ). `null` nếu run không gắn issue hoặc issue không thuộc dự án. */
  issue(): Promise<ItsaplanIssue | null>;
  /**
   * Ghi một comment trả lời lên issue của run. Mặc định: vào đúng luồng của comment
   * gọi bot (mention), gắn dấu bot, và CHỐNG TRÙNG theo run (chạy lại không ghi hai lần).
   * Truyền `key` để cho phép nhiều câu trả lời khác nhau trong một run.
   */
  reply(
    text: string,
    options?: { key?: string; thread?: boolean } & Pick<CommentOptions, "mark">,
  ): Promise<CommentResult>;
}

export type RunHandler<C = unknown> = (
  ctx: RunContext<C>,
) => Promise<HandlerResult> | HandlerResult;

/** Handler theo trigger. Trigger không có handler thì run được đóng là success và ghi log. */
export interface TriggerHandlers<C = unknown> {
  mention?: RunHandler<C>;
  delegation?: RunHandler<C>;
  field?: RunHandler<C>;
  /**
   * Run từ lịch cron TẠO TRÊN ITSAPLAN (trigger `schedule`). Dạng `{ "0 8 * * *": fn }`
   * (bot tự giữ lịch) thuộc milestone 2.
   */
  schedule?: RunHandler<C>;
  manual?: RunHandler<C>;
  /** Issue vào một cột mà lịch `status` theo dõi. */
  status?: RunHandler<C>;
  event?: RunHandler<C>;
  /** Nhận mọi trigger chưa có handler riêng. */
  fallback?: RunHandler<C>;
}

export interface BackofficeRunOptions {
  /** Số run chạy song song. Mặc định 1. */
  concurrency?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  /** Hạn một run (ms). Mặc định 30 phút. */
  runTimeoutMs?: number;
}

/** Khai báo hậu cần của một bot. */
export interface BackofficeDefinition<C = unknown> {
  /** Username của agent trên itsaplan (không có @). Dùng để gỡ mention khỏi nội dung comment. */
  agent?: string;
  /** Handle khác cũng coi là bot (bí danh cũ). */
  handles?: string[];
  on?: TriggerHandlers<C>;
  /** Luật "sự kiện → điều kiện → hành động" chạy trên webhook của itsaplan. */
  rules?: Rule<C>[];
  runs?: BackofficeRunOptions;
}
