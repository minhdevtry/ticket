/**
 * `defineBot` — MỘT khai báo cho một bot, hai vai:
 *  - **lễ tân** (`receptionist`): hội thoại tiếp nhận qua chat → xác nhận → tạo ticket;
 *  - **hậu cần** (`backoffice`): run của itsaplan theo trigger, luật sự kiện, vòng đời ticket.
 *
 * `defineBot` chỉ KIỂM TRA và đặt kiểu (không chạy gì, không đọc env, không mạng); trả lại
 * chính khai báo đã đóng băng. `createBot` mới dựng runtime từ khai báo này.
 *
 * Lỗi khai báo được gom thành MỘT `BotDefinitionError` liệt kê đủ chỗ sai, và ném ngay lúc
 * module được nạp, nên một khai báo sai không bao giờ chạy được.
 */
import type { EnvSchema, EnvShape, InferEnv } from "../core/config";
import type { CopyCatalog } from "../intake/ports";
import type { BackofficeDefinition } from "../backoffice";
import { DEFAULT_TIMEZONE, assertTimezone, parseCron } from "../backoffice/cron";

/**
 * Dự án itsaplan mà bot phụ trách. Mọi dự án nằm trong một team, và mã dự án (`KEY`) chỉ
 * duy nhất TRONG team, nên bot luôn gọi itsaplan bằng ref đủ `<teamSlug>.<KEY>` (vd
 * `tech.TECH2`); khoá trần dễ trùng giữa các team và server đoán theo dự án cũ nhất.
 */
export interface TrackerRef {
  /** Slug của team, vd `tech` (chữ thường, số, gạch ngang; bắt đầu bằng chữ), hoặc id số (chuỗi `"12"`) với team chưa có slug. */
  team: string;
  /** Mã dự án trong team, vd `TECH2` (`^[A-Z][A-Z0-9]*$`). Bot chỉ đọc/ghi issue của dự án này. */
  project: string;
}

/** Một kênh chat (Telegram…). Cụ thể hoá ở milestone 2 cùng với adapter kênh. */
export interface ChannelSpec {
  kind: string;
  [option: string]: unknown;
}

/**
 * Vai lễ tân. Milestone 1 CHỈ khai báo và kiểm tra hình dạng; runtime lễ tân
 * (engine hội thoại, kênh, extractor) được nối vào `createBot` ở milestone 2.
 * Các trường `catalog`, `priorityRules`, `extractor` hiện để `unknown`, kiểu chặt đi kèm
 * adapter ở milestone 2.
 */
export interface ReceptionistDefinition {
  channels?: readonly ChannelSpec[];
  catalog?: unknown;
  priorityRules?: unknown;
  extractor?: unknown;
}

/** Khai báo đầy đủ của một bot. `E` là hình dạng env, suy ra từ `env`. */
export interface BotDefinition<E extends EnvShape = EnvShape> {
  /** Định danh ổn định: chữ thường, số, gạch ngang, 2–40 ký tự (dùng trong log, health, khoá). */
  id: string;
  tracker: TrackerRef;
  /** Giọng điệu/chuỗi hiển thị cho người dùng cuối (`CopyCatalog` của lễ tân). */
  persona?: CopyCatalog;
  /** Schema env riêng của bot; giá trị đã kiểm tra tới tay handler qua `ctx.config`. */
  env?: EnvSchema<E>;
  receptionist?: ReceptionistDefinition;
  backoffice?: BackofficeDefinition<InferEnv<E>>;
}

/** Một chỗ sai trong khai báo. */
export interface BotDefinitionIssue {
  /** Đường dẫn trường, vd `backoffice.on.mention`. */
  path: string;
  message: string;
}

/** Lỗi khai báo bot, gom mọi chỗ sai. */
export class BotDefinitionError extends Error {
  readonly issues: BotDefinitionIssue[];

  constructor(botId: string | undefined, issues: BotDefinitionIssue[]) {
    super(
      [
        `Khai báo bot${botId ? ` "${botId}"` : ""} không hợp lệ (${issues.length} lỗi)`,
        ...issues.map((i) => `  - ${i.path}: ${i.message}`),
      ].join("\n"),
    );
    this.name = "BotDefinitionError";
    this.issues = issues;
  }
}

