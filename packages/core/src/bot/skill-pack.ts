/**
 * Gói skill — sinh cấu trúc file gói skill cho agent harness từ khai báo `defineBot` (RFC 0002 PR 15).
 *
 * Cấu trúc tương thích legacy:
 * - `AGENTS.md`: hướng dẫn quy trình vận hành của agent.
 * - `IDENTITY.md`: danh tính, khai sinh của bot.
 * - `SOUL.md`: tính cách, giọng điệu.
 * - `bot.json`: metadata, kênh, dự án tracker.
 * - `messages/<key>.md`: các tin nhắn tĩnh (/start, /help, after-reset...).
 *
 * Core không hardcode tiếng Việt; mọi nội dung sinh từ khai báo của bot (`persona`, `skill`, `instructions`).
 */
import type { EnvShape } from "../core/config";
import type { BotDefinition } from "./define";

export function buildSkillPack<E extends EnvShape = EnvShape>(
  definition: BotDefinition<E> | Readonly<BotDefinition<E>>,
): Record<string, string> {
  const rec = definition.receptionist;
  const skill = rec?.skill;

  const pack: Record<string, string> = {};

  // AGENTS.md: hướng dẫn vận hành
  pack["AGENTS.md"] = skill?.agentsMd ?? rec?.instructions ?? "";

  // IDENTITY.md: danh tính bot
  pack["IDENTITY.md"] = skill?.identityMd ?? "";

  // SOUL.md: tính cách và giọng điệu
  pack["SOUL.md"] = skill?.soulMd ?? "";

  // bot.json: metadata bot
  const botJsonObj = skill?.botJson ?? {
    id: definition.id,
    channel: { type: "telegram", accountId: definition.id },
    tracker: {
      type: "itsaplan",
      projectKey: definition.tracker?.project,
      teamSlug: definition.tracker?.team,
    },
  };
  pack["bot.json"] = JSON.stringify(botJsonObj, null, 2);

  // Tin nhắn tĩnh (staticMessages)
  if (skill?.staticMessages) {
    for (const [key, content] of Object.entries(skill.staticMessages)) {
      const path = key.includes("/") ? key : `messages/${key.endsWith(".md") ? key : `${key}.md`}`;
      pack[path] = content;
    }
  }

  return pack;
}
