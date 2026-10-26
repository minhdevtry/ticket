/**
 * Bản ghi vàng: kịch bản hội thoại ghi MỘT LẦN từ bản legacy (dữ liệu tổng hợp) thành JSON, rồi
 * phát lại ở engine mới để so máy với máy mà không import code legacy. Mỗi lượt là
 * `(tin, action, voiceText, nút)` theo hợp đồng `intake_step` của legacy.
 *
 * Module này chỉ có phần dùng chung: định dạng fixture, chuẩn hoá tham số, so sánh, danh sách
 * lệch được phép (allowlist). Việc ghi nằm ở `apps/tieulinh-legacy/scripts/golden`. Cách dùng:
 * [Kiểm hội thoại bằng kịch bản và bản ghi vàng](/how-to/golden-scripts).
 */
import { legacyActionForOutcome } from "../intake/engine/action-map";
import type { StepOutcome } from "../intake/engine/types";
import type { InlineButton } from "../intake/gate/types";
import type { ExtractedFields } from "../intake/ports";
import type { Script, ScriptRun } from "./scripted-chat";

/** Phiên bản định dạng fixture. Đổi hình dạng thì tăng số này và sửa `parseFixture`. */
export const GOLDEN_FORMAT = 1;

/** Một lượt của bản ghi vàng. */
export interface GoldenTurn {
  /** Đồng hồ đi thêm từng này ms trước lượt. */
  advanceMs: number;
  /** Tin người báo gửi (có thể là nhãn nút đã bấm). */
  message: string;
  /** Đường dẫn ảnh kèm tin, nếu có. */
  mediaPaths?: string[];
  /**
   * Kết quả trích xuất mà bộ trích xuất giả của engine mới trả cho lượt này. Được ghim trong kịch
   * bản (engine mới chưa có bộ trích xuất heuristic); lúc ghi, `intent` của nó bị đối chiếu với
   * bộ trích xuất thật của legacy.
   */
  extract?: ExtractedFields;
  /** `action` của `intake_step` legacy. */
  action: string;
  /** Chữ gửi người báo, đã chuẩn hoá bằng {@link normalizeVoiceText}. */
  voiceText: string;
  /** Nút kèm lượt (`text` và `callbackData`), `null` nếu không có. */
  buttons: InlineButton[][] | null;
}

/** Một kịch bản ghi vàng: toàn bộ nội dung file JSON. */
export interface GoldenFixture {
  format: typeof GOLDEN_FORMAT;
  /** Tên ngắn, cũng là tên file (`<scenario>.json`). */
  scenario: string;
  description: string;
  /** Test legacy mà kịch bản bắt nguồn (đường dẫn file và tên test). */
  source: string;
  /** Mốc đồng hồ ban đầu (ms epoch). */
  startMs: number;
  /** Độ trễ tối thiểu giữa tóm tắt và xác nhận mà bản ghi dùng. */
  minConfirmDelayMs: number;
  turns: GoldenTurn[];
}

/** Ticket của lượt, dùng để thay mã và link bằng chỗ giữ. */
export interface GoldenIssueRef {
  identifier?: string;
  url?: string;
}

/**
 * Chuẩn hoá tham số trong chữ gửi người báo: link ticket thành `{url}`, mã ticket thành
 * `{identifier}`. Hai bên (legacy lúc ghi, engine mới lúc phát lại) dùng cùng hàm này nên
 * không phụ thuộc cách mỗi bên đánh số ticket.
 */
export function normalizeVoiceText(text: string, issue?: GoldenIssueRef): string {
  let out = text;
  if (issue?.url) out = out.split(issue.url).join("{url}");
  if (issue?.identifier) out = out.split(issue.identifier).join("{identifier}");
  return out;
}

/** Chuỗi JSON ổn định của fixture (thụt 2 dấu cách, xuống dòng cuối): hai lần ghi giống nhau từng byte. */
export function serializeFixture(fixture: GoldenFixture): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

