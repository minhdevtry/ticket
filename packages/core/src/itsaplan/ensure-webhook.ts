/**
 * Đảm bảo webhook Itsaplan của một dự án tồn tại, bật, và đủ sự kiện.
 *
 * MERGED (0.1.0): CM wins. CM's `REQUIRED_WEBHOOK_EVENTS` is a strict superset
 * (adds `issue.created`, needed for tickets staff create directly on Itsaplan)
 * and its disabled-webhook branch REACTIVATES in place (`updateWebhook isActive:
 * true`) rather than intake's delete-then-recreate, which is safer (keeps the
 * webhook id/secret stable). Both behaviours are generic; CM's is the superset.
 */
import type { ItsaplanClient } from "./client";
import { getLogger } from "../core/logger";

export const REQUIRED_WEBHOOK_EVENTS = [
  "comment.created",
  "comment.updated",
  "issue.state_changed",
  "issue.assigned",
  // Phiếu chuyên viên tự tạo trực tiếp trên Itsaplan — thiếu sự kiện này thì
  // webhook không bao giờ bắn. (CM)
  "issue.created",
];

export async function ensureItsaplanWebhook(
  client: ItsaplanClient,
  projectKey: string,
  webhookUrl: string,
): Promise<{ success: boolean; webhookId?: number; message: string }> {
  try {
    const hooks = await client.listWebhooks(projectKey).catch(() => []);
    const matching = hooks.find(
      (h) => h.url.trim().toLowerCase() === webhookUrl.trim().toLowerCase(),
    );

    const missing = matching
      ? REQUIRED_WEBHOOK_EVENTS.filter((e) => !(matching.events ?? []).includes(e))
      : [];

    if (matching && matching.isActive && missing.length) {
      await client.updateWebhook(matching.id, {
        events: [...new Set([...(matching.events ?? []), ...missing])],
      });
      const msg = `Webhook [${projectKey}] #${matching.id}: thêm sự kiện ${missing.join(", ")}`;
      getLogger().info(`[ensureWebhook] ${msg}`);
      return { success: true, webhookId: matching.id, message: msg };
    }

    if (matching && matching.isActive) {
      const msg = `Webhook trên [${projectKey}] đã hoạt động chuẩn: ${webhookUrl} (ID: ${matching.id})`;
      getLogger().info(`[ensureWebhook] ${msg}`);
      return { success: true, webhookId: matching.id, message: msg };
    }

    if (matching && !matching.isActive) {
      getLogger().warn(
        `[ensureWebhook] Webhook ID ${matching.id} đang bị tắt (isActive = false), kích hoạt lại...`,
      );
      await client.updateWebhook(matching.id, {
        isActive: true,
        events: [...new Set([...(matching.events ?? []), ...missing])],
      });
      const msg = `Webhook [${projectKey}] #${matching.id}: kích hoạt lại thành công`;
      getLogger().info(`[ensureWebhook] ${msg}`);
      return { success: true, webhookId: matching.id, message: msg };
    }

    // Idempotent khi KHÔNG prune: không có webhook URL khớp, nhưng có một webhook
    // cùng host chỉ lệch cổng/path (vd env sao chép từ bot khác trỏ :3102 trong
    // khi worker nghe :3104 — lỗi OP 16/10). Thay vì đẻ thêm một webhook mới mỗi
    // lần khởi động (rác tích tụ, nhiều cổng chết), CẬP NHẬT webhook cũ về URL
    // đúng và giữ nguyên id/secret. Chỉ nhận cùng host để không đụng webhook của
    // máy khác đang phục vụ cùng dự án.
    const canon = safeUrl(webhookUrl);
    const sameHostStale = canon
      ? hooks.find((h) => {
          const u = safeUrl(h.url);
          return (
            !!u &&
            u.hostname === canon.hostname &&
            h.url.trim().toLowerCase() !== webhookUrl.trim().toLowerCase()
          );
        })
      : undefined;
    if (sameHostStale) {
      await client.updateWebhook(sameHostStale.id, {
        url: webhookUrl,
        isActive: true,
        events: [...new Set([...(sameHostStale.events ?? []), ...REQUIRED_WEBHOOK_EVENTS])],
      });
      const msg = `Webhook [${projectKey}] #${sameHostStale.id}: trỏ lại URL đúng ${webhookUrl} (từ ${sameHostStale.url}), tái dùng id — không tạo mới`;
      getLogger().info(`[ensureWebhook] ${msg}`);
      return { success: true, webhookId: sameHostStale.id, message: msg };
    }

    const created = await client.createWebhook(projectKey, {
      url: webhookUrl,
      events: REQUIRED_WEBHOOK_EVENTS,
      isActive: true,
    });

    const msg = `Đã tự động tạo và kích hoạt Webhook trên [${projectKey}]: ${created.url} (ID: ${created.id})`;
    getLogger().info(`[ensureWebhook] ${msg}`);
    return { success: true, webhookId: created.id, message: msg };
  } catch (err: any) {
    const msg = `Không thể đảm bảo webhook trên [${projectKey}]: ${err.message}`;
    getLogger().warn(`[ensureWebhook] ${msg}`);
    return { success: false, message: msg };
  }
}

