import { afterAll, describe, expect, it, test, mock, afterEach } from "bun:test";
import { complete, extractJson, isLlmConfigured, llmConfigFromEnv, parseApiStyle } from "./llm";

// Proxy giả: model "chet" trả 503 như agya/gemini-3.8-flash thật (24/09), model khác trả lời bình thường.
const seen: string[] = [];
const proxy = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const body = (await req.json()) as { model: string; stream?: boolean };
    seen.push(body.model);
    // local-router (26/09): không ghi stream:false là trả SSE, res.json() vỡ "Failed to parse JSON".
    if (body.model === "sse-mac-dinh" && body.stream !== false) {
      return new Response('data: {"choices":[{"delta":{"content":"{"}}]}\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    if (body.model === "chet") return new Response('{"error":"ECONNREFUSED"}', { status: 503 });
    if (body.model === "sai-input") return new Response('{"error":"bad"}', { status: 400 });
    return Response.json({ choices: [{ message: { content: `tra-loi-tu-${body.model}` } }] });
  },
});
afterAll(() => proxy.stop(true));
const baseUrl = `http://127.0.0.1:${proxy.port}`;

describe("complete — danh sách model dự phòng", () => {
  it("model đầu lỗi 5xx thì thử model kế tiếp", async () => {
    seen.length = 0;
    const text = await complete({ baseUrl, apiKey: "", model: "chet, song" }, "sys", "user");
    expect(text).toBe("tra-loi-tu-song");
    expect(seen).toEqual(["chet", "song"]);
  });

  it("lỗi 4xx (request sai) không đổi model — đổi cũng vô ích", async () => {
    seen.length = 0;
    await expect(
      complete({ baseUrl, apiKey: "", model: "sai-input,song" }, "s", "u"),
    ).rejects.toThrow(/400/);
    expect(seen).toEqual(["sai-input"]);
  });

  it("luôn xin trả lời một lần (stream:false) — proxy mặc định stream thì vẫn đọc được", async () => {
    expect(await complete({ baseUrl, apiKey: "", model: "sse-mac-dinh" }, "s", "u")).toBe(
      "tra-loi-tu-sse-mac-dinh",
    );
  });

  it("hết model thì ném lỗi của model cuối", async () => {
    await expect(complete({ baseUrl, apiKey: "", model: "chet" }, "s", "u")).rejects.toThrow(/503/);
  });
});

describe("parseApiStyle", () => {
  test("nhận đúng 'anthropic'/'openclaw', mặc định 'openai' cho mọi giá trị khác", () => {
    expect(parseApiStyle("anthropic")).toBe("anthropic");
    expect(parseApiStyle("openclaw")).toBe("openclaw");
    expect(parseApiStyle("openai")).toBe("openai");
    expect(parseApiStyle(undefined)).toBe("openai");
    expect(parseApiStyle("linh tinh")).toBe("openai");
  });
});

describe("extractJson", () => {
  test("lấy khối JSON đầu tiên kể cả khi model bọc trong ```json", () => {
    expect(extractJson<{ a: number }>('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  test("trả null khi không parse được", () => {
    expect(extractJson("không có json nào ở đây")).toBeNull();
  });
});

describe("llmConfigFromEnv / isLlmConfigured", () => {
  test("OpenClaw chỉ cần model, không cần URL/key (server dùng model OpenClaw đang đăng nhập)", () => {
    const c = llmConfigFromEnv({
      OPENAI_API_STYLE: "openclaw",
      OPENAI_MODEL: "openai/gpt-5.6-luna",
    });
    expect(c.api).toBe("openclaw");
    expect(isLlmConfigured(c)).toBe(true);
  });

  test("HTTP thiếu URL → chưa cấu hình", () => {
    expect(isLlmConfigured(llmConfigFromEnv({ OPENAI_MODEL: "gpt-4o-mini" }))).toBe(false);
    expect(isLlmConfigured(llmConfigFromEnv({ OPENAI_BASE_URL: "http://x/v1" }))).toBe(true);
  });
});
