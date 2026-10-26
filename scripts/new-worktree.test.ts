import { describe, expect, test } from "bun:test";
import {
  branchDirName,
  DEFAULT_BASE,
  isDirtyPorcelain,
  mainWorktreePath,
  parseArgs,
  worktreePath,
  workspacesRoot,
} from "./new-worktree";

describe("workspacesRoot", () => {
  test("worktree nằm dưới ~/orca/workspaces", () => {
    expect(workspacesRoot("/home/user")).toBe("/home/user/orca/workspaces");
  });
});

describe("branchDirName", () => {
  test("thay '/' bằng '-'", () => {
    expect(branchDirName("feat/chat")).toBe("feat-chat");
    expect(branchDirName("chore/agent-workflow-setup")).toBe("chore-agent-workflow-setup");
  });

  test("nhánh không có '/' thì giữ nguyên", () => {
    expect(branchDirName("main")).toBe("main");
  });

  test("cắt khoảng trắng thừa", () => {
    expect(branchDirName("  feat/chat  ")).toBe("feat-chat");
  });
});

describe("worktreePath", () => {
  test("ghép root, tên repo và tên nhánh đã làm sạch", () => {
    expect(worktreePath("/root/ws", "ticket", "feat/chat")).toBe("/root/ws/ticket/feat-chat");
  });

  test("nhánh khác nhau thì đường dẫn khác nhau", () => {
    expect(worktreePath("/root/ws", "ticket", "feat/chat")).not.toBe(
      worktreePath("/root/ws", "ticket", "feat/web"),
    );
  });

  test("'feat/chat' và 'feat-chat' trùng đường dẫn: công cụ phải chặn bằng cách báo đã tồn tại", () => {
    // Quy tắc thay '/' bằng '-' là bắt buộc, nên va chạm là có thật. Công cụ chặn ở
    // bước "đường dẫn đã tồn tại" chứ không ghi đè worktree của nhánh khác.
    expect(worktreePath("/root/ws", "ticket", "feat/chat")).toBe(
      worktreePath("/root/ws", "ticket", "feat-chat"),
    );
  });
});

describe("isDirtyPorcelain", () => {
  test("rỗng là sạch", () => {
    expect(isDirtyPorcelain("")).toBe(false);
    expect(isDirtyPorcelain("   \n\n")).toBe(false);
  });

  test("có dòng thay đổi là bẩn", () => {
    expect(isDirtyPorcelain(" M src/a.ts\n")).toBe(true);
    expect(isDirtyPorcelain("?? src/b.ts\n")).toBe(true);
  });
});

describe("mainWorktreePath", () => {
  test("lấy worktree đầu tiên trong danh sách", () => {
    const list = [
      "worktree /srv/main-checkout",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /srv/other",
      "HEAD def456",
      "branch refs/heads/feat/chat",
      "",
    ].join("\n");
    expect(mainWorktreePath(list)).toBe("/srv/main-checkout");
  });

  test("danh sách rỗng thì không có", () => {
    expect(mainWorktreePath("")).toBeNull();
  });
});

describe("parseArgs", () => {
  test("chỉ tên nhánh thì lấy nhánh nền mặc định", () => {
    const args = parseArgs(["feat/chat"]);
    expect(args.branch).toBe("feat/chat");
    expect(args.base).toBe(DEFAULT_BASE);
    expect(args.allowDirty).toBe(false);
  });

  test("nhánh nền thứ hai được dùng", () => {
    expect(parseArgs(["feat/chat", "origin/develop"]).base).toBe("origin/develop");
  });

  test("--allow-dirty bật cờ", () => {
    expect(parseArgs(["feat/chat", "--allow-dirty"]).allowDirty).toBe(true);
  });

  test("thiếu tên nhánh thì lỗi", () => {
    expect(() => parseArgs([])).toThrow("Thiếu tên nhánh");
  });

  test("thừa tham số thì lỗi", () => {
    expect(() => parseArgs(["a", "b", "c"])).toThrow("Thừa tham số");
  });

  test("cờ lạ thì lỗi", () => {
    expect(() => parseArgs(["feat/chat", "--k Something"])).toThrow("Không hiểu tham số");
  });
});
