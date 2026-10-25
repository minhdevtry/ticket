import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createKeysProvider } from "@vuihoc/bot-core/backoffice";
import { ConfigError } from "@vuihoc/bot-core/core";
import { HOUR, type Harness, T0, harness, sleep, until } from "./testkit";
import type { TieulinhServices } from "./services";
import { SLA_PAGE, slaHoursFor, slaSweep } from "./sla";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.stop());

const alerts = () => h.channelLog().filter((r) => r.kind === "alert");
const sweeps = () => h.fake.count(/^GET .*\/issues/);

describe("nhắc quá hạn tiếp nhận (SLA)", () => {
  test("cron + đồng hồ giả: ticket chưa giao quá hạn thì nhắc trực ca đúng một lần, không đổi cột", async () => {
    const { app, bot } = h.boot({ env: { TIEULINH_SLA_CRON: "* * * * *" } });
    app.services(); // ghim mốc bắt đầu theo dõi tại T0

    const mkAt = (title: string, extra: Parameters<typeof h.fake.addIssue>[0] | object = {}) =>
      h.fake.addIssue({
        title,
        columnId: 2,
        createdAt: new Date(T0 + 1000).toISOString(),
        ...extra,
      } as never);
    const urgent = mkAt("Mất kết nối cổng thanh toán", { priority: "urgent" });
    const medium = mkAt("Lỗi hiển thị báo cáo", { priority: "medium" });
    mkAt("Đã có người nhận", { priority: "urgent", assigneeUserId: "staff-1" });
    mkAt("Đang xử lý rồi", { priority: "urgent", columnId: 3 });
    h.fake.addIssue({
      title: "Ticket cũ trước khi bot theo dõi",
      priority: "urgent",
      columnId: 2,
      createdAt: new Date(T0 - 10 * HOUR).toISOString(),
    });

    await bot.start();
    await sleep(80);
    expect(alerts()).toHaveLength(0); // chưa tới hạn nào

    h.clock.t = T0 + HOUR + 2 * 60_000; // quá hạn 1 giờ của urgent
    await until(() => alerts().length === 1);
    expect(alerts()[0]!.text).toContain(urgent.identifier);
    expect(alerts()[0]!.text).toContain("URGENT");

    // quét tiếp nhiều nhịp: không nhắc lại
    const before = sweeps();
    h.clock.t += 60_000;
    await until(() => sweeps() > before);
    expect(alerts()).toHaveLength(1);

    h.clock.t = T0 + 4 * HOUR + 2 * 60_000; // quá hạn 4 giờ của medium
    await until(() => alerts().length === 2);
    expect(alerts()[1]!.text).toContain(medium.identifier);
    expect(alerts().filter((a) => a.text?.includes(urgent.identifier))).toHaveLength(1);

    // chỉ nhắc, không đụng cột hay người nhận (ADR-0006)
    expect(h.fake.count(/^(PATCH|PUT|DELETE) /)).toBe(0);
    expect(h.fake.issues.find((i) => i.id === urgent.id)!.columnId).toBe(2);
  });

  test("khởi động lại cùng thư mục dữ liệu: ticket đã nhắc không bị nhắc lại", async () => {
    h.fake.addIssue({
      title: "Quá hạn",
      priority: "low",
      columnId: 1,
      createdAt: new Date(T0 + 1000).toISOString(),
    });
    const first = h.boot({ env: { TIEULINH_SLA_CRON: "* * * * *" } });
    first.app.services();
    await first.bot.start();
    h.clock.t = T0 + 25 * HOUR;
    await until(() => alerts().length === 1);
    await first.bot.stop();
    first.app.close();

    const second = h.boot({ env: { TIEULINH_SLA_CRON: "* * * * *" } });
    const before = sweeps();
    await second.bot.start();
    h.clock.t += 5 * 60_000;
    await until(() => sweeps() > before);
    await sleep(50);
    expect(alerts()).toHaveLength(1);
  });

  test("lượt quét chồng nhau bị bỏ qua (không cảnh báo hai lần)", async () => {
    const { app } = h.boot();
    const svc = app.services();
    h.fake.addIssue({
      title: "Quá hạn",
      priority: "urgent",
      columnId: 1,
      createdAt: new Date(T0 + 1000).toISOString(),
    });
    h.clock.t = T0 + 3 * HOUR;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const real = h.tracker();
    const slow = { ...real, columns: async () => (await gate, real.columns()) };
    const warns: string[] = [];
    const ctx = {
      tracker: slow,
      clock: h.clock,
      keys: createKeysProvider(null),
      logger: { debug() {}, info() {}, warn: (m: string) => warns.push(m), error() {} },
    } as never;
    const sweep = slaSweep(svc);
    const first = sweep(ctx);
    await sweep(ctx); // lượt chồng: trả ngay
    expect(warns.some((w) => w.includes("bỏ qua"))).toBe(true);
    release();
    await first;
    expect(alerts()).toHaveLength(1);
  });

  test("hạn theo ưu tiên: urgent 1h, high 2h, medium 4h, low 24h, không rõ = medium", () => {
    expect(["urgent", "high", "medium", "low", null, "weird"].map(slaHoursFor)).toEqual([
      1, 2, 4, 24, 4, 4,
    ]);
  });

  /** Chạy thẳng một lượt quét với tracker thật và bộ khoá do test giữ (để quét lại nhiều lượt). */
  function direct(svc: TieulinhServices) {
    const keys = createKeysProvider(null);
    const warns: string[] = [];
    const ctx = {
      tracker: h.tracker(),
      clock: h.clock,
      keys,
      logger: { debug() {}, info() {}, warn: (m: string) => warns.push(m), error() {} },
    } as never;
    return { run: () => slaSweep(svc)(ctx), warns };
  }

  const overdue = (title: string, extra: object = {}) =>
    h.fake.addIssue({
      title,
      priority: "urgent",
      columnId: 1,
      createdAt: new Date(T0 + 1000).toISOString(),
      ...extra,
    } as never);

  test("nhiều hơn một trang ticket: cửa sổ chạm trần chia đôi, không sót ticket nào", async () => {
    const { app } = h.boot();
    const svc0 = app.services(); // ghim mốc theo dõi tại T0
    const n = SLA_PAGE + 20;
    for (let i = 0; i < n; i++) {
      // trải đều trong 10 phút để chia đôi cửa sổ tách được
      overdue(`Quá hạn ${i}`, { createdAt: new Date(T0 + 1000 + i * 1000).toISOString() });
    }
    h.clock.t = T0 + 3 * HOUR;
    const { run } = direct(svc0);
    await run();
    expect(alerts()).toHaveLength(n);
    // ticket đã giao hoặc ngoài cột chờ vẫn không bị nhắc dù nằm giữa kho lớn
    expect(new Set(alerts().map((a) => a.text)).size).toBe(n);
  });

  test("kênh báo chưa giao được (false): không đánh dấu, lượt sau giao được thì nhắc", async () => {
    let deliver = false;
    const sent: string[] = [];
    const { app } = h.boot({
      appOptions: {
        channel: {
          channelType: "test",
          sendComment: async () => "c",
          sendStateChange: async () => "s",
          sendAlert: async (text: string) => {
            if (!deliver) return false;
            sent.push(text);
          },
        },
      },
    });
    const svc = app.services(); // ghim mốc theo dõi tại T0
    overdue("Quá hạn");
    h.clock.t = T0 + 3 * HOUR;
    const { run } = direct(svc);
    await run();
    expect(sent).toHaveLength(0);
    deliver = true;
    await run();
    expect(sent).toHaveLength(1);
    await run();
    expect(sent).toHaveLength(1);
  });

  test("kênh ném lỗi: không đánh dấu, lượt sau thử lại", async () => {
    let fail = true;
    const sent: string[] = [];
    const { app } = h.boot({
      appOptions: {
        channel: {
          channelType: "test",
          sendComment: async () => "c",
          sendStateChange: async () => "s",
          sendAlert: async (text: string) => {
            if (fail) throw new Error("telegram sập");
            sent.push(text);
          },
        },
      },
    });
    const svc = app.services(); // ghim mốc theo dõi tại T0
    overdue("Quá hạn");
    h.clock.t = T0 + 3 * HOUR;
    const { run } = direct(svc);
    await run();
    fail = false;
    await run();
    expect(sent).toHaveLength(1);
  });

  test("cảnh báo có link ticket khi đặt ITSAPLAN_WEB_URL, không có thì không bịa link", async () => {
    const withUrl = h.boot({ env: { ITSAPLAN_WEB_URL: "https://itsaplan.example.com/" } });
    const svc = withUrl.app.services();
    const t = overdue("Quá hạn");
    h.clock.t = T0 + 3 * HOUR;
    await direct(svc).run();
    expect(alerts()[0]!.text).toContain(
      `Link: https://itsaplan.example.com/tech/issue/${t.identifier}`,
    );
  });

  test("không đặt ITSAPLAN_WEB_URL: cảnh báo không có dòng Link", async () => {
    const svc = h.boot().app.services();
    overdue("Quá hạn");
    h.clock.t = T0 + 3 * HOUR;
    await direct(svc).run();
    expect(alerts()[0]!.text).not.toContain("Link:");
  });

  test("có TELEGRAM_BOT_TOKEN mà thiếu TIEULINH_ONCALL_CHAT_ID: ConfigError ngay lúc dựng bot", () => {
    expect(() => h.boot({ env: { TELEGRAM_BOT_TOKEN: "123456:fake-token" } })).toThrow(ConfigError);
    expect(() =>
      h.boot({
        env: { TELEGRAM_BOT_TOKEN: "123456:fake-token", TIEULINH_ONCALL_CHAT_ID: "-1000000000009" },
        appOptions: { telegram: { fetch: (async () => new Response("{}")) as never } },
      }),
    ).not.toThrow();
  });
});
