import { z } from "zod";
import { defineTool, type AnyMcpTool } from "../../core/mcp-tool";
import { describeToolFailure } from "../../core/tool-error";
import type { ChannelBindingStore, CopyCatalog, TrackerPort } from "../ports";

export interface LookupToolsDeps {
  tracker: TrackerPort;
  bindings?: ChannelBindingStore;
  copy?: CopyCatalog;
  projectKey?: string;
}

export function lookupTools(deps: LookupToolsDeps): AnyMcpTool[] {
  const { tracker, bindings, copy, projectKey } = deps;
  const sampleId = projectKey ? `${projectKey}-42` : "TECH-42";

  const getIssueTool = defineTool({
    name: "get_issue",
    description:
      "Tra tiến độ, người phụ trách và toàn bộ trao đổi của một bản ghi theo mã " +
      `(ví dụ "${sampleId}") hoặc tra ticket gần nhất nếu người dùng không nhớ mã. ` +
      "Dùng khi người dùng hỏi tiến độ hoặc nhắc tới một mã.",
    inputSchema: {
      identifier: z
        .string()
        .optional()
        .describe(
          `Mã hiển thị, ví dụ "${sampleId}". Nếu để trống sẽ tự lấy ticket gần nhất qua chatId.`,
        ),
      chatId: z
        .string()
        .optional()
        .describe("Chat ID Telegram của người dùng để tra ticket gần nhất nếu thiếu mã"),
    },
    handler: async ({ identifier, chatId }) => {
      try {
        let target = identifier?.trim().toUpperCase();
        if (!target && chatId && bindings) {
          try {
            const binding = bindings.getLatestBinding(chatId);
            if (binding?.identifier) {
              target = binding.identifier.trim().toUpperCase();
            }
          } catch {
            // bỏ qua lỗi đọc binding
          }
        }

        if (!target) {
          const msg = copy?.text
            ? copy.text("lookup.clarify_identifier")
            : `Dạ anh/chị cho em xin mã ticket (ví dụ ${sampleId}) để em kiểm tra tiến độ giúp mình nhé ạ!`;
          return {
            found: false,
            reason: "missing_identifier",
            message: msg,
          };
        }

        const issue = await tracker.findByIdentifier(target);
        if (!issue) {
          return {
            found: false,
            identifier: target,
            message: `Dạ em không tìm thấy ticket ${target} trên hệ thống ạ.`,
          };
        }

        const statusName = issue.stateType ?? "Chờ xử lý";
        const summary = copy?.text
          ? copy.text("lookup.status", {
              identifier: issue.identifier,
              status: statusName,
              title: issue.title,
            })
          : `Ticket ${issue.identifier} (${issue.title}) đang ở trạng thái: ${statusName}.`;

        return {
          found: true,
          identifier: issue.identifier,
          issueId: issue.id,
          title: issue.title,
          status: {
            name: statusName,
            stateType: issue.stateType,
          },
          humanSummary: summary,
          comments: [],
        };
      } catch (err: unknown) {
        return describeToolFailure("get_issue", err);
      }
    },
  });

  return [getIssueTool];
}
