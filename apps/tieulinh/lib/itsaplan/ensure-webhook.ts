import { ensureItsaplanWebhook, type ItsaplanClient } from "@vuihoc/bot-core/itsaplan";

/**
 * Sự kiện worker Tiểu Linh cần. `comment.updated` là sự kiện Itsaplan bắn khi GHIM
 * hoặc sửa comment — lúc tech lead ghim Nguyên nhân / Cách khắc phục thì worker
 * chốt ticket tương tự (worker/related-curator.ts, ADR-0007).
 *
 * Cố ý KHÔNG có `issue.created` (bộ mặc định của thư viện có): giữ đúng các sự
 * kiện webhook hiện đang đăng ký trên Itsaplan, không tự bật thêm luồng mới.
 */
export const TIEULINH_WEBHOOK_EVENTS = [
  "comment.created",
  "comment.updated",
  "issue.state_changed",
  "issue.assigned",
] as const;

/** `ensureItsaplanWebhook` của thư viện với bộ sự kiện của Tiểu Linh. */
export function ensureTieuLinhWebhook(
  client: ItsaplanClient,
  projectKey: string,
  webhookUrl: string,
) {
  return ensureItsaplanWebhook(client, projectKey, webhookUrl, { events: TIEULINH_WEBHOOK_EVENTS });
}
