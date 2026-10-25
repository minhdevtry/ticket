import { describe, expect, test } from "bun:test";
import { ManualClock } from "./manual-clock";
import {
  applyAllowlist,
  compareGolden,
  formatGoldenReport,
  GOLDEN_FORMAT,
  type GoldenFixture,
  goldenScript,
  normalizeVoiceText,
  parseFixture,
  serializeFixture,
} from "./golden";
import { type ChatEngine, ScriptedChat } from "./scripted-chat";

const fixture: GoldenFixture = {
  format: GOLDEN_FORMAT,
  scenario: "demo",
  description: "demo",
  source: "nơi nào đó",
  startMs: 0,
  minConfirmDelayMs: 0,
  turns: [
    {
      advanceMs: 0,
      message: "hi",
      extract: { userIntent: "report_issue" },
      action: "ask_missing_field",
      voiceText: "Which team?",
      buttons: [[{ text: "Ops", callbackData: "ops" }]],
    },
    {
      advanceMs: 5,
      message: "ok",
      action: "ticket_created",
      voiceText: "Created {identifier} at {url}",
      buttons: null,
    },
  ],
};

/** Engine giả trả đúng thứ bản ghi vàng mong đợi, trừ khi `drift` đổi một thứ. */
function engine(drift: { text?: string } = {}): ChatEngine {
  let n = 0;
  return {
    step: async () =>
      ++n === 1
        ? {
            outcome: "asked",
            messages: [{ text: "Which team?", buttons: [[{ text: "Ops", callbackData: "ops" }]] }],
          }
        : {
            outcome: "created",
            messages: [{ text: drift.text ?? "Created TECH-7 at https://t.example.com/7" }],
            issue: { id: 7, identifier: "TECH-7", url: "https://t.example.com/7" },
          },
  };
}

const play = (e: ChatEngine) =>
  new ScriptedChat({ engine: e, clock: new ManualClock(0), extractor: { push() {} } }).run(
    goldenScript(fixture),
  );

describe("bản ghi vàng", () => {
  test("normalizeVoiceText thay link trước, mã sau, mọi lần xuất hiện", () => {
    const issue = { identifier: "TECH-7", url: "https://t.example.com/TECH-7" };
    expect(normalizeVoiceText("TECH-7: https://t.example.com/TECH-7 (TECH-7)", issue)).toBe(
      "{identifier}: {url} ({identifier})",
    );
    expect(normalizeVoiceText("không có gì", undefined)).toBe("không có gì");
  });

  test("serializeFixture ổn định và parseFixture đọc lại đúng", () => {
    const json = serializeFixture(fixture);
    expect(json.endsWith("}\n")).toBe(true);
    expect(serializeFixture(parseFixture(json))).toBe(json);
  });

  test("parseFixture từ chối fixture sai hình dạng", () => {
    expect(() => parseFixture("{}")).toThrow(/format/);
    expect(() => parseFixture(JSON.stringify({ ...fixture, turns: [] }))).toThrow(/turns/);
    expect(() =>
      parseFixture(JSON.stringify({ ...fixture, turns: [{ advanceMs: 0, message: "x" }] })),
    ).toThrow(/action/);
  });

  test("goldenScript mang đầu vào và kết quả trích xuất ghim, không mang kỳ vọng", () => {
    const script = goldenScript(fixture);
    expect(script.turns.map((t) => t.say)).toEqual(["hi", "ok"]);
    expect(script.turns[0].extract).toEqual({ userIntent: "report_issue" });
    expect(script.turns.every((t) => t.expect === undefined)).toBe(true);
  });

  test("khớp từng chữ (sau chuẩn hoá mã và link) thì không lệch", async () => {
    expect(compareGolden(fixture, await play(engine()))).toEqual([]);
  });

  test("lệch chữ, action và nút được nêu theo lượt và trường", async () => {
    const run = await play(engine({ text: "Done TECH-7" }));
    expect(compareGolden(fixture, run).map((d) => [d.turn, d.field])).toEqual([[2, "voiceText"]]);

    const asChitchat = compareGolden(fixture, await play(engine()), {
      actionOf: (o) => (o === "created" ? "other" : "ask_missing_field"),
    });
    expect(asChitchat.map((d) => [d.turn, d.field, d.actual])).toEqual([[2, "action", "other"]]);
  });

  test("allowlist: lệch có phép, lệch ngoài danh sách, dòng thừa", () => {
    const d = (turn: number, field: "action" | "voiceText" | "buttons") => ({
      scenario: "demo",
      turn,
      field,
      expected: 1,
      actual: 2,
    });
    const verdict = applyAllowlist(
      [d(1, "voiceText"), d(2, "voiceText"), d(2, "action")],
      [
        { scenario: "demo", turn: 1, field: "voiceText", reason: "một" },
        { scenario: "*", turn: "*", field: "voiceText", reason: "chung" },
        { scenario: "demo", turn: 9, field: "buttons", reason: "thừa" },
        { scenario: "khác", turn: 1, field: "buttons", reason: "kịch bản khác" },
      ],
      ["demo"],
    );
    expect(verdict.expected.map((e) => [e.turn, e.reason])).toEqual([
      [1, "một"],
      [2, "chung"],
    ]);
    expect(verdict.unexpected.map((u) => [u.turn, u.field])).toEqual([[2, "action"]]);
    expect(verdict.stale.map((s) => s.reason)).toEqual(["thừa"]);
  });

  test("báo cáo nêu kịch bản khớp, lệch có phép và lệch mới", () => {
    const hit = { scenario: "a", turn: 2, field: "buttons" as const, expected: 1, actual: 2 };
    const report = formatGoldenReport([
      { scenario: "ok", turns: 3, verdict: { unexpected: [], expected: [], stale: [] } },
      {
        scenario: "a",
        turns: 3,
        verdict: { unexpected: [], expected: [{ ...hit, reason: "r" }], stale: [] },
      },
      { scenario: "b", turns: 3, verdict: { unexpected: [hit], expected: [], stale: [] } },
    ]);
    expect(report).toContain("3 kịch bản, 1 khớp, 2 lệch");
    expect(report).toContain("khớp         ok");
    expect(report).toContain("lệch có phép a: 1 được phép, 0 chưa được phép: lượt 2 [buttons]");
    expect(report).toContain("LỆCH MỚI    b");
  });
});
