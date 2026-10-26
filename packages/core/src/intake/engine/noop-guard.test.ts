/**
 * TECH-1148 — chặn tin vô nghĩa và chặn tạo ticket rỗng (BẢN PORT của
 * `apps/tieulinh-legacy/lib/intake-step/noop-guard.test.ts`).
 *
 * Tin rỗng hoặc token nội bộ của nút đã khoá ("noop") KHÔNG kèm ảnh thì bị bỏ
 * qua hoàn toàn: không tạo tờ khai, không tạo ticket, không làm ô nhiễm tiêu
 * đề/mô tả của tờ khai đang gom. Và khi đã tạo ticket, bấm nhầm nút không được
 * mở ticket rỗng thứ hai.
 *
 * Mỗi ca mở đầu bằng MÃ SỰ CỐ GỐC của legacy (TECH-1148 cho cả 6 ca) để truy
 * vết được về đúng sự cố đã đo.
 *
 * Ca 1-5 là PORT của legacy. Ca 6 KHÔNG phải port: legacy ca 6 gọi tool MCP
 * `create_issue` (một cửa vào riêng, chưa có ở core — thuộc PR 15/16), còn ca 6
 * của core là hàng rào "tờ khai trống" ở đường tạo ticket của engine. Sổ đối
 * chiếu ghi ca 6 của legacy là `deferred`.
 *
 * NGUỒN: legacy `lib/intake-step/noop-guard.test.ts` (6 ca); RFC 0002 mục 1.1
 * hàng A11.
 */
import { describe, expect, test } from "bun:test";
import { MIN_CONFIRM_DELAY_MS } from "../confirm";
import { CHAT, makeHarness, report } from "./engine-harness.fixture";
import type { Harness } from "./engine-harness.fixture";

/** Đưa chat tới lúc tóm tắt (đủ trường, sẵn sàng xác nhận). */
async function driveToSummary(h: Harness): Promise<void> {
  h.extractor.push(report(["login is broken"], { values: { van_de: "login is broken" } }));
  const out = await h.engine.step({ chatId: CHAT, message: "login is broken" });
  expect(out.outcome).toBe("summary");
}

