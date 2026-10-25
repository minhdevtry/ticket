import { describe, expect, it } from "bun:test";
import type { AgUiEvent } from "../itsaplan";
import { type ToolLoopResult, type ToolLoopStep, createLlmTracer } from "./index";

function sink(enabled = true) {
  const events: AgUiEvent[] = [];
  return {
    events,
    enabled,
    emit: async (...e: AgUiEvent[]) => void events.push(...e),
  };
}

const step = (over: Partial<ToolLoopStep> = {}): ToolLoopStep => ({
  index: 1,
  response: {
    text: "Để mình xem issue.",
    toolCalls: [],
    stopReason: "tool_use",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    model: "m",
    message: { role: "assistant", content: "" },
  },
  executions: [
    {
      call: { id: "toolu_1", name: "get_issue", args: { identifier: "TECH-1" } },
      content: '{"title":"x"}',
      isError: false,
      durationMs: 3,
    },
  ],
  ...over,
});

describe("createLlmTracer", () => {
  it("một bước = văn bản + gọi tool + kết quả, đúng thứ tự và đúng loại AG-UI", async () => {
    const s = sink();
    await createLlmTracer(s).onStep(step());
    expect(s.events.map((e) => e.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
    ]);
    const start = s.events[3] as Extract<AgUiEvent, { type: "TOOL_CALL_START" }>;
    const args = s.events[4] as Extract<AgUiEvent, { type: "TOOL_CALL_ARGS" }>;
    const result = s.events[6] as Extract<AgUiEvent, { type: "TOOL_CALL_RESULT" }>;
    expect(start.toolCallName).toBe("get_issue");
    expect(JSON.parse(args.delta)).toEqual({ identifier: "TECH-1" });
    expect(result.toolCallId).toBe(start.toolCallId);
    expect(result.content).toBe('{"title":"x"}');
  });

  it("lỗi tool được đánh dấu; tham số/kết quả dài bị cắt theo maxChars", async () => {
    const s = sink();
    await createLlmTracer(s, { maxChars: 20 }).onStep(
      step({
        executions: [
          {
            call: { id: "a", name: "t", args: { big: "x".repeat(100) } },
            content: "y".repeat(100),
            isError: true,
            durationMs: 1,
          },
        ],
      }),
    );
    const args = s.events.find((e) => e.type === "TOOL_CALL_ARGS") as { delta: string };
    const result = s.events.find((e) => e.type === "TOOL_CALL_RESULT") as { content: string };
    expect(args.delta.length).toBeLessThan(60);
    expect(args.delta).toContain("cắt");
    expect(result.content).toContain("LỖI");
    expect(result.content.length).toBeLessThan(80);
  });

  it("id tool không đụng nhau giữa các bước và giữa các tracer dù provider lặp id", async () => {
    const s = sink();
    const t1 = createLlmTracer(s);
    const t2 = createLlmTracer(s);
    await t1.onStep(step({ index: 1 }));
    await t1.onStep(step({ index: 2 }));
    await t2.onStep(step({ index: 1 }));
    const ids = s.events
      .filter((e) => e.type === "TOOL_CALL_START")
      .map((e) => (e as { toolCallId: string }).toolCallId);
    expect(new Set(ids).size).toBe(3);
  });

  it("trace tắt thì không phát gì; vượt maxEvents thì ngừng phát", async () => {
    const off = sink(false);
    await createLlmTracer(off).onStep(step());
    expect(off.events).toHaveLength(0);

    const s = sink();
    const tracer = createLlmTracer(s, { maxEvents: 10 });
    await tracer.onStep(step()); // 7 sự kiện
    await tracer.onStep(step()); // 7 nữa: vượt trần, bỏ
    expect(s.events).toHaveLength(7);
  });

  it("finish ghi dòng tổng kết có token và chi phí", async () => {
    const s = sink();
    const result = {
      steps: [step()],
      finishReason: "end",
      usage: { inputTokens: 2000, outputTokens: 500, totalTokens: 2500 },
    } as unknown as ToolLoopResult;
    await createLlmTracer(s, { pricing: { inputPerMTok: 1, outputPerMTok: 2 } }).finish(result);
    const text = (s.events.find((e) => e.type === "TEXT_MESSAGE_CONTENT") as { delta: string })
      .delta;
    expect(text).toContain("1 bước");
    expect(text).toContain("2000 token vào");
    expect(text).toContain("500 token ra");
    expect(text).toContain("0.0030");
  });
});
