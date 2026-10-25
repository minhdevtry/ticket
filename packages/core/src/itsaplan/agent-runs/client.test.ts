import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { FakeItsaplan } from "../../testing/fake-itsaplan";
import { AgentRunsApiError, AgentRunsClient, AgentRunsProtocolError } from "./client";

let fake: FakeItsaplan;

const client = (overrides: Partial<ConstructorParameters<typeof AgentRunsClient>[0]> = {}) =>
  new AgentRunsClient({
    baseUrl: fake.baseUrl,
    apiKey: fake.agentKey,
    retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 },
    ...overrides,
  });

beforeEach(() => {
  fake = new FakeItsaplan();
  fake.start();
});
afterEach(async () => {
  await fake.stop();
});

describe("AgentRunsClient.claim", () => {
  it("trả null khi hàng đợi trống và gửi x-api-key", async () => {
    expect(await client().claim()).toBeNull();
    expect(fake.requests[0]?.apiKey).toBe(fake.agentKey);
    expect(fake.requests[0]?.path).toBe("/agent-runs/claim");
  });

  it("nhận run, chuẩn hoá trường và tăng attempts ở server", async () => {
    const issue = fake.addIssue({ title: "Lỗi đăng nhập" });
    const queued = fake.enqueueRun({ trigger: "delegation", prompt: "làm đi", issueId: issue.id });
    const run = await client().claim();
    expect(run).toEqual({
      id: queued.id,
      trigger: "delegation",
      prompt: "làm đi",
      systemPrompt: expect.stringContaining("Run mode"),
      attempts: 1,
      traceEvents: true,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
    });
    // đã thuê: lần claim thứ hai không thấy lại
    expect(await client().claim()).toBeNull();
  });

  it("run không gắn issue có issueId/issueIdentifier null và chấp nhận trigger lạ", async () => {
    fake.enqueueRun({ trigger: "something-new", prompt: "x" });
    const run = await client().claim();
    expect(run?.issueId).toBeNull();
    expect(run?.issueIdentifier).toBeNull();
    expect(run?.trigger).toBe("something-new");
  });

  it("401 và 409 là lỗi chết (fatal); 500 thì không", async () => {
    const bad = client({ apiKey: "sai" });
    const err401 = await bad.claim().catch((e) => e);
    expect(err401).toBeInstanceOf(AgentRunsApiError);
    expect(err401.status).toBe(401);
    expect(err401.fatal).toBe(true);

    const inv = new FakeItsaplan({ invocationUrl: true });
    inv.start();
    try {
      const err409 = await new AgentRunsClient({ baseUrl: inv.baseUrl, apiKey: inv.agentKey })
        .claim()
        .catch((e) => e);
      expect(err409.status).toBe(409);
      expect(err409.fatal).toBe(true);
    } finally {
      await inv.stop();
    }

    const before = fake.count("POST /agent-runs/claim");
    fake.fail(/claim/, 500, 1);
    const err500 = await client()
      .claim()
      .catch((e) => e);
    expect(err500.status).toBe(500);
    expect(err500.fatal).toBe(false);
    // claim KHÔNG tự retry: chỉ đúng một request đã đi
    expect(fake.count("POST /agent-runs/claim") - before).toBe(1);
  });

  it("phản hồi sai giao thức ném AgentRunsProtocolError", async () => {
    const odd = new AgentRunsClient({
      baseUrl: "http://x.example.com",
      apiKey: "k",
      fetch: (async () => Response.json({ nope: 1 })) as unknown as typeof fetch,
    });
    await expect(odd.claim()).rejects.toBeInstanceOf(AgentRunsProtocolError);
    const noId = new AgentRunsClient({
      baseUrl: "http://x.example.com",
      apiKey: "k",
      fetch: (async () =>
        Response.json({ run: { id: "7", trigger: "mention" } })) as unknown as typeof fetch,
    });
    await expect(noId.claim()).rejects.toBeInstanceOf(AgentRunsProtocolError);
  });
});

