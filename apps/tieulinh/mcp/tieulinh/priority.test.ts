import { describe, expect, test } from "bun:test";
import { assessPriority } from "../shared/index";
import urgencyRules from "./domain/urgency-rules.json";

const tool = assessPriority(urgencyRules);
const assess = (input: Record<string, unknown>) => tool.handler(input as never) as any;

const noEvidence = {
  scope: "single_user",
  blocksPayment: false,
  reconciliationMismatch: false,
  blocksLearning: false,
  dataLoss: false,
  hasWorkaround: false,
  singleDeviceOnly: false,
};

describe("assess_priority", () => {
  test("hạ mức khi chỉ một người và có cách làm tạm", () => {
    // Luật trần này được hiệu chỉnh bằng ticket thật: 19/30 ca người dùng chọn
    // Urgent rơi đúng vào đây, chấm lại chỉ đáng High.
    const r = assess({ ...noEvidence, proposedLevel: "Urgent", hasWorkaround: true });
    expect(r.allowedLevel).toBe("High");
    expect(r.direction).toBe("lowered");
  });

  test("nâng mức khi đang chặn giao dịch, dù model đề Low", () => {
    const r = assess({ ...noEvidence, proposedLevel: "Low", blocksPayment: true });
    expect(r.allowedLevel).toBe("Urgent");
    expect(r.direction).toBe("raised");
  });

  test("sàn thắng trần: chặn giao dịch thì có cách làm tạm cũng vẫn Urgent", () => {
    const r = assess({ ...noEvidence, proposedLevel: "Low", blocksPayment: true, hasWorkaround: true });
    expect(r.allowedLevel).toBe("Urgent");
    expect(r.floorOverrodeCeiling).toBe(true);
  });

  test("cả hệ thống thì không còn là việc của một người", () => {
    const r = assess({ ...noEvidence, proposedLevel: "Medium", scope: "entire_system" });
    expect(r.allowedLevel).toBe("Urgent");
  });

  test("mức hợp lý thì giữ nguyên, không bịa lý do", () => {
    const r = assess({ ...noEvidence, proposedLevel: "High", scope: "group" });
    expect(r.direction).toBe("kept");
    expect(r.reasons).toEqual([]);
  });

  test("thiếu bằng chứng thì nói rõ thiếu gì, không đoán bừa", () => {
    const r = assess({ proposedLevel: "High" });
    expect(r.allowedLevel).toBe("High");
    expect(r.missingEvidence).toContain("scope");
    expect(r.missingEvidence).toContain("blocksPayment");
  });

  test("học sinh đơn lẻ gián đoạn học tập thì sàn là High, không ép lên Urgent", () => {
    const r = assess({ ...noEvidence, proposedLevel: "High", scope: "single_user", blocksLearning: true });
    expect(r.allowedLevel).toBe("High");
    expect(r.direction).toBe("kept");
  });
});
