import { z } from "zod";
import { ItsaplanClient } from "../../../lib/itsaplan/client";
import { findIssueByIdentifier } from "../../../lib/itsaplan/project";
import { markBotComment } from "@vuihoc/bot-core/core";
import { escapeItsaplanMarkdown } from "../../../lib/html-entities";
import { defineTool, type AnyMcpTool } from "@vuihoc/bot-core/core";
import type { TrackerConfig } from "./issues";

export interface EscalateVocabulary {
  noun: string;
  /** Câu đáp người dùng. `{identifier}` được thay. */
  acknowledgement: string;
  /** Tin nhắn gửi đội trực. `{identifier}`, `{title}`, `{reporter}`, `{reason}` được thay. */
  alertTemplate: string;
}

/**
 * Nâng mức ưu tiên lên Urgent và soạn sẵn tin báo đội trực.
 *
 * Tool **không tự gửi** tin báo: gửi đi đâu là việc của kênh, mà kênh thì mỗi
 * host một khác. Trả chuỗi ra để host tự định tuyến, thế mới đem đi chỗ khác
 * được.
 */
export function escalateIssue(config: TrackerConfig, vocabulary: EscalateVocabulary): AnyMcpTool {
  const client = new ItsaplanClient(config.baseUrl, config.apiKey);

  return defineTool({
    name: "escalate_issue",
    description:
      `Nâng mức ưu tiên lên Urgent và soạn cảnh báo tới đội trực, khi người dùng giục gấp ` +
      `("gấp lắm", "50 phút rồi chưa ai nhận", "muộn giờ học rồi"). ` +
      `Bắt buộc truyền \`identifier\` — chưa chắc là ticket nào thì hỏi lại người dùng, không tự đoán bằng \`latestTicket\`.`,
    inputSchema: {
      identifier: z
        .string()
        .describe(
          'Mã cần nâng ưu tiên, ví dụ "TECH-42". Chưa chắc chắn thì phải hỏi lại người dùng trước.',
        ),
      reason: z.string().optional().describe("Lý do người dùng nêu, dùng cho tin báo trực ca"),
      reporterName: z.string().describe("Tên người báo, do host cung cấp"),
      reporterUsername: z.string().optional().describe("Username trên kênh chat, nếu có"),
    },
    handler: async (input) => {
      const target = input.identifier.trim().toUpperCase();

      const issue = await findIssueByIdentifier(client, target, config.projectKey);
      if (!issue) {
        return { escalated: false, reason: "not_found", identifier: target };
      }

      await client.updateIssue(issue.id, { priority: "urgent" });
      await client.addComment(
        issue.id,
        markBotComment(
          `🚨 **Người báo giục gấp.** ${escapeItsaplanMarkdown(input.reason ?? "")}`.trim(),
        ),
      );

      const reporter = input.reporterUsername ? `@${input.reporterUsername}` : input.reporterName;
      const fill = (template: string) =>
        template
          .replaceAll("{identifier}", issue.identifier || target)
          .replaceAll("{title}", issue.title ?? "")
          .replaceAll("{reporter}", reporter)
          .replaceAll("{reason}", input.reason ?? "");

      return {
        escalated: true,
        identifier: issue.identifier || target,
        message: fill(vocabulary.acknowledgement),
        // Host tự quyết gửi đi đâu; tool chỉ soạn.
        alert: fill(vocabulary.alertTemplate),
      };
    },
  });
}
