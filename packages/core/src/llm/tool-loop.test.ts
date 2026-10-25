import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { FakeLlm } from "./fake-llm";
import {
  LlmAbortError,
  LlmApiError,
  LlmConfigError,
  createLlm,
  defineLlmTool,
  runToolLoop,
  toolSpec,
} from "./index";
import type { Llm, LlmApi, ToolLoopStep } from "./index";

const APIS: LlmApi[] = ["anthropic-messages", "openai-chat"];
let fake: FakeLlm;
beforeEach(() => {
  fake = new FakeLlm();
  fake.start();
});
afterEach(() => fake.stop());

const llmFor = (api: LlmApi, extra: Partial<Parameters<typeof createLlm>[0]> = {}): Llm =>
  createLlm({
    baseUrl: fake.baseUrl(api),
    apiKey: "k-test-0000",
    model: "m",
    api,
    sleep: async () => {},
    ...extra,
  });

const user = (content: string) => [{ role: "user" as const, content }];

function adder(log: unknown[] = []) {
  return defineLlmTool({
    name: "add",
    description: "Cộng hai số",
    schema: z.object({ a: z.number(), b: z.number().int().min(0) }),
    run: ({ a, b }, ctx) => {
      log.push({ a, b, step: ctx.step });
      return { sum: a + b };
    },
  });
}

