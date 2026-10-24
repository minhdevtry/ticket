/**
 * Ticket closure — một module sở hữu vòng đời "đã xử lý → hoàn tất" (CONTEXT.md).
 *
 * Luật (ADR-0006, spec docs/superpowers/specs/2026-09-24-ticket-closure-design.md):
 * - Chỉ người xử lý chuyển ticket sang Done. Bot không bao giờ tự đóng, không
 *   có lịch tự đóng.
 * - Sang đã xử lý → báo người báo kèm nút "👍 Đã ổn". Bấm nút chỉ ghi comment;
 *   ticket vẫn ở Resolved chờ chuyên viên kiểm tra.
 * - Sang hoàn tất → báo người báo (không nút) và phát "ticket hoàn tất" đúng một
 *   lần cho các sink tri thức (KG, Onyx).
 *
 * Trạng thái cuối cùng đã thấy của mỗi ticket nằm trong bảng `ticket_states`.
 * Bảng đó là chốt chống trùng: một lần kéo cột bắn cả `issue.state_changed` lẫn
 * `issue.updated`, webhook có thể tới lại — trạng thái không đổi thì bỏ qua.
 */
import type { Database } from "bun:sqlite";
import type { ItsaplanClient } from "../lib/itsaplan/client";
import type { ProjectColumnStates, TicketState } from "../lib/itsaplan/ticket-state";
import { resolveFriendlyStatusName } from "../lib/itsaplan/status";
import { describeState } from "../lib/itsaplan/state-messages";
import type { TicketBinding, TicketBindingRepository } from "../lib/storage/binding-repository";
import { markBotComment, escapeItsaplanMarkdown } from "../lib/formatting";
import { closedTicketRefusalMessage, resolveSupplementMentionTarget } from "../lib/itsaplan/supplement-notifier";
import { getLogger } from "../lib/logger";
import type { Notifier } from "./notifier";
import { identifierInProject, isTieuLinhProject, normalizeProjectKey, projectOfIdentifier } from "./project-lock";

export type TicketDoneHandler = (issueId: number, identifier: string) => Promise<void>;

export interface TicketClosureOptions {
  db: Database;
  columns: Pick<ProjectColumnStates, "stateOf">;
  bindings: Pick<TicketBindingRepository, "getBindingByIssueId" | "saveMessageRoute" | "getMessageRoute">;
  notifiers: Map<string, Notifier>;
  itsaplan: Pick<ItsaplanClient, "addComment" | "getIssue"> & Partial<Pick<ItsaplanClient, "getProject" | "getIssueTimeline">>;
  projectKey?: string;
  onTicketDone?: TicketDoneHandler;
  now?: () => number;
}

/** `error`: ghi phản hồi hỏng (Itsaplan lỗi) — do nơi gọi đặt, không phải closure. */
export type ReporterOkOutcome =
  | "recorded"
  | "already_recorded"
  | "done"
  | "reopened"
  | "canceled"
  | "not_bound"
  | "unknown"
  | "error";

export interface ReporterOkResult {
  outcome: ReporterOkOutcome;
  /** Câu bot trả lời người vừa bấm. */
  replyText: string;
}

/**
 * `handled: false` khi tin không phải reply vào một tin route đã biết (route
 * chưa từng ghi, hay ticket không thuộc dự án worker này) — plugin để tin đi
 * tiếp vào agent như thường, không giả vờ đã xử lý.
 */
export type ReporterReplyResult = { handled: true; replyText: string } | { handled: false };

interface TicketStateRow {
  issue_id: number;
  identifier: string;
  project_key: string;
  state: TicketState;
  prompt_message_id: string | null;
  reporter_ok_at: number | null;
  updated_at: number;
  column_id?: number | null;
}

const rawChat = (chatId: string | number) => String(chatId).replace(/^telegram:/i, "").trim();

function vnTime(ms: number): string {
  const parts = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")} ${get("day")}/${get("month")}`;
}

