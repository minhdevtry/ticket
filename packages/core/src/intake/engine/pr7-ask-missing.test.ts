import { describe, expect, test } from "bun:test";
import { makeHarness, report, CHAT } from "./engine-harness.fixture";
import { createCatalog } from "../gate/catalog";
import { MIN_CONFIRM_DELAY_MS } from "../confirm";

describe("PR 7 — Hỏi bổ sung theo luật (RFC 0002 §1.5)", () => {
  test("variant là hàm suy ra: đổi nhánh động theo dữ liệu đầu vào", async () => {
    // A1: variant là hàm (IntakeEngineDeps.variant: (draft, record) => string)
    const catalog = createCatalog({
      fields: {
        nhanh: {
          productA: {
            ten: "Product A",
            truong_mo_dau: "fieldA",
            recap: ["fieldA"],
            truong: {
              fieldA: {
                bat_buoc: true,
                kieu: "text",
                duoc_hoi: true,
                nhan: "Field A",
                hoi: "Field A?",
              },
            },
          },
          productB: {
            ten: "Product B",
            truong_mo_dau: "fieldB",
            recap: ["fieldB"],
            truong: {
              fieldB: {
                bat_buoc: true,
                kieu: "text",
                duoc_hoi: true,
                nhan: "Field B",
                hoi: "Field B?",
              },
            },
          },
        },
      },
    });

    const h = makeHarness({
      catalog,
      variant: (_draft, record) => (record.values.product === "B" ? "productB" : "productA"),
    });

    // Lượt 1: chưa có product -> rơi vào productA, hỏi fieldA
    h.extractor.push({ userIntent: "report_issue", symptoms: ["lỗi"], title: "lỗi" });
    const r1 = await h.engine.step({ chatId: CHAT, message: "có lỗi" });
    expect(r1.outcome).toBe("asked");
    expect(r1.messages[0].text).toContain("Field A?");

    // Lượt 2: bổ sung product: "B" -> variant tự đổi sang productB, hỏi fieldB
    h.extractor.push({ userIntent: "provide_info", symptoms: [], values: { product: "B" } });
    const r2 = await h.engine.step({ chatId: CHAT, message: "sản phẩm B nhé" });
    expect(r2.outcome).toBe("asked");
    expect(r2.messages[0].text).toContain("Field B?");
  });

  test("ngân sách hỏi: trường hết ngân sách (askedCount >= budget) thì thôi hỏi", async () => {
    // A1: không hỏi lại trường đã quá số lần theo catalog
    const catalog = createCatalog({
      fields: {
        nhanh: {
          tech: {
            ten: "Tech",
            truong_mo_dau: "field_limited",
            recap: ["field_limited"],
            truong: {
              field_limited: {
                bat_buoc: true,
                kieu: "text",
                duoc_hoi: true,
                nhan: "Giới hạn",
                hoi: "Hỏi lần 1?",
                hoi_lai: ["Hỏi lần 2?"], // budget = 2
                het_luot: "Chưa xác định",
              },
            },
          },
        },
      },
    });

    const h = makeHarness({ catalog });

    // Lượt 1: hỏi lần 1 (questionCount = 1)
    h.extractor.push({ userIntent: "report_issue", symptoms: ["lỗi"], title: "lỗi" });
    const r1 = await h.engine.step({ chatId: CHAT, message: "lỗi rồi" });
    expect(r1.outcome).toBe("asked");
    expect(r1.messages[0].text).toContain("Hỏi lần 1?");

    // Lượt 2: không cung cấp giá trị hợp lệ -> hỏi lần 2 (questionCount = 2)
    h.extractor.push({ userIntent: "provide_info", symptoms: [] });
    const r2 = await h.engine.step({ chatId: CHAT, message: "vẫn lỗi" });
    expect(r2.outcome).toBe("asked");
    expect(r2.messages[0].text).toContain("Hỏi lần 2?");

    // Lượt 3: hết ngân sách (2 >= 2) -> rơi về het_luot, chuyển sang summary
    h.extractor.push({ userIntent: "provide_info", symptoms: [] });
    const r3 = await h.engine.step({ chatId: CHAT, message: "chịu rồi" });
    expect(r3.outcome).toBe("summary");
    expect(r3.messages[0].text).toContain("Chưa xác định");
  });

  test("A2: chỉ có ảnh (media) thì hỏi short_description", async () => {
    const h = makeHarness();
    h.extractor.push({ userIntent: "provide_info", symptoms: [] });
    const r = await h.engine.step({
      chatId: CHAT,
      message: "",
      mediaPaths: ["/tmp/photo.jpg"],
    });
    expect(r.outcome).toBe("asked");
    expect(r.missingFields).toEqual(["short_description"]);

    const draft = h.drafts.getLatestByChatId(CHAT);
    expect(draft?.lastAskedFields).toEqual(["short_description"]);
  });

  test("B4: tin xác nhận / huỷ chỉ gộp trường cấu trúc, triệu chứng không bị ghi đè", async () => {
    const h = makeHarness();
    h.extractor.push(report(["triệu chứng ban đầu"], { values: { van_de: "sự cố" } }));
    const r1 = await h.engine.step({ chatId: CHAT, message: "sự cố" });
    expect(r1.outcome).toBe("summary");

    // Tin xác nhận nhưng model trích xuất trả symptoms mới -> structuredOnly bỏ qua symptoms mới
    h.extractor.push({
      userIntent: "confirm",
      symptoms: ["triệu chứng rác không được gộp"],
      values: { note: "ghi chú cấu trúc" },
    });
    h.clock.advance(MIN_CONFIRM_DELAY_MS + 1);
    const r2 = await h.engine.step({ chatId: CHAT, message: "yes" });
    expect(r2.outcome).toBe("created");
    expect(h.tracker.created[0].description).not.toContain("triệu chứng rác không được gộp");
  });

  test("B4: removeSymptoms gỡ triệu chứng khỏi danh sách gộp", async () => {
    const h = makeHarness();
    h.extractor.push({
      userIntent: "report_issue",
      symptoms: ["lỗi màn hình trắng", "lỗi âm thanh rè"],
      title: "Lỗi thiết bị",
    });
    await h.engine.step({ chatId: CHAT, message: "máy bị lỗi" });

    // Lượt 2: người dùng bảo bỏ lỗi âm thanh
    h.extractor.push({
      userIntent: "report_issue",
      removeSymptoms: ["âm thanh rè"],
      values: { van_de: "màn hình trắng" },
    });
    await h.engine.step({ chatId: CHAT, message: "bỏ ý âm thanh nhé" });

    const draft = h.drafts.getLatestByChatId(CHAT);
    expect(draft?.symptoms).toContain("lỗi màn hình trắng");
    expect(draft?.symptoms?.some((s) => s.includes("âm thanh rè"))).toBe(false);
  });

  test("B4: bằng chứng ưu tiên chỉ nới (evidence đơn điệu tăng)", async () => {
    const h = makeHarness();
    h.extractor.push({
      userIntent: "report_issue",
      symptoms: ["chặn thanh toán"],
      blocksPayment: true,
      scope: "group",
    });
    await h.engine.step({ chatId: CHAT, message: "không thanh toán được" });

    let draft = h.drafts.getLatestByChatId(CHAT);
    expect(draft?.evidence?.blocksPayment).toBe(true);
    expect(draft?.evidence?.scope).toBe("group");

    // Lượt 2: LLM trả false hoặc scope thấp hơn -> không bị hạ
    h.extractor.push({
      userIntent: "report_issue",
      symptoms: ["chi tiết thêm"],
      blocksPayment: false,
      scope: "single_user",
      values: { van_de: "lỗi thanh toán" },
    });
    await h.engine.step({ chatId: CHAT, message: "chi tiết thêm" });

    draft = h.drafts.getLatestByChatId(CHAT);
    expect(draft?.evidence?.blocksPayment).toBe(true);
    expect(draft?.evidence?.scope).toBe("group");
  });
});
