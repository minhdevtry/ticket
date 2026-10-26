import { describe, expect, test } from "bun:test";
import { ticketDomain } from "./domain";
import { symptomsOfDescription } from "./ticket-formatter";

/**
 * Hồi quy do TECH-1084 gây ra. `rawText` được thêm vào để mô tả ticket là lời
 * NGUYÊN VĂN của người báo.
 */
describe("rawText: không được hy sinh thông tin định danh hay văn bản tra cứu", () => {
  function build(over: Record<string, unknown> = {}) {
    return ticketDomain.build({
      reporterName: "Nguyễn Văn A",
      reporterUsername: "user_a",
      reporterNameCode: "CS01",
      title: "[LiveClass] Phòng ROOM-5511 lỗi 502",
      description: "Học sinh Nguyễn Văn A ở phòng ROOM-5511 báo lỗi 502, SĐT phụ huynh 0900000005",
      hasSpecificSubject: true,
      category: "LiveClass",
      priority: "medium",
      symptoms: [],
      ...over,
    } as Parameters<typeof ticketDomain.build>[0]);
  }

  test("SĐT người báo nói ở lượt trước không bị xoá vì tin vừa gửi không nhắc lại", () => {
    const built = build({
      // Tin vừa gửi không nhắc SĐT — người báo đã nói ở tin trước.
      rawText: "phòng học vẫn lỗi ạ, anh kiểm tra giúp em",
      studentId: "0900000005",
    });
    expect(built.description).toContain("Tài khoản HS / SĐT: 0900000005");
  });

  test("văn bản tra cứu lấy từ lời nguyên văn, không phải từ tóm tắt của model", () => {
    const built = build({
      // Toàn bộ lượt tròi chuyện, mỗi lượt một dòng — đúng như mô tả zod yêu cầu.
      rawText: "học sinh Nguyễn Văn A phòng ROOM-5511 báo lỗi 502\nvẫn lỗi ạ, anh kiểm tra giúp em",
    });
    const symptoms = symptomsOfDescription(built.description);
    expect(symptoms).toMatch(/ROOM-5511/);
    expect(symptoms).toMatch(/Nguyễn Văn A|502/);
  });

  test("khi không có rawText thì đối chiếu vẫn dùng description làm chuẩn", () => {
    const built = build({ rawText: undefined, studentId: "0900000005" });
    expect(built.description).toContain("Tài khoản HS / SĐT: 0900000005");
  });

  test("đoán hệ thống / phân loại lỗi đọc cả rawText, không chỉ description", () => {
    const built = ticketDomain.build({
      reporterName: "Nguyễn Văn A",
      reporterUsername: "user_a",
      reporterNameCode: "CS01",
      title: "Lỗi không xác định",
      description: "Sự cố tài khoản.",
      rawText: "bị trùng tài khoản học, không lên được đơn trên CRM ạ",
      hasSpecificSubject: false,
      priority: "medium",
      symptoms: [],
    } as Parameters<typeof ticketDomain.build>[0]);
    expect(built.system).toBe("CRM_Vuihoc");
    expect(built.errorCategory).toBe("Lỗi dữ liệu");
  });

  test("moi SĐT từ tin nguyên văn khi tóm tắt của model không có số", () => {
    const built = ticketDomain.build({
      reporterName: "Nguyễn Văn A",
      reporterUsername: "user_a",
      reporterNameCode: "CS01",
      title: "Không vào được lớp",
      description: "Học sinh không vào được lớp.",
      rawText: "mẹ bé Bo không vào được lớp, số 0900000005 ạ",
      hasSpecificSubject: true,
      priority: "medium",
      symptoms: [],
    } as Parameters<typeof ticketDomain.build>[0]);
    expect(built.description).toContain("Tài khoản HS / SĐT: 0900000005");
  });
});
