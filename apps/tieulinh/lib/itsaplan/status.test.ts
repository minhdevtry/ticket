import { describe, expect, test } from "bun:test";
import { resolveFriendlyStatusName } from "./status";

describe("resolveFriendlyStatusName", () => {
  test("chuyển đổi chuẩn xác sang tiếng Việt thuần túy, không icon, hỗ trợ Resolved", () => {
    expect(resolveFriendlyStatusName("Backlog", "backlog")).toBe("Mới tiếp nhận");
    expect(resolveFriendlyStatusName("Todo", "unstarted")).toBe("Chờ xử lý");
    expect(resolveFriendlyStatusName("In Progress", "started")).toBe("Đang xử lý");
    expect(resolveFriendlyStatusName("Resolved", "resolved")).toBe("Đã xử lý (chờ duyệt)");
    expect(resolveFriendlyStatusName("Xử lý xong", "")).toBe("Đã xử lý (chờ duyệt)");
    expect(resolveFriendlyStatusName("Done", "completed")).toBe("Hoàn tất");
    expect(resolveFriendlyStatusName("Canceled", "canceled")).toBe("Đã hủy");
  });
});
