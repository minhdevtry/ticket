import { describe, expect, it } from "bun:test";
import {
  runConversation,
  scoreRun,
  scoreRuns,
  replyContains,
  createdTicketWithPrefix,
  noTicketCreated,
  turnHasButton,
  type ConversationRunner,
  type EvalScenario,
  type EvalTurnInput,
  type EvalTurnOutput,
} from "./index";

/**
 * A3 — eval harness TS. Test chứng minh khung chạy–bắt–chấm hoạt động với một
 * runner giả (engine mô phỏng), các check dựng sẵn đúng, và một lượt ném lỗi
 * thì run dừng gọn chứ không vỡ.
 */

/** Runner giả: gom đủ 2 lượt thì "tạo ticket" OP-1 và hiện nút xác nhận ở lượt chốt. */
function fakeRunner(): ConversationRunner {
  let turns = 0;
  let created = false;
  return {
    async step(input: EvalTurnInput): Promise<EvalTurnOutput> {
      turns++;
      if (input.text === "boom") throw new Error("nổ");
      if (input.text.includes("xác nhận")) {
        created = true;
        return { reply: "Đã tạo ticket OP-1 cho anh.", createdTicket: { identifier: "OP-1" } };
      }
      if (turns === 1) return { reply: "Anh mô tả giúp em sự cố ạ?" };
      return { reply: "Em tóm tắt vậy đúng chưa ạ?", buttons: ["✅ Xác nhận tạo phiếu"], createdTicket: created ? { identifier: "OP-1" } : null };
    },
  };
}

const scenario: EvalScenario = {
  name: "tạo phiếu cơ bản",
  turns: [{ text: "Classin lỗi" }, { text: "phòng 8B2" }, { kind: "button", text: "xác nhận" }],
};

describe("runConversation", () => {
  it("chạy đủ các lượt, thu transcript", async () => {
    const run = await runConversation(fakeRunner(), scenario);
    expect(run.transcript).toHaveLength(3);
    expect(run.transcript[0]!.output.reply).toContain("mô tả");
    expect(run.transcript[2]!.output.createdTicket?.identifier).toBe("OP-1");
  });

  it("một lượt ném lỗi → dừng, ghi lượt lỗi vào transcript", async () => {
    const run = await runConversation(fakeRunner(), { name: "lỗi", turns: [{ text: "boom" }, { text: "không tới" }] });
    expect(run.transcript).toHaveLength(1);
    expect(run.transcript[0]!.output.meta?.error).toBe(true);
  });
});

describe("scoreRun + check dựng sẵn", () => {
  it("các check đạt khi transcript đúng", async () => {
    const run = await runConversation(fakeRunner(), scenario);
    const scored = scoreRun(run, [
      createdTicketWithPrefix("OP"),
      turnHasButton(1, "Xác nhận"),
      replyContains(2, "đã tạo ticket"),
    ]);
    expect(scored.ok).toBe(true);
    expect(scored.passed).toBe(3);
    expect(scored.failed).toBe(0);
  });

  it("check trượt báo lý do, không vỡ", async () => {
    const run = await runConversation(fakeRunner(), scenario);
    const scored = scoreRun(run, [noTicketCreated()]); // kịch bản này CÓ tạo ticket → trượt
    expect(scored.ok).toBe(false);
    expect(scored.checks[0]!.reason).toContain("đã tạo");
  });

  it("check ném lỗi → tính trượt, không vỡ cả run", async () => {
    const run = await runConversation(fakeRunner(), scenario);
    const scored = scoreRun(run, [{ name: "xịt", run: () => { throw new Error("x"); } }]);
    expect(scored.ok).toBe(false);
    expect(scored.checks[0]!.reason).toContain("ném lỗi");
  });
});

describe("scoreRuns (nhiều kịch bản)", () => {
  it("tổng hợp pass/fail qua nhiều kịch bản, mỗi kịch bản runner mới", async () => {
    const chitchat: EvalScenario = { name: "chitchat", turns: [{ text: "chào em" }, { text: "ừ cảm ơn" }] };
    const report = await scoreRuns(
      () => fakeRunner(),
      [scenario, chitchat],
      [createdTicketWithPrefix("OP")],
    );
    expect(report.scenariosTotal).toBe(2);
    // scenario tạo ticket → đạt; chitchat không tạo → trượt check createdTicket
    expect(report.scenariosOk).toBe(1);
    expect(report.totalChecks).toBe(2);
  });

  it("noTicketCreated đạt cho kịch bản chitchat", async () => {
    const chitchat: EvalScenario = { name: "chitchat", turns: [{ text: "chào em" }] };
    const report = await scoreRuns(() => fakeRunner(), [chitchat], [noTicketCreated()]);
    expect(report.scenariosOk).toBe(1);
  });
});
