/**
 * Bọc danh sách tool thành một MCP server chạy trên stdio hoặc HTTP.
 *
 * Không có gì ở đây biết tới Telegram hay OpenClaw. Host nào nói được MCP thì
 * cắm vào chạy — đó là điểm khiến lớp này portable hơn skill markdown.
 *
 * NGUỒN: intake `mcp/shared/server.ts` (nguyên văn, chỉ đổi import nội bộ sang
 * `../tool-error`/`../logger` và thêm alias trung lập). Tên gốc
 * `createIntakeMcpServer` được GIỮ (Tiểu Linh/Iris còn gọi theo tên này); thêm
 * `createMcpServer` làm tên trung lập cho bot mới (Bot-Sales, CM).
 */
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { describeToolFailure } from "./tool-error";
import { getLogger } from "./logger";
import type { AnyMcpTool } from "./mcp-tool";

export interface McpServerOptions {
  name: string;
  version: string;
  tools: AnyMcpTool[];
}

/** Tên trung lập — dùng cho bot mới. */
export function createMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer({ name: options.name, version: options.version });

  for (const tool of options.tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (input: unknown) => {
        // Tool hỏng thì vẫn trả về kết quả BÌNH THƯỜNG, chỉ khác là mang cờ
        // `loi: true` kèm câu nói sẵn cho người dùng. Ném lỗi lên host thì
        // model được tự do diễn giải, và nó đã từng chọn cách im lặng.
        let result: unknown;
        try {
          result = await tool.handler(input as never);
        } catch (err) {
          result = describeToolFailure(tool.name, err);
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    );
  }

  return server;
}

/** Giữ tên gốc intake để call site cũ không phải đổi. */
export const createIntakeMcpServer = createMcpServer;
/** Alias options cho call site cũ. */
export type IntakeMcpOptions = McpServerOptions;

export async function runOnStdio(server: McpServer): Promise<void> {
  await server.connect(new StdioServerTransport());
}

export interface HttpMcpOptions {
  port: number;
  /** Nếu có: mọi request phải mang đúng `Authorization: Bearer <apiKey>` này. */
  apiKey?: string;
  /**
   * Địa chỉ bind. Mặc định 127.0.0.1 — dịch vụ ngoài (Onyx) đi vào qua tunnel
   * nên không cần nghe trên mọi interface; muốn mở ra LAN thì phải đặt rõ "0.0.0.0".
   */
  hostname?: string;
}

/**
 * Chạy MCP server qua HTTP (Streamable HTTP, chuẩn MCP hiện tại) thay vì stdio
 * — dùng khi host gọi vào là 1 dịch vụ ngoài (như Onyx MCP Actions) thay vì
 * tiến trình con OpenClaw/Telegram bot spawn ra.
 *
 * Nhận vào 1 FACTORY (không phải 1 instance McpServer đã tạo sẵn) vì mỗi request
 * cần 1 cặp server+transport RIÊNG — McpServer chỉ chấp nhận đúng 1 transport
 * đang kết nối tại 1 thời điểm; dùng lại 1 instance cho nhiều request đồng thời
 * sẽ ném lỗi "Already connected to a transport".
 *
 * Stateless theo từng request — phù hợp các tool truy vấn thuần (đọc). KHÔNG
 * dùng hàm này để expose các tool có side-effect (create_issue, update_issue…);
 * chỉ bọc 1 server đã lọc sẵn tool cần công khai.
 */
export function runOnHttp(
  makeServer: () => McpServer,
  options: HttpMcpOptions,
): ReturnType<typeof Bun.serve> {
  const log = getLogger();
  const hostname = options.hostname ?? "127.0.0.1";
  const expectedAuth = options.apiKey ? Buffer.from(`Bearer ${options.apiKey}`) : null;

  const httpServer = Bun.serve({
    port: options.port,
    hostname,
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname !== "/mcp") {
        return new Response("Not found", { status: 404 });
      }

      if (expectedAuth) {
        const auth = Buffer.from(req.headers.get("authorization") || "");
        // So sánh thời gian hằng — tránh dò key theo độ trễ phản hồi.
        const ok = auth.length === expectedAuth.length && timingSafeEqual(auth, expectedAuth);
        if (!ok) {
          log.warn(`[HttpMcp] Từ chối request thiếu/sai Authorization tới ${url.pathname}`);
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      const server = makeServer();
      try {
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        await server.connect(transport);
        const res = await transport.handleRequest(req);
        return res;
      } catch (err: any) {
        log.error(`[HttpMcp] Lỗi xử lý request: ${err.message}`);
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      } finally {
        await server.close();
      }
    },
  });

  log.info(`[HttpMcp] MCP HTTP server nghe ở ${hostname}:${options.port} (POST /mcp)`);
  return httpServer;
}
