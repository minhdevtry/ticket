/**
 * Đăng ký webhook itsaplan theo `rules` của bot (opt-in). Khác `ensureItsaplanWebhook` (đã có ở
 * `@vuihoc/bot-core/itsaplan`, dùng cho worker cũ): hàm này
 *  - CHỈ đụng dự án của bot (ref đủ `<team>.<KEY>`, và kiểm `projectId` của mọi webhook liệt kê
 *    trùng `projectId` của dự án): không bao giờ liệt kê, tạo hay sửa webhook của dự án khác;
 *  - không xoá webhook nào (trừ bản VỪA TẠO khi hai process đăng ký đồng thời), không "trỏ lại"
 *    webhook có URL khác (có thể là của bot/máy khác), không bật lại webhook mà người khác đã tắt;
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
  /**
   * `created`/`updated`/`unchanged`: webhook đang bật và đủ sự kiện. `disabled`: đã có webhook
   * cùng URL nhưng ai đó TẮT nó; bot KHÔNG tự bật lại (có thể là chủ ý), chỉ báo cáo.
   */
  action: "created" | "updated" | "unchanged" | "disabled";
  webhookId: number;
  /** Sự kiện mà webhook có sau khi đảm bảo (gồm cả sự kiện có sẵn của webhook đó). */
  events: string[];
  /** Với `disabled`: sự kiện bot cần mà webhook đang thiếu (bot không bổ sung vào webhook đang tắt). */
  missingEvents?: string[];
  /**
   * `secret` của webhook có khớp `secret` đã truyền vào không (so sánh, không bao giờ trả giá trị).
   * `null` nếu không truyền `secret` hoặc server không trả secret.
   */
  secretMatches: boolean | null;
  /** Bot đã gửi `secret` khi tạo (server chấp nhận). `false` khi không truyền hoặc server từ chối trường này. */
  secretSent: boolean;
}

const isPermission = (err: unknown): err is ItsaplanApiError =>
  err instanceof ItsaplanApiError && (err.status === 401 || err.status === 403);

const isRejectedPayload = (err: unknown): boolean =>
  err instanceof ItsaplanApiError && (err.status === 400 || err.status === 422);

/**
 * Đảm bảo có một webhook ĐANG BẬT trỏ `url` trên dự án `projectRef`, đủ `events`.
 *  - Chưa có webhook nào cùng URL → tạo (gửi kèm `secret` nếu truyền; server từ chối trường này
 *    thì tạo lại không có nó). Sau khi tạo, liệt kê lại: nếu cùng lúc process khác cũng tạo (hai
 *    bot khởi động đồng thời), giữ webhook có id nhỏ nhất và xoá bản VỪA TẠO của mình nếu nó không
 *    phải bản nhỏ nhất. Đây là webhook duy nhất bot được phép xoá.
 *  - Có nhưng thiếu sự kiện → bổ sung sự kiện (giữ sự kiện sẵn có).
 *  - Có nhưng đang TẮT → không đụng vào, trả `disabled` để caller báo cho người vận hành.
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
  /** Secret mong muốn (`ITSAPLAN_WEBHOOK_SECRET`): gửi khi tạo nếu API nhận, và so với webhook có sẵn. */
  secret?: string;
}): Promise<EnsureRuleWebhookResult> {
  const { client, projectRef, projectId } = args;
  const wanted = [...new Set(args.events)].sort();
  if (wanted.length === 0) throw new Error("không có sự kiện nào để đăng ký webhook");
  const sameUrl = (h: WebhookSubscription) =>
    h.url.trim().toLowerCase() === args.url.trim().toLowerCase();
  const list = async () =>
    (await client.listWebhooks(projectRef))
      .filter((h) => h.projectId === undefined || h.projectId === projectId)
      .filter(sameUrl)
      .sort((a, b) => a.id - b.id);
  const secretOf = (h: WebhookSubscription): boolean | null =>
    args.secret && typeof h.secret === "string" && h.secret !== ""
      ? h.secret === args.secret
      : null;

  const reconcile = async (
    match: WebhookSubscription,
    secretSent: boolean,
    justCreated: boolean,
  ): Promise<EnsureRuleWebhookResult> => {
    const have = new Set(match.events ?? []);
    const missing = wanted.filter((e) => !have.has(e));
    const secretMatches = secretOf(match);
    if (!match.isActive) {
      return {
        action: "disabled",
        webhookId: match.id,
        events: [...have].sort(),
        missingEvents: missing,
        secretMatches,
        secretSent,
      };
    }
    if (missing.length === 0) {
      return {
        action: justCreated ? "created" : "unchanged",
        webhookId: match.id,
        events: [...have].sort(),
        secretMatches,
        secretSent,
      };
    }
    const events = [...new Set([...have, ...wanted])].sort();
    await client.updateWebhook(match.id, { events });
    return { action: "updated", webhookId: match.id, events, secretMatches, secretSent };
  };

  try {
    const existing = await list();
    if (existing.length > 0) return await reconcile(existing[0], false, false);

    let secretSent = args.secret !== undefined && args.secret !== "";
    const payload = { url: args.url, events: wanted, isActive: true };
    let created: WebhookSubscription;
    try {
      created = await client.createWebhook(projectRef, {
        ...payload,
        ...(secretSent ? { secret: args.secret } : {}),
      });
    } catch (err) {
      if (!secretSent || !isRejectedPayload(err)) throw err;
      secretSent = false; // API không nhận `secret` do client đặt: để server tự cấp
      created = await client.createWebhook(projectRef, payload);
    }
    if (created.projectId !== undefined && created.projectId !== projectId) {
      throw new Error(
        `itsaplan tạo webhook #${created.id} ở dự án ${created.projectId}, không phải ${projectRef}: dừng`,
      );
    }
    // Hai process khởi động đồng thời có thể cùng thấy "chưa có": liệt kê lại và giữ bản id nhỏ nhất.
    const after = await list();
    const oldest = after[0];
    if (oldest && oldest.id < created.id) {
      try {
        await client.deleteWebhook(created.id);
      } catch {
        // xoá không được thì còn một bản thừa, vô hại: sự kiện tới trùng sẽ bị dedupe
      }
      return reconcile(oldest, false, false);
    }
    return reconcile(created, secretSent, true);
  } catch (err) {
    if (isPermission(err)) throw new WebhookPermissionError(projectRef, err.status);
    throw err;
  }
}
