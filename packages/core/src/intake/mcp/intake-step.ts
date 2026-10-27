import { z } from "zod";
import { defineTool, type AnyMcpTool } from "../../core/mcp-tool";
import { describeToolFailure } from "../../core/tool-error";
import type { IntakeEngine } from "../engine/engine";
import { legacyActionForOutcome } from "../engine/action-map";
import type { StepOutcome } from "../engine/types";
import type { DraftRepository } from "../draft/repository";

const WAITS_FOR_USER: Record<string, true> = {
  ask_missing_field: true,
  confirm_summary: true,
  awaiting_user_confirmation: true,
  clarify_intent: true,
  ask_new_or_continue: true,
  ask_split_or_merge: true,
  confirm_ticket_action: true,
};
function deriveStatus(outcome: StepOutcome, action: string): string {
  if (action === "confirm_summary" || outcome === "summary") return "ready_for_confirmation";
  if (
    action === "ticket_created" ||
    action === "already_created" ||
    outcome === "created" ||
    outcome === "already_created"
  ) {
    return "created";
  }
  if (action === "canceled" || outcome === "canceled" || outcome === "action_canceled") {
    return "canceled";
  }
  if (action === "create_failed" || outcome === "failed") return "failed";
  if (action === "ask_new_or_continue" || outcome === "parked") return "parked";
  return "collecting";
}

export interface IntakeStepDeps {
  engine: IntakeEngine;
  drafts?: DraftRepository;
}

export function intakeStepTool(deps: IntakeStepDeps): AnyMcpTool {
  const { engine, drafts } = deps;

  return defineTool({
    name: "intake_step",
    description:
      "Đường CHÍNH tiếp nhận sự cố kỹ thuật, tất định từng lượt hội thoại. " +
      "BẮT BUỘC gọi mỗi khi người dùng nhắn về sự cố: báo lỗi, trả lời câu hỏi, bấm nút, xác nhận, huỷ, gửi ảnh. " +
      "Tool tự trích xuất, lưu tờ khai IntakeDraft, hỏi trường còn thiếu (nút bấm tự hiện trên Telegram), " +
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
      forceNew: z.boolean().optional().describe("Bắt đầu sự cố mới (/new)"),
    },
    handler: async ({
      message,
      mediaPaths,
      chatId,
      reporterName,
      reporterUsername,
      reporterNameCode,
      forceNew,
    }) => {
      try {
        const stepOutput = await engine.step({
          chatId,
          message: message ?? "",
          mediaPaths,
          reporter: {
            name: reporterName,
            username: reporterUsername,
            nameCode: reporterNameCode,
          },
          forceNew,
        });

        const legacyAction = legacyActionForOutcome(stepOutput.outcome);
        const action = legacyAction ?? stepOutput.outcome;
        const status = deriveStatus(stepOutput.outcome, action);
        const waitsForUser = Boolean(WAITS_FOR_USER[action]);

        const voiceText = stepOutput.messages.map((m) => m.text).join("\n\n");
        const buttonsShown = stepOutput.messages.some((m) =>
          Boolean(m.buttons && m.buttons.length > 0),
        );

        let revision: number | undefined;
        if (drafts) {
          const doc = stepOutput.docId
            ? drafts.getByDocId(stepOutput.docId)
            : drafts.getLatestByChatId(chatId);
          revision = doc?.revision;
        }

        const agentInstruction = waitsForUser
          ? "Gửi nguyên văn voiceText rồi KẾT THÚC LƯỢT. Chờ người dùng tự trả lời hoặc bấm nút — không tự chọn đáp án, không gọi lại intake_step trong lượt này."
          : "Gửi nguyên văn voiceText cho người dùng.";

        return {
          success: stepOutput.outcome !== "failed",
          action,
          status,
          voiceText,
          displayMarkdown: voiceText,
          missingFields: stepOutput.missingFields,
          buttonsShown,
          agentInstruction,
          issue: stepOutput.issue ?? stepOutput.createdIssue,
          similarTickets: [],
          docId: stepOutput.docId,
          revision,
        };
      } catch (err: unknown) {
        return describeToolFailure("intake_step", err);
      }
    },
  });
}
