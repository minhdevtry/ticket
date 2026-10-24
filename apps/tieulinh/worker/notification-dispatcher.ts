import type { TicketBinding, TicketBindingRepository } from "../lib/storage/binding-repository";
import type { Notifier } from "./notifier";
import { getLogger } from "../lib/logger";
import type { ItsaplanWebhookEnvelope } from "./webhook-server";

import type { TicketClosure } from "./ticket-closure";
import type { TicketLifecycleService } from "./lifecycle";

import type { ItsaplanClient } from "../lib/itsaplan/client";
import { syncRelatedTickets } from "./related-tickets-sync";
import {
  isBotComment,
  stripBotMentions,
  stripCommentHtml,
  isCommentRecentlyForwarded,
  decodeHtmlEntities,
} from "../lib/formatting";
import { identifierInProject, normalizeProjectKey, projectOfIdentifier } from "./project-lock";
import type { DuplicateMerger } from "./duplicate-merger";

/**
 * Comment nào được đẩy về người báo.
 *
 * - `mention` — chỉ comment có tag `@<handle>`. Hành vi cũ, giữ để quay đầu nhanh.
 * - `all` — đẩy mọi comment của người, trừ comment do chính bot ghi và comment
 *   gắn cờ nội bộ.
 *
 * Đổi mặc định sang `all` ngày 17/09/2026: soi log từ 12/09 tới 17/09, 15/15
 * comment trên PO đều bị chặn ở cổng `@iris` — chưa một tin nào tới tay người
 * đóng góp. Cổng đó đòi team Product nhớ gõ đúng handle, và họ không gõ.
 */
export type CommentForwardPolicy = "mention" | "all";

/** Cờ để lại một comment trên tracker, không đẩy về người báo. */
export const INTERNAL_COMMENT_MARKERS = ["#noibo", "#nộibộ", "#internal", "[nội bộ]", "[noi bo]"];

export interface NotificationDispatcherOptions {
  /**
   * Handles that make a tracker comment visible to the reporter. A comment
   * without one of these mentions is internal chatter and stays on the tracker.
   * Each bot supplies its own; they used to be hardcoded to Tiểu Linh's.
   *
   * Ở chế độ `all`, handle chỉ còn dùng để gỡ phần tag ra khỏi câu gửi đi.
   */
  agentHandles: string[];
  /** Mặc định `all`. Xem `CommentForwardPolicy`. */
  commentForwardPolicy?: CommentForwardPolicy;
  /**
   * Mã dự án worker này phụ trách ("TECH", "PO"). Khai thì worker bỏ qua sự kiện
   * của dự án khác.
   *
   * Đo được 17/09/2026: webhook của TECH nhận cả sự kiện PO (PO-15/39/40/78), và
   * worker TECH đã nạp PO-78 vào Onyx thành `ticket_tech-640`. Hai worker dùng
   * chung một file binding nên nếu không chặn ở đây, người gửi yêu cầu sản phẩm
   * sẽ nhận thông báo bằng bot Tiểu Linh kèm giọng "đội Kỹ thuật".
   */
  projectKey?: string;
  /** Vòng đời đã xử lý → hoàn tất (worker/ticket-closure.ts). */
  closure?: Pick<TicketClosure, "onColumnChanged">;
  /** Chỉ còn dùng để đăng ký theo dõi SLA khi ticket được tạo. */
  lifecycle?: Pick<TicketLifecycleService, "recordSlaTarget">;
  itsaplanBaseUrl?: string;
  itsaplanWebUrl?: string;
  itsaplanClient?: ItsaplanClient;
  /**
   * Có comment mới / comment được sửa hoặc GHIM (Itsaplan bắn `comment.updated`
   * khi ghim), hoặc ticket đổi cột → chốt ticket tương tự nếu người đã ghim
   * nguyên nhân (worker/related-curator.ts). Gọi thừa không sao: curator tự
   * kiểm tra và đợi gộp sự kiện.
   */
  onTicketKnowledgeMaybeChanged?: (issueId: number) => void;
  /**
   * Kỹ thuật tuyên bố một ticket trùng ticket khác bằng bình luận (ADR-0008
   * quyết định 7 ý 2, xem worker/duplicate-merger.ts). Không khai thì bỏ qua
   * (mặc định tắt khi thiếu cấu hình LLM — xem worker/index.ts).
   */
  duplicateMerger?: Pick<DuplicateMerger, "handleComment">;
}

