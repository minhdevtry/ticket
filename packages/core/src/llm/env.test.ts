import { describe, expect, it } from "bun:test";
import { ConfigError, loadConfig } from "../core/config";
import { createLlm, llmEnv, llmFromConfig } from "./index";

const FULL = {
  LLM_BASE_URL: "http://127.0.0.1:18999",
  LLM_API_KEY: "proxy-injects-the-real-key",
  LLM_MODEL: "MiniMax-M3.1-Flash",
};

describe("llmEnv", () => {
  it("mặc định mọi biến tuỳ chọn, LLM_API mặc định anthropic-messages", () => {
    const cfg = loadConfig(llmEnv(), { env: {} });
    expect(cfg.values.LLM_BASE_URL).toBeUndefined();
    expect(cfg.values.LLM_API).toBe("anthropic-messages");
  });

  it("LLM_API_KEY là secret: bị che trong redacted và có trong secretValues", () => {
    const cfg = loadConfig(llmEnv(), {
      env: { ...FULL, LLM_API: "openai-chat", LLM_TIMEOUT_MS: "5000" },
    });
    expect(cfg.redacted.LLM_API_KEY).toBe("[REDACTED]");
    expect(cfg.redacted.LLM_BASE_URL).toBe(FULL.LLM_BASE_URL);
    expect(cfg.secretValues).toContain(FULL.LLM_API_KEY);
    expect(cfg.values.LLM_TIMEOUT_MS).toBe(5000);
    expect(cfg.values.LLM_API).toBe("openai-chat");
  });

  it("required: thiếu thì ConfigError gom đủ biến, không lộ giá trị", () => {
    const err = (() => {
      try {
        loadConfig(llmEnv({ required: true }), { env: { LLM_API_KEY: "secret-value-123" } });
      } catch (e) {
        return e as ConfigError;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(err!.issues.map((i) => i.name).sort()).toEqual(["LLM_BASE_URL", "LLM_MODEL"]);
    expect(err!.message).not.toContain("secret-value-123");
  });

  it("từ chối LLM_API lạ và URL sai", () => {
    expect(() => loadConfig(llmEnv(), { env: { LLM_API: "gemini" } })).toThrow(ConfigError);
    expect(() => loadConfig(llmEnv(), { env: { LLM_BASE_URL: "không phải url" } })).toThrow(
      ConfigError,
    );
  });
});

describe("llmFromConfig", () => {
  it("không đặt gì thì undefined", () => {
    expect(llmFromConfig({})).toBeUndefined();
  });

  it("đủ ba biến thì dựng client đúng api và model", () => {
    const llm = llmFromConfig({ ...FULL, LLM_API: "openai-chat" });
    expect(llm).toBeDefined();
    expect(llm!.api).toBe("openai-chat");
    expect(llm!.model).toBe("MiniMax-M3.1-Flash");
    expect(llmFromConfig(FULL)!.api).toBe("anthropic-messages");
  });

  it("đặt một phần thì ConfigError nêu biến thiếu", () => {
    const err = (() => {
      try {
        llmFromConfig({ LLM_BASE_URL: FULL.LLM_BASE_URL });
      } catch (e) {
        return e as ConfigError;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(err!.issues.map((i) => i.name)).toEqual(["LLM_API_KEY", "LLM_MODEL"]);
  });

  it("createLlm không có giá trị mặc định nào cho URL/key", () => {
    // @ts-expect-error baseUrl bắt buộc
    expect(() => createLlm({ apiKey: "k", model: "m", api: "openai-chat" })).toThrow();
  });
});
