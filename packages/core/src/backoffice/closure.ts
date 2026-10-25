/**
 * `TicketClosure` — vòng đời "đã xử lý → hoàn tất" nhìn từ phía người báo, cho bot hậu cần.
 *
 * Luật (ADR-0006 của Tiểu Linh, áp cho mọi bot dùng lớp này):
 *  - CHỈ người xử lý chuyển ticket sang Done. Lớp này không bao giờ đổi cột, không hẹn giờ đóng.
 *  - Ticket sang Resolved → báo người báo kèm nút "Đã ổn". Bấm nút (hoặc `recordReporterOk`) chỉ
 *    ghi MỘT comment cho người xử lý tham khảo; ticket vẫn ở Resolved chờ người xử lý kiểm tra.
 *    Người báo không bấm thì không suy ra điều gì.
 *  - Sang Done/Canceled/mở lại → báo người báo (không nút) và gỡ nút "Đã ổn" của tin cũ.
 *
 * Trạng thái cuối cùng đã thấy nằm trong `TicketStateStore`: nó là chốt chống trùng (một lần kéo
 * cột bắn nhiều sự kiện, webhook có thể tới lại; đổi giữa hai cột cùng nhóm "mở" không báo gì) và
 * nhớ tin nào đang mang nút. Kênh gửi là `ChannelPort`; chữ nghĩa do `copy` tiêm vào (không có
 * chuỗi tiếng Việt trong logic).
 *
 * Dùng như một hành động của luật: `whenEvent("issue.state_changed").do(closure.onStateChanged)`.
 * `recordReporterOk` do kênh vào (callback nút Telegram…) gọi, kèm tracker khoá dự án để kiểm
 * ticket thuộc dự án của bot (ADR-0001).
 *
 * NGUỒN: intake `worker/ticket-closure.ts` (bỏ phần nạp tri thức KG/Onyx và phần riêng của PO).
 */
import { getLogger } from "../core/logger";
import { classifyColumn, projectOfIdentifier } from "../itsaplan";
import type {
  ChannelPort,
  Clock,
  MessageRouteStore,
  NotifyBinding,
  NotifyBindingReader,
  StateChangeCopyMap,
  TicketLifecycleState,
  TicketStateStore,
} from "../intake/ports";
import { systemClock } from "../intake/ports";
import type { RuleContext } from "./rules";
import type { ScopedTracker } from "./tracker";

/** Chữ bot nói với người bấm "Đã ổn" và chữ của comment ghi cho người xử lý. */
export interface ReporterOkCopy {
  /** Thân comment ghi lên ticket (bot tự gắn dấu bot). */
  comment(vars: { who: string; time: string }): string;
  /** Câu trả lời khi đã ghi nhận (kể cả bấm lần hai). */
  ack(): string;
  /** Không có ticket (không có liên kết chat, hoặc ngoài dự án của bot). */
  unknown(): string;
  /** Nút thuộc cuộc trò chuyện khác. */
  notYourChat(): string;
  done(vars: { identifier: string }): string;
  canceled(vars: { identifier: string }): string;
  /** Ticket đã được kéo ra khỏi Resolved (đang xử lý lại). */
  reopened(vars: { identifier: string }): string;
}

export interface TicketClosureOptions {
  states: TicketStateStore;
  bindings: NotifyBindingReader;
  routes: MessageRouteStore;
  channel: ChannelPort;
  /** Lời báo mỗi lần đổi trạng thái; trả `null` = không báo gì. */
  copy: StateChangeCopyMap;
  okCopy: ReporterOkCopy;
  clock?: Clock;
  /** Định dạng giờ trong comment "Đã ổn". Mặc định ISO. */
  formatTime?: (ms: number) => string;
}

/** Kết quả `recordReporterOk`: `outcome` cho log/test, `replyText` là câu bot nói với người bấm. */
export type ReporterOkOutcome =
  | "recorded"
  | "already_recorded"
  | "done"
  | "canceled"
  | "reopened"
  | "not_bound"
  | "unknown";

export interface ReporterOkResult {
  outcome: ReporterOkOutcome;
  replyText: string;
}

const rawChat = (chatId: string | number) =>
  String(chatId)
    .replace(/^telegram:/i, "")
    .trim();

export class TicketClosure {
  private readonly clock: Clock;
  private readonly formatTime: (ms: number) => string;

  constructor(private readonly o: TicketClosureOptions) {
    this.clock = o.clock ?? systemClock;
    this.formatTime = o.formatTime ?? ((ms) => new Date(ms).toISOString());
  }

