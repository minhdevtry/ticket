/**
 * Điều phối run của itsaplan tới handler theo trigger.
 */
import type { IntakeLogger } from "../core/logger";
import { type Llm, withSignal } from "../llm";
import { systemClock, type Clock } from "../intake/ports";
import {
  type AgentRunHandler,
  type AgentRunOutcome,
  type ItsaplanIssue,
  identifierInProject,
  type RunTrace,
  isTransientError,
} from "../itsaplan";
import { parseMentionPrompt } from "./mention";
import type { ScopedTracker } from "./tracker";
import type { BackofficeDefinition, HandlerResult, RunContext, RunHandler } from "./types";

/** Đóng run là thành công kèm lý do bỏ qua (không thử lại, không coi là lỗi). */
export function skip(reason: string): AgentRunOutcome {
  return { status: "success", output: `Bỏ qua: ${reason}` };
}

/** Đóng run là thất bại. Server KHÔNG thử lại run failed. */
export function fail(error: string): AgentRunOutcome {
  return { status: "failed", error };
}

/** Nhả lease để server giao lại sau (lỗi tạm thời). Xem `AgentRunOutcome`. */
export function retryLater(reason?: string): AgentRunOutcome {
  return { status: "retry", reason };
}

export interface DispatcherDeps<C> {
  botId: string;
  projectKey: string;
  tracker: ScopedTracker;
  config: C;
  logger: IntakeLogger;
  clock?: Clock;
  /** Client LLM của bot (nếu đã cấu hình); handler nhận bản gắn `signal` của run. */
  llm?: Llm;
  /**
   * Che secret của bot (theo giá trị). Mọi thứ handler ghi vào `ctx.trace` (văn bản, tham số và
   * kết quả tool, kể cả của `runAgentLoop`) đi qua hàm này trước khi lên itsaplan.
   */
  scrub?: <T>(value: T) => T;
}

/**
 * Bọc `RunTrace` để che secret ở mọi đường ghi (`emit`, `text`, `tool`); các phương thức còn lại
 * (`flush`, `enabled`, `setSession`) đi thẳng tới trace thật nên offset/trạng thái vẫn là của nó.
 */
function scrubbedTrace(trace: RunTrace, scrub: <T>(value: T) => T): RunTrace {
  return new Proxy(trace, {
    get(target, prop) {
      switch (prop) {
        case "emit":
          return (...events: Parameters<RunTrace["emit"]>) => target.emit(...scrub(events));
        case "text":
          return (message: string) => target.text(scrub(message));
        case "tool":
          return (name: string, args: unknown, result: unknown) =>
            target.tool(scrub(name), scrub(args), scrub(result));
        default: {
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      }
    },
  });
}

function normalize(result: HandlerResult): AgentRunOutcome {
  if (result === undefined || result === null) return { status: "success" };
  if (typeof result === "string") return { status: "success", output: result };
  return result;
}

/**
 * Dựng `AgentRunHandler` cho worker từ khai báo hậu cần: khoá dự án, chọn handler theo
 * trigger, dựng `RunContext`.
 *
 * Lỗi: handler ném lỗi THƯỜNG thì worker báo `failed` (server không thử lại). Lỗi TẠM THỜI
 * (itsaplan 5xx/429, mạng, hết giờ: xem `isTransientError`) được đổi thành `retry` để server
 * giao lại; ở lượt cuối worker đổi `retry` thành `failed` kèm lý do. Run đã bị huỷ (mất lease,
 * quá hạn, tắt) thì lỗi được ném nguyên vẹn để worker bỏ qua.
 */
export function createRunDispatcher<C>(
  def: BackofficeDefinition<C>,
  deps: DispatcherDeps<C>,
): AgentRunHandler {
  const handlers = def.on ?? {};
  const botHandles = [def.agent, ...(def.handles ?? [])].filter((h): h is string => !!h);
  const clock = deps.clock ?? systemClock;

  return async (workerCtx) => {
    const { run } = workerCtx;
    const logger = workerCtx.logger;

    // Lọc rẻ theo mã (không tốn request); ranh giới thật là projectId, kiểm ở dưới.
    if (run.issueIdentifier && !identifierInProject(run.issueIdentifier, deps.projectKey)) {
      logger.info(
        `[backoffice] run #${run.id}: ${run.issueIdentifier} ngoài dự án ${deps.projectKey}`,
      );
      return skip(`${run.issueIdentifier} không thuộc dự án ${deps.projectKey}`);
    }

    const handler =
      (handlers as Record<string, RunHandler<C, any> | undefined>)[run.trigger] ??
      handlers.fallback;
    if (!handler) {
      logger.warn(`[backoffice] run #${run.id}: không có handler cho trigger "${run.trigger}"`);
      return skip(`không có handler cho trigger ${run.trigger}`);
    }

    // Tracker riêng của run: ghi bị từ chối ngay khi run bị huỷ.
    const tracker = deps.tracker.forSignal(workerCtx.signal);
    const comment = run.trigger === "mention" ? parseMentionPrompt(run.prompt, botHandles) : null;
    let issueCache: Promise<ItsaplanIssue | null> | undefined;
    let replyCount = 0;

    const ctx: RunContext<C> = {
      run,
      trigger: run.trigger,
      bot: { id: deps.botId, project: deps.projectKey, ref: tracker.ref, agent: def.agent },
      config: deps.config,
      logger,
      signal: workerCtx.signal,
      trace: deps.scrub ? scrubbedTrace(workerCtx.trace, deps.scrub) : workerCtx.trace,
      tracker,
      llm: deps.llm ? withSignal(deps.llm, workerCtx.signal) : undefined,
      clock,
      idempotencyKey: workerCtx.idempotencyKey,
      attempt: workerCtx.attempt,
      maxAttempts: workerCtx.maxAttempts,
      prompt: run.prompt,
      comment,
      issue() {
        issueCache ??= run.issueId == null ? Promise.resolve(null) : tracker.getIssue(run.issueId);
        // Không nhớ thất bại: lần gọi sau (hoặc lượt sau) được thử lại.
        issueCache.catch(() => {
          issueCache = undefined;
        });
        return issueCache;
      },
      async reply(text, options = {}) {
        if (run.issueId == null) throw new Error("reply: run không gắn issue");
        const thread = options.thread ?? true;
        const key = options.key ?? `reply#${++replyCount}`;
        return tracker.comment(run.issueId, text, {
          replyToId: thread ? (comment?.replyToId ?? null) : null,
          mark: options.mark,
          idempotencyKey: `${workerCtx.idempotencyKey}:${key}`,
        });
      },
    };

    try {
      if (run.issueId != null && !(await ctx.issue())) {
        logger.info(
          `[backoffice] run #${run.id}: issue ${run.issueId} không thuộc dự án ${tracker.ref}`,
        );
        return skip(`issue ${run.issueIdentifier ?? run.issueId} không thuộc dự án ${tracker.ref}`);
      }
      return normalize(await handler(ctx));
    } catch (err) {
      if (!workerCtx.signal.aborted && isTransientError(err)) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[backoffice] run #${run.id}: lỗi tạm thời (lượt ${ctx.attempt}/${ctx.maxAttempts}): ${reason}`,
        );
        return retryLater(reason);
      }
      throw err;
    }
  };
}
