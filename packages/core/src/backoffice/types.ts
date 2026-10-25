/**
 * Kiểu của tầng hậu cần (back office): handler theo trigger và luật sự kiện.
 */
import type { IntakeLogger } from "../core/logger";
import type { Llm } from "../llm";
import type { Clock } from "../intake/ports";
import type { ItsaplanIssue } from "../itsaplan";
import type { AgentRunOutcome, AgentRunTrigger, ClaimedAgentRun, RunTrace } from "../itsaplan";
import type { MentionComment } from "./mention";
import type { CommentOptions, CommentResult, ProjectRef, ScopedTracker } from "./tracker";
import type { Rule } from "./rules";

/** Kết quả handler được phép trả: chuỗi (= success + output), `void`, hoặc outcome đầy đủ. */
// biome-ignore lint/suspicious/noConfusingVoidType: handler async không trả gì là hợp lệ
export type HandlerResult = AgentRunOutcome | string | undefined | void;

/** Ngữ cảnh một run mà handler nhận được. */
export interface RunContext<C = unknown, M extends MentionComment | null = MentionComment | null> {
  readonly run: ClaimedAgentRun;
  readonly trigger: AgentRunTrigger | (string & {});
  readonly bot: {
    readonly id: string;
    /** Mã dự án trong team, vd `TECH2`. */
    readonly project: string;
    /** Ref đủ `<team>.<KEY>`, vd `tech.TECH2`. */
    readonly ref: ProjectRef;
    readonly agent?: string;
  };
  /** Cấu hình đã kiểm tra của bot (từ `defineBot({ env })`). */
  readonly config: C;
  readonly logger: IntakeLogger;
  /** Bị huỷ khi mất lease, hết hạn run hoặc bot đang tắt cưỡng bức. Truyền cho `fetch`/LLM. */
  readonly signal: AbortSignal;
  readonly trace: RunTrace;
  /** Tracker khoá vào dự án của bot. */
  readonly tracker: ScopedTracker;
  /**
   * Client LLM khi bot đã cấu hình (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`), nếu không là
   * `undefined`. Lời gọi bị huỷ theo `signal` của run. Xem `@vuihoc/bot-core/llm`:
   * `runAgentLoop(ctx, ...)` chạy vòng lặp tool và ghi trace lên itsaplan, `requireLlm(ctx)`
   * ném lỗi rõ ràng khi chưa cấu hình.
   */
  readonly llm: Llm | undefined;
  readonly clock: Clock;
  /** Khoá ổn định của run (`agent-run:<id>`). */
  readonly idempotencyKey: string;
  /** Lượt thử hiện tại (bắt đầu từ 1) và số lượt tối đa server cho một run. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Prompt nguyên văn của run. Với trigger không phải `mention`, đây là nội dung duy nhất cần đọc. */
  readonly prompt: string;
  /**
   * Comment đã phân tích. CHỈ có ở trigger `mention` (handler `on.mention` nhận kiểu không-null);
   * các trigger khác là `null`, đọc `ctx.prompt`.
   */
  readonly comment: M;
  /** Issue của run (đọc một lần rồi nhớ). `null` nếu run không gắn issue hoặc issue không thuộc dự án. */
  issue(): Promise<ItsaplanIssue | null>;
  /**
   * Ghi một comment trả lời lên issue của run. Mặc định: vào đúng luồng của comment
   * gọi bot (mention), gắn dấu bot, và CHỐNG TRÙNG: khoá mặc định là số thứ tự lần gọi trong
   * run (`reply#1`, `reply#2`…), nên nhiều câu trả lời trong một run đều được ghi, còn chạy lại
   * cả run (giao lại sau crash) thì từng câu đã ghi bị bỏ qua. Truyền `key` để tự đặt khoá.
   *
   * Lưu ý: kiểm-rồi-ghi KHÔNG nguyên tử. Hai lần chạy đồng thời của cùng một run (hiếm: lease
   * hết hạn trong khi lượt cũ còn sống) có thể cùng ghi. Giảm thiểu bằng huỷ lượt cũ khi bị
   * giao lại và từ chối ghi sau khi `signal` huỷ, không loại bỏ hoàn toàn.
   */
  reply(
    text: string,
    options?: { key?: string; thread?: boolean } & Pick<CommentOptions, "mark">,
  ): Promise<CommentResult>;
}

export type RunHandler<C = unknown, M extends MentionComment | null = MentionComment | null> = (
  ctx: RunContext<C, M>,
) => Promise<HandlerResult> | HandlerResult;

/** Handler theo trigger. Trigger không có handler thì run được đóng là success và ghi log. */
export interface TriggerHandlers<C = unknown> {
  mention?: RunHandler<C, MentionComment>;
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
  /** Số run chạy song song (số nguyên >= 1). Mặc định 1. */
  concurrency?: number;
  /** Chờ giữa hai lần poll khi hàng đợi trống (ms, >= 0). Mặc định 3000. */
  pollIntervalMs?: number;
  /** Chu kỳ heartbeat (ms, > 0 và <= một nửa lease 300 s). Mặc định 60 000. */
  heartbeatIntervalMs?: number;
  /** Hạn một run (ms, > 0). Mặc định 30 phút. */
  runTimeoutMs?: number;
  /** Số lượt thử tối đa server cho một run (để biết lượt cuối). Mặc định 3. */
  maxAttempts?: number;
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
