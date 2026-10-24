/**
 * Gọi mô hình ngôn ngữ (LLM) để trích xuất hoặc tổng hợp thông tin.
 *
 * Sống ở `worker/` nhưng có thể dùng lại ở các script/tool khác. Không phụ
 * thuộc thư viện ngoài — gọi HTTP trần.
 */
import { existsSync } from "node:fs";
import { getLogger } from "../lib/logger";

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * "openai" (mặc định) gọi /chat/completions; "anthropic" gọi /v1/messages (x-api-key, system
   * rời khỏi messages); "openclaw" không gọi HTTP nào cả — chạy CLI `openclaw infer model run`,
   * dùng lại phiên đăng nhập/model mà gateway OpenClaw đang chạy đã có sẵn (tạm thời, khi chưa
   * có endpoint LLM riêng). `model` khi đó là chuỗi `provider/model` (vd "openai/gpt-5.6-luna").
   */
  api?: "openai" | "anthropic" | "openclaw";
}

/** Đọc OPENAI_API_STYLE thành union hợp lệ, mặc định "openai" cho giá trị lạ/rỗng. */
export function parseApiStyle(value: string | undefined): LlmConfig["api"] {
  return value === "anthropic" || value === "openclaw" ? value : "openai";
}

/**
 * Cấu hình LLM từ env — MỘT chỗ cho MCP, worker và script. Mặc định trên server:
 * OPENAI_API_STYLE=openclaw + OPENAI_MODEL=openai/gpt-5.6-luna, tức dùng luôn model
 * OpenClaw đang đăng nhập, không cần URL/key riêng.
 */
export function llmConfigFromEnv(env: Record<string, string | undefined> = process.env): LlmConfig {
  return {
    api: parseApiStyle(env.OPENAI_API_STYLE),
    baseUrl: env.OPENAI_BASE_URL ?? "",
    apiKey: env.OPENAI_API_KEY ?? "",
    model: env.OPENAI_MODEL ?? "gpt-4o-mini",
  };
}

/** Đủ cấu hình để gọi: OpenClaw chỉ cần model; HTTP cần URL. */
export function isLlmConfigured(config: LlmConfig | undefined): config is LlmConfig {
  if (!config?.model) return false;
  return config.api === "openclaw" ? true : Boolean(config.baseUrl);
}

/** Lỗi 4xx: request sai, đổi model cũng không cứu được. */
class LlmClientError extends Error {}

/**
 * `config.model` có thể là danh sách cách nhau bằng dấu phẩy ("a,b"): model
 * trước lỗi 5xx/mạng thì thử model sau. Proxy AI cục bộ hay có model chết
 * (vd agya/gemini-3.8-flash trả 503 ngày 24/09) — không có dự phòng thì
 * extractor rơi về nhánh không LLM, tiêu đề bị cắt cụt.
 */
export async function complete(
  config: LlmConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const models = config.model
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  let lastError: Error = new Error("Chưa cấu hình model LLM");
  for (const [i, model] of models.entries()) {
    try {
      return await completeOnce({ ...config, model }, systemPrompt, userPrompt);
    } catch (err: any) {
      lastError = err;
      if (err instanceof LlmClientError || i === models.length - 1) break;
      getLogger().warn(`[llm] Model ${model} lỗi (${err.message.slice(0, 120)}) — thử ${models[i + 1]}`);
    }
  }
  throw lastError;
}

async function completeOpenAi(config: LlmConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      // local-router (26/09) mặc định trả SSE khi không ghi rõ → res.json() vỡ.
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const msg = `LLM trả HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    throw res.status >= 400 && res.status < 500 && res.status !== 429 ? new LlmClientError(msg) : new Error(msg);
  }
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? "";
}

async function completeAnthropic(config: LlmConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(config.apiKey ? { "x-api-key": config.apiKey } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const msg = `LLM trả HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    throw res.status >= 400 && res.status < 500 && res.status !== 429 ? new LlmClientError(msg) : new Error(msg);
  }
  const body = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  return body.content?.find((c) => c.type === "text")?.text ?? "";
}

async function completeOpenclaw(config: LlmConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  const legacyBin = "/usr/local/bin/openclaw";
  const bin = process.env.OPENCLAW_BIN || (existsSync(legacyBin) ? legacyBin : "openclaw");
  const proc = Bun.spawn(
    [bin, "infer", "model", "run", "--model", config.model, "--prompt", `${systemPrompt}\n\n${userPrompt}`, "--json"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => proc.kill(), 60_000);
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  clearTimeout(timer);

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`openclaw infer model run thoát mã ${exitCode}: ${stderr.slice(0, 200)}`);
  }
  const body = JSON.parse(stdout) as { ok?: boolean; outputs?: Array<{ text?: string }> };
  if (!body.ok) throw new Error(`openclaw infer model run báo lỗi: ${stdout.slice(0, 200)}`);
  return body.outputs?.[0]?.text ?? "";
}

async function completeOnce(config: LlmConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  const text =
    config.api === "anthropic"
      ? await completeAnthropic(config, systemPrompt, userPrompt)
      : config.api === "openclaw"
      ? await completeOpenclaw(config, systemPrompt, userPrompt)
      : await completeOpenAi(config, systemPrompt, userPrompt);
  if (!text) getLogger().warn(`[llm] Model trả về rỗng.`);
  return text;
}

/** Trích xuất JSON từ câu trả lời của model, tự bóc ```json … ``` nếu có. */
export function extractJson<T = unknown>(raw: string): T | null {
  const cleaned = raw
    .replace(/^[\s\S]*?```(?:json)?\s*/i, "")
    .replace(/\s*```[\s\S]*$/, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}
