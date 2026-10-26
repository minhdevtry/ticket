/**
 * `ScriptedChat`: chạy một kịch bản hội thoại "tin vào, kỳ vọng ra" qua `engine.step` và trả bản
 * ghi từng lượt kèm chỗ lệch kỳ vọng. Không phụ thuộc engine cụ thể: chỉ cần một đối tượng có
 * `step(input)` (engine của `@vuihoc/bot-core/intake` hoặc một engine khác cùng hình dạng).
 *
 * Đồng hồ và bộ trích xuất là của test, nên kịch bản cắm vào qua hai móc tuỳ chọn:
 * `clock.advance(ms)` (thường là `ManualClock`) và `extractor.push(...)` (bộ trích xuất giả
 * xếp hàng kết quả cho từng lượt). Xem [Kiểm hội thoại bằng kịch bản và bản ghi vàng](/how-to/golden-scripts).
 */
import type { InlineButton } from "../intake/gate/types";
import type { ExtractedFields } from "../intake/ports";
import type { StepInput, StepOutcome, StepOutput } from "../intake/engine/types";

/** Thứ `ScriptedChat` cần ở engine: đúng một phương thức `step`. */
export interface ChatEngine {
  step(input: StepInput): Promise<StepOutput>;
}

/** Điều kiện kiểm một lượt. Trường nào bỏ trống thì không kiểm trường đó. */
export interface TurnExpectation {
  /** Kết quả của engine; mảng nghĩa là "một trong". */
  outcome?: StepOutcome | StepOutcome[];
  /** Chữ gửi người báo (các tin của lượt nối bằng xuống dòng) phải đúng nguyên văn. */
  text?: string;
  /** Chữ gửi người báo phải chứa MỌI chuỗi này. */
  includes?: string | string[];
  /** Chữ gửi người báo không được chứa chuỗi nào trong này. */
  excludes?: string | string[];
  /** Nhãn nút theo từng hàng; `null` nghĩa là không có nút nào. */
  buttons?: string[][] | null;
  /** Mã ticket của lượt (`output.issue.identifier`); `null` nghĩa là lượt không có ticket. */
  issue?: string | null;
}

/** Một lượt của kịch bản: người báo nói gì, đồng hồ đi bao lâu, và kỳ vọng. */
export interface ScriptTurn {
  /** Tin của người báo (có thể là nhãn nút mà người báo bấm). */
  say?: string;
  /** Đường dẫn ảnh/video kèm tin. */
  media?: string[];
  /** Cờ `/new`. */
  forceNew?: boolean;
  /** Cho đồng hồ đi thêm từng này ms TRƯỚC lượt. Cần `clock` trong `ScriptedChatOptions`. */
  advanceMs?: number;
  /** Kết quả trích xuất mà bộ trích xuất giả trả cho lượt này. Cần `extractor` trong options. */
  extract?: ExtractedFields;
  expect?: TurnExpectation;
}

/** Kịch bản: tên và danh sách lượt. */
export interface Script {
  name: string;
  turns: ScriptTurn[];
}

/** Móc đồng hồ: `advance` là tất cả những gì kịch bản cần. */
export interface ScriptClock {
  advance(ms: number): void;
}

/** Móc bộ trích xuất giả: xếp kết quả cho các lượt tới. */
export interface ScriptExtractor {
  push(...fields: ExtractedFields[]): unknown;
}

export interface ScriptedChatOptions {
  engine: ChatEngine;
  /** Mã chat dùng cho mọi lượt. Mặc định `telegram:-1000000000001` (mã giả dành cho fixture). */
  chatId?: string;
  clock?: ScriptClock;
  extractor?: ScriptExtractor;
}

/** Bản ghi một lượt đã chạy. `index` đếm từ 1. */
export interface TurnRecord {
  index: number;
  /** Tin đã gửi (chuỗi rỗng nếu lượt chỉ có ảnh). */
  message: string;
  media: string[];
  advanceMs: number;
  output: StepOutput;
  /** Các tin của lượt nối bằng xuống dòng. */
  text: string;
  /** Nút của lượt (mọi hàng của mọi tin, theo thứ tự); `null` nếu không có. */
  buttons: InlineButton[][] | null;
}

/** Một chỗ lệch giữa kỳ vọng và kết quả. */
export interface Mismatch {
  turn: number;
  field: keyof TurnExpectation;
  expected: unknown;
  actual: unknown;
}

/** Kết quả chạy một kịch bản. */
export interface ScriptRun {
  name: string;
  turns: TurnRecord[];
  mismatches: Mismatch[];
  ok: boolean;
  /** Mô tả các chỗ lệch cho người đọc; chuỗi rỗng khi `ok`. */
  format(): string;
  /** Ném `Error` kèm `format()` nếu có chỗ lệch. */
  assertOk(): void;
}

