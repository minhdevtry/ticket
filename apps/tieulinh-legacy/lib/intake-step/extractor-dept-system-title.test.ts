import { describe, expect, it } from "bun:test";
import { detectUnrecognizedDept, detectSystem, stripGreeting, FieldExtractor } from "./extractor";
import { intakeStep } from "../../mcp/tieulinh/tools/intake-step";
import { IntakeDocumentRepository } from "../intake-document/repository";
import { applySchema } from "../storage/schema";
import { Database } from "bun:sqlite";
import validationRules from "../../mcp/tieulinh/domain/validation-rules.json";
import fieldRequirements from "../../mcp/tieulinh/domain/required_fields.json";
import productMapping from "../../mcp/tieulinh/domain/product_mapping.json";
import urgencyRules from "../../mcp/tieulinh/domain/urgency-rules.json";
import * as fs from "node:fs";

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

describe("Pipeline hỏi lại bộ phận ngoài danh mục đúng một lần", () => {
  function makeStep(dbPath: string) {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    const db = new Database(dbPath);
    applySchema(db);
    const repo = new IntakeDocumentRepository(db);
    const fakeLlm = { baseUrl: "http://llm.fake", apiKey: "k", model: "m" };
    const extractor = new FieldExtractor(fakeLlm, async () =>
      JSON.stringify({
        userIntent: "report_issue",
        reportingDept: null,
        symptoms: ["lỗi Zalo PC đơ"],
      }),
    );
    const step = intakeStep({
      repo,
      extractor,
      projectKey: "TECHTEST",
      validationRules: validationRules as any,
      fieldRequirements: fieldRequirements as any,
      productMapping: productMapping as any,
      urgencyRules: urgencyRules as any,
      // Ca này dừng ở bước hỏi, không bao giờ tạo ticket.
      itsaplan: {} as any,
    });
    return { step, repo, dbPath };
  }

  it("câu hỏi nói rõ bộ phận không có trong danh mục thay vì lặp lại câu cũ", async () => {
    const { step, dbPath } = makeStep(
      `data/test-unrecognized-dept-${Date.now()}-${process.pid}.db`,
    );
    const chatId = "chat_unrec_dept_test";
    const r1 = (await step.handler({
      chatId,
      message:
        "Em chào anh, Zalo PC em bị đơ không gửi được tin cho khách. Em bên bộ phận Kế toán ạ.",
    })) as any;
    expect(r1.action).toBe("ask_missing_field");
    expect(r1.missingFields).toContain("reporting_dept");
    // Câu hỏi phải nói rõ lý do, không lặp câu cũ
    expect(r1.voiceText).toContain("Kế toán");
    expect(r1.voiceText).toContain("không có trong danh mục");
    fs.unlinkSync(dbPath);
  });
});
