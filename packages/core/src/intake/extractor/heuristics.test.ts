import { describe, expect, it } from "bun:test";
import { isPersonNameOnly, isInvalidTitle, deriveFallbackTitle } from "./heuristics";

describe("W29-SPLIT Vòng 2 — Đơn vị: tên người, chốt tiêu đề, định danh có nhãn, tách khối", () => {
  it("chỉ coi là tên người khi từ ĐẦU là họ Việt và mọi từ viết hoa Unicode thật", () => {
    expect(isPersonNameOnly("Trần Thị B")).toBe(true);
    expect(isPersonNameOnly("Lê Văn Anh C")).toBe(true);
    expect(isPersonNameOnly("Nguyễn Văn P")).toBe(true);
    expect(isPersonNameOnly("Nguyễn Văn Anh D")).toBe(true);

    // Bug 1 + Bug 2 của REVIEW.md §4: chữ thường có dấu KHÔNG phải chữ hoa, và
    // cụm Title-Case không có họ người Việt thì không phải tên người.
    expect(isPersonNameOnly("Sale ạ")).toBe(false);
    expect(isPersonNameOnly("Zalo PC ạ")).toBe(false);
    expect(isPersonNameOnly("MỨC ĐỘ CAO")).toBe(false);
    expect(isPersonNameOnly("Đổi Lịch Học")).toBe(false);
    expect(isPersonNameOnly("Đồng Bộ Dữ Liệu")).toBe(false);
    expect(isPersonNameOnly("Không hiển thị bài tập ngày 13/10")).toBe(false);
    expect(isPersonNameOnly("Code: 9100002")).toBe(false);
  });

  it("chốt tiêu đề: nhận 8 tiêu đề Title-Case, từ chối tên người / mã trần / lời chào", () => {
    for (const ok of [
      "Báo Cáo Buổi Học",
      "Đổi Lịch Học",
      "Chuyển Khóa Học",
      "Đồng Bộ Dữ Liệu",
      "Sai Số Buổi Học",
      "Lỗi Hiển Thị Bài Tập",
      "Không Vào Được App",
      "Mất Kết Nối Mạng",
    ]) {
      expect(isInvalidTitle(ok)).toBe(false);
    }

    expect(isInvalidTitle("Trần Thị B")).toBe(true);
    expect(isInvalidTitle("9100002")).toBe(true);
    expect(isInvalidTitle("Code: 9100003")).toBe(true);
    expect(isInvalidTitle("Hỗ trợ em với ạ")).toBe(true);
    // Có ngữ cảnh: chỉ từ chối khi tên đó thật sự là một dòng tên trong báo cáo
    const report = "**Lê Văn Anh C**\nCode: 9100002\nHS bị lỗi buổi học";
    expect(isInvalidTitle("Lê Văn Anh C", report)).toBe(true);
    expect(isInvalidTitle("Trần Thị B", report)).toBe(false);
  });

  it("deriveFallbackTitle lấy dòng mô tả lỗi, không lấy tên học sinh (TECH-1146)", () => {
    const textMaiKhanhChi = `**Trần Thị B**
Code: 9100003
Mã học sinh: 90106

HS trước đó có 2 khóa học 48 buổi và 24 buổi đã học hết. Nay mua thêm gói 48 buổi là 120 buổi.
=> Số buổi đúng phải là 72/120 buổi nhưng hệ thống đang hiển thị là 0/96 buổi. Nhờ tech sửa lại giúp e ạ`;

    const title = deriveFallbackTitle(textMaiKhanhChi);
    expect(title).not.toContain("Trần Thị B");
    expect(title).toContain("Số buổi đúng phải là 72/120");
  });
});
