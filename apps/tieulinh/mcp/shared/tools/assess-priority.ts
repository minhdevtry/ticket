import { z } from "zod";
import { defineTool, type AnyMcpTool } from "../tool";

export interface UrgencyRuleFloor {
  when: Record<string, unknown>;
  minLevel: string;
  reason: string;
}

export interface UrgencyRuleCeiling {
  when: Record<string, unknown>;
  maxLevel: string;
  reason: string;
}

export interface UrgencyRules {
  levels: string[];
  floors: UrgencyRuleFloor[];
  ceilings: UrgencyRuleCeiling[];
  evidence?: Record<string, unknown>;
}

const evidenceShape = {
  scope: z
    .enum(["single_user", "group", "entire_system"])
    .optional()
    .describe("Lỗi đang ảnh hưởng một người, một nhóm, hay cả hệ thống? (single_user | group | entire_system)"),
  blocksPayment: z.boolean().optional().describe("Có ai đang KHÔNG hoàn tất được giao dịch ngay lúc này không?"),
  reconciliationMismatch: z.boolean().optional().describe("Có lệch đối soát tiền không?"),
  blocksLearning: z.boolean().optional().describe("Học sinh đã trả tiền mà không học được?"),
  dataLoss: z.boolean().optional().describe("Có mất dữ liệu không lùi lại được không?"),
  hasWorkaround: z.boolean().optional().describe("Có cách làm tạm để đi vòng qua lỗi không?"),
  singleDeviceOnly: z.boolean().optional().describe("Chỉ hỏng trên một máy, máy khác vẫn chạy?"),
};

const matches = (when: Record<string, unknown>, evidence: Record<string, unknown>) =>
  Object.entries(when).every(([k, v]) => evidence[k] === v);

export function evaluatePriorityRules(
  rules: UrgencyRules,
  proposedLevel: string,
  evidence: Record<string, unknown>,
) {
  const levels = rules.levels;
  const indexOf = (level: string) => levels.indexOf(level);

  let floor = 0;
  const floorReasons: string[] = [];
  for (const rule of rules.floors) {
    if (!matches(rule.when, evidence)) continue;
    floor = Math.max(floor, indexOf(rule.minLevel));
    floorReasons.push(rule.reason);
  }

  let ceiling = levels.length - 1;
  const ceilingReasons: string[] = [];
  for (const rule of rules.ceilings) {
    if (!matches(rule.when, evidence)) continue;
    ceiling = Math.min(ceiling, indexOf(rule.maxLevel));
    ceilingReasons.push(rule.reason);
  }

  const floorWins = ceiling < floor;
  if (floorWins) ceiling = floor;

  const proposed = indexOf(proposedLevel);
  const allowed = Math.min(Math.max(proposed, floor), ceiling);
  const direction = allowed > proposed ? "raised" : allowed < proposed ? "lowered" : "kept";

  return {
    proposedLevel,
    allowedLevel: levels[allowed],
    direction,
    differsFromProposed: direction !== "kept",
    reasons: direction === "raised" ? floorReasons : direction === "lowered" ? ceilingReasons : [],
    floor: levels[floor],
    ceiling: levels[ceiling],
    floorOverrodeCeiling: floorWins,
  };
}

export function assessPriority(rules: UrgencyRules): AnyMcpTool {
  const levels = rules.levels;

  return defineTool({
    name: "assess_priority",
    description:
      "Đối chiếu mức ưu tiên bạn định gán với bằng chứng đọc được từ mô tả. " +
      "DÙNG THẲNG `allowedLevel` làm mức của ticket — KHÔNG dừng lại hỏi người dùng. " +
      "`differsFromProposed: true` chỉ nghĩa là mức bạn đề xuất lệch với bằng chứng, không phải lệnh dừng.",
    inputSchema: {
      proposedLevel: z.enum(levels as [string, ...string[]]).describe("Mức bạn định gán sau khi đọc mô tả"),
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
