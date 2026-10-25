/**
 * Chuyển đổi giữa hình dạng trung lập (`LlmRequest`/`LlmResponse`) và hai kiểu API:
 *  - `anthropic-messages`: `POST {base}/v1/messages`, `x-api-key`, `system` rời khỏi `messages`,
 *    kết quả tool là khối `tool_result` trong tin nhắn `user`;
 *  - `openai-chat`: `POST {base}/chat/completions`, `Authorization: Bearer`, tham số tool là
 *    chuỗi JSON, kết quả tool là tin nhắn `role: "tool"`.
 *
 * Hình dạng đã đối chiếu với proxy dev (`tools/tl2-shadow/proxy.ts`): chỉ hai đường dẫn
 * `/v1/messages` và `/v1/chat/completions`, thân JSON có `model`, và chỉ các header
 * `content-type`, `accept`, `anthropic-version`, `anthropic-beta` được chuyển tiếp (proxy tự
 * gắn khoá thật).
 */
import { LlmResponseError } from "./errors";
import type {
  LlmApi,
  LlmAssistantMessage,
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmStopReason,
  LlmToolCall,
  LlmToolChoice,
  LlmUsage,
} from "./types";

type Json = Record<string, unknown>;

/** Phiên bản header `anthropic-version` (proxy dev chuyển tiếp header này). */
export const ANTHROPIC_VERSION = "2023-06-01";

const DEFAULT_MAX_TOKENS = 4096;

const asObject = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

function usageOf(input: number, output: number, total?: number): LlmUsage {
  return { inputTokens: input, outputTokens: output, totalTokens: total || input + output };
}

/** URL của endpoint theo quy ước base URL đã dùng trong repo (xem `providerBaseUrl`). */
export function endpointUrl(api: LlmApi, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (api === "anthropic-messages") {
    // SDK Anthropic tự thêm /v1/messages vào base không có /v1; chịu cả base đã có /v1.
    return `${base.replace(/\/v1$/, "")}/v1/messages`;
  }
  return `${base}/chat/completions`;
}

/** Header của một request (không gồm secret ngoài đúng một header xác thực). */
export function requestHeaders(api: LlmApi, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (api === "anthropic-messages") {
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    if (apiKey) headers["x-api-key"] = apiKey;
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

// ── Anthropic Messages ───────────────────────────────────────────────────────

function anthropicToolChoice(choice: LlmToolChoice): Json {
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.name };
}

function anthropicMessages(messages: readonly LlmMessage[]): Json[] {
  const out: Json[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      if (m.raw?.api === "anthropic-messages" && Array.isArray(m.raw.value)) {
        out.push({ role: "assistant", content: m.raw.value });
        continue;
      }
      const blocks: Json[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const call of m.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: asObject(call.args) ?? {},
        });
      }
      out.push({ role: "assistant", content: blocks.length > 0 ? blocks : m.content });
    } else {
      const block: Json = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      if (m.isError) block.is_error = true;
      const last = out[out.length - 1];
      // Nhiều kết quả tool liền nhau phải nằm chung MỘT tin nhắn user.
      if (last && last.role === "user" && Array.isArray(last.content) && last.__tool) {
        (last.content as Json[]).push(block);
      } else {
        out.push({ role: "user", content: [block], __tool: true });
      }
    }
  }
  return out.map(({ __tool, ...rest }) => rest);
}

/** Thân request kiểu Anthropic Messages. */
export function buildAnthropicBody(request: LlmRequest, model: string): Json {
  const body: Json = {
    model,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: anthropicMessages(request.messages),
    stream: false,
  };
  if (request.system) body.system = request.system;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
    if (request.toolChoice) body.tool_choice = anthropicToolChoice(request.toolChoice);
  }
  return body;
}

const ANTHROPIC_STOP: Record<string, LlmStopReason> = {
  end_turn: "end",
  stop_sequence: "end",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  refusal: "content_filter",
};

