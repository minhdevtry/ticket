/**
 * Luật "sự kiện → điều kiện → hành động" chạy trên webhook mà itsaplan gửi
 * (đã qua `ItsaplanWebhookServer`: chữ ký, dedupe). Tất định, không gọi LLM:
 *
 * ```ts
 * rules: [
 *   whenColumn("Cần phân loại").do(
 *     actions.comment("Đã nhận, đang phân loại."),
 *     actions.setPriority("medium"),
 *   ),
 *   whenResolved().do(notifyOwner),
 *   whenCommentCreated((c) => c.text.includes("gấp")).do(actions.setPriority("high")),
 * ]
 * ```
 *
 * Luật chạy ngay trong process nhận webhook. Việc phải làm SAU một khoảng thời gian dùng
 * `actions.after("48h", fn)` hoặc `actions.closeAfter("48h")`: hẹn được ghi vào kho bền
 * (`BotStore`), tự chạy lại sau khi bot khởi động lại, và tự huỷ khi điều kiện đổi (người báo
 * trả lời, ticket mở lại…). Engine tự lọc sự kiện ngoài dự án (theo `projectId`), sự kiện do agent gây ra (chống vòng
 * lặp), comment của bot, và sự kiện trùng (chỉ đánh dấu "đã thấy" SAU khi xử lý không lỗi).
 *
 * Tên sự kiện theo server thật: `issue.created|updated|deleted|assigned|state_changed|
 * label_changed|link_changed`, `comment.created|updated|deleted`. Đổi cột phát
 * `issue.state_changed` (payload có `columnId` và `state`, KHÔNG có cột cũ; không có
 * `issue.column_changed`).
 */
import { randomUUID } from "node:crypto";
import { foldForComparison, isBotComment, stripCommentHtml } from "../core/formatting";
import type { IntakeLogger } from "../core/logger";
import { systemClock, type Clock } from "../intake/ports";
import {
  type ItsaplanIssue,
  type ItsaplanWebhookEnvelope,
  type ProjectColumn,
  type TicketState,
  classifyColumn,
  identifierInProject,
  webhookDedupeKey,
} from "../itsaplan";
import { type Llm, withSignal } from "../llm";
import { parseDuration } from "./duration";
import {
  type BotStore,
  type KeySet,
  MemoryKeySet,
  type TimerArmOutcome,
  type TimerArmSpec,
  type TimerRow,
} from "./store";
import type { ScopedTracker, TrackerPriority } from "./tracker";

/** Cột (tên + trạng thái) của issue tại thời điểm sự kiện. */
export interface RuleColumn {
  id: number;
  name: string;
  state: TicketState;
}

/** Sự kiện webhook đã được chuẩn hoá cho luật. */
export interface RuleEvent {
  /** Tên sự kiện, vd `issue.state_changed`, `comment.created`. */
  name: string;
  envelope: ItsaplanWebhookEnvelope;
  issueId: number | null;
  /** Mã đọc được, vd `TECH-42`, nếu payload có. */
  identifier: string | null;
  /** Cột hiện tại của issue (chỉ cho sự kiện issue có `columnId`). */
  column: RuleColumn | null;
  /** Chỉ cho `comment.*`: nội dung đã gỡ HTML. */
  comment: { id: number | null; raw: string; text: string } | null;
  actor: ItsaplanWebhookEnvelope["actor"];
}

/**
 * Khoá huỷ của hẹn giờ: sự kiện webhook làm một timer `pending` của CÙNG issue bị huỷ nếu timer
 * khai token đó trong `cancelOn`. Mọi timer còn bị huỷ khi issue bị xoá (`issue.deleted`).
 *
 * | Token | Sự kiện | Huỷ khi |
 * |---|---|---|
 * | `comment` | `comment.created` | có comment của người (không phải bot/agent) |
 * | `reporter-comment` | `comment.created` | comment đó là của người báo (xem `BackofficeDefinition.reporter`) |
 * | `state-change` | `issue.state_changed` | issue đổi cột (đi đâu cũng huỷ) |
 * | `reopened` | `issue.state_changed` | issue vào một cột còn mở (không phải Resolved/Done/huỷ) |
 * | `assigned` | `issue.assigned` | issue đổi người được giao |
 */
export type CancelToken = "comment" | "reporter-comment" | "state-change" | "reopened" | "assigned";

/** Sự kiện webhook mà từng token cần nghe (để đăng ký webhook đủ sự kiện). */
const TOKEN_EVENT: Record<CancelToken, string> = {
  comment: "comment.created",
  "reporter-comment": "comment.created",
  "state-change": "issue.state_changed",
  reopened: "issue.state_changed",
  assigned: "issue.assigned",
};

/** Ngữ cảnh hành động hẹn giờ khi đến hạn. */
export interface TimerContext<C = unknown> {
  /** Khoá của hẹn giờ (cũng là khoá huỷ trực tiếp). */
  readonly key: string;
  readonly rule: string;
  readonly issueId: number | null;
  readonly identifier: string | null;
  /** Lúc hẹn và hạn (epoch ms). */
  readonly armedAt: number;
  readonly dueAt: number;
  /** Lần chạy thứ mấy (>= 2 khi lần trước lỗi hoặc process sập giữa chừng). */
  readonly attempt: number;
  readonly config: C;
  readonly logger: IntakeLogger;
  readonly clock: Clock;
  /** Tracker khoá dự án; ghi bị từ chối khi `signal` huỷ (bot đang tắt). */
  readonly tracker: ScopedTracker;
  readonly signal: AbortSignal;
  /** Client LLM khi bot đã cấu hình (`LLM_*`), nếu không `undefined`; bị huỷ theo `signal`. */
  readonly llm: Llm | undefined;
  /**
   * Khoá ổn định của (hẹn giờ, lần hẹn): `timer:<key>#<gen>`. Chạy lại sau sập thì vẫn là khoá
   * này, nên truyền cho `tracker.comment({ idempotencyKey })` để không ghi trùng.
   */
  readonly idempotencyKey: string;
  /** Issue (đọc một lần rồi nhớ); `null` nếu không còn hoặc ngoài dự án. */
  issue(): Promise<ItsaplanIssue | null>;
  /** Đọc issue LẠI từ itsaplan, không dùng bản nhớ: dùng ngay trước một thao tác ghi quyết định. */
  freshIssue(): Promise<ItsaplanIssue | null>;
  /**
   * Ném {@link TimerCancelled} nếu hẹn này đã bị yêu cầu huỷ (người báo vừa trả lời, ticket vừa mở
   * lại…) hoặc không còn đang chạy ở process này. Mọi lệnh ghi của `ctx.tracker` đã tự gọi hàm này
   * trước khi ghi; gọi thêm khi hành động ghi ra ngoài bằng đường khác.
   */
  assertActive(): void;
  /** `actorId` có phải người báo của issue này không (theo `BackofficeDefinition.reporter`). */
  isReporter(actorId: string | null | undefined): Promise<boolean>;
}

