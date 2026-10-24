import { describe, expect, it } from "bun:test";
import { resolveKgHttpConfig } from "./config";

describe("resolveKgHttpConfig", () => {
  it("thiếu KG_MCP_API_KEY thì từ chối chạy (bug thật: instance :8933 chạy không auth vì khởi động sai thư mục, không nạp .env)", () => {
    expect(() => resolveKgHttpConfig({})).toThrow(/KG_MCP_API_KEY/);
  });

  it("cho chạy không auth chỉ khi bật rõ KG_MCP_ALLOW_NO_AUTH=1", () => {
    const cfg = resolveKgHttpConfig({ KG_MCP_ALLOW_NO_AUTH: "1" });
    expect(cfg.apiKey).toBeUndefined();
  });

  it("mặc định cổng 8933, host 127.0.0.1; đọc được override", () => {
    expect(resolveKgHttpConfig({ KG_MCP_API_KEY: "k" })).toEqual({ port: 8933, hostname: "127.0.0.1", apiKey: "k" });
    expect(resolveKgHttpConfig({ KG_MCP_API_KEY: "k", KG_MCP_PORT: "8998", KG_MCP_HOST: "0.0.0.0" })).toEqual({
      port: 8998,
      hostname: "0.0.0.0",
      apiKey: "k",
    });
  });
});
