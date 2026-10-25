import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { FakeLlm } from "./fake-llm";
import {
  LlmAbortError,
  LlmApiError,
  LlmConfigError,
  LlmNetworkError,
  LlmResponseError,
  LlmTimeoutError,
  createLlm,
} from "./index";
import type { Llm, LlmApi, LlmRequest } from "./index";

const KEY = "llmkey-llmkey-llmkey-1";
const APIS: LlmApi[] = ["anthropic-messages", "openai-chat"];

let fake: FakeLlm;
beforeEach(() => {
  fake = new FakeLlm();
  fake.start();
});
afterEach(() => fake.stop());

const noSleep = async () => {};

function make(api: LlmApi, extra: Partial<Parameters<typeof createLlm>[0]> = {}): Llm {
  return createLlm({
    baseUrl: fake.baseUrl(api),
    apiKey: KEY,
    model: "MiniMax-M3.1-Flash",
    api,
    sleep: noSleep,
    ...extra,
  });
}

const ask: LlmRequest = { system: "Bạn là trợ lý.", messages: [{ role: "user", content: "chào" }] };

describe.each(APIS)("createLlm (%s)", (api) => {
  it("gửi đúng đường dẫn, header và thân; đọc văn bản và token", async () => {
    fake.script({ text: "Xin chào!", usage: { input: 12, output: 4 } });
    const res = await make(api).complete({ ...ask, temperature: 0.2, maxTokens: 100 });

    expect(res.text).toBe("Xin chào!");
    expect(res.stopReason).toBe("end");
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 4, totalTokens: 16 });
    expect(res.model).toBe("MiniMax-M3.1-Flash");
    expect(res.message).toEqual({ role: "assistant", content: "Xin chào!" });

    const req = fake.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe(api === "anthropic-messages" ? "/v1/messages" : "/v1/chat/completions");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.body.model).toBe("MiniMax-M3.1-Flash");
    expect(req.body.stream).toBe(false);
    expect(req.body.max_tokens).toBe(100);
    expect(req.body.temperature).toBe(0.2);
    if (api === "anthropic-messages") {
      expect(req.headers["x-api-key"]).toBe(KEY);
      expect(req.headers["anthropic-version"]).toBe("2023-06-01");
      expect(req.headers.authorization).toBeUndefined();
      expect(req.body.system).toBe("Bạn là trợ lý.");
      expect(req.body.messages).toEqual([{ role: "user", content: "chào" }]);
    } else {
      expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(req.headers["x-api-key"]).toBeUndefined();
      expect(req.body.messages).toEqual([
        { role: "system", content: "Bạn là trợ lý." },
        { role: "user", content: "chào" },
      ]);
    }
  });

  it("chỉ dùng header mà proxy dev chuyển tiếp và hai đường dẫn nó cho phép", async () => {
    fake.script({ text: "ok" });
    await make(api).complete(ask);
    const req = fake.requests[0]!;
    // tools/tl2-shadow/proxy.ts: pick(["content-type","accept","anthropic-version","anthropic-beta"])
    // rồi tự gắn x-api-key/authorization. Mọi header khác bị bỏ nên không được dựa vào.
    const carried = new Set(["content-type", "accept", "anthropic-version", "anthropic-beta"]);
    const auth = new Set(["x-api-key", "authorization"]);
    const transport = new Set([
      "host",
      "content-length",
      "connection",
      "accept-encoding",
      "user-agent",
    ]);
    for (const name of Object.keys(req.headers)) {
      expect(carried.has(name) || auth.has(name) || transport.has(name)).toBe(true);
    }
    expect(["/v1/messages", "/v1/chat/completions"]).toContain(req.path);
  });

  it("tool: gửi khai báo, nhận lời gọi, gửi lại kết quả (kể cả lỗi) ở lượt sau", async () => {
    fake.script(
      { toolCalls: [{ name: "get_issue", args: { identifier: "TECH-1" }, id: "t1" }] },
      { text: "Xong" },
    );
    const llm = make(api);
    const tools = [
      {
        name: "get_issue",
        description: "Đọc issue",
        parameters: { type: "object", properties: { identifier: { type: "string" } } },
      },
    ];
    const first = await llm.complete({ ...ask, tools, toolChoice: "auto" });
    expect(first.stopReason).toBe("tool_use");
    expect(first.toolCalls).toEqual([
      { id: "t1", name: "get_issue", args: { identifier: "TECH-1" } },
    ]);
    expect(first.message.toolCalls).toEqual(first.toolCalls);

    const sent = fake.requests[0]!.body;
    if (api === "anthropic-messages") {
      expect(sent.tools[0]).toEqual({
        name: "get_issue",
        description: "Đọc issue",
        input_schema: tools[0]!.parameters,
      });
      expect(sent.tool_choice).toEqual({ type: "auto" });
    } else {
      expect(sent.tools[0]).toEqual({
        type: "function",
        function: { name: "get_issue", description: "Đọc issue", parameters: tools[0]!.parameters },
      });
      expect(sent.tool_choice).toBe("auto");
    }

    await llm.complete({
      ...ask,
      tools,
      messages: [
        ...ask.messages,
        first.message,
        { role: "tool", toolCallId: "t1", name: "get_issue", content: "lỗi rồi", isError: true },
        { role: "tool", toolCallId: "t2", name: "get_issue", content: "kết quả 2" },
      ],
    });
    const msgs = fake.requests[1]!.body.messages as any[];
    if (api === "anthropic-messages") {
      expect(msgs[1]).toEqual({
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "get_issue", input: { identifier: "TECH-1" } },
        ],
      });
      // hai kết quả tool liền nhau nằm chung MỘT tin nhắn user
      expect(msgs).toHaveLength(3);
      expect(msgs[2]).toEqual({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "lỗi rồi", is_error: true },
          { type: "tool_result", tool_use_id: "t2", content: "kết quả 2" },
        ],
      });
    } else {
      expect(msgs[2]).toEqual({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: { name: "get_issue", arguments: '{"identifier":"TECH-1"}' },
          },
        ],
      });
      expect(msgs[3]).toEqual({ role: "tool", tool_call_id: "t1", content: "lỗi rồi" });
      expect(msgs[4]).toEqual({ role: "tool", tool_call_id: "t2", content: "kết quả 2" });
    }
  });

  it("bỏ khối suy luận khỏi text nhưng giữ nguyên để gửi lại ở lượt sau", async () => {
    fake.script(
      { thinking: "nghĩ một chút", text: "Đáp án", toolCalls: [{ name: "x", args: {}, id: "a" }] },
      { text: "ok" },
    );
    const llm = make(api);
    const first = await llm.complete(ask);
    expect(first.text).toBe("Đáp án");
    expect(first.message.content).toBe("Đáp án");
    expect(first.message.raw?.api).toBe(api);

    await llm.complete({
      ...ask,
      messages: [...ask.messages, first.message, { role: "tool", toolCallId: "a", content: "r" }],
    });
    const echoed = fake.requests[1]!.body.messages.find((m: any) => m.role === "assistant");
    expect(JSON.stringify(echoed)).toContain("nghĩ một chút");
  });

  it("ghi đè model theo từng request", async () => {
    fake.script({ text: "a" });
    await make(api).complete({ ...ask, model: "MiniMax-Other" });
    expect(fake.requests[0]!.body.model).toBe("MiniMax-Other");
  });

  it("thử lại 503 rồi thành công; báo số lần gọi cho hook onUsage", async () => {
    const events: any[] = [];
    fake.script({ status: 503 }, { status: 500 }, { text: "ổn rồi" });
    const res = await make(api, { onUsage: (e) => events.push(e) }).complete(ask);
    expect(res.text).toBe("ổn rồi");
    expect(fake.requests).toHaveLength(3);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ api, model: "MiniMax-M3.1-Flash", attempts: 3 });
    expect(events[0].usage.totalTokens).toBe(15);
  });

  it("hết lần thử lại thì ném LlmApiError có status và retryable", async () => {
    fake.script({ status: 503 }, { status: 503 }, { status: 503 });
    const err = await make(api, { maxRetries: 2 })
      .complete(ask)
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmApiError);
    expect(err.status).toBe(503);
    expect(err.retryable).toBe(true);
    expect(err.transient).toBe(true);
    expect(err.attempts).toBe(3);
    expect(fake.requests).toHaveLength(3);
  });

  it("maxRetries = 0 không thử lại", async () => {
    fake.script({ status: 503 }, { text: "không bao giờ tới" });
    const err = await make(api, { maxRetries: 0 })
      .complete(ask)
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmApiError);
    expect(fake.requests).toHaveLength(1);
  });

  it("KHÔNG thử lại 4xx (trừ 429): 400, 401, 404", async () => {
    for (const status of [400, 401, 404]) {
      fake.requests.length = 0;
      fake.script({ status });
      const err = await make(api)
        .complete(ask)
        .catch((e) => e);
      expect(err).toBeInstanceOf(LlmApiError);
      expect(err.status).toBe(status);
      expect(err.retryable).toBe(false);
      expect(err.transient).toBe(false);
      expect(fake.requests).toHaveLength(1);
    }
  });

  it("429 tôn trọng Retry-After (có trần) và thử lại", async () => {
    const waits: number[] = [];
    fake.script({ status: 429, headers: { "retry-after": "2" } }, { text: "ổn" });
    const res = await make(api, { sleep: async (ms) => void waits.push(ms) }).complete(ask);
    expect(res.text).toBe("ổn");
    expect(waits).toEqual([2000]);

    waits.length = 0;
    fake.script({ status: 429, headers: { "retry-after": "3600" } }, { text: "ổn" });
    await make(api, { maxRetryAfterMs: 5000, sleep: async (ms) => void waits.push(ms) }).complete(
      ask,
    );
    expect(waits).toEqual([5000]);
  });

  it("không bao giờ để key lọt vào thông điệp lỗi, kể cả khi server nhại lại key", async () => {
    fake.script({
      status: 401,
      body: JSON.stringify({ error: { message: `bad key ${KEY} rejected` } }),
    });
    const err = await make(api, { maxRetries: 0 })
      .complete(ask)
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmApiError);
    expect(err.message).not.toContain(KEY);
    expect(err.body).not.toContain(KEY);
    expect(err.message).toContain("[REDACTED]");
    expect(JSON.stringify(err)).not.toContain(KEY);
    expect(String(err.stack)).not.toContain(KEY);
  });

  it("mạng lỗi thì thử lại rồi ném LlmNetworkError (key cũng được che)", async () => {
    let calls = 0;
    const llm = make(api, {
      maxRetries: 1,
      fetch: (async () => {
        calls++;
        throw new TypeError(`connect ECONNREFUSED using ${KEY}`);
      }) as unknown as typeof fetch,
    });
    const err = await llm.complete(ask).catch((e) => e);
    expect(err).toBeInstanceOf(LlmNetworkError);
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain(KEY);
    expect(calls).toBe(2);
  });

  it("quá timeoutMs thì ném LlmTimeoutError sau khi thử lại hết", async () => {
    fake.script({ delayMs: 400, text: "chậm" }, { delayMs: 400, text: "chậm" });
    const err = await make(api, { timeoutMs: 30, maxRetries: 1 })
      .complete(ask)
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmTimeoutError);
    expect(err.retryable).toBe(true);
    expect(fake.requests).toHaveLength(2);
  });

  it("huỷ giữa lời gọi: LlmAbortError, không thử lại", async () => {
    fake.script({ delayMs: 400, text: "chậm" }, { text: "không bao giờ tới" });
    const controller = new AbortController();
    const pending = make(api)
      .complete({ ...ask, signal: controller.signal })
      .catch((e) => e);
    setTimeout(() => controller.abort(), 30);
    const err = await pending;
    expect(err).toBeInstanceOf(LlmAbortError);
    expect(err.retryable).toBe(false);
    expect(fake.requests).toHaveLength(1);
  });

  it("huỷ khi đang chờ backoff cũng dừng ngay", async () => {
    fake.script({ status: 503 }, { text: "không bao giờ tới" });
    const controller = new AbortController();
    const llm = createLlm({
      baseUrl: fake.baseUrl(api),
      apiKey: KEY,
      model: "m",
      api,
      retryBaseDelayMs: 10_000,
      retryMaxDelayMs: 10_000,
    });
    const started = Date.now();
    const pending = llm.complete({ ...ask, signal: controller.signal }).catch((e) => e);
    setTimeout(() => controller.abort(), 50);
    expect(await pending).toBeInstanceOf(LlmAbortError);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fake.requests).toHaveLength(1);
  });

  it("signal đã huỷ từ trước thì không gọi mạng", async () => {
    const err = await make(api)
      .complete({ ...ask, signal: AbortSignal.abort() })
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmAbortError);
    expect(fake.requests).toHaveLength(0);
  });

  it("2xx nhưng sai hình dạng hoặc không phải JSON: LlmResponseError, không thử lại", async () => {
    fake.script({ body: "{}" }, { body: "<html>proxy lỗi</html>" });
    const llm = make(api);
    expect(await llm.complete(ask).catch((e) => e)).toBeInstanceOf(LlmResponseError);
    expect(await llm.complete(ask).catch((e) => e)).toBeInstanceOf(LlmResponseError);
    expect(fake.requests).toHaveLength(2);
  });

  it("hook onUsage ném lỗi cũng không làm hỏng lời gọi", async () => {
    fake.script({ text: "ok" });
    const res = await make(api, {
      onUsage: () => {
        throw new Error("hook hỏng");
      },
    }).complete(ask);
    expect(res.text).toBe("ok");
  });
});

