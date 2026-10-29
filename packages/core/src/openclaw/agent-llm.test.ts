import { describe, expect, it } from "bun:test";
import { readAgentLlm, loadAgentLlm, resolveSecretValue } from "./agent-llm";

describe("@vuihoc/bot-core/openclaw — agent-llm resolver", () => {
  const sampleConfig = {
    agents: {
      defaults: {
        model: {
          primary: "custom-ai/MiniMax-M3.1-Flash",
          fallbacks: ["openai/gpt-4o-mini"],
        },
      },
      list: [
        {
          id: "op-agent",
          model: {
            primary: "op-deepseek/deepseek-v4.1-flash",
            fallbacks: ["custom-ai/MiniMax-M3.1-Flash"],
          },
        },
        {
          id: "default-agent",
        },
      ],
      entries: {
        "cm-support": {
          model: {
            primary: "custom-ai/MiniMax-M3.1-Flash",
            fallbacks: [],
          },
        },
      },
    },
    models: {
      providers: {
        "op-deepseek": {
          baseUrl: "https://deepseek.example.internal:8090",
          api: "anthropic-messages",
          apiKey: {
            source: "file",
            provider: "op_deepseek_file",
          },
        },
        "custom-ai": {
          baseUrl: "https://api.custom-ai.internal",
          api: "anthropic-messages",
          apiKey: "sk-plain-custom-key",
        },
      },
    },
    secrets: {
      providers: {
        op_deepseek_file: {
          source: "file",
          path: "~/.openclaw/secrets/op-deepseek.key",
        },
      },
    },
  };

  it("phân giải đúng model, provider, baseUrl và apiKey tĩnh", () => {
    const res = readAgentLlm(sampleConfig, "cm-support");
    expect(res).not.toBeNull();
    expect(res?.agentId).toBe("cm-support");
    expect(res?.model).toBe("MiniMax-M3.1-Flash");
    expect(res?.rawModel).toBe("custom-ai/MiniMax-M3.1-Flash");
    expect(res?.provider).toBe("custom-ai");
    expect(res?.baseUrl).toBe("https://api.custom-ai.internal");
    expect(res?.apiKey).toBe("sk-plain-custom-key");
    expect(res?.api).toBe("anthropic-messages");
  });

  it("phân giải apiKey từ file secret và model của agent trong agents.list", () => {
    const mockReadFile = (path: string) => {
      if (path.includes("op-deepseek.key")) return "sk-mocked-deepseek-token";
      return "";
    };
    const res = readAgentLlm(sampleConfig, "op-agent", mockReadFile);
    expect(res).not.toBeNull();
    expect(res?.agentId).toBe("op-agent");
    expect(res?.model).toBe("deepseek-v4.1-flash");
    expect(res?.provider).toBe("op-deepseek");
    expect(res?.baseUrl).toBe("https://deepseek.example.internal:8090");
    expect(res?.apiKey).toBe("sk-mocked-deepseek-token");
    expect(res?.fallbacks).toEqual(["custom-ai/MiniMax-M3.1-Flash"]);
  });

  it("loadAgentLlm đọc file JSON và phân giải chính xác", () => {
    const mockFs = (_p: string) => JSON.stringify(sampleConfig);
    const res = loadAgentLlm("/fake/openclaw.json", "op-agent", mockFs);
    expect(res?.model).toBe("deepseek-v4.1-flash");
  });

  it("resolveSecretValue trả về chuỗi trực tiếp hoặc null khi không hợp lệ", () => {
    expect(resolveSecretValue("plain-key", sampleConfig)).toBe("plain-key");
    expect(resolveSecretValue(123, sampleConfig)).toBeNull();
  });

  it("trả về null nếu config rỗng hoặc không có agents", () => {
    expect(readAgentLlm(null, "any")).toBeNull();
    expect(readAgentLlm({}, "any")).toBeNull();
  });

  it("fallback về agents.defaults khi agent không chỉ định model riêng", () => {
    const res = readAgentLlm(sampleConfig, "default-agent");
    expect(res).not.toBeNull();
    expect(res?.agentId).toBe("default-agent");
    expect(res?.model).toBe("MiniMax-M3.1-Flash");
    expect(res?.provider).toBe("custom-ai");
  });

  it("trả về null nếu config rỗng hoặc không có agents", () => {
    expect(readAgentLlm(null, "any")).toBeNull();
    expect(readAgentLlm({}, "any")).toBeNull();
  });
});
