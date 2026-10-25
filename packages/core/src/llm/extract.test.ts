import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { FakeLlm } from "./fake-llm";
import { LlmAbortError, LlmExtractError, createLlm, extract, parseJsonLoose } from "./index";
import type { LlmApi } from "./index";

let fake: FakeLlm;
beforeEach(() => {
  fake = new FakeLlm();
  fake.start();
});
afterEach(() => fake.stop());

const llmFor = (api: LlmApi) =>
  createLlm({
    baseUrl: fake.baseUrl(api),
    apiKey: "k-test-0000",
    model: "m",
    api,
    sleep: async () => {},
  });

const Incident = z.object({
  title: z.string(),
  severity: z.enum(["low", "high"]),
  systems: z.array(z.string()).default([]),
});

describe("parseJsonLoose", () => {
  it("nhận JSON thuần, code fence, lời dẫn, dấu phẩy thừa, nháy cong, khối think", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('Đây là kết quả:\n{"a":1}\nHy vọng giúp ích.')).toEqual({ a: 1 });
    expect(parseJsonLoose('{"a":[1,2,],}')).toEqual({ a: [1, 2] });
    expect(parseJsonLoose("{“a”: “b”}")).toEqual({ a: "b" });
    expect(parseJsonLoose('<think>hmm {"x":0}</think>{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('{"a":"có } trong chuỗi"} thừa')).toEqual({ a: "có } trong chuỗi" });
    expect(parseJsonLoose("[1,2]")).toEqual([1, 2]);
  });

  it("không phải JSON thì undefined", () => {
    expect(parseJsonLoose("xin lỗi, tôi không biết")).toBeUndefined();
    expect(parseJsonLoose('{"a":')).toBeUndefined();
    expect(parseJsonLoose("")).toBeUndefined();
  });
});

describe.each(["anthropic-messages", "openai-chat"] as const)("extract (%s)", (api) => {
  it("trích dữ liệu hợp lệ ngay lần đầu", async () => {
    fake.script({ text: '{"title":"Không vào được app","severity":"high","systems":["app"]}' });
    const out = await extract({
      llm: llmFor(api),
      schema: Incident,
      instruction: "Trích thông tin sự cố.",
      input: "App không vào được, gấp",
    });
    expect(out.data).toEqual({ title: "Không vào được app", severity: "high", systems: ["app"] });
    expect(out.attempts).toBe(1);
    expect(out.repaired).toBe(false);

    const sent = fake.requests[0]!.body;
    const system = api === "anthropic-messages" ? sent.system : sent.messages[0].content;
    expect(system).toContain("Trích thông tin sự cố.");
    expect(system).toContain('"severity"'); // JSON Schema của zod
    expect(sent.temperature).toBeUndefined(); // không ép 0: MiniMax từ chối
    const userMsg = sent.messages.find((m: any) => m.role === "user");
    expect(userMsg.content).toBe("<input>\nApp không vào được, gấp\n</input>");
  });

  it("tự sửa code fence và dấu phẩy thừa mà không tốn lời gọi thứ hai", async () => {
    fake.script({ text: 'Kết quả:\n```json\n{"title":"x","severity":"low",}\n```' });
    const out = await extract({ llm: llmFor(api), schema: Incident, instruction: "i", input: "t" });
    expect(out.data.severity).toBe("low");
    expect(out.attempts).toBe(1);
    expect(out.repaired).toBe(true);
    expect(fake.requests).toHaveLength(1);
  });

  it("sai schema: hỏi lại ĐÚNG MỘT lần kèm lỗi cụ thể, rồi thành công", async () => {
    fake.script(
      { text: '{"title":"x","severity":"nghiêm trọng"}', usage: { input: 10, output: 5 } },
      { text: '{"title":"x","severity":"high"}', usage: { input: 30, output: 7 } },
    );
    const out = await extract({ llm: llmFor(api), schema: Incident, instruction: "i", input: "t" });
    expect(out.data).toEqual({ title: "x", severity: "high", systems: [] });
    expect(out.attempts).toBe(2);
    expect(out.repaired).toBe(true);
    expect(out.usage).toEqual({
      inputTokens: 40,
      outputTokens: 12,
      totalTokens: 52,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    const retry = JSON.stringify(fake.requests[1]!.body.messages);
    expect(retry).toContain("severity");
    expect(retry).toContain("Your reply was invalid");
  });

  it("không phải JSON: hỏi lại; hỏng cả hai lần thì ném LlmExtractError (1 lần thử lại, không hơn)", async () => {
    fake.script({ text: "tôi không chắc" }, { text: '{"title":1}' });
    const err = await extract({
      llm: llmFor(api),
      schema: Incident,
      instruction: "i",
      input: "t",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmExtractError);
    expect(err.attempts).toBe(2);
    expect(err.issues.join(" ")).toContain("title");
    expect(err.lastText).toBe('{"title":1}');
    expect(err.message).not.toContain('{"title":1}'); // dữ liệu không vào thông điệp
    expect(fake.requests).toHaveLength(2);
  });

  it("retries: 0 thì không hỏi lại", async () => {
    fake.script({ text: "rác" }, { text: '{"title":"x","severity":"low"}' });
    await expect(
      extract({ llm: llmFor(api), schema: Incident, instruction: "i", input: "t", retries: 0 }),
    ).rejects.toBeInstanceOf(LlmExtractError);
    expect(fake.requests).toHaveLength(1);
  });

  it("bỏ khối suy luận của model trước khi parse", async () => {
    fake.script({ thinking: 'thử {"title":"sai"}', text: '{"title":"đúng","severity":"low"}' });
    const out = await extract({ llm: llmFor(api), schema: Incident, instruction: "i", input: "t" });
    expect(out.data.title).toBe("đúng");
  });

  it("huỷ thì ném LlmAbortError", async () => {
    const err = await extract({
      llm: llmFor(api),
      schema: Incident,
      instruction: "i",
      input: "t",
      signal: AbortSignal.abort(),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmAbortError);
  });
});
