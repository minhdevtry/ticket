/**
 * Cơ chế thông báo khi người báo bổ sung thông tin vào ticket (W29-NOTIFY, 06/10/2026).
 *
 * Tech lead (lead Kỹ thuật) phản ánh: "nhiều ticket đã đóng hoặc đang xử lý mà bên báo lỗi
 * có thêm phản hồi. Nếu chị ko chủ động vào xem thì ko biết. Em thêm tính năng noti giúp c với".
 * Team Kỹ thuật, team Kỹ thuật chốt:
 * - Ticket đã đóng (Done / Canceled) → không cho bổ sung vào nữa; từ chối lịch sự và hướng dẫn tạo ticket mới.
 * - Ticket đang xử lý (In Progress / Open / Resolved) → cho bổ sung và tạo thông báo vào Inbox của kỹ thuật viên.
 *
 * Bằng chứng từ mã nguồn Itsaplan API (apps/api/src/modules/issues/activity.ts & shared/mentions.ts):
 * - Khi bình luận chứa `@username` (khớp `user.username` trong `get_project.assignees`),
 *   Itsaplan tự động phân giải và tạo bản ghi thông báo loại `mentioned` vào Inbox
 *   của thành viên đó (`modules/notifications/service.ts:notifyComment`), đồng thời
 *   tự động đăng ký họ theo dõi issue (`autoWatchIssue`).
 * - Nếu không có @mention, bình luận của bot chỉ báo cho `watchers` (loại `commented`).
 *   Tuy nhiên, các ticket do bot tạo không có người tạo là người thật, và kỹ thuật viên
 *   được gán sau có thể chưa bình luận nên chưa trở thành watcher — dẫn đến Inbox trống.
 *
 * Do đó, giải pháp tin cậy nhất là:
 * 1. Nếu ticket có người xử lý (`assigneeUserId`), @mention username của assignee đó.
 * 2. Nếu ticket chưa gán ai, tra timeline tìm bình luận gần nhất của kỹ thuật viên
 *    (loại trừ bot và hệ thống) để @mention kỹ thuật viên đó.
 * 3. Nếu chưa có ai gán và chưa có kỹ thuật viên nào trao đổi: không mention.
 * 4. Nếu bật `NOTIFY_ON_CALL_SUPPLEMENT=1` và có cấu hình `ON_CALL_CHAT_ID`,
 *    gửi thêm tin ngắn tới kênh trực ca Telegram (mặc định tắt an toàn).
 */

import type { ItsaplanClient, ItsaplanIssue, ProjectAssignee, ProjectColumn } from "./client";
import { classifyColumn, type TicketState } from "./ticket-state";
import { isSystemActor } from "../kg/human-signals";
import { isBotComment, markBotComment, escapeItsaplanMarkdown } from "../formatting";
import { getLogger } from "../logger";

const NON_SPECIALIST_ACTOR_RE =
  /\b(?:ti[eể]u\s*linh|tieulinh|iris|bot-ticket-intake|bot-iris-intake|onyx|bot|ai-coder|ai-lead|ai-qa|coder\s*ai|lead\s*ai|qa\s*ai)\b|^admin$/i;

/**
 * Kiểm tra xem ticket đã ở trạng thái đóng (hoàn tất hoặc đã hủy) hay chưa.
 * Resolved ("Đã xử lý") vẫn tính là đang theo dõi / mở để người báo phản hồi nghiệm thu.
 */
export function isIssueClosed(
  issue: { columnId?: number; stateType?: string },
  columns?: ProjectColumn[],
): boolean {
  if (columns && typeof issue.columnId === "number") {
    const col = columns.find((c) => c.id === issue.columnId);
    if (col) {
      const state = classifyColumn(col);
      return state === "done" || state === "canceled";
    }
  }
  return issue.stateType === "completed" || issue.stateType === "canceled";
}

/**
 * Câu trả lời lịch sự khi từ chối bổ sung vào ticket đã đóng, hướng dẫn tạo ticket mới
 * (yêu cầu của team Kỹ thuật: "ticket đã đóng thì thôi k cho làm gì vào nữa,
 * bên báo lỗi phải tự chủ động tạo ticket mới").
 */
export function closedTicketRefusalMessage(identifier: string, stateLabel?: string): string {
  const stateVi = stateLabel ? ` ở trạng thái ${stateLabel}` : "";
  return `Dạ ticket ${identifier} hiện đã đóng${stateVi} trên hệ thống rồi nên không thể ghi bổ sung được nữa ạ. Nếu cần hỗ trợ sự cố mới, anh/chị vui lòng tạo ticket mới giúp em nhé ạ.`;
}

export interface SupplementMentionTarget {
  username: string;
  name?: string;
  source: "assignee" | "last_commenter";
}

export interface TimelineCommentEntry {
  kind?: string;
  body?: string | null;
  actorName?: string | null;
  actorUsername?: string | null;
  actorUserId?: string | null;
  actorKind?: string | null;
}

export interface ResolveMentionOptions {
  client: Pick<ItsaplanClient, "getProject"> & Partial<Pick<ItsaplanClient, "getIssueTimeline">>;
  projectKey: string;
  issue: Pick<ItsaplanIssue, "id" | "assigneeUserId">;
  timeline?: unknown[];
  reporterNames?: Array<string | undefined | null>;
}

/**
 * Xác định username kỹ thuật viên cần @mention khi có thông tin bổ sung:
 * 1. Ưu tiên assignee của ticket (`issue.assigneeUserId`).
 * 2. Nếu chưa gán assignee, tìm kỹ thuật viên bình luận gần nhất trên timeline.
 * 3. Không có ai -> trả về null.
 */