/**
 * Ném từ hành động hẹn giờ (hoặc từ `ctx.assertActive()`) để HUỶ hẹn một cách có chủ ý: bộ chạy
 * đánh hẹn `cancelled` kèm lý do, không thử lại và không tính là lỗi.
 */
export class TimerCancelled extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "TimerCancelled";
  }
}

/** Hành động chạy khi hẹn giờ đến hạn. Ném lỗi thì được thử lại (có giới hạn). */
export type TimerAction<C = unknown> = (ctx: TimerContext<C>) => void | Promise<void>;

/**
 * Kiểm tra ngay trước khi chạy hành động hẹn giờ (phòng khi bot lỡ webhook lúc tắt). Trả `true`
 * để chạy; `false` hoặc một chuỗi lý do để HUỶ hẹn giờ này.
 */
export type TimerGuard<C = unknown> = (
  ctx: TimerContext<C>,
) => boolean | string | Promise<boolean | string>;

/** Thao tác hẹn giờ gắn với (luật, bước) hiện tại. */
export interface RuleTimers {
  /** Hẹn một timer. `rule`/`step` do engine điền. Trả kết quả hẹn (xem `TimerArmOutcome`). */
  arm(spec: Omit<TimerArmSpec, "rule" | "step">): TimerArmOutcome;
  /** Huỷ timer `pending` theo khoá. */
  cancel(key: string): boolean;
  /** Đọc một timer. */
  get(key: string): TimerRow | null;
}

export interface RuleContext<C = unknown> {
  readonly event: RuleEvent;
  readonly rule: string;
  /** Vị trí của hành động đang chạy trong `rule.actions`. */
  readonly step: number;
  /** Hẹn giờ bền (cần `RuleEngineOptions.store`; `createBot` luôn cấp). */
  readonly timers: RuleTimers;
  readonly tracker: ScopedTracker;
  readonly config: C;
  readonly logger: IntakeLogger;
  readonly clock: Clock;
  /** Khoá ổn định cho (luật, sự kiện): dùng làm khoá chống trùng cho hành động ghi ra ngoài. */
  readonly idempotencyKey: string;
  /** Issue của sự kiện (đọc một lần rồi nhớ). */
  issue(): Promise<ItsaplanIssue | null>;
}

export type RuleCondition<C = unknown> = (ctx: RuleContext<C>) => boolean | Promise<boolean>;
export type RuleAction<C = unknown> = (ctx: RuleContext<C>) => void | Promise<void>;

export interface Rule<C = unknown> {
  readonly name: string;
  /** Tên sự kiện kích hoạt luật. */
  readonly events: readonly string[];
  readonly conditions: readonly RuleCondition<C>[];
  readonly actions: readonly RuleAction<C>[];
  /**
   * Sự kiện phụ mà luật cần nghe chỉ để HUỶ hẹn giờ (không kích hoạt luật). Tự suy ra từ các
   * hành động `after`/`closeAfter`.
   */
  readonly watches?: readonly string[];
  /**
   * Luật có hành động cần biết ai là người báo (`closeAfter`, hoặc `cancelOn: ["reporter-comment"]`).
   * Khi có, `backoffice.reporter` là BẮT BUỘC (xem `ReporterResolver`).
   */
  readonly needsReporter?: boolean;
}

/** Dựng luật theo kiểu chuỗi; bất biến. Kết thúc bằng `.do(...)`. */
export class RuleBuilder<C = unknown> {
  constructor(
    private readonly ruleName: string,
    private readonly events: readonly string[],
    private readonly conditions: readonly RuleCondition<C>[] = [],
  ) {}

  /** Đặt tên luật (dùng trong log và khoá chống trùng). */
  named(name: string): RuleBuilder<C> {
    return new RuleBuilder(name, this.events, this.conditions);
  }

  /** Thêm điều kiện (tất cả phải đúng). */
  and(condition: RuleCondition<C>): RuleBuilder<C> {
    return new RuleBuilder(this.ruleName, this.events, [...this.conditions, condition]);
  }

  /** Chốt luật với danh sách hành động chạy tuần tự. */
  do(...actions: RuleAction<C>[]): Rule<C> {
    if (actions.length === 0) throw new Error(`Luật "${this.ruleName}" cần ít nhất một hành động`);
    const watches = [
      ...new Set(actions.flatMap((a) => (delayedOf(a) ? (delayedOf(a)?.watches ?? []) : []))),
    ].sort();
    const needsReporter = actions.some((a) => delayedOf(a)?.usesReporter === true);
    return Object.freeze({
      name: this.ruleName,
      events: this.events,
      conditions: this.conditions,
      actions,
      ...(watches.length > 0 ? { watches } : {}),
      ...(needsReporter ? { needsReporter } : {}),
    });
  }
}

/** Luật cho một hay nhiều loại sự kiện webhook. */
export function whenEvent<C = unknown>(...events: string[]): RuleBuilder<C> {
  if (events.length === 0) throw new Error("whenEvent cần ít nhất một tên sự kiện");
  return new RuleBuilder<C>(`when(${events.join("|")})`, events);
}

