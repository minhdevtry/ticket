/**
 * Adapter biến các bước của vòng lặp tool thành sự kiện AG-UI trên itsaplan, để lịch sử run
 * của issue hiện câu model nói, từng tool được gọi (tham số, kết quả hoặc lỗi) và số token.
 *
 * Gửi qua `RunTrace` (`ctx.trace`), tức `AgentRunsClient.appendEvents`: `RunTrace` giữ `offset`,
 * tách lô <= 200 sự kiện, và tự tắt khi server trả 404/409 hoặc báo `truncated`. Server giữ tối
 * đa 2000 sự kiện / 1 MB mỗi lần thử (xem `docs/reference/agent-runs.md`), nên adapter:
 *  - cắt tham số/kết quả/văn bản về `maxChars` ký tự (mặc định 4000, tối đa 12 000 là trần của
 *    một `delta` ở server) kèm dấu cắt;
 *  - ngừng phát khi đã phát `maxEvents` sự kiện (mặc định 1500, chừa chỗ cho `RUN_STARTED`,
 *    `RUN_FINISHED` và trace khác của handler).
 * Lỗi trace không bao giờ làm hỏng run (`RunTrace` nuốt lỗi và tắt chính nó).
 */
import { randomUUID } from "node:crypto";
import { AGENT_RUN_LIMITS, type AgUiEvent } from "../itsaplan";
import { type LlmPricing, estimateCost } from "./usage";
import type { ToolLoopResult, ToolLoopStep } from "./tool-loop";

/** Phần của `RunTrace` mà adapter dùng (để test truyền bản giả). */
export interface TraceSink {
  readonly enabled: boolean;
  emit(...events: AgUiEvent[]): Promise<void>;
}

/** Tuỳ chọn của {@link createLlmTracer}. */
export interface LlmTracerOptions {
  /** Trần ký tự cho mỗi đoạn văn bản/tham số/kết quả. Mặc định 4000, bị kẹp ở 12 000 (trần `delta` của server). */
  maxChars?: number;
  /** Trần số sự kiện adapter được phát trong một lần dùng. Mặc định 1500. */
  maxEvents?: number;
  /** Có đơn giá thì dòng tổng kết ghi thêm chi phí ước tính. */
  pricing?: LlmPricing;
  /**
   * Che secret trong mọi chuỗi trước khi gửi (vd `createScrubber` của bot). Trong bot kit,
   * `ctx.trace` đã tự che theo secret của bot nên thường không cần đặt.
   */
  scrub?: <T>(value: T) => T;
}

/** Bộ phát trace cho một vòng lặp tool. */
export interface LlmTracer {
  /** Truyền làm `onStep` của `runToolLoop`. */
  onStep(step: ToolLoopStep): Promise<void>;
  /**
   * Ghi dòng tổng kết (số bước, token, lý do dừng). Gọi sau khi vòng lặp xong, kể cả khi nó ném
   * lỗi: khi đó bỏ `result` và đưa `error`, dòng tổng kết ghi các bước đã chạy và loại lỗi.
   */
  finish(result?: ToolLoopResult, error?: unknown): Promise<void>;
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}… [cắt ${text.length - max} ký tự]`;

const identity = <T>(value: T): T => value;

/** Dựng bộ phát trace trên `ctx.trace`. */
export function createLlmTracer(trace: TraceSink, options: LlmTracerOptions = {}): LlmTracer {
  // Ngoài `delta` tối đa của server thì cả lô bị từ chối: kẹp lại, cộng chừa chỗ cho dấu cắt.
  const maxChars = Math.max(
    1,
    Math.min(options.maxChars ?? 4000, AGENT_RUN_LIMITS.textDeltaChars - 64),
  );
  const scrub = options.scrub ?? identity;
  const out = (text: string): string => clip(String(scrub(text)), maxChars);
  let stepCount = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const maxEvents = options.maxEvents ?? 1500;
  const prefix = randomUUID().slice(0, 8);
  let sent = 0;
  let seq = 0;

  const send = (events: AgUiEvent[]): Promise<void> => {
    if (!trace.enabled || sent + events.length > maxEvents) return Promise.resolve();
    sent += events.length;
    return trace.emit(...events);
  };

  const textEvents = (text: string): AgUiEvent[] => {
    const messageId = `llm-${prefix}-m${++seq}`;
    return [
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: out(text) },
      { type: "TEXT_MESSAGE_END", messageId },
    ];
  };

  return {
    async onStep(step) {
      stepCount++;
      tokensIn += step.response.usage.inputTokens;
      tokensOut += step.response.usage.outputTokens;
      if (!trace.enabled) return;
      const events: AgUiEvent[] = [];
      if (step.response.text.trim()) events.push(...textEvents(step.response.text));
      for (const execution of step.executions) {
        const toolCallId = `llm-${prefix}-s${step.index}-${execution.call.id || ++seq}`;
        events.push(
          {
            type: "TOOL_CALL_START",
            toolCallId,
            toolCallName: execution.call.name,
          },
          {
            type: "TOOL_CALL_ARGS",
            toolCallId,
            delta: out(
              execution.call.argsError !== undefined && execution.call.rawArgs !== undefined
                ? execution.call.rawArgs
                : (JSON.stringify(execution.call.args ?? {}) ?? "{}"),
            ),
          },
          { type: "TOOL_CALL_END", toolCallId },
          {
            type: "TOOL_CALL_RESULT",
            messageId: `llm-${prefix}-r${++seq}`,
            toolCallId,
            content: out(execution.isError ? `LỖI: ${execution.content}` : execution.content),
            role: "tool",
          },
        );
      }
      await send(events);
    },

    async finish(result, error) {
      const usage = result?.usage;
      const input = usage?.inputTokens ?? tokensIn;
      const output = usage?.outputTokens ?? tokensOut;
      const parts =
        result !== undefined
          ? [`LLM: ${result.steps.length} bước (${result.finishReason})`]
          : [
              `LLM: dừng vì lỗi sau ${stepCount} bước (${
                error instanceof Error ? error.name : "lỗi không rõ"
              }${error instanceof Error && error.message ? `: ${error.message}` : ""})`,
            ];
      parts.push(`${input} token vào, ${output} token ra`);
      if (options.pricing && usage) {
        parts.push(`~${estimateCost(usage, options.pricing).toFixed(4)} chi phí ước tính`);
      }
      await send(textEvents(parts.join("; ")));
    },
  };
}
