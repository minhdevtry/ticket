/**
 * NotificationDispatcher — maps Itsaplan webhook events to chat messages sent
 * through an injected `ChannelPort`, to the chat bound to the ticket.
 *
 * Channel-free and copy-free: it imports no Telegram and holds no Vietnamese
 * literal in logic — state-change text comes from an injected
 * `StateChangeCopyMap`, the send surface is a `ChannelPort`, and bindings are
 * read through `NotifyBindingReader`.
 *
 * NGUỒN (intake `worker/notification-dispatcher.ts` + `worker/ticket-closure.ts`):
 *  - 837fb08: project-lock BEFORE any side effect; an event whose project
 *    cannot be read is NOT accepted (empty prefix must not pass); always record.
 *  - 4cea3c9: comment-forward policy — default `all` (every human comment), with
 *    an optional `mention` mode that forwards only comments tagging the bot.
 *  - isBotComment (core): never forward a comment the bot itself wrote (echo).
 *  - comment.updated (edit/pin) does NOT re-notify the reporter.
 *  - ADR-0006 (closure, e65b058): resolved → notify + "press OK" button (the OK
 *    records a comment, never a state change); done → notify (no button); only
 *    the handler moves a ticket to done — the bot never closes.
 *  - fd48c6e: record a message route keyed by (messageId, channel, chatId) so a
 *    reply to the notification can become a comment on that ticket.
 */
import { getLogger } from "../../core/logger";
import { isBotComment, stripBotMentions, stripCommentHtml } from "../../core/formatting";
import {
  identifierInProject,
  normalizeProjectKey,
  projectOfIdentifier,
} from "../../itsaplan/project-lock";
import type { ItsaplanWebhookEnvelope } from "../../itsaplan/webhook/events";
import type {
  ChannelPort,
  MessageRouteStore,
  NotifyBinding,
  NotifyBindingReader,
  StateChangeCopyMap,
  TicketLifecycleState,
  TrackerPort,
} from "../ports";

/**
 * Comment nào được đẩy về người báo.
 *  - `all` — mọi comment của người, trừ comment do chính bot ghi (mặc định).
 *    Đổi sang `all` 17/09/2026 vì cổng `@iris` chặn hết comment Product team.
 *  - `mention` — chỉ comment có tag `@<handle>` của bot. Hành vi cũ.
 * NGUỒN: intake 4cea3c9 + `CommentForwardPolicy`.
 */
export type CommentForwardPolicy = "mention" | "all";

/** Cờ để lại một comment trên tracker, không đẩy về người báo. NGUỒN: intake. */
export const INTERNAL_COMMENT_MARKERS = ["#noibo", "#nộibộ", "#internal", "[nội bộ]", "[noi bo]"];

/**
 * Resolve a column id to a lifecycle state. The webhook carries only a numeric
 * `columnId`; a bot injects the project→column→state map (kept out of the
 * library — it is Tiểu Linh/CM domain). Returns the state and column name, or
 * null when the column is unknown.
 * NGUỒN: intake `lib/itsaplan/ticket-state.ts` `stateOf`, as an injected port.
 */
export interface ColumnStateResolverPort {
  stateOf(input: {
    project: string;
    columnId: number;
  }): Promise<{ state: TicketLifecycleState; columnName: string } | null>;
}

export interface NotificationDispatcherOptions {
  bindings: NotifyBindingReader;
  routes: MessageRouteStore;
  /** The one send surface. Telegram (ticket 12) is one implementation. */
  channel: ChannelPort;
  /** Per-project copy for state changes — no Vietnamese literal in logic. */
  copy: StateChangeCopyMap;
  /** Resolves a webhook `columnId` to a lifecycle state + column name. */
  columns?: ColumnStateResolverPort;
  /** Reads the ticket back when the payload lacks a usable identifier. */
  tracker?: Pick<TrackerPort, "getIssue">;
  /**
   * Mã dự án worker này phụ trách ("TECH", "PO"). Khai thì bỏ qua sự kiện của
   * dự án khác (webhook không lọc dự án; nhiều worker dùng chung binding).
   */
  projectKey?: string;
  /** Handles that mark a comment visible to the reporter (for `mention` mode / tag-strip). */
  agentHandles?: string[];
  /** Mặc định `all`. */
  commentForwardPolicy?: CommentForwardPolicy;
}

export class NotificationDispatcher {
  private readonly o: NotificationDispatcherOptions;
  private readonly projectKey: string | null;
  private readonly agentHandles: string[];
  private readonly policy: CommentForwardPolicy;