function fail(where: string, what: string): never {
  throw new Error(`Fixture vàng sai định dạng (${where}): ${what}`);
}

/** Đọc và kiểm hình dạng một fixture; ném `Error` nêu chỗ sai. */
export function parseFixture(json: string): GoldenFixture {
  const raw = JSON.parse(json) as Partial<GoldenFixture> | null;
  if (!raw || typeof raw !== "object") fail("gốc", "không phải object");
  if (raw.format !== GOLDEN_FORMAT)
    fail("format", `cần ${GOLDEN_FORMAT}, gặp ${String(raw.format)}`);
  for (const key of ["scenario", "description", "source"] as const) {
    if (typeof raw[key] !== "string" || raw[key] === "") fail(key, "cần chuỗi không rỗng");
  }
  if (typeof raw.startMs !== "number") fail("startMs", "cần số");
  if (typeof raw.minConfirmDelayMs !== "number") fail("minConfirmDelayMs", "cần số");
  if (!Array.isArray(raw.turns) || raw.turns.length === 0) fail("turns", "cần mảng không rỗng");
  raw.turns.forEach((t, i) => {
    const at = `turns[${i}]`;
    if (typeof t.advanceMs !== "number") fail(at, "thiếu advanceMs");
    if (typeof t.message !== "string") fail(at, "thiếu message");
    if (typeof t.action !== "string") fail(at, "thiếu action");
    if (typeof t.voiceText !== "string") fail(at, "thiếu voiceText");
    if (t.buttons !== null && !Array.isArray(t.buttons)) fail(at, "buttons phải là mảng hoặc null");
  });
  return raw as GoldenFixture;
}

/** Biến fixture thành kịch bản cho `ScriptedChat`: đầu vào và kết quả trích xuất ghim, KHÔNG có kỳ vọng. */
export function goldenScript(fixture: GoldenFixture): Script {
  return {
    name: fixture.scenario,
    turns: fixture.turns.map((t) => ({
      say: t.message,
      media: t.mediaPaths,
      advanceMs: t.advanceMs,
      extract: t.extract,
    })),
  };
}

/**
 * Ánh xạ `StepOutcome` của engine sang `action` của legacy — dùng BẢNG CHÍNH
 * THỨC của RFC 0002 mục 2.3 (`legacyActionForOutcome`). Kết quả không có
 * trong bảng (`chitchat`, `needs_resend`) giữ nguyên tên để lệch hiện rõ.
 */
export function legacyActionOfOutcome(outcome: StepOutcome): string {
  return legacyActionForOutcome(outcome) ?? outcome;
}

/** Trường của một lượt được so với bản ghi vàng. */
export type GoldenField = "action" | "voiceText" | "buttons";

/** Một chỗ engine lệch bản ghi vàng. `turn` đếm từ 1. */
export interface GoldenDivergence {
  scenario: string;
  turn: number;
  field: GoldenField;
  expected: unknown;
  actual: unknown;
}

export interface CompareGoldenOptions {
  /** Ánh xạ `StepOutcome` sang `action` legacy. Mặc định {@link legacyActionOfOutcome}. */
  actionOf?: (outcome: StepOutcome) => string;
}

/**
 * So từng lượt của một lần chạy với bản ghi vàng: `action`, chữ đã chuẩn hoá, nút. Không ném;
 * trả danh sách chỗ lệch (rỗng nghĩa là khớp từng chữ).
 */
export function compareGolden(
  fixture: GoldenFixture,
  run: ScriptRun,
  options: CompareGoldenOptions = {},
): GoldenDivergence[] {
  const actionOf = options.actionOf ?? legacyActionOfOutcome;
  const out: GoldenDivergence[] = [];
  fixture.turns.forEach((want, i) => {
    const got = run.turns[i];
    const turn = i + 1;
    const diverge = (field: GoldenField, expected: unknown, actual: unknown) =>
      out.push({ scenario: fixture.scenario, turn, field, expected, actual });
    if (!got) {
      diverge("action", want.action, "(lượt không chạy)");
      return;
    }
    const action = actionOf(got.output.outcome);
    if (action !== want.action) diverge("action", want.action, action);
    const text = normalizeVoiceText(got.text, got.output.issue);
    if (text !== want.voiceText) diverge("voiceText", want.voiceText, text);
    if (JSON.stringify(got.buttons) !== JSON.stringify(want.buttons)) {
      diverge("buttons", want.buttons, got.buttons);
    }
  });
  return out;
}

