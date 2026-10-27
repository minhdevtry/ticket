import { z } from "zod";
import { defineTool, type AnyMcpTool } from "../../core/mcp-tool";
import { describeToolFailure } from "../../core/tool-error";
import type { IdentityToolsConfig } from "../../identity/tools";
import type { DraftRepository } from "../draft/repository";

export interface ReceptionistIdentityToolsDeps {
  config: IdentityToolsConfig;
  drafts?: DraftRepository;
}

export function receptionistIdentityTools(deps: ReceptionistIdentityToolsDeps): AnyMcpTool[] {
  const { config, drafts } = deps;

  const checkIdentity = defineTool({
    name: "check_identity",
    description:
      "Kiểm tra người đang nhắn đã được duyệt name code chưa. Gọi trước khi ghi bản ghi mới.",
    inputSchema: {
      userId: z.string().describe("Id người dùng trên kênh chat, do host cung cấp"),
    },
    handler: ({ userId }) => {
      try {
        const result = config.service.checkUserApproval(userId);
        let pendingDraft: Record<string, unknown> | null = null;
        if (drafts) {
          const draft = drafts.getLatestByChatId(userId);
          if (
            draft &&
            (draft.status === "collecting" || draft.status === "ready_for_confirmation")
          ) {
            pendingDraft = {
              ...draft,
              state: { title: draft.ticket.title },
            };
          }
        }
        return {
          ...result,
          pendingDraft,
          message: config.copy.check(result),
        };
      } catch (err: unknown) {
        return describeToolFailure("check_identity", err);
      }
    },
  });

  const registerIdentity = defineTool({
    name: "register_identity",
    description: 'Đăng ký name code cho người dùng chưa có, dạng "CS_example".',
    inputSchema: {
      userId: z.string().describe("Id người dùng trên kênh chat, do host cung cấp"),
      nameCode: z.string().describe('Name code người dùng khai, dạng "CS_example"'),
      fullName: z.string().optional().describe("Tên hiển thị"),
      username: z.string().optional().describe("Username trên kênh chat"),
      pendingReport: z
        .string()
        .optional()
        .describe("Nội dung họ đang định báo, giữ lại để xử lý sau khi duyệt"),
    },
    handler: (input) => {
      try {
        const result = config.service.registerIdentity(input);
        return { ...result, message: config.copy.register(result) };
      } catch (err: unknown) {
        return describeToolFailure("register_identity", err);
      }
    },
  });

  return [checkIdentity, registerIdentity];
}
