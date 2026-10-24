/**
 * Dựng `openclaw.json` cho gateway Tiểu Linh 2 trên Colab. KHÔNG chứa secret thật:
 *  - khoá MiniMax và itsaplan nằm ở proxy trên máy dev, Colab chỉ gọi cổng loopback;
 *  - `apiKey` ở đây là giá trị giả (proxy gỡ rồi gắn khoá thật);
 *  - token gateway là chuỗi ngẫu nhiên sinh trên Colab, chỉ để chặn tiến trình lạ trên VM.
 * Không có token Telegram, không có chat ID cảnh báo, Onyx/Memgraph/tìm ticket tương tự đều tắt.
 */

/**
 * Tool dựng sẵn của OpenClaw bị cấm cho agent Tiểu Linh 2: chỉ còn tool của MCP `ticketintake`.
 * (`deny` luôn thắng allow; xem docs OpenClaw "tool policy".) Tiểu Linh 2 không cần shell, file,
 * web, trình duyệt, cron hay gửi tin: bị lừa qua prompt injection cũng không có gì để lạm dụng.
 */
export const DENIED_TOOL_GROUPS = [
  "group:runtime",
  "group:fs",
  "group:web",
  "group:ui",
  "group:automation",
  "group:nodes",
  "group:messaging",
];

export type ApiStyle = "anthropic-messages" | "openai-completions";

export interface RenderOptions {
  /** Thư mục trạng thái OpenClaw (OPENCLAW_STATE_DIR). */
  home: string;
  workspace: string;
  /** Thư mục bản phát hành đã giải nén (chứa apps/, packages/). */
  releaseDir: string;
  gatewayPort: number;
  gatewayToken: string;
  minimaxPort: number;
  itsaplanPort: number;
  model: string;
  api: ApiStyle;
  projectKey: string;
  agentId?: string;
  bunBin?: string;
}

/** Base URL của provider tuỳ kiểu API: SDK Anthropic tự thêm /v1/messages, kiểu OpenAI thì cần /v1. */
export function providerBaseUrl(api: ApiStyle, port: number): string {
  return api === "anthropic-messages" ? `http://127.0.0.1:${port}` : `http://127.0.0.1:${port}/v1`;
}

export function renderConfig(o: RenderOptions): Record<string, unknown> {
  const agentId = o.agentId ?? "ticket-intake-agent-2";
  const modelRef = `tl2proxy/${o.model}`;
  const mcpEnv: Record<string, string> = {
    ITSAPLAN_BASE_URL: `http://127.0.0.1:${o.itsaplanPort}`,
    ITSAPLAN_API_KEY: "proxy-injects-the-real-key",
    ITSAPLAN_PROJECT_KEY: o.projectKey,
    INTAKE_DB_PATH: `${o.home}/tieulinh.db`,
    // LLM nội bộ của MCP (trích xuất tờ khai, soát thông tin) cũng đi qua proxy MiniMax.
    OPENAI_API_STYLE: o.api === "anthropic-messages" ? "anthropic" : "openai",
    OPENAI_BASE_URL: providerBaseUrl(o.api, o.minimaxPort),
    OPENAI_API_KEY: "proxy-injects-the-real-key",
    OPENAI_MODEL: o.model,
    // Cố ý để trống/không đặt: ADMIN_IDS, ALERT_CHAT_ID, ON_CALL_*, TELEGRAM_*, ONYX_*, MEMGRAPH_*.
    ADMIN_IDS: "",
    ALERT_CHAT_ID: "",
    REQUIRE_APPROVAL: "true",
  };
  return {
    gateway: {
      mode: "local",
      port: o.gatewayPort,
      bind: "loopback",
      auth: { mode: "token", token: o.gatewayToken },
      http: { endpoints: { chatCompletions: { enabled: true } } },
    },
    models: {
      mode: "merge",
      providers: {
        tl2proxy: {
          baseUrl: providerBaseUrl(o.api, o.minimaxPort),
          api: o.api,
          apiKey: "proxy-injects-the-real-key",
          models: [
            {
              id: o.model,
              name: o.model,
              reasoning: true,
              contextWindow: 200000,
              maxTokens: 8192,
            },
          ],
        },
      },
    },
    agents: {
      defaults: { model: { primary: modelRef } },
      entries: {
        [agentId]: {
          name: "Ticket Intake 2",
          workspace: o.workspace,
          model: { primary: modelRef },
          thinkingDefault: "off",
          tools: { deny: DENIED_TOOL_GROUPS },
        },
      },
    },
    mcp: {
      servers: {
        ticketintake: {
          command: o.bunBin ?? "bun",
          args: ["run", `${o.releaseDir}/apps/tieulinh/mcp/tieulinh/index.ts`],
          env: mcpEnv,
        },
      },
    },
    tools: { deny: DENIED_TOOL_GROUPS },
    channels: {},
    plugins: { entries: {} },
  };
}
