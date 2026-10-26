import { describe, expect, it } from "bun:test";
import { mergeExtractedFields, newLinesOnly } from "./merger";
import type { IntakeDocument } from "../intake-document/types";

/**
 * "### Mô tả" của ticket là lời kể của người báo (ADR-0010) — và phải hiện MỘT
 * lần. Lượt xác nhận, agent (OpenClaw) đôi khi truyền lại chính tin người báo
 * vừa gửi; nếu gộp thêm, mô tả ticket hiện nội dung hai lần:
 *   - TECH-1307 (20/10): tin xác nhận lệch MỘT dấu cách so với tin đầu.
 *   - TECH-1201 (09/10): tin chứa lại tin đầu kèm nhãn nút "Sự cố mới".
 *   - TECH-1277 (17/10): tin trả lời nhắc lại tên/mã đã có, in đậm.
 *   - TECH-1141 (06/10): token nội bộ "noop" lọt vào mô tả.
 *
 * Dữ liệu trong test là giả (repo công khai: không số điện thoại, email, tên
 * thật của khách hàng) nhưng giữ nguyên HÌNH của các ca đo được.
 */
const doc = (rawText?: string): IntakeDocument => ({
  docId: "d",
  chatId: "c",
  revision: 1,
  status: "collecting",
  currentTurn: 1,
  fields: rawText
    ? { rawText: { value: rawText, source: "user_message", turn: 1, updatedAt: "" } }
    : {},
  evidence: {},
  askedCount: {},
  similarTickets: [],
  createdAt: "",
  updatedAt: "",
});

const extracted = (symptoms: string[]) => ({
  userIntent: "provide_info" as const,
  symptoms,
});

describe("rawText: lời kể của người báo không hiện lặp", () => {
  it("tin xác nhận lặp lại tin đầu (lệch một dấu cách) thì không gộp thêm", () => {
    const first =
      "Không đăng nhập được Gmail trường . ID: **hocsinh01@truong.edu.vn****  MK: MatKhau01@**";
    const again =
      "Không đăng nhập được Gmail trường . ID: **hocsinh01@truong.edu.vn****   MK: MatKhau01@**";
    const merged = mergeExtractedFields(
      doc(first),
      extracted(["Không đăng nhập được Gmail trường"]),
      2,
      again,
    );
    expect(merged.fields.rawText?.value).toBe(first);
  });

  it("nhãn nút của bot và tin đã có thì chỉ giữ phần mới", () => {
    const merged = mergeExtractedFields(
      doc("0900000017\nTiểu Linh ơi c không lên đơn được, báo fix giúp"),
      extracted(["Không lên được đơn trên CRM"]),
      2,
      "0900000017\nTiểu Linh ơi c không lên đơn được, báo fix giúp\nSự cố mới\n0900000017\nTiểu Linh ơi c không lên đơn được, báo fix giúp\nQuản lý lớp",
    );
    expect(merged.fields.rawText?.value).toBe(
      "0900000017\nTiểu Linh ơi c không lên đơn được, báo fix giúp\nQuản lý lớp",
    );
  });

  it("token nội bộ (noop) không lọt vào lời kể", () => {
    const merged = mergeExtractedFields(
      doc("Lỗi crm báo lỗi kết nối"),
      extracted(["CRM báo lỗi kết nối"]),
      2,
      "Lỗi crm báo lỗi kết nối\nnoop",
    );
    expect(merged.fields.rawText?.value).toBe("Lỗi crm báo lỗi kết nối");
  });

  it("tin trả lời nhắc lại thông tin đã có thì không lặp, phần mới thì vẫn vào", () => {
    const merged = mergeExtractedFields(
      doc(
        "Nguyễn Văn An\nCode: 70000001\nMã học sinh: 70000002\ncó 3 line chỉ chuyển phí được 1 line",
      ),
      extracted(["Mã khách hàng 70000001"]),
      2,
      "**Nguyễn Văn An**\nCode: 70000001\nMã học sinh: 70000002\nCARE_Vuihoc",
    );
    expect(merged.fields.rawText?.value).toBe(
      "Nguyễn Văn An\nCode: 70000001\nMã học sinh: 70000002\ncó 3 line chỉ chuyển phí được 1 line\nCARE_Vuihoc",
    );
  });

  it("tin mới thì ghi đủ, không mất dòng nào", () => {
    const merged = mergeExtractedFields(
      doc("không vào được lớp"),
      extracted(["Không vào được lớp"]),
      2,
      "không vào được lớp\nmàn hình trắng\nthử lại vẫn lỗi",
    );
    expect(merged.fields.rawText?.value).toBe(
      "không vào được lớp\nmàn hình trắng\nthử lại vẫn lỗi",
    );
  });

  it("agent gõ lại lệch một chữ thì không lặp (khối tóm tắt của bot)", () => {
    const first = "• Hệ thống: CARE_Vuihoc · Phân loại: Lỗi kỹ thuật · Bộ phận: Quản lý lớp";
    const typedAgain = "• Hệ thống: CARE_Vuihoc · Phân E loại: Lỗi kỹ thuật · Bộ phận: Quản lý lớp";
    const merged = mergeExtractedFields(
      doc(first),
      extracted(["Phân loại lỗi kỹ thuật"]),
      2,
      typedAgain,
    );
    expect(merged.fields.rawText?.value).toBe(first);
  });

  it("hai sự cố khác nhau dù lệch ít chữ vẫn phải giữ cả hai", () => {
    const merged = mergeExtractedFields(
      doc("Học sinh không vào được lớp 5 buổi tối thứ Hai"),
      extracted(["Không vào được lớp 5"]),
      2,
      "Học sinh không vào được lớp 6 buổi tối thứ Hai",
    );
    expect(merged.fields.rawText?.value).toBe(
      "Học sinh không vào được lớp 5 buổi tối thứ Hai\nHọc sinh không vào được lớp 6 buổi tối thứ Hai",
    );
  });

  it("câu khác nghĩa (buổi tối vs buổi sáng) thì không gộp", () => {
    const merged = mergeExtractedFields(
      doc("Học sinh không vào được lớp học buổi tối thứ Hai"),
      extracted(["Không vào được lớp buổi tối"]),
      2,
      "Học sinh không vào được lớp học buổi sáng thứ Hai",
    );
    expect(merged.fields.rawText?.value).toBe(
      "Học sinh không vào được lớp học buổi tối thứ Hai\nHọc sinh không vào được lớp học buổi sáng thứ Hai",
    );
  });
});

describe("newLinesOnly", () => {
  it("bỏ dòng lặp, bỏ dấu markdown và bỏ nhãn nút", () => {
    expect(newLinesOnly("**Nguyễn Văn An**\nSự cố mới\nCARE_Vuihoc", "Nguyễn Văn An")).toBe(
      "CARE_Vuihoc",
    );
  });

  it("giữ ngắt đoạn giữa các dòng mới", () => {
    expect(newLinesOnly("dòng 1\n\ndòng 2", "")).toBe("dòng 1\n\ndòng 2");
  });
});