/** Issue vào cột `name` (được chuyển tới hoặc tạo trong cột đó). So khớp không phân biệt hoa thường/dấu. */
export function whenColumn<C = unknown>(name: string): RuleBuilder<C> {
  const wanted = foldForComparison(name);
  return new RuleBuilder<C>(
    `whenColumn(${name})`,
    ["issue.created", "issue.state_changed"],
    [(ctx) => !!ctx.event.column && foldForComparison(ctx.event.column.name) === wanted],
  );
}

/** Issue được chuyển sang cột "Resolved/Đã xử lý". */
export function whenResolved<C = unknown>(): RuleBuilder<C> {
  return new RuleBuilder<C>(
    "whenResolved",
    ["issue.state_changed"],
    [(ctx) => ctx.event.column?.state === "resolved"],
  );
}

/** Issue được chuyển sang nhóm hoàn tất (Done). */
export function whenDone<C = unknown>(): RuleBuilder<C> {
  return new RuleBuilder<C>(
    "whenDone",
    ["issue.state_changed"],
    [(ctx) => ctx.event.column?.state === "done"],
  );
}

/** Có comment mới (bỏ comment của bot). `predicate` lọc thêm theo nội dung. */
export function whenCommentCreated<C = unknown>(
  predicate?: (comment: { raw: string; text: string }, ctx: RuleContext<C>) => boolean,
): RuleBuilder<C> {
  return new RuleBuilder<C>(
    "whenCommentCreated",
    ["comment.created"],
    predicate
      ? [(ctx) => !!ctx.event.comment && predicate(ctx.event.comment, ctx)]
      : [(ctx) => !!ctx.event.comment],
  );
}

// ── hành động dựng sẵn ───────────────────────────────────────────────────────
// Gom trong namespace `actions`: tên trần như `comment` dễ lẫn với `ctx.comment`.

function requireIssueId(ctx: RuleContext<unknown>, action: string): number {
  if (ctx.event.issueId == null) {
    throw new Error(`${action}: sự kiện ${ctx.event.name} không gắn issue`);
  }
  return ctx.event.issueId;
}

/** Ghi comment lên issue của sự kiện (gắn dấu bot, chống trùng theo luật + sự kiện). */
function comment<C = unknown>(
  text: string | ((ctx: RuleContext<C>) => string | Promise<string>),
): RuleAction<C> {
  return async (ctx) => {
    const body = typeof text === "function" ? await text(ctx) : text;
    await ctx.tracker.comment(requireIssueId(ctx, "comment"), body, {
      idempotencyKey: ctx.idempotencyKey,
    });
  };
}

/** Chuyển issue sang cột theo tên. */
function moveTo<C = unknown>(column: string): RuleAction<C> {
  return async (ctx) => {
    await ctx.tracker.moveTo(requireIssueId(ctx, "moveTo"), column);
  };
}

/** Gán issue cho một người (`userId` itsaplan) hoặc bỏ gán (`null`). Nhận hàm để chọn theo ngữ cảnh. */
function assign<C = unknown>(
  user: string | null | ((ctx: RuleContext<C>) => string | null | Promise<string | null>),
): RuleAction<C> {
  return async (ctx) => {
    const userId = typeof user === "function" ? await user(ctx) : user;
    await ctx.tracker.assign(requireIssueId(ctx, "assign"), userId);
  };
}

/** Đặt mức ưu tiên. */
function setPriority<C = unknown>(priority: TrackerPriority): RuleAction<C> {
  return async (ctx) => {
    await ctx.tracker.setPriority(requireIssueId(ctx, "setPriority"), priority);
  };
}

// ── hẹn giờ ──────────────────────────────────────────────────────────────────

const DELAYED = Symbol.for("@vuihoc/bot-core/delayed-action");

interface DelayedAction<C> {
  readonly delayMs: number;
  readonly run: TimerAction<C>;
  readonly guard?: TimerGuard<C>;
  readonly cancelOn: readonly CancelToken[];
  readonly key?: string;
  readonly replace: boolean;
  /** Sự kiện cần nghe để huỷ hẹn. */
  readonly watches: readonly string[];
  /** Định danh ổn định của hành động (ghi vào hẹn; lệch lúc đến hạn thì bỏ hẹn). */
  readonly actionId: string;
  /** Hành động cần `backoffice.reporter`. */
  readonly usesReporter: boolean;
}

type DelayedFn<C> = RuleAction<C> & { readonly [DELAYED]?: DelayedAction<C> };

function delayedOf<C>(action: RuleAction<C>): DelayedAction<C> | undefined {
  return (action as DelayedFn<C>)[DELAYED];
}

/** Tuỳ chọn của `actions.after` và `actions.closeAfter`. */
export interface AfterOptions<C = unknown> {
  /**
   * Khoá của hẹn giờ, duy nhất trong bot. Mẫu BẮT BUỘC chứa `{issue}` (id issue; thiếu thì mọi
   * issue dùng chung một hẹn), có thể chứa thêm `{rule}`, `{step}`. Mặc định `{rule}#{step}:{issue}`:
   * mỗi (luật, bước, issue) có đúng một hẹn đang chờ. Đặt khoá chung để luật khác huỷ được bằng
   * `actions.cancelTimer(khoá)`. Mặc định khoá chứa vị trí bước: thêm/xoá/đổi thứ tự hành động
   * của luật làm khoá của hẹn đang chờ không còn khớp (hẹn cũ bị bỏ lúc đến hạn); đặt `key` và
   * `id` tường minh nếu cần chịu được việc sửa luật.
   */
  key?: string;
  /**
   * Định danh ổn định của hành động này. Mặc định suy từ loại và thời hạn (`after:172800000`).
   * Hẹn ghi định danh lúc hẹn; lúc đến hạn, nếu hành động hiện ở (luật, bước) đó có định danh khác
   * (luật đã bị sửa) thì hẹn bị bỏ thay vì chạy nhầm hành động khác.
   */
  id?: string;
  /** Token huỷ (xem `CancelToken`). Mặc định không có: chỉ huỷ bằng khoá hoặc khi issue bị xoá. */
  cancelOn?: readonly CancelToken[];
  /** Kiểm tra ngay trước khi chạy (huỷ hẹn nếu không còn đúng). */
  guard?: TimerGuard<C>;
  /**
   * Hẹn trùng khoá khi hẹn cũ còn `pending`: `false` (mặc định) giữ hẹn cũ, nên webhook giao lại
   * không đẩy lùi hạn; `true` dời hạn theo lần hẹn mới (kiểu debounce).
   */
  replace?: boolean;
}

