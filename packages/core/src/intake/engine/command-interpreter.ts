/**
 * Bộ đọc lệnh nhắm vào ticket đã có bằng LLM (ADR-0008).
 *
 * Nhận diện ý định: append, cancel_or_close, edit, lookup, move_created, new, unclear.
 * Có đường lùi tất định khi không có LLM hoặc LLM lỗi/timeout.
 */
import { parseJsonLoose } from "../../llm/extract";
import type { LlmConfig, CompleteFn } from "../extractor/llm-extractor";
import type { TicketCommand, TicketCommandInput, TicketCommandInterpreterPort } from "../ports";
import {
  classifyCancelOrCloseIntent,
  mentionedIdentifiers,
  stripSupplementCommandWrapper,
} from "./text";
import { withTimeout } from "./timeout";
const SYSTEM_PROMPT = `Bạn đọc MỘT tin nhắn Telegram người báo lỗi gửi cho bot tiếp nhận sự cố và cho biết người báo muốn gì với các ticket ĐÃ CÓ dưới đây. Bot sẽ luôn hỏi người báo xác nhận trước khi ghi, nhưng bạn phải hiểu đúng ý.
Hành động:
- "append": thêm thông tin / trả lời kỹ thuật cho một ticket đã có ("bổ sung TECH-795 …", "TECH-795 cập nhật thông tin thêm …", trả lời đúng điều kỹ thuật vừa hỏi như "đơn hàng gia hạn ạ", "DH900002"). "content" = phần nội dung cần ghi, NGUYÊN VĂN người báo (bỏ phần lệnh như "bổ sung TECH-795").
- "cancel_or_close": người báo yêu cầu HỦY / ĐÓNG / BỎ ticket đã có vì không cần xử lý nữa hoặc báo sự cố đã tự hết / học sinh đã vào dùng được ("Hủy TECH-951", "hủy TECH-951 vì học sinh đã vào được rồi", "Đóng ticket TECH-999", "hủy ticket TECH-1126", "xin đóng TECH-795"). "content" = nguyên văn lời người báo. TUYỆT ĐỐI KHÔNG chọn "edit" khi người báo muốn hủy hoặc đóng ticket.
- "edit": đề nghị SỬA ticket ("sửa TECH-795 SĐT thành …", "TECH-795 ghi sai mã đơn, đúng là …", "đổi tiêu đề TECH-795 …"). "instruction" = điều cần sửa, nguyên văn.
- "lookup": hỏi tình trạng ("TECH-795 tới đâu rồi", "check TECH-795", chỉ gõ mã).
- "move_created": ticket bot VỪA TẠO (đánh dấu "vừa tạo") thật ra là bổ sung cho một ticket khác ("cái này bổ sung cho TECH-795 chứ", "nhầm rồi, cái vừa rồi là của TECH-795"). "from" = ticket vừa tạo, "ticket" = ticket đích.
- "new": báo sự cố MỚI, trả lời câu hỏi của tờ khai đang soạn (bộ phận, hệ thống, xác nhận…), hoặc nhắc ticket cũ chỉ để so sánh ("lỗi giống TECH-722"). Tin tả một lỗi khác chủ đề ticket (vd ticket về hạn học, tin báo CRM không gọi được) cũng là "new".
- "unclear": tin ngắn/mơ hồ, có thể là trả lời kỹ thuật mà cũng có thể là việc khác. Đừng đoán bừa.
Trả về ĐÚNG một object JSON: {"action": "...", "ticket": "<mã>" | null, "from": "<mã>" | null, "content": "...", "instruction": "...", "reason": "..."}`;

