/**
 * Gửi trace của một lần chạy (sự kiện AG-UI) lên itsaplan để hiện trong lịch sử run.
 *
 * Trace chỉ là phụ: lỗi trace KHÔNG bao giờ làm hỏng run. Lần lỗi đầu tiên tắt trace
 * của lần thử đó (log một cảnh báo), phần còn lại của run vẫn chạy bình thường.
 */
import type { IntakeLogger } from "../../core/logger";
import type { AgentRunsClient } from "./client";
import { AGENT_RUN_LIMITS, type AgUiEvent, type ClaimedAgentRun } from "./types";

type TraceClient = Pick<AgentRunsClient, "appendEvents">;

/** Trace của một lần thử. Mọi lời gọi được tuần tự hoá, `offset` tự theo dõi. */
export class RunTrace {
  private offset = 0;
  private chain: Promise<void> = Promise.resolve();
  private disabled: boolean;
  private seq = 0;
  private sessionId: string | undefined;

  constructor(
    private readonly client: TraceClient,
    private readonly run: ClaimedAgentRun,
    private readonly logger: IntakeLogger,
    enabled: boolean,
  ) {
    this.disabled = !enabled || !run.traceEvents;
  }

  /** Trace có đang gửi không (server muốn + chưa bị tắt vì lỗi). */
  get enabled(): boolean {
    return !this.disabled;
  }

  /** Gắn UUID phiên của coding agent (nếu có). Chỉ có hiệu lực từ lô kế tiếp. */
  setSession(sessionId: string): void {
    this.sessionId ??= sessionId;
  }

  /** Gửi sự kiện thô. Trả promise hoàn tất khi lô đã gửi (hoặc trace đã tắt). */
  emit(...events: AgUiEvent[]): Promise<void> {
    if (this.disabled || events.length === 0) return Promise.resolve();
    this.chain = this.chain.then(() => this.sendAll(events));
    return this.chain;
  }

  /** Ghi một đoạn văn bản của assistant (ghi chú, kết luận). */
  text(message: string): Promise<void> {
    const messageId = `m${++this.seq}-${this.run.id}`;
    const chunks: AgUiEvent[] = [];
    for (let i = 0; i < message.length || i === 0; i += AGENT_RUN_LIMITS.textDeltaChars) {
      chunks.push({
        type: "TEXT_MESSAGE_CONTENT",
        messageId,
        delta: message.slice(i, i + AGENT_RUN_LIMITS.textDeltaChars),
      });
    }
    return this.emit({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" }, ...chunks, {
      type: "TEXT_MESSAGE_END",
      messageId,
    });
  }

  /** Ghi một lần gọi công cụ cùng kết quả (đã cắt theo trần của server). */
  tool(name: string, args: unknown, result: unknown): Promise<void> {
    const id = `t${++this.seq}-${this.run.id}`;
    const limit = AGENT_RUN_LIMITS.toolTextChars;
    const asText = (v: unknown) => (typeof v === "string" ? v : (JSON.stringify(v) ?? "null"));
    return this.emit(
      { type: "TOOL_CALL_START", toolCallId: id, toolCallName: name },
      { type: "TOOL_CALL_ARGS", toolCallId: id, delta: asText(args).slice(0, limit) },
      { type: "TOOL_CALL_END", toolCallId: id },
      {
        type: "TOOL_CALL_RESULT",
        messageId: `r${this.seq}-${this.run.id}`,
        toolCallId: id,
        content: asText(result).slice(0, limit),
      },
    );
  }

  /** Chờ mọi lô đang gửi xong. */
  flush(): Promise<void> {
    return this.chain;
  }

  private async sendAll(events: AgUiEvent[]): Promise<void> {
    for (let i = 0; i < events.length && !this.disabled; i += AGENT_RUN_LIMITS.eventsPerBatch) {
      const batch = events.slice(i, i + AGENT_RUN_LIMITS.eventsPerBatch);
      try {
        const ack = await this.client.appendEvents(this.run.id, {
          attempt: this.run.attempts,
          offset: this.offset,
          events: batch,
          ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        });
        if (ack === "lost" || ack === "conflict") {
          this.disable(`server trả ${ack}`);
          return;
        }
        this.offset = ack.nextOffset;
        if (ack.truncated) this.disable("server đã chạm trần trace");
      } catch (err) {
        this.disable(err instanceof Error ? err.message : String(err));
      }
    }
  }

  private disable(reason: string): void {
    if (this.disabled) return;
    this.disabled = true;
    this.logger.warn(`[agent-runs] run #${this.run.id}: tắt trace (${reason})`);
  }
}
