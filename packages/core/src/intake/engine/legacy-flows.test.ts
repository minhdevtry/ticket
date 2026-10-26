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
import { createCatalog } from "../gate/catalog";
import { makeCopyCatalog } from "../copy-catalog";
import { TEST_COPY } from "./test-copy.fixture";
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

  // ── PR 7 (RFC 0002 §1.5 A1-A5, B3, B4) ──────────────────────────────────
  test("tóm tắt hiện mức ưu tiên bằng tiếng Việt, không in 'MEDIUM'", async () => {
    // Mã sự cố gốc: legacy pipeline.flow.test.ts
    const h = makeHarness({
      copy: makeCopyCatalog({
        ...TEST_COPY,
        "priority.level.medium": "Trung bình",
      }),
    });
    h.extractor.push(report(["Lỗi app Duo"], { values: { van_de: "Lỗi app Duo" } }));
    const r = await h.engine.step({ chatId: CHAT, message: "Lỗi app Duo" });
    expect(r.outcome).toBe("summary");
    expect(r.messages[0].text).not.toContain("MEDIUM");
    expect(r.messages[0].text).toContain("Trung bình");
  });

  test("câu hỏi dùng nhãn tiếng Việt, không lộ tên trường nội bộ, và nút được đẩy ra Telegram", async () => {
    // Mã sự cố gốc: legacy pipeline.flow.test.ts
    const h = makeHarness({
      catalog: createCatalog({
        fields: {
          nhanh: {
            tech: {
              ten: "Tech",
              truong_mo_dau: "reporting_dept",
              recap: ["reporting_dept"],
              truong: {
                reporting_dept: {
                  bat_buoc: true,
                  kieu: "enum:phong_ban",
                  duoc_hoi: true,
                  nhan: "Bộ phận",
                  hoi: "Anh/chị ở bộ phận nào ạ?",
                },
              },
            },
          },
        },
        enums: { phong_ban: ["Sale", "CSKH"] },
      }),
    });
    h.extractor.push({
      userIntent: "report_issue",
      symptoms: ["Lỗi app Duo"],
      title: "Lỗi app Duo",
    });
    const r = await h.engine.step({
      chatId: CHAT,
      message: "Lỗi app Duo học sinh 0900000005 không làm bài được",
    });
    expect(r.outcome).toBe("asked");
    expect(r.messages[0].text).not.toContain("reporting_dept");
    expect(r.messages[0].text).not.toContain("reportingDept");
    expect(r.messages[0].buttons?.length).toBeGreaterThan(0);
  });

  test("mặc định Medium (không còn rơi về Low) và gửi Itsaplan chữ thường", async () => {
    // Mã sự cố gốc: legacy pipeline.flow.test.ts
    const h = makeHarness();
    h.extractor.push(report(["Lỗi app Duo"], { values: { van_de: "Lỗi app Duo" } }));
    await h.engine.step({ chatId: CHAT, message: "Lỗi app Duo" });
    h.extractor.push({ userIntent: "confirm" });
    h.clock.advance(MIN_CONFIRM_DELAY_MS + 1);
    await h.engine.step({ chatId: CHAT, message: "yes" });
    expect(h.tracker.created[0].priority).toBe("medium");
  });

  test("xin gấp chưa có lý do → hỏi một lần; trả lời lý do → High", async () => {
    // Mã sự cố gốc: legacy pipeline.flow.test.ts (29/09: xin gấp có lý do thì cho hết)
    const h = makeHarness({
      copy: makeCopyCatalog({
        ...TEST_COPY,
        "ask.priority_reason":
          'Dạ anh/chị cho em biết lý do cần xử lý gấp để em đặt mức {level} nhé ạ. Không có lý do cụ thể thì nhắn "không có".',
      }),
    });
    h.extractor.push({
      userIntent: "report_issue",
      title: "Sai hạn khoá",
      symptoms: ["khoá tự học sai hạn"],
      values: { van_de: "khoá tự học sai hạn" },
      requestedPriority: "high",
    });
    const r1 = await h.engine.step({
      chatId: CHAT,
      message: "khoá tự học sai hạn, em bên CSKH, xử lý gấp giúp em",
    });
    expect(r1.outcome).toBe("asked");
    expect(r1.messages[0].text).toContain("lý do");

    h.extractor.push({ userIntent: "provide_info", symptoms: [] });
    const r2 = await h.engine.step({ chatId: CHAT, message: "học sinh mai thi rồi ạ" });
    expect(r2.outcome).toBe("summary");
    const draft = h.drafts.getLatestByChatId(CHAT);
    expect(draft?.ticket.priority).toBe("high");
    expect(draft?.requestedPriority?.reason).toBe("học sinh mai thi rồi ạ");
  });

  test("thiếu hệ thống: hỏi MỘT lần kèm nút, không biết thì tóm tắt ghi rõ 'Chưa xác định'", async () => {
    // Mã sự cố gốc: legacy "Bug 10: hệ thống chưa rõ"
    const h = makeHarness({
      copy: makeCopyCatalog({
        ...TEST_COPY,
        "field.unknown_value": "Chưa xác định",
      }),
      catalog: createCatalog({
        fields: {
          nhanh: {
            tech: {
              ten: "Tech",
              truong_mo_dau: "van_de",
              recap: ["van_de", "system"],
              truong: {
                van_de: {
                  bat_buoc: true,
                  kieu: "text",
                  duoc_hoi: true,
                  nhan: "Vấn đề",
                  hoi: "Vấn đề gì?",
                },
                system: {
                  bat_buoc: false,
                  kieu: "enum:system",
                  duoc_hoi: true,
                  nhan: "Hệ thống",
                  hoi: "Hệ thống nào?",
                },
              },
            },
          },
        },
        enums: { system: ["CRM_Vuihoc", "DUO_Vuihoc", "VH_Tự học"] },
      }),
    });
    h.extractor.push(
      report(["Học sinh không làm bài được"], { values: { van_de: "không làm bài được" } }),
    );
    const r1 = await h.engine.step({
      chatId: CHAT,
      message: "Học sinh 0900000005 không làm bài được, em bên Vận hành",
    });
    expect(r1.outcome).toBe("asked");
    expect(r1.missingFields).toEqual(["system"]);
    expect(r1.messages[0].buttons?.flat().map((b) => b.callbackData)).toContain("CRM_Vuihoc");

    h.extractor.push({ userIntent: "provide_info", symptoms: [] });
    const r2 = await h.engine.step({ chatId: CHAT, message: "không rõ" });
    expect(r2.outcome).toBe("summary");
    expect(r2.messages[0].text).toContain("Chưa xác định");
  });

  test("chọn hệ thống qua nút thì điền đúng giá trị", async () => {
    // Mã sự cố gốc: legacy pipeline.flow.test.ts
    const h = makeHarness({
      catalog: createCatalog({
        fields: {
          nhanh: {
            tech: {
              ten: "Tech",
              truong_mo_dau: "van_de",
              recap: ["van_de", "system"],
              truong: {
                van_de: {
                  bat_buoc: true,
                  kieu: "text",
                  duoc_hoi: true,
                  nhan: "Vấn đề",
                  hoi: "Vấn đề gì?",
                },
                system: {
                  bat_buoc: false,
                  kieu: "enum:system",
                  duoc_hoi: true,
                  nhan: "Hệ thống",
                  hoi: "Hệ thống nào?",
                },
              },
            },
          },
        },
        enums: { system: ["CRM_Vuihoc", "DUO_Vuihoc", "VH_Tự học"] },
      }),
    });
    h.extractor.push(
      report(["Học sinh không làm bài được"], { values: { van_de: "không làm bài được" } }),
    );
    await h.engine.step({
      chatId: CHAT,
      message: "Học sinh 0900000005 không làm bài được, em bên Vận hành",
    });

    h.extractor.push(report([], { values: { system: "VH_Tự học" } }));
    const r = await h.engine.step({ chatId: CHAT, message: "VH_Tự học" });
    expect(r.outcome).toBe("summary");
    const draft = h.drafts.getLatestByChatId(CHAT);
    expect(draft?.record?.values.system).toBe("VH_Tự học");
  });
});
