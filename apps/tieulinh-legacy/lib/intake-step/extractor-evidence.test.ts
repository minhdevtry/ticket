import { describe, expect, it } from "bun:test";
import { FieldExtractor } from "./extractor";

// Bug thật 24/09 (giả lập qua openclaw + MiniMax-M3): "Gấp: cả lớp 30 học sinh không vào
// được phòng học DUO" ra ưu tiên Trung bình — prompt không liệt kê khoá JSON nên model
// không bao giờ trả scope/blocksLearning, bảng luật sàn Urgent không có gì để khớp.
const fakeLlm = { baseUrl: "http://llm.fake", apiKey: "k", model: "m" };

describe("Trích bằng chứng ưu tiên", () => {
  it("prompt gửi LLM liệt kê đủ khoá JSON, gồm các trường bằng chứng", async () => {
    let sys = "";
    const ex = new FieldExtractor(fakeLlm, async (_c, s) => {
      sys = s;
      return '{"userIntent":"report_issue"}';
    });
    await ex.extract("app lỗi");
    for (const key of [
      "userIntent",
      "title",
      "symptoms",
      "studentAccount",
      "scope",
      "blocksLearning",
      "blocksPayment",
      "hasWorkaround",
    ]) {
      expect(sys).toContain(`"${key}"`);
    }
  });

  it("LLM không trả bằng chứng thì luật nhận diện bù: cả lớp không vào học được → group + blocksLearning", async () => {
    const ex = new FieldExtractor(
      fakeLlm,
      async () => '{"userIntent":"report_issue","title":"Cả lớp không vào được DUO"}',
    );
    const r = await ex.extract(
      "Gấp: cả lớp 30 học sinh không vào được phòng học DUO, lớp bắt đầu 5 phút nữa",
    );
    expect(r.blocksLearning).toBe(true);
    expect(r.scope).toBe("group");
  });

  it("giá trị LLM trả về thắng luật nhận diện", async () => {
    const ex = new FieldExtractor(
      fakeLlm,
      async () => '{"userIntent":"report_issue","scope":"entire_system","blocksLearning":true}',
    );
    const r = await ex.extract("cả lớp không vào được lớp");
    expect(r.scope).toBe("entire_system");
  });

  it("không LLM: một học sinh không vào được lớp → blocksLearning, scope single_user", async () => {
    const r = await new FieldExtractor().extract("học sinh không vào được lớp học trên app DUO");
    expect(r.blocksLearning).toBe(true);
    expect(r.scope).toBe("single_user");
  });

  it("không LLM: không thanh toán được → blocksPayment", async () => {
    const r = await new FieldExtractor().extract(
      "phụ huynh bấm thanh toán thì báo lỗi 404, không thanh toán được",
    );
    expect(r.blocksPayment).toBe(true);
  });

  it("không tạo/lên được đơn → blocksPayment (đúng câu hỏi trong urgency-rules)", async () => {
    for (const t of [
      "CRM không tạo được đơn cho khách, báo trùng tài khoản",
      "sale không lên được đơn",
      "không lập được đơn hàng",
    ]) {
      expect((await new FieldExtractor().extract(t)).blocksPayment).toBe(true);
    }
  });

  it("luật nhận diện thấy cụm rõ ràng thì thắng false mặc định của LLM", async () => {
    const ex = new FieldExtractor(
      fakeLlm,
      async () => '{"userIntent":"report_issue","blocksPayment":false,"blocksLearning":false}',
    );
    const r = await ex.extract("CRM không tạo được đơn cho khách");
    expect(r.blocksPayment).toBe(true);
  });

  it("tin bổ sung không mô tả lỗi (chỉ SĐT) không bịa bằng chứng", async () => {
    const r = await new FieldExtractor().extract("SĐT học sinh 0900000005");
    expect(r.blocksLearning).toBeUndefined();
    expect(r.scope).toBeUndefined();
  });
});

describe("Bộ phận phải có trong tin nhắn (chống model bịa)", () => {
  // Bug thật 24/09: MiniMax-M3 trả reportingDept "Vận hành" cho "Bên em có lỗi: CRM không tạo được đơn…"
  // → bot không bao giờ hỏi bộ phận.
  const llmSays = (dept: string) =>
    new FieldExtractor(fakeLlm, async () =>
      JSON.stringify({ userIntent: "report_issue", reportingDept: dept }),
    );

  it("tin không nhắc bộ phận thì bỏ giá trị LLM đoán", async () => {
    const r = await llmSays("Vận hành").extract(
      "Bên em có lỗi: CRM không tạo được đơn cho khách, báo trùng tài khoản",
    );
    expect(r.reportingDept).toBeUndefined();
  });

  it("nhận khi tin nhắc đúng tên, không dấu, hay viết tắt", async () => {
    expect((await llmSays("Vận hành").extract("Em bên Vận hành nhé")).reportingDept).toBe(
      "Vận hành",
    );
    expect((await llmSays("Vận hành").extract("em ben van hanh")).reportingDept).toBe("Vận hành");
    expect((await llmSays("CSKH").extract("chị bên cskh ạ")).reportingDept).toBe("CSKH");
    expect((await llmSays("Vận hành").extract("bên VH báo lỗi")).reportingDept).toBe("Vận hành");
    expect((await llmSays("CSKH").extract("em bên chăm sóc khách hàng")).reportingDept).toBe(
      "CSKH",
    );
  });
});
