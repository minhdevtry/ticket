import { describe, expect, it } from "bun:test";
import { auditBootstrapReadiness, isBootstrapSafe, type WorkspaceFiles } from "./bootstrap-guard";

/**
 * Mục 4: chống lỗ hổng bot OpenClaw mới chạy onboarding với người thật (lộ nội
 * bộ — đã xảy ra với @vhops_bot 18/10). Test chứng minh guard bắt đúng ba dấu
 * hiệu (BOOTSTRAP còn, persona rỗng, AGENTS template) và cho qua khi đã seed.
 */

const seeded: WorkspaceFiles = {
  // bootstrap đã xóa (undefined)
  identity:
    "# OP\nEm là OP, bot tiếp nhận yêu cầu vận hành của VUIHOC qua @vhops_bot, phụ trách project OP. Xưng em, gọi anh/chị.",
  soul: "# SOUL\nGiọng: lễ phép, đi thẳng việc. Cấm nói chuyện khởi tạo/nội bộ với người ngoài. Luôn tạo ticket đúng quy trình.",
  agents:
    "# AGENTS\nQuy trình tiếp nhận: nhận mô tả sự cố, gate, tóm tắt, xác nhận, gọi opintake__intake_step để tạo ticket OP.",
};

describe("auditBootstrapReadiness", () => {
  it("workspace đã seed → không phát hiện, bot sẵn sàng", () => {
    expect(auditBootstrapReadiness(seeded)).toEqual([]);
    expect(isBootstrapSafe(seeded)).toBe(true);
  });

  it("còn BOOTSTRAP.md → block", () => {
    const f = { ...seeded, bootstrap: "# BOOTSTRAP\nChào, mình vừa thức dậy..." };
    const found = auditBootstrapReadiness(f);
    expect(found.some((x) => x.code === "bootstrap-present" && x.severity === "block")).toBe(true);
    expect(isBootstrapSafe(f)).toBe(false);
  });

  it("IDENTITY rỗng/template → block", () => {
    const f = { ...seeded, identity: "# IDENTITY\n(điền tên bạn thích vào đây)" };
    expect(
      auditBootstrapReadiness(f).some((x) => x.code === "identity-empty" && x.severity === "block"),
    ).toBe(true);
    expect(isBootstrapSafe(f)).toBe(false);
  });

  it("IDENTITY gần rỗng (quá ngắn) → block", () => {
    const f = { ...seeded, identity: "# OP" };
    expect(isBootstrapSafe(f)).toBe(false);
  });

  it("SOUL template → chỉ warn, không block", () => {
    const f = { ...seeded, soul: "pick something you like" };
    const found = auditBootstrapReadiness(f);
    expect(found.some((x) => x.code === "soul-empty" && x.severity === "warn")).toBe(true);
    // soul chỉ warn: nếu identity/agents ổn thì vẫn safe
    expect(isBootstrapSafe(f)).toBe(true);
  });

  it("AGENTS.md kiểu 'this folder is home / first run' → block", () => {
    const f = {
      ...seeded,
      agents: "This folder is your home.\nFirst run: see BOOTSTRAP.md to set yourself up.",
    };
    expect(
      auditBootstrapReadiness(f).some(
        (x) => x.code === "agents-template" && x.severity === "block",
      ),
    ).toBe(true);
    expect(isBootstrapSafe(f)).toBe(false);
  });

  it("nhiều lỗi cùng lúc → block xếp trước (bootstrap đầu tiên)", () => {
    const f: WorkspaceFiles = { bootstrap: "còn đây", identity: "", soul: "", agents: "first run" };
    const found = auditBootstrapReadiness(f);
    expect(found[0]!.code).toBe("bootstrap-present");
    expect(found.filter((x) => x.severity === "block").length).toBeGreaterThanOrEqual(3);
  });
});
