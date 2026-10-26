import { describe, expect, test } from "bun:test";
import {
  appendTicketUpdateDescription,
  buildAdviceComment,
  formatConfirmationMessage,
  formatTicketDescription,
  quoteForPreview,
} from "./ticket-formatter";
import type { IncidentDetails, ReporterInfo } from "./types";

describe("bản ghi vàng định dạng ticket Tiểu Linh (PR 14: byte-identical parity)", () => {
  const incident: IncidentDetails = {
    title: "[LiveClass] Phòng ROOM-5511 lỗi 502",
    product: "LiveClass",
    category: "LiveClass",
    environment: "Production",
    priority: "high",
    roomCode: "ROOM-5511",
    studentAccount: "0900000005",
    rawText: "Vào phòng ROOM-5511 báo lỗi 502, SĐT phụ huynh 0900000005",
    imageUrls: [],
    deviceType: "iPad",
    deviceOs: "iPadOS 17",
    appVersion: "2.4.1",
    reportingDept: "Vận hành",
  };

  const reporter: ReporterInfo = {
    name: "Nguyễn Văn A (CS01)",
    username: "user_a",
    telegramId: 123456,
  };

  test("formatConfirmationMessage: byte-identical với bản ghi vàng", () => {
    const confirmation = formatConfirmationMessage({
      issueIdentifier: "TECH-100",
      issueUrl: "https://x/100",
      incident,
      missingSoftFields: ["mã giao dịch"],
    });

    const expected = [
      "Đã tạo ticket TECH-100",
      "",
      "- Tiêu đề: [LiveClass] Phòng ROOM-5511 lỗi 502",
      "- Sản phẩm: LiveClass",
      "- Tài khoản HS / SĐT: 0900000005",
      "- Bộ phận: Vận hành",
      "- Phân loại lỗi: LiveClass",
      "- Ưu tiên: High",
      "",
      "Anh/chị cho em xin thêm mã giao dịch với ạ.",
    ].join("\n");

    expect(confirmation).toBe(expected);
  });

  test("buildAdviceComment: byte-identical với bản ghi vàng", () => {
    const comment = buildAdviceComment("Triệu chứng khớp nhóm", "- Bước 1\n- Bước 2");

    const expected = [
      "**Gợi ý chuyên môn & nguyên nhân đã biết**",
      "",
      "- Bước 1",
      "- Bước 2",
    ].join("\n");

    expect(comment).toBe(expected);
  });

  test("quoteForPreview: escape Markdown và bọc blockquote byte-identical", () => {
    const quoted = quoteForPreview("lỗi *đậm* _nghiêng_ [link](x)");
    expect(quoted).toBe("> lỗi \\*đậm\\* \\_nghiêng\\_ \\[link\\]\\(x\\)");
  });

  test("formatTicketDescription: bố cục Markdown và metadata block đúng chuẩn TMS Vuihoc", () => {
    const description = formatTicketDescription({
      incident,
      reporter,
      sourceName: "ticket-intake",
    });

    expect(description).toContain("## Thông tin sự cố\n\n");
    expect(description).toContain("- Người báo: Nguyễn Văn A (CS01) (@user_a) - 123456\n");
    expect(description).toContain("- Sản phẩm: LiveClass\n");
    expect(description).toContain("- Tài khoản HS / SĐT: 0900000005\n");
    expect(description).toContain("- Bộ phận: Vận hành\n");
    expect(description).toContain("- Phòng học / Lớp: ROOM-5511\n");
    expect(description).toContain("- Thiết bị: iPad\n");
    expect(description).toContain("- Hệ điều hành: iPadOS 17\n");
    expect(description).toContain("- Phiên bản app: 2.4.1\n");
    expect(description).toContain(
      "### Mô tả\n\n> Vào phòng ROOM-5511 báo lỗi 502, SĐT phụ huynh 0900000005\n",
    );
    expect(description).toContain("<!-- vuihoc-meta:");
    expect(description).toContain("*Nguồn: ticket-intake (Telegram) · ");
  });

  test("appendTicketUpdateDescription: nối mục Bổ sung và cập nhật metadata đúng chuẩn", () => {
    const initial = [
      "## Thông tin sự cố",
      "",
      "- Người báo: Nguyễn Văn A",
      "- Sản phẩm: LiveClass",
      "- Phòng học / Lớp: ROOM-5511",
      "",
      "### Mô tả",
      "",
      "> Lỗi 502",
      "",
      "---",
      "",
      "*Nguồn: ticket-intake*",
      "",
      '<!-- vuihoc-meta: {"product":"LiveClass","roomCode":"ROOM-5511"} -->',
    ].join("\n");

    const updated = appendTicketUpdateDescription(initial, {
      additionalNotes: "Đã thử đổi mạng",
      studentAccount: "0900000008",
      device: "PC",
      timestamp: "2026-03-14 10:00",
    });

    expect(updated).toContain("- Tài khoản HS / SĐT: 0900000008\n");
    expect(updated).toContain("- Thiết bị: PC\n");
    expect(updated).toContain("### ➕ Bổ sung\n\n");
    expect(updated).toContain("- **2026-03-14 10:00:** Đã thử đổi mạng\n");
    expect(updated).toContain("- **2026-03-14 10:00 · Tài khoản HS / SĐT:** 0900000008\n");
    expect(updated).toContain("- **2026-03-14 10:00 · Thiết bị:** PC\n");
    expect(updated).toContain(
      '<!-- vuihoc-meta: {"product":"LiveClass","roomCode":"ROOM-5511","studentAccount":"0900000008","deviceType":"PC"} -->',
    );
  });
});