export class NotificationDispatcher {
  private readonly bindingRepo: TicketBindingRepository;
  private readonly botAdapters: Map<string, Notifier>;
  private readonly agentHandles: string[];
  private readonly commentForwardPolicy: CommentForwardPolicy;
  private readonly projectKey: string | null;
  private readonly closure?: Pick<TicketClosure, "onColumnChanged">;
  private readonly lifecycle?: Pick<TicketLifecycleService, "recordSlaTarget">;
  private itsaplanBaseUrl: string;
  private itsaplanWebUrl: string;
  private itsaplanClient?: ItsaplanClient;
  private readonly onTicketKnowledgeMaybeChanged?: (issueId: number) => void;
  private readonly duplicateMerger?: Pick<DuplicateMerger, "handleComment">;

  constructor(
    bindingRepo: TicketBindingRepository,
    options: NotificationDispatcherOptions,
    botAdapters: Map<string, Notifier> = new Map(),
  ) {
    this.bindingRepo = bindingRepo;
    this.botAdapters = botAdapters;
    this.agentHandles = options.agentHandles;
    this.commentForwardPolicy = options.commentForwardPolicy ?? "all";
    this.projectKey = normalizeProjectKey(options.projectKey);
    this.closure = options.closure;
    this.lifecycle = options.lifecycle;
    this.itsaplanBaseUrl = (options.itsaplanBaseUrl || "").replace(/\/+$/, "");
    this.itsaplanWebUrl = (options.itsaplanWebUrl || options.itsaplanBaseUrl || "").replace(
      /\/+$/,
      "",
    );
    this.itsaplanClient = options.itsaplanClient;
    this.onTicketKnowledgeMaybeChanged = options.onTicketKnowledgeMaybeChanged;
    this.duplicateMerger = options.duplicateMerger;
  }

  registerBot(botAdapter: Notifier) {
    this.botAdapters.set(botAdapter.channelType, botAdapter);
  }

  /** Comment người viết muốn giữ lại trên tracker, không đẩy về người báo. */
  isInternalComment(commentBody: string): boolean {
    const lowered = commentBody.toLowerCase();
    return INTERNAL_COMMENT_MARKERS.some((marker) => lowered.includes(marker.toLowerCase()));
  }

  extractReporterMessage(
    commentBody: string,
    reporterUsername?: string,
  ): { isCallToReporter: boolean; cleanText: string } {
    const bodyWithoutHtml = stripCommentHtml(commentBody);
    let cleanText = stripBotMentions(bodyWithoutHtml, this.agentHandles);
    const mentioned = cleanText !== bodyWithoutHtml.trim();

    // Ở chế độ `all`, mọi comment của người đều tới tay người báo; phần tag chỉ
    // là thứ cần gỡ khỏi câu chữ, không còn là điều kiện.
    if (!mentioned && this.commentForwardPolicy === "mention") {
      // Do NOT forward internal technician mentions (@TE_... or peer usernames) to Telegram
      return { isCallToReporter: false, cleanText: commentBody };
    }

    // Loại bỏ thẻ <video>/<mark>/<span> thô và markdown ảnh khỏi cleanText gửi về Telegram
    cleanText = decodeHtmlEntities(
      stripCommentHtml(cleanText).replace(/!\[.*?\]\(.*?\)/g, ""),
    ).trim();
    return { isCallToReporter: true, cleanText };
  }

  /**
   * Sự kiện này thuộc dự án worker đang phụ trách? Không khai `projectKey` thì
   * nhận tất. Không đọc được dự án (payload thiếu identifier) thì KHÔNG nhận —
   * trước đây tiền tố rỗng lọt qua, nên sự kiện dự án khác cũng được xử lý.
   */
  private ownsProject(identifier?: string | null): boolean {
    return identifierInProject(identifier, this.projectKey);
  }

  /**
   * Identifier của issue trong sự kiện: payload → binding → hỏi Itsaplan.
   * Trả `null` khi không biết — nơi gọi phải bỏ qua, không đoán.
   */
  private async resolveIdentifier(
    issueId: number,
    payloadIdentifier?: unknown,
  ): Promise<string | null> {
    if (typeof payloadIdentifier === "string" && projectOfIdentifier(payloadIdentifier))
      return payloadIdentifier;
    const fromBinding = this.bindingRepo.getBindingByIssueId(issueId)?.identifier;
    if (fromBinding && projectOfIdentifier(fromBinding)) return fromBinding;
    if (!this.itsaplanClient) return null;
    const issue = await this.itsaplanClient.getIssue(issueId).catch(() => null);
    return issue?.identifier && projectOfIdentifier(issue.identifier) ? issue.identifier : null;
  }