function expandKey(template: string, rule: string, step: number, issueId: number | null): string {
  return template
    .replaceAll("{issue}", issueId === null ? "" : String(issueId))
    .replaceAll("{rule}", rule)
    .replaceAll("{step}", String(step));
}

const DEFAULT_KEY = "{rule}#{step}:{issue}";

/**
 * Chạy `run` sau `duration` (`"48h"`, `"90m"`, `"1d 12h"`, hoặc số ms). Hẹn được ghi vào kho
 * bền và tự chạy lại sau khi bot khởi động lại. `run` phải TẤT ĐỊNH và chạy lại được (có thể chạy
 * hai lần nếu bot sập giữa chừng): dùng `ctx.idempotencyKey` cho thao tác ghi.
 *
 * Hàm `run` không được ghi vào kho, chỉ vị trí (tên luật, bước) và định danh (`id`) của nó; vì
 * vậy KHÔNG đổi tên hay đổi thứ tự hành động của luật khi còn hẹn đang chờ (hẹn mồ côi hoặc lệch
 * định danh bị huỷ kèm log).
 */
function after<C = unknown>(
  duration: string | number,
  run: TimerAction<C>,
  options: AfterOptions<C> = {},
): RuleAction<C> {
  return buildDelayed("after", duration, run, options, {});
}

function buildDelayed<C>(
  kind: string,
  duration: string | number,
  run: TimerAction<C>,
  options: AfterOptions<C>,
  extra: { idSuffix?: string; usesReporter?: boolean },
): RuleAction<C> {
  const delayMs = parseDuration(duration);
  const cancelOn = [...new Set(options.cancelOn ?? [])];
  for (const token of cancelOn) {
    if (!(token in TOKEN_EVENT)) throw new Error(`cancelOn: token không biết "${token}"`);
  }
  if (options.key !== undefined && !options.key.includes("{issue}")) {
    throw new Error(
      `${kind}: key "${options.key}" thiếu {issue}: mọi issue sẽ dùng chung một hẹn (ví dụ đúng: "nhac:{issue}")`,
    );
  }
  const watches = [...new Set(["issue.deleted", ...cancelOn.map((t) => TOKEN_EVENT[t])])];
  const meta: DelayedAction<C> = {
    delayMs,
    run,
    guard: options.guard,
    cancelOn,
    key: options.key,
    replace: options.replace ?? false,
    watches,
    actionId:
      options.id !== undefined
        ? `id:${options.id}`
        : `${kind}:${delayMs}${extra.idSuffix ? `:${extra.idSuffix}` : ""}`,
    usesReporter: extra.usesReporter === true || cancelOn.includes("reporter-comment"),
  };
  const action: RuleAction<C> = (ctx) => {
    if (ctx.event.issueId == null) {
      throw new Error(`${kind}: sự kiện ${ctx.event.name} không gắn issue`);
    }
    const key = expandKey(meta.key ?? DEFAULT_KEY, ctx.rule, ctx.step, ctx.event.issueId);
    const outcome = ctx.timers.arm({
      key,
      dueAt: ctx.clock.now() + meta.delayMs,
      issueId: ctx.event.issueId,
      identifier: ctx.event.identifier,
      cancelOn: meta.cancelOn,
      replace: meta.replace,
      actionId: meta.actionId,
    });
    ctx.logger.info(
      `[rules] ${ctx.rule}: hẹn ${key} sau ${Math.round(meta.delayMs / 1000)}s (${outcome})`,
    );
  };
  return Object.assign(action, { [DELAYED]: meta });
}

/** Tuỳ chọn của `actions.closeAfter`. */
export interface CloseAfterOptions<C = unknown> extends AfterOptions<C> {
  /** Cột đích (theo tên, không phân biệt hoa thường/dấu). Mặc định cột đầu tiên thuộc nhóm Done. */
  to?: string;
  /** Comment ghi lên issue ngay trước khi đóng (chống trùng theo lần hẹn). */
  comment?: string | ((ctx: TimerContext<C>) => string | Promise<string>);
}

/**
 * "Resolved → Done sau `duration` trừ khi ticket được mở lại hoặc người báo trả lời."
 * Dùng với `whenResolved().do(actions.closeAfter("48h"))`.
 *
 * - Mặc định huỷ khi issue đổi cột (`state-change`) hoặc người báo comment (`reporter-comment`).
 * - Ngay trước khi đóng, bot kiểm lại bằng itsaplan (phòng lỡ webhook lúc tắt): issue còn ở cột
 *   Resolved và không có comment của người báo kể từ lúc issue VÀO cột Resolved (`statusSince` của
 *   server, không phải lúc bot hẹn); không thì huỷ hẹn, không đóng. Comment không có `createdAt`
 *   được coi là mới. Issue được đọc LẠI (không dùng bản nhớ) ngay trước comment và trước khi chuyển
 *   cột, và hành động dừng nếu có yêu cầu huỷ tới trong lúc chạy.
 * - BẮT BUỘC có `backoffice.reporter`: itsaplan không trả người báo trên issue, nên bot không tự
 *   biết. Dùng `anyHumanIsReporter` để tuyên bố rõ "mọi người comment đều tính là người báo".
 */
