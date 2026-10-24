#!/usr/bin/env bun
/**
 * MCP server RIÊNG, chạy qua HTTP, CHỈ công khai đúng 1 tool: query_knowledge_graph.
 *
 * Khác với intake-tieulinh (chạy stdio, do OpenClaw spawn, có đủ create_issue/
 * update_issue...): server này là điểm vào cho HỆ THỐNG NGOÀI (Onyx MCP Actions)
 * gọi vào — nên chỉ bọc đúng 1 tool đọc-thuần (query_knowledge_graph), không
 * có bất kỳ tool nào có side-effect trên Itsaplan. Thu hẹp bề mặt tin cậy khi
 * mở ra cho 1 dịch vụ ngoài gọi, thay vì tái dùng nguyên bộ tool nội bộ.
 *
 * Dùng: bun run apps/tieulinh/mcp/kg-http/index.ts
 * Env cần: MEMGRAPH_URI/MEMGRAPH_USER/MEMGRAPH_PASS (mặc định bolt://localhost:7687),
 *          KG_MCP_PORT (mặc định 8933), KG_MCP_HOST (mặc định 127.0.0.1),
 *          KG_MCP_API_KEY (bắt buộc — thiếu thì không khởi động, trừ khi đặt
 *          KG_MCP_ALLOW_NO_AUTH=1 cho dev cục bộ).
 */
import { createIntakeMcpServer, runOnHttp, queryKnowledgeGraph } from "../shared/index";
import { getLogger } from "../../lib/logger";
import { type KgHttpConfig, resolveKgHttpConfig } from "./config";

let config: KgHttpConfig;
try {
  config = resolveKgHttpConfig(process.env);
} catch (err: any) {
  getLogger().error(`[kg-http] ${err.message}`);
  process.exit(1);
}
if (!config.apiKey) {
  getLogger().warn(
    "[kg-http] Đang chạy KHÔNG xác thực (KG_MCP_ALLOW_NO_AUTH=1) — chỉ dùng cho dev cục bộ.",
  );
}

// Tạo tool 1 LẦN DUY NHẤT (không phải trong makeServer) — bên trong nó tự giữ
// 1 MemgraphClient dùng chung, mở lười (lazy) ở lần gọi đầu. makeServer() sẽ
// chạy lại mỗi request (McpServer chỉ nhận 1 transport tại 1 thời điểm), nhưng
// phải bọc lại đúng CÙNG MỘT tool object này — nếu gọi queryKnowledgeGraph()
// mới mỗi request thì mỗi request mở 1 kết nối Bolt mới, không bao giờ đóng.
const kgTool = queryKnowledgeGraph();
const makeServer = () =>
  createIntakeMcpServer({
    name: "intake-kg",
    version: "1.0.0",
    tools: [kgTool],
  });

runOnHttp(makeServer, config);
