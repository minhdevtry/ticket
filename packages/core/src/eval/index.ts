/**
 * Eval harness (A3) — khung chạy hội thoại nhiều lượt → chấm, bằng TypeScript.
 *
 * Rút từ ba cách khác nhau của ba bot (intake `harness.ts`/`test-*-live.ts` TS;
 * Bot-Sales `openclaw_eval.py` + `score_runs.py` Python; CM `tests/p2/run.py`
 * Python). Spec chốt: **một ngôn ngữ = TS** (Bun chạy thẳng, cùng hệ test với
 * phần còn lại của lib) — bỏ nhánh Python.
 *
 * Chia hai lớp, cả hai THUẦN (không I/O, không mạng, không đọc đĩa):
 *   1. `runConversation` — chạy một kịch bản (dãy lượt người dùng) qua một
 *      `ConversationRunner` do BOT tiêm (một hàm `step(input) → output`), thu lại
 *      transcript từng lượt. Khung không biết engine nào; bot nối engine thật
 *      (hoặc một LLM-backed step) vào runner.
 *   2. `scoreRun` / `scoreRuns` — chấm transcript theo các `Check` do bot tiêm.
 *      Khung chỉ chạy check và tổng hợp pass/fail; TIÊU CHÍ chấm là của bot (một
 *      bot sale chấm khác một bot tiếp nhận). Không literal tiếng Việt trong khung.
 *
 * Vì sao tách: "chạy–bắt" là chung mọi bot; "chấm" là nội dung riêng. Để chung
 * một chỗ thì mọi bot viết eval cùng một hình dạng, so sánh được, chạy trong
 * cùng `bun test`.
 */

/** Một lượt người dùng trong kịch bản. `kind` cho phép mô phỏng cả bấm nút. */
export interface EvalTurnInput {
  kind?: "message" | "button";
  /** Lời người dùng (message) hoặc callback_data (button). */
  text: string;
  /** Số media kèm lượt này (một số engine dùng làm ngữ cảnh). */
  attachments?: number;
  /** Mốc thời gian ảo của lượt (ms) — để test guard theo thời gian. */
  atMs?: number;
}

/** Kết quả một lượt mà runner trả về (đã chuẩn hoá, channel-free). */
export interface EvalTurnOutput {
  /** Text bot trả lời lượt này (đã strip định dạng kênh nếu có). */
  reply: string;
  /** Nhãn các nút bot hiện ra lượt này, nếu có. */
  buttons?: string[];
  /** Bot có tạo ticket ở lượt này không + định danh, nếu runner biết. */
  createdTicket?: { identifier: string } | null;
  /** Bất kỳ dữ liệu phụ runner muốn ghi để check đọc (opaque). */
  meta?: Record<string, unknown>;
}

/** Một lượt đã chạy: input + output, ghép lại thành transcript. */
export interface EvalTurn {
  input: EvalTurnInput;
  output: EvalTurnOutput;
}

/** Bot tiêm: chạy MỘT lượt. Giữ trạng thái hội thoại bên trong (closure/engine). */
export interface ConversationRunner {
  step(input: EvalTurnInput): Promise<EvalTurnOutput>;
  /** Dọn sau một kịch bản (đóng DB tạm…). Tùy chọn. */
  reset?(): Promise<void> | void;
}

export interface EvalScenario {
  name: string;
  turns: EvalTurnInput[];
}

export interface EvalRun {
  scenario: string;
  transcript: EvalTurn[];
}

/**
 * Chạy một kịch bản qua runner, trả transcript. Không chấm — chỉ chạy & bắt.
 * Một lượt ném lỗi thì transcript vẫn giữ các lượt trước + một lượt lỗi (reply
 * mang thông báo lỗi, meta.error=true) để check thấy được, thay vì mất cả run.
 */
export async function runConversation(
  runner: ConversationRunner,
  scenario: EvalScenario,
): Promise<EvalRun> {
  const transcript: EvalTurn[] = [];
  for (const input of scenario.turns) {
    try {
      const output = await runner.step(input);
      transcript.push({ input, output });
    } catch (err: any) {
      transcript.push({
        input,
        output: {
          reply: "",
          meta: { error: true, message: err?.message ? String(err.message) : String(err) },
        },
      });
      break; // một lượt vỡ thì các lượt sau vô nghĩa
    }
  }
  await runner.reset?.();
  return { scenario: scenario.name, transcript };
}

/** Một tiêu chí chấm do bot tiêm. Đọc transcript, trả đạt/không + lý do. */
export interface Check {
  /** Tên tiêu chí (hiện trong báo cáo). */
  name: string;
  /** True = đạt. `reason` giải thích khi trượt (hoặc ghi chú khi đạt). */
  run(run: EvalRun): { pass: boolean; reason?: string };
}

