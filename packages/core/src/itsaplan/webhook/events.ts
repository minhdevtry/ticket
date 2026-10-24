/**
 * `@vuihoc/bot-core/itsaplan/webhook` — typed Itsaplan webhook envelope, HMAC
 * signature verification, and the dedupe key.
 *
 * NGUỒN: intake `worker/webhook-server.ts` (a6275e7 — body cap, signature,
 * dedupe-by-event+issue). Ported verbatim in behaviour: the signature scheme is
 * `t=<sec>,v1=<hex>` over `${t}.${rawBody}` with HMAC-SHA256, matching
 * Itsaplan's own `apps/worker/src/signature.ts`. The dedupe key is
 * `event|issue|comment|webhookTimestamp` so two different events in the same
 * millisecond are not collapsed.
 *
 * Moved out of a `worker/` path into the itsaplan layer because it is pure
 * tracker-protocol logic with no channel coupling (same reasoning as
 * project-lock.ts). The HTTP server and the dedupe policy are separate files.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface ItsaplanWebhookActor {
  type?: "human" | "agent" | "system" | string;
  id?: string | number | null;
  name?: string | null;
}

export type ItsaplanWebhookEventName =
  | "issue.created"
  | "issue.updated"
  | "issue.deleted"
  | "issue.assigned"
  | "issue.state_changed"
  | "issue.column_changed"
  | "issue.label_changed"
  | "issue.link_changed"
  | "comment.created"
  | "comment.updated";

export interface ItsaplanWebhookEnvelope {
  action: "create" | "update" | "remove";
  type: "Issue" | "Comment";
  event: ItsaplanWebhookEventName;
  data: any;
  actor?: ItsaplanWebhookActor | null;
  createdAt: string;
  webhookTimestamp?: number;
}

/** Giới hạn body mỗi request. Webhook thật chỉ vài KB; 1 MB là trần an toàn. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
/** Độ lệch tối đa của `t=` trong chữ ký so với đồng hồ máy. */
export const DEFAULT_SIGNATURE_TOLERANCE_SEC = 5 * 60;

/**
 * Kiểm chữ ký Itsaplan: HMAC-SHA256 trên `${t}.${rawBody}` (đúng byte nhận
 * được), header dạng `t=<giây>,v1=<hex>`. Nhiều secret vì webhook không lọc dự
 * án — sự kiện có thể đến từ subscription khác cùng trỏ về URL này.
 *
 * NGUỒN: intake `worker/webhook-server.ts::verifyItsaplanSignature` (a6275e7).
 */
export function verifyItsaplanSignature(
  header: string | undefined,
  rawBody: string,
  secrets: string[],
  nowSec: number = Math.floor(Date.now() / 1000),
  toleranceSec: number = DEFAULT_SIGNATURE_TOLERANCE_SEC,
): boolean {
  if (!header) return false;
  const parts = new Map(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()] as [string, string];
    }),
  );
  const ts = Number(parts.get("t"));
  const sig = parts.get("v1") ?? "";
  if (!Number.isFinite(ts) || !/^[0-9a-f]+$/i.test(sig)) return false;
  if (Math.abs(nowSec - ts) > toleranceSec) return false;
  const given = Buffer.from(sig, "hex");
  const clean = secrets.map((s) => s.trim()).filter(Boolean);
  return clean.some((secret) => {
    const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest();
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}

/** Constant-time string compare for the Telegram `secret_token` header. */
export function safeEqualToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Khoá chống trùng: loại sự kiện + issue (+ comment) + webhookTimestamp. Chỉ
 * theo timestamp thì hai sự kiện khác nhau cùng mili-giây bị coi là trùng.
 * Trả `null` khi payload không có `webhookTimestamp` (không khoá được).
 *
 * NGUỒN: intake `worker/webhook-server.ts::webhookDedupeKey` (a6275e7).
 */
export function webhookDedupeKey(envelope: ItsaplanWebhookEnvelope): string | null {
  if (!envelope?.webhookTimestamp) return null;
  const data = envelope.data ?? {};
  const isComment = envelope.event === "comment.created" || envelope.event === "comment.updated";
  const issueId = isComment ? data.issueId : (data.id ?? data.issueId);
  const commentId = isComment ? (data.id ?? "") : "";
  return `${envelope.event}|${issueId ?? ""}|${commentId}|${envelope.webhookTimestamp}`;
}

export type WebhookParseResult =
  | { ok: true; envelope: ItsaplanWebhookEnvelope }
  | { ok: false; error: string };

/** Parse a raw body into a typed envelope. Shape is trusted-ish; JSON only. */
export function parseWebhookEnvelope(rawBody: string): WebhookParseResult {
  let envelope: ItsaplanWebhookEnvelope;
  try {
    envelope = JSON.parse(rawBody) as ItsaplanWebhookEnvelope;
  } catch (err: any) {
    return { ok: false, error: `Invalid JSON: ${err?.message ?? String(err)}` };
  }
  if (!envelope || typeof envelope !== "object" || typeof envelope.event !== "string") {
    return { ok: false, error: "Not a webhook envelope" };
  }
  return { ok: true, envelope };
}
