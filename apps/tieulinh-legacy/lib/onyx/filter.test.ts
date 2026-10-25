import { describe, expect, test } from "bun:test";
import {
  isTestTicket,
  isRawTooShort,
  hasKnowledge,
  containsPii,
  evaluatePreLlmFilter,
  evaluatePostLlmFilter,
} from "./filter";

describe("Onyx Ingestion Filter Gates", () => {
  describe("Cửa 1: isTestTicket", () => {
    test("detects various [TEST] patterns in title", () => {
      expect(isTestTicket("[TEST] Lỗi phòng học")).toBe(true);
      expect(isTestTicket("[TEST BOT] Test ticket")).toBe(true);
      expect(isTestTicket("BOT TEST: Báo sự cố ảo")).toBe(true);
      expect(isTestTicket("TEST không vào được app")).toBe(true);
      expect(isTestTicket("[test] thử nghiệm")).toBe(true);
    });

    test("passes legitimate tickets", () => {
      expect(isTestTicket("Lỗi phòng ROOM-5511 không có tiếng")).toBe(false);
      expect(isTestTicket("Học sinh không nộp được bài Contest")).toBe(false);
      expect(isTestTicket("Server 502 Bad Gateway")).toBe(false);
    });
  });

  describe("Cửa 2: isRawTooShort", () => {
    test("rejects raw material shorter than threshold", () => {
      expect(isRawTooShort("Ngắn quá")).toBe(true);
      expect(isRawTooShort("A".repeat(299), 300)).toBe(true);
    });

    test("passes raw material meeting or exceeding threshold", () => {
      expect(isRawTooShort("A".repeat(300), 300)).toBe(false);
      expect(isRawTooShort("A".repeat(500), 300)).toBe(false);
    });
  });

  describe("Cửa 3: hasKnowledge", () => {
    test("rejects when both root cause and resolution are unknown or vague", () => {
      expect(
        hasKnowledge({
          rootCause: "Chưa ghi nhận rõ nguyên nhân",
          resolution: "Chưa rõ",
        }),
      ).toBe(false);

      expect(
        hasKnowledge({
          rootCause: "Không rõ",
          resolution: "Chưa xác định",
        }),
      ).toBe(false);
    });

    test("accepts when root cause is clear", () => {
      expect(
        hasKnowledge({
          rootCause: "Xung đột websocket connection pool trên ingress pod",
          resolution: "Chưa rõ",
        }),
      ).toBe(true);
    });

    test("accepts when resolution is clear", () => {
      expect(
        hasKnowledge({
          rootCause: "Chưa rõ",
          resolution: "Khởi động lại cụm replica service LiveClass và dọn dẹp cache Redis",
        }),
      ).toBe(true);
    });
  });

  describe("Cửa 4: containsPii", () => {
    test("detects unredacted phone number", () => {
      expect(containsPii("Liên hệ phụ huynh 0900000005 để kiểm tra")).toBe(true);
    });

    test("detects student account password", () => {
      expect(containsPii("Học sinh đăng nhập với Pass: 90000008")).toBe(true);
    });

    test("passes clean technical text", () => {
      expect(
        containsPii(
          "Lỗi ROOM-5511 trả HTTP 502 do CPU server cán mốc 100%. Đã scale pod lên 5 replicas.",
        ),
      ).toBe(false);
    });
  });

  describe("evaluatePreLlmFilter & evaluatePostLlmFilter", () => {
    test("pre-filter blocks test ticket with clear reason", () => {
      const decision = evaluatePreLlmFilter({ title: "[TEST] Sự cố thử nghiệm" }, "A".repeat(400));
      expect(decision.pass).toBe(false);
      expect(decision.reason).toContain("thử nghiệm");
    });

    test("pre-filter blocks short ticket with clear reason", () => {
      const decision = evaluatePreLlmFilter({ title: "Lỗi thật" }, "Ngắn quá");
      expect(decision.pass).toBe(false);
      expect(decision.reason).toContain("< 300");
    });

    test("post-filter blocks document missing actionable knowledge", () => {
      const decision = evaluatePostLlmFilter(
        { rootCause: "Chưa rõ", resolution: "Không rõ" },
        "Bản tóm tắt sạch sẽ không có PII",
      );
      expect(decision.pass).toBe(false);
      expect(decision.reason).toContain("Không có tri thức rõ ràng");
    });

    test("post-filter blocks document containing leaked PII", () => {
      const decision = evaluatePostLlmFilter(
        { rootCause: "Lỗi tài khoản cụ thể", resolution: "Reset pass" },
        "Học sinh có Pass: 12345678",
      );
      expect(decision.pass).toBe(false);
      expect(decision.reason).toContain("PII");
    });

    test("passes clean, complete document", () => {
      const decision = evaluatePostLlmFilter(
        {
          rootCause: "Deadlock bảng tutor_learning_history",
          resolution: "Tạo index bổ sung cho user_id và created_at",
        },
        "Tài liệu kỹ thuật sạch hoàn toàn PII",
      );
      expect(decision.pass).toBe(true);
    });
  });
});
