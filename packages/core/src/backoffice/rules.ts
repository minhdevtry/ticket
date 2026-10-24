/**
 * Luật "sự kiện → điều kiện → hành động" chạy trên webhook mà itsaplan gửi
 * (đã qua `ItsaplanWebhookServer`: chữ ký, dedupe). Tất định, không gọi LLM:
 *
 * ```ts
 * rules: [
 *   whenColumn("Cần phân loại").do(comment("Đã nhận, đang phân loại."), setPriority("medium")),
 *   whenResolved().do(notifyOwner),
 *   whenCommentCreated((c) => c.text.includes("gấp")).do(setPriority("high")),
 * ]
 * ```
 *
 * Milestone 1: luật chạy ngay trong process nhận webhook, KHÔNG có hàng đợi bền hay
 * hẹn giờ (nên chưa có `closeAfter("48h")`: cần kho hẹn giờ bền, thuộc milestone 2).
 * Engine tự lọc sự kiện ngoài dự án, sự kiện do agent gây ra (chống vòng lặp), comment
 * của bot, và sự kiện trùng.
 */
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

export interface RuleContext<C = unknown> {
  readonly event: RuleEvent;
  readonly rule: string;
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
    return Object.freeze({
      name: this.ruleName,
      events: this.events,
      conditions: this.conditions,
      actions,
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
    ["issue.created", "issue.state_changed", "issue.column_changed"],
    [(ctx) => !!ctx.event.column && foldForComparison(ctx.event.column.name) === wanted],
  );
}

/** Issue được chuyển sang cột "Resolved/Đã xử lý". */
export function whenResolved<C = unknown>(): RuleBuilder<C> {
  return new RuleBuilder<C>(
    "whenResolved",
    ["issue.state_changed", "issue.column_changed"],
    [(ctx) => ctx.event.column?.state === "resolved"],
  );
}

/** Issue được chuyển sang nhóm hoàn tất (Done). */
export function whenDone<C = unknown>(): RuleBuilder<C> {
  return new RuleBuilder<C>(
    "whenDone",
    ["issue.state_changed", "issue.column_changed"],
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

function requireIssueId(ctx: RuleContext<unknown>, action: string): number {
  if (ctx.event.issueId == null) {
    throw new Error(`${action}: sự kiện ${ctx.event.name} không gắn issue`);
  }
  return ctx.event.issueId;
}

/** Ghi comment lên issue của sự kiện (gắn dấu bot, chống trùng theo luật + sự kiện). */
export function comment<C = unknown>(
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
export function moveTo<C = unknown>(column: string): RuleAction<C> {
  return async (ctx) => {
    await ctx.tracker.moveTo(requireIssueId(ctx, "moveTo"), column);
  };
}

/** Gán issue cho một người (`userId` itsaplan) hoặc bỏ gán (`null`). Nhận hàm để chọn theo ngữ cảnh. */
export function assign<C = unknown>(
  user: string | null | ((ctx: RuleContext<C>) => string | null | Promise<string | null>),
): RuleAction<C> {
  return async (ctx) => {
    const userId = typeof user === "function" ? await user(ctx) : user;
    await ctx.tracker.assign(requireIssueId(ctx, "assign"), userId);
  };
}

/** Đặt mức ưu tiên. */
export function setPriority<C = unknown>(priority: TrackerPriority): RuleAction<C> {
  return async (ctx) => {
    await ctx.tracker.setPriority(requireIssueId(ctx, "setPriority"), priority);
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
  /** Số khoá dedupe nhớ. Mặc định 2000. */
  dedupeSize?: number;
}

const ISSUE_EVENTS = new Set([
  "issue.created",
  "issue.updated",
  "issue.deleted",
  "issue.assigned",
  "issue.state_changed",
  "issue.column_changed",
  "issue.label_changed",
  "issue.link_changed",
]);

/** Chạy luật trên từng webhook envelope. */
export class RuleEngine<C = unknown> {
  private readonly seen = new Set<string>();
  private readonly clock: Clock;

  constructor(private readonly o: RuleEngineOptions<C>) {
    this.clock = o.clock ?? systemClock;
  }

  /** Tên các sự kiện webhook mà bộ luật cần (để đăng ký webhook chỉ với những sự kiện này). */
  requiredEvents(): string[] {
    return [...new Set(this.o.rules.flatMap((r) => r.events))].sort();
  }

  /**
   * Xử lý một envelope. Không bao giờ ném: lỗi của từng luật được ghi vào kết quả và log,
   * các luật khác vẫn chạy. Trả danh sách luật đã khớp (rỗng nếu bị lọc/không khớp).
   */
  async handle(envelope: ItsaplanWebhookEnvelope): Promise<RuleRunSummary[]> {
    const { logger, tracker } = this.o;
    const candidates = this.o.rules.filter((r) => r.events.includes(envelope.event));
    if (candidates.length === 0) return [];

    const dedupeKey = webhookDedupeKey(envelope);
    if (dedupeKey) {
      if (this.seen.has(dedupeKey)) return [];
      this.seen.add(dedupeKey);
      if (this.seen.size > (this.o.dedupeSize ?? 2000)) {
        const oldest = this.seen.values().next().value;
        if (oldest !== undefined) this.seen.delete(oldest);
      }
    }

    if (!this.o.reactToAgents && envelope.actor?.type === "agent") return [];

    let event: RuleEvent | null;
    try {
      event = await this.normalize(envelope);
    } catch (err) {
      logger.warn(`[rules] ${envelope.event}: không đọc được sự kiện: ${errMsg(err)}`);
      return [];
    }
    if (!event) return [];

    let issueCache: Promise<ItsaplanIssue | null> | undefined;
    const loadIssue = () => {
      issueCache ??=
        event.issueId == null ? Promise.resolve(null) : tracker.getIssue(event.issueId);
      return issueCache;
    };

    const results: RuleRunSummary[] = [];
    for (const rule of candidates) {
      const ctx: RuleContext<C> = {
        event,
        rule: rule.name,
        tracker,
        config: this.o.config,
        logger,
        clock: this.clock,
        idempotencyKey: `rule:${rule.name}:${event.name}:${event.issueId ?? ""}:${event.comment?.id ?? ""}:${envelope.webhookTimestamp ?? ""}`,
        issue: loadIssue,
      };
      try {
        let matched = true;
        for (const condition of rule.conditions) {
          if (!(await condition(ctx))) {
            matched = false;
            break;
          }
        }
        if (!matched) continue;
        for (const action of rule.actions) await action(ctx);
        results.push({ rule: rule.name, status: "done" });
        logger.info(`[rules] ${rule.name}: xong cho ${event.identifier ?? event.issueId}`);
      } catch (err) {
        results.push({ rule: rule.name, status: "failed", detail: errMsg(err) });
        logger.warn(`[rules] ${rule.name}: lỗi — ${errMsg(err)}`);
      }
    }
    return results;
  }

  /** Chuẩn hoá envelope; `null` nếu sự kiện không thuộc dự án của bot hoặc không dùng được. */
  private async normalize(envelope: ItsaplanWebhookEnvelope): Promise<RuleEvent | null> {
    const data = envelope.data ?? {};
    const name = envelope.event;
    const isComment = name.startsWith("comment.");
    const issueId = numberOrNull(isComment ? data.issueId : (data.id ?? data.issueId));
    const identifierRaw = isComment ? data.issue?.identifier : data.identifier;
    let identifier = typeof identifierRaw === "string" ? identifierRaw : null;

    // Khoá dự án: ưu tiên mã trong payload; không có thì hỏi tracker (đã tự khoá dự án).
    if (identifier) {
      if (!identifierInProject(identifier, this.o.tracker.projectKey)) return null;
    } else {
      if (issueId == null) return null;
      const issue = await this.o.tracker.getIssue(issueId);
      if (!issue) return null;
      identifier = issue.identifier;
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
      name,
      envelope,
      issueId,
      identifier,
      column,
      comment: commentInfo,
      actor: envelope.actor,
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
    try {
      const columns = await this.o.tracker.columns();
      const hit = columns.find((c) => c.id === columnId);
      if (hit) return { id: hit.id, name: hit.name, state: classifyColumn(hit) };
    } catch {
      // rơi xuống payload
    }
    return fromPayload();
  }
}

const numberOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return v != null && Number.isFinite(n) && n > 0 ? n : null;
};
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