describe("tham số tool kiểu OpenAI", () => {
  it("JSON hỏng không làm sập: args undefined kèm argsError", async () => {
    fake.script({ toolCalls: [{ name: "t", args: null, id: "c", rawArgs: "{oops" }] });
    const res = await make("openai-chat").complete(ask);
    expect(res.toolCalls[0]!.args).toBeUndefined();
    expect(res.toolCalls[0]!.argsError).toContain("JSON");
  });

  it("tham số rỗng thành {}", async () => {
    fake.script({ toolCalls: [{ name: "t", args: null, id: "c", rawArgs: "" }] });
    const res = await make("openai-chat").complete(ask);
    expect(res.toolCalls[0]!.args).toEqual({});
  });
});

describe("max_tokens và lý do dừng", () => {
  it("length / max_tokens", async () => {
    fake.script({ text: "cụt", finish: "length" });
    expect((await make("openai-chat").complete(ask)).stopReason).toBe("max_tokens");
    fake.script({ text: "cụt", finish: "max_tokens" });
    expect((await make("anthropic-messages").complete(ask)).stopReason).toBe("max_tokens");
  });
});

describe("quy ước base URL", () => {
  it("anthropic-messages chịu cả base có /v1; dấu / cuối bị bỏ", async () => {
    fake.script({ text: "a" }, { text: "b" });
    await createLlm({
      baseUrl: `${fake.origin}/v1/`,
      apiKey: KEY,
      model: "m",
      api: "anthropic-messages",
    }).complete(ask);
    await createLlm({
      baseUrl: `${fake.origin}/`,
      apiKey: KEY,
      model: "m",
      api: "anthropic-messages",
    }).complete(ask);
    expect(fake.requests.map((r) => r.path)).toEqual(["/v1/messages", "/v1/messages"]);
  });

  it("apiKey rỗng thì không gửi header xác thực", async () => {
    fake.script({ text: "a" });
    await createLlm({
      baseUrl: fake.baseUrl("openai-chat"),
      apiKey: "",
      model: "m",
      api: "openai-chat",
    }).complete(ask);
    expect(fake.requests[0]!.headers.authorization).toBeUndefined();
  });
});

describe("kiểm tra cấu hình", () => {
  it("ném LlmConfigError cho api, baseUrl, model sai", () => {
    const ok = {
      baseUrl: "http://127.0.0.1:1",
      apiKey: "k",
      model: "m",
      api: "openai-chat",
    } as const;
    expect(() => createLlm({ ...ok, api: "gemini" as never })).toThrow(LlmConfigError);
    expect(() => createLlm({ ...ok, baseUrl: "không phải url" })).toThrow(LlmConfigError);
    expect(() => createLlm({ ...ok, baseUrl: "file:///etc/passwd" })).toThrow(LlmConfigError);
    expect(() => createLlm({ ...ok, model: "" })).toThrow(LlmConfigError);
    expect(() => createLlm(ok)).not.toThrow();
  });
});
