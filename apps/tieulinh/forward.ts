/**
 * Chuyển lời người xử lý về người báo qua kênh (`ChannelPort`), đúng MỘT lần cho mỗi comment.
 *
 * Hai đường cùng dẫn tới đây và dùng chung khoá `forward:<issue>:<comment>`:
 *  - luật `comment.created` (webhook): mọi comment của người, theo chính sách `all|mention`;
 *  - handler `mention` (run): comment gọi @tieulinh2 cũng là một comment webhook, nên nếu không
 *    chung khoá thì người báo nhận hai tin.
 * Chính sách (nội bộ `#noibo…`, chặn bot echo, `all|mention`, khoá dự án) do `NotificationDispatcher`
 * của core giữ; ở đây chỉ thêm chống trùng và chế độ sandbox.
 */
import type { ItsaplanWebhookEnvelope } from "@vuihoc/bot-core/itsaplan";
import type { RuleAction } from "@vuihoc/bot-core/backoffice";
import type { TieulinhConfig } from "./env";
import type { TieulinhServices } from "./services";

type IssueLite = { id: number; identifier: string; title?: string };

/** Đẩy một phong bì `comment.created` qua dispatcher nếu comment này chưa được chuyển. */
export async function forwardOnce(
  svc: TieulinhServices,
  input: {
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
  if (!svc.claim(`forward:${issueId}:${input.commentKey}`)) return "duplicate";
  await svc.dispatcher.handleEvent(input.envelope);
  return "forwarded";
}

/** Hành động của luật `comment.created`: chuyển comment của người xử lý về người báo. */
export function relayComment(svc: TieulinhServices): RuleAction<TieulinhConfig> {
  return async (ctx) => {
    const { event } = ctx;
    if (event.issueId === null || !event.comment) return;
    await forwardOnce(svc, {
      issueId: event.issueId,
      commentKey: event.comment.id ?? `ts${event.envelope.webhookTimestamp ?? ""}`,
      envelope: event.envelope,
      issue: () => ctx.issue(),
    });
  };
}