function closeAfter<C = unknown>(
  duration: string | number,
  options: CloseAfterOptions<C> = {},
): RuleAction<C> {
  const { to, comment: note, ...rest } = options;
  /** Lý do KHÔNG được đóng nữa, hoặc `null` nếu issue vẫn đang Resolved. */
  const notResolved = async (ctx: TimerContext<C>, issue: ItsaplanIssue | null) => {
    if (!issue) return "issue không còn hoặc ngoài dự án";
    const columns = await ctx.tracker.columns();
    const column = columns.find((c) => c.id === issue.columnId);
    if (!column || classifyColumn(column) !== "resolved") {
      return `issue không còn ở cột Resolved (${column?.name ?? issue.columnId})`;
    }
    return null;
  };
  const guard: TimerGuard<C> = async (ctx) => {
    const issue = await ctx.freshIssue();
    const why = await notResolved(ctx, issue);
    if (why !== null || !issue) return why ?? "issue không còn";
    // Mốc "đã Resolved": thời điểm issue vào cột hiện tại theo server; thiếu thì lúc bot hẹn.
    const since = issue.statusSince ? Date.parse(issue.statusSince) : Number.NaN;
    const resolvedAt = Number.isFinite(since) ? since : ctx.armedAt;
    for (const c of await ctx.tracker.comments(issue.id)) {
      if (isBotComment(c.body)) continue;
      const at = c.createdAt ? Date.parse(c.createdAt) : Number.NaN;
      // Không biết comment từ khi nào: coi là mới (thà không đóng còn hơn đóng nhầm).
      if (Number.isFinite(at) && !(at > resolvedAt)) continue;
      if (await ctx.isReporter(c.author?.id)) return "người báo đã trả lời sau khi Resolved";
    }
    return rest.guard ? rest.guard(ctx) : true;
  };
  return buildDelayed<C>(
    "closeAfter",
    duration,
    async (ctx) => {
      /** Đọc LẠI issue (không dùng bản nhớ) và dừng nếu hết Resolved hoặc có yêu cầu huỷ. */
      const recheck = async (): Promise<ItsaplanIssue> => {
        ctx.assertActive();
        const latest = await ctx.freshIssue();
        const why = await notResolved(ctx, latest);
        if (why !== null || !latest) throw new TimerCancelled(why ?? "issue không còn");
        return latest;
      };
      const issue = await recheck();
      const columns = await ctx.tracker.columns();
      const wanted = to === undefined ? undefined : foldForComparison(to);
      const target = columns.find((c) =>
        wanted === undefined ? classifyColumn(c) === "done" : foldForComparison(c.name) === wanted,
      );
      if (!target) {
        throw new Error(
          to === undefined
            ? "closeAfter: dự án không có cột thuộc nhóm Done"
            : `closeAfter: dự án không có cột "${to}"`,
        );
      }
      if (note !== undefined) {
        const text = typeof note === "function" ? await note(ctx) : note;
        await recheck(); // người dùng có thể vừa mở lại trong lúc dựng nội dung
        await ctx.tracker.comment(issue.id, text, { idempotencyKey: ctx.idempotencyKey });
      }
      // Ngay trước khi chuyển cột: đọc lại lần cuối (không cache).
      await recheck();
      await ctx.tracker.moveTo(issue.id, target.id);
    },
    {
      ...rest,
      cancelOn: rest.cancelOn ?? ["state-change", "reporter-comment"],
      guard,
    },
    { idSuffix: to === undefined ? undefined : `to=${foldForComparison(to)}`, usesReporter: true },
  );
}

/**
 * Huỷ hẹn giờ theo khoá (mẫu có `{issue}`/`{rule}`, như `AfterOptions.key`). Dùng khi một luật
 * khác cần dập hẹn của luật này, vd `whenColumn("Đang xử lý").do(actions.cancelTimer("close:{issue}"))`.
 */
function cancelTimer<C = unknown>(key: string): RuleAction<C> {
  return (ctx) => {
    const k = expandKey(key, ctx.rule, ctx.step, ctx.event.issueId);
    if (ctx.timers.cancel(k)) ctx.logger.info(`[rules] ${ctx.rule}: huỷ hẹn ${k}`);
  };
}

/**
 * Hành động dựng sẵn cho `.do(...)`: `actions.comment`, `actions.moveTo`, `actions.assign`,
 * `actions.setPriority`, và hẹn giờ bền `actions.after`, `actions.closeAfter`, `actions.cancelTimer`.
 */
export const actions = {
  comment,
  moveTo,
  assign,
  setPriority,
  after,
  closeAfter,
  cancelTimer,
} as const;

/** Bọc tracker: mọi lệnh ghi gọi `gate()` (ném `TimerCancelled`) ngay trước khi ghi. */
function gateWrites(tracker: ScopedTracker, gate: () => void): ScopedTracker {
  return {
    ...tracker,
    forSignal: (signal) => gateWrites(tracker.forSignal(signal), gate),
    comment: (...a) => (gate(), tracker.comment(...a)),
    moveTo: (...a) => (gate(), tracker.moveTo(...a)),
    assign: (...a) => (gate(), tracker.assign(...a)),
    setPriority: (...a) => (gate(), tracker.setPriority(...a)),
  };
}

// ── engine ───────────────────────────────────────────────────────────────────

export type RuleRunStatus = "done" | "skipped" | "failed";

export interface RuleRunSummary {
  rule: string;
  status: RuleRunStatus;
  /** Lý do bỏ qua hoặc thông điệp lỗi. */
  detail?: string;
}

