/**
 * Vòng lặp tool: model gọi tool → bot chạy → trả kết quả → lặp tới khi model trả lời xong.
 *
 * Nguyên tắc:
 *  - Tham số tool luôn được kiểm bằng zod TRƯỚC khi chạy; sai thì model nhận một thông điệp lỗi
 *    nói rõ trường nào sai và được thử lại, tool không bao giờ chạy với tham số sai.
 *  - Tool ném lỗi thì thông điệp lỗi quay về model (nó có thể tự sửa); riêng huỷ (`signal`)
 *    thì ném thẳng ra ngoài.
 *  - Có trần số bước và trần token; vượt trần thì dừng và nói rõ lý do trong `finishReason`.
 *  - Thông điệp gửi cho model viết bằng tiếng Anh (model theo chỉ dẫn tốt nhất bằng tiếng Anh);
 *    văn bản cho người dùng cuối là việc của handler.
 */
import { z } from "zod";
import { LlmAbortError, LlmConfigError } from "./errors";
import type {
  Llm,
  LlmMessage,
  LlmResponse,
  LlmToolCall,
  LlmToolChoice,
  LlmToolSpec,
  LlmUsage,
} from "./types";

/** Ngữ cảnh truyền cho `run` của tool. */
export interface ToolRunContext {
  /** Huỷ khi cả vòng lặp bị huỷ: truyền cho `fetch` bên trong tool. */
  signal: AbortSignal | undefined;
  /** Id lời gọi tool của model. */
  toolCallId: string;
  /** Số thứ tự bước (từ 1). */
  step: number;
}

/** Một tool model được phép gọi. Dựng bằng {@link defineLlmTool}. */
export interface LlmTool<S extends z.ZodType = z.ZodType> {
  /** Tên model gọi: chữ, số, `_`, `-` (tối đa 64 ký tự). */
  name: string;
  /** Một đến hai câu để model biết khi nào nên gọi. */
  description: string;
  /** Schema zod của tham số; phải là `z.object(...)`. */
  schema: S;
  /**
   * Chạy tool với tham số đã kiểm. Trả chuỗi, hoặc giá trị JSON (được `JSON.stringify`). Thông điệp
   * của lỗi ném ra được gửi cho model: đừng đưa secret vào đó.
   */
  run(args: z.output<S>, ctx: ToolRunContext): Promise<unknown> | unknown;
}

/** Tool đã xoá tham số kiểu, dùng cho mảng hỗn hợp. */
export type AnyLlmTool = LlmTool<z.ZodType>;

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Khai báo một tool. Kiểm tên và schema ngay lúc khai báo (ném `LlmConfigError`), để lỗi hiện
 * lúc nạp module chứ không phải giữa một run.
 */
export function defineLlmTool<S extends z.ZodType>(tool: LlmTool<S>): LlmTool<S> {
  if (!TOOL_NAME.test(tool.name)) {
    throw new LlmConfigError(`Tên tool "${tool.name}" không hợp lệ (chữ, số, _ hoặc -, tối đa 64)`);
  }
  if (toolParameters(tool.schema).type !== "object") {
    throw new LlmConfigError(`Schema của tool "${tool.name}" phải là z.object(...)`);
  }
  return tool;
}

/** JSON Schema tham số của một schema zod (không có `$schema`). */
export function toolParameters(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  return json;
}

/** Khai báo tool dưới dạng `LlmToolSpec` để gửi cho model. */
export function toolSpec(tool: AnyLlmTool): LlmToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    parameters: toolParameters(tool.schema),
  };
}

/** Kết quả chạy một lời gọi tool. */
export interface ToolExecution {
  call: LlmToolCall;
  /** Nội dung đã gửi lại cho model. */
  content: string;
  /** Tham số sai, tool không tồn tại hoặc tool ném lỗi. */
  isError: boolean;
  durationMs: number;
}

/** Một bước của vòng lặp: một lời gọi model và các tool nó yêu cầu. */
export interface ToolLoopStep {
  /** Từ 1. */
  index: number;
  response: LlmResponse;
  /** Rỗng ở bước cuối (model trả lời bằng văn bản). */
  executions: ToolExecution[];
}

/** Vì sao vòng lặp dừng. */
export type ToolLoopFinishReason = "end" | "max_steps" | "budget" | "max_tokens";

/** Tuỳ chọn của {@link runToolLoop}. */
export interface ToolLoopOptions {
  llm: Llm;
  system?: string;
  messages: readonly LlmMessage[];
  tools: readonly AnyLlmTool[];
  /** Số lần gọi model tối đa. Mặc định 8. */
  maxSteps?: number;
  /** Trần tổng token (vào + ra) của cả vòng; kiểm trước mỗi lời gọi và sau mỗi bước. Mặc định không giới hạn. */
  maxTotalTokens?: number;
  /** Trần ký tự của kết quả một tool gửi cho model (cắt kèm ghi chú). Mặc định 16 000. */
  maxToolResultChars?: number;
  maxTokens?: number;
  temperature?: number;
  toolChoice?: LlmToolChoice;
  /** Huỷ vòng lặp (kể cả lời gọi model đang chạy): ném `LlmAbortError`. */
  signal?: AbortSignal;
  /** Gọi sau MỖI bước, trước khi sang bước kế. Lỗi ném ra từ đây dừng vòng lặp. */
  onStep?: (step: ToolLoopStep) => void | Promise<void>;
}

