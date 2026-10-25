import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../lib/storage/schema";
import { KgSyncRepository } from "../lib/storage/kg-sync-repository";
import { KgSyncRunner, resolveKgSyncGate } from "./kg-sync-runner";

describe("resolveKgSyncGate — KG chỉ bật khi được mời rõ ràng", () => {
  test("có MEMGRAPH_URI nhưng dự án không nằm trong KG_SYNC_PROJECTS → tắt (Iris/PO)", () => {
    const gate = resolveKgSyncGate({
      MEMGRAPH_URI: "bolt://x:7687",
      ITSAPLAN_PROJECT_KEY: "PO",
      KG_SYNC_PROJECTS: "TECHTEST",
    });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain("PO");
  });

  test("KG_SYNC_PROJECTS rỗng (mặc định) → tắt dù có MEMGRAPH_URI", () => {
    expect(
      resolveKgSyncGate({ MEMGRAPH_URI: "bolt://x:7687", ITSAPLAN_PROJECT_KEY: "TECH" }).enabled,
    ).toBe(false);
  });

  test("thiếu MEMGRAPH_URI → tắt", () => {
    const gate = resolveKgSyncGate({
      ITSAPLAN_PROJECT_KEY: "TECHTEST",
      KG_SYNC_PROJECTS: "TECHTEST",
    });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain("MEMGRAPH_URI");
  });

  test("thiếu ITSAPLAN_PROJECT_KEY → tắt (không biết mình là ai)", () => {
    expect(
      resolveKgSyncGate({ MEMGRAPH_URI: "bolt://x", KG_SYNC_PROJECTS: "TECHTEST" }).enabled,
    ).toBe(false);
  });

  test("có MEMGRAPH_URI và dự án được liệt kê (không phân biệt hoa thường, có khoảng trắng) → bật", () => {
    const gate = resolveKgSyncGate({
      MEMGRAPH_URI: "bolt://x:7687",
      ITSAPLAN_PROJECT_KEY: "techtest",
      KG_SYNC_PROJECTS: " TECHTEST2 , techtest ",
    });
    expect(gate.enabled).toBe(true);
    expect(gate.projectKey).toBe("TECHTEST");
  });
});

function setup(
  syncImpl: (
    issueId: number,
    identifier: string,
  ) => Promise<{ success: boolean; skipped?: boolean; error?: string }>,
) {
  const db = new Database(":memory:");
  applySchema(db);
  const repo = new KgSyncRepository(db);
  let now = 1_000_000;
  const sync = mock(syncImpl);
  const runner = new KgSyncRunner({
    sync,
    repo,
    projectKey: "TECHTEST",
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 10_000,
    now: () => now,
  });
  return { db, repo, runner, sync, advance: (ms: number) => (now += ms), now: () => now };
}

describe("KgSyncRunner — chống chạy trùng", () => {
  // Một lần đóng có thể tới 2 lần gần như cùng lúc (webhook lặp, hàng đợi thử lại) và
  // dispatcher gọi lần nữa — hai lượt đồng thời cho cùng một ticket.
  test("hai lượt đồng thời cho cùng ticket chỉ sync một lần", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup(async () => {
      await gate;
      return { success: true };
    });

    const a = t.runner.handle(1, "TECHTEST-1");
    const b = t.runner.handle(1, "TECHTEST-1");
    release();
    await Promise.all([a, b]);

    expect(t.sync).toHaveBeenCalledTimes(1);
  });

  test("ticket khác dự án không được xếp hàng/sync", async () => {
    const t = setup(async () => ({ success: true }));
    await t.runner.handle(2, "PO-2");
    expect(t.sync).not.toHaveBeenCalled();
    expect(t.repo.listQueue()).toHaveLength(0);
  });
});