/** Chữ của một lượt engine: các tin nối bằng xuống dòng. */
export function joinText(output: StepOutput): string {
  return output.messages.map((m) => m.text).join("\n");
}

/** Nút của một lượt engine: mọi hàng của mọi tin, hoặc `null`. */
export function collectButtons(output: StepOutput): InlineButton[][] | null {
  const rows = output.messages.flatMap((m) => m.buttons ?? []);
  return rows.length > 0 ? rows : null;
}

const asList = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

function check(rec: TurnRecord, expect: TurnExpectation | undefined): Mismatch[] {
  if (!expect) return [];
  const out: Mismatch[] = [];
  const miss = (field: keyof TurnExpectation, expected: unknown, actual: unknown) =>
    out.push({ turn: rec.index, field, expected, actual });

  if (expect.outcome !== undefined) {
    const allowed = Array.isArray(expect.outcome) ? expect.outcome : [expect.outcome];
    if (!allowed.includes(rec.output.outcome)) miss("outcome", expect.outcome, rec.output.outcome);
  }
  if (expect.text !== undefined && expect.text !== rec.text) miss("text", expect.text, rec.text);
  const missing = asList(expect.includes).filter((s) => !rec.text.includes(s));
  if (missing.length > 0) miss("includes", missing, rec.text);
  const present = asList(expect.excludes).filter((s) => rec.text.includes(s));
  if (present.length > 0) miss("excludes", present, rec.text);
  if (expect.buttons !== undefined) {
    const actual = rec.buttons ? rec.buttons.map((row) => row.map((b) => b.text)) : null;
    if (JSON.stringify(actual) !== JSON.stringify(expect.buttons))
      miss("buttons", expect.buttons, actual);
  }
  if (expect.issue !== undefined) {
    const actual = rec.output.issue?.identifier ?? null;
    if (actual !== expect.issue) miss("issue", expect.issue, actual);
  }
  return out;
}

function formatMismatches(name: string, mismatches: Mismatch[]): string {
  if (mismatches.length === 0) return "";
  const lines = mismatches.map(
    (m) =>
      `  lượt ${m.turn}, ${m.field}: kỳ vọng ${JSON.stringify(m.expected)}, thực tế ${JSON.stringify(m.actual)}`,
  );
  return `Kịch bản "${name}" lệch ${mismatches.length} chỗ:\n${lines.join("\n")}`;
}

/** Chạy kịch bản "tin vào, kỳ vọng ra" qua `engine.step`. */
export class ScriptedChat {
  private readonly chatId: string;

  constructor(private readonly options: ScriptedChatOptions) {
    this.chatId = options.chatId ?? "telegram:-1000000000001";
  }

  /**
   * Chạy tuần tự từng lượt (lượt sau chờ lượt trước xong) và gom bản ghi. Không ném khi lệch kỳ
   * vọng: xem `ok`, `mismatches` hoặc gọi `assertOk()`.
   */
  async run(script: Script): Promise<ScriptRun> {
    const { engine, clock, extractor } = this.options;
    const turns: TurnRecord[] = [];
    const mismatches: Mismatch[] = [];

    for (const [i, turn] of script.turns.entries()) {
      const advanceMs = turn.advanceMs ?? 0;
      if (advanceMs > 0) {
        if (!clock)
          throw new Error(
            `Kịch bản "${script.name}" lượt ${i + 1}: có advanceMs nhưng thiếu clock`,
          );
        clock.advance(advanceMs);
      }
      if (turn.extract) {
        if (!extractor)
          throw new Error(
            `Kịch bản "${script.name}" lượt ${i + 1}: có extract nhưng thiếu extractor`,
          );
        extractor.push(turn.extract);
      }
      const media = turn.media ?? [];
      const output = await engine.step({
        chatId: this.chatId,
        message: turn.say,
        ...(media.length > 0 ? { mediaPaths: media } : {}),
        ...(turn.forceNew ? { forceNew: true } : {}),
      });
      const rec: TurnRecord = {
        index: i + 1,
        message: turn.say ?? "",
        media,
        advanceMs,
        output,
        text: joinText(output),
        buttons: collectButtons(output),
      };
      turns.push(rec);
      mismatches.push(...check(rec, turn.expect));
    }

    const format = () => formatMismatches(script.name, mismatches);
    return {
      name: script.name,
      turns,
      mismatches,
      ok: mismatches.length === 0,
      format,
      assertOk() {
        if (mismatches.length > 0) throw new Error(format());
      },
    };
  }
}
