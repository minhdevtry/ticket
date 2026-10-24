import { describe, expect, test } from "bun:test";
import { resolveFriendlyStatusName, tryResolveFriendlyStatusName } from "./status";

// Ported from intake `lib/itsaplan/status.test.ts`.
describe("resolveFriendlyStatusName", () => {
  test("chuyển sang tiếng Việt, hỗ trợ Resolved", () => {
    expect(resolveFriendlyStatusName("Backlog", "backlog")).toBe("Mới tiếp nhận");
    expect(resolveFriendlyStatusName("Todo", "unstarted")).toBe("Chờ xử lý");
    expect(resolveFriendlyStatusName("In Progress", "started")).toBe("Đang xử lý");
    expect(resolveFriendlyStatusName("Resolved", "resolved")).toBe("Đã xử lý (chờ duyệt)");
    expect(resolveFriendlyStatusName("Xử lý xong", "")).toBe("Đã xử lý (chờ duyệt)");
    expect(resolveFriendlyStatusName("Done", "completed")).toBe("Hoàn tất");
    expect(resolveFriendlyStatusName("Canceled", "canceled")).toBe("Đã hủy");
  });
});

describe("tryResolveFriendlyStatusName (CM truthful variant)", () => {
  test("khớp mẫu → chuỗi; không khớp → null (không đoán)", () => {
    expect(tryResolveFriendlyStatusName("Done", "completed")).toBe("Hoàn tất");
    expect(tryResolveFriendlyStatusName("Một cột lạ", "")).toBeNull();
    expect(tryResolveFriendlyStatusName("", "")).toBeNull();
    // resolveFriendlyStatusName vẫn trả nguyên tên cột lạ (hợp đồng intake).
    expect(resolveFriendlyStatusName("Một cột lạ", "")).toBe("Một cột lạ");
  });
});