/**
 * Một dòng của danh sách lệch được phép. `scenario` và `turn` có thể là `"*"`. Mỗi dòng PHẢI có
 * `reason` nói vì sao lệch và PR nào sẽ xoá dòng đó (số PR theo RFC 0002 mục 5).
 */
export interface GoldenAllow {
  scenario: string;
  turn: number | "*";
  field: GoldenField;
  reason: string;
}

/** Kết quả đối chiếu chỗ lệch với allowlist. */
export interface GoldenVerdict {
  /** Lệch không có trong allowlist: đây là lỗi. */
  unexpected: GoldenDivergence[];
  /** Lệch đã được allowlist cho phép (kèm lý do). */
  expected: Array<GoldenDivergence & { reason: string }>;
  /** Dòng allowlist không còn khớp chỗ lệch nào: phải xoá (đây cũng là lỗi, để allowlist chỉ co lại). */
  stale: GoldenAllow[];
}

const matches = (a: GoldenAllow, d: GoldenDivergence) =>
  a.field === d.field &&
  (a.scenario === "*" || a.scenario === d.scenario) &&
  (a.turn === "*" || a.turn === d.turn);

/** Đối chiếu chỗ lệch với allowlist. `scenarios` là các kịch bản đã chạy (để dòng của kịch bản khác không bị coi là stale). */
export function applyAllowlist(
  divergences: GoldenDivergence[],
  allowlist: GoldenAllow[],
  scenarios?: string[],
): GoldenVerdict {
  const unexpected: GoldenDivergence[] = [];
  const expected: GoldenVerdict["expected"] = [];
  for (const d of divergences) {
    const hit = allowlist.find((a) => matches(a, d));
    if (hit) expected.push({ ...d, reason: hit.reason });
    else unexpected.push(d);
  }
  const stale = allowlist.filter(
    (a) =>
      (scenarios === undefined || a.scenario === "*" || scenarios.includes(a.scenario)) &&
      !divergences.some((d) => matches(a, d)),
  );
  return { unexpected, expected, stale };
}

/** Kết quả của một kịch bản vàng, để in báo cáo. */
export interface GoldenResult {
  scenario: string;
  turns: number;
  verdict: GoldenVerdict;
}

/** Báo cáo ngắn: kịch bản nào khớp, kịch bản nào lệch (lượt nào, trường nào, bao nhiêu chỗ được phép). */
export function formatGoldenReport(results: GoldenResult[]): string {
  const lines = results.map((r) => {
    const { unexpected, expected } = r.verdict;
    const all = [...unexpected, ...expected];
    if (all.length === 0) return `  khớp         ${r.scenario} (${r.turns} lượt)`;
    const byTurn = new Map<number, Set<GoldenField>>();
    for (const d of all) byTurn.set(d.turn, (byTurn.get(d.turn) ?? new Set()).add(d.field));
    const where = [...byTurn.entries()]
      .sort(([a], [b]) => a - b)
      .map(([turn, fields]) => `lượt ${turn} [${[...fields].join(", ")}]`)
      .join("; ");
    const status = unexpected.length > 0 ? "LỆCH MỚI    " : "lệch có phép ";
    return `  ${status}${r.scenario}: ${expected.length} được phép, ${unexpected.length} chưa được phép: ${where}`;
  });
  const diverging = results.filter(
    (r) => r.verdict.unexpected.length + r.verdict.expected.length > 0,
  ).length;
  return `Bản ghi vàng: ${results.length} kịch bản, ${results.length - diverging} khớp, ${diverging} lệch\n${lines.join("\n")}`;
}