/** Đọc phản hồi kiểu Anthropic Messages. Ném `LlmResponseError` nếu sai hình dạng. */
export function parseAnthropicResponse(json: unknown, requestedModel: string): LlmResponse {
  const root = asObject(json);
  const content = root?.content;
  if (!root || !Array.isArray(content)) {
    throw new LlmResponseError("Phản hồi LLM (anthropic-messages) thiếu mảng `content`");
  }
  let text = "";
  const toolCalls: LlmToolCall[] = [];
  let hasExtra = false;
  for (const raw of content) {
    const block = asObject(raw);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: String(block.id ?? ""),
        name: String(block.name ?? ""),
        args: block.input ?? {},
      });
    } else hasExtra = true; // thinking, redacted_thinking…
  }
  const usage = asObject(root.usage);
  const stopRaw = typeof root.stop_reason === "string" ? root.stop_reason : "";
  const stopReason: LlmStopReason =
    toolCalls.length > 0 ? "tool_use" : (ANTHROPIC_STOP[stopRaw] ?? "other");
  const message: LlmAssistantMessage = {
    role: "assistant",
    content: text,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(hasExtra ? { raw: { api: "anthropic-messages" as const, value: content } } : {}),
  };
  return {
    text,
    toolCalls,
    stopReason,
    usage: usageOf(num(usage?.input_tokens), num(usage?.output_tokens)),
    model: typeof root.model === "string" ? root.model : requestedModel,
    message,
  };
}

// ── OpenAI Chat Completions ──────────────────────────────────────────────────

function openaiToolChoice(choice: LlmToolChoice): unknown {
  if (typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

function openaiMessages(system: string | undefined, messages: readonly LlmMessage[]): Json[] {
  const out: Json[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    } else {
      const content =
        m.raw?.api === "openai-chat" && typeof m.raw.value === "string" ? m.raw.value : m.content;
      const msg: Json = { role: "assistant", content: content || null };
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        }));
      }
      out.push(msg);
    }
  }
  return out;
}

/** Thân request kiểu OpenAI Chat Completions. */
export function buildOpenAiBody(request: LlmRequest, model: string): Json {
  const body: Json = {
    model,
    messages: openaiMessages(request.system, request.messages),
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    // Một số router mặc định trả SSE khi không ghi rõ.
    stream: false,
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    if (request.toolChoice) body.tool_choice = openaiToolChoice(request.toolChoice);
  }
  return body;
}

const OPENAI_STOP: Record<string, LlmStopReason> = {
  stop: "end",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
  content_filter: "content_filter",
};

/** Bỏ khối `<think>…</think>` (MiniMax và vài model khác nhúng suy luận vào `content`). */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .replace(/^\s*<think>[\s\S]*$/, "")
    .trim();
}

/** Đọc phản hồi kiểu OpenAI Chat Completions. Ném `LlmResponseError` nếu sai hình dạng. */
export function parseOpenAiResponse(json: unknown, requestedModel: string): LlmResponse {
  const root = asObject(json);
  const choices = root?.choices;
  const choice = Array.isArray(choices) ? asObject(choices[0]) : null;
  const msg = asObject(choice?.message);
  if (!root || !choice || !msg) {
    throw new LlmResponseError("Phản hồi LLM (openai-chat) thiếu `choices[0].message`");
  }
  const rawContent = typeof msg.content === "string" ? msg.content : "";
  const text = stripThinking(rawContent);
  const toolCalls: LlmToolCall[] = [];
  if (Array.isArray(msg.tool_calls)) {
    for (const raw of msg.tool_calls) {
      const call = asObject(raw);
      const fn = asObject(call?.function);
      if (!call || !fn) continue;
      const call_: LlmToolCall = {
        id: String(call.id ?? ""),
        name: String(fn.name ?? ""),
        args: {},
      };
      const argText = typeof fn.arguments === "string" ? fn.arguments.trim() : "";
      if (argText) {
        try {
          call_.args = JSON.parse(argText);
        } catch (err) {
          call_.args = undefined;
          call_.argsError = `arguments are not valid JSON: ${(err as Error).message}`;
        }
      } else if (fn.arguments !== undefined && typeof fn.arguments === "object") {
        call_.args = fn.arguments; // vài proxy trả object thay vì chuỗi
      }
      toolCalls.push(call_);
    }
  }
  const usage = asObject(root.usage);
  const finish = typeof choice.finish_reason === "string" ? choice.finish_reason : "";
  const message: LlmAssistantMessage = {
    role: "assistant",
    content: text,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(rawContent !== text && rawContent
      ? { raw: { api: "openai-chat" as const, value: rawContent } }
      : {}),
  };
  return {
    text,
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool_use" : (OPENAI_STOP[finish] ?? "other"),
    usage: usageOf(
      num(usage?.prompt_tokens),
      num(usage?.completion_tokens),
      num(usage?.total_tokens),
    ),
    model: typeof root.model === "string" ? root.model : requestedModel,
    message,
  };
}
