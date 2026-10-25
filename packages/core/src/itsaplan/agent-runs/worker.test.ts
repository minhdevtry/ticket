import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { IntakeLogger } from "../../core/logger";
import { FakeItsaplan } from "../../testing/fake-itsaplan";
import { AgentRunsClient } from "./client";
import {
  AgentRunWorker,
  MemoryRunLedger,
  type AgentRunHandler,
  type AgentRunWorkerOptions,
} from "./worker";

const silent: IntakeLogger = { debug() {}, info() {}, warn() {}, error() {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("until: quá hạn chờ điều kiện");
    await sleep(5);
  }
}

let fake: FakeItsaplan;
const workers: AgentRunWorker[] = [];

function makeWorker(handler: AgentRunHandler, extra: Partial<AgentRunWorkerOptions> = {}) {
  const worker = new AgentRunWorker({
    client: new AgentRunsClient({
      baseUrl: fake.baseUrl,
      apiKey: fake.agentKey,
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
    }),
    handler,
    pollIntervalMs: 5,
    minPollIntervalMs: 0,
    heartbeatIntervalMs: 20,
    errorBackoff: { baseMs: 5, maxMs: 10 },
    logger: silent,
    ...extra,
  });
  workers.push(worker);
  return worker;
}

beforeEach(() => {
  fake = new FakeItsaplan();
  fake.start();
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.stop()));
  await fake.stop();
});

