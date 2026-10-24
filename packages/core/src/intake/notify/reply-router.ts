/**
 * ReplyRouter — a reporter's reply to a notification message becomes a COMMENT
 * on that ticket, and is NOT forwarded to the agent as a new incident.
 *
 * NGUỒN: intake `worker/ticket-closure.ts` (`recordReporterReply`,
 * `recordReporterOk`) + 25c68db. The problem it fixes: the OpenClaw-polling bot
 * has no `reply_to_message` on the update, so a free-text reply ("chưa ổn ạ…")
 * fell into the agent and was read as a brand-new incident (measured 28/09).
 * The reply is matched to a ticket by `message_routes` (fd48c6e, chat-scoped),
 * written as a comment, and acknowledged — never routed to the agent.
 *
 * ADR-0006: the reporter pressing "👍 Đã ổn" or replying only RECORDS a comment.
 * It never changes the ticket state and never reopens — only the handler moves
 * a column. The bot never closes a ticket.
 *
 * Channel-free and copy-free: the tracker write is a `TrackerPort`, the route
 * lookup a `MessageRouteStore`, and the reply/ack strings come from an injected
 * `ReplyCopy` (no Vietnamese literal in logic).
 */
import { markBotComment } from "../../core/formatting";
import { identifierInProject, normalizeProjectKey } from "../../itsaplan/project-lock";
import type { Clock, MessageRouteStore, TrackerPort } from "../ports";
import { systemClock } from "../ports";

/**
 * `handled: false` khi tin không phải reply vào một tin route đã biết — nơi gọi
 * để tin đi tiếp vào agent như thường, KHÔNG giả vờ đã xử lý. NGUỒN: intake
 * `ReporterReplyResult`.
 */
export type ReplyRouteResult = { handled: true; replyText: string } | { handled: false };

/**
 * The ack/comment strings, injected so no Vietnamese literal lives here.
 * `comment` is the body written to the tracker; `ack` is what the reporter is
 * told. Both receive the resolved vars.
 */
export interface ReplyCopy {
  /** Body of the comment recorded on the ticket. vars: {who, text, time}. */
  comment(vars: { who: string; text: string; time: string }): string;
  /** What the reporter is told after their reply is recorded. vars: {identifier}. */
  ack(vars: { identifier: string }): string;
}

export interface ReplyRouterOptions {
  routes: MessageRouteStore;
  tracker: Pick<TrackerPort, "addComment">;
  copy: ReplyCopy;
  /** Formats the "now" timestamp for the comment body. Injected = testable. */
  formatTime?: (ms: number) => string;
  clock?: Clock;
  /** Dự án của worker; reply vào ticket dự án khác thì bỏ (ADR-0001). */
  projectKey?: string;
  channelType?: string;
}

const rawChat = (chatId: string | number) => String(chatId).replace(/^telegram:/i, "").trim();

export class ReplyRouter {
  private readonly projectKey: string | null;
  private readonly channelType: string;
  private readonly formatTime: (ms: number) => string;
  private readonly clock: Clock;

  constructor(private readonly o: ReplyRouterOptions) {
    this.projectKey = normalizeProjectKey(o.projectKey);
    this.channelType = o.channelType ?? "telegram";
    this.formatTime = o.formatTime ?? ((ms) => new Date(ms).toISOString());
    this.clock = o.clock ?? systemClock;
  }

  private owns(identifier: string): boolean {
    return !this.projectKey || identifierInProject(identifier, this.projectKey);
  }

  /**
   * Người báo nhắn tự do vào đúng tin thông báo. Tra route theo `message_routes`
   * (thử cả hai dạng chat id vì cột có thể mang tiền tố `telegram:`). Chỉ ghi
   * comment — không đổi trạng thái (ADR-0006). NGUỒN: intake `recordReporterReply`.
   */
  async recordReporterReply(request: {
    chatId: string | number;
    messageId: string | number;
    text: string;
    userName?: string;
  }): Promise<ReplyRouteResult> {
    const bare = rawChat(request.chatId);
    const route =
      this.o.routes.getMessageRoute(String(request.messageId), this.channelType, bare) ??
      this.o.routes.getMessageRoute(String(request.messageId), this.channelType, `telegram:${bare}`);
    if (!route || !this.owns(route.identifier)) {
      return { handled: false };
    }
    const who = request.userName?.trim() || "Người báo";
    const now = this.clock.now();
    const text = request.text.trim();
    await this.o.tracker.addComment(
      route.issueId,
      markBotComment(this.o.copy.comment({ who, text, time: this.formatTime(now) })),
    );
    return { handled: true, replyText: this.o.copy.ack({ identifier: route.identifier }) };
  }
}
