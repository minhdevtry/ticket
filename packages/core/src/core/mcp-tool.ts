/**
 * Một tool MCP, khai báo một lần, chạy được ở mọi host.
 *
 * Tên tool và tên trường bằng tiếng Anh — đó là thứ model và host đọc như định
 * danh. Phần mô tả và câu chữ trả về cho người dùng vẫn là tiếng Việt.
 *
 * NGUỒN: intake `mcp/shared/tool.ts` (nguyên văn). Giữ tên `defineTool`/`McpTool`
 * để Tiểu Linh cắm vào không phải đổi call site.
 */
import { z } from "zod";

export interface McpTool<TShape extends z.ZodRawShape = z.ZodRawShape> {
  /** Định danh model gọi. snake_case tiếng Anh. */
  name: string;
  /** Một dòng model đọc để quyết định có gọi hay không. Tiếng Việt. */
  description: string;
  inputSchema: TShape;
  handler(input: z.infer<z.ZodObject<TShape>>): Promise<unknown> | unknown;
}

/**
 * Một tool bất kỳ, đã xoá tham số kiểu — dùng cho danh sách tool hỗn hợp.
 * Trước đây chỗ này là `McpTool<never>` rồi cast bừa ở mọi factory.
 */
export type AnyMcpTool = McpTool<z.ZodRawShape>;

export function defineTool<TShape extends z.ZodRawShape>(tool: McpTool<TShape>): McpTool<TShape> {
  return tool;
}