export interface RuleEngineOptions<C> {
  rules: readonly Rule<C>[];
  tracker: ScopedTracker;
  config: C;
  logger: IntakeLogger;
  clock?: Clock;
  /**
   * Có xử lý sự kiện do một agent gây ra không. Mặc định false: agent comment/đổi cột
   * rồi webhook bắn ngược về luật là vòng lặp kinh điển.
   */
  reactToAgents?: boolean;
  /** Số khoá dedupe nhớ khi không có `seen`. Mặc định 2000. */
  dedupeSize?: number;
  /**
   * Tập khoá "sự kiện đã xử lý xong". Mặc định in-memory (mất khi restart); `createBot` cắm tập
   * bền (`BotStore.keys("rule-seen")`) khi có `dataDir`, nên webhook giao lại sau restart không
   * chạy luật lần hai.
   */
  seen?: KeySet;
  /** Kho bền cho hẹn giờ (`after`, `closeAfter`). Không có thì hành động hẹn giờ ném lỗi rõ ràng. */
  store?: BotStore;
  /** LLM của bot, đưa vào `TimerContext.llm` (gắn `signal` của từng lần chạy hẹn). */
  llm?: Llm;
  /**
   * `actorId` có phải người báo của issue không (để token huỷ `reporter-comment` và `closeAfter`
   * biết người báo đã trả lời). BẮT BUỘC khi có luật dùng chúng (`Rule.needsReporter`): itsaplan
   * không trả người báo trên issue nên bot không tự đoán được. Muốn "mọi người comment đều tính là
   * người báo" thì truyền `anyHumanIsReporter` (thận trọng: không tự đóng khi ai đó nói gì).
   */
  reporter?: ReporterResolver;
}

/** Quyết định một người dùng itsaplan có phải người báo của issue không. */
export type ReporterResolver = (info: {
  issue: ItsaplanIssue;
  actorId: string | null;
}) => boolean | Promise<boolean>;

/** Kết quả chạy một hẹn giờ đến hạn: `skipped` nghĩa là điều kiện không còn, hẹn bị huỷ. */
export type TimerFireResult = { status: "done" } | { status: "skipped"; reason: string };

/**
 * Tuyên bố "MỌI người (không phải bot) comment đều tính là người báo": `closeAfter` chỉ đóng khi
 * hoàn toàn không ai nói gì sau lúc Resolved. An toàn nhưng thận trọng; nếu bot biết danh sách
 * nhân viên thì viết hàm riêng loại họ ra.
 */
export const anyHumanIsReporter: ReporterResolver = () => true;

const ISSUE_EVENTS = new Set([
  "issue.created",
  "issue.updated",
  "issue.deleted",
  "issue.assigned",
  "issue.state_changed",
  "issue.label_changed",
  "issue.link_changed",
]);

/** Chạy luật trên từng webhook envelope. */
export class RuleEngine<C = unknown> {
  /** Khoá sự kiện đã xử lý XONG không lỗi. */
  private readonly seen: KeySet;
  /** Khoá đang xử lý (chặn hai lần giao đồng thời của cùng một sự kiện). */
  private readonly inflight = new Set<string>();
  private readonly clock: Clock;
  private readonly watched: Set<string>;
  private readonly reporter: ReporterResolver | undefined;

  constructor(private readonly o: RuleEngineOptions<C>) {
    const needing = o.rules.filter((r) => r.needsReporter).map((r) => r.name);
    if (needing.length > 0 && !o.reporter) {
      throw new Error(
        `luật ${needing.map((n) => `"${n}"`).join(", ")} dùng closeAfter/reporter-comment nên cần \`reporter\` (backoffice.reporter): itsaplan không trả người báo trên issue. Truyền một hàm xác định người báo, hoặc \`anyHumanIsReporter\` để coi mọi người comment là người báo`,
      );
    }
    this.clock = o.clock ?? systemClock;
    this.seen = o.seen ?? new MemoryKeySet(o.dedupeSize ?? 2000);
    this.reporter = o.reporter;
    this.watched = new Set(o.rules.flatMap((r) => r.watches ?? []));
  }

  /**
   * Tên các sự kiện webhook mà bộ luật cần (để đăng ký webhook chỉ với những sự kiện này): sự
   * kiện kích hoạt luật cộng sự kiện chỉ để huỷ hẹn giờ.
   */
  requiredEvents(): string[] {
    return [...new Set(this.o.rules.flatMap((r) => [...r.events, ...(r.watches ?? [])]))].sort();
  }

  /** Bộ luật có hành động hẹn giờ không (khi có thì `createBot` bật bộ chạy hẹn giờ). */
  hasTimers(): boolean {
    return this.watched.size > 0;
  }

  private markSeen(key: string): void {
    try {
      this.seen.add(key);
    } catch (err) {
      // Không ghi được dấu "đã thấy" thì tệ nhất là xử lý lại một sự kiện giao lại; không làm hỏng luật.
      this.o.logger.warn(`[rules] không ghi được khoá dedupe: ${errMsg(err)}`);
    }
  }

  /**
   * Xử lý một envelope. Không bao giờ ném: lỗi của từng luật được ghi vào kết quả và log,
   * các luật khác vẫn chạy. Trả danh sách luật đã khớp (rỗng nếu bị lọc/không khớp).
   *
   * Dedupe: chỉ khi payload có `webhookTimestamp` (không có thì không dedupe, và khoá chống
   * trùng của hành động ghi mang một nonce để không nuốt nhầm sự kiện khác). Sự kiện chỉ được
   * đánh dấu "đã thấy" SAU khi xử lý không lỗi, nên giao lại sau lỗi vẫn được chạy.
   */
  async handle(envelope: ItsaplanWebhookEnvelope): Promise<RuleRunSummary[]> {
    const { logger } = this.o;
    const candidates = this.o.rules.filter((r) => r.events.includes(envelope.event));
    const watching = this.o.store !== undefined && this.watched.has(envelope.event);
    if (candidates.length === 0 && !watching) return [];

    const dedupeKey = webhookDedupeKey(envelope);
    if (dedupeKey && (this.seen.has(dedupeKey) || this.inflight.has(dedupeKey))) return [];

    if (!this.o.reactToAgents && envelope.actor?.type === "agent") return [];

    if (dedupeKey) this.inflight.add(dedupeKey);
    try {
      let normalized: { event: RuleEvent; issue: ItsaplanIssue | null } | null;
      try {
        normalized = await this.normalize(envelope);
      } catch (err) {
        // Chưa biết sự kiện có thuộc ta không (vd itsaplan đang lỗi): KHÔNG đánh dấu đã thấy.
        logger.warn(`[rules] ${envelope.event}: không đọc được sự kiện: ${errMsg(err)}`);
        return [];
      }
      if (!normalized) {
        if (dedupeKey) this.markSeen(dedupeKey);
        return [];
      }
      if (watching) await this.cancelTimersFor(normalized.event, normalized.issue);
      const results = await this.runRules(envelope, candidates, normalized);
      if (dedupeKey && results.every((r) => r.status !== "failed")) this.markSeen(dedupeKey);
      return results;
    } finally {
      if (dedupeKey) this.inflight.delete(dedupeKey);
    }
  }

