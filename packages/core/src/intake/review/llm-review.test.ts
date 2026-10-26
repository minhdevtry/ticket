import { describe, expect, it } from "bun:test";
import { LlmTechReviewer } from "./llm-review";

const llm = { baseUrl: "", apiKey: "", model: "m" };
const input = {
  description: "Hạn tự học Toán 3 cập nhật sai",
  attachments: 0,
  known: { "Tài khoản HS / SĐT": "0900000006" },
};

describe("LlmTechReviewer", () => {
  it("đọc JSON LLM: tối đa 3 dữ kiện + câu hỏi; hướng dẫn và lời báo đều vào prompt", async () => {
    let sys = "";
    let user = "";
    const r = new LlmTechReviewer(llm, "HƯỚNG DẪN X", async (_c, s, u) => {
      sys = s;
      user = u;
      return '```json\n{"missing":["mã đơn","hạn đang hiện","hạn đúng","thừa"],"question":"Cho em xin mã đơn ạ"}\n```';
    });
    const out = await r.review(input);
    expect(out.missing).toEqual(["mã đơn", "hạn đang hiện", "hạn đúng"]);
    expect(out.question).toBe("Cho em xin mã đơn ạ");
    expect(sys).toContain("HƯỚNG DẪN X");
    expect(sys).toContain("KHÔNG hỏi nguyên nhân");
    expect(user).toContain("0900000006");
  });

  it("đủ dữ kiện, thiếu câu hỏi hay JSON hỏng → coi như đủ", async () => {
    for (const raw of ['{"missing":[]}', '{"missing":["mã đơn"]}', "không phải json"]) {
      const out = await new LlmTechReviewer(llm, "", async () => raw).review(input);
      expect(out.missing).toEqual([]);
    }
  });

  it("LLM treo quá hạn → lỗi (pipeline bắt và bỏ qua)", async () => {
    const r = new LlmTechReviewer(llm, "", () => new Promise(() => {}), 20);
    await expect(r.review(input)).rejects.toThrow("timeout");
  });
});