describe("AgentRunsClient.heartbeat / report", () => {
  it("heartbeat ok, lost khi run không còn của ta, và retry khi 503", async () => {
    const queued = fake.enqueueRun({ trigger: "manual", prompt: "p" });
    const run = (await client().claim())!;
    expect(await client().heartbeat({ runId: run.id, attempt: run.attempts })).toBe("ok");
    fake.fail(/heartbeat/, 503, 2);
    expect(await client().heartbeat({ runId: run.id, attempt: run.attempts })).toBe("ok");
    expect(fake.count(`POST /agent-runs/${queued.id}/heartbeat`)).toBe(4);
    // sai attempt (đã đổi lượt) → lost
    expect(await client().heartbeat({ runId: run.id, attempt: run.attempts + 1 })).toBe("lost");
    expect(await client().heartbeat({ runId: 99999 })).toBe("lost");
  });

  it("tôn trọng Retry-After của 429", async () => {
    fake.enqueueRun({ trigger: "manual", prompt: "p" });
    const run = (await client().claim())!;
    fake.fail(/heartbeat/, 429, 1, { "retry-after": "0" });
    expect(await client().heartbeat({ runId: run.id, attempt: run.attempts })).toBe("ok");
  });

  it("hết retry thì ném lỗi", async () => {
    fake.enqueueRun({ trigger: "manual", prompt: "p" });
    const run = (await client({
      retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
    }).claim())!;
    fake.fail(/heartbeat/, 503, 10);
    await expect(
      client({ retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 } }).heartbeat({
        runId: run.id,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fake.count(`POST /agent-runs/${run.id}/heartbeat`)).toBe(2);
  });

  it("report success/failed ghi đúng, cắt output/error, lần hai là stale", async () => {
    fake.enqueueRun({ trigger: "manual", prompt: "p" });
    fake.enqueueRun({ trigger: "manual", prompt: "q" });
    const a = (await client().claim())!;
    const b = (await client().claim())!;

    expect(
      await client().report({
        runId: a.id,
        result: {
          status: "success",
          output: "x".repeat(20_000),
          usage: { inputTokens: 5, outputTokens: 2 },
        },
        attempt: a.attempts,
      }),
    ).toBe("recorded");
    expect(fake.run(a.id)).toMatchObject({
      status: "success",
      usage: { inputTokens: 5, outputTokens: 2 },
    });
    expect(fake.run(a.id).output?.length).toBe(10_000);

    expect(
      await client().report({
        runId: b.id,
        result: { status: "failed", error: "e".repeat(900) },
        attempt: b.attempts,
      }),
    ).toBe("recorded");
    expect(fake.run(b.id).status).toBe("failed");
    expect(fake.run(b.id).error?.length).toBe(500);

    // đã kết thúc → server trả 404 → stale
    expect(
      await client().report({ runId: a.id, result: { status: "success" }, attempt: a.attempts }),
    ).toBe("stale");
  });

  it("report với attempt cũ bị từ chối (run đã sang lượt khác)", async () => {
    fake.enqueueRun({ trigger: "manual", prompt: "p" });
    const run = (await client().claim())!;
    expect(
      await client().report({
        runId: run.id,
        result: { status: "success" },
        attempt: run.attempts + 1,
      }),
    ).toBe("stale");
    expect(fake.run(run.id).status).toBe("pending");
  });
});

describe("AgentRunsClient.appendEvents", () => {
  it("ack theo offset, gửi lại lô đã nhận là idempotent, lệch offset là conflict", async () => {
    fake.enqueueRun({ trigger: "manual", prompt: "p" });
    const run = (await client().claim())!;
    const events = [{ type: "RUN_STARTED" as const }, { type: "RUN_FINISHED" as const }];

    expect(
      await client().appendEvents({ runId: run.id, attempt: run.attempts, offset: 0, events }),
    ).toEqual({
      nextOffset: 2,
      truncated: false,
    });
    // gửi lại y hệt
    expect(
      await client().appendEvents({ runId: run.id, attempt: run.attempts, offset: 0, events }),
    ).toEqual({
      nextOffset: 2,
      truncated: false,
    });
    expect(fake.run(run.id).events).toHaveLength(2);
    // nhảy cóc
    expect(
      await client().appendEvents({ runId: run.id, attempt: run.attempts, offset: 9, events }),
    ).toBe("conflict");
    // sai attempt
    expect(
      await client().appendEvents({ runId: run.id, attempt: run.attempts + 1, offset: 2, events }),
    ).toBe("lost");
  });

  it("từ chối lô rỗng hoặc quá 200 sự kiện ngay ở client", async () => {
    await expect(
      client().appendEvents({ runId: 1, attempt: 1, offset: 0, events: [] }),
    ).rejects.toThrow(RangeError);
    const many = Array.from({ length: 201 }, () => ({ type: "RUN_STARTED" as const }));
    await expect(
      client().appendEvents({ runId: 1, attempt: 1, offset: 0, events: many }),
    ).rejects.toThrow(RangeError);
  });
});