  constructor(options: NotificationDispatcherOptions) {
    this.o = options;
    this.projectKey = normalizeProjectKey(options.projectKey);
    this.agentHandles = options.agentHandles ?? [];
    this.policy = options.commentForwardPolicy ?? "all";
  }

  /** Entry point: one webhook envelope. */
  async handleEvent(envelope: ItsaplanWebhookEnvelope): Promise<void> {
    const event = envelope.event;
    const data = envelope.data ?? {};

    if (event === "comment.updated") return; // sửa/ghim comment không báo lại
    if (event === "comment.created") {
      await this.handleComment(envelope, data);
      return;
    }
    if (
      event === "issue.state_changed" ||
      event === "issue.column_changed" ||
      event === "issue.updated"
    ) {
      await this.handleStateChange(envelope, data, event);
      return;
    }
  }

  /** Comment của người xử lý → đẩy về người báo (bỏ comment bot, lọc dự án). */
  private async handleComment(envelope: ItsaplanWebhookEnvelope, data: any): Promise<void> {
    const issueId = Number(data.issueId);
    if (!issueId) return;
    const bodyText = typeof data.body === "string" ? data.body : "";

    // Comment do chính bot ghi: không chặn ở đây thì người dùng nhận lại đúng
    // câu mình vừa nhắn (echo loop). NGUỒN: isBotComment (core).
    if (isBotComment(bodyText)) return;
    if (bodyText.includes("(Telegram")) return; // echo từ chính Telegram

    const binding = this.o.bindings.getBindingByIssueId(issueId);
    if (!binding) {
      // Thiếu binding = worker không biết issue này gắn chat nào, nên nuốt comment.
      // Nguyên nhân thực tế hay gặp (OP 16/10): worker trỏ NHẦM file SQLite (DB
      // path tương đối + CWD khác) nên đọc một DB rỗng không có binding. Trước đây
      // chỗ này `return` lặng lẽ, không để lại dấu vết — webhook trả 200 mà chat
      // im, rất khó lần. Log rõ để lần sau soi được ngay.
      getLogger().warn(
        `[NotificationDispatcher] comment.created issue=${issueId}: KHÔNG có binding ` +
          `(worker có đang trỏ đúng DB chứa ticket_bindings không?) — bỏ qua.`,
      );
      return;
    }
    if (!this.ownsProject(binding.identifier)) return; // 837fb08: project-lock

    const authorName =
      (typeof envelope.actor?.name === "string" ? envelope.actor.name.trim() : "") ||
      (typeof data.author?.name === "string" ? data.author.name.trim() : "") ||
      (typeof data.actorName === "string" ? data.actorName.trim() : "") ||
      "";

    if (this.isInternalComment(bodyText)) {
      getLogger().info(
        `[NotificationDispatcher] Comment ${binding.identifier} gắn cờ nội bộ, giữ trên tracker.`,
      );
      return;
    }

    const { isCallToReporter, cleanText } = this.extractReporterMessage(bodyText);
    if (!isCallToReporter) return; // `mention` mode and no tag → internal chatter
    const images = this.extractCommentImages(bodyText);
    if (!cleanText && images.length === 0) return; // tránh gửi tin trắng

    try {
      const sent = await this.o.channel.sendComment({
        binding,
        authorName: authorName || this.defaultAuthorName(binding),
        text: cleanText,
        images,
      });
      if (sent !== undefined && sent !== null) {
        this.o.routes.saveMessageRoute({
          messageId: String(sent),
          channelType: binding.channelType,
          chatId: binding.chatId,
          issueId,
          identifier: binding.identifier,
          kind: "comment", // fd48c6e
        });
      }
    } catch (err: any) {
      getLogger().error(
        `[NotificationDispatcher] Gửi comment ${binding.identifier} lỗi: ${err.message}`,
      );
    }
  }

