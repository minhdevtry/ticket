import { z } from "zod";
import { defineTool, type AnyMcpTool } from "../../shared/tool";
import type { IntakeDocumentRepository } from "../../../lib/intake-document/repository";

export function inspectTools(repo: IntakeDocumentRepository): AnyMcpTool[] {
  const getIntakeDoc = defineTool({
    name: "get_intake_doc",
    description:
      "Tra cứu chi tiết tờ khai IntakeDocument và toàn bộ lịch sử revision của phiên tiếp nhận sự cố. " +
      "Hỗ trợ kiểm tra provenance từng trường thông tin để phục vụ phân tích hoặc dựng Knowledge Graph.",
    inputSchema: {
      chatId: z.string().optional().describe("ID phòng chat Telegram"),
      docId: z.string().optional().describe("Mã định danh tờ khai nếu có"),
      includeHistory: z
        .boolean()
        .default(false)
        .describe("Lấy toàn bộ lịch sử revision (mặc định false)"),
    },
    handler: ({ chatId, docId, includeHistory }) => {
      let doc = null;
      if (docId) {
        doc = repo.getByDocId(docId);
      } else if (chatId) {
        doc = repo.getLatestByChatId(chatId);
      }

      if (!doc) {
        return { found: false, message: "Không tìm thấy IntakeDocument tương ứng" };
      }

      const history = includeHistory && doc.docId ? repo.getRevisions(doc.docId) : undefined;

      return {
        found: true,
        document: doc,
        history,
      };
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
      const doc = repo.getLatestByChatId(chatId);
      if (!doc) {
        return { found: false, similarTickets: [] };
      }

      return {
        found: true,
        docId: doc.docId,
        revision: doc.revision,
        similarTickets: doc.similarTickets,
      };
    },
  });

  return [getIntakeDoc, getSimilarTickets];
}
