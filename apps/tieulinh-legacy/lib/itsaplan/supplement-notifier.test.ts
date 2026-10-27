import { describe, expect, it, mock } from "bun:test";
import {
  isIssueClosed,
  closedTicketRefusalMessage,
  resolveSupplementMentionTarget,
  formatSupplementComment,
  notifyOnCallSupplement,
} from "./supplement-notifier";
import type { ProjectColumn, ProjectAssignee } from "@vuihoc/bot-core/itsaplan";

describe("supplement-notifier", () => {
  const columns: ProjectColumn[] = [
    { id: 1, name: "Backlog", stateType: "backlog", position: 1 },
    { id: 2, name: "In Progress", stateType: "started", position: 2 },
    { id: 3, name: "Resolved", stateType: "completed", position: 3 }, // Resolved trong TECH có stateType completed nhưng là Đã xử lý (chưa đóng)
    { id: 4, name: "Done", stateType: "completed", position: 4 },
    { id: 5, name: "Canceled", stateType: "canceled", position: 5 },
  ];

  describe("isIssueClosed", () => {
    it("cột In Progress / Backlog → false (đang mở)", () => {
      expect(isIssueClosed({ columnId: 1 }, columns)).toBe(false);
      expect(isIssueClosed({ columnId: 2 }, columns)).toBe(false);
    });

    it("cột Resolved ('Đã xử lý') → false (vẫn mở để người báo nghiệm thu)", () => {
      expect(isIssueClosed({ columnId: 3 }, columns)).toBe(false);
    });

    it("cột Done / Hoàn tất → true (đã đóng)", () => {
      expect(isIssueClosed({ columnId: 4 }, columns)).toBe(true);
    });

    it("cột Canceled / Đã hủy → true (đã đóng)", () => {
      expect(isIssueClosed({ columnId: 5 }, columns)).toBe(true);
    });

    it("không có danh sách cột: dựa vào stateType của issue", () => {
      expect(isIssueClosed({ stateType: "started" })).toBe(false);
      expect(isIssueClosed({ stateType: "completed" })).toBe(true);
      expect(isIssueClosed({ stateType: "canceled" })).toBe(true);
    });
  });

  describe("closedTicketRefusalMessage", () => {
    it("chứa mã ticket, 'đã đóng', và hướng dẫn 'tạo ticket mới'", () => {
      const msg = closedTicketRefusalMessage("TECH-999", "Hoàn tất (Done)");
      expect(msg).toContain("TECH-999");
      expect(msg).toContain("đã đóng");
      expect(msg).toContain("Hoàn tất (Done)");
      expect(msg).toContain("tạo ticket mới");
    });
  });

  describe("resolveSupplementMentionTarget", () => {
    const assignees: ProjectAssignee[] = [
      { userId: "u-techlead-a", username: "techlead_a", name: "TechLead_A" },
      { userId: "u-chung", username: "techuser_b", name: "TechUser_B" },
      { userId: "u-techuser-o", username: "techuser_o", name: "TechUser_O" },
    ];

    const fakeClient = (customAssignees: ProjectAssignee[] = assignees) => ({
      getProject: async () => ({ id: 1, key: "TECH", name: "Tech", assignees: customAssignees }),
      getIssueTimeline: async () => [],
    });

    it("in-progress có assignee → mention assignee", async () => {
      const client = fakeClient();
      const target = await resolveSupplementMentionTarget({
        client,
        projectKey: "TECH",
        issue: { id: 100, assigneeUserId: "u-techlead-a" },
      });

      expect(target).not.toBeNull();
      expect(target?.username).toBe("techlead_a");
      expect(target?.source).toBe("assignee");
    });

    it("assignee có tiền tố @ → tự động gỡ @ khỏi username", async () => {
      const client = fakeClient([{ userId: "u-test", username: "@testuser", name: "Test" }]);
      const target = await resolveSupplementMentionTarget({
        client,
        projectKey: "TECH",
        issue: { id: 101, assigneeUserId: "u-test" },
      });

      expect(target?.username).toBe("testuser");
    });

    it("no assignee → mention last technician commenter từ timeline", async () => {
      const timeline = [
        {
          kind: "comment",
          actorUserId: "u-chung",
          actorName: "TechUser_B",
          body: "Kỹ thuật đang kiểm tra",
        },
        { kind: "comment", actorName: "Tiểu Linh", body: "Thông báo bot <!-- intake-bot -->" },
      ];
      const client = {
        ...fakeClient(),
        getIssueTimeline: async () => timeline,
      };

      const target = await resolveSupplementMentionTarget({
        client,
        projectKey: "TECH",
        issue: { id: 102, assigneeUserId: null },
      });

      expect(target).not.toBeNull();
      expect(target?.username).toBe("techuser_b");
      expect(target?.source).toBe("last_commenter");
    });

    it("no assignee + timeline có technician với actorUsername hợp lệ nhưng chưa trong assignees → dùng actorUsername", async () => {
      const timeline = [
        {
          kind: "comment",
          actorName: "Kỹ thuật viên K",
          actorUsername: "techuser_k",
          body: "Đã kiểm tra server",
        },
      ];
      const client = {
        ...fakeClient(),
        getIssueTimeline: async () => timeline,
      };

      const target = await resolveSupplementMentionTarget({
        client,
        projectKey: "TECH",
        issue: { id: 103, assigneeUserId: null },
      });

      expect(target).not.toBeNull();
      expect(target?.username).toBe("techuser_k");
      expect(target?.source).toBe("last_commenter");
    });

    it("no assignee + không có bình luận kỹ thuật viên nào (chỉ có bot) → none (null)", async () => {
      const timeline = [
        { kind: "comment", actorName: "Tiểu Linh", body: "Ticket tạo tự động <!-- intake-bot -->" },
        { kind: "comment", actorName: "admin", body: "System sync <!-- intake-bot -->" },
      ];
      const client = {
        ...fakeClient(),
        getIssueTimeline: async () => timeline,
      };

      const target = await resolveSupplementMentionTarget({
        client,
        projectKey: "TECH",
        issue: { id: 104, assigneeUserId: null },
      });

      expect(target).toBeNull();
    });

    it("no assignee + timeline rỗng → none (null)", async () => {
      const client = fakeClient();
      const target = await resolveSupplementMentionTarget({
        client,
        projectKey: "TECH",
        issue: { id: 105, assigneeUserId: null },
      });

      expect(target).toBeNull();
    });
  });

  describe("formatSupplementComment", () => {
    it("định dạng user_update kèm mention", () => {
      const comment = formatSupplementComment({
        parts: ["0900000005", "Học sinh dùng iPad"],
        mention: "techlead_a",
        style: "user_update",
      });
      expect(comment).toContain("➕ **[Cập nhật bổ sung từ người dùng]** (cc @techlead_a):");
      expect(comment).toContain("(cc @techlead_a)");
      expect(comment).not.toContain("(cc @techlead_a))");
      expect(comment).toContain("0900000005");
      expect(comment).toContain("Học sinh dùng iPad");
      expect(comment).toContain("<!-- intake-bot -->");
    });

    it("định dạng user_update khi mention đã có tiền tố @ vẫn chuẩn hoá thành đúng (cc @username)", () => {
      const comment = formatSupplementComment({
        parts: ["0900000005"],
        mention: "@techlead_a",
        style: "user_update",
      });
      expect(comment).toContain("(cc @techlead_a)");
      expect(comment).not.toContain("(cc @@techlead_a)");
      expect(comment).not.toContain("(cc @techlead_a))");
    });
    it("định dạng user_update không kèm mention (none)", () => {
      const comment = formatSupplementComment({
        parts: ["0900000005"],
        mention: null,
        style: "user_update",
      });

      expect(comment).toContain("➕ **[Cập nhật bổ sung từ người dùng]:**");
      expect(comment).not.toContain("cc @");
      expect(comment).toContain("0900000005");
    });

    it("định dạng who_supplement kèm mention", () => {
      const comment = formatSupplementComment({
        who: "Nguyễn Văn A",
        parts: ["Đã gửi lại ảnh"],
        mention: "techuser_b",
        style: "who_supplement",
      });
      expect(comment).toContain("**Nguyễn Văn A** bổ sung (cc @techuser_b):");
      expect(comment).toContain("(cc @techuser_b)");
      expect(comment).not.toContain("(cc @techuser_b))");
      expect(comment).toContain("Đã gửi lại ảnh");
    });
    it("định dạng who_supplement không kèm mention", () => {
      const comment = formatSupplementComment({
        who: "Nguyễn Văn A",
        parts: ["Đã gửi lại ảnh"],
        mention: null,
        style: "who_supplement",
      });

      expect(comment).toContain("**Nguyễn Văn A** bổ sung:");
      expect(comment).not.toContain("cc @");
    });
  });

  describe("notifyOnCallSupplement", () => {
    const originalEnv = process.env.NOTIFY_ON_CALL_SUPPLEMENT;

    it("khi NOTIFY_ON_CALL_SUPPLEMENT=1: gọi broadcastAlert tới kênh trực ca", async () => {
      process.env.NOTIFY_ON_CALL_SUPPLEMENT = "1";
      const broadcastAlert = mock(async () => {});
      const notifier = { broadcastAlert };

      await notifyOnCallSupplement({
        notifier,
        identifier: "TECH-1234",
        summary: "Phụ huynh gửi thêm tài khoản hs_9921",
      });

      expect(broadcastAlert).toHaveBeenCalledTimes(1);
      const text = (broadcastAlert.mock.calls[0] as unknown[])[0] as string;
      expect(text).toContain("TECH-1234");
      expect(text).toContain("hs_9921");

      process.env.NOTIFY_ON_CALL_SUPPLEMENT = originalEnv;
    });

    it("khi NOTIFY_ON_CALL_SUPPLEMENT không bật: không gửi cảnh báo", async () => {
      delete process.env.NOTIFY_ON_CALL_SUPPLEMENT;
      const broadcastAlert = mock(async () => {});
      const notifier = { broadcastAlert };

      await notifyOnCallSupplement({
        notifier,
        identifier: "TECH-1234",
        summary: "Phụ huynh gửi thêm tài khoản hs_9921",
      });

      expect(broadcastAlert).not.toHaveBeenCalled();

      process.env.NOTIFY_ON_CALL_SUPPLEMENT = originalEnv;
    });
  });
});
