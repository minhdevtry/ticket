import { describe, expect, it } from "bun:test";
import { buildSkillPack } from "@vuihoc/bot-core/bot";
import { harness } from "./testkit";

describe("Tiểu Linh: cấu trúc gói skill", () => {
  it("sinh đúng cấu trúc file của gói skill Tiểu Linh", async () => {
    const h = harness();
    try {
      const { app } = h.boot();
      const pack = buildSkillPack(app.bot);

      expect(pack["AGENTS.md"]).toBeDefined();
      expect(pack["AGENTS.md"]).toContain("Tiểu Linh");

      expect(pack["IDENTITY.md"]).toBeDefined();
      expect(pack["IDENTITY.md"]).toContain("Tiểu Linh");

      expect(pack["SOUL.md"]).toBeDefined();
      expect(pack["SOUL.md"]).toContain("Xưng em, gọi anh/chị");

      expect(pack["bot.json"]).toBeDefined();
      const botJson = JSON.parse(pack["bot.json"]);
      expect(botJson.id).toBe("tieulinh");
      expect(botJson.channel?.type).toBe("telegram");

      expect(pack["messages/greeting.md"]).toBeDefined();
      expect(pack["messages/greeting.md"]).toContain("Tiểu Linh");

      expect(pack["messages/help.md"]).toBeDefined();
      expect(pack["messages/help.md"]).toContain("Hỗ trợ kỹ thuật");

      expect(pack["messages/after-reset.md"]).toBeDefined();
      expect(pack["messages/after-reset.md"]).toContain("Đã làm mới phiên");
    } finally {
      await h.stop();
    }
  });
});
