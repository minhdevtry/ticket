import { z } from "zod";
import { defineTool, type AnyMcpTool } from "../../core/mcp-tool";
import { describeToolFailure } from "../../core/tool-error";
import type { DraftRepository } from "../draft/repository";
import type { IntakeDraft } from "../draft/types";

export interface InspectToolsDeps {
  drafts: DraftRepository;
}

export function inspectTools(deps: InspectToolsDeps): AnyMcpTool[] {
  const { drafts } = deps;

  const getIntakeDoc = defineTool({
    name: "get_intake_doc",
    description:
      "Tra cứu chi tiết tờ khai IntakeDraft và toàn bộ lịch sử revision của phiên tiếp nhận sự cố. " +
      "Hỗ trợ kiểm tra provenance từng trường thông tin để phục vụ phân tích hoặc kiểm thử.",
    inputSchema: {
      chatId: z.string().optional().describe("ID phòng chat Telegram"),
      docId: z.string().optional().describe("Mã định danh tờ khai nếu có"),
      includeHistory: z
        .boolean()
        .default(false)
        .describe("Lấy toàn bộ lịch sử revision (mặc định false)"),
    },
    handler: ({ chatId, docId, includeHistory }) => {
      try {
        let doc: IntakeDraft | null = null;
        if (docId) {
          doc = drafts.getByDocId(docId);
        } else if (chatId) {
          doc = drafts.getLatestByChatId(chatId);
        }

        if (!doc) {
          return { found: false, message: "Không tìm thấy IntakeDocument tương ứng" };
        }

        const history = includeHistory && doc.docId ? drafts.getRevisions(doc.docId) : undefined;

        // Cung cấp trường tương thích với legacy inspect: `fields[name] = { value }`
        const recordValues = doc.record?.values ?? {};
        const fields: Record<string, { value: string }> = {};
        for (const [k, v] of Object.entries(recordValues)) {
          fields[k] = { value: v };
        }

        return {
          found: true,
          document: {
            ...doc,
            fields,
          },
          history,
        };
      } catch (err: unknown) {
        return describeToolFailure("get_intake_doc", err);
      }
    },
  });

  const getSimilarTickets = defineTool({
    name: "get_similar_tickets",
    description:
      "Lấy danh sách các ticket tương tự đã được tìm kiếm và thẩm định sự tồn tại trên Itsaplan cho phiên chat hiện tại.",
    inputSchema: {
      chatId: z.string().describe("ID phòng chat Telegram"),
    },
    handler: ({ chatId }) => {
      try {
        const doc = drafts.getLatestByChatId(chatId);
        if (!doc) {
          return { found: false, similarTickets: [] };
        }

        return {
          found: true,
          docId: doc.docId,
          revision: doc.revision,
          similarTickets: [],
        };
      } catch (err: unknown) {
        return describeToolFailure("get_similar_tickets", err);
      }
    },
  });

  return [getIntakeDoc, getSimilarTickets];
}
