import { describe, expect, test } from "bun:test";
import {
  identifiersConflict,
  isGroundedInDigits,
  normalizeDigits,
  recoverAccountFromText,
  identityConflict,
  extractBlockInfo,
} from "./identifiers";

describe("normalizeDigits", () => {
  test("giữ lại đúng chữ số, bỏ khoảng trắng/dấu chấm/gạch ngang", () => {
    expect(normalizeDigits("0900 000 003")).toBe("0900000003");
    expect(normalizeDigits("0900.000.003")).toBe("0900000003");
    expect(normalizeDigits("0900-000-003")).toBe("0900000003");
  });
});

describe("isGroundedInDigits", () => {
  test("giá trị có chữ số nằm trong nguồn thì grounded", () => {
    expect(isGroundedInDigits("0900000003", normalizeDigits("... 0900000003 ..."))).toBe(true);
  });

  test("giá trị toàn chữ (không có chữ số) coi như grounded — không đối chiếu được bằng số", () => {
    expect(isGroundedInDigits("KH-ABC", normalizeDigits("không có mã nào ở đây"))).toBe(true);
  });

  test("giá trị không nằm trong nguồn thì KHÔNG grounded", () => {
    expect(
      isGroundedInDigits("0900000004", normalizeDigits("90000003 - 0900000003 DH900003")),
    ).toBe(false);
  });
});

describe("recoverAccountFromText", () => {
  test("moi lại đúng SĐT thật trong lời kể", () => {
    expect(recoverAccountFromText("90000003 - 0900000003 DH900003 UID: 900017")).toBe("0900000003");
  });

  test("không có số nào hợp lệ thì trả về undefined", () => {
    expect(recoverAccountFromText("Đơn hàng bị lỗi, cần kiểm tra gấp")).toBeUndefined();
  });
});

describe("identifiersConflict", () => {
  test("hai SĐT thật sự khác nhau (khác sự cố) → xung đột", () => {
    expect(identifiersConflict("0900000003", "0900000004")).toBe(true);
  });

  test("cùng một SĐT nhưng gõ có khoảng trắng/dấu chấm khác nhau → KHÔNG xung đột", () => {
    expect(identifiersConflict("0900000003", "0900 000 003")).toBe(false);
    expect(identifiersConflict("0900.000.003", "0900000003")).toBe(false);
    expect(identifiersConflict("0900-000-003", "0900000003")).toBe(false);
  });

  test("một bên là tập con chữ số của bên kia (vd gõ thiếu số 0 đầu) → KHÔNG xung đột", () => {
    expect(identifiersConflict("0900000005", "900000005")).toBe(false);
  });

  test("một bên không có chữ số (mã toàn chữ) → không đối chiếu được, KHÔNG coi là xung đột", () => {
    expect(identifiersConflict("KH-ABC", "0900000003")).toBe(false);
  });

  test("giá trị giống hệt nhau → không xung đột", () => {
    expect(identifiersConflict("ROOM-5511", "ROOM-5511")).toBe(false);
  });
});

describe("multi-incident identifiers and conflict", () => {
  test("extractBlockInfo bỏ qua tham số URL, SĐT, TK/MK, mã phiếu thu; chỉ lấy định danh có nhãn", () => {
    // FP-06: cid=… trong link LMS không phải Mã khách hàng
    expect(
      extractBlockInfo("- Link: https://se-lms.example.com/module/lms/index?cid=670&id=90107")
        .customerId,
    ).toBeUndefined();
    // FP-05: mã học sinh thật vẫn lấy được, nhưng TK/MK không bị bóc thành định danh
    expect(extractBlockInfo("Code: 90000007\nMã học sinh: 900102").studentAccount).toBe("900102");
    const loginBlock = extractBlockInfo("tài khoản:\nTK: 0900000009\nMK: 0900000009");
    expect(loginBlock.studentAccount).toBeUndefined();
    expect(loginBlock.customerId).toBeUndefined();
    // FP-10: mã phiếu thu (TNX…) không thành định danh
    expect(extractBlockInfo("mã phiếu thu: TNX0123456789").customerId).toBeUndefined();
    // Mã CRM 7-10 số đứng riêng một dòng (dữ liệu thật TECH-1248/1249)
    expect(extractBlockInfo("90000002\nBộ phận QLL\ncon không hiện bài tập").customerId).toBe(
      "90000002",
    );
  });

  test("identityConflict chỉ so CÙNG LỚP định danh, và chỉ khi cả hai bên đều có", () => {
    expect(identityConflict({ customer: "90000001" }, { customer: "90000002" })).toBe("customer");
    expect(identityConflict({ customer: "90000001" }, { customer: "90000001" })).toBeUndefined();
    // Giá trị tờ khai chưa từng có thì không phải xung đột
    expect(identityConflict({}, { customer: "90000002" })).toBeUndefined();
    // Khác lớp: mã học sinh vs SĐT vs mã khách hàng không đụng nhau (FP-05)
    expect(identityConflict({ student: "900102" }, { phone: "0900000009" })).toBeUndefined();
    expect(identityConflict({ customer: "90000007" }, { student: "900102" })).toBeUndefined();
  });
});
