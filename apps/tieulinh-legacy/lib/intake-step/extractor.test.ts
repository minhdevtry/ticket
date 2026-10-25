import { describe, expect, it } from "bun:test";
import { FieldExtractor } from "./extractor";
import { mergeExtractedFields } from "./merger";
import type { IntakeDocument } from "../intake-document/types";

describe("FieldExtractor & Merger", () => {
  it("trích xuất tĩnh và chuẩn hóa OOV thành công", async () => {
    const extractor = new FieldExtractor();
    const res = await extractor.extract("CRM bị lỗi 500 khi mở đơn hàng SĐT phụ huynh 0900000008");

    expect(res.userIntent).toBe("report_issue");
    expect(res.studentAccount).toBe("0900000008");
    expect(res.customerId).toBeUndefined(); // SĐT không được gán làm customerId
  });

  it("gộp trường bảo toàn dữ liệu cũ và tăng revision", () => {
    const initialDoc: IntakeDocument = {
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
    expect(merged.fields.symptoms?.value).toContain("Không vào được phòng");
    expect(merged.fields.symptoms?.value).toContain("Không thấy nút mic");
  });
});
