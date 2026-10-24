import { describe, expect, test } from "bun:test";
import { buildOnyxDocumentBody, parseVuihocMeta } from "./document";

describe("parseVuihocMeta", () => {
  test("đọc lại khối JSON ẩn trong mô tả", () => {
    const description =
      "## Thông tin sự cố\n\n...\n\n" +
      '<!-- vuihoc-meta: {"system":"Duo","category":"Lỗi kỹ thuật","priority":"urgent"} -->';
    expect(parseVuihocMeta(description)).toEqual({
      system: "Duo",
      category: "Lỗi kỹ thuật",
      priority: "urgent",
    });
  });

  test("trả null khi mô tả không có khối meta", () => {
    expect(parseVuihocMeta("Mô tả không có gì đặc biệt")).toBeNull();
  });

  test("trả null khi khối meta không parse được", () => {
    expect(parseVuihocMeta("<!-- vuihoc-meta: {khong phai json} -->")).toBeNull();
  });
});

describe("buildOnyxDocumentBody", () => {
  test("dựng đúng khuôn mà bên tra cứu regex đang mong đợi", () => {
    const body = buildOnyxDocumentBody({
      identifier: "TECH-364",
      system: "TUTOR_Vuihoc",
      errorCategory: "Lỗi kỹ thuật",
      closedDate: "2026-08-26",
      symptom: "BTVN không hiển thị sau một mốc ngày",
      rootCause: "Bảng tutor_learning_history thiếu dữ liệu sau mốc ngày đó",
      resolution: "Insert bù dữ liệu còn thiếu vào bảng tutor_learning_history",
      prevention: "Theo dõi job đồng bộ định kỳ",
    });

    expect(body).toBe(
      [
        "TECH-364 · TUTOR_Vuihoc · Lỗi kỹ thuật · đóng 2026-08-26",
        "",
        "TRIỆU CHỨNG",
        "BTVN không hiển thị sau một mốc ngày",
        "",
        "NGUYÊN NHÂN",
        "Bảng tutor_learning_history thiếu dữ liệu sau mốc ngày đó",
        "",
        "CÁCH KHẮC PHỤC",
        "Insert bù dữ liệu còn thiếu vào bảng tutor_learning_history",
        "",
        "CÁCH PHÒNG TRÁNH",
        "Theo dõi job đồng bộ định kỳ",
      ].join("\n"),
    );

    // Khuôn phải khớp đúng các regex mà searchViaMcp dùng để cắt lại từng mục.
    expect(body).toMatch(/TECH-\d+\s*·\s*([^·\n]+)/);
    expect(body).toMatch(/·\s*([^·\n]+)\s*·\s*đóng\s*\d{4}/);
    expect(body).toMatch(
      /TRIỆU CHỨNG\s*\n([\s\S]*?)(?=\n[A-ZÀ-Ỹ\s]+:|\n---|\nPHẠM VI|\nNGUYÊN NHÂN|$)/,
    );
    expect(body).toMatch(/NGUYÊN NHÂN\s*\n([\s\S]*?)(?=\n[A-ZÀ-Ỹ\s]+:|\n---|\nCÁCH KHẮC PHỤC|$)/);
    expect(body).toMatch(
      /CÁCH KHẮC PHỤC\s*\n([\s\S]*?)(?=\n[A-ZÀ-Ỹ\s]+:|\n---|\nCÁCH PHÒNG TRÁNH|$)/,
    );
  });

  test("bỏ hẳn mục rỗng hoặc 'không rõ', không in dòng rỗng cho loãng vector", () => {
    const body = buildOnyxDocumentBody({
      identifier: "TECH-1",
      closedDate: "2026-09-17",
      symptom: "Lỗi 502",
      rootCause: "không rõ",
      resolution: "",
      prevention: undefined,
    });

    expect(body).not.toContain("NGUYÊN NHÂN");
    expect(body).not.toContain("CÁCH KHẮC PHỤC");
    expect(body).not.toContain("CÁCH PHÒNG TRÁNH");
    expect(body).toBe("TECH-1 · đóng 2026-09-17\n\nTRIỆU CHỨNG\nLỗi 502");
  });

  test("bỏ hệ thống/phân loại khỏi dòng đầu khi không có", () => {
    const body = buildOnyxDocumentBody({
      identifier: "TECH-2",
      closedDate: "2026-09-17",
      symptom: "Lỗi gì đó",
    });
    expect(body.split("\n")[0]).toBe("TECH-2 · đóng 2026-09-17");
  });
});