/**
 * Dựng URL webhook từ CHÍNH cổng mà worker sẽ nghe, để URL đăng ký và cổng nghe
 * không bao giờ lệch nhau.
 *
 * Lý do có hàm này: khi dựng worker OP (16/10), env sao chép từ Tiểu Linh có
 * `WEBHOOK_URL` trỏ cổng 3102 trong khi worker lại nghe `WEBHOOK_PORT=3104`, nên
 * Itsaplan đăng ký webhook về một cổng không ai nghe. Dùng một nguồn duy nhất
 * (port) để sinh URL thì không còn hai biến phải khớp tay.
 */
export function deriveWebhookUrl(opts: {
  /** Host Itsaplan gọi về được (IP LAN của máy chạy worker, vd "10.0.0.5"). */
  host: string;
  /** Cổng worker nghe — PHẢI là cổng truyền vào `server.start(port)`. */
  port: number;
  /** Mặc định "/webhook". */
  path?: string;
  /** Mặc định "http". */
  scheme?: "http" | "https";
}): string {
  const path = opts.path ?? "/webhook";
  const scheme = opts.scheme ?? "http";
  return `${scheme}://${opts.host}:${opts.port}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Xoá các webhook ĐANG BẬT của một dự án mà URL KHÁC `canonicalUrl` — tức trỏ về
 * một cổng/host không còn ai nghe. Giữ nguyên webhook của host khác (một dự án có
 * thể được nhiều máy phục vụ), chỉ dọn webhook cùng host mà lệch cổng.
 *
 * Trả về danh sách id đã xoá. Mỗi lần xoá là một lời gọi `deleteWebhook`; lỗi lẻ
 * được nuốt và ghi log để một webhook cứng đầu không chặn cả quá trình khởi động.
 */
export async function pruneForeignWebhooks(
  client: ItsaplanClient,
  projectKey: string,
  canonicalUrl: string,
  opts: { sameHostOnly?: boolean } = {},
): Promise<number[]> {
  const sameHostOnly = opts.sameHostOnly ?? true;
  const canon = safeUrl(canonicalUrl);
  const removed: number[] = [];
  try {
    const hooks = await client.listWebhooks(projectKey).catch(() => []);
    for (const h of hooks) {
      const u = safeUrl(h.url);
      if (!u) continue;
      const sameUrl = h.url.trim().toLowerCase() === canonicalUrl.trim().toLowerCase();
      if (sameUrl) continue; // giữ webhook chuẩn
      if (sameHostOnly && canon && u.hostname !== canon.hostname) continue; // host khác: để yên
      try {
        await client.deleteWebhook(h.id);
        removed.push(h.id);
        getLogger().info(
          `[pruneWebhooks] [${projectKey}] xoá webhook #${h.id} lệch cổng/host: ${h.url}`,
        );
      } catch (err: any) {
        getLogger().warn(
          `[pruneWebhooks] [${projectKey}] không xoá được #${h.id}: ${err?.message || err}`,
        );
      }
    }
  } catch (err: any) {
    getLogger().warn(`[pruneWebhooks] [${projectKey}] lỗi liệt kê webhook: ${err?.message || err}`);
  }
  return removed;
}

function safeUrl(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}
