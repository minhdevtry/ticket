/**
 * Vòng lặp tool: model gọi tool → bot chạy → trả kết quả → lặp tới khi model trả lời xong.
 *
 * Nguyên tắc:
 *  - Tham số tool luôn được kiểm bằng zod TRƯỚC khi chạy; sai thì model nhận một thông điệp lỗi
 *    nói rõ trường nào sai và được thử lại, tool không bao giờ chạy với tham số sai.
 *  - Tool ném lỗi thì thông điệp lỗi quay về model (nó có thể tự sửa); riêng huỷ (`signal`)
 *    thì ném thẳng ra ngoài.
 *  - Có trần số bước và trần token; vượt trần thì dừng và nói rõ lý do trong `finishReason`.
 *  - Bước CUỐI (`maxSteps`) gửi `toolChoice: "none"` và không chạy tool nào model lỡ gọi (kết quả
 *    sẽ không ai đọc); khối tool_use bị cắt bởi `max_tokens` cũng không chạy.
 *  - Có hạn tổng `deadlineMs` cho cả vòng và hạn `toolTimeoutMs` cho từng tool.
 *  - Thông điệp gửi cho model viết bằng tiếng Anh (model theo chỉ dẫn tốt nhất bằng tiếng Anh);
 *    văn bản cho người dùng cuối là việc của handler.
 */
import { z } from "zod";
import { LlmAbortError, LlmConfigError, LlmTimeoutError } from "./errors";
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
  /**
   * Hạn cho một lần chạy tool (ms), ghi đè `toolTimeoutMs` của vòng lặp; `0` = không giới hạn.
   * Quá hạn thì `signal` của tool bị huỷ và model nhận lỗi "timed out" (tool không còn được chờ,
   * nhưng nếu nó phớt lờ `signal` thì phần việc đang dở vẫn có thể chạy nốt).
   */
  timeoutMs?: number;
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
  /** Tham số sai, tool không tồn tại, tool ném lỗi/quá hạn, hoặc không được chạy (`skipped`). */
  isError: boolean;
  durationMs: number;
  /** Tool KHÔNG được chạy (bước cuối, hoặc lời gọi bị cắt bởi `max_tokens`). */
  skipped?: true;
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
export type ToolLoopFinishReason = "end" | "max_steps" | "budget" | "max_tokens" | "refused";

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
  /** Không gửi nếu bỏ trống. */
  temperature?: number;
  /**
   * Ép model chọn tool, CHỈ áp cho bước 1; các bước sau là `auto` (ép mãi thì model không bao giờ
   * được trả lời và vòng lặp không kết thúc). Bước cuối luôn là `none`, trừ khi `maxSteps` là 1.
   */
  toolChoice?: LlmToolChoice;
  /**
   * Hạn TỔNG (ms) cho cả vòng lặp (model + tool). Mặc định không giới hạn. Quá hạn ném
   * `LlmTimeoutError` (`scope: "deadline"`), không phải `finishReason`, vì kết quả dở dang
   * không dùng được.
   */
  deadlineMs?: number;
  /** Hạn mặc định cho MỖI lần chạy tool (ms); `LlmTool.timeoutMs` ghi đè. Mặc định 60 000; `0` = không giới hạn. */
  toolTimeoutMs?: number;
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
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

/** `LlmUsage` rỗng. */
export const ZERO_USAGE: LlmUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_RESULT_CHARS = 16_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

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

function skipped(call: LlmToolCall, reason: string): ToolExecution {
  return {
    call,
    content: `Tool "${call.name}" was not run: ${reason}`,
    isError: true,
    durationMs: 0,
    skipped: true,
  };
}

