import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  SqliteOutboxStore,
  OutboxChannelPort,
  outboxApplySchema,
  type OutboxClock,
} from "./outbox";
import type { ChannelPort, NotifyBinding } from "../ports";

/**
 * B1 — outbox opt-in. Mặc định (không bọc) gửi thẳng, hành vi cũ. Khi BỌC:
 * gửi thẳng trước; chỉ khi lỗi mới xếp outbox; drain gửi lại có giới hạn +
 * backoff; hết lượt → failed, không kẹt. Clock tiêm để kiểm backoff.
 */

const binding: NotifyBinding = { issueId: 1, identifier: "OP-1", chatId: "7", channelType: "telegram" };

function fakeClock(start = 0): OutboxClock & { set(ms: number): void } {
  let t = start;
  return { now: () => t, set: (ms: number) => { t = ms; } };
}

function db(): Database {
  const d = new Database(":memory:", { create: true });
  outboxApplySchema(d, { wal: false });
  return d;
}

/** ChannelPort đếm lần gọi; `failTimes` lần đầu ném, sau đó thành công. */
function flakyChannel(failTimes: number) {
  let calls = 0;
  const port: ChannelPort = {
    channelType: "telegram",
    async sendComment() {
      calls++;
      if (calls <= failTimes) throw new Error(`boom ${calls}`);
      return calls;
    },
    async sendStateChange() {
      calls++;
      if (calls <= failTimes) throw new Error(`boom ${calls}`);
      return calls;
    },
  };
  return { port, getCalls: () => calls };
}

describe("OutboxChannelPort (opt-in)", () => {
  it("gửi thẳng ổn → KHÔNG ghi outbox (đường thành công không chậm)", async () => {
    const clock = fakeClock();
    const store = new SqliteOutboxStore(db(), { clock });
    const { port } = flakyChannel(0);
    const wrapped = new OutboxChannelPort(port, store);
    const id = await wrapped.sendComment({ binding, authorName: "KTV", text: "ok" });
    expect(id).toBe(1);
    expect(store.pendingCount()).toBe(0);
  });

  it("gửi thẳng lỗi → trả null + xếp outbox 1 việc", async () => {
    const store = new SqliteOutboxStore(db(), { clock: fakeClock() });
    const { port } = flakyChannel(99);
    const wrapped = new OutboxChannelPort(port, store);
    const id = await wrapped.sendComment({ binding, authorName: "KTV", text: "x" });
    expect(id).toBeNull();
    expect(store.pendingCount()).toBe(1);
  });
});

describe("SqliteOutboxStore.drain", () => {
  it("drain gửi lại thành công → sent, hết pending", async () => {
    const clock = fakeClock(0);
    const store = new SqliteOutboxStore(db(), { clock, backoffBaseMs: 1000 });
    // channel lỗi 1 lần (lúc gửi thẳng), lần drain sau thành công
    const { port } = flakyChannel(1);
    const wrapped = new OutboxChannelPort(port, store);
    await wrapped.sendComment({ binding, authorName: "KTV", text: "x" }); // lỗi → xếp
    expect(store.pendingCount()).toBe(1);

    // chưa tới hạn (next_attempt_at = now khi enqueue, nên tới hạn ngay ở now)
    const r = await store.drain(port);
    expect(r.sent).toBe(1);
    expect(store.pendingCount()).toBe(0);
  });

  it("backoff: việc chưa tới hạn thì drain bỏ qua", async () => {
    const clock = fakeClock(0);
    const store = new SqliteOutboxStore(db(), { clock, backoffBaseMs: 1000, maxAttempts: 5 });
    const { port } = flakyChannel(99); // luôn lỗi
    const wrapped = new OutboxChannelPort(port, store);
    await wrapped.sendComment({ binding, authorName: "KTV", text: "x" }); // xếp, next = now(0)

    // drain lần 1 tại t=0: thử, lỗi → retried, dời next = 0 + 1000
    let r = await store.drain(port);
    expect(r.retried).toBe(1);
    // t=500 chưa tới hạn → không thử
    clock.set(500);
    r = await store.drain(port);
    expect(r.retried + r.sent + r.failed).toBe(0);
    // t=1000 tới hạn → thử tiếp
    clock.set(1000);
    r = await store.drain(port);
    expect(r.retried).toBe(1);
  });

  it("hết maxAttempts → failed, thôi thử (không kẹt vô hạn)", async () => {
    const clock = fakeClock(0);
    const store = new SqliteOutboxStore(db(), { clock, backoffBaseMs: 1, backoffMaxMs: 1, maxAttempts: 3 });
    const { port } = flakyChannel(99);
    const wrapped = new OutboxChannelPort(port, store);
    await wrapped.sendComment({ binding, authorName: "KTV", text: "x" }); // attempts 0, pending

    // mỗi drain +1 attempt; backoff 1ms nên nhích clock chút là tới hạn
    for (let i = 0; i < 5; i++) {
      clock.set(i * 10 + 10);
      await store.drain(port);
    }
    expect(store.pendingCount()).toBe(0); // không còn pending (đã failed)
  });

  it("payload JSON hỏng → failed ngay, không ném", async () => {
    const d = db();
    const clock = fakeClock(0);
    const store = new SqliteOutboxStore(d, { clock });
    d.query(
      `INSERT INTO notify_outbox (kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES ('comment', '{bad json', 'pending', 0, ?, ?, ?)`,
    ).run("1970-01-01T00:00:00.000Z", "1970-01-01T00:00:00.000Z", "1970-01-01T00:00:00.000Z");
    const { port } = flakyChannel(0);
    const r = await store.drain(port);
    expect(r.failed).toBe(1);
    expect(store.pendingCount()).toBe(0);
  });
});
