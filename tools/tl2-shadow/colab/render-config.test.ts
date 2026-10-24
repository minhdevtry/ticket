import { describe, expect, it } from "bun:test";
import { type RenderOptions, providerBaseUrl, renderConfig } from "./render-config.ts";

const opts: RenderOptions = {
  home: "/data/home",
  workspace: "/data/home/workspace",
  releaseDir: "/data/release",
  gatewayPort: 18796,
  gatewayToken: "token-ngau-nhien",
  minimaxPort: 18999,
  itsaplanPort: 18998,
  model: "MiniMax-M3.1-Flash",
  api: "anthropic-messages",
  projectKey: "TECH2",
};

describe("renderConfig", () => {
  const cfg: any = renderConfig(opts);

  it("gateway chỉ loopback, có token, bật chat-completions", () => {
    expect(cfg.gateway).toMatchObject({
      bind: "loopback",
      port: 18796,
      auth: { mode: "token", token: "token-ngau-nhien" },
      http: { endpoints: { chatCompletions: { enabled: true } } },
    });
  });

  it("provider trỏ proxy loopback với khoá giả; base URL theo kiểu API", () => {
    expect(cfg.models.providers.tl2proxy.baseUrl).toBe("http://127.0.0.1:18999");
    expect(providerBaseUrl("openai-completions", 18999)).toBe("http://127.0.0.1:18999/v1");
    expect(cfg.agents.entries["ticket-intake-agent-2"].model.primary).toBe(
      "tl2proxy/MiniMax-M3.1-Flash",
    );
  });

  it("MCP trỏ proxy itsaplan, project thử, không có Telegram/Onyx/Memgraph/chat cảnh báo", () => {
    const env = cfg.mcp.servers.ticketintake.env;
    expect(env).toMatchObject({
      ITSAPLAN_BASE_URL: "http://127.0.0.1:18998",
      ITSAPLAN_PROJECT_KEY: "TECH2",
      ADMIN_IDS: "",
      ALERT_CHAT_ID: "",
    });
    for (const k of Object.keys(env)) {
      expect(k).not.toMatch(/^(TELEGRAM_|ONYX_|MEMGRAPH_|ON_CALL)/);
    }
    expect(cfg.channels).toEqual({});
    expect(cfg.mcp.servers.ticketintake.args[1]).toBe(
      "/data/release/apps/tieulinh/mcp/tieulinh/index.ts",
    );
  });

  it("không chứa secret nào ngoài token gateway ngẫu nhiên", () => {
    const text = JSON.stringify(cfg);
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    expect(text.match(/proxy-injects-the-real-key/g)?.length).toBeGreaterThan(0);
  });
});
