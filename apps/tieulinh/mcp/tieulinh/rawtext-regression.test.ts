import { describe, expect, test } from "bun:test";
import { ticketDomain } from "./domain";
import { symptomsOfDescription } from "../../lib/kg/similar-finder";

/**
 * Hồi quy do TECH-1084 gây ra. `rawText` được thêm vào để mô tả ticket là lời
 * NGUYÊN VĂN của người báo — nhưng nó KHÔNG phải lời kể đầy đủ của cả cuộc hội
 * thoại, chỉ là tin nhắn vừa gửi. Hai hệ quả phải giữ được:
 *
 * 1. `groundIdentifierFields` đối chiếu định danh (SĐT, mã HS) với `rawText`.
 *    Nếu người báo nói SĐT ở lượt trước còn tin vừa gửi không nhắc lại, SĐT đó
 *    bị XOÁ khỏi ticket — mất thông tin tra cứu của người báo.
 * 2. `symptomsOfDescription` lấy "### Mô tả" làm văn bản tra cứu BM25. Nếu mô
 *    tả chỉ còn tin cuối, các từ khóa phân biệt (mã phòng, tên, môn, kỳ) biến
 *    mất → ticket cũ khó tra được.
 *
 * Cả hai đều đúng khi mọi sự cố đi qua `intake_step` (rawText gộp mọi lượt), và
 * hỏng khi LLM gọi `create_issue` và chỉ đưa tin vừa gửi.
 */
describe("rawText: không được hy sinh thông tin định danh hay văn bản tra cứu", () => {
  function build(over: Record<string, any> = {}) {
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
    } as any);
  }

  test("SĐT người báo nói ở lượt trước không bị xoá vì tin vừa gửi không nhắc lại", () => {
    const built = build({
      // Tin vừa gửi không nhắc SĐT — người báo đã nói ở tin trước.
      rawText: "phòng học vẫn lỗi ạ, anh kiểm tra giúp em",
      studentId: "0900000005",
    });
    expect(built.description).toContain("Tài khoản HS / SĐT: 0900000005");
  });

  // Mô tả hiển thị = `rawText` (nguyên văn). Nhưng `rawText` được yêu cầu phải
  // là TOÀN BỘ lượt tròi chuyện, nên khối "### Mô tả" vẫn giữ mã phòng / tên nói
  // ở lượt trước — đây cũng là văn bản nguồn cho BM25.
  test("văn bản tra cứu lấy từ lời nguyên văn, không phải từ tóm tắt của model", () => {
    const built = build({
      // Toàn bộ lượt tròi chuyện, mỗi lượt một dòng — đúng như mô tả zod yêu cầu.
      rawText: "học sinh Nguyễn Văn A phòng ROOM-5511 báo lỗi 502\nvẫn lỗi ạ, anh kiểm tra giúp em",
    });
    const symptoms = symptomsOfDescription(built.description);
    expect(symptoms).toMatch(/ROOM-5511/);
    expect(symptoms).toMatch(/Nguyễn Văn A|502/);
  });

  // Không có `rawText` thì mô tả rơi về `description` (bản viết lại) — nhưng
  // đối chiếu định danh vẫn phải giữ được SĐT, vì `reporterText` gộp cả hai.
  test("khi không có rawText thì đối chiếu vẫn dùng description làm chuẩn", () => {
    const built = build({ rawText: undefined, studentId: "0900000005" });
    expect(built.description).toContain("Tài khoản HS / SĐT: 0900000005");
  });

  // Sau khi tách `rawText`, các từ khoá phân loại nằm ở tin nguyên văn chứ không
  // còn ở `description` mà model viết tóm. Nếu heuristic không đọc `rawText`,
  // ticket rơi về "Khác" và mất nhãn — hỏng âm thầm so với trước khi tách.
  test("đoán hệ thống / phân loại lỗi đọc cả rawText, không chỉ description", () => {
    // Không set `category`/`system`/`errorCategory` — đúng tình huống model chỉ
    // gửi nguyên văn + tóm tắt, để heuristic tự đoán từ lời người báo.
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
    } as any);
    expect(built.system).toBe("CRM_Vuihoc");
    expect(built.errorCategory).toBe("Lỗi dữ liệu");
  });

  // Cùng mẫu: moi SĐT phải đọc lời người báo, không chỉ tóm tắt của model.
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
    } as any);
    expect(built.description).toContain("Tài khoản HS / SĐT: 0900000005");
  });
});
