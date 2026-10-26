import { describe, expect, it } from "bun:test";
import { detectSystem, detectUnrecognizedDept, stripGreeting } from "./heuristics";
import { FieldExtractor } from "./llm-extractor";

describe("Bộ phận ngoài danh mục (unrecognized dept)", () => {
  it("nhận ra 'Kế toán' là bộ phận ngoài danh mục", () => {
    expect(detectUnrecognizedDept("Tôi bên bộ phận Kế toán ạ")).toBe("Kế toán");
  });

  it("bỏ qua khi bộ phận đã khớp danh mục", () => {
    expect(detectUnrecognizedDept("Tôi bên bộ phận Sale ạ")).toBeUndefined();
    expect(detectUnrecognizedDept("Em là CSKH nhé")).toBeUndefined();
  });

  it("không bịa khi tin không nhắc bộ phận", () => {
    expect(detectUnrecognizedDept("App Duo không vào được lớp học")).toBeUndefined();
  });

  it("bỏ qua cụm viết tắt đã có trong DEPT_SYNONYMS", () => {
    expect(detectUnrecognizedDept("Tôi bên CSKH ạ")).toBeUndefined();
    expect(detectUnrecognizedDept("bên khối QLL báo lỗi")).toBeUndefined();
  });

  it("extractor trả reportingDeptUnrecognized khi LLM không đoán ra bộ phận", async () => {
    // LLM trả null (không đoán) — detector bắt từ câu chữ
    const ex = new FieldExtractor(
      { baseUrl: "http://llm.fake", apiKey: "k", model: "m" },
      async () =>
        JSON.stringify({ userIntent: "report_issue", reportingDept: null, symptoms: ["lỗi Zalo"] }),
    );
    const res = await ex.extract("Tôi là kế toán bộ phận Kế toán, không gửi được Zalo cho khách");
    expect(res.reportingDept).toBeUndefined();
    expect(res.reportingDeptUnrecognized).toBe("Kế toán");
  });
});

describe("System synonyms cho công cụ bên thứ 3", () => {
  // TECH-876..887: Công cụ bên thứ 3 (Zalo, Viber, Messenger) vào Khác_Hạ tầng_IT
  it("nhận Zalo/Viber/Messenger vào Khác_Hạ tầng_IT", () => {
    expect(detectSystem("Zalo PC bị đơ không gửi được tin")).toBe("Khác_Hạ tầng_IT");
    expect(detectSystem("gửi tin viber bị treo")).toBe("Khác_Hạ tầng_IT");
    expect(detectSystem("messenger không nhận tin nhắn")).toBe("Khác_Hạ tầng_IT");
  });

  it("hệ thống danh mục vẫn thắng từ đồng nghĩa", () => {
    expect(detectSystem("LMS không load bài")).toBe("LMS_Vuihoc");
    expect(detectSystem("CRM không tạo được đơn")).toBe("CRM_Vuihoc");
  });
});

describe("Tiêu đề dự phòng bỏ lời chào", () => {
  // TECH-1146: Cắt lời chào khỏi tiêu đề dự phòng
  it("cắt 'Em chào anh, em là …' khỏi tiêu đề heuristic", () => {
    expect(
      stripGreeting("Em chào anh, em là HueDT bên bộ phận Sale. Zalo PC bị đơ không gửi được tin"),
    ).toBe("Zalo PC bị đơ không gửi được tin");
  });

  it("giữ nguyên câu không có lời chào", () => {
    expect(stripGreeting("Zalo PC bị đơ, gõ chữ chậm")).toBe("Zalo PC bị đơ, gõ chữ chậm");
  });

  it("chỉ chào trơn thì giữ câu gốc", () => {
    expect(stripGreeting("Em chào anh")).toBe("Em chào anh");
  });

  it("extractor không LLM cho tiêu đề không còn lời chào", async () => {
    const res = await new FieldExtractor().extract(
      "Em chào anh, em là HueDT bên bộ phận Sale. Zalo PC em bị đơ, không gửi được tin nhắn cho khách hàng.",
    );
    expect(res.title).toBe("Zalo PC em bị đơ, không gửi được tin nhắn cho khách hàng.");
  });
});

describe("Bộ phận ngoài danh mục", () => {
  // Phần "hỏi lại đúng một lần" (câu hỏi phản hồi nói rõ bộ phận ngoài danh mục) là
  // hành vi của ENGINE, thuộc PR 7 của RFC 0002. Ở PR 5 chỉ chứng minh được phần bộ
  // trích xuất: nhận ra bộ phận ngoài danh mục và KHÔNG đoán bừa một bộ phận trong
  // danh mục.
  it("extractor nhận ra bộ phận ngoài danh mục và không đoán bừa", async () => {
    const ex = new FieldExtractor(
      { baseUrl: "http://llm.fake", apiKey: "k", model: "m" },
      async () =>
        JSON.stringify({
          userIntent: "report_issue",
          reportingDept: null,
          symptoms: ["lỗi Zalo PC đơ"],
        }),
    );
    const res = await ex.extract(
      "Em chào anh, Zalo PC em bị đơ không gửi được tin cho khách. Em bên bộ phận Kế toán ạ.",
    );
    expect(res.reportingDept).toBeUndefined();
    expect(res.reportingDeptUnrecognized).toBe("Kế toán");
  });
});