const ID = /^[a-z][a-z0-9-]{1,39}$/;
/**
 * Ref team theo luật của itsaplan: slug (`tech`) hoặc, với team chưa có slug, id số (`12`);
 * server chấp nhận cả hai trong `<team>.<KEY>`.
 */
const TEAM_SLUG = /^(?:[a-z][a-z0-9-]{0,38}[a-z0-9]|[0-9]+)$/;
/** Lease mặc định của run phía server (ms). */
const LEASE_MS = 300_000;
const PROJECT_KEY = /^[A-Z][A-Z0-9]*$/;
const TRIGGER_KEYS = new Set([
  "mention",
  "delegation",
  "field",
  "schedule",
  "manual",
  "status",
  "event",
  "fallback",
]);

const MISSED_POLICIES = new Set(["skip", "catch-up-once"]);

/** Kiểm `backoffice.schedule` và `scheduleOptions`: biểu thức cron, múi giờ, chính sách, handler. */
function validateSchedule(
  back: NonNullable<BotDefinition<any>["backoffice"]>,
  bad: (path: string, message: string) => void,
): void {
  const opts = back.scheduleOptions;
  let timezone = DEFAULT_TIMEZONE;
  if (opts !== undefined) {
    if (opts.timezone !== undefined) {
      try {
        assertTimezone(opts.timezone);
        timezone = opts.timezone;
      } catch (err) {
        bad("backoffice.scheduleOptions.timezone", (err as Error).message);
      }
    }
    if (opts.missed !== undefined && !MISSED_POLICIES.has(opts.missed)) {
      bad("backoffice.scheduleOptions.missed", 'phải là "skip" hoặc "catch-up-once"');
    }
    if (
      opts.graceMs !== undefined &&
      !(typeof opts.graceMs === "number" && Number.isFinite(opts.graceMs) && opts.graceMs >= 0)
    ) {
      bad("backoffice.scheduleOptions.graceMs", "phải là số >= 0 (ms)");
    }
  }
  const schedule = back.schedule;
  if (schedule === undefined) return;
  if (schedule === null || typeof schedule !== "object" || Array.isArray(schedule)) {
    bad("backoffice.schedule", 'phải là object dạng { "0 8 * * *": handler }');
    return;
  }
  const seen = new Set<string>();
  for (const [expr, value] of Object.entries(schedule)) {
    const at = `backoffice.schedule[${JSON.stringify(expr)}]`;
    const job =
      typeof value === "function" ? { run: value } : (value as unknown as Record<string, unknown>);
    if (!job || typeof job.run !== "function") {
      bad(at, "phải là hàm hoặc { run: hàm, missed?, timezone? }");
      continue;
    }
    if (job.missed !== undefined && !MISSED_POLICIES.has(job.missed as string)) {
      bad(`${at}.missed`, 'phải là "skip" hoặc "catch-up-once"');
    }
    try {
      const cron = parseCron(expr, (job.timezone as string | undefined) ?? timezone);
      if (seen.has(cron.expression)) bad(at, `trùng lịch "${cron.expression}"`);
      seen.add(cron.expression);
    } catch (err) {
      bad(at, (err as Error).message);
    }
  }
}

