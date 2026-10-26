/**
 * Ngữ cảnh cho bộ trích xuất (`ExtractInput.context`) và nút cho câu hỏi trong
 * `StepOutput` (RFC 0002 PR 4, mục 1.5 E6 và mục 2.1).
 */
import { describe, expect, test } from "bun:test";
import { MIN_CONFIRM_DELAY_MS } from "../confirm";
import type { TechReviewerPort } from "../ports";
import { CHAT, makeHarness, report } from "./engine-harness.fixture";
import { enumTestCatalog } from "./enum-catalog.fixture";

describe("ExtractInput.context — ngữ cảnh cho bộ trích xuất", () => {
  test("bộ trích xuất nhận tiêu đề và mô tả của tờ khai đang gom", async () => {
    const h = makeHarness();
    h.extractor.push(report(["login broken"], { values: { van_de: "login broken" } }));
    await h.engine.step({ chatId: CHAT, message: "login broken" });

    // Lượt sau: tờ khai đã có tiêu đề và mô tả → bộ trích xuất phải thấy.
    h.extractor.push({ userIntent: "provide_info", symptoms: [] });
    await h.engine.step({ chatId: CHAT, message: "vẫn lỗi" });

    const context = h.extractor.calls[1].context;
    expect(context?.draftTitle).toBe("login broken");
    expect(context?.draftDescription).toContain("login broken");
  });

  test("ngữ cảnh mang trường vừa hỏi (để biết tin này trả lời cho câu nào)", async () => {
    const h = makeHarness();
    // Lượt 1: còn thiếu `van_de` → engine hỏi.
    h.extractor.push({ userIntent: "report_issue", symptoms: [], title: null });
    await h.engine.step({ chatId: CHAT, message: "có lỗi" });

    h.extractor.push({ userIntent: "provide_info", symptoms: [] });
    await h.engine.step({ chatId: CHAT, message: "login broken" });

    expect(h.extractor.calls[1].context?.lastAskedFields).toContain("van_de");
  });

  test("ngữ cảnh mang câu hỏi kỹ thuật vừa hỏi và trường vừa hỏi", async () => {
    const reviewer: TechReviewerPort = {
      async review() {
        return { missing: ["order code"], question: "Cho em xin mã đơn ạ." };
      },
    };
    const h = makeHarness({ techReviewer: reviewer });
    h.extractor.push(report(["login broken"], { values: { van_de: "login broken" } }));
    await h.engine.step({ chatId: CHAT, message: "login broken" });

    h.extractor.push({ userIntent: "provide_info", symptoms: [] });
    await h.engine.step({ chatId: CHAT, message: "DH900002" });

    const context = h.extractor.calls[1].context;
    expect(context?.techQuestion).toBe("Cho em xin mã đơn ạ.");
    expect(context?.lastAskedFields).toContain("__tech");
  });

  test("ngữ cảnh mang ticket vừa tạo trong chat", async () => {
    const h = makeHarness();
    h.extractor.push(report(["login broken"], { values: { van_de: "login broken" } }));
    await h.engine.step({ chatId: CHAT, message: "login broken" });
    h.extractor.push({ userIntent: "confirm" });
    h.clock.advance(MIN_CONFIRM_DELAY_MS + 1);
    await h.engine.step({ chatId: CHAT, message: "đúng rồi" });

    h.extractor.push({ userIntent: "provide_info", symptoms: [] });
    await h.engine.step({ chatId: CHAT, message: "thêm một dòng nữa" });

    const context = h.extractor.calls[2].context;
    expect(context?.createdTicket?.identifier).toBe("TECH-1");
    expect(context?.createdTicket?.description).toContain("login broken");
  });

  test("mô tả trong ngữ cảnh bị cắt ở 1.500 ký tự", async () => {
    const h = makeHarness();
    const long = "y".repeat(4000);
    h.extractor.push(report([long], { values: { van_de: long } }));
    await h.engine.step({ chatId: CHAT, message: long });

    h.extractor.push({ userIntent: "provide_info", symptoms: [] });
    await h.engine.step({ chatId: CHAT, message: "thêm" });

    const context = h.extractor.calls[1].context;
    expect(context?.draftDescription?.length).toBe(1500);
  });
});

describe("StepOutput — câu hỏi có kèm nút", () => {
  test("câu hỏi cho trường enum đi kèm nút lựa chọn", async () => {
    const h = makeHarness({ catalog: enumTestCatalog });
    h.extractor.push({ userIntent: "report_issue", symptoms: [], title: null });
    const out = await h.engine.step({ chatId: CHAT, message: "có lỗi" });

    expect(out.outcome).toBe("asked");
    const buttons = out.messages[0].buttons;
    expect(buttons).toBeTruthy();
    const labels = (buttons ?? []).flat().map((b) => b.callbackData);
    expect(labels).toContain("CRM");
    expect(labels).toContain("Duo");
  });

  test("trường tự do thì câu hỏi không kèm nút", async () => {
    const h = makeHarness();
    h.extractor.push({ userIntent: "report_issue", symptoms: [], title: null });
    const out = await h.engine.step({ chatId: CHAT, message: "có lỗi" });

    expect(out.outcome).toBe("asked");
    expect(out.messages[0].buttons).toBeUndefined();
  });
});
