import { describe, expect, it } from "bun:test";
import { extractQuotedErrors, quoteGate } from "./quote-gate";

describe("extractQuotedErrors", () => {
  it("trích câu trong ngoặc kép (>= 10 ký tự)", () => {
    const out = extractQuotedErrors('Hệ thống báo: "Số buổi học chuyển phí đang không đúng, vui lòng thử lại"');
    expect(out).toEqual(["Số buổi học chuyển phí đang không đúng, vui lòng thử lại"]);
  });

  it("bỏ câu quá ngắn (< 10 ký tự), gộp nhiều đoạn văn bản", () => {
    const out = extractQuotedErrors('Lỗi "ok"', 'Ticket cũ báo "Không thể tạo đơn do trùng tài khoản học sinh"');
    expect(out).toEqual(["Không thể tạo đơn do trùng tài khoản học sinh"]);
  });

  it("không có ngoặc kép nào -> rỗng", () => {
    expect(extractQuotedErrors("Không có báo lỗi gì cả", undefined, null)).toEqual([]);
  });
});

describe("quoteGate", () => {
  it("thiếu quote ở 1 trong 2 bên -> none (không đủ bằng chứng)", () => {
    expect(quoteGate([], ["Không thể tạo đơn do trùng tài khoản học sinh"])).toBe("none");
    expect(quoteGate(["Không thể tạo đơn do trùng tài khoản học sinh"], [])).toBe("none");
  });

  it("quote giống nhau (chỉ khác số liệu/tên) -> match, thắng cả khi LLM nói khác", () => {
    const gate = quoteGate(
      ['Không thể tạo đơn do trùng tài khoản học sinh Nguyễn Văn A'],
      ['Không thể tạo đơn do trùng tài khoản học sinh Trần Thị B'],
    );
    expect(gate).toBe("match");
  });

  it("quote khác hẳn nội dung/cấu trúc -> conflict, từ chối dù LLM nói true", () => {
    const gate = quoteGate(
      ["Không thể tạo đơn do trùng tài khoản học sinh"],
      ["Số buổi học chuyển phí đang không đúng, vui lòng thử lại"],
    );
    expect(gate).toBe("conflict");
  });
});