/** Kết quả của {@link runToolLoop}. */
export interface ToolLoopResult {
  /** Văn bản cuối của model (`""` nếu dừng vì trần mà model chưa nói gì). */
  text: string;
  finishReason: ToolLoopFinishReason;
  steps: ToolLoopStep[];
  /** Toàn bộ hội thoại sau vòng lặp (gồm tin nhắn đầu vào). */
  messages: LlmMessage[];
  /** Tổng token của mọi lời gọi model. */
  usage: LlmUsage;
}

/** Cộng hai `LlmUsage`. */
export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** `LlmUsage` rỗng. */
export const ZERO_USAGE: LlmUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_RESULT_CHARS = 16_000;

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}

function clip(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n[truncated: ${text.length - max} more characters]`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "ok";
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
}

async function execute(
  call: LlmToolCall,
  tools: ReadonlyMap<string, AnyLlmTool>,
  signal: AbortSignal | undefined,
  step: number,
  maxChars: number,
): Promise<ToolExecution> {
  const started = Date.now();
  const done = (content: string, isError: boolean): ToolExecution => ({
    call,
    content: clip(content, maxChars),
    isError,
    durationMs: Date.now() - started,
  });

  const tool = tools.get(call.name);
  if (!tool) {
    return done(
      `Unknown tool "${call.name}". Available tools: ${[...tools.keys()].join(", ") || "(none)"}.`,
      true,
    );
  }
  if (call.argsError !== undefined) {
    return done(
      `Invalid arguments for tool "${call.name}": ${call.argsError}. Send a valid JSON object and call the tool again.`,
      true,
    );
  }
  const parsed = tool.schema.safeParse(call.args ?? {});
  if (!parsed.success) {
    return done(
      `Invalid arguments for tool "${call.name}": ${describeIssues(parsed.error)}. Fix the arguments and call the tool again.`,
      true,
    );
  }
  try {
    const result = await tool.run(parsed.data, { signal, toolCallId: call.id, step });
    return done(stringify(result), false);
  } catch (err) {
    if (signal?.aborted) throw new LlmAbortError();
    const message = err instanceof Error ? err.message : String(err);
    return done(`Tool "${call.name}" failed: ${message}`, true);
  }
}

/**
 * Chạy vòng lặp tool tới khi model trả lời bằng văn bản, hoặc chạm trần (`maxSteps`,
 * `maxTotalTokens`). Không ném khi chạm trần: đọc `finishReason`.
 *
 * Ném `LlmAbortError` khi `signal` huỷ; các lỗi của `llm.complete` (`LlmApiError`…) đi thẳng ra.
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const { llm, signal } = options;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new LlmConfigError("maxSteps phải là số nguyên >= 1");
  }
  const maxChars = options.maxToolResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const registry = new Map<string, AnyLlmTool>();
  for (const tool of options.tools) {
    if (registry.has(tool.name)) throw new LlmConfigError(`Trùng tên tool "${tool.name}"`);
    registry.set(tool.name, tool);
  }
  const specs = options.tools.map(toolSpec);

  const messages: LlmMessage[] = [...options.messages];
  const steps: ToolLoopStep[] = [];
  let usage: LlmUsage = ZERO_USAGE;
  let finishReason: ToolLoopFinishReason = "max_steps";
  let text = "";

  const overBudget = () =>
    options.maxTotalTokens !== undefined && usage.totalTokens >= options.maxTotalTokens;

  for (let index = 1; index <= maxSteps; index++) {
    if (signal?.aborted) throw new LlmAbortError();
    if (overBudget()) {
      finishReason = "budget";
      break;
    }
    const response = await llm.complete({
      system: options.system,
      messages,
      tools: specs.length > 0 ? specs : undefined,
      toolChoice: options.toolChoice,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      signal,
    });
    usage = addUsage(usage, response.usage);
    messages.push(response.message);
    text = response.text;

    const step: ToolLoopStep = { index, response, executions: [] };
    steps.push(step);

    if (response.toolCalls.length === 0) {
      finishReason = response.stopReason === "max_tokens" ? "max_tokens" : "end";
      await options.onStep?.(step);
      break;
    }
    for (const call of response.toolCalls) {
      const execution = await execute(call, registry, signal, index, maxChars);
      step.executions.push(execution);
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: execution.content,
        isError: execution.isError || undefined,
      });
    }
    await options.onStep?.(step);
    if (overBudget()) {
      finishReason = "budget";
      break;
    }
    if (index === maxSteps) finishReason = "max_steps";
  }

  return { text, finishReason, steps, messages, usage };
}
