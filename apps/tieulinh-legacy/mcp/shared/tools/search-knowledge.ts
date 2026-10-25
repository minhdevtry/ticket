import { z } from "zod";
import { OnyxClient } from "../../../lib/onyx/client";
import { defineTool, type AnyMcpTool } from "@vuihoc/bot-core/core";

export interface KnowledgeConfig {
  baseUrl: string;
  apiKey: string;
  personaId?: number;
  mcpUrl?: string;
}

/**
 * Tra kho runbook và ticket đã đóng, trả về ứng viên — không kết luận.
 *
 * Bản MCP cũ gọi tool này là `tra_ticket_tuong_tu` và đã chọn đúng hướng: tool
 * chỉ đưa ứng viên, **model** đọc triệu chứng rồi tự quyết có cùng nguyên nhân
 * hay không. Bản trong `relation-matcher.ts` thì nhét hẳn một LLM vào trong,
 * nên kéo cả runtime agent theo — không dùng được ở đây, và cũng không cần.
 */
export function searchKnowledge(config: KnowledgeConfig): AnyMcpTool {
  const client = new OnyxClient(config.baseUrl, config.apiKey, config.mcpUrl);

  return defineTool({
    name: "search_knowledge",
    description:
      "Tra kho runbook và ticket đã đóng để tìm việc tương tự. GỌI SAU khi đã đủ thông tin và " +
      "TRƯỚC create_issue, đúng một lần cho mỗi sự cố. ĐỌC KỸ triệu chứng và nguyên nhân của " +
      "từng ứng viên: chỉ coi là trùng khi cùng nguyên nhân hoặc cùng luồng kỹ thuật. " +
      "Khác nguyên nhân, hoặc không chắc, thì bỏ qua — thà không gắn còn hơn gắn sai.",
    inputSchema: {
      title: z.string().describe("Tiêu đề sự cố đang tiếp nhận"),
      description: z.string().describe("Mô tả sự cố đang tiếp nhận"),
      excludeIdentifier: z
        .string()
        .optional()
        .describe("Mã ticket hiện tại, để khỏi tự khớp chính nó"),
      system: z.string().optional().describe("Tên hệ thống để tự động lọc ứng viên cùng hệ thống"),
    },
    handler: async ({ title, description, excludeIdentifier, system }) => {
      const result = await client.searchSimilarTickets(
        title,
        description,
        excludeIdentifier,
        config.personaId ?? 6,
        system,
      );
      return {
        answer: result.answer,
        candidates: result.relatedTicketKeys,
        candidateDetails: result.candidateDetails || [],
        suggestions: result.suggestions || {},
        // Nhắc lại ngay trong kết quả, vì đây là chỗ model hay vội kết luận.
        note: "Đây là ứng viên, chưa phải kết luận. ĐỌC KỸ nguyên nhân và triệu chứng: chỉ gắn khi thực sự cùng nguyên nhân kỹ thuật. Nếu khác nguyên nhân thì không gắn.",
      };
    },
  });
}
