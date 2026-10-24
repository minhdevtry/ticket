import { describe, expect, test } from "bun:test";
import { evaluatePriorityRules, resolveRequestedPriority, type UrgencyRules } from "./priority";
import urgencyRules from "./urgency-rules.fixture.json";

const rules = urgencyRules as UrgencyRules;

const noEvidence = {
  scope: "single_user",
  blocksPayment: false,
  reconciliationMismatch: false,
  blocksLearning: false,
  dataLoss: false,
  hasWorkaround: false,
  singleDeviceOnly: false,
};

/**
 * Tests ported from intake-agents `mcp/tieulinh/priority.test.ts`, adapted to
 * the pure `evaluatePriorityRules` API (the MCP tool wrapper and its zod
 * evidence schema stay in the bot). `proposedLevel` + evidence go straight in.
 */
describe("evaluatePriorityRules", () => {
  test("hạ mức khi chỉ một người và có cách làm tạm", () => {
    const r = evaluatePriorityRules(rules, "Urgent", { ...noEvidence, hasWorkaround: true });
    expect(r.allowedLevel).toBe("High");
    expect(r.direction).toBe("lowered");
  });

  test("nâng mức khi đang chặn giao dịch, dù model đề Low", () => {
    const r = evaluatePriorityRules(rules, "Low", { ...noEvidence, blocksPayment: true });
    expect(r.allowedLevel).toBe("Urgent");
    expect(r.direction).toBe("raised");
  });

  test("sàn thắng trần: chặn giao dịch thì có cách làm tạm cũng vẫn Urgent", () => {
    const r = evaluatePriorityRules(rules, "Low", { ...noEvidence, blocksPayment: true, hasWorkaround: true });
    expect(r.allowedLevel).toBe("Urgent");
    expect(r.floorOverrodeCeiling).toBe(true);
  });

  test("cả hệ thống thì không còn là việc của một người", () => {
    const r = evaluatePriorityRules(rules, "Medium", { ...noEvidence, scope: "entire_system" });
    expect(r.allowedLevel).toBe("Urgent");
  });

  test("mức hợp lý thì giữ nguyên, không bịa lý do", () => {
    const r = evaluatePriorityRules(rules, "High", { ...noEvidence, scope: "group" });
    expect(r.direction).toBe("kept");
    expect(r.reasons).toEqual([]);
  });

  test("không có bằng chứng thì giữ nguyên mức đề xuất", () => {
    // Trước đây wrapper MCP báo `missingEvidence`; engine thuần chỉ cần: không
    // bằng chứng nào khớp luật thì mức đề xuất được giữ.
    const r = evaluatePriorityRules(rules, "High", {});
    expect(r.allowedLevel).toBe("High");
    expect(r.direction).toBe("kept");
  });

  test("học sinh đơn lẻ gián đoạn học tập thì sàn là High, không ép lên Urgent", () => {
    const r = evaluatePriorityRules(rules, "High", { ...noEvidence, scope: "single_user", blocksLearning: true });
    expect(r.allowedLevel).toBe("High");
    expect(r.direction).toBe("kept");
  });
});

/**
 * The "người báo xin gấp" rule, pulled out of pipeline.ts into the engine
 * (user decision 29/09): a requested higher priority is honoured only with a
 * reason and only strictly above the evidence level; it never lowers.
 */
describe("resolveRequestedPriority", () => {
  const levels = rules.levels;

  test("có lý do và cao hơn mức bằng chứng thì cho đúng mức xin", () => {
    const r = resolveRequestedPriority(levels, "Medium", { level: "Urgent", reason: "sếp đang chờ gấp" });
    expect(r.level).toBe("Urgent");
    expect(r.grantedByRequest).toBe(true);
  });

  test("xin mà không có lý do thì bỏ qua, giữ mức bằng chứng", () => {
    const r = resolveRequestedPriority(levels, "Medium", { level: "Urgent" });
    expect(r.level).toBe("Medium");
    expect(r.grantedByRequest).toBe(false);
  });

  test("không bao giờ hạ mức bằng chứng đã cao hơn", () => {
    const r = resolveRequestedPriority(levels, "Urgent", { level: "Low", reason: "em thấy không gấp lắm" });
    expect(r.level).toBe("Urgent");
    expect(r.grantedByRequest).toBe(false);
  });

  test("xin đúng bằng mức bằng chứng thì không tính là do người báo", () => {
    const r = resolveRequestedPriority(levels, "High", { level: "High", reason: "cần trong ngày" });
    expect(r.level).toBe("High");
    expect(r.grantedByRequest).toBe(false);
  });

  test("không có yêu cầu nào thì giữ mức bằng chứng", () => {
    const r = resolveRequestedPriority(levels, "Medium", undefined);
    expect(r.level).toBe("Medium");
    expect(r.grantedByRequest).toBe(false);
  });

  test("mức xin lạ (không trong bảng) không thể nâng mức", () => {
    const r = resolveRequestedPriority(levels, "Medium", { level: "SuperUrgent", reason: "gấp lắm" });
    expect(r.level).toBe("Medium");
    expect(r.grantedByRequest).toBe(false);
  });
});
