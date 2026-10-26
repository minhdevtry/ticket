/**
 * Chuẩn hoá đầu vào — tiền xử lý tất định, KHÔNG LLM (RFC 0002 PR 4).
 *
 * Bốn phần: tin vô nghĩa (A11, TECH-1148), từ chối (A13), câu trả lời cho câu
 * hỏi dữ kiện luôn vào mô tả (appendRawText), và trần `rawText` theo legacy.
 */
import { describe, expect, test } from "bun:test";
import { MIN_CONFIRM_DELAY_MS } from "../confirm";
import type { TechReviewerPort } from "../ports";
import { CHAT, makeHarness, report } from "./engine-harness.fixture";
import { isDeclineAnswer, isMeaninglessInput } from "./normalize";
import { MAX_RAW_TEXT_CHARS, MAX_RAW_TEXT_TOTAL_CHARS } from "./engine";

describe("tin vô nghĩa (A11, TECH-1148)", () => {
  test("tin rỗng hoặc token nội bộ mà không kèm ảnh là vô nghĩa", () => {
    expect(isMeaninglessInput("", [])).toBe(true);
    expect(isMeaninglessInput("   ", [])).toBe(true);
    expect(isMeaninglessInput("noop", [])).toBe(true);
    expect(isMeaninglessInput("NOOP", [])).toBe(true);
  });

  test("có ảnh thì KHÔNG vô nghĩa (tin chỉ có ảnh vẫn phải được xử lý)", () => {
    expect(isMeaninglessInput("", ["/tmp/a.png"])).toBe(false);
    expect(isMeaninglessInput("noop", ["/tmp/a.png"])).toBe(false);
  });

  test("lời người báo thật thì không vô nghĩa", () => {
    expect(isMeaninglessInput("không vào được lớp", [])).toBe(false);
  });
});

describe("từ chối (A13)", () => {
  test("nhận ra câu trả lời từ chối", () => {
    expect(isDeclineAnswer("em không biết ạ")).toBe(true);
    expect(isDeclineAnswer("không biết")).toBe(true);
    expect(isDeclineAnswer("không có")).toBe(true);
    expect(isDeclineAnswer("chưa có")).toBe(true);
    expect(isDeclineAnswer("em không rõ ạ")).toBe(true);
  });

  test("không nhầm lời thật là từ chối", () => {
    expect(isDeclineAnswer("")).toBe(false);
    expect(isDeclineAnswer("không vào được lớp")).toBe(false);
    expect(isDeclineAnswer("app bị lỗi")).toBe(false);
    expect(isDeclineAnswer("x".repeat(50))).toBe(false);
  });
});

describe("chuẩn hoá trong engine", () => {
  test("câu trả lời cho câu hỏi dữ kiện luôn vào mô tả, kể cả khi chỉ là một mã", async () => {
    const reviewer: TechReviewerPort = {
      async review() {
        return { missing: ["order code"], question: "Cho em xin mã đơn ạ." };
      },
    };
    const h = makeHarness({ techReviewer: reviewer });
    h.extractor.push(report(["login broken"], { values: { van_de: "login broken" } }));
    const asked = await h.engine.step({ chatId: CHAT, message: "login broken" });
    expect(asked.outcome).toBe("asked");

    // Bộ trích xuất không ra triệu chứng nào — chỉ có mã đơn.
    h.extractor.push({ userIntent: "report_issue", symptoms: [] });
    await h.engine.step({ chatId: CHAT, message: "DH900002" });

    const draft = h.drafts.getLatestByChatId(CHAT)!;
    expect(draft.ticket.rawText).toContain("DH900002");
  });

  test("một tin dài bị cắt ở trần của một tin, cả cuộc cắt ở trần tổng", async () => {
    const h = makeHarness();
    const long = "z".repeat(10_000);
    h.extractor.push(report([long], { values: { van_de: long } }));
    await h.engine.step({ chatId: CHAT, message: long });

    let draft = h.drafts.getLatestByChatId(CHAT)!;
    expect(draft.ticket.rawText.length).toBe(MAX_RAW_TEXT_CHARS);

    h.extractor.push({ userIntent: "provide_info", symptoms: ["q".repeat(10_000)] });
    await h.engine.step({ chatId: CHAT, message: "q".repeat(10_000) });
    draft = h.drafts.getLatestByChatId(CHAT)!;
    // Cắt ở trần tổng rồi thêm dấu "…" báo đã cắt.
    expect(draft.ticket.rawText.length).toBeLessThanOrEqual(MAX_RAW_TEXT_TOTAL_CHARS + 1);
    expect(draft.ticket.rawText.length).toBeGreaterThan(MAX_RAW_TEXT_TOTAL_CHARS - 10);
  });

  test("tin vô nghĩa khi đang chờ xác nhận chỉ nhắc bấm nút, không đụng tờ khai", async () => {
    const h = makeHarness();
    h.extractor.push(report(["login broken"], { values: { van_de: "login broken" } }));
    await h.engine.step({ chatId: CHAT, message: "login broken" });

    const before = h.drafts.getLatestByChatId(CHAT)!;
    const out = await h.engine.step({ chatId: CHAT, message: "noop" });
    const after = h.drafts.getLatestByChatId(CHAT)!;

    expect(out.outcome).toBe("too_soon");
    expect(out.messages[0].buttons).toBeTruthy();
    expect(after.ticket.rawText).toBe(before.ticket.rawText);
    expect(after.status).toBe("ready_for_confirmation");
  });

  test("huỷ rõ ràng đóng tờ khai và trả lời người báo", async () => {
    const h = makeHarness();
    h.extractor.push(report(["login broken"], { values: { van_de: "login broken" } }));
    await h.engine.step({ chatId: CHAT, message: "login broken" });

    h.extractor.push({ userIntent: "cancel" });
    const out = await h.engine.step({ chatId: CHAT, message: "thôi huỷ đi em" });

    expect(out.outcome).toBe("canceled");
    expect(out.messages[0].text.length).toBeGreaterThan(0);
    expect(h.drafts.getLatestByChatId(CHAT)?.status).toBe("canceled");
  });

  test("sau khi huỷ, tin vô nghĩa trả lời theo trạng thái đã huỷ", async () => {
    const h = makeHarness();
    h.extractor.push(report(["login broken"], { values: { van_de: "login broken" } }));
    await h.engine.step({ chatId: CHAT, message: "login broken" });
    h.extractor.push({ userIntent: "cancel" });
    await h.engine.step({ chatId: CHAT, message: "thôi huỷ đi em" });

    const out = await h.engine.step({ chatId: CHAT, message: "noop" });
    expect(out.outcome).toBe("canceled");
  });
});
