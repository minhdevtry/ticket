/**
 * Cấu hình LLM từ biến môi trường: `llmEnv()` để gộp vào `defineEnv`, `llmFromConfig` để dựng
 * client từ giá trị đã nạp. `createBot` tự đọc các biến này (không cần khai trong `env` của bot)
 * và đưa client tới handler qua `ctx.llm`.
 */
import { z } from "zod";
import { type EnvSchema, ConfigError, type ConfigIssue, defineEnv, secret } from "../core/config";
import { type CreateLlmOptions, createLlm } from "./client";
import type { Llm } from "./types";

const API = z.enum(["anthropic-messages", "openai-chat"]);

function optionalShape() {
  return {
    LLM_BASE_URL: z.url().optional(),
    LLM_API_KEY: secret(z.string().min(1).optional()),
    LLM_MODEL: z.string().min(1).optional(),
    LLM_API: API.default("anthropic-messages"),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(1).optional(),
    LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(10).optional(),
  };
}

function requiredShape() {
  return {
    ...optionalShape(),
    LLM_BASE_URL: z.url(),
    LLM_API_KEY: secret(z.string().min(1)),
    LLM_MODEL: z.string().min(1),
  };
}

/**
 * Schema env cho LLM. Mặc định mọi biến tuỳ chọn (bot chạy không LLM); `{ required: true }` bắt
 * `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` phải có, thiếu thì bot không khởi động được.
 * `LLM_API` mặc định `anthropic-messages`.
 */
export function llmEnv(options: { required: true }): EnvSchema<ReturnType<typeof requiredShape>>;
export function llmEnv(options?: { required?: false }): EnvSchema<ReturnType<typeof optionalShape>>;
export function llmEnv(options: { required?: boolean } = {}): EnvSchema<any> {
  return defineEnv(options.required ? requiredShape() : optionalShape());
}

/** Giá trị cấu hình LLM đã nạp (tập con của `ctx.config` hoặc `loadConfig(llmEnv())`). */
export interface LlmConfigValues {
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_API?: "anthropic-messages" | "openai-chat";
  LLM_TIMEOUT_MS?: number;
  LLM_MAX_RETRIES?: number;
}

/**
 * Dựng client từ giá trị đã nạp. Không đặt biến nào của `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`
 * thì trả `undefined` (bot không dùng LLM); đặt một phần thì ném `ConfigError` nêu biến còn
 * thiếu (cấu hình dở dang gần như chắc chắn là nhầm).
 */
export function llmFromConfig(
  values: LlmConfigValues,
  extra: Pick<CreateLlmOptions, "fetch" | "onUsage" | "sleep"> = {},
): Llm | undefined {
  const required = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"] as const;
  const present = required.filter((name) => Boolean(values[name]));
  if (present.length === 0) return undefined;
  if (present.length < required.length) {
    const issues: ConfigIssue[] = required
      .filter((name) => !values[name])
      .map((name) => ({
        name,
        kind: "missing",
        message: `chưa đặt (cần đủ ${required.join(", ")} khi dùng LLM)`,
      }));
    throw new ConfigError(issues, "llm");
  }
  return createLlm({
    baseUrl: values.LLM_BASE_URL as string,
    apiKey: values.LLM_API_KEY as string,
    model: values.LLM_MODEL as string,
    api: values.LLM_API ?? "anthropic-messages",
    timeoutMs: values.LLM_TIMEOUT_MS,
    maxRetries: values.LLM_MAX_RETRIES,
    ...extra,
  });
}