function userPrompt(input: TicketCommandInput): string {
  const cands = input.candidates
    .map((c) =>
      [
        `- ${c.identifier}${c.title ? `: ${c.title}` : ""}`,
        c.ownTicket ? "  (ticket của chính người báo)" : "  (ticket của người khác)",
        c.mentioned ? "  (người báo nhắc mã này trong tin)" : "",
        c.justCreated ? "  (bot VỪA TẠO ticket này trong chat)" : "",
        c.techQuestion ? `  Kỹ thuật vừa hỏi người báo: "${c.techQuestion.slice(0, 600)}"` : "",
        c.recentlyRelayed && !c.techQuestion
          ? "  (bot vừa chuyển tin của kỹ thuật về ticket này cho người báo)"
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
  return [
    `Ticket đã có liên quan:\n${cands}`,
    input.draftTitle
      ? `Tờ khai sự cố đang soạn dở: "${input.draftTitle}"`
      : "Không có tờ khai đang soạn.",
    `Tin nhắn mới${input.attachments ? ` (kèm ${input.attachments} ảnh/tệp)` : ""}:\n"${input.message.slice(0, 2000)}"`,
  ].join("\n\n");
}

export interface LlmTicketCommandInterpreterOptions {
  timeoutMs?: number;
  systemPrompt?: string;
}

export class LlmTicketCommandInterpreter implements TicketCommandInterpreterPort {
  private readonly timeoutMs: number;
  private readonly systemPrompt: string;

  constructor(
    private readonly llm: LlmConfig,
    private readonly completeFn?: CompleteFn,
    timeoutMsOrOptions?: number | LlmTicketCommandInterpreterOptions,
  ) {
    if (typeof timeoutMsOrOptions === "object" && timeoutMsOrOptions !== null) {
      this.timeoutMs = timeoutMsOrOptions.timeoutMs ?? 45_000;
      this.systemPrompt = timeoutMsOrOptions.systemPrompt ?? SYSTEM_PROMPT;
    } else {
      this.timeoutMs = timeoutMsOrOptions ?? 45_000;
      this.systemPrompt = SYSTEM_PROMPT;
    }
  }

  async interpret(input: TicketCommandInput): Promise<TicketCommand> {
    const cancelIntent = classifyCancelOrCloseIntent(input.message);
    const supplement = stripSupplementCommandWrapper(input.message);
    const projectKeys = new Set([
      ...input.candidates.map((c) => c.identifier.split("-")[0]).filter(Boolean),
    ]);
    const msgMentions = new Set(
      [...projectKeys].flatMap((pk) =>
        mentionedIdentifiers(input.message, pk).map((id) => id.toUpperCase()),
      ),
    );

    if (cancelIntent) {
      const mentionedOwn = input.candidates.find(
        (c) => (c.mentioned || msgMentions.has(c.identifier.toUpperCase())) && c.ownTicket,
      );
      const mentionedAny = input.candidates.find(
        (c) => c.mentioned || msgMentions.has(c.identifier.toUpperCase()),
      );
      const cancelTarget = mentionedOwn ?? mentionedAny;
      if (cancelTarget) {
        return {
          action: "cancel_or_close",
          identifier: cancelTarget.identifier,
          content: input.message.trim(),
          intent: cancelIntent,
        };
      }
    }

    if (!this.completeFn) {
      if (supplement.isSupplementCommand) {
        const target =
          input.candidates.find(
            (c) => (c.mentioned || msgMentions.has(c.identifier.toUpperCase())) && c.ownTicket,
          ) ??
          input.candidates.find((c) => c.mentioned || msgMentions.has(c.identifier.toUpperCase()));
        if (target) {
          return {
            action: "append",
            identifier: target.identifier,
            content: supplement.content,
          };
        }
      }
      return { action: "unclear" };
    }

    const raw = await withTimeout(
      this.completeFn(this.llm, this.systemPrompt, userPrompt(input)),
      this.timeoutMs,
      "ticket-command",
    ).catch((err) => {
      if (cancelIntent || supplement.isSupplementCommand) return "{}";
      throw err;
    });

    const parsed = (parseJsonLoose(raw) as Record<string, unknown> | null | undefined) ?? {};
    const action = String(parsed.action ?? "")
      .trim()
      .toLowerCase();

    const find = (v: unknown) =>
      input.candidates.find(
        (c) =>
          c.identifier.toUpperCase() ===
          String(v ?? "")
            .trim()
            .toUpperCase(),
      );
    const target = find(parsed.ticket ?? parsed.identifier);
    if (action === "move_created" && target) {
      const from = find(parsed.from) ?? input.candidates.find((c) => c.justCreated);
      if (from?.justCreated && from.identifier !== target.identifier) {
        return { action: "move_created", from: from.identifier, identifier: target.identifier };
      }
    }

    if (action === "new") return { action: "new" };
    if (action === "lookup" && target) return { action: "lookup", identifier: target.identifier };
    if (
      action === "cancel_or_close" &&
      target &&
      cancelIntent &&
      (target.mentioned || msgMentions.has(target.identifier.toUpperCase()))
    ) {
      const content =
        typeof parsed.content === "string" && parsed.content.trim()
          ? parsed.content.trim()
          : input.message.trim();
      return {
        action: "cancel_or_close",
        identifier: target.identifier,
        content,
        intent: cancelIntent,
      };
    }
    if (action === "edit" && target) {
      const instruction =
        typeof parsed.instruction === "string" && parsed.instruction.trim()
          ? parsed.instruction.trim()
          : input.message;
      return {
        action: "edit",
        identifier: target.identifier,
        instruction,
      };
    }
    if (action === "append" && target) {
      const llmContent =
        typeof parsed.content === "string" && parsed.content.trim() ? parsed.content.trim() : "";
      const content =
        supplement.isSupplementCommand && !supplement.content
          ? ""
          : llmContent && llmContent.toLowerCase() !== input.message.trim().toLowerCase()
            ? llmContent
            : supplement.isSupplementCommand
              ? supplement.content
              : llmContent || input.message;
      return { action: "append", identifier: target.identifier, content };
    }
    if (supplement.isSupplementCommand) {
      const mentionedOwn = input.candidates.find(
        (c) => (c.mentioned || msgMentions.has(c.identifier.toUpperCase())) && c.ownTicket,
      );
      const mentionedAny = input.candidates.find(
        (c) => c.mentioned || msgMentions.has(c.identifier.toUpperCase()),
      );
      const suppTarget = mentionedOwn ?? mentionedAny;
      if (suppTarget) {
        return { action: "append", identifier: suppTarget.identifier, content: supplement.content };
      }
    }
    return { action: "unclear" };
  }
}