export async function resolveSupplementMentionTarget(
  options: ResolveMentionOptions,
): Promise<SupplementMentionTarget | null> {
  let assignees: ProjectAssignee[] = [];
  if (typeof options.client.getProject === "function") {
    try {
      const project = await options.client.getProject(options.projectKey);
      assignees = project?.assignees ?? [];
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      getLogger().warn(`[supplement-notifier] Không lấy được assignees của ${options.projectKey}: ${message}`);
    }
  }

  // 1. Ưu tiên assignee đang nhận ticket
  if (options.issue.assigneeUserId) {
    const assigned = assignees.find((a) => a.userId === options.issue.assigneeUserId);
    if (assigned && assigned.username) {
      const clean = assigned.username.trim().replace(/^@/, "");
      if (clean) return { username: clean, name: assigned.name, source: "assignee" };
    }
  }

  // 2. Không có assignee -> tìm kỹ thuật viên trao đổi gần nhất trên timeline
  let timeline = options.timeline;
  if (!timeline && typeof options.client.getIssueTimeline === "function") {
    try {
      timeline = await options.client.getIssueTimeline(options.issue.id);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      getLogger().warn(`[supplement-notifier] Không lấy được timeline #${options.issue.id}: ${message}`);
    }
  }

  if (Array.isArray(timeline) && timeline.length > 0) {
    const reporterSet = new Set(
      (options.reporterNames ?? [])
        .map((n) => String(n ?? "").trim().replace(/^@/, "").toLowerCase())
        .filter(Boolean),
    );

    // Duyệt từ mới nhất tới cũ nhất
    for (const raw of timeline.slice().reverse()) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as TimelineCommentEntry;
      if (item.kind !== "comment" || !item.body || typeof item.body !== "string" || !item.body.trim()) continue;
      if (isBotComment(item.body)) continue;
      if (item.actorKind === "agent") continue;

      const actorName = String(item.actorName ?? "").trim();
      const actorUsername = String(item.actorUsername ?? "").trim().replace(/^@/, "");
      const actorUserId = String(item.actorUserId ?? "").trim();
      if (!actorName || isSystemActor(actorName) || NON_SPECIALIST_ACTOR_RE.test(`${actorName} ${actorUsername}`)) {
        continue;
      }
      if (reporterSet.has(actorName.toLowerCase()) || (actorUsername && reporterSet.has(actorUsername.toLowerCase()))) {
        continue;
      }

      // Khớp với danh sách thành viên dự án
      const matched = assignees.find(
        (a) =>
          (actorUserId && a.userId === actorUserId) ||
          (actorUsername && a.username && a.username.toLowerCase() === actorUsername.toLowerCase()) ||
          (actorName && a.name && a.name.toLowerCase() === actorName.toLowerCase()) ||
          (actorName && a.username && a.username.toLowerCase() === actorName.toLowerCase()),
      );

      if (matched && matched.username) {
        const clean = matched.username.trim().replace(/^@/, "");
        if (clean) return { username: clean, name: matched.name, source: "last_commenter" };
      }

      // Fallback: nếu actorUsername hợp lệ nhưng không nằm trong assignees (vd khách mời)
      if (actorUsername && /^[a-zA-Z0-9_.-]+$/.test(actorUsername)) {
        return { username: actorUsername, name: actorName, source: "last_commenter" };
      }

      // Đã gặp bình luận gần nhất của kỹ thuật viên nhưng không rõ username -> dừng để không mention nhầm người cũ hơn
      break;
    }
  }

  return null;
}

export interface FormatSupplementCommentOptions {
  who?: string;
  parts: string[];
  mention?: string | null;
  style?: "user_update" | "who_supplement";
}

/**
 * Định dạng bình luận bổ sung kèm @mention kỹ thuật viên theo cú pháp Itsaplan:
 * `➕ **[Cập nhật bổ sung từ người dùng]** (cc @username):` hoặc `**${who}** bổ sung (cc @username):`
 */
export function formatSupplementComment(options: FormatSupplementCommentOptions): string {
  const mentionClean = options.mention?.trim().replace(/^@/, "");
  const mentionSuffix = mentionClean ? ` (cc @${mentionClean})` : "";
  const bodyText = options.parts.map((p) => escapeItsaplanMarkdown(p)).join("\n\n");

  if (options.style === "who_supplement") {
    const who = options.who?.trim() || "Người báo";
    return markBotComment(`**${who}** bổ sung${mentionSuffix}:\n${bodyText}`);
  }

  if (mentionClean) {
    return markBotComment(`➕ **[Cập nhật bổ sung từ người dùng]** (cc @${mentionClean}):\n${bodyText}`);
  }
  return markBotComment(`➕ **[Cập nhật bổ sung từ người dùng]:**\n${bodyText}`);
}

/**
 * Gửi thông báo ngắn tới kênh trực ca Telegram nếu được kích hoạt qua env `NOTIFY_ON_CALL_SUPPLEMENT=1`
 * (mặc định tắt an toàn).
 */
export async function notifyOnCallSupplement(options: {
  notifier?: { broadcastAlert?: (text: string) => Promise<void> };
  identifier: string;
  summary: string;
}): Promise<void> {
  const enabled = process.env.NOTIFY_ON_CALL_SUPPLEMENT === "1" || process.env.NOTIFY_ON_CALL_SUPPLEMENT === "true";
  if (!enabled || !options.notifier?.broadcastAlert) return;
  const shortText = options.summary.length > 300 ? `${options.summary.slice(0, 300)}…` : options.summary;
  const msg = `📢 **[Tiểu Linh]** Người báo vừa bổ sung thông tin vào ticket **${options.identifier}**:\n> ${shortText}`;
  await options.notifier.broadcastAlert(msg).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    getLogger().warn(`[supplement-notifier] broadcastAlert lỗi cho ${options.identifier}: ${message}`);
  });
}