  private async runRules(
    envelope: ItsaplanWebhookEnvelope,
    candidates: readonly Rule<C>[],
    normalized: { event: RuleEvent; issue: ItsaplanIssue | null },
  ): Promise<RuleRunSummary[]> {
    const { logger, tracker } = this.o;
    const { event } = normalized;
    let issueCache: Promise<ItsaplanIssue | null> | undefined =
      normalized.issue === null ? undefined : Promise.resolve(normalized.issue);
    const loadIssue = () => {
      issueCache ??=
        event.issueId == null ? Promise.resolve(null) : tracker.getIssue(event.issueId);
      return issueCache;
    };
    // Không có timestamp thì không thể phân biệt hai sự kiện giống nhau: dùng nonce để khoá
    // chống trùng không nuốt nhầm sự kiện khác (đổi lại không chống được giao lại).
    const delivery = envelope.webhookTimestamp ?? `nonce-${randomUUID()}`;

    const results: RuleRunSummary[] = [];
    for (const rule of candidates) {
      const base = {
        event,
        rule: rule.name,
        tracker,
        config: this.o.config,
        logger,
        clock: this.clock,
        idempotencyKey: `rule:${rule.name}:${event.name}:${event.issueId ?? ""}:${event.comment?.id ?? ""}:${delivery}`,
        issue: loadIssue,
      };
      try {
        let matched = true;
        const first = this.stepContext(base, rule.name, 0);
        for (const condition of rule.conditions) {
          if (!(await condition(first))) {
            matched = false;
            break;
          }
        }
        if (!matched) continue;
        for (const [step, action] of rule.actions.entries()) {
          await action(this.stepContext(base, rule.name, step));
        }
        results.push({ rule: rule.name, status: "done" });
        logger.info(`[rules] ${rule.name}: xong cho ${event.identifier ?? event.issueId}`);
      } catch (err) {
        results.push({ rule: rule.name, status: "failed", detail: errMsg(err) });
        logger.warn(`[rules] ${rule.name}: lỗi — ${errMsg(err)}`);
      }
    }
    return results;
  }

  private stepContext(
    base: Omit<RuleContext<C>, "step" | "timers">,
    rule: string,
    step: number,
  ): RuleContext<C> {
    const store = this.o.store;
    const need = (): BotStore => {
      if (!store) {
        throw new Error(
          "hẹn giờ cần kho bền: truyền `store` cho RuleEngine (createBot tự cấp, mặc định in-memory)",
        );
      }
      return store;
    };
    return {
      ...base,
      step,
      timers: {
        arm: (spec) => need().armTimer({ ...spec, rule, step }, this.clock.now()).outcome,
        cancel: (key) => need().cancelTimer(key, "huỷ bằng luật", this.clock.now()),
        get: (key) => need().getTimer(key),
      },
    };
  }

  /**
   * Huỷ hẹn giờ `pending` của issue theo sự kiện vừa tới (xem `CancelToken`). Chạy TRƯỚC khi luật
   * của chính sự kiện này hẹn mới. Lỗi kho chỉ ghi log: bước kiểm tra lúc đến hạn vẫn bảo vệ.
   */
  private async cancelTimersFor(event: RuleEvent, issue: ItsaplanIssue | null): Promise<void> {
    const store = this.o.store;
    if (!store || event.issueId == null) return;
    const id = event.issueId;
    const now = this.clock.now();
    const cancel = (token: CancelToken, why: string) => {
      const n = store.cancelByToken(id, token, why, now);
      if (n > 0) this.o.logger.info(`[rules] huỷ ${n} hẹn của ${event.identifier ?? id}: ${why}`);
    };
    try {
      switch (event.name) {
        case "issue.deleted": {
          const n = store.cancelAllForIssue(id, "issue bị xoá", now);
          if (n > 0) this.o.logger.info(`[rules] huỷ ${n} hẹn của issue ${id}: issue bị xoá`);
          break;
        }
        case "issue.state_changed":
          cancel("state-change", `đổi cột sang "${event.column?.name ?? "?"}"`);
          if (event.column?.state === "open")
            cancel("reopened", `mở lại ở cột "${event.column.name}"`);
          break;
        case "issue.assigned":
          cancel("assigned", "đổi người được giao");
          break;
        case "comment.created": {
          cancel("comment", "có comment của người");
          const actorId = event.actor?.id == null ? null : String(event.actor.id);
          const known = issue ?? (await this.o.tracker.getIssue(id));
          if (known && this.reporter && (await this.reporter({ issue: known, actorId }))) {
            cancel("reporter-comment", "người báo trả lời");
          }
          break;
        }
        default:
          break;
      }
    } catch (err) {
      this.o.logger.warn(`[rules] huỷ hẹn giờ cho ${event.name} lỗi: ${errMsg(err)}`);
    }
  }