  extractCommentImages(commentBody: string, attachments?: any[]): string[] {
    const urls: string[] = [];

    // 1. Extract markdown image links: ![alt](url)
    const mdRegex = /!\[.*?\]\((.*?)\)/g;
    for (const match of commentBody.matchAll(mdRegex)) {
      if (match[1]) urls.push(match[1].trim());
    }

    // 2. Extract from attachments array if present
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        if (typeof att === "string") {
          urls.push(att.trim());
        } else if (att && typeof att.url === "string") {
          urls.push(att.url.trim());
        }
      }
    }

    return this.normalizeUrls(urls);
  }

  // Markdown has no video syntax — Itsaplan embeds a video comment as a raw
  // <video src="…" controls></video> tag (xem attachmentMarkdown ở web).
  extractCommentVideos(commentBody: string): string[] {
    const urls: string[] = [];
    const videoRegex = /<video\b[^>]*\bsrc="([^"]*)"[^>]*>/gi;
    for (const match of commentBody.matchAll(videoRegex)) {
      if (match[1]) urls.push(match[1].trim());
    }
    return this.normalizeUrls(urls);
  }

  private normalizeUrls(urls: string[]): string[] {
    const targetBase = (this.itsaplanWebUrl || this.itsaplanBaseUrl).replace(/\/+$/, "");
    return [...new Set(urls)].map((u) => {
      // Nếu là URL localhost/127.0.0.1, chuyển sang URL web public
      if (u.startsWith("http://127.0.0.1") || u.startsWith("http://localhost")) {
        const pathPart = u.replace(/^https?:\/\/[^/]+/, "");
        return `${targetBase}${pathPart.startsWith("/") ? pathPart : `/${pathPart}`}`;
      }
      if (u.startsWith("http://") || u.startsWith("https://")) return u;
      const cleanPath = u.startsWith("/") ? u : `/${u}`;
      return `${targetBase}${cleanPath}`;
    });
  }

  async handleWebhook(envelope: ItsaplanWebhookEnvelope): Promise<void> {
    const event = envelope.event;
    const data = envelope.data;
    if (!data) return;

    if (event === "issue.created") {
      const issueId = Number(data.id || data.issueId);
      if (issueId && this.lifecycle) {
        const identifier = await this.resolveIdentifier(issueId, data.identifier);
        const projectKey = projectOfIdentifier(identifier);
        if (!identifier || !projectKey) {
          getLogger().info(
            `[NotificationDispatcher] issue.created #${issueId} không rõ dự án, bỏ qua theo dõi SLA.`,
          );
          return;
        }
        if (!this.ownsProject(identifier)) return;
        const priority = String(data.priority || "medium");
        this.lifecycle.recordSlaTarget({
          issueId,
          identifier,
          priority,
          projectKey,
          createdAt: data.createdAt ? new Date(data.createdAt).getTime() : Date.now(),
        });
      }
      return;
    }

    if (event === "comment.created" || event === "comment.updated") {
      const commentIssueId = Number(data.issueId);
      if (commentIssueId && !isBotComment(typeof data.body === "string" ? data.body : "")) {
        this.onTicketKnowledgeMaybeChanged?.(commentIssueId);
      }
      // Sửa / ghim comment không báo lại người báo.
      if (event === "comment.updated") return;
    }

    if (event === "comment.created") {
      const issueId = Number(data.issueId);
      if (!issueId) return;

      const bodyText = typeof data.body === "string" ? data.body : "";

      // Comment do chính bot ghi: `update_issue`, lifecycle, ingest. Không chặn
      // ở đây thì người dùng nhận lại đúng câu mình vừa nhắn.
      if (isBotComment(bodyText)) return;

      // Ignore echoes from Telegram itself
      if (bodyText.includes("(Telegram")) {
        return;
      }

      const binding = this.bindingRepo.getBindingByIssueId(issueId);
      if (!binding) return;
      if (!this.ownsProject(binding.identifier)) return;

      const commentActorName =
        (typeof envelope.actor?.name === "string" ? envelope.actor.name.trim() : "") ||
        (typeof data.author?.name === "string" ? data.author.name.trim() : "") ||
        (typeof data.actorName === "string" ? data.actorName.trim() : "") ||
        undefined;

      // Kỹ thuật tuyên bố ticket trùng (ADR-0008 quyết định 7 ý 2) — kiểm tra
      // trước bộ lọc nội bộ/forward bên dưới: tuyên bố trùng có thể nằm trong
      // bình luận không tag người báo, vẫn phải gộp. Chạy độc lập (không chặn
      // luồng báo người báo phía dưới); lỗi tự log bên trong, không ném ra đây.
      if (this.duplicateMerger) {
        this.duplicateMerger
          .handleComment({
            issueId,
            identifier: binding.identifier,
            commentBody: bodyText,
            actorName: commentActorName,
          })
          .catch((err: unknown) =>
            getLogger().error(
              `[NotificationDispatcher] DuplicateMerger lỗi trên ${binding.identifier}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      }
      if (this.isInternalComment(bodyText)) {
        getLogger().info(
          `[NotificationDispatcher] Comment on ${binding.identifier} gắn cờ nội bộ, giữ lại trên tracker.`,
        );
        return;
      }

      const { isCallToReporter, cleanText } = this.extractReporterMessage(
        bodyText,
        binding.reporterUsername,
      );

      if (!isCallToReporter) {
        getLogger().info(
          `[NotificationDispatcher] Comment on ${binding.identifier} is internal (no mention), skipping notification.`,
        );
        return;
      }

      // Comment chỉ có ảnh/video, phần chữ rỗng sau khi bóc — vẫn đẩy, nhưng
      // đừng gửi một tin nhắn trắng.
      if (
        !cleanText &&
        !this.extractCommentImages(bodyText, data.attachments).length &&
        !this.extractCommentVideos(bodyText).length
      ) {
        return;
      }

      // Kiểm tra trùng lặp nếu runner vừa mới chuyển tiếp bình luận này
      if (isCommentRecentlyForwarded(issueId, cleanText)) {
        getLogger().info(
          `[NotificationDispatcher] Comment on ${binding.identifier} đã được chuyển tiếp trước đó, bỏ qua để tránh trùng lặp.`,
        );
        return;
      }

      const botAdapter = this.botAdapters.get(binding.channelType);
      if (!botAdapter) {
        getLogger().warn(
          `[NotificationDispatcher] No bot adapter found for channel: ${binding.channelType}`,
        );
        return;
      }

      const images = this.extractCommentImages(bodyText, data.attachments);
      const videos = this.extractCommentVideos(bodyText);
      const authorName =
        decodeHtmlEntities(commentActorName) ||
        (binding.identifier.startsWith("PO-") || this.projectKey === "PO"
          ? "Product team"
          : "Kỹ thuật viên Itsaplan");
      try {
        const sentMessageId =
          images.length > 0 || videos.length > 0
            ? await botAdapter.notifyComment(binding, authorName, cleanText, images, videos)
            : await botAdapter.notifyComment(binding, authorName, cleanText);
        if (sentMessageId !== undefined && sentMessageId !== null) {
          this.bindingRepo.saveMessageRoute(
            String(sentMessageId),
            binding.channelType,
            issueId,
            binding.identifier,
            binding.chatId,
            "comment",
          );
        }
      } catch (err: any) {
        getLogger().error(
          `[NotificationDispatcher] Error dispatching comment notification: ${err.message}`,
        );
      }
    } else if (
      event === "issue.state_changed" ||
      event === "issue.column_changed" ||
      event === "issue.updated"
    ) {
      const issueId = Number(data.id || data.issueId);
      if (!issueId) return;

      // Khoá dự án TRƯỚC mọi việc có tác dụng phụ. Trước đây syncRelatedTickets
      // chạy trước khoá → worker này addLink lên issue của dự án khác.
      const identifier = await this.resolveIdentifier(issueId, data.identifier);
      if (!identifier || !this.ownsProject(identifier)) {
        if (!identifier) {
          getLogger().info(`[NotificationDispatcher] ${event} #${issueId} không rõ dự án, bỏ qua.`);
        }
        return;
      }

      this.onTicketKnowledgeMaybeChanged?.(issueId);

      // Khi có cập nhật issue (đặc biệt là trường Related Tickets), đồng bộ liên kết sang Links native
      if (this.itsaplanClient) {
        syncRelatedTickets(this.itsaplanClient, issueId).catch((err) => {
          getLogger().warn(
            `[NotificationDispatcher] syncRelatedTickets failed for #${issueId}:`,
            err,
          );
        });
      }

      // Webhook thật chỉ mang columnId (không có tên cột / stateType) — phân
      // loại, báo người báo, phát hoàn tất đều do TicketClosure lo.
      const columnId = Number(data.columnId);
      if (!this.closure || !Number.isFinite(columnId) || columnId <= 0) return;
      await this.closure.onColumnChanged({
        issueId,
        identifier,
        columnId,
        columnChanged: event === "issue.state_changed" || event === "issue.column_changed",
      });
    }
  }
}