  /** Đổi cột/trạng thái → báo người báo (ADR-0006 closure). */
  private async handleStateChange(
    envelope: ItsaplanWebhookEnvelope,
    data: any,
    event: string,
  ): Promise<void> {
    const issueId = Number(data.id || data.issueId);
    if (!issueId) return;

    // 837fb08: khoá dự án TRƯỚC mọi tác dụng phụ.
    const identifier = await this.resolveIdentifier(issueId, data.identifier);
    if (!identifier || !this.ownsProject(identifier)) {
      if (!identifier)
        getLogger().info(`[NotificationDispatcher] ${event} #${issueId} không rõ dự án, bỏ qua.`);
      return;
    }

    const columnId = Number(data.columnId);
    if (!this.o.columns || !Number.isFinite(columnId) || columnId <= 0) return;
    const project = projectOfIdentifier(identifier);
    if (!project) return;

    const resolved = await this.o.columns.stateOf({ project, columnId }).catch(() => null);
    if (!resolved) {
      getLogger().warn(
        `[NotificationDispatcher] ${identifier}: cột #${columnId} không tra ra, bỏ qua.`,
      );
      return;
    }
    const { state, columnName } = resolved;

    const binding = this.o.bindings.getBindingByIssueId(issueId);
    if (!binding) {
      getLogger().warn(
        `[NotificationDispatcher] issue.state_changed issue=${issueId}: KHÔNG có binding ` +
          `(worker có đang trỏ đúng DB chứa ticket_bindings không?) — bỏ qua.`,
      );
      return;
    }

    const message = this.o.copy.describe({ project, columnName, state, identifier });
    if (!message) return;

    try {
      const sent = await this.o.channel.sendStateChange({
        binding,
        message,
        state,
        // ADR-0006: resolved → nút "Đã ổn" (chỉ ghi comment, không đổi trạng thái).
        withReporterOkButton: state === "resolved",
      });
      if (sent !== undefined && sent !== null) {
        this.o.routes.saveMessageRoute({
          messageId: String(sent),
          channelType: binding.channelType,
          chatId: binding.chatId,
          issueId,
          identifier: binding.identifier,
          kind: "state", // fd48c6e
        });
      }
    } catch (err: any) {
      getLogger().error(
        `[NotificationDispatcher] Báo trạng thái ${binding.identifier} lỗi: ${err.message}`,
      );
    }
  }

  /** Sự kiện này thuộc dự án worker đang phụ trách? NGUỒN: 837fb08. */
  private ownsProject(identifier?: string | null): boolean {
    return identifierInProject(identifier, this.projectKey);
  }

  /** Comment người viết muốn giữ lại trên tracker. NGUỒN: intake. */
  isInternalComment(commentBody: string): boolean {
    const lowered = commentBody.toLowerCase();
    return INTERNAL_COMMENT_MARKERS.some((m) => lowered.includes(m.toLowerCase()));
  }

  /**
   * Bóc câu gửi về người báo + quyết định có đẩy không.
   * NGUỒN: intake `extractReporterMessage` (4cea3c9 tag-only mode).
   */
  extractReporterMessage(commentBody: string): { isCallToReporter: boolean; cleanText: string } {
    const bodyWithoutHtml = stripCommentHtml(commentBody);
    let cleanText = stripBotMentions(bodyWithoutHtml, this.agentHandles);
    const mentioned = cleanText !== bodyWithoutHtml.trim();
    // `all`: mọi comment người đều tới tay người báo, tag chỉ là thứ cần gỡ.
    if (!mentioned && this.policy === "mention") {
      return { isCallToReporter: false, cleanText: commentBody };
    }
    cleanText = stripCommentHtml(cleanText)
      .replace(/!\[.*?\]\(.*?\)/g, "")
      .trim();
    return { isCallToReporter: true, cleanText };
  }

  /** Ảnh markdown trong comment. NGUỒN: intake `extractCommentImages`. */
  extractCommentImages(commentBody: string): string[] {
    const urls: string[] = [];
    const re = /!\[.*?\]\((.*?)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(commentBody)) !== null) if (m[1]) urls.push(m[1].trim());
    return urls;
  }

  /**
   * Identifier của issue: payload → binding → hỏi tracker. `null` khi không
   * biết (nơi gọi bỏ qua, không đoán). NGUỒN: intake `resolveIdentifier`.
   */
  private async resolveIdentifier(
    issueId: number,
    payloadIdentifier?: unknown,
  ): Promise<string | null> {
    if (typeof payloadIdentifier === "string" && projectOfIdentifier(payloadIdentifier))
      return payloadIdentifier;
    const fromBinding = this.o.bindings.getBindingByIssueId(issueId)?.identifier;
    if (fromBinding && projectOfIdentifier(fromBinding)) return fromBinding;
    if (!this.o.tracker) return null;
    const issue = await this.o.tracker.getIssue(issueId).catch(() => null);
    return issue?.identifier && projectOfIdentifier(issue.identifier) ? issue.identifier : null;
  }

  private defaultAuthorName(binding: NotifyBinding): string {
    return binding.identifier.startsWith("PO-") || this.projectKey === "PO"
      ? "Product team"
      : "Kỹ thuật viên Itsaplan";
  }
}
