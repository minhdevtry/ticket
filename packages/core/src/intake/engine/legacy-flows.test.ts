/**
 * Sáu kịch bản lễ tân của legacy được PORT sang engine của core
 * (RFC 0002 PR 4, hàng "Test legacy được port").
 *
 * Tên test GIỮ NGUYÊN tên của legacy để sổ đối chiếu trỏ tới được. Mỗi kịch
 * bản chạy qua cổng công khai `IntakeEngine.step()`. Mỗi ca mở đầu bằng MÃ SỰ
 * CỐ GỐC của legacy (vd TECH-924 cho phong bì kênh) để truy vết được về đúng
 * sự cố đã đo.
 *
 * NGUỒN: legacy `lib/intake-step/pipeline.flow.test.ts` — "ok khi tài liệu chưa
 * từng được tóm tắt", "không biết", "không vào được lớp", "xác nhận lần hai",
 * "phong bì", "tin rất dài".
 */
import { describe, expect, test } from "bun:test";
import { MIN_CONFIRM_DELAY_MS } from "../confirm";
import { CHAT, makeHarness, report } from "./engine-harness.fixture";
import type { Harness } from "./engine-harness.fixture";
import { MAX_RAW_TEXT_CHARS } from "./engine";

/** Đưa chat tới lúc tóm tắt (đủ trường, sẵn sàng xác nhận). */
async function toSummary(h: Harness): Promise<void> {
  h.extractor.push(report(["login broken"], { values: { van_de: "login broken" } }));
  const out = await h.engine.step({ chatId: CHAT, message: "login broken" });
  expect(out.outcome).toBe("summary");
}

describe("port kịch bản lễ tân của legacy (RFC 0002 PR 4)", () => {
  test("'ok' khi tài liệu chưa từng được tóm tắt không tạo ticket", async () => {
    // Mã sự cố gốc: legacy "Bug 3: xác nhận nhầm"
    // (`lib/intake-step/pipeline.flow.test.ts`).
    const h = makeHarness();
    // Lượt 1: còn thiếu trường → engine hỏi, CHƯA có tóm tắt.
    h.extractor.push({ userIntent: "report_issue", symptoms: [], title: null });
    const asked = await h.engine.step({ chatId: CHAT, message: "Lỗi app Duo" });
    expect(asked.outcome).toBe("asked");

    // Lượt 2: "ok" — chưa có tóm tắt thì không được tạo ticket.
    h.extractor.push({ userIntent: "confirm" });
    const out = await h.engine.step({ chatId: CHAT, message: "ok" });
    expect(out.outcome).not.toBe("created");
    expect(h.tracker.created).toHaveLength(0);
  });

  test("'không biết' được ghi vào explicitlyMissing và bot thôi hỏi trường đó", async () => {
    // Mã sự cố gốc: legacy "Bug 7: câu hỏi gộp, nút bấm, explicitlyMissing"
    // (`lib/intake-step/pipeline.flow.test.ts`).
    const h = makeHarness();
    // Lượt 1: còn thiếu `van_de` → engine hỏi.
    h.extractor.push({ userIntent: "report_issue", symptoms: [], title: null });
    const asked = await h.engine.step({ chatId: CHAT, message: "có lỗi" });
    expect(asked.outcome).toBe("asked");

    // Lượt 2: người báo nói rõ không biết.
    h.extractor.push({ userIntent: "provide_info", symptoms: [] });
    await h.engine.step({ chatId: CHAT, message: "em không biết ạ" });

    const draft = h.drafts.getLatestByChatId(CHAT)!;
    expect(draft.record?.explicitlyMissing).toContain("van_de");
    // Bot thôi hỏi trường đó: lượt sau không hỏi lại `van_de`.
    h.extractor.push({ userIntent: "provide_info", symptoms: [] });
    const out = await h.engine.step({ chatId: CHAT, message: "vậy thì bỏ qua" });
    expect(out.outcome).toBe("summary");
    expect(out.messages[0].text).not.toContain("What's the problem?");
  });

  test("'không vào được lớp' không huỷ tài liệu (không LLM)", async () => {
    // Mã sự cố gốc: legacy "Bug 3: xác nhận nhầm"
    // (`lib/intake-step/pipeline.flow.test.ts`).
    const h = makeHarness();
    h.extractor.push(report(["không vào được lớp"], { values: { van_de: "không vào được lớp" } }));
    const out = await h.engine.step({ chatId: CHAT, message: "không vào được lớp trên app Duo" });

    expect(out.outcome).not.toBe("canceled");
    expect(h.drafts.getLatestByChatId(CHAT)?.status).not.toBe("canceled");
  });

  test("xác nhận lần hai: không tạo thêm, không comment rác", async () => {
    // Mã sự cố gốc: legacy "Bug 1: sau khi tạo"
    // (`lib/intake-step/pipeline.flow.test.ts`).
    const h = makeHarness();
    await toSummary(h);
    h.extractor.push({ userIntent: "confirm" });
    h.clock.advance(MIN_CONFIRM_DELAY_MS + 1);
    const first = await h.engine.step({ chatId: CHAT, message: "đúng rồi" });
    expect(first.outcome).toBe("created");

    h.extractor.push({ userIntent: "confirm" });
    const again = await h.engine.step({ chatId: CHAT, message: "đúng rồi" });
    expect(again.outcome).toBe("already_created");
    expect(h.tracker.created).toHaveLength(1);
    expect(h.tracker.comments).toHaveLength(0);
  });

  test("phong bì kênh (Conversation info / Sender / context) không lọt vào mô tả ticket", async () => {
    // Mã sự cố gốc: TECH-924 (26/09) — phong bì OpenClaw lọt vào mô tả ticket
    // (`lib/intake-step/pipeline.flow.test.ts`).
    const h = makeHarness();
    const envelope = [
      "Lỗi app Duo học sinh không làm bài được",
      "Conversation info (untrusted metadata):",
      "{",
      '  "chat_id": "telegram:1000000003",',
      '  "username": "SA_UserH"',
      "}",
    ].join("\n");
    h.extractor.push(report(["Lỗi app Duo"], { values: { van_de: "Lỗi app Duo" } }));
    await h.engine.step({ chatId: CHAT, message: envelope });

    h.extractor.push({ userIntent: "confirm" });
    h.clock.advance(MIN_CONFIRM_DELAY_MS + 1);
    await h.engine.step({ chatId: CHAT, message: "đúng rồi" });

    const description = h.tracker.created[0].description;
    expect(description).not.toContain("untrusted");
    expect(description).not.toContain("telegram:1000000003");
    expect(description).toContain("Lỗi app Duo");
  });

  test("tin nhắn rất dài không thổi phồng mô tả ticket", async () => {
    // Mã sự cố gốc: legacy "Bug 10: tin rất dài"
    // (`lib/intake-step/pipeline.flow.test.ts`).
    const h = makeHarness();
    const huge = `Lỗi app Duo đăng nhập ${"log ".repeat(20_000)}`;
    h.extractor.push(report(["Lỗi app Duo"], { values: { van_de: "Lỗi app Duo" } }));
    await h.engine.step({ chatId: CHAT, message: huge });

    const draft = h.drafts.getLatestByChatId(CHAT)!;
    expect(draft.ticket.rawText.length).toBeLessThanOrEqual(MAX_RAW_TEXT_CHARS);
  });
});
