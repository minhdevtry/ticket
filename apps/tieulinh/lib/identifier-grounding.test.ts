import { describe, expect, test } from "bun:test";
import {
  identifiersConflict,
  isGroundedInDigits,
  normalizeDigits,
  recoverAccountFromText,
} from "./identifier-grounding";

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
    expect(isGroundedInDigits("0900000004", normalizeDigits("90000003 - 0900000003 DH900003"))).toBe(false);
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

// TECH-928 phần 2 (28/09/2026): chốt "sự cố mới hay bổ sung" ở
// lib/intake-step/pipeline.ts dùng đúng hàm này để phát hiện xung đột.
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
