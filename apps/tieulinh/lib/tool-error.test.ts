import { describe, expect, test } from "bun:test";
import { createIntakeMcpServer } from "../mcp/shared/server";
import { defineTool } from "../mcp/shared/tool";
import { describeToolFailure, newErrorCode } from "./tool-error";

describe("tool-error", () => {
  test("mã lỗi ngắn, viết hoa, và hai thời điểm khác nhau ra hai mã khác nhau", () => {
    const a = newErrorCode(1_757_000_000_000);
    const b = newErrorCode(1_757_000_000_001);
    expect(a).toMatch(/^[0-9A-Z]{6}$/);
    expect(a).not.toBe(b);
  });

  test("thông báo mang đủ mã lỗi, chi tiết và lời dặn chụp màn hình", () => {
    const failure = describeToolFailure(
      "create_issue",
      new Error("Itsaplan 503 Service Unavailable"),
    );
    expect(failure.loi).toBe(true);
    expect(failure.thong_bao_cho_nguoi_dung).toContain(failure.ma_loi);
    expect(failure.thong_bao_cho_nguoi_dung).toContain("Itsaplan 503 Service Unavailable");
    expect(failure.thong_bao_cho_nguoi_dung).toContain("chụp màn hình");
  });

  /** Stack dài thì người ta không đọc, và tin nhắn Telegram cũng có trần. */
  test("chi tiết dài bị cắt, không nhồi cả stack vào tin nhắn", () => {
    const failure = describeToolFailure("get_issue", new Error("x".repeat(2000)));
    expect(failure.chi_tiet.length).toBeLessThanOrEqual(301);
    expect(failure.chi_tiet.endsWith("…")).toBe(true);
  });

  /**
   * Cổng thật: tool ném lỗi thì host phải nhận kết quả bình thường mang cờ
   * `loi`, không phải một exception để model tự quyết định nói gì.
   */
  test("tool ném lỗi thì server trả kết quả có cờ loi, không ném lên host", async () => {
    const server = createIntakeMcpServer({
      name: "test",
      version: "0",
      tools: [
        defineTool({
          name: "no_op",
          description: "tool luôn hỏng",
          inputSchema: {},
          handler: () => {
            throw new Error("ổ cắm rút rồi");
          },
        }),
      ],
    });

    const registered = (server as any)._registeredTools?.no_op;
    expect(registered).toBeDefined();
    const res = await registered.handler({}, {});
    const payload = JSON.parse(res.content[0].text);
    expect(payload.loi).toBe(true);
    expect(payload.thong_bao_cho_nguoi_dung).toContain("ổ cắm rút rồi");
  });
});
