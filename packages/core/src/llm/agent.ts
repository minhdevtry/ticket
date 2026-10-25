/**
 * Keo dán vòng lặp tool với `RunContext` của hậu cần: `ctx.llm`, `ctx.signal`, `ctx.trace`.
 */
import type { RunContext } from "../backoffice/types";
import type { AgentRunUsage } from "../itsaplan";
import { LlmAbortError, LlmConfigError } from "./errors";
import {
  type ToolLoopOptions,
  type ToolLoopResult,
  type ToolLoopStep,
  runToolLoop,
} from "./tool-loop";
import { type LlmTracerOptions, createLlmTracer } from "./trace";
import type { Llm, LlmUsage } from "./types";

/** Phần của `RunContext` mà các hàm ở đây cần. */
export type LlmRunContext = Pick<RunContext, "signal" | "trace" | "llm">;

/**
 * Lấy `ctx.llm`, ném `LlmConfigError` (không thử lại, run thành `failed` với thông điệp rõ ràng)
 * nếu bot chưa cấu hình LLM.
 */
export function requireLlm(ctx: Pick<RunContext, "llm">): Llm {
  if (!ctx.llm) {
    throw new LlmConfigError(
      "Bot chưa cấu hình LLM: đặt LLM_BASE_URL, LLM_API_KEY và LLM_MODEL (xem llmEnv)",
    );
  }
  return ctx.llm;
}

/** Bọc client để mọi lời gọi cũng bị huỷ khi `signal` huỷ (thêm vào `signal` của từng request). */
export function withSignal(llm: Llm, signal: AbortSignal): Llm {
  return {
    api: llm.api,
    model: llm.model,
    complete(request) {
      if (signal.aborted) return Promise.reject(new LlmAbortError());
      return llm.complete({
        ...request,
        signal: request.signal ? AbortSignal.any([request.signal, signal]) : signal,
      });
    },
  };
}

/** Đổi tổng token thành `usage` của kết quả run (hiện trên lịch sử run ở itsaplan). */
export function toRunUsage(usage: LlmUsage): AgentRunUsage {
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
}

/** Tuỳ chọn của {@link runAgentLoop}: như `runToolLoop` nhưng `llm`/`signal` lấy từ `ctx`. */
export interface AgentLoopOptions
  extends Omit<ToolLoopOptions, "llm" | "signal" | "onStep">,
    LlmTracerOptions {
  /** Gọi thêm sau mỗi bước (sau khi đã gửi trace). */
  onStep?: (step: ToolLoopStep) => void | Promise<void>;
}

/**
 * Chạy vòng lặp tool trong một run: dùng `ctx.llm`, huỷ theo `ctx.signal`, và ghi trace lên
 * itsaplan (văn bản của model, từng tool, token) qua `ctx.trace`, kể cả khi vòng lặp ném lỗi.
 * Ném `LlmConfigError` nếu bot chưa cấu hình LLM.
 *
 * Trả về kết quả của vòng lặp; dùng `toRunUsage(result.usage)` để báo token cho run.
 */
export async function runAgentLoop(
  ctx: LlmRunContext,
  options: AgentLoopOptions,
): Promise<ToolLoopResult> {
  const { onStep, maxChars, maxEvents, pricing, scrub, ...loop } = options;
  const llm = requireLlm(ctx);
  const tracer = createLlmTracer(ctx.trace, { maxChars, maxEvents, pricing, scrub });
  let result: ToolLoopResult | undefined;
  let failure: unknown;
  try {
    result = await runToolLoop({
      ...loop,
      llm,
      signal: ctx.signal,
      onStep: async (step) => {
        await tracer.onStep(step);
        await onStep?.(step);
      },
    });
    return result;
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    // Dòng tổng kết cũng phải có khi vòng lặp ném lỗi (hết giờ, huỷ, LLM hỏng); lỗi trace không
    // được che lỗi thật.
    await tracer.finish(result, failure).catch(() => {});
  }
}