describe.each(APIS)("runToolLoop (%s)", (api) => {
  it("gọi tool rồi trả lời; trả về văn bản, các bước, hội thoại và tổng token", async () => {
    const log: unknown[] = [];
    fake.script(
      {
        toolCalls: [{ name: "add", args: { a: 1, b: 2 }, id: "c1" }],
        usage: { input: 10, output: 3 },
      },
      { text: "Tổng là 3", usage: { input: 20, output: 5 } },
    );
    const result = await runToolLoop({
      llm: llmFor(api),
      system: "sys",
      messages: user("1+2?"),
      tools: [adder(log)],
    });

    expect(result.text).toBe("Tổng là 3");
    expect(result.finishReason).toBe("end");
    expect(result.steps.map((s) => s.index)).toEqual([1, 2]);
    expect(result.steps[0]!.executions[0]).toMatchObject({
      content: '{"sum":3}',
      isError: false,
      call: { name: "add", args: { a: 1, b: 2 } },
    });
    expect(result.steps[1]!.executions).toEqual([]);
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 8, totalTokens: 38 });
    expect(log).toEqual([{ a: 1, b: 2, step: 1 }]);
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    // tool gửi lại đúng khai báo từ zod
    const sentTool = fake.requests[0]!.body.tools[0];
    const params =
      api === "anthropic-messages" ? sentTool.input_schema : sentTool.function.parameters;
    expect(params.type).toBe("object");
    expect(Object.keys(params.properties)).toEqual(["a", "b"]);
    expect(params.$schema).toBeUndefined();
  });

  it("tham số sai kiểu: tool KHÔNG chạy, model nhận thông điệp lỗi nói rõ trường sai rồi tự sửa", async () => {
    const log: unknown[] = [];
    fake.script(
      { toolCalls: [{ name: "add", args: { a: "một", b: -1 }, id: "c1" }] },
      { toolCalls: [{ name: "add", args: { a: 1, b: 1 }, id: "c2" }] },
      { text: "2" },
    );
    const result = await runToolLoop({
      llm: llmFor(api),
      messages: user("?"),
      tools: [adder(log)],
    });

    const first = result.steps[0]!.executions[0]!;
    expect(first.isError).toBe(true);
    expect(first.content).toContain('Invalid arguments for tool "add"');
    expect(first.content).toContain("a:");
    expect(first.content).toContain("b:");
    expect(first.content).toContain("call the tool again");
    expect(log).toEqual([{ a: 1, b: 1, step: 2 }]);
    expect(result.text).toBe("2");
    // lỗi thực sự tới được model ở lượt sau
    expect(JSON.stringify(fake.requests[1]!.body.messages)).toContain("Invalid arguments");
  });

  it("thiếu tham số bắt buộc cũng thành lỗi cho model", async () => {
    fake.script({ toolCalls: [{ name: "add", args: {}, id: "c1" }] }, { text: "thôi" });
    const result = await runToolLoop({ llm: llmFor(api), messages: user("?"), tools: [adder()] });
    expect(result.steps[0]!.executions[0]!.content).toContain("a:");
  });

  it("tool không tồn tại: báo model danh sách tool có", async () => {
    fake.script({ toolCalls: [{ name: "ghost", args: {}, id: "c1" }] }, { text: "ok" });
    const result = await runToolLoop({ llm: llmFor(api), messages: user("?"), tools: [adder()] });
    const exec = result.steps[0]!.executions[0]!;
    expect(exec.isError).toBe(true);
    expect(exec.content).toContain('Unknown tool "ghost"');
    expect(exec.content).toContain("add");
  });

  it("tool ném lỗi: thông điệp lỗi quay về model, vòng lặp tiếp tục", async () => {
    const boom = defineLlmTool({
      name: "boom",
      description: "luôn lỗi",
      schema: z.object({}),
      run: () => {
        throw new Error("hệ thống bận");
      },
    });
    fake.script({ toolCalls: [{ name: "boom", args: {}, id: "c1" }] }, { text: "đành chịu" });
    const result = await runToolLoop({ llm: llmFor(api), messages: user("?"), tools: [boom] });
    expect(result.steps[0]!.executions[0]).toMatchObject({
      isError: true,
      content: 'Tool "boom" failed: hệ thống bận',
    });
    expect(result.text).toBe("đành chịu");
  });

  it("chạm maxSteps: dừng với finishReason max_steps, không ném", async () => {
    fake.respond(() => ({ toolCalls: [{ name: "add", args: { a: 1, b: 1 } }] }));
    const result = await runToolLoop({
      llm: llmFor(api),
      messages: user("?"),
      tools: [adder()],
      maxSteps: 3,
    });
    expect(result.finishReason).toBe("max_steps");
    expect(result.steps).toHaveLength(3);
    expect(fake.requests).toHaveLength(3);
  });

  it("trần token: dừng khi tổng token chạm maxTotalTokens", async () => {
    fake.respond(() => ({
      toolCalls: [{ name: "add", args: { a: 1, b: 1 } }],
      usage: { input: 60, output: 10 },
    }));
    const result = await runToolLoop({
      llm: llmFor(api),
      messages: user("?"),
      tools: [adder()],
      maxSteps: 10,
      maxTotalTokens: 100,
    });
    expect(result.finishReason).toBe("budget");
    expect(result.steps).toHaveLength(2);
    expect(result.usage.totalTokens).toBe(140);
  });

  it("onStep được gọi sau mỗi bước theo thứ tự (kể cả bước cuối)", async () => {
    fake.script({ toolCalls: [{ name: "add", args: { a: 1, b: 1 }, id: "c1" }] }, { text: "xong" });
    const seen: ToolLoopStep[] = [];
    await runToolLoop({
      llm: llmFor(api),
      messages: user("?"),
      tools: [adder()],
      onStep: (s) => void seen.push(s),
    });
    expect(seen.map((s) => [s.index, s.executions.length])).toEqual([
      [1, 1],
      [2, 0],
    ]);
  });

  it("huỷ trong lúc tool chạy: LlmAbortError, không gọi model thêm", async () => {
    const controller = new AbortController();
    const slow = defineLlmTool({
      name: "slow",
      description: "chậm",
      schema: z.object({}),
      run: async (_a, ctx) => {
        controller.abort();
        ctx.signal?.throwIfAborted();
        return "không tới";
      },
    });
    fake.script(
      { toolCalls: [{ name: "slow", args: {}, id: "c1" }] },
      { text: "không bao giờ tới" },
    );
    const err = await runToolLoop({
      llm: llmFor(api),
      messages: user("?"),
      tools: [slow],
      signal: controller.signal,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmAbortError);
    expect(fake.requests).toHaveLength(1);
  });

  it("huỷ trong lúc model đang trả lời", async () => {
    fake.script({ delayMs: 400, text: "chậm" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const err = await runToolLoop({
      llm: llmFor(api),
      messages: user("?"),
      tools: [adder()],
      signal: controller.signal,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmAbortError);
  });

  it("lỗi của llm (hết lần thử lại) đi thẳng ra với status", async () => {
    fake.script({ status: 503 });
    const err = await runToolLoop({
      llm: llmFor(api, { maxRetries: 0 }),
      messages: user("?"),
      tools: [adder()],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmApiError);
    expect(err.status).toBe(503);
  });

  it("cắt kết quả tool quá dài", async () => {
    const big = defineLlmTool({
      name: "big",
      description: "dài",
      schema: z.object({}),
      run: () => "x".repeat(500),
    });
    fake.script({ toolCalls: [{ name: "big", args: {}, id: "c1" }] }, { text: "ok" });
    const result = await runToolLoop({
      llm: llmFor(api),
      messages: user("?"),
      tools: [big],
      maxToolResultChars: 100,
    });
    const content = result.steps[0]!.executions[0]!.content;
    expect(content.length).toBeLessThan(200);
    expect(content).toContain("truncated");
  });
});

describe("runToolLoop (chi tiết)", () => {
  it("tham số JSON hỏng (openai) thành lỗi cho model chứ tool không chạy", async () => {
    const log: unknown[] = [];
    fake.script(
      { toolCalls: [{ name: "add", args: null, id: "c1", rawArgs: "{a: 1" }] },
      { text: "thử lại sau" },
    );
    const result = await runToolLoop({
      llm: llmFor("openai-chat"),
      messages: user("?"),
      tools: [adder(log)],
    });
    expect(log).toEqual([]);
    expect(result.steps[0]!.executions[0]!.content).toContain("not valid JSON");
  });

  it("nhiều lời gọi tool trong một bước chạy tuần tự, kết quả đủ và đúng id", async () => {
    fake.script(
      {
        toolCalls: [
          { name: "add", args: { a: 1, b: 1 }, id: "x" },
          { name: "add", args: { a: 2, b: 2 }, id: "y" },
        ],
      },
      { text: "ok" },
    );
    const result = await runToolLoop({
      llm: llmFor("anthropic-messages"),
      messages: user("?"),
      tools: [adder()],
    });
    expect(result.steps[0]!.executions.map((e) => e.content)).toEqual(['{"sum":2}', '{"sum":4}']);
    const toolMsgs = result.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => (m as { toolCallId: string }).toolCallId)).toEqual(["x", "y"]);
  });

  it("không đổi mảng messages của người gọi", async () => {
    fake.script({ text: "a" });
    const input = user("?");
    await runToolLoop({ llm: llmFor("openai-chat"), messages: input, tools: [] });
    expect(input).toHaveLength(1);
  });

  it("không có tool thì không gửi trường tools", async () => {
    fake.script({ text: "a" });
    await runToolLoop({ llm: llmFor("openai-chat"), messages: user("?"), tools: [] });
    expect(fake.requests[0]!.body.tools).toBeUndefined();
  });

  it("kiểm cấu hình: trùng tên tool, maxSteps sai", async () => {
    const llm = llmFor("openai-chat");
    await expect(
      runToolLoop({ llm, messages: user("?"), tools: [adder(), adder()] }),
    ).rejects.toBeInstanceOf(LlmConfigError);
    await expect(
      runToolLoop({ llm, messages: user("?"), tools: [], maxSteps: 0 }),
    ).rejects.toBeInstanceOf(LlmConfigError);
  });
});

describe("defineLlmTool", () => {
  it("từ chối tên sai và schema không phải object ngay lúc khai báo", () => {
    expect(() =>
      defineLlmTool({
        name: "tên có dấu cách",
        description: "x",
        schema: z.object({}),
        run: () => 1,
      }),
    ).toThrow(LlmConfigError);
    expect(() =>
      defineLlmTool({ name: "ok", description: "x", schema: z.string(), run: () => 1 }),
    ).toThrow(LlmConfigError);
  });

  it("toolSpec sinh JSON Schema từ zod, giữ mô tả trường", () => {
    const spec = toolSpec(
      defineLlmTool({
        name: "t",
        description: "d",
        schema: z.object({ id: z.string().describe("Mã issue") }),
        run: () => 1,
      }),
    );
    expect(spec.parameters).toMatchObject({
      type: "object",
      properties: { id: { type: "string", description: "Mã issue" } },
      required: ["id"],
    });
  });
});