  /**
   * Chạy hành động của một hẹn giờ đến hạn (do bộ chạy hẹn giờ gọi, đã claim). Tìm hành động theo
   * (tên luật, bước) trong khai báo hiện tại; không thấy thì `skipped`. Chạy `guard` rồi hành động.
   * Ném lỗi của hành động để bộ chạy thử lại.
   */
  async fireTimer(row: TimerRow, signal: AbortSignal): Promise<TimerFireResult> {
    const rule = this.o.rules.find((r) => r.name === row.rule);
    const meta = rule ? delayedOf(rule.actions[row.step] ?? (() => {})) : undefined;
    if (!rule || !meta) {
      return {
        status: "skipped",
        reason: `luật "${row.rule}" bước ${row.step} không còn trong khai báo`,
      };
    }
    if (row.actionId !== null && row.actionId !== meta.actionId) {
      return {
        status: "skipped",
        reason: `hành động của luật "${row.rule}" bước ${row.step} đã đổi (${row.actionId} → ${meta.actionId}): hẹn bị bỏ`,
      };
    }
    const store = this.o.store;
    const gate = (): void => {
      const why = store?.timerBlocked(row.key, row.gen);
      if (why) throw new TimerCancelled(why);
    };
    const tracker = gateWrites(this.o.tracker.forSignal(signal), gate);
    let issueCache: Promise<ItsaplanIssue | null> | undefined;
    const freshIssue = () =>
      row.issueId == null ? Promise.resolve(null) : tracker.getIssue(row.issueId);
    const issue = () => {
      issueCache ??= freshIssue();
      issueCache.catch(() => {
        issueCache = undefined;
      });
      return issueCache;
    };
    const reporter = this.reporter;
    const ctx: TimerContext<C> = {
      key: row.key,
      rule: row.rule,
      issueId: row.issueId,
      identifier: row.identifier,
      armedAt: row.armedAt,
      dueAt: row.dueAt,
      attempt: row.attempts,
      config: this.o.config,
      logger: this.o.logger,
      clock: this.clock,
      tracker,
      signal,
      llm: this.o.llm ? withSignal(this.o.llm, signal) : undefined,
      idempotencyKey: `timer:${row.key}#${row.gen}`,
      issue,
      freshIssue,
      assertActive: gate,
      isReporter: async (actorId) => {
        if (!reporter) return true; // không có hàm xác định: thận trọng, coi là người báo
        const known = await issue();
        return known ? reporter({ issue: known, actorId: actorId ?? null }) : false;
      },
    };
    try {
      gate();
      if (meta.guard) {
        const verdict = await meta.guard(ctx);
        if (verdict !== true) {
          return {
            status: "skipped",
            reason: typeof verdict === "string" ? verdict : "guard trả false",
          };
        }
      }
      await meta.run(ctx);
      return { status: "done" };
    } catch (err) {
      if (err instanceof TimerCancelled) return { status: "skipped", reason: err.reason };
      throw err;
    }
  }

  /**
   * Chuẩn hoá envelope; `null` nếu sự kiện không thuộc dự án của bot hoặc không dùng được.
   * Ném nếu không xác minh được dự án (lỗi tạm thời): caller KHÔNG được coi đó là "ngoài dự án".
   */
  private async normalize(
    envelope: ItsaplanWebhookEnvelope,
  ): Promise<{ event: RuleEvent; issue: ItsaplanIssue | null } | null> {
    const data = envelope.data ?? {};
    const name = envelope.event;
    const isComment = name.startsWith("comment.");
    const issueId = numberOrNull(isComment ? data.issueId : (data.id ?? data.issueId));
    const identifierRaw = isComment ? data.issue?.identifier : data.identifier;
    let identifier = typeof identifierRaw === "string" ? identifierRaw : null;

    // Lọc rẻ theo mã (itsaplan gửi sự kiện của MỌI dự án tới mọi webhook), rồi xác minh bằng
    // projectId: mã chỉ duy nhất trong team và đổi khi issue chuyển dự án.
    if (identifier && !identifierInProject(identifier, this.o.tracker.projectKey)) return null;
    const { projectId } = await this.o.tracker.ready();
    let issue: ItsaplanIssue | null = null;
    const payloadProjectId = isComment ? null : numberOrNull(data.projectId);
    if (payloadProjectId !== null) {
      if (payloadProjectId !== projectId) return null;
    } else {
      // Payload (comment) không có projectId: hỏi tracker (đã khoá theo projectId).
      if (issueId == null) return null;
      issue = await this.o.tracker.getIssue(issueId);
      if (!issue) return null;
      identifier ??= issue.identifier;
    }

    let column: RuleColumn | null = null;
    if (ISSUE_EVENTS.has(name)) column = await this.resolveColumn(data);

    let commentInfo: RuleEvent["comment"] = null;
    if (isComment) {
      const raw = typeof data.body === "string" ? data.body : "";
      if (isBotComment(raw)) return null;
      commentInfo = { id: numberOrNull(data.id), raw, text: stripCommentHtml(raw) };
    }

    return {
      event: {
        name,
        envelope,
        issueId,
        identifier,
        column,
        comment: commentInfo,
        actor: envelope.actor,
      },
      issue,
    };
  }

  private async resolveColumn(data: any): Promise<RuleColumn | null> {
    const columnId = numberOrNull(data?.columnId);
    const fromPayload = (): RuleColumn | null => {
      const st = data?.state;
      if (columnId == null || !st || typeof st.name !== "string") return null;
      const column = { name: st.name, stateType: st.type } as Pick<
        ProjectColumn,
        "name" | "stateType"
      >;
      return { id: columnId, name: st.name, state: classifyColumn(column) };
    };
    if (columnId == null) return null;
    // Payload của server thật mang `state` {name, type} của cột: dùng nó trước (đúng thời điểm
    // sự kiện). Chỉ khi thiếu mới tra danh sách cột.
    const direct = fromPayload();
    if (direct) return direct;
    try {
      const columns = await this.o.tracker.columns();
      const hit = columns.find((c) => c.id === columnId);
      if (hit) return { id: hit.id, name: hit.name, state: classifyColumn(hit) };
    } catch {
      // không tra được cột: luật dùng cột sẽ không khớp
    }
    return null;
  }
}

const numberOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return v != null && Number.isFinite(n) && n > 0 ? n : null;
};
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
