import { describe, expect, it } from "bun:test";
import { defineBot } from "./define";
import { buildSkillPack } from "./skill-pack";
import { fixtureCatalog } from "../intake/gate/catalog.fixture";
import { FieldExtractor } from "../intake/extractor/llm-extractor";
import { makeCopyCatalog } from "../intake/copy-catalog";
import { TEST_COPY } from "../intake/engine/test-copy.fixture";
import fixtureUrgency from "../intake/priority/urgency-rules.fixture.json" with { type: "json" };
import type { UrgencyRules } from "../intake/priority/priority";

describe("buildSkillPack", () => {
  it("sinh đầy đủ cây file gói skill từ BotDefinition", () => {
    const def = defineBot({
      id: "bot-support",
      tracker: { team: "tech", project: "TECH" },
      persona: makeCopyCatalog(TEST_COPY),
      receptionist: {
        catalog: fixtureCatalog,
        priorityRules: fixtureUrgency as unknown as UrgencyRules,
        extractor: new FieldExtractor(),
        instructions: "Hướng dẫn xử lý sự cố",
        skill: {
          agentsMd: "# Quy trình vận hành\n1. Tiếp nhận sự cố.",
          identityMd: "---\nid: bot-support\n---\n# Khai sinh",
          soulMd: "# Tâm hồn\nThân thiện, nhanh nhẹn.",
          botJson: {
            id: "bot-support",
            tracker: { projectKey: "TECH" },
            capabilities: ["create", "inquire"],
          },
          staticMessages: {
            greeting: "Chào anh/chị, em có thể giúp gì?",
            help: "Gõ /help để xem hướng dẫn.",
            "after-reset.md": "Đã làm mới phiên.",
          },
        },
      },
    });

    const pack = buildSkillPack(def);

    expect(pack["AGENTS.md"]).toBe("# Quy trình vận hành\n1. Tiếp nhận sự cố.");
    expect(pack["IDENTITY.md"]).toBe("---\nid: bot-support\n---\n# Khai sinh");
    expect(pack["SOUL.md"]).toBe("# Tâm hồn\nThân thiện, nhanh nhẹn.");
    expect(pack["messages/greeting.md"]).toBe("Chào anh/chị, em có thể giúp gì?");
    expect(pack["messages/help.md"]).toBe("Gõ /help để xem hướng dẫn.");
    expect(pack["messages/after-reset.md"]).toBe("Đã làm mới phiên.");

    const botJson = JSON.parse(pack["bot.json"]);
    expect(botJson.id).toBe("bot-support");
    expect(botJson.capabilities).toContain("create");
  });

  it("rơi về instructions khi skill.agentsMd không khai", () => {
    const def = defineBot({
      id: "fallback-bot",
      tracker: { team: "tech", project: "TECH" },
      persona: makeCopyCatalog(TEST_COPY),
      receptionist: {
        catalog: fixtureCatalog,
        priorityRules: fixtureUrgency as unknown as UrgencyRules,
        extractor: new FieldExtractor(),
        instructions: "# Default Instructions",
      },
    });

    const pack = buildSkillPack(def);
    expect(pack["AGENTS.md"]).toBe("# Default Instructions");
    expect(pack["IDENTITY.md"]).toBe("");
    expect(pack["SOUL.md"]).toBe("");
    expect(pack["bot.json"]).toBeDefined();
    const botJson = JSON.parse(pack["bot.json"]);
    expect(botJson.id).toBe("fallback-bot");
  });
});