async function execute(
  call: LlmToolCall,
  tools: ReadonlyMap<string, AnyLlmTool>,
  signal: AbortSignal | undefined,
  step: number,
  maxChars: number,
  defaultTimeoutMs: number,
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

  const timeoutMs = tool.timeoutMs ?? defaultTimeoutMs;
  const toolAbort = new AbortController();
  const toolSignal = signal ? AbortSignal.any([signal, toolAbort.signal]) : toolAbort.signal;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const guards: Promise<never>[] = [];
  if (timeoutMs > 0) {
    guards.push(
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          toolAbort.abort();
          reject(new Error(`timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }),
    );
  }
  if (signal) {
    guards.push(
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new LlmAbortError());
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    );
  }
  try {
    const result = await Promise.race([
      Promise.resolve().then(() =>
        tool.run(parsed.data, { signal: toolSignal, toolCallId: call.id, step }),
      ),
      ...guards,
    ]);
    return done(stringify(result), false);
  } catch (err) {
    if (!timedOut && signal?.aborted) throw new LlmAbortError();
    const message = err instanceof Error ? err.message : String(err);
    return done(`Tool "${call.name}" failed: ${message}`, true);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Chạy vòng lặp tool tới khi model trả lời bằng văn bản, hoặc chạm trần (`maxSteps`,
 * `maxTotalTokens`). Không ném khi chạm trần: đọc `finishReason`.
 *
 * Ném `LlmAbortError` khi `signal` huỷ, `LlmTimeoutError` (`scope: "deadline"`) khi quá
 * `deadlineMs`; các lỗi của `llm.complete` (`LlmApiError`…) đi thẳng ra.
 *
 * Nếu bọc trong run mà để lỗi tạm thời (`transient`) bay ra khỏi handler, server chạy lại CẢ
 * handler, tức mọi tool đã chạy sẽ chạy lần nữa: tool có tác dụng phụ phải tự chống trùng.
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const { llm, signal } = options;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new LlmConfigError("maxSteps phải là số nguyên >= 1");
  }
  const maxChars = options.maxToolResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const registry = new Map<string, AnyLlmTool>();
  for (const tool of options.tools) {
    if (registry.has(tool.name)) throw new LlmConfigError(`Trùng tên tool "${tool.name}"`);
    registry.set(tool.name, tool);
  }
  const specs = options.tools.map(toolSpec);

  const deadlineMs = options.deadlineMs ?? 0;
  const deadlineSignal = deadlineMs > 0 ? AbortSignal.timeout(deadlineMs) : undefined;
  const loopSignal =
    signal && deadlineSignal
      ? AbortSignal.any([signal, deadlineSignal])
      : (signal ?? deadlineSignal);
  const deadlineHit = () => !!deadlineSignal?.aborted && !signal?.aborted;
  const timeoutError = () => new LlmTimeoutError(deadlineMs, "deadline");
  /** Đổi lỗi huỷ do hạn tổng gây ra thành lỗi hết giờ; lỗi khác đi nguyên. */
  const translate = (err: unknown): unknown =>
    deadlineHit() && (err instanceof LlmAbortError || (err as Error)?.name === "AbortError")
      ? timeoutError()
      : err;

  const messages: LlmMessage[] = [...options.messages];
  const steps: ToolLoopStep[] = [];
  let usage: LlmUsage = ZERO_USAGE;
  let finishReason: ToolLoopFinishReason = "max_steps";
  let text = "";

  const overBudget = () =>
    options.maxTotalTokens !== undefined && usage.totalTokens >= options.maxTotalTokens;

  const pushResults = (executions: readonly ToolExecution[]) => {
    for (const execution of executions) {
      messages.push({
        role: "tool",
        toolCallId: execution.call.id,
        name: execution.call.name,
        content: execution.content,
        isError: execution.isError || undefined,
      });
    }
  };

  for (let index = 1; index <= maxSteps; index++) {
    if (signal?.aborted) throw new LlmAbortError();
    if (deadlineHit()) throw timeoutError();
    if (overBudget()) {
      finishReason = "budget";
      break;
    }
    const isFinal = index === maxSteps;
    // Ép tool chỉ ở bước 1; bước cuối cấm tool (trừ khi chỉ có đúng một bước và người dùng đã chọn).
    const toolChoice: LlmToolChoice | undefined =
      index === 1
        ? isFinal && !options.toolChoice
          ? "none"
          : options.toolChoice
        : isFinal
          ? "none"
          : undefined;
    let response: LlmResponse;
    try {
      response = await llm.complete({
        system: options.system,
        messages,
        tools: specs.length > 0 ? specs : undefined,
        toolChoice,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        signal: loopSignal,
      });
    } catch (err) {
      throw translate(err);
    }
    usage = addUsage(usage, response.usage);
    messages.push(response.message);
    text = response.text;

    const step: ToolLoopStep = { index, response, executions: [] };
    steps.push(step);

    if (response.toolCalls.length === 0) {
      finishReason =
        response.stopReason === "max_tokens"
          ? "max_tokens"
          : response.stopReason === "content_filter"
            ? "refused"
            : "end";
      await options.onStep?.(step);
      break;
    }

    if (response.stopReason === "max_tokens") {
      // Đầu ra bị cắt: tham số tool có thể thiếu nửa sau, chạy nó là chạy với dữ liệu sai.
      step.executions = response.toolCalls.map((call) =>
        skipped(call, "the reply was cut off at max_tokens, so the call may be incomplete"),
      );
      pushResults(step.executions);
      finishReason = "max_tokens";
      await options.onStep?.(step);
      break;
    }
    if (isFinal) {
      // Kết quả sẽ không ai đọc: đừng chạy (tránh tác dụng phụ vô nghĩa).
      step.executions = response.toolCalls.map((call) =>
        skipped(call, "the step limit was reached"),
      );
      pushResults(step.executions);
      finishReason = "max_steps";
      await options.onStep?.(step);
      break;
    }

    for (const call of response.toolCalls) {
      let execution: ToolExecution;
      try {
        execution = await execute(call, registry, loopSignal, index, maxChars, toolTimeoutMs);
      } catch (err) {
        throw translate(err);
      }
      step.executions.push(execution);
      pushResults([execution]);
    }
    await options.onStep?.(step);
    if (overBudget()) {
      finishReason = "budget";
      break;
    }
  }

  return { text, finishReason, steps, messages, usage };
}
