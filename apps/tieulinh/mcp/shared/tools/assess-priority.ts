import { defineTool, type AnyMcpTool } from "@vuihoc/bot-core/core";
import { type UrgencyRules, evaluatePriorityRules } from "@vuihoc/bot-core/intake";
import { z } from "zod";

/**
 * Wrapper MCP của Tiểu Linh cho `assess_priority`. Engine floor/ceiling
 * (`evaluatePriorityRules`) và các kiểu `UrgencyRules*` nằm ở
 * `@vuihoc/bot-core/intake`; file này chỉ giữ schema bằng chứng (zod) và việc
 * gắn engine vào MCP SDK.
 */

const evidenceShape = {
  scope: z
    .enum(["single_user", "group", "entire_system"])
    .optional()
    .describe(
      "Lỗi đang ảnh hưởng một người, một nhóm, hay cả hệ thống? (single_user | group | entire_system)",
    ),
  blocksPayment: z
    .boolean()
    .optional()
    .describe("Có ai đang KHÔNG hoàn tất được giao dịch ngay lúc này không?"),
  reconciliationMismatch: z.boolean().optional().describe("Có lệch đối soát tiền không?"),
  blocksLearning: z.boolean().optional().describe("Học sinh đã trả tiền mà không học được?"),
  dataLoss: z.boolean().optional().describe("Có mất dữ liệu không lùi lại được không?"),
  hasWorkaround: z.boolean().optional().describe("Có cách làm tạm để đi vòng qua lỗi không?"),
  singleDeviceOnly: z.boolean().optional().describe("Chỉ hỏng trên một máy, máy khác vẫn chạy?"),
};

export function assessPriority(rules: UrgencyRules): AnyMcpTool {
  const levels = rules.levels;

  return defineTool({
    name: "assess_priority",
    description:
      "Đối chiếu mức ưu tiên bạn định gán với bằng chứng đọc được từ mô tả. " +
      "DÙNG THẲNG `allowedLevel` làm mức của ticket — KHÔNG dừng lại hỏi người dùng. " +
      "`differsFromProposed: true` chỉ nghĩa là mức bạn đề xuất lệch với bằng chứng, không phải lệnh dừng.",
    inputSchema: {
      proposedLevel: z
        .enum(levels as [string, ...string[]])
        .describe("Mức bạn định gán sau khi đọc mô tả"),
      ...evidenceShape,
    },
    handler: (input) => {
      const evidence: Record<string, unknown> = {};
      const missing: string[] = [];

      for (const key of Object.keys(evidenceShape) as Array<keyof typeof evidenceShape>) {
        const value = (input as Record<string, unknown>)[key];
        if (value === undefined) {
          missing.push(key);
        } else {
          evidence[key] = value;
        }
      }

      const result = evaluatePriorityRules(rules, input.proposedLevel, evidence);
      return {
        ...result,
        missingEvidence: missing,
      };
    },
  });
}
