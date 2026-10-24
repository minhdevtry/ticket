import { describe, expect, test } from "bun:test";
import { describeState, stateMessageFor } from "./state-messages";

describe("lời báo trạng thái theo dự án (PO — PO 01/10)", () => {
  test("cột PO có lời giải thích, tên cột không phân biệt hoa thường/dấu cách", () => {
    expect(describeState("PO", "Discussion")).toBe("Discussion (PO nhặt ticket và bắt đầu trao đổi cùng các bên)");
    expect(describeState("po", "PO Inprogress")).toBe("PO inprogress (PO bắt đầu làm giải pháp)");
    expect(describeState("PO", "PO  Done")).toBe("PO done (đã làm xong giải pháp)");
    expect(describeState("PO", "Sent to dev")).toBe("Sent to dev (đã gửi ticket sang Tech team)");
    expect(describeState("PO", "Dev inprogress")).toBe("Dev inprogress (đang bắt đầu phát triển)");
    expect(describeState("PO", "Golive")).toBe("Golive (tính năng đã golive)");
    expect(describeState("PO", "Backlog")).toBe("Backlog (tính năng mới được order)");
    expect(describeState("PO", "Canceled")).toBe("Cancelled (yêu cầu đã được huỷ)");
  });

  test("dự án khác (TECH) hoặc cột lạ → null, giữ cách báo cũ", () => {
    expect(stateMessageFor("TECH", "Discussion")).toBeNull();
    expect(stateMessageFor("PO", "Cột lạ")).toBeNull();
    expect(stateMessageFor(undefined, "Golive")).toBeNull();
  });
});
