/**
 * LLM giả cho test: một HTTP server thật (Bun.serve, cổng ngẫu nhiên, chỉ loopback) nói cả hai
 * kiểu API (`POST /v1/messages` và `POST /v1/chat/completions`) và trả lời theo kịch bản. Dùng
 * với `createLlm` thật (HTTP thật) nên test bắt được lỗi ở tầng wire. Không gọi dịch vụ thật.
 *
 * Kịch bản: mỗi lời gọi lấy một "lượt" từ hàng đợi (`script`), hoặc hàm `respond` quyết định
 * theo request. Hết kịch bản thì trả 400 để test thấy ngay.
 */

/** Một lời gọi tool trong lượt trả lời của model. */
export interface FakeLlmToolCall {
  name: string;
  args: unknown;
  id?: string;
  /** Ghi đè nguyên văn chuỗi tham số (kiểu OpenAI) để mô phỏng JSON hỏng. */
  rawArgs?: string;
}

/** Một lượt trả lời của model giả. */
export interface FakeLlmTurn {
  text?: string;
  toolCalls?: FakeLlmToolCall[];
  /** Khối suy luận: `thinking` (anthropic) hoặc `<think>` trong content (openai). */
  thinking?: string;
  /** `input` là token KHÔNG cache; `cacheRead`/`cacheCreation` là token cache (mỗi API báo một kiểu). */
  usage?: { input: number; output: number; cacheRead?: number; cacheCreation?: number };
  /** Ghi đè lý do dừng theo cách gọi của từng API. */
  finish?: string;
  /** Trả lỗi HTTP thay vì phản hồi thường. */
  status?: number;
  headers?: Record<string, string>;
  /** Thân thô (ghi đè hoàn toàn thân phản hồi). */
  body?: string;
  /** Chờ trước khi trả (ms), để test timeout/huỷ. */
  delayMs?: number;
  model?: string;
}

/** Request đã nhận. */
export interface FakeLlmRequest {
  method: string;
  path: string;
  /** Header chữ thường. */
  headers: Record<string, string>;
  body: Record<string, any>;
  api: "anthropic-messages" | "openai-chat";
}

/** Server LLM giả. */
export class FakeLlm {
  readonly requests: FakeLlmRequest[] = [];
  private readonly turns: FakeLlmTurn[] = [];
  private responder: ((req: FakeLlmRequest) => FakeLlmTurn | undefined) | null = null;
  private server: ReturnType<typeof Bun.serve> | null = null;

  /** Bật server, trả URL gốc (không có đường dẫn). */
  start(): string {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => this.handle(req),
    });
    return this.origin;
  }

  get origin(): string {
    if (!this.server) throw new Error("FakeLlm chưa start()");
    return `http://127.0.0.1:${this.server.port}`;
  }

  /** `baseUrl` đúng quy ước của từng kiểu API (openai-chat có `/v1`). */
  baseUrl(api: "anthropic-messages" | "openai-chat"): string {
    return api === "anthropic-messages" ? this.origin : `${this.origin}/v1`;
  }

  async stop(): Promise<void> {
    await this.server?.stop(true);
    this.server = null;
  }

  /** Thêm các lượt vào cuối hàng đợi. */
  script(...turns: FakeLlmTurn[]): this {
    this.turns.push(...turns);
    return this;
  }

  /** Quyết định theo request; trả `undefined` thì rơi về hàng đợi `script`. */
  respond(fn: (req: FakeLlmRequest) => FakeLlmTurn | undefined): this {
    this.responder = fn;
    return this;
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const api =
      url.pathname === "/v1/messages"
        ? "anthropic-messages"
        : url.pathname === "/v1/chat/completions"
          ? "openai-chat"
          : null;
    if (!api || req.method !== "POST") return new Response("not found", { status: 404 });
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const body = (await req.json().catch(() => ({}))) as Record<string, any>;
    const record: FakeLlmRequest = { method: req.method, path: url.pathname, headers, body, api };
    this.requests.push(record);

    const turn = this.responder?.(record) ?? this.turns.shift();
    if (!turn)
      return Response.json({ error: { message: "FakeLlm: hết kịch bản" } }, { status: 400 });
    if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
    if (turn.body !== undefined) {
      return new Response(turn.body, {
        status: turn.status ?? 200,
        headers: { "content-type": "application/json", ...turn.headers },
      });
    }
    if (turn.status && turn.status >= 400) {
      return Response.json(
        { error: { message: `FakeLlm lỗi ${turn.status}` } },
        { status: turn.status, headers: turn.headers },
      );
    }
    const payload =
      api === "anthropic-messages" ? anthropicPayload(turn, body) : openaiPayload(turn, body);
    return Response.json(payload, { headers: turn.headers });
  }
}

function anthropicPayload(turn: FakeLlmTurn, body: Record<string, any>) {
  const content: unknown[] = [];
  if (turn.thinking) content.push({ type: "thinking", thinking: turn.thinking, signature: "sig" });
  if (turn.text) content.push({ type: "text", text: turn.text });
  (turn.toolCalls ?? []).forEach((c, i) => {
    content.push({ type: "tool_use", id: c.id ?? `toolu_${i}`, name: c.name, input: c.args });
  });
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: turn.model ?? body.model,
    content,
    stop_reason: turn.finish ?? ((turn.toolCalls?.length ?? 0) > 0 ? "tool_use" : "end_turn"),
    usage: {
      input_tokens: turn.usage?.input ?? 10,
      output_tokens: turn.usage?.output ?? 5,
      ...(turn.usage?.cacheRead !== undefined
        ? { cache_read_input_tokens: turn.usage.cacheRead }
        : {}),
      ...(turn.usage?.cacheCreation !== undefined
        ? { cache_creation_input_tokens: turn.usage.cacheCreation }
        : {}),
    },
  };
}

function openaiPayload(turn: FakeLlmTurn, body: Record<string, any>) {
  const calls = (turn.toolCalls ?? []).map((c, i) => ({
    id: c.id ?? `call_${i}`,
    type: "function",
    function: { name: c.name, arguments: c.rawArgs ?? JSON.stringify(c.args) },
  }));
  const content = `${turn.thinking ? `<think>${turn.thinking}</think>\n\n` : ""}${turn.text ?? ""}`;
  const cached = turn.usage?.cacheRead ?? 0;
  const input = (turn.usage?.input ?? 10) + cached;
  const output = turn.usage?.output ?? 5;
  return {
    id: "chatcmpl_fake",
    object: "chat.completion",
    model: turn.model ?? body.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(calls.length > 0 ? { tool_calls: calls } : {}),
        },
        finish_reason: turn.finish ?? (calls.length > 0 ? "tool_calls" : "stop"),
      },
    ],
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: input + output,
      ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    },
  };
}
