/**
 * Đọc cấu hình kg-http từ env. Tách riêng để test được chính sách khởi động:
 * thiếu API key thì KHÔNG chạy (trước đây chỉ cảnh báo rồi vẫn mở cổng không
 * auth — đã xảy ra thật khi chạy lệnh từ thư mục gốc repo, Bun không nạp apps/tieulinh-legacy/.env).
 */
export interface KgHttpConfig {
  port: number;
  hostname: string;
  apiKey?: string;
}

export function resolveKgHttpConfig(env: Record<string, string | undefined>): KgHttpConfig {
  const apiKey = env.KG_MCP_API_KEY || undefined;
  if (!apiKey && env.KG_MCP_ALLOW_NO_AUTH !== "1") {
    throw new Error(
      "KG_MCP_API_KEY chưa đặt — không khởi động kg-http. Chạy từ thư mục apps/tieulinh-legacy/ để Bun nạp .env, " +
        "hoặc đặt KG_MCP_ALLOW_NO_AUTH=1 nếu cố ý chạy không auth cho dev cục bộ.",
    );
  }
  return {
    port: Number(env.KG_MCP_PORT ?? "8933"),
    hostname: env.KG_MCP_HOST ?? "127.0.0.1",
    apiKey,
  };
}