describe("KgSyncRunner — hàng đợi thử lại bền vững", () => {
  test("sync lỗi → vào kg_sync_queue với backoff; tới hạn thì thử lại; thành công thì xoá", async () => {
    let fail = true;
    const t = setup(async () =>
      fail ? { success: false, error: "bolt down" } : { success: true },
    );

    await t.runner.handle(5, "TECHTEST-5");
    const [row] = t.repo.listQueue();
    expect(row).toMatchObject({
      identifier: "TECHTEST-5",
      issue_id: 5,
      attempts: 1,
      last_error: "bolt down",
    });
    expect(row.next_attempt_at).toBe(t.now() + 1000);

    // Chưa tới hạn → không thử.
    await t.runner.processDue();
    expect(t.sync).toHaveBeenCalledTimes(1);

    t.advance(1000);
    await t.runner.processDue();
    expect(t.sync).toHaveBeenCalledTimes(2);
    expect(t.repo.listQueue()[0]).toMatchObject({ attempts: 2, next_attempt_at: t.now() + 2000 });

    fail = false;
    t.advance(2000);
    await t.runner.processDue();
    expect(t.repo.listQueue()).toHaveLength(0);
  });

  test("hết số lần thử thì bỏ cuộc (xoá khỏi hàng đợi, log lỗi)", async () => {
    const t = setup(async () => ({ success: false, error: "LLM sai schema" }));
    await t.runner.handle(6, "TECHTEST-6");
    for (let i = 0; i < 5; i++) {
      t.advance(60_000);
      await t.runner.processDue();
    }
    expect(t.sync).toHaveBeenCalledTimes(3);
    expect(t.repo.listQueue()).toHaveLength(0);
  });

  test("sync ném exception cũng được xếp hàng", async () => {
    const t = setup(async () => {
      throw new Error("boom");
    });
    await t.runner.handle(7, "TECHTEST-7");
    expect(t.repo.listQueue()[0]).toMatchObject({ attempts: 1, last_error: "boom" });
  });

  test("hàng đợi sống qua restart: runner mới trên cùng DB xử lý mục tồn đọng", async () => {
    const t = setup(async () => ({ success: false, error: "x" }));
    await t.runner.handle(8, "TECHTEST-8");

    const sync2 = mock(async () => ({ success: true }));
    const runner2 = new KgSyncRunner({
      sync: sync2,
      repo: new KgSyncRepository(t.db),
      projectKey: "TECHTEST",
      now: () => t.now() + 10_000,
    });
    await runner2.processDue();
    expect(sync2).toHaveBeenCalledWith(8, "TECHTEST-8");
    expect(t.repo.listQueue()).toHaveLength(0);
  });

  test("mục của dự án khác trong DB dùng chung không bị worker này xử lý", async () => {
    const t = setup(async () => ({ success: true }));
    t.repo.enqueueFailure({
      identifier: "PO-9",
      issueId: 9,
      projectKey: "PO",
      error: "x",
      nextAttemptAt: 0,
      now: 0,
    });
    await t.runner.processDue();
    expect(t.sync).not.toHaveBeenCalled();
    expect(t.repo.listQueue()).toHaveLength(1);
  });

  test("processDue chồng nhau thì lượt sau bỏ qua", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup(async () => {
      await gate;
      return { success: true };
    });
    t.repo.enqueueFailure({
      identifier: "TECHTEST-10",
      issueId: 10,
      projectKey: "TECHTEST",
      error: "x",
      nextAttemptAt: 0,
      now: 0,
    });
    const first = t.runner.processDue();
    await t.runner.processDue();
    release();
    await first;
    expect(t.sync).toHaveBeenCalledTimes(1);
  });
});

describe("KgSyncRunner cho sink Onyx — hàng đợi riêng", () => {
  // Trước 24/09 Onyx lỗi là mất việc (không queue); giờ dùng cùng runner với bảng riêng.
  test("Onyx lỗi thì vào onyx_ingest_queue, không lẫn sang kg_sync_queue", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const onyxRepo = new KgSyncRepository(db, "onyx_ingest_queue");
    const kgRepo = new KgSyncRepository(db);
    const runner = new KgSyncRunner({
      label: "Onyx",
      repo: onyxRepo,
      projectKey: "TECH",
      sync: async () => ({ success: false, error: "Onyx 502" }),
      now: () => 1_000,
    });

    await runner.handle(7, "TECH-7");

    expect(onyxRepo.getQueued("TECH-7")?.last_error).toBe("Onyx 502");
    expect(kgRepo.getQueued("TECH-7")).toBeNull();
  });
});

describe("resolveOnyxSyncGate — Iris/PO không bao giờ nạp Onyx (ADR-0002)", () => {
  const { resolveOnyxSyncGate } = require("./kg-sync-runner");

  test("PO có ONYX_BASE_URL (đọc chung apps/tieulinh-legacy/.env) vẫn tắt", () => {
    expect(
      resolveOnyxSyncGate({ ONYX_BASE_URL: "https://onyx", ITSAPLAN_PROJECT_KEY: "PO" }).enabled,
    ).toBe(false);
  });

  test("mặc định chỉ TECH được nạp", () => {
    expect(
      resolveOnyxSyncGate({ ONYX_BASE_URL: "https://onyx", ITSAPLAN_PROJECT_KEY: "TECH" }).enabled,
    ).toBe(true);
    expect(
      resolveOnyxSyncGate({ ONYX_BASE_URL: "https://onyx", ITSAPLAN_PROJECT_KEY: "TECHTEST" })
        .enabled,
    ).toBe(false);
  });

  test("ONYX_SYNC_PROJECTS mở cho dự án khác, nhưng PO vẫn bị chặn cứng", () => {
    expect(
      resolveOnyxSyncGate({
        ONYX_BASE_URL: "x",
        ITSAPLAN_PROJECT_KEY: "TECHTEST",
        ONYX_SYNC_PROJECTS: "TECH,TECHTEST",
      }).enabled,
    ).toBe(true);
    expect(
      resolveOnyxSyncGate({
        ONYX_BASE_URL: "x",
        ITSAPLAN_PROJECT_KEY: "PO",
        ONYX_SYNC_PROJECTS: "PO",
      }).enabled,
    ).toBe(false);
  });

  test("thiếu ONYX_BASE_URL → tắt", () => {
    expect(resolveOnyxSyncGate({ ITSAPLAN_PROJECT_KEY: "TECH" }).enabled).toBe(false);
  });
});