export class TicketClosure {
  private readonly db: Database;
  private readonly projectKey: string | null;
  private readonly now: () => number;

  constructor(private readonly options: TicketClosureOptions) {
    this.db = options.db;
    this.projectKey = normalizeProjectKey(options.projectKey);
    this.now = options.now ?? Date.now;
  }

  private row(issueId: number): TicketStateRow | null {
    return (this.db.query(`SELECT * FROM ticket_states WHERE issue_id = ?`).get(issueId) as TicketStateRow) ?? null;
  }

  private owns(identifier: string): boolean {
    return !this.projectKey || identifierInProject(identifier, this.projectKey);
  }

  /**
   * Ticket vừa đổi cột. Trả trạng thái mới, hoặc `null` khi không phải việc của
   * worker này (dự án khác, cột không tra ra).
   */
  async onColumnChanged(event: {
    issueId: number;
    identifier: string;
    columnId: number;
    /**
     * `true` khi sự kiện thật sự là đổi cột (`issue.state_changed`). `false` cho
     * `issue.updated` (sửa mô tả, gán người…): lần đầu thấy ticket thì chỉ ghi
     * lại trạng thái, không báo ai — spec Q13, ticket có từ trước deploy.
     */
    columnChanged?: boolean;
  }): Promise<TicketState | null> {
    const { issueId, identifier, columnId } = event;
    const projectKey = projectOfIdentifier(identifier);
    if (!projectKey || !this.owns(identifier)) return null;

    const resolved = await this.options.columns.stateOf(projectKey, columnId);
    if (!resolved) {
      getLogger().warn(`[TicketClosure] ${identifier}: cột #${columnId} không có trong dự án ${projectKey}, bỏ qua.`);
      return null;
    }
    const { state, column } = resolved;
    const prev = this.row(issueId);
    // Dự án có lời báo riêng cho từng cột (PO): đổi giữa hai cột cùng nhóm "mở" (Discussion → PO inprogress → …)
    // cũng phải báo; các dự án khác chỉ báo khi đổi nhóm trạng thái như cũ.
    const described = describeState(projectKey, column.name);
    const sameColumn = event.columnChanged === false || (prev?.column_id !== null && prev?.column_id !== undefined && prev.column_id === columnId);
    if (prev?.state === state && (!described || sameColumn)) return state;

    const now = this.now();
    if (!prev && event.columnChanged === false) {
      this.db
        .query(`INSERT INTO ticket_states (issue_id, identifier, project_key, state, column_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(issueId, identifier, projectKey, state, columnId, now);
      return state;
    }

    this.db
      .query(`
        INSERT INTO ticket_states (issue_id, identifier, project_key, state, column_id, prompt_message_id, reporter_ok_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
        ON CONFLICT(issue_id) DO UPDATE SET
          identifier = excluded.identifier, project_key = excluded.project_key, state = excluded.state, column_id = excluded.column_id,
          prompt_message_id = NULL, reporter_ok_at = NULL, updated_at = excluded.updated_at
      `)
      .run(issueId, identifier, projectKey, state, columnId, now);

    const binding = this.options.bindings.getBindingByIssueId(issueId);
    const notifier = binding ? this.options.notifiers.get(binding.channelType) : undefined;

    // Rời đã xử lý (sang hoàn tất hay bị kéo lại) → nút "Đã ổn" cũ hết nghĩa.
    if (prev?.state === "resolved" && prev.prompt_message_id && binding && notifier?.clearInteractiveButtons) {
      await notifier.clearInteractiveButtons(binding, prev.prompt_message_id).catch(() => {});
    }

    if (binding && notifier) {
      // Dự án có lời giải thích riêng cho từng cột (PO — PO 01/10) thì báo đúng lời đó.
      await this.notify(binding, notifier, issueId, described ?? resolveFriendlyStatusName(column.name, column.stateType), state, described !== null);
    }

    if (state === "done" && this.options.onTicketDone) {
      this.options.onTicketDone(issueId, identifier).catch((err) => {
        getLogger().warn(`[TicketClosure] Xử lý ticket hoàn tất ${identifier} lỗi:`, err);
      });
    }
    return state;
  }

  private async notify(
    binding: TicketBinding,
    notifier: Notifier,
    issueId: number,
    label: string,
    state: TicketState,
    exact = false,
  ): Promise<void> {
    try {
      const sent = await notifier.notifyStateChange(binding, label, state, exact);
      if (sent === undefined || sent === null) return;
      this.options.bindings.saveMessageRoute(String(sent), binding.channelType, issueId, binding.identifier, binding.chatId, "state");
      if (state === "resolved") {
        this.db.query(`UPDATE ticket_states SET prompt_message_id = ? WHERE issue_id = ?`).run(String(sent), issueId);
      }
    } catch (err: any) {
      getLogger().error(`[TicketClosure] Báo trạng thái ${binding.identifier} cho người báo lỗi: ${err.message}`);
    }
  }

  /**
   * Người báo bấm "👍 Đã ổn". Chỉ ghi comment — không đổi trạng thái ticket.
   * Trạng thái xét theo Itsaplan ngay lúc bấm (nút có thể đã cũ).
   */
  async recordReporterOk(request: { issueId: number; chatId: string | number; userName?: string }): Promise<ReporterOkResult> {
    const { issueId } = request;
    const binding = this.options.bindings.getBindingByIssueId(issueId);
    if (!binding || !this.owns(binding.identifier)) {
      return { outcome: "unknown", replyText: "Dạ em không tìm thấy ticket này ạ." };
    }
    if (rawChat(binding.chatId) !== rawChat(request.chatId)) {
      getLogger().warn(`[TicketClosure] Bấm "Đã ổn" cho ${binding.identifier} từ chat lạ ${request.chatId}, bỏ qua.`);
      return { outcome: "not_bound", replyText: "Dạ nút này không thuộc cuộc trò chuyện của ticket ạ." };
    }

    const state = await this.liveState(issueId, binding.identifier);
    const id = binding.identifier;
    if (state === "done") return { outcome: "done", replyText: `Dạ ticket ${id} đã hoàn tất rồi ạ.` };
    if (state === "canceled") return { outcome: "canceled", replyText: `Dạ ticket ${id} đã được huỷ ạ.` };
    if (state !== "resolved") {
      return { outcome: "reopened", replyText: `Dạ ticket ${id} đang được xử lý lại, em sẽ báo anh/chị khi xong ạ.` };
    }

    const ack = "Dạ em đã ghi nhận, chuyên viên sẽ kiểm tra lại và đóng ticket ạ.";
    const row = this.row(issueId);
    if (row?.reporter_ok_at) return { outcome: "already_recorded", replyText: ack };

    const now = this.now();
    const who = request.userName?.trim() || "Người báo";
    await this.options.itsaplan.addComment(issueId, markBotComment(`**${who}** phản hồi: đã ổn (${vnTime(now)}).`));
    this.db
      .query(`
        INSERT INTO ticket_states (issue_id, identifier, project_key, state, reporter_ok_at, updated_at)
        VALUES (?, ?, ?, 'resolved', ?, ?)
        ON CONFLICT(issue_id) DO UPDATE SET
          state = 'resolved', reporter_ok_at = excluded.reporter_ok_at, updated_at = excluded.updated_at
      `)
      .run(issueId, id, projectOfIdentifier(id) ?? "", now, now);

    const notifier = this.options.notifiers.get(binding.channelType);
    if (row?.prompt_message_id && notifier?.clearInteractiveButtons) {
      await notifier.clearInteractiveButtons(binding, row.prompt_message_id).catch(() => {});
    }
    return { outcome: "recorded", replyText: ack };
  }

  /**
   * Người báo nhắn tự do (không bấm nút) vào đúng tin thông báo trạng thái —
   * ví dụ "chưa ổn ạ, vẫn lỗi y như cũ" (spec C4). Bot chạy qua OpenClaw
   * polling không có `update.message.reply_to_message` như webhook mode
   * (telegram-handler.ts), nên tin rơi vào agent dưới dạng text thường và bị
   * hiểu nhầm thành sự cố mới (đo 28/09/2026). Plugin xac-nhan-xong bắt
   * `reply_to_id` trong phong bì OpenClaw rồi gọi thẳng đây.
   *
   * Chỉ ghi comment — không đổi trạng thái, không mở lại ticket (ADR-0006: chỉ
   * người xử lý chuyển cột; "người báo không bấm nghĩa là chưa có ý kiến,
   * thấy chưa ổn thì họ tự nhắn" — bản thân việc nhắn không phải một quyết định).
   *
   * `chatId`/`messageId` tra theo `message_routes`, nhưng cột `chat_id` ở đó
   * có thể mang tiền tố `telegram:` hoặc không tuỳ nơi ghi (xem `rawChat`),
   * nên thử cả hai dạng thay vì đòi khớp y hệt.
   */
  async recordReporterReply(request: {
    chatId: string | number;
    messageId: string | number;
    text: string;
    userName?: string;
  }): Promise<ReporterReplyResult> {
    const bare = rawChat(request.chatId);
    const route =
      this.options.bindings.getMessageRoute(request.messageId, "telegram", bare) ??
      this.options.bindings.getMessageRoute(request.messageId, "telegram", `telegram:${bare}`);
    if (!route || !this.owns(route.identifier)) {
      return { handled: false };
    }

    const isTieuLinh = isTieuLinhProject(route.identifier, this.projectKey);

    // W29-NOTIFY (06/10/2026): Kiểm tra ticket đã đóng chưa (chỉ cho Tiểu Linh/TECH; Iris/PO giữ nguyên)
    if (isTieuLinh) {
      const state = await this.liveState(route.issueId, route.identifier);
      if (state === "done" || state === "canceled") {
        return {
          handled: true,
          replyText: closedTicketRefusalMessage(route.identifier),
        };
      }
    }

    const who = request.userName?.trim() || "Người báo";
    const now = this.now();
    let mentionSuffix = "";
    if (isTieuLinh && typeof this.options.itsaplan.getProject === "function") {
      try {
        const issue = await this.options.itsaplan.getIssue(route.issueId);
        const mention = await resolveSupplementMentionTarget({
          client: this.options.itsaplan as Pick<ItsaplanClient, "getProject" | "getIssueTimeline">,
          projectKey: projectOfIdentifier(route.identifier) ?? "TECH",
          issue,
          reporterNames: [who],
        });
        const cleanUser = mention?.username?.trim().replace(/^@+/, "");
        if (cleanUser) {
          mentionSuffix = ` (cc @${cleanUser})`;
        }
      } catch {}
    }
    await this.options.itsaplan.addComment(
      route.issueId,
      markBotComment(`**${who}** phản hồi${mentionSuffix}: ${escapeItsaplanMarkdown(request.text)} (${vnTime(now)}).`),
    );
    return {
      handled: true,
      replyText: `Dạ em đã chuyển phản hồi của anh/chị vào ${route.identifier} cho đội Kỹ thuật ạ.`,
    };
  }

  /** Trạng thái hiện tại trên Itsaplan; hỏi hỏng thì dùng trạng thái đã lưu. */
  private async liveState(issueId: number, identifier: string): Promise<TicketState | null> {
    const projectKey = projectOfIdentifier(identifier);
    try {
      const issue = await this.options.itsaplan.getIssue(issueId);
      if (projectKey && typeof issue?.columnId === "number") {
        const s = await this.options.columns.stateOf(projectKey, issue.columnId);
        if (s) return s.state;
      }
    } catch (err: any) {
      getLogger().warn(`[TicketClosure] Không tra được trạng thái ${identifier}: ${err.message}`);
    }
    return this.row(issueId)?.state ?? null;
  }
}
