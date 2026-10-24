import { describe, expect, test } from "bun:test";
import { extractAccounts, ticketDomain } from "./domain";

function build(over: Partial<Parameters<typeof ticketDomain.build>[0]> = {}) {
  return ticketDomain.build({
    reporterName: "Nguyễn Văn A",
    reporterUsername: "user_a",
    reporterNameCode: "CS01",
    title: "[LiveClass] ROOM-5511 lỗi 502",
    description: "Phòng học không vào được",
    hasSpecificSubject: false,
    category: "LiveClass",
    priority: "medium",
    symptoms: [],
    ...over,
  });
}

describe("ticketDomain.build", () => {
  test("danh tính người báo đi vào mô tả, không phải do model bịa", () => {
    // MCP không có requestContext, nên host cấp qua tham số reporter*.
    const built = build();
    expect(built.description).toContain("Nguyễn Văn A (CS01)");
    expect(built.description).toContain("@user_a");
  });

  test("sự cố của một người mà chưa có định danh thì hỏi thêm", () => {
    const built = build({ description: "Mẹ bé Bo không vào được lớp", hasSpecificSubject: true });
    expect(built.confirmation).toContain("số điện thoại phụ huynh hoặc tài khoản học sinh");
  });

  test("sự cố toàn hệ thống thì không hỏi định danh", () => {
    const built = build({ description: "Server trả 502 toàn hệ thống", hasSpecificSubject: false });
    expect(built.confirmation).not.toContain("cho em xin thêm");
  });

  test("số điện thoại nằm trong câu chữ thì tự moi ra, khỏi hỏi lại", () => {
    const built = build({
      description: "Mẹ bé Bo 0900000005 không vào được lớp",
      hasSpecificSubject: true,
    });
    expect(built.confirmation).not.toContain("cho em xin thêm");
    expect(built.description).toContain("0900000005");
  });

  test("chuỗi giữ chỗ để tool thay sau khi tracker cấp mã", () => {
    // Lúc build thì issue chưa tồn tại, điền mã cụ thể ở đây là bịa.
    expect(build().confirmation).toContain("{identifier}");
  });

  test('model điền "null" vào trường tuỳ chọn thì bỏ, không in ra cho người đọc', () => {
    const built = build({ roomId: "null", device: "undefined" });
    expect(built.description).not.toContain("Phòng học / Lớp");
    expect(built.description).not.toContain("Thiết bị");
  });

  // TECH-548 (đo thật 15/09/2026): model gọi create_issue với diagnosis chứa
  // "Số điện thoại liên hệ: 0900000019" thay vì truyền customerId/studentId.
  // SĐT lọt vào chỗ sai, cần tra cứu người báo.
  test("SĐT lẫn trong diagnosis thì vớt về Thông tin sự cố, không để lại trong mô tả", () => {
    const built = build({
      // Người báo có nhắc số này trong mô tả — vớt từ diagnosis về đúng ô,
      // chứ không phải model tự bịa một số không ai cung cấp (khác TECH-928).
      description: "Khi lên đơn không hiển thị địa chỉ, SĐT liên hệ 0900000019",
      diagnosis:
        "Khi lên đơn, khu vực góc phải không hiển thị địa chỉ và giá tiền.\n" +
        "Số điện thoại liên hệ: 0900000019.\n" +
        "Chưa xác định nguyên nhân.",
    });
    expect(built.description).toContain("Tài khoản HS / SĐT: 0900000019");
    // SĐT phải được cắt khỏi CHÍNH `diagnosis` — đây là giá trị được ghi ra
    // comment công khai của bot (create_issue → buildAdviceComment), nên phải
    // kiểm ở đây chứ không kiểm trong mô tả (mô tả vốn không chứa diagnosis).
    expect(built.diagnosis).not.toContain("0900000019");
    expect(built.diagnosis).toContain("góc phải không hiển thị địa chỉ");
  });

  // TECH-1084: `rawText` là NGUYÊN VĂN lời kể; `description` là bản model viết lại.
  test("rawText nguyên văn thắng description do model viết lại (TECH-1084)", () => {
    const built = build({
      rawText: "con bé không thấy bài kiểm tra ạ, em hỗ trợ chị với",
      description: "Học sinh Nguyễn Văn A báo không thấy bài kiểm tra. Cần đối chiếu dữ liệu lịch học.",
    });
    // Toàn bộ phần người đọc thấy phải là lời nguyên văn, không phải bản viết lại.
    expect(built.description).toContain("> con bé không thấy bài kiểm tra ạ, em hỗ trợ chị với");
    expect(built.description).not.toContain("Cần đối chiếu dữ liệu lịch học");
  });

  test("diagnosis của model không lọt vào mô tả ticket, mà được trả ra để ghi comment (TECH-1084)", () => {
    const built = build({ diagnosis: "Cần đối chiếu dữ liệu bài tập về nhà trên hệ thống Gia sư" });
    expect(built.description).not.toContain("Cần đối chiếu dữ liệu bài tập về nhà");
    expect(built.diagnosis).toBe("Cần đối chiếu dữ liệu bài tập về nhà trên hệ thống Gia sư");
  });

  test("SĐT truyền vào customerId thì chuyển thành SĐT, không in ra Mã khách hàng", () => {
    const built = build({
      customerId: "0900000020",
      description: "quản lý lớp đang check cts này gia sư bị chuyển sang duo, SĐT 0900000020",
    });
    expect(built.description).toContain("Tài khoản HS / SĐT: 0900000020");
    expect(built.description).not.toContain("Mã khách hàng: 0900000020");
    expect(built.confirmation).toContain("Tài khoản HS / SĐT: 0900000020");
    expect(built.confirmation).not.toContain("Mã khách hàng: 0900000020");
  });
});

describe("extractAccounts", () => {
  test("moi số điện thoại, mỗi số một lần", () => {
    expect(extractAccounts("SĐT 0900000005, gọi lại 0900000005")).toBe("0900000005");
  });
  test("mã phòng không phải tài khoản", () => {
    expect(extractAccounts("Phòng ROOM-5511 lỗi 502")).toBeUndefined();
  });
});
