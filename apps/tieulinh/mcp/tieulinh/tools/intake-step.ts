import { z } from "zod";
import { defineTool, type AnyMcpTool } from "../../shared/tool";
import { IntakeStepPipeline, type IntakePipelineOptions } from "../../../lib/intake-step/pipeline";
import type { IntakeNextAction } from "../../../lib/intake-document/packet";

/** Các bước bot vừa hỏi / xin xác nhận — lượt phải dừng để người dùng trả lời. */
const WAITS_FOR_USER: ReadonlySet<IntakeNextAction> = new Set([
  "ask_missing_field",
  "confirm_summary",
  "awaiting_user_confirmation",
  "clarify_intent",
]);

export function intakeStep(options: IntakePipelineOptions): AnyMcpTool {
  const pipeline = new IntakeStepPipeline(options);

  return defineTool({
    name: "intake_step",
    description:
      "Đường CHÍNH tiếp nhận sự cố kỹ thuật, tất định từng lượt hội thoại. " +
      "BẮT BUỘC gọi mỗi khi người dùng nhắn về sự cố: báo lỗi, trả lời câu hỏi, bấm nút, xác nhận, huỷ, gửi ảnh. " +
      "Tool tự trích xuất, lưu tờ khai IntakeDocument, hỏi trường còn thiếu (nút bấm tự hiện trên Telegram), " +
      "xin xác nhận, TỰ TẠO ticket khi người dùng xác nhận và tự ghi phần bổ sung vào ticket đã tạo. " +
      "Gửi nguyên văn `voiceText` cho người dùng. KHÔNG gọi create_issue sau khi tool này đã tạo ticket. " +
      "`message` phải là đúng tin người dùng vừa gửi — TUYỆT ĐỐI không tự gửi lời xác nhận (vd callbackData của nút) thay người dùng; " +
      "sau action confirm_summary thì kết thúc lượt, chờ người dùng bấm nút.",
    inputSchema: {
      message: z
        .string()
        .optional()
        .describe("Nội dung tin nhắn văn bản người dùng vừa gửi (có thể rỗng nếu chỉ gửi ảnh)"),
      mediaPaths: z
        .array(z.string())
        .optional()
        .describe("Đường dẫn ảnh/video người dùng gửi trong tin này — tool tự đính kèm vào ticket"),
      chatId: z.string().describe("ID của phòng chat / Telegram chat_id"),
      reporterName: z.string().optional().describe("Tên người báo nếu có"),
      reporterUsername: z.string().optional().describe("Telegram username của người báo"),
      reporterNameCode: z.string().optional().describe("Mã nhân sự (VD: CS_user_a)"),
      excludeIdentifier: z.string().optional().describe("Mã ticket loại trừ khi tìm kiếm tương tự"),
    },
    handler: async ({
      message,
      mediaPaths,
      chatId,
      reporterName,
      reporterUsername,
      reporterNameCode,
      excludeIdentifier,
    }) => {
      const packet = await pipeline.run({
        chatId,
        message: message ?? "",
        mediaPaths,
        reporter: {
          name: reporterName,
          username: reporterUsername,
          nameCode: reporterNameCode,
          telegramId: chatId,
        },
        excludeIdentifier,
      });

      // Không trả nút (callbackData) cho model: nút đã được pipeline đẩy thẳng lên
      // Telegram. Thấy danh sách lựa chọn, model từng tự gọi lại intake_step với
      // "Sale" / "đúng rồi" thay người dùng.
      const waitsForUser = WAITS_FOR_USER.has(packet.action);
      return {
        success: packet.success,
        action: packet.action,
        status: packet.status,
        voiceText: packet.voiceText,
        displayMarkdown: packet.displayMarkdown,
        missingFields: packet.missingFields,
        buttonsShown: Boolean(packet.buttons?.length),
        agentInstruction: waitsForUser
          ? "Gửi nguyên văn voiceText rồi KẾT THÚC LƯỢT. Chờ người dùng tự trả lời hoặc bấm nút — không tự chọn đáp án, không gọi lại intake_step trong lượt này."
          : "Gửi nguyên văn voiceText cho người dùng.",
        issue: packet.issue,
        similarTickets: packet.similarTickets,
        docId: packet.docId,
        revision: packet.revision,
      };
    },
  });
}