  /**
   * Hành động của luật cho `issue.state_changed`: báo người báo nếu NHÓM trạng thái đổi. Lỗi gửi
   * tin chỉ được log: trạng thái đã ghi nên lần sau không báo lại (thà thiếu một tin còn hơn báo
   * lặp), và một lần gửi hỏng không làm hỏng luật khác.
   */
  readonly onStateChanged = async (ctx: Pick<RuleContext, "event" | "logger">): Promise<void> => {
    const { event } = ctx;
    if (event.issueId === null || !event.identifier || !event.column) return;
    const { issueId, identifier, column } = event;
    const prev = this.o.states.get(issueId);
    if (prev?.state === column.state) return;

    this.o.states.enter({
      issueId,
      identifier,
      state: column.state,
      columnId: column.id,
      now: this.clock.now(),
    });

    const binding = this.o.bindings.getBindingByIssueId(issueId);
    if (!binding) return;
    if (prev?.state === "resolved" && prev.promptMessageId) {
      await this.clearButtons(binding, prev.promptMessageId);
    }
    const project = projectOfIdentifier(identifier);
    const message =
      project &&
      this.o.copy.describe({ project, columnName: column.name, state: column.state, identifier });
    if (!message) return;
    try {
      const sent = await this.o.channel.sendStateChange({
        binding,
        message,
        state: column.state,
        // ADR-0006: nút "Đã ổn" chỉ ghi comment, không đổi trạng thái.
        withReporterOkButton: column.state === "resolved",
      });
      if (sent === undefined || sent === null) return;
      this.o.routes.saveMessageRoute({
        messageId: String(sent),
        channelType: binding.channelType,
        chatId: binding.chatId,
        issueId,
        identifier: binding.identifier,
        kind: "state",
      });
      if (column.state === "resolved") this.o.states.setPrompt(issueId, String(sent));
    } catch (err) {
      ctx.logger.error(
        `[closure] báo ${binding.identifier} cho người báo lỗi: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /**
   * Người báo bấm "Đã ổn". CHỈ ghi comment — không đổi cột, không hẹn giờ. Trạng thái xét theo
   * itsaplan ngay lúc bấm (nút có thể đã cũ). `tracker` khoá dự án: ticket ngoài dự án là "không biết".
   */
  async recordReporterOk(
    tracker: Pick<ScopedTracker, "getIssue" | "columns" | "comment">,
    request: { issueId: number; chatId: string | number; userName?: string },
  ): Promise<ReporterOkResult> {
    const { okCopy } = this.o;
    const { issueId } = request;
    const binding = this.o.bindings.getBindingByIssueId(issueId);
    const issue = binding ? await tracker.getIssue(issueId) : null;
    if (!binding || !issue) return { outcome: "unknown", replyText: okCopy.unknown() };
    if (rawChat(binding.chatId) !== rawChat(request.chatId)) {
      getLogger().warn(
        `[closure] "Đã ổn" cho ${binding.identifier} từ chat lạ ${request.chatId}, bỏ qua.`,
      );
      return { outcome: "not_bound", replyText: okCopy.notYourChat() };
    }

    const id = binding.identifier;
    const state = await this.liveState(tracker, issue.columnId, issueId);
    if (state === "done") return { outcome: "done", replyText: okCopy.done({ identifier: id }) };
    if (state === "canceled") {
      return { outcome: "canceled", replyText: okCopy.canceled({ identifier: id }) };
    }
    if (state !== "resolved") {
      return { outcome: "reopened", replyText: okCopy.reopened({ identifier: id }) };
    }

    const row = this.o.states.get(issueId);
    if (row?.reporterOkAt) return { outcome: "already_recorded", replyText: okCopy.ack() };

    const now = this.clock.now();
    await tracker.comment(
      issueId,
      okCopy.comment({ who: request.userName?.trim() || "Người báo", time: this.formatTime(now) }),
      // Hai lần bấm gần nhau (callback giao đôi) chỉ ghi một comment.
      { idempotencyKey: `reporter-ok:${issueId}:${row?.updatedAt ?? 0}` },
    );
    if (row) this.o.states.markReporterOk(issueId, now);
    else {
      this.o.states.enter({ issueId, identifier: id, state: "resolved", columnId: null, now });
      this.o.states.markReporterOk(issueId, now);
    }
    if (row?.promptMessageId) await this.clearButtons(binding, row.promptMessageId);
    return { outcome: "recorded", replyText: okCopy.ack() };
  }

  private async clearButtons(binding: NotifyBinding, messageId: string): Promise<void> {
    await this.o.channel.clearInteractiveButtons?.(binding, messageId).catch(() => {});
  }

  /** Trạng thái hiện tại trên itsaplan; không tra được thì dùng trạng thái đã lưu. */
  private async liveState(
    tracker: Pick<ScopedTracker, "columns">,
    columnId: number,
    issueId: number,
  ): Promise<TicketLifecycleState | null> {
    try {
      const column = (await tracker.columns()).find((c) => c.id === columnId);
      if (column) return classifyColumn(column);
    } catch (err) {
      getLogger().warn(
        `[closure] không tra được cột của #${issueId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return this.o.states.get(issueId)?.state ?? null;
  }
}