export interface CheckResult {
  name: string;
  pass: boolean;
  reason?: string;
}

export interface ScoredRun {
  scenario: string;
  checks: CheckResult[];
  passed: number;
  failed: number;
  /** Đạt toàn bộ check? */
  ok: boolean;
}

/** Chấm MỘT run theo danh sách check. Một check ném lỗi tính là trượt (không vỡ). */
export function scoreRun(run: EvalRun, checks: Check[]): ScoredRun {
  const results: CheckResult[] = checks.map((c) => {
    try {
      const r = c.run(run);
      return { name: c.name, pass: r.pass, reason: r.reason };
    } catch (err: any) {
      return { name: c.name, pass: false, reason: `check ném lỗi: ${err?.message ?? err}` };
    }
  });
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  return { scenario: run.scenario, checks: results, passed, failed, ok: failed === 0 };
}

export interface EvalReport {
  runs: ScoredRun[];
  totalChecks: number;
  totalPassed: number;
  totalFailed: number;
  /** Số kịch bản đạt toàn bộ check / tổng số kịch bản. */
  scenariosOk: number;
  scenariosTotal: number;
}

/**
 * Chạy nhiều kịch bản qua runner-factory (mỗi kịch bản một runner mới để không
 * rò trạng thái) và chấm cùng bộ check. Trả báo cáo tổng hợp.
 */
export async function scoreRuns(
  makeRunner: (scenario: EvalScenario) => ConversationRunner | Promise<ConversationRunner>,
  scenarios: EvalScenario[],
  checks: Check[],
): Promise<EvalReport> {
  const scored: ScoredRun[] = [];
  for (const scenario of scenarios) {
    const runner = await makeRunner(scenario);
    const run = await runConversation(runner, scenario);
    scored.push(scoreRun(run, checks));
  }
  return {
    runs: scored,
    totalChecks: scored.reduce((n, r) => n + r.checks.length, 0),
    totalPassed: scored.reduce((n, r) => n + r.passed, 0),
    totalFailed: scored.reduce((n, r) => n + r.failed, 0),
    scenariosOk: scored.filter((r) => r.ok).length,
    scenariosTotal: scored.length,
  };
}

// ── Check dựng sẵn hay dùng (thuần, không literal nghiệp vụ) ──────────────────

/** Bot trả lời có chứa đoạn text (so không phân biệt hoa thường). */
export function replyContains(turnIndex: number, needle: string, name?: string): Check {
  return {
    name: name ?? `turn[${turnIndex}].reply chứa "${needle}"`,
    run(run) {
      const t = run.transcript[turnIndex];
      if (!t) return { pass: false, reason: `không có lượt ${turnIndex}` };
      const ok = t.output.reply.toLowerCase().includes(needle.toLowerCase());
      return { pass: ok, reason: ok ? undefined : `reply: "${t.output.reply.slice(0, 120)}"` };
    },
  };
}

/** Có đúng một lượt nào đó tạo ticket với prefix dự án cho trước. */
export function createdTicketWithPrefix(prefix: string, name?: string): Check {
  return {
    name: name ?? `có tạo ticket ${prefix}-*`,
    run(run) {
      const created = run.transcript.filter((t) =>
        t.output.createdTicket?.identifier?.toUpperCase().startsWith(`${prefix.toUpperCase()}-`),
      );
      if (created.length === 1) return { pass: true };
      return {
        pass: false,
        reason: `số ticket ${prefix}-* tạo ra = ${created.length} (mong đợi 1)`,
      };
    },
  };
}

/** KHÔNG lượt nào tạo ticket (vd kịch bản chitchat không được đẻ phiếu). */
export function noTicketCreated(name?: string): Check {
  return {
    name: name ?? "không tạo ticket nào",
    run(run) {
      const n = run.transcript.filter((t) => t.output.createdTicket?.identifier).length;
      return { pass: n === 0, reason: n === 0 ? undefined : `đã tạo ${n} ticket` };
    },
  };
}

/** Một lượt bày ra nút có nhãn cho trước (vd nút xác nhận tạo ticket). */
export function turnHasButton(turnIndex: number, label: string, name?: string): Check {
  return {
    name: name ?? `turn[${turnIndex}] có nút "${label}"`,
    run(run) {
      const t = run.transcript[turnIndex];
      const has = !!t?.output.buttons?.some((b) => b.toLowerCase().includes(label.toLowerCase()));
      return {
        pass: has,
        reason: has ? undefined : `nút: ${JSON.stringify(t?.output.buttons ?? [])}`,
      };
    },
  };
}
