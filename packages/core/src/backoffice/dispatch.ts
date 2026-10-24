/**
 * Điều phối run của itsaplan tới handler theo trigger.
 */
import type { IntakeLogger } from "../core/logger";
import { systemClock, type Clock } from "../intake/ports";
import {
  type AgentRunHandler,
  type AgentRunOutcome,
  type ItsaplanIssue,
  identifierInProject,
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
}

function normalize(result: HandlerResult): AgentRunOutcome {
  if (result === undefined || result === null) return { status: "success" };
  if (typeof result === "string") return { status: "success", output: result };
  return result;
}

/**
 * Dựng `AgentRunHandler` cho worker từ khai báo hậu cần: khoá dự án, chọn handler theo
 * trigger, dựng `RunContext`. Handler ném lỗi thì worker báo `failed`.
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

    if (run.issueIdentifier && !identifierInProject(run.issueIdentifier, deps.projectKey)) {
      logger.info(
        `[backoffice] run #${run.id}: ${run.issueIdentifier} ngoài dự án ${deps.projectKey}`,
      );
      return skip(`${run.issueIdentifier} không thuộc dự án ${deps.projectKey}`);
    }

    const handler =
      (handlers as Record<string, RunHandler<C> | undefined>)[run.trigger] ?? handlers.fallback;
    if (!handler) {
      logger.warn(`[backoffice] run #${run.id}: không có handler cho trigger "${run.trigger}"`);
      return skip(`không có handler cho trigger ${run.trigger}`);
    }

    const comment = parseMentionPrompt(run.prompt, botHandles);
    let issueCache: Promise<ItsaplanIssue | null> | undefined;

    const ctx: RunContext<C> = {
      run,
      trigger: run.trigger,
      bot: { id: deps.botId, project: deps.projectKey, agent: def.agent },
      config: deps.config,
      logger,
      signal: workerCtx.signal,
      trace: workerCtx.trace,
      tracker: deps.tracker,
      clock,
      idempotencyKey: workerCtx.idempotencyKey,
      comment,
      issue() {
        issueCache ??=
          run.issueId == null ? Promise.resolve(null) : deps.tracker.getIssue(run.issueId);
        return issueCache;
      },
      async reply(text, options = {}) {
        if (run.issueId == null) throw new Error("reply: run không gắn issue");
        const thread = options.thread ?? true;
        return deps.tracker.comment(run.issueId, text, {
          replyToId: thread ? comment.replyToId : null,
          mark: options.mark,
          idempotencyKey: options.key
            ? `${workerCtx.idempotencyKey}:${options.key}`
            : `${workerCtx.idempotencyKey}:reply`,
        });
      },
    };

    return normalize(await handler(ctx));
  };
}
