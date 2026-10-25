/**
 * Đăng ký webhook itsaplan theo `rules` của bot (opt-in). Khác `ensureItsaplanWebhook` (đã có ở
 * `@vuihoc/bot-core/itsaplan`, dùng cho worker cũ): hàm này
 *  - CHỈ đụng dự án của bot (ref đủ `<team>.<KEY>`, và kiểm `projectId` của mọi webhook liệt kê
 *    trùng `projectId` của dự án): không bao giờ liệt kê, tạo hay sửa webhook của dự án khác;
 *  - không xoá webhook nào, không "trỏ lại" webhook có URL khác (có thể là của bot/máy khác);
 *  - phân biệt rõ lỗi quyền (401/403) khỏi lỗi khác, để báo cho người vận hành điều cần làm.
 */
import { ItsaplanApiError, type ItsaplanClient, type WebhookSubscription } from "../itsaplan";

/** Ném khi key không đủ quyền quản lý webhook của dự án. */
export class WebhookPermissionError extends Error {
  constructor(
    readonly projectRef: string,
    readonly status: number,
  ) {
    super(
      `key itsaplan không có quyền quản lý webhook của dự án ${projectRef} (HTTP ${status}). ` +
        "Đặt ITSAPLAN_WEBHOOK_KEY bằng một key có quyền webhook (key agent thường không có), " +
        "hoặc tắt tự đăng ký (BOT_WEBHOOK_AUTO_REGISTER) và tạo webhook thủ công trên itsaplan.",
    );
    this.name = "WebhookPermissionError";
  }
}

export interface EnsureRuleWebhookResult {
  action: "created" | "updated" | "unchanged";
  webhookId: number;
  /** Sự kiện mà webhook có sau khi đảm bảo (gồm cả sự kiện có sẵn của webhook đó). */
  events: string[];
}

const isPermission = (err: unknown): err is ItsaplanApiError =>
  err instanceof ItsaplanApiError && (err.status === 401 || err.status === 403);

/**
 * Đảm bảo có một webhook ĐANG BẬT trỏ `url` trên dự án `projectRef`, đủ `events`.
 *  - Chưa có webhook nào cùng URL → tạo.
 *  - Có nhưng thiếu sự kiện hoặc đang tắt → bổ sung sự kiện (giữ sự kiện sẵn có) và bật lại tại chỗ.
 *  - Đã đủ → không làm gì.
 * Ném `WebhookPermissionError` nếu key bị từ chối; lỗi khác nổi lên nguyên vẹn.
 */
export async function ensureRuleWebhook(args: {
  client: ItsaplanClient;
  /** Ref đủ `<team>.<KEY>` của dự án bot phụ trách. */
  projectRef: string;
  /** `projectId` của dự án đó (từ `tracker.ready()`), để loại webhook không thuộc dự án. */
  projectId: number;
  /** URL mà itsaplan gọi tới được. */
  url: string;
  events: readonly string[];
}): Promise<EnsureRuleWebhookResult> {
  const { client, projectRef, projectId } = args;
  const wanted = [...new Set(args.events)].sort();
  if (wanted.length === 0) throw new Error("không có sự kiện nào để đăng ký webhook");
  const sameUrl = (h: WebhookSubscription) =>
    h.url.trim().toLowerCase() === args.url.trim().toLowerCase();
  try {
    const hooks = (await client.listWebhooks(projectRef)).filter(
      (h) => h.projectId === undefined || h.projectId === projectId,
    );
    const match = hooks.find(sameUrl);
    if (!match) {
      const created = await client.createWebhook(projectRef, {
        url: args.url,
        events: wanted,
        isActive: true,
      });
      if (created.projectId !== undefined && created.projectId !== projectId) {
        throw new Error(
          `itsaplan tạo webhook #${created.id} ở dự án ${created.projectId}, không phải ${projectRef}: dừng`,
        );
      }
      return { action: "created", webhookId: created.id, events: wanted };
    }
    const have = new Set(match.events ?? []);
    const missing = wanted.filter((e) => !have.has(e));
    if (missing.length === 0 && match.isActive) {
      return { action: "unchanged", webhookId: match.id, events: [...have].sort() };
    }
    const events = [...new Set([...have, ...wanted])].sort();
    await client.updateWebhook(match.id, { events, isActive: true });
    return { action: "updated", webhookId: match.id, events };
  } catch (err) {
    if (isPermission(err)) throw new WebhookPermissionError(projectRef, err.status);
    throw err;
  }
}
