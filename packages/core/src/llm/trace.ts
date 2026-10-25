/**
 * Adapter biến các bước của vòng lặp tool thành sự kiện AG-UI trên itsaplan, để lịch sử run
 * của issue hiện câu model nói, từng tool được gọi (tham số, kết quả hoặc lỗi) và số token.
 *
 * Gửi qua `RunTrace` (`ctx.trace`), tức `AgentRunsClient.appendEvents`: `RunTrace` giữ `offset`,
 * tách lô <= 200 sự kiện, và tự tắt khi server trả 404/409 hoặc báo `truncated`. Server giữ tối
 * đa 2000 sự kiện / 1 MB mỗi lần thử (xem `docs/reference/agent-runs.md`), nên adapter:
 *  - cắt tham số/kết quả/văn bản về `maxChars` ký tự (mặc định 4000) kèm dấu cắt;
 *  - ngừng phát khi đã phát `maxEvents` sự kiện (mặc định 1500, chừa chỗ cho `RUN_STARTED`,
 *    `RUN_FINISHED` và trace khác của handler).
 * Lỗi trace không bao giờ làm hỏng run (`RunTrace` nuốt lỗi và tắt chính nó).
 */
import { randomUUID } from "node:crypto";
import type { AgUiEvent } from "../itsaplan";
import { type LlmPricing, estimateCost } from "./usage";
import type { ToolLoopResult, ToolLoopStep } from "./tool-loop";

/** Phần của `RunTrace` mà adapter dùng (để test truyền bản giả). */
export interface TraceSink {
  readonly enabled: boolean;
  emit(...events: AgUiEvent[]): Promise<void>;
}

/** Tuỳ chọn của {@link createLlmTracer}. */
export interface LlmTracerOptions {
  /** Trần ký tự cho mỗi đoạn văn bản/tham số/kết quả. Mặc định 4000. */
  maxChars?: number;
  /** Trần số sự kiện adapter được phát trong một lần dùng. Mặc định 1500. */
  maxEvents?: number;
  /** Có đơn giá thì dòng tổng kết ghi thêm chi phí ước tính. */
  pricing?: LlmPricing;
}

/** Bộ phát trace cho một vòng lặp tool. */
export interface LlmTracer {
  /** Truyền làm `onStep` của `runToolLoop`. */
  onStep(step: ToolLoopStep): Promise<void>;
  /** Ghi dòng tổng kết (số bước, token, lý do dừng). Gọi sau khi vòng lặp xong. */
  finish(result: ToolLoopResult): Promise<void>;
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}… [cắt ${text.length - max} ký tự]`;

/** Dựng bộ phát trace trên `ctx.trace`. */
export function createLlmTracer(trace: TraceSink, options: LlmTracerOptions = {}): LlmTracer {
  const maxChars = options.maxChars ?? 4000;
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
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: clip(text, maxChars) },
      { type: "TEXT_MESSAGE_END", messageId },
    ];
  };

  return {
    async onStep(step) {
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
            delta: clip(JSON.stringify(execution.call.args ?? {}), maxChars),
          },
          { type: "TOOL_CALL_END", toolCallId },
          {
            type: "TOOL_CALL_RESULT",
            messageId: `llm-${prefix}-r${++seq}`,
            toolCallId,
            content: clip(
              execution.isError ? `LỖI: ${execution.content}` : execution.content,
              maxChars,
            ),
            role: "tool",
          },
        );
      }
      await send(events);
    },

    async finish(result) {
      const { usage } = result;
      const parts = [
        `LLM: ${result.steps.length} bước (${result.finishReason})`,
        `${usage.inputTokens} token vào, ${usage.outputTokens} token ra`,
      ];
      if (options.pricing)
        parts.push(`~${estimateCost(usage, options.pricing).toFixed(4)} chi phí ước tính`);
      await send(textEvents(parts.join("; ")));
    },
  };
}
