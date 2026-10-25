import { describe, expect, test } from "bun:test";
import type { StepInput, StepOutput } from "../intake/engine/types";
import type { ExtractedFields } from "../intake/ports";
import { ManualClock } from "./manual-clock";
import { type ChatEngine, ScriptedChat } from "./scripted-chat";

/** Engine giả: trả lần lượt các kết quả đã xếp, ghi lại đầu vào. */
class StubEngine implements ChatEngine {
  inputs: StepInput[] = [];
  constructor(private outputs: StepOutput[]) {}
  async step(input: StepInput): Promise<StepOutput> {
    this.inputs.push(input);
    return this.outputs.shift() ?? { outcome: "chitchat", messages: [] };
  }
}

const ask: StepOutput = {
  outcome: "asked",
  messages: [
    { text: "Which team?", buttons: [[{ text: "Ops", callbackData: "ops" }]] },
    { text: "Anything else?" },
  ],
};

describe("ScriptedChat", () => {
  test("chạy tuần tự, ghi chữ nối các tin và nút của lượt", async () => {
    const engine = new StubEngine([ask]);
    const run = await new ScriptedChat({ engine, chatId: "c1" }).run({
      name: "ghi-lai",
      turns: [{ say: "hi", media: ["a.png"], forceNew: true }],
    });
    expect(engine.inputs).toEqual([
      { chatId: "c1", message: "hi", mediaPaths: ["a.png"], forceNew: true },
    ]);
    expect(run.turns[0].text).toBe("Which team?\nAnything else?");
    expect(run.turns[0].buttons).toEqual([[{ text: "Ops", callbackData: "ops" }]]);
    expect(run.ok).toBe(true);
    expect(run.format()).toBe("");
    run.assertOk();
  });

  test("kỳ vọng đúng thì ok; sai thì liệt kê từng chỗ lệch và assertOk ném", async () => {
    const run = await new ScriptedChat({ engine: new StubEngine([ask, ask]) }).run({
      name: "lech",
      turns: [
        {
          say: "a",
          expect: {
            outcome: ["summary", "asked"],
            includes: ["team"],
            excludes: "secret",
            buttons: [["Ops"]],
            issue: null,
          },
        },
        {
          say: "b",
          expect: {
            outcome: "summary",
            text: "x",
            includes: "nope",
            excludes: "team",
            buttons: null,
            issue: "TECH-1",
          },
        },
      ],
    });
    expect(run.turns[0].index).toBe(1);
    expect(run.mismatches.filter((m) => m.turn === 1)).toEqual([]);
    expect(run.mismatches.filter((m) => m.turn === 2).map((m) => m.field)).toEqual([
      "outcome",
      "text",
      "includes",
      "excludes",
      "buttons",
      "issue",
    ]);
    expect(run.ok).toBe(false);
    expect(run.format()).toContain('Kịch bản "lech" lệch 6 chỗ');
    expect(() => run.assertOk()).toThrow(/lượt 2, outcome/);
  });

  test("advanceMs đẩy đồng hồ trước lượt; extract xếp vào bộ trích xuất trước lượt", async () => {
    const clock = new ManualClock(1_000);
    const pushed: ExtractedFields[] = [];
    const seenAt: number[] = [];
    const engine: ChatEngine = {
      step: async () => {
        seenAt.push(clock.now());
        return { outcome: "chitchat", messages: [] };
      },
    };
    const extractor = { push: (...f: ExtractedFields[]) => void pushed.push(...f) };
    await new ScriptedChat({ engine, clock, extractor }).run({
      name: "dong-ho",
      turns: [
        { say: "a", advanceMs: 500, extract: { userIntent: "confirm" } },
        { say: "b", advanceMs: 2_000 },
      ],
    });
    expect(seenAt).toEqual([1_500, 3_500]);
    expect(pushed).toEqual([{ userIntent: "confirm" }]);
  });

  test("thiếu móc clock hoặc extractor thì báo lỗi rõ thay vì lặng lẽ bỏ qua", async () => {
    const chat = new ScriptedChat({ engine: new StubEngine([]) });
    await expect(chat.run({ name: "k", turns: [{ say: "a", advanceMs: 1 }] })).rejects.toThrow(
      /thiếu clock/,
    );
    await expect(
      chat.run({ name: "k", turns: [{ say: "a", extract: { userIntent: "confirm" } }] }),
    ).rejects.toThrow(/thiếu extractor/);
  });
});

describe("ManualClock", () => {
  test("mặc định là mốc cố định và chỉ đi khi advance", () => {
    const c = new ManualClock();
    expect(new Date(c.now()).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    c.advance(1_000);
    expect(c.now() - Date.UTC(2026, 0, 1)).toBe(1_000);
    expect(() => c.advance(-1)).toThrow(RangeError);
  });
});