/** Kiểm tra khai báo; trả danh sách lỗi (rỗng = hợp lệ). Không ném. */
export function validateBotDefinition(def: BotDefinition<any>): BotDefinitionIssue[] {
  const issues: BotDefinitionIssue[] = [];
  const bad = (path: string, message: string) => issues.push({ path, message });

  if (typeof def?.id !== "string" || !ID.test(def.id)) {
    bad("id", 'bắt buộc, chữ thường/số/gạch ngang, bắt đầu bằng chữ, 2–40 ký tự (vd "tieulinh")');
  }
  if (typeof def?.tracker?.team !== "string" || !TEAM_SLUG.test(def.tracker.team)) {
    bad(
      "tracker.team",
      'bắt buộc, slug team itsaplan (chữ thường/số/gạch ngang, bắt đầu bằng chữ, 2–40 ký tự, vd "tech") hoặc id số của team chưa có slug',
    );
  }
  if (typeof def?.tracker?.project !== "string" || !PROJECT_KEY.test(def.tracker.project)) {
    bad("tracker.project", 'bắt buộc, mã dự án IN HOA/số, bắt đầu bằng chữ (vd "TECH2")');
  }
  if (!def?.receptionist && !def?.backoffice) {
    bad("receptionist | backoffice", "cần ít nhất một vai");
  }

  const back = def?.backoffice;
  if (back) {
    const on = back.on ?? {};
    const rules = back.rules ?? [];
    const schedule = back.schedule;
    const hasSchedule =
      !!schedule && typeof schedule === "object" && Object.keys(schedule).length > 0;
    if (Object.keys(on).length === 0 && rules.length === 0 && !hasSchedule) {
      bad(
        "backoffice",
        "cần ít nhất một handler trong `on`, một luật trong `rules` hoặc một lịch trong `schedule`",
      );
    }
    for (const [key, handler] of Object.entries(on)) {
      if (!TRIGGER_KEYS.has(key)) {
        bad(`backoffice.on.${key}`, `trigger không biết (hợp lệ: ${[...TRIGGER_KEYS].join(", ")})`);
      } else if (key === "schedule" && handler && typeof handler === "object") {
        bad(
          "backoffice.on.schedule",
          'chỉ nhận một hàm (cho run `schedule` từ lịch tạo trên itsaplan); lịch do bot tự giữ khai ở `backoffice.schedule: { "0 8 * * *": handler }`',
        );
      } else if (typeof handler !== "function") {
        bad(`backoffice.on.${key}`, "phải là hàm");
      }
    }
    validateSchedule(back, bad);
    const seen = new Set<string>();
    rules.forEach((rule, i) => {
      const at = `backoffice.rules[${i}]`;
      if (
        !rule ||
        typeof rule.name !== "string" ||
        !Array.isArray(rule.events) ||
        !Array.isArray(rule.actions)
      ) {
        bad(at, "không phải luật hợp lệ (dựng bằng whenColumn(...).do(...) và các hàm liên quan)");
        return;
      }
      if (rule.actions.length === 0) bad(at, "luật không có hành động");
      if (seen.has(rule.name)) {
        bad(
          at,
          `trùng tên luật "${rule.name}" (tên luật dùng làm khoá chống trùng, phải duy nhất; dùng .named())`,
        );
      }
      seen.add(rule.name);
    });
    const runs = back.runs;
    if (runs) {
      const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
      if (
        runs.concurrency !== undefined &&
        !(Number.isInteger(runs.concurrency) && runs.concurrency >= 1)
      ) {
        bad("backoffice.runs.concurrency", "phải là số nguyên >= 1");
      }
      if (
        runs.pollIntervalMs !== undefined &&
        !(num(runs.pollIntervalMs) && runs.pollIntervalMs >= 0)
      ) {
        bad("backoffice.runs.pollIntervalMs", "phải là số >= 0 (ms)");
      }
      if (
        runs.heartbeatIntervalMs !== undefined &&
        !(
          num(runs.heartbeatIntervalMs) &&
          runs.heartbeatIntervalMs > 0 &&
          runs.heartbeatIntervalMs <= LEASE_MS / 2
        )
      ) {
        bad(
          "backoffice.runs.heartbeatIntervalMs",
          `phải > 0 và <= ${LEASE_MS / 2} ms (một nửa lease ${LEASE_MS / 1000} giây của server), không thì lease hết hạn giữa hai nhịp`,
        );
      }
      if (runs.runTimeoutMs !== undefined && !(num(runs.runTimeoutMs) && runs.runTimeoutMs > 0)) {
        bad("backoffice.runs.runTimeoutMs", "phải là số > 0 (ms)");
      }
      if (
        runs.maxAttempts !== undefined &&
        !(Number.isInteger(runs.maxAttempts) && runs.maxAttempts >= 1)
      ) {
        bad("backoffice.runs.maxAttempts", "phải là số nguyên >= 1");
      }
    }
  }
  return issues;
}

/**
 * Khai báo một bot. Chỉ kiểm tra và đặt kiểu; ném `BotDefinitionError` nếu sai.
 *
 * ```ts
 * export default defineBot({
 *   id: "tieulinh",
 *   tracker: { team: "tech", project: "TECH2" },
 *   backoffice: { agent: "tieulinh2", on: { mention: answerMention } },
 * });
 * ```
 */
export function defineBot<E extends EnvShape = Record<never, never>>(
  def: BotDefinition<E>,
): Readonly<BotDefinition<E>> {
  const issues = validateBotDefinition(def);
  if (issues.length > 0) throw new BotDefinitionError(def?.id, issues);
  return Object.freeze({ ...def });
}