describe("AgentRunWorker", () => {
  it("nhận run, chạy handler và báo success kèm output; ghi trace RUN_STARTED/RUN_FINISHED", async () => {
    const run = fake.enqueueRun({ trigger: "manual", prompt: "làm việc" });
    const seen: string[] = [];
    const worker = makeWorker(async (ctx) => {
      seen.push(`${ctx.run.id}:${ctx.run.trigger}:${ctx.idempotencyKey}`);
      await ctx.trace.text("đang làm");
      return "xong rồi";
    });
    worker.start();
    await until(() => fake.run(run.id).status === "success");
    // Server ghi success trước khi worker kịp cộng số đếm: chờ run rời hàng active.
    await worker.idle();

    expect(seen).toEqual([`${run.id}:manual:agent-run:${run.id}`]);
    expect(fake.run(run.id).output).toBe("xong rồi");
    const types = (fake.run(run.id).events as { type: string }[]).map((e) => e.type);
    expect(types[0]).toBe("RUN_STARTED");
    expect(types).toContain("TEXT_MESSAGE_CONTENT");
    expect(types.at(-1)).toBe("RUN_FINISHED");
    expect(worker.health().totals).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
  });

  it("handler ném lỗi → báo failed với thông điệp, run không được giao lại", async () => {
    const run = fake.enqueueRun({ trigger: "manual", prompt: "x" });
    const worker = makeWorker(async () => {
      throw new Error("hỏng rồi");
    });
    worker.start();
    await until(() => fake.run(run.id).status === "failed");
    await worker.idle();
    expect(fake.run(run.id).error).toBe("hỏng rồi");
    await sleep(40);
    expect(fake.run(run.id).attempts).toBe(1);
    expect(worker.health().totals.failed).toBe(1);
  });

  it("outcome failed tường minh được báo đúng, kèm usage", async () => {
    const run = fake.enqueueRun({ trigger: "manual", prompt: "x" });
    makeWorker(async () => ({
      status: "failed",
      error: "không đủ dữ liệu",
      usage: { inputTokens: 10, outputTokens: 1 },
    })).start();
    await until(() => fake.run(run.id).status === "failed");
    expect(fake.run(run.id).error).toBe("không đủ dữ liệu");
    expect(fake.run(run.id).usage).toEqual({ inputTokens: 10, outputTokens: 1 });
  });

  it("giới hạn concurrency", async () => {
    for (let i = 0; i < 6; i++) fake.enqueueRun({ trigger: "manual", prompt: `r${i}` });
    let current = 0;
    let max = 0;
    const worker = makeWorker(
      async () => {
        current++;
        max = Math.max(max, current);
        await sleep(30);
        current--;
      },
      { concurrency: 2 },
    );
    worker.start();
    await until(() => fake.runs.every((r) => r.status === "success"));
    expect(max).toBe(2);
  });

  it("gửi heartbeat có attempt khi handler chạy lâu", async () => {
    const run = fake.enqueueRun({ trigger: "manual", prompt: "x" });
    makeWorker(async () => {
      await sleep(90);
    }).start();
    await until(() => fake.run(run.id).status === "success");
    const beats = fake.requests.filter((r) => r.path.endsWith("/heartbeat"));
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats[0]?.body).toEqual({ attempt: 1 });
  });

  it("mất lease (heartbeat 404) → huỷ handler và KHÔNG báo kết quả", async () => {
    const run = fake.enqueueRun({ trigger: "manual", prompt: "x" });
    fake.fail(/heartbeat/, 404, 100);
    let aborted = false;
    const worker = makeWorker(async (ctx) => {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
      });
      return "không được báo";
    });
    worker.start();
    await until(() => aborted);
    await worker.idle();
    expect(fake.count(`POST /agent-runs/${run.id}/result`)).toBe(0);
    expect(worker.health().totals.dropped).toBe(1);
  });

  it("claim lỗi thì backoff rồi tự hồi phục", async () => {
    const run = fake.enqueueRun({ trigger: "manual", prompt: "x" });
    fake.fail(/claim/, 500, 3);
    const worker = makeWorker(async () => "ok");
    worker.start();
    await until(
      () => worker.health().consecutiveErrors > 0 || fake.run(run.id).status === "success",
    );
    await until(() => fake.run(run.id).status === "success");
    expect(fake.count("POST /agent-runs/claim")).toBeGreaterThanOrEqual(4);
    expect(worker.health().consecutiveErrors).toBe(0);
    expect(worker.health().lastError).toContain("500");
  });

  it("key bị từ chối (401) là lỗi chết: dừng poll và gọi onFatal", async () => {
    let fatal: Error | null = null;
    const worker = new AgentRunWorker({
      client: new AgentRunsClient({ baseUrl: fake.baseUrl, apiKey: "sai" }),
      handler: async () => {},
      pollIntervalMs: 5,
      minPollIntervalMs: 0,
      errorBackoff: { baseMs: 1, maxMs: 2 },
      fatalAfter: 2,
      logger: silent,
      onFatal: (e) => {
        fatal = e;
      },
    });
    workers.push(worker);
    worker.start();
    await until(() => fatal !== null);
    expect(worker.health().state).toBe("failed");
    expect(fake.count("POST /agent-runs/claim")).toBe(2); // đúng fatalAfter lần
    const calls = fake.count("POST /agent-runs/claim");
    await sleep(40);
    expect(fake.count("POST /agent-runs/claim")).toBe(calls);
  });

  it("stop() êm: chờ run đang chạy xong rồi mới dừng", async () => {
    const run = fake.enqueueRun({ trigger: "manual", prompt: "x" });
    let started = false;
    const worker = makeWorker(async () => {
      started = true;
      await sleep(60);
      return "xong";
    });
    worker.start();
    await until(() => started);
    await worker.stop();
    expect(fake.run(run.id).status).toBe("success");
    expect(worker.health().state).toBe("stopped");
    // đã dừng thì không nhận việc mới
    const later = fake.enqueueRun({ trigger: "manual", prompt: "y" });
    await sleep(30);
    expect(fake.run(later.id).attempts).toBe(0);
  });

  it("stop() quá hạn drain: huỷ handler, KHÔNG báo, run còn pending để giao lại", async () => {
    const run = fake.enqueueRun({ trigger: "manual", prompt: "x" });
    let signalAborted = false;
    let started = false;
    const worker = makeWorker(
      async (ctx) => {
        started = true;
        await new Promise<void>((resolve) =>
          ctx.signal.addEventListener("abort", () => {
            signalAborted = true;
            resolve();
          }),
        );
        throw new Error("bị huỷ");
      },
      { drainTimeoutMs: 20 },
    );
    worker.start();
    await until(() => started);
    await worker.stop();
    expect(signalAborted).toBe(true);
    expect(fake.run(run.id).status).toBe("pending");
    expect(fake.count(`POST /agent-runs/${run.id}/result`)).toBe(0);
  });

  it("outcome retry: nhả lease, server giao lại ở lần thử sau", async () => {
    const quick = new FakeItsaplan({ leaseMs: 40 });
    quick.start();
    try {
      const run = quick.enqueueRun({ trigger: "manual", prompt: "x" });
      const attempts: number[] = [];
      const worker = new AgentRunWorker({
        client: new AgentRunsClient({ baseUrl: quick.baseUrl, apiKey: quick.agentKey }),
        handler: async (ctx) => {
          attempts.push(ctx.run.attempts);
          return ctx.run.attempts === 1 ? { status: "retry", reason: "tạm thời" } : "ổn rồi";
        },
        pollIntervalMs: 5,
        minPollIntervalMs: 0,
        heartbeatIntervalMs: 1000,
        logger: silent,
      });
      workers.push(worker);
      worker.start();
      await until(() => quick.run(run.id).status === "success");
      expect(attempts).toEqual([1, 2]);
      expect(worker.health().totals.retried).toBe(1);
    } finally {
      await quick.stop();
    }
  });

  it("idempotency: báo kết quả lỗi thì giữ trong ledger; run giao lại KHÔNG chạy lại handler", async () => {
    const quick = new FakeItsaplan({ leaseMs: 60 });
    quick.start();
    try {
      const run = quick.enqueueRun({ trigger: "manual", prompt: "x" });
      quick.fail(/result/, 500, 1);
      let calls = 0;
      const ledger = new MemoryRunLedger();
      const worker = new AgentRunWorker({
        client: new AgentRunsClient({
          baseUrl: quick.baseUrl,
          apiKey: quick.agentKey,
          retry: { maxRetries: 0 },
        }),
        handler: async () => {
          calls++;
          return "kết quả";
        },
        ledger,
        pollIntervalMs: 5,
        minPollIntervalMs: 0,
        heartbeatIntervalMs: 1000,
        logger: silent,
      });
      workers.push(worker);
      worker.start();
      await until(() => quick.run(run.id).status === "success", 4000);
      await worker.idle();
      expect(calls).toBe(1);
      expect(quick.run(run.id).attempts).toBe(2);
      expect(quick.run(run.id).output).toBe("kết quả");
      expect(worker.health().totals.reportErrors).toBe(1);
      expect(await ledger.get(run.id)).toBeUndefined();
    } finally {
      await quick.stop();
    }
  });

  it("result bị server từ chối vì đã kết thúc (404) thì tính là dropped, không ném", async () => {
    const run = fake.enqueueRun({ trigger: "manual", prompt: "x" });
    const worker = makeWorker(async () => {
      // run bị đóng từ phía server (người dùng huỷ) trong khi handler chạy
      fake.run(run.id).status = "failed";
      return "muộn";
    });
    worker.start();
    await until(() => worker.health().totals.dropped === 1);
    expect(worker.health().totals.succeeded).toBe(0);
  });

  it("run quá runTimeoutMs bị huỷ và báo failed", async () => {
    const run = fake.enqueueRun({ trigger: "manual", prompt: "x" });
    makeWorker(
      async (ctx) => {
        await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
      },
      { runTimeoutMs: 30 },
    ).start();
    await until(() => fake.run(run.id).status === "failed");
    expect(fake.run(run.id).error).toContain("Timed out");
  });

  it("start() hai lần là no-op; health phản ánh trạng thái", async () => {
    const worker = makeWorker(async () => {});
    expect(worker.health().state).toBe("created");
    worker.start();
    worker.start();
    expect(worker.health().state).toBe("running");
    await until(() => worker.health().lastPollAt !== null);
    await worker.stop();
    await worker.stop();
    expect(worker.health().state).toBe("stopped");
  });
  it("handler nhận attempt và maxAttempts", async () => {
    fake.enqueueRun({ trigger: "manual", prompt: "x" });
    const seen: [number, number][] = [];
    makeWorker(
      async (ctx) => {
        seen.push([ctx.attempt, ctx.maxAttempts]);
      },
      { maxAttempts: 5 },
    ).start();
    await until(() => seen.length === 1);
    expect(seen).toEqual([[1, 5]]);
  });

  it("retry ở lượt cuối bị đổi thành failed kèm lý do, không để lease hết hạn trong im lặng", async () => {
    const quick = new FakeItsaplan({ leaseMs: 30 });
    quick.start();
    try {
      const run = quick.enqueueRun({ trigger: "manual", prompt: "x" });
      const attempts: number[] = [];
      const worker = new AgentRunWorker({
        client: new AgentRunsClient({ baseUrl: quick.baseUrl, apiKey: quick.agentKey }),
        handler: async (ctx) => {
          attempts.push(ctx.attempt);
          return { status: "retry", reason: "itsaplan 503" };
        },
        pollIntervalMs: 5,
        minPollIntervalMs: 0,
        heartbeatIntervalMs: 1000,
        logger: silent,
      });
      workers.push(worker);
      worker.start();
      await until(() => quick.run(run.id).status === "failed", 4000);
      await worker.idle();
      expect(attempts).toEqual([1, 2, 3]);
      expect(quick.run(run.id).error).toContain("Hết lượt thử (3/3)");
      expect(quick.run(run.id).error).toContain("itsaplan 503");
      expect(worker.health().totals).toMatchObject({ retried: 2, failed: 1 });
    } finally {
      await quick.stop();
    }
  });

  it("run được giao lại khi đang chạy: huỷ lượt cũ và nhận lượt mới thay vì bỏ qua", async () => {
    const quick = new FakeItsaplan({ leaseMs: 40 });
    quick.start();
    try {
      const run = quick.enqueueRun({ trigger: "manual", prompt: "x" });
      const log: string[] = [];
      const worker = new AgentRunWorker({
        client: new AgentRunsClient({ baseUrl: quick.baseUrl, apiKey: quick.agentKey }),
        handler: async (ctx) => {
          if (ctx.attempt === 1) {
            // heartbeat quá thưa nên lease hết hạn; lượt này phải bị huỷ khi lượt 2 tới
            await new Promise<void>((resolve) =>
              ctx.signal.addEventListener("abort", () => resolve()),
            );
            log.push("lượt 1 bị huỷ");
            return "không được báo";
          }
          log.push(`lượt ${ctx.attempt} chạy`);
          return "xong ở lượt mới";
        },
        concurrency: 2,
        pollIntervalMs: 5,
        minPollIntervalMs: 0,
        heartbeatIntervalMs: 10_000,
        logger: silent,
      });
      workers.push(worker);
      worker.start();
      await until(() => quick.run(run.id).status === "success", 4000);
      await worker.idle();
      expect(log).toContain("lượt 2 chạy");
      expect(log).toContain("lượt 1 bị huỷ");
      expect(quick.run(run.id).output).toBe("xong ở lượt mới");
    } finally {
      await quick.stop();
    }
  });

  it("stop() không bị giữ bởi handler phớt lờ signal: quá drain + grace là bỏ mặc", async () => {
    const run = fake.enqueueRun({ trigger: "manual", prompt: "x" });
    let started = false;
    const worker = makeWorker(
      async () => {
        started = true;
        await new Promise<void>(() => {}); // không bao giờ xong, không nghe signal
      },
      { drainTimeoutMs: 20, abortGraceMs: 20 },
    );
    worker.start();
    await until(() => started);
    const t0 = Date.now();
    await worker.stop();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(worker.health().state).toBe("stopped");
    expect(fake.run(run.id).status).toBe("pending");
    expect(fake.count(`POST /agent-runs/${run.id}/result`)).toBe(0);
  });

  it("ledger hỏng không làm sập worker: vẫn chạy handler và báo kết quả", async () => {
    const run = fake.enqueueRun({ trigger: "manual", prompt: "x" });
    const broken: AgentRunWorkerOptions["ledger"] = {
      get() {
        throw new Error("ledger get hỏng");
      },
      set() {
        throw new Error("ledger set hỏng");
      },
      delete() {
        throw new Error("ledger delete hỏng");
      },
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const worker = makeWorker(async () => "vẫn xong", { ledger: broken });
      worker.start();
      await until(() => fake.run(run.id).status === "success");
      await worker.idle();
      await sleep(10);
      expect(fake.run(run.id).output).toBe("vẫn xong");
      expect(worker.health().totals.succeeded).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("lỗi bất ngờ trong worker bị chặn ở vỏ ngoài: tính dropped, không unhandled rejection", async () => {
    fake.enqueueRun({ trigger: "manual", prompt: "x" });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const throwing: IntakeLogger = {
        ...silent,
        info() {
          throw new Error("logger hỏng");
        },
      };
      const worker = makeWorker(async () => "ok", { logger: throwing });
      worker.start();
      await until(() => worker.health().totals.dropped > 0);
      await worker.stop();
      expect(worker.health().totals.dropped).toBeGreaterThan(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("một lần 401 thoáng qua không giết worker (chưa đủ fatalAfter)", async () => {
    const run = fake.enqueueRun({ trigger: "manual", prompt: "x" });
    fake.fail(/claim/, 401, 1);
    const worker = makeWorker(async () => "ok");
    worker.start();
    await until(() => fake.run(run.id).status === "success");
    await worker.idle();
    expect(worker.health().state).toBe("running");
    expect(worker.health().lastError).toContain("401");
  });

  it("từ chối cấu hình vô lý: heartbeat >= nửa lease, runTimeout <= 0", () => {
    const client = new AgentRunsClient({ baseUrl: "http://10.0.0.1", apiKey: "k" });
    const handler: AgentRunHandler = async () => {};
    expect(() => new AgentRunWorker({ client, handler, heartbeatIntervalMs: 200_000 })).toThrow(
      RangeError,
    );
    expect(() => new AgentRunWorker({ client, handler, heartbeatIntervalMs: 0 })).toThrow(
      RangeError,
    );
    expect(() => new AgentRunWorker({ client, handler, runTimeoutMs: 0 })).toThrow(RangeError);
  });
});
