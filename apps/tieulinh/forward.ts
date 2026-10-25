/**
 * Chuyển lời người xử lý về người báo qua kênh (`ChannelPort`), đúng MỘT lần cho mỗi comment.
 *
 * Mỗi comment được chuyển đúng một lần nhờ khoá `forward:<issue>:<comment id>` trong `ctx.keys`
 * (bền qua restart). Comment gọi @agent là một comment webhook nhưng ĐƯỜNG DUY NHẤT chuyển nó là
 * handler `mention` (khoá theo run, nên giao lại run không gửi lần hai): luật `comment.created`
 * bỏ qua comment có @agent (`mentionsAgent`), nếu không người báo nhận hai tin.
 *  - luật `comment.created` (webhook): mọi comment của người KHÔNG gọi agent, theo chính sách `all|mention`;
 *  - handler `mention` (run): comment gọi agent.
 * Chính sách (nội bộ `#noibo…`, chặn bot echo, `all|mention`, khoá dự án) do `NotificationDispatcher`
 * của core giữ; ở đây chỉ thêm chống trùng và chế độ sandbox.
 */
import type { ItsaplanWebhookEnvelope } from "@vuihoc/bot-core/itsaplan";
import type { KeysProvider, RuleAction } from "@vuihoc/bot-core/backoffice";
import type { TieulinhConfig } from "./env";
import { FORWARD_KEYS, KEYS_TTL_MS, type TieulinhServices } from "./services";

type IssueLite = { id: number; identifier: string; title?: string };

/** Đẩy một phong bì `comment.created` qua dispatcher nếu comment này chưa được chuyển. */
export async function forwardOnce(
  svc: TieulinhServices,
  input: {
    keys: KeysProvider;
    issueId: number;
    commentKey: string | number;
    envelope: ItsaplanWebhookEnvelope;
    issue: () => Promise<IssueLite | null>;
  },
): Promise<"forwarded" | "duplicate" | "no_binding"> {
  const { issueId } = input;
  if (!svc.bindings.getBindingByIssueId(issueId)) {
    const issue = svc.config.TIEULINH_SANDBOX_CHAT ? await input.issue() : null;
    if (!issue || !svc.ensureBinding(issue)) return "no_binding";
  }
  const done = input.keys(FORWARD_KEYS, { ttlMs: KEYS_TTL_MS });
  const key = `forward:${issueId}:${input.commentKey}`;
  if (done.has(key)) return "duplicate";
  await svc.dispatcher.handleEvent(input.envelope);
  // Đánh dấu SAU khi gửi: kênh lỗi thì ném, lần giao lại sẽ thử lại thay vì nuốt mất tin.
  done.add(key);
  return "forwarded";
}

/** Comment có gọi @agent không (đi đường `mention`, luật comment phải bỏ qua). */
export function mentionsAgent(text: string, agent: string): boolean {
  const re = new RegExp(
    `(^|[^\\w@])@${agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`,
    "i",
  );
  return re.test(text);
}

/** Hành động của luật `comment.created`: chuyển comment của người xử lý về người báo. */
export function relayComment(svc: TieulinhServices): RuleAction<TieulinhConfig> {
  return async (ctx) => {
    const { event } = ctx;
    if (event.issueId === null || !event.comment) return;
    if (mentionsAgent(event.comment.raw, svc.config.TIEULINH_AGENT)) return;
    await forwardOnce(svc, {
      keys: ctx.keys,
      issueId: event.issueId,
      commentKey: event.comment.id ?? `ts${event.envelope.webhookTimestamp ?? ""}`,
      envelope: event.envelope,
      issue: () => ctx.issue(),
    });
  };
}
