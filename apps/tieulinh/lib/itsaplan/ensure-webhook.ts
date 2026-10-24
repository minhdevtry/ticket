import type { ItsaplanClient } from "./client";
import { getLogger } from "@vuihoc/bot-core/core";

/**
 * Sự kiện worker cần. `comment.updated` là sự kiện Itsaplan bắn khi GHIM hoặc
 * sửa comment — lúc tech lead ghim Nguyên nhân / Cách khắc phục thì worker chốt
 * ticket tương tự (worker/related-curator.ts, ADR-0007).
 */
export const REQUIRED_WEBHOOK_EVENTS = [
  "comment.created",
  "comment.updated",
  "issue.state_changed",
  "issue.assigned",
];

/**
 * Đảm bảo Webhook lắng nghe sự kiện trên Itsaplan luôn tồn tại, bật, và đủ sự kiện.
 */
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
        `[ensureWebhook] Webhook ID ${matching.id} đang bị tắt (isActive = false), xóa và tạo mới...`,
      );
      await client.deleteWebhook(matching.id).catch(() => {});
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