describe("TECH-1148: chặn tin noop và chặn tạo ticket rỗng (5 ca port + 1 ca của core)", () => {
  test("1. Tin noop độc lập: bị bỏ qua, KHÔNG tạo tờ khai, KHÔNG tạo ticket", async () => {
    // Mã sự cố gốc: TECH-1148 (legacy `lib/intake-step/noop-guard.test.ts`).
    const h = makeHarness();
    const out = await h.engine.step({ chatId: CHAT, message: "noop" });

    expect(h.drafts.getLatestByChatId(CHAT)).toBeNull();
    expect(h.tracker.created).toHaveLength(0);
    expect(out.outcome).toBe("clarify");
  });

  test("2. Tin callback_data: noop khi chưa có tờ khai: bị bỏ qua, không tạo tờ khai", async () => {
    // Mã sự cố gốc: TECH-1148 (legacy `lib/intake-step/noop-guard.test.ts`).
    const h = makeHarness();
    const out = await h.engine.step({ chatId: CHAT, message: "callback_data: noop" });

    expect(h.drafts.getLatestByChatId(CHAT)).toBeNull();
    expect(h.tracker.created).toHaveLength(0);
    expect(out.outcome).toBe("clarify");
  });

  test("3. Sau khi tạo ticket, bấm nhầm nút noop không mở ticket noop mới", async () => {
    // Mã sự cố gốc: TECH-1148 (legacy `lib/intake-step/noop-guard.test.ts`).
    const h = makeHarness();
    await driveToSummary(h);
    h.extractor.push({ userIntent: "confirm" });
    h.clock.advance(MIN_CONFIRM_DELAY_MS + 1);
    const created = await h.engine.step({ chatId: CHAT, message: "đúng rồi" });
    expect(created.outcome).toBe("created");
    expect(h.tracker.created).toHaveLength(1);

    // Bấm nhầm nút đã khoá → Telegram gửi "callback_data: noop".
    const noop = await h.engine.step({ chatId: CHAT, message: "callback_data: noop" });
    expect(noop.outcome).toBe("already_created");
    expect(h.tracker.created).toHaveLength(1);

    // Tờ khai đã tạo không bị ô nhiễm bởi chữ "noop".
    const stored = h.drafts.getLatestByChatId(CHAT)!;
    expect(stored.ticket.title).not.toBe("noop");
    expect(stored.ticket.rawText).not.toContain("noop");
  });

  test("4. Tin noop trong khi đang thu thập: không làm ô nhiễm title hay rawText", async () => {
    // Mã sự cố gốc: TECH-1148 (legacy `lib/intake-step/noop-guard.test.ts`).
    const h = makeHarness();
    h.extractor.push(report(["CRM đơn hàng không mở"], { values: { van_de: "CRM đơn hàng" } }));
    await h.engine.step({ chatId: CHAT, message: "CRM bị lỗi đơn hàng không mở được" });

    const before = h.drafts.getLatestByChatId(CHAT)!;
    const titleBefore = before.ticket.title;
    const rawBefore = before.ticket.rawText;
    const revisionBefore = before.revision;

    await h.engine.step({ chatId: CHAT, message: "noop" });

    const after = h.drafts.getLatestByChatId(CHAT)!;
    expect(after.ticket.title).toBe(titleBefore);
    expect(after.ticket.rawText).toBe(rawBefore);
    expect(after.ticket.rawText).not.toContain("noop");
    expect(after.revision).toBe(revisionBefore);
  });

  test("5. Hàng rào tạo ticket: từ chối khi tiêu đề hoặc mô tả chỉ là token nội bộ (noop)", async () => {
    // Mã sự cố gốc: TECH-1148 (legacy `lib/intake-step/noop-guard.test.ts`).
    const h = makeHarness();
    // Tờ khai có sẵn tiêu đề/mô tả chỉ là token nội bộ.
    const nowIso = new Date(h.clock.now()).toISOString();
    h.drafts.saveRevision({
      docId: "doc_bad_noop",
      chatId: CHAT,
      revision: 1,
      status: "ready_for_confirmation",
      version: 2,
      ticket: { title: "noop", rawText: "noop", priority: "medium", mediaPaths: [] },
      summaryShownAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    h.extractor.push({ userIntent: "confirm" });
    h.clock.advance(MIN_CONFIRM_DELAY_MS + 1);
    const out = await h.engine.step({ chatId: CHAT, message: "đúng rồi" });

    expect(out.outcome).toBe("needs_resend");
    expect(h.tracker.created).toHaveLength(0);
  });

  test("6. Hàng rào tạo ticket: tờ khai trống (tiêu đề và mô tả rỗng) cũng không tạo ticket", async () => {
    // Mã sự cố gốc: TECH-1148 (legacy `lib/intake-step/noop-guard.test.ts`).
    // Ca này KHÔNG phải port của ca 6 của legacy (legacy gọi tool MCP
    // `create_issue`, thuộc PR 15/16): đây là nhánh "rỗng" của hàng rào ở đường
    // tạo ticket của core, bù cho ca 5 (nhánh "chỉ là noop").
    const h = makeHarness();
    const nowIso = new Date(h.clock.now()).toISOString();
    h.drafts.saveRevision({
      docId: "doc_empty",
      chatId: CHAT,
      revision: 1,
      status: "ready_for_confirmation",
      version: 2,
      ticket: { title: "", rawText: "", priority: "medium", mediaPaths: [] },
      summaryShownAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    h.extractor.push({ userIntent: "confirm" });
    h.clock.advance(MIN_CONFIRM_DELAY_MS + 1);
    const out = await h.engine.step({ chatId: CHAT, message: "đúng rồi" });

    expect(out.outcome).toBe("needs_resend");
    expect(h.tracker.created).toHaveLength(0);
  });
});
