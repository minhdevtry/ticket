import { describe, expect, it } from "bun:test";
import { extractLabelledIdentifiers } from "./heuristics";
import { FieldExtractor } from "./llm-extractor";
import { type LegacyDraftDocument, mergeExtractedFields } from "./merger";
describe("FieldExtractor & Merger", () => {
  // TECH-1146: Số điện thoại 10 số (03/05/07/08/09) là tài khoản / SĐT phụ huynh, không phải mã KH
  it("trích xuất tĩnh và chuẩn hóa OOV thành công", async () => {
    const extractor = new FieldExtractor();
    const res = await extractor.extract("CRM bị lỗi 500 khi mở đơn hàng SĐT phụ huynh 0900000008");

    expect(res.userIntent).toBe("report_issue");
    expect(res.studentAccount).toBe("0900000008");
    expect(res.customerId).toBeUndefined(); // SĐT không được gán làm customerId
  });

  it("gộp trường bảo toàn dữ liệu cũ và tăng revision", () => {
    const initialDoc: LegacyDraftDocument = {
      docId: "doc_test",
      chatId: "chat_999",
      revision: 1,
      status: "collecting",
      currentTurn: 1,
      fields: {
        title: { value: "Lỗi app", source: "user_message", turn: 1, updatedAt: "" },
        product: { value: "Tutor", source: "user_message", turn: 1, updatedAt: "" },
        symptoms: {
          value: ["Không vào được phòng"],
          source: "user_message",
          turn: 1,
          updatedAt: "",
        },
      },
      evidence: {},
      askedCount: {},
      similarTickets: [],
      createdAt: "",
      updatedAt: "",
    };

    const merged = mergeExtractedFields(
      initialDoc,
      {
        userIntent: "provide_info",
        system: "ClassIn",
        reportingDept: "Quản lý lớp",
        symptoms: ["Không thấy nút mic"],
      },
      2,
      "Em dùng ClassIn bên QLL nhé",
    );

    expect(merged.revision).toBe(2);
    expect(merged.currentTurn).toBe(2);
    expect(merged.fields.product?.value).toBe("Tutor"); // Giữ nguyên từ turn 1
    expect(merged.fields.system?.value).toBe("ClassIn"); // Bổ sung ở turn 2
    expect(merged.fields.reportingDept?.value).toBe("Quản lý lớp");
    const symptoms = Array.isArray(merged.fields.symptoms?.value)
      ? (merged.fields.symptoms?.value as string[])
      : [];
    expect(symptoms).toContain("Không vào được phòng");
    expect(symptoms).toContain("Không thấy nút mic");
  });

  it("mã CRM: lấy mã đầu tiên thay vì mã sau khi có nhiều dòng mã CRM độc lập", () => {
    const ids = extractLabelledIdentifiers("1234567\n8901234");
    expect(ids.customer).toBe("1234567");
  });

  it("gộp triệu chứng: giữ 30 triệu chứng cuối khi vượt trần", () => {
    const initialDoc: LegacyDraftDocument = {
      docId: "doc_test",
      chatId: "chat_999",
      revision: 1,
      status: "collecting",
      currentTurn: 1,
      fields: {},
      evidence: {},
      createdAt: "",
      updatedAt: "",
    };
    const manySymptoms = Array.from({ length: 35 }, (_, i) => `Triệu chứng ${i + 1}`);
    const merged = mergeExtractedFields(
      initialDoc,
      { userIntent: "report_issue", symptoms: manySymptoms },
      1,
      "nhiều lỗi",
    );
    const symptoms = (merged.fields.symptoms?.value ?? []) as string[];
    expect(symptoms).toHaveLength(30);
    expect(symptoms[0]).toBe("Triệu chứng 6");
    expect(symptoms[29]).toBe("Triệu chứng 35");
  });

  it("gộp triệu chứng: dedup không hợp nhất phân biệt hoa thường", () => {
    const initialDoc: LegacyDraftDocument = {
      docId: "doc_test",
      chatId: "chat_999",
      revision: 1,
      status: "collecting",
      currentTurn: 1,
      fields: {
        symptoms: { value: ["Lỗi X"], source: "user_message", turn: 1, updatedAt: "" },
      },
      evidence: {},
      createdAt: "",
      updatedAt: "",
    };
    const merged = mergeExtractedFields(
      initialDoc,
      { userIntent: "provide_info", symptoms: ["lỗi x"] },
      2,
      "lỗi x",
    );
    const symptoms = (merged.fields.symptoms?.value ?? []) as string[];
    expect(symptoms).toEqual(["Lỗi X", "lỗi x"]);
  });

  it("gộp triệu chứng & rawText: loại bỏ token nội bộ như noop", () => {
    const initialDoc: LegacyDraftDocument = {
      docId: "doc_test",
      chatId: "chat_999",
      revision: 1,
      status: "collecting",
      currentTurn: 1,
      fields: {},
      evidence: {},
      createdAt: "",
      updatedAt: "",
    };
    const merged = mergeExtractedFields(
      initialDoc,
      { userIntent: "provide_info", symptoms: ["noop", "Lỗi thật"] },
      2,
      "noop",
    );
    const symptoms = (merged.fields.symptoms?.value ?? []) as string[];
    expect(symptoms).toEqual(["Lỗi thật"]);
    expect(merged.fields.rawText).toBeUndefined();
  });

  it("gộp trường: unrecognizedDept được ghi lại và xoá khi đã có reportingDept hợp lệ", () => {
    const initialDoc: LegacyDraftDocument = {
      docId: "doc_test",
      chatId: "chat_999",
      revision: 1,
      status: "collecting",
      currentTurn: 1,
      fields: {},
      evidence: {},
      createdAt: "",
      updatedAt: "",
    };
    const step1 = mergeExtractedFields(
      initialDoc,
      { userIntent: "provide_info", reportingDeptUnrecognized: "Kế toán" },
      2,
      "Em bên Kế toán",
    );
    expect(step1.unrecognizedDept).toBe("Kế toán");

    const step2 = mergeExtractedFields(
      step1,
      { userIntent: "provide_info", reportingDept: "Vận hành" },
      3,
      "Thực ra em bên Vận hành",
    );
    expect(step2.unrecognizedDept).toBeUndefined();
    expect(step2.fields.reportingDept?.value).toBe("Vận hành");
  });
});
