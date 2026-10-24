import { describe, expect, test } from "bun:test";
import { validateOne, type ValidationRules } from "../shared/index";
import rules from "./domain/validation-rules.json";

const check = (field: string, value: string) =>
  validateOne(rules as ValidationRules, field, value);

describe("validate_fields", () => {
  test("mã người liên quan để chung chung, không gán là mã KH", () => {
    // Người báo không nói rõ là khách hàng, phụ huynh hay học sinh thì đừng đoán.
    expect(check("subject_code", "HS2039").valid).toBe(true);
    expect(check("subject_code", "KH001").valid).toBe(true);
    expect(check("subject_code", "889201").valid).toBe(true);
    expect(rules.subject_code.description).toContain("KHÔNG tự suy ra");
  });

  test("mã sai định dạng thì báo, nhưng không dump ghi chú nội bộ cho model", () => {
    const v = check("name_code", "cs_user_a");
    expect(v.valid).toBe(false);
    expect(v.reason).toBe("Sai định dạng");
    expect(v.expectedPattern).toBeTruthy();
    // Ghi chú trong bảng là cho người bảo trì đọc, đưa ra chỉ làm nhiễu ngữ cảnh.
    expect(v.reason).not.toContain("schema mới");
  });

  test("enum chuẩn hoá về đúng chính tả trong bảng", () => {
    expect(check("device_type", "điện thoại").normalized).toBe("Điện thoại");
    expect(check("device_type", "  PC  ").normalized).toBe("PC");
  });

  test("enum sai thì trả kèm danh sách cho phép", () => {
    const v = check("urgency", "Khẩn");
    expect(v.valid).toBe(false);
    expect(v.allowedValues).toContain("Urgent");
  });

  test("chặn giá trị rác", () => {
    for (const garbageValue of ["test", "n/a", "."]) {
      expect(check("device_os", garbageValue).valid).toBe(false);
    }
    expect(check("device_os", "Android 14").valid).toBe(true);
  });

  test("trường không có luật thì cho qua, không chặn bừa", () => {
    expect(check("khong_co_luat", "gì đó").valid).toBe(true);
  });

  test("để trống là không hợp lệ", () => {
    expect(check("device_type", "   ").valid).toBe(false);
  });
});
