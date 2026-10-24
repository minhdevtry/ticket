import { afterEach, describe, expect, it } from "bun:test";
import { askDiscriminatingQuestion, verifyCandidate } from "./similar-judge";
import type { CorpusTicket } from "./similar-finder";

function makeLlmServer(handler: (body: any) => Response) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    return handler(await req.json());
  } });
  return { server, baseUrl: `http://127.0.0.1:${server.port}` };
}

describe("verifyCandidate", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => { server?.stop(true); server = undefined; });

  const candidate: CorpusTicket = { identifier: "TECH-1", title: "Cache hỏng", symptomsText: "Không đồng bộ dữ liệu", humanCause: "Cache hỏng", humanFix: "Xoá cache" };

  it("parse đúng JSON model trả về, kể cả bọc trong ```json```", async () => {
    const { server: s, baseUrl } = makeLlmServer(() =>
      Response.json({ choices: [{ message: { content: '```json\n{"same_root_cause": true, "confidence": "high", "matching_mechanism": "cùng cache"}\n```' } }] }),
    );
    server = s;
    const r = await verifyCandidate({ baseUrl, apiKey: "", model: "m" }, "Không đồng bộ dữ liệu", candidate);
    expect(r).toEqual({ sameRootCause: true, confidence: "high", newCauseGuess: undefined, candidateCause: undefined, matchingMechanism: "cùng cache" });
  });

  it("confidence lạ/rỗng -> mặc định 'low'", async () => {
    const { server: s, baseUrl } = makeLlmServer(() => Response.json({ choices: [{ message: { content: '{"same_root_cause": false}' } }] }));
    server = s;
    const r = await verifyCandidate({ baseUrl, apiKey: "", model: "m" }, "abc", candidate);
    expect(r?.confidence).toBe("low");
    expect(r?.sameRootCause).toBe(false);
  });

  it("lỗi HTTP / JSON hỏng -> null (KHÔNG chấp nhận ứng viên, không throw)", async () => {
    const { server: s, baseUrl } = makeLlmServer(() => new Response("boom", { status: 500 }));
    server = s;
    const r = await verifyCandidate({ baseUrl, apiKey: "", model: "m" }, "abc", candidate);
    expect(r).toBeNull();
  });
});

describe("askDiscriminatingQuestion", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => { server?.stop(true); server = undefined; });

  it("trả đúng câu hỏi model đưa ra", async () => {
    const { server: s, baseUrl } = makeLlmServer(() => Response.json({ choices: [{ message: { content: '{"question": "Kiểm tra CRM xem loại nào"}' } }] }));
    server = s;
    const q = await askDiscriminatingQuestion({ baseUrl, apiKey: "", model: "m" }, "ticket mới", [{ clusterId: "A", cause: "x", fix: "y", sampleIds: ["TECH-1"] }]);
    expect(q).toBe("Kiểm tra CRM xem loại nào");
  });

  it("lỗi gọi LLM -> câu hỏi dự phòng (fallback), không throw", async () => {
    const { server: s, baseUrl } = makeLlmServer(() => new Response("err", { status: 500 }));
    server = s;
    const q = await askDiscriminatingQuestion({ baseUrl, apiKey: "", model: "m" }, "ticket mới", [{ clusterId: "A", sampleIds: ["TECH-1"] }]);
    expect(q.length).toBeGreaterThan(0);
  });
});
