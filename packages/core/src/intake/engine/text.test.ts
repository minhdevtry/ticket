import { describe, expect, it } from "bun:test";
import type { ReplyCandidate } from "../ports";
import { LlmTicketCommandInterpreter } from "./command-interpreter";
import { foldButton, mentionedIdentifiers, stripSupplementCommandWrapper } from "./text";

const llm = { baseUrl: "", apiKey: "", model: "m" };

describe("mentionedIdentifiers", () => {
  it("nhận các cách viết mã ticket", () => {
    expect(mentionedIdentifiers("TECH-795 cập nhật", "TECH")).toEqual(["TECH-795"]);
    expect(mentionedIdentifiers("Ticket tech 722 đã ổn, tech722 nữa", "TECH")).toEqual([
      "TECH-722",
    ]);
    expect(mentionedIdentifiers("mã đơn DH900002", "TECH")).toEqual([]);
  });

  it("mentionedIdentifiers nhận các kiểu người báo hay gõ (TECH-1001, 30/09)", () => {
    const ids = (t: string) => mentionedIdentifiers(t, "TECH");
    expect(ids("đây là ticket 989 mà")).toEqual(["TECH-989"]);
    expect(ids("Bổ sung TECH_989 video")).toEqual(["TECH-989"]);
    expect(ids("tech 1001 và #989")).toEqual(["TECH-1001", "TECH-989"]);
    expect(ids("tk 989 lỗi")).toEqual(["TECH-989"]);
    expect(ids("SĐT 0900000017 đơn DH900005 ticket")).toEqual([]);
    expect(ids("TECHTEST-795")).toEqual([]);
  });

  it("mentionedIdentifiers hỗ trợ khoá dự án có chữ số mà không khớp nhầm SĐT hay mã khác", () => {
    const ids = (t: string) => mentionedIdentifiers(t, "TECH2");
    expect(ids("TECH2-795 cập nhật")).toEqual(["TECH2-795"]);
    expect(ids("bổ sung tech2 722 và TECH2_989")).toEqual(["TECH2-722", "TECH2-989"]);
    expect(ids("ticket 989 và #501")).toEqual(["TECH2-989", "TECH2-501"]);
    expect(ids("SĐT 0900000005, 0900-000005, đơn DH900002, mã TECH2026")).toEqual([]);
  });
});

describe("stripSupplementCommandWrapper", () => {
  it("bóc vỏ câu lệnh bổ sung / đính kèm trần (TECH-1218: 'update vào tick TECH-1218') để không ghi câu lệnh thành comment", async () => {
    const cand1218: ReplyCandidate = {
      identifier: "TECH-1218",
      issueId: 1107,
      ownTicket: true,
      mentioned: true,
    };
    for (const bareCmd of [
      "update vào tick TECH-1218",
      "update TECH-1218",
      "bổ sung vào ticket TECH-1218",
      "đính kèm ảnh vào TECH-1218 giúp em nhé",
      "gắn ảnh vào ticket TECH-1218 ạ",
      "TECH-1218 bổ sung ạ",
      "ảnh bổ sung cho ticket TECH-1218",
    ]) {
      expect(stripSupplementCommandWrapper(bareCmd)).toEqual({
        isSupplementCommand: true,
        content: "",
      });
    }
    expect(
      stripSupplementCommandWrapper("update vào tick TECH-1218: học sinh bị chặn Vuihoc.vn"),
    ).toEqual({
      isSupplementCommand: true,
      content: "học sinh bị chặn Vuihoc.vn",
    });
    expect(stripSupplementCommandWrapper("nhầm rồi, cái này bổ sung cho TECH-795")).toEqual({
      isSupplementCommand: false,
      content: "nhầm rồi, cái này bổ sung cho TECH-795",
    });

    const unclearInterp = new LlmTicketCommandInterpreter(llm, async () => '{"action":"unclear"}');
    expect(
      await unclearInterp.interpret({
        message: "update vào tick TECH-1218",
        attachments: 0,
        candidates: [cand1218],
      }),
    ).toEqual({
      action: "append",
      identifier: "TECH-1218",
      content: "",
    });

    const echoInterp = new LlmTicketCommandInterpreter(
      llm,
      async () => '{"action":"append","ticket":"TECH-1218","content":"update vào tick TECH-1218"}',
    );
    expect(
      await echoInterp.interpret({
        message: "update vào tick TECH-1218",
        attachments: 1,
        candidates: [cand1218],
      }),
    ).toEqual({
      action: "append",
      identifier: "TECH-1218",
      content: "",
    });
  });
});

describe("foldButton", () => {
  it("chuẩn hoá nhãn nút chính xác", () => {
    expect(foldButton("✅ Bổ sung vào TECH-795")).toBe("bo sung vao tech 795");
    expect(foldButton("Bổ sung vào TECH-795")).toBe("bo sung vao tech 795");
    expect(foldButton("Huỷ")).toBe("huy");
    expect(foldButton("Hủy")).toBe("huy");
  });
});
