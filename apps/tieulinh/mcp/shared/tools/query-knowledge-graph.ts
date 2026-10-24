import { z } from "zod";
import { MemgraphClient } from "../../../lib/kg/memgraph-client";
import { KnowledgeGraphQueries } from "../../../lib/kg/kg-queries";
import { defineTool, type AnyMcpTool } from "@vuihoc/bot-core/core";

export function queryKnowledgeGraph(): AnyMcpTool {
  let memgraph: MemgraphClient | undefined;
  let queries: KnowledgeGraphQueries | undefined;

  const getQueries = () => {
    if (!memgraph) {
      memgraph = new MemgraphClient();
      queries = new KnowledgeGraphQueries(memgraph);
    }
    return queries!;
  };

  return defineTool({
    name: "query_knowledge_graph",
    description:
      "Tra cứu Đồ thị Tri thức Kỹ thuật (Memgraph Knowledge Graph) chứa 350+ sự cố Vuihoc đã xử lý thành công. " +
      "Dùng để: (1) Tìm giải pháp đã được chứng minh hiệu quả cho sự cố tương tự; (2) Tra cứu các nguyên nhân gốc rễ hay lặp lại theo hệ thống; " +
      "(3) Tìm các sự cố liên quan chùm.",
    inputSchema: {
      action: z
        .enum(["suggest_resolution", "top_root_causes", "most_related", "graph_stats"])
        .describe(
          "Hành động tra cứu: 'suggest_resolution' (gợi ý cách xử lý), 'top_root_causes' (nguyên nhân hay gặp), 'most_related' (tâm chấn sự cố), 'graph_stats' (thống kê đồ thị)",
        ),
      system: z
        .string()
        .optional()
        .describe("Tên hệ thống (vd: CRM_Vuihoc, LMS_Vuihoc, TUTOR_Vuihoc...)"),
      errorCategory: z
        .string()
        .optional()
        .describe("Loại lỗi (vd: Lỗi hệ thống, Lỗi dữ liệu, Lỗi phân quyền...)"),
      keywords: z
        .array(z.string())
        .optional()
        .describe("Từ khóa triệu chứng hoặc lỗi kỹ thuật (vd: ['trùng tài khoản', 'tạo đơn'])"),
      limit: z
        .number()
        .optional()
        .default(5)
        .describe("Số lượng kết quả tối đa cần lấy (mặc định 5)"),
    },
    handler: async ({ action, system, errorCategory, keywords = [], limit = 5 }) => {
      try {
        const q = getQueries();
        if (action === "suggest_resolution") {
          const results = await q.suggestResolutions({
            system,
            errorCategory,
            keywords,
            limit,
          });
          return {
            action,
            count: results.length,
            suggestions: results.map((r) => ({
              ticket: r.identifier,
              title: r.title,
              system: r.system,
              rootCause: r.rootCause,
              resolution: r.resolution,
            })),
            note: "Các giải pháp trên được trích xuất từ các ticket đã Done trong Knowledge Graph. Kỹ thuật viên/Agent có thể tham khảo để xử lý nhanh.",
          };
        }

        if (action === "top_root_causes") {
          const causes = await q.topRootCauses(system, limit);
          return {
            action,
            system: system || "Toàn bộ hệ thống",
            causes,
          };
        }

        if (action === "most_related") {
          const related = await q.mostRelatedTickets(limit);
          return {
            action,
            clusters: related,
          };
        }

        if (action === "graph_stats") {
          const stats = await q.statsByLabel();
          return {
            action,
            labels: stats,
          };
        }

        return { error: `Hành động ${action} không hỗ trợ` };
      } catch (err: any) {
        return { error: `Lỗi truy vấn Knowledge Graph: ${err.message}` };
      }
    },
  });
}
