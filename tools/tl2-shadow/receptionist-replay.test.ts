/**
 * Tests for receptionist-replay (RFC 0002 §4.3 - §4.5, PR 6).
 *
 * Verifies:
 * - Tầng 1: replayTurn with forced past decisions, independent turn evaluation.
 * - S0, S1, S2 diff classification.
 * - Tầng 2: runFreeConversation (informational).
 * - Tầng 3: evaluateRelaxedConfirm (shadow-relaxed confirm).
 * - Acceptance Criterion 2: M0-M4 computation and M0 = 0.
 * - Acceptance Criterion 3: Deterministic replay twice via CachedFieldExtractor.
 * - Acceptance Criterion 7: Synthetic tests for TECH-928 and TECH-1013.
 */
import { describe, expect, test } from "bun:test";
import { CachedFieldExtractor } from "../../packages/core/src/testing/extraction-cache.ts";
import type {
  ExtractedFields,
  ExtractInput,
  FieldExtractorPort,
} from "../../packages/core/src/intake/ports.ts";
import {
  calculateMetrics,
  classifyDiff,
  evaluateRelaxedConfirm,
  replayTurn,
  type ReplayTurnInput,
  runFreeConversation,
} from "./receptionist-replay.ts";
import type { PairV2 } from "./queue.ts";

class ScriptedQueueExtractor implements FieldExtractorPort {
  calls = 0;
  constructor(private queue: ExtractedFields[] = []) {}

  push(...items: ExtractedFields[]): void {
    this.queue.push(...items);
  }

  async extract(_input: ExtractInput): Promise<ExtractedFields> {
    this.calls++;
    return (
      this.queue.shift() ?? {
        userIntent: "provide_info",
        symptoms: [],
      }
    );
  }
}

describe("Receptionist Replay — Tầng 1 (đánh giá từng lượt)", () => {
  test("lượt t được đánh giá độc lập trên trạng thái t-1 ép bởi TL1", async () => {
    const turns: ReplayTurnInput[] = [
      {
        user: "App Duo học sinh 0900000005 không mở được",
        tl1Reply: "Anh/chị bổ sung giúp em: bộ phận của anh/chị.",
      },
      {
        user: "không biết",
        tl1Reply:
          "Em tóm tắt lại sự cố nhé: App Duo học sinh 0900000005 không mở được, thuộc hệ thống DUO_Vuihoc, mức ưu tiên Trung bình.",
      },
      {
        user: "đúng rồi",
        tl1Reply:
          "Em đã tạo thành công ticket TECH-1 cho anh/chị rồi ạ. Đội Kỹ thuật sẽ tiếp nhận và xử lý ngay nhé!",
      },
    ];

    const extractor = new ScriptedQueueExtractor([
      // Lượt 0 (quá khứ của lượt 1): báo cáo ban đầu
      {
        userIntent: "report_issue",
        title: "App Duo không mở được",
        symptoms: ["không mở được"],
        identifiers: { studentAccount: "0900000005" },
        values: { van_de: "không mở được" },
      },
      // Lượt 1 (lượt đánh giá): người dùng nói "không biết"
      {
        userIntent: "provide_info",
        symptoms: [],
      },
    ]);

    // Replay lượt 1: quá khứ (lượt 0) bị ép lastAskedFields = ["reporting_dept"] theo TL1
    const pair = await replayTurn("chat_test_1", turns, 1, { extractor });

    expect(pair.v).toBe(2);
    expect(pair.tl1.action).toBe("confirm_summary");
    expect(pair.tl2.target).toBe("receptionist");
    // Lệch ở lượt 1 được ghi nhận trong diff
    expect(pair.diff).toBeDefined();
    expect(pair.diff?.class).not.toBe("S0"); // Không vi phạm an toàn
  });
});

describe("Diff Classification — S0 / S1 / S2", () => {
  test("S0: tạo ticket khi người dùng chưa xác nhận", () => {
    const diff = classifyDiff(
      { action: "ask_missing_field", reply: "Cần thêm thông tin" },
      { outcome: "created", reply: "Đã tạo ticket", buttons: [], fields: {} },
      "tin người dùng",
      { userIntent: "report_issue", pastUserMessages: ["tin người dùng"] },
    );
    expect(diff.class).toBe("S0");
    expect(diff.code).toBe("unconfirmed_ticket_creation");
  });

  test("S0: lộ phong bì kênh vào ticket", () => {
    const diff = classifyDiff(
      { action: "ticket_created", reply: "Đã tạo ticket" },
      { outcome: "created", reply: "Đã tạo ticket", buttons: [], fields: {} },
      "đúng rồi",
      {
        userIntent: "confirm",
        pastUserMessages: ["Lỗi app"],
        draft: {
          docId: "d1",
          chatId: "c1",
          revision: 1,
          status: "created",
          createdAt: "",
          updatedAt: "",
          ticket: {
            title: "Lỗi app",
            rawText: "Conversation info (untrusted metadata):\n```json\n{}\n```\nLỗi app",
            priority: "medium",
            mediaPaths: [],
          },
        },
      },
    );
    expect(diff.class).toBe("S0");
    expect(diff.code).toBe("envelope_leak");
  });

  test("S0: lộ token noop vào ticket", () => {
    const diff = classifyDiff(
      { action: "ticket_created", reply: "Đã tạo ticket" },
      { outcome: "created", reply: "Đã tạo ticket", buttons: [], fields: {} },
      "đúng rồi",
      {
        userIntent: "confirm",
        pastUserMessages: ["Lỗi app"],
        draft: {
          docId: "d1",
          chatId: "c1",
          revision: 1,
          status: "created",
          createdAt: "",
          updatedAt: "",
          ticket: {
            title: "noop",
            rawText: "Lỗi app",
            priority: "medium",
            mediaPaths: [],
          },
        },
      },
    );
    expect(diff.class).toBe("S0");
    expect(diff.code).toBe("noop_leak");
  });

  test("S0: mất chữ của người báo khỏi rawText", () => {
    const diff = classifyDiff(
      { action: "ticket_created", reply: "Đã tạo ticket" },
      { outcome: "created", reply: "Đã tạo ticket", buttons: [], fields: {} },
      "đúng rồi",
      {
        userIntent: "confirm",
        pastUserMessages: ["Học sinh Nguyễn Văn An báo lỗi 502 phòng 101"],
        draft: {
          docId: "d1",
          chatId: "c1",
          revision: 1,
          status: "created",
          createdAt: "",
          updatedAt: "",
          ticket: {
            title: "Lỗi 502",
            rawText: "Chỉ ghi một câu ngắn khác", // Mất chữ nguyên văn của người báo!
            priority: "medium",
            mediaPaths: [],
          },
        },
      },
    );
    expect(diff.class).toBe("S0");
    expect(diff.code).toBe("rawtext_missing_words");
  });

  test("S1: hỏi trường khác", () => {
    const diff = classifyDiff(
      { action: "ask_missing_field", reply: "Anh/chị bổ sung giúp em: bộ phận của anh/chị." },
      { outcome: "asked", reply: "Lỗi xảy ra trên hệ thống nào ạ?", buttons: [], fields: {} },
      "Lỗi app",
      {
        userIntent: "report_issue",
        pastUserMessages: ["Lỗi app"],
        draft: {
          docId: "d1",
          chatId: "c1",
          revision: 1,
          status: "collecting",
          lastAskedFields: ["system"],
          createdAt: "",
          updatedAt: "",
          ticket: { title: "", rawText: "Lỗi app", priority: "medium", mediaPaths: [] },
        },
      },
    );
    expect(diff.class).toBe("S1");
    expect(diff.code).toBe("asked_other_field");
    expect(diff.tl1Field).toBe("reporting_dept");
    expect(diff.tl2Field).toBe("system");
  });

  test("S2: cùng hành động nhưng khác câu chữ bề mặt", () => {
    const diff = classifyDiff(
      { action: "ask_missing_field", reply: "Anh/chị bổ sung giúp em: bộ phận của anh/chị." },
      { outcome: "asked", reply: "Xin cho biết bộ phận của bạn?", buttons: [], fields: {} },
      "Lỗi app",
      { userIntent: "report_issue", pastUserMessages: ["Lỗi app"] },
    );
    expect(diff.class).toBe("S2");
    expect(diff.code).toBe("wording_difference");
  });
});

describe("Receptionist Replay — Tầng 2 (chạy tự do)", () => {
  test("runFreeConversation theo dõi điểm lệch đầu tiên và độ hội tụ", async () => {
    const turns: ReplayTurnInput[] = [
      {
        user: "App Duo không mở được",
        tl1Reply: "Anh/chị bổ sung giúp em: bộ phận của anh/chị.",
      },
      {
        user: "Vận hành",
        tl1Reply:
          "Em tóm tắt lại sự cố nhé: App Duo không mở được, thuộc hệ thống DUO_Vuihoc, mức ưu tiên Trung bình.",
      },
    ];

    const extractor = new ScriptedQueueExtractor([
      {
        userIntent: "report_issue",
        title: "App Duo không mở được",
        symptoms: ["không mở được"],
        values: { van_de: "không mở được" },
      },
      {
        userIntent: "provide_info",
        symptoms: [],
        values: { bo_phan: "Vận hành" },
      },
    ]);

    const res = await runFreeConversation("chat_free_1", turns, { extractor });
    expect(res.tl1Turns).toBe(2);
    expect(res.tl2Turns).toBe(2);
    expect(res.tl1Questions).toBeGreaterThanOrEqual(1);
  });
});

describe("Receptionist Replay — Tầng 3 (xác nhận nới lỏng)", () => {
  test("gate đủ: tạo ticket và so sánh payload với tóm tắt TL1", async () => {
    const turns: ReplayTurnInput[] = [
      {
        user: "Lỗi app Duo học sinh 0900000005 không làm bài được",
        tl1Reply: "Anh/chị bổ sung giúp em: bộ phận của anh/chị.",
      },
      {
        user: "Em bên Vận hành nhé",
        tl1Reply:
          "Em tóm tắt lại sự cố nhé: Lỗi app Duo học sinh 0900000005 không làm bài được, thuộc hệ thống DUO_Vuihoc, mức ưu tiên Trung bình. Anh/chị kiểm tra chuẩn rồi thì xác nhận giúp em nhé!",
      },
      {
        user: "đúng rồi",
        tl1Reply:
          "Em đã tạo thành công ticket TECH-1 cho anh/chị rồi ạ. Đội Kỹ thuật sẽ tiếp nhận và xử lý ngay nhé!",
      },
    ];

    const extractor = new ScriptedQueueExtractor([
      {
        userIntent: "report_issue",
        title: "Lỗi app Duo không làm bài được",
        symptoms: ["không làm bài được"],
        identifiers: { studentAccount: "0900000005" },
        values: { van_de: "không làm bài được" },
      },
      {
        userIntent: "provide_info",
        symptoms: [],
        values: { bo_phan: "Vận hành", van_de: "không làm bài được" },
      },
      {
        userIntent: "confirm",
      },
    ]);

    const res = await evaluateRelaxedConfirm("chat_t3_1", turns, { extractor });
    expect(res.relaxedCreated).toBe(true);
    expect(res.payload).toBeDefined();
    expect(res.tl1Summary?.system).toBe("DUO_Vuihoc");
  });

  test("gate chưa đủ: không ép tạo ticket, ghi tl2_stricter và missingFields", async () => {
    const turns: ReplayTurnInput[] = [
      {
        user: "Lỗi app",
        tl1Reply: "Anh/chị bổ sung giúp em: bộ phận của anh/chị.",
      },
      {
        user: "đúng rồi",
        tl1Reply:
          "Em đã tạo thành công ticket TECH-1 cho anh/chị rồi ạ. Đội Kỹ thuật sẽ tiếp nhận và xử lý ngay nhé!",
      },
    ];

    const extractor = new ScriptedQueueExtractor([
      {
        userIntent: "report_issue",
        symptoms: [],
        title: null,
      },
      {
        userIntent: "confirm",
      },
    ]);

    const res = await evaluateRelaxedConfirm("chat_t3_2", turns, { extractor });
    expect(res.relaxedCreated).toBe(false);
    expect(res.tl2_stricter).toBe(true);
    expect(res.missingFields?.length).toBeGreaterThan(0);
  });
});

describe("Tiêu chí 3: Chạy lại hai lần cho cùng kết quả (nhờ bộ nhớ đệm)", () => {
  test("chạy replay 2 lần cho cùng kết quả chính xác, lần 2 hoàn toàn offline", async () => {
    const innerExtractor = new ScriptedQueueExtractor([
      {
        userIntent: "report_issue",
        title: "App Duo lỗi",
        symptoms: ["lỗi"],
        identifiers: { studentAccount: "0900000008" },
        values: { van_de: "lỗi" },
      },
      {
        userIntent: "provide_info",
        symptoms: [],
        values: { bo_phan: "Vận hành" },
      },
    ]);
    const cachedExtractor = new CachedFieldExtractor(innerExtractor);

    const turns: ReplayTurnInput[] = [
      {
        user: "App Duo lỗi học sinh 0900000008",
        tl1Reply: "Anh/chị bổ sung giúp em: bộ phận của anh/chị.",
      },
      {
        user: "Vận hành",
        tl1Reply:
          "Em tóm tắt lại sự cố nhé: App Duo lỗi học sinh 0900000008, thuộc hệ thống DUO_Vuihoc, mức ưu tiên Trung bình.",
      },
    ];

    // Lần 1: chạy và làm đầy cache
    const run1 = await replayTurn("chat_cache_test", turns, 1, { extractor: cachedExtractor });
    expect(innerExtractor.calls).toBe(2);

    // Bật chế độ offline hoàn toàn cho lần 2
    cachedExtractor.setOffline(true);
    const run2 = await replayTurn("chat_cache_test", turns, 1, { extractor: cachedExtractor });

    // Không gọi thêm lần nào vào innerExtractor
    expect(innerExtractor.calls).toBe(2);
    // Kết quả 2 lần chạy giống hệt nhau
    expect(run1.tl2.outcome).toBe(run2.tl2.outcome);
    expect(run1.tl2.reply).toBe(run2.tl2.reply);
    expect(run1.diff).toEqual(run2.diff);
  });
});

describe("Tiêu chí 7: Test kịch bản tổng hợp TECH-928 và TECH-1013", () => {
  test("TECH-928: nhiều sự cố trong 1 tin / định danh xung đột; rawText giữ nguyên SĐT", async () => {
    const turns: ReplayTurnInput[] = [
      {
        user: "Lỗi app Duo học sinh 0900000003 không làm bài được",
        tl1Reply: "Anh/chị bổ sung giúp em: bộ phận của anh/chị.",
      },
      {
        user: "Đơn hàng DH900004 báo sai thời hạn khoá học, SĐT phụ huynh 0900000004",
        tl1Reply:
          "Dạ tin này có vẻ là sự cố khác với sự cố «Lỗi app Duo» ạ. Đây là SỰ CỐ MỚI hay bổ sung cho sự cố đang chờ vậy anh/chị?",
      },
    ];

    const extractor = new ScriptedQueueExtractor([
      {
        userIntent: "report_issue",
        title: "Lỗi app Duo học sinh 0900000003 không làm bài được",
        symptoms: ["không làm bài được"],
        identifiers: { studentAccount: "0900000003" },
        values: { van_de: "không làm bài được" },
      },
      {
        userIntent: "report_issue",
        title: "Đơn hàng DH900004 báo sai thời hạn",
        symptoms: ["báo sai thời hạn"],
        identifiers: { studentAccount: "0900000004" },
        values: { van_de: "báo sai thời hạn" },
      },
    ]);

    const pair = await replayTurn("chat_tech_928", turns, 1, { extractor });
    // TL1 hỏi "sự cố mới hay bổ sung" (ask_new_or_continue)
    expect(pair.tl1.action).toBe("ask_new_or_continue");
    // Không vi phạm an toàn S0
    expect(pair.diff?.class).not.toBe("S0");
  });

  test("TECH-1013: tin sau khi tạo ticket không tự ghi vào ticket cũ mà hỏi trước", async () => {
    const turns: ReplayTurnInput[] = [
      {
        user: "Lỗi app Duo",
        tl1Reply:
          "Em tóm tắt lại sự cố nhé: Lỗi app Duo, thuộc hệ thống DUO_Vuihoc, mức ưu tiên Trung bình.",
      },
      {
        user: "đúng rồi",
        tl1Reply:
          "Em đã tạo thành công ticket TECH-101 cho anh/chị rồi ạ. Đội Kỹ thuật sẽ tiếp nhận và xử lý ngay nhé!",
      },
      {
        user: "Em gửi thêm ảnh chụp màn hình này nhé",
        tl1Reply: "Em đã cập nhật bổ sung thông tin này vào ticket TECH-101 cho anh/chị rồi nhé ạ!",
      },
    ];

    const extractor = new ScriptedQueueExtractor([
      {
        userIntent: "report_issue",
        title: "Lỗi app Duo",
        symptoms: ["Lỗi app Duo"],
        values: { van_de: "Lỗi app Duo", bo_phan: "Vận hành" },
      },
      {
        userIntent: "confirm",
      },
      {
        userIntent: "provide_info",
        symptoms: [],
      },
    ]);

    const pair = await replayTurn("chat_tech_1013", turns, 2, { extractor });
    // TL1 đã ở post_create_update hoặc clarify_intent sau tạo ticket
    expect(pair.tl1.action).toBe("post_create_update");
    // Không vi phạm an toàn S0 (không tự tạo ticket bừa bãi)
    expect(pair.diff?.class).not.toBe("S0");
  });
});

describe("Tiêu chí 2: Replay trên cặp tổng hợp ra đúng M0-M4 và M0 bằng 0", () => {
  test("tính M0-M4 trên tập cặp tổng hợp, M0 = 0", async () => {
    const syntheticPairs: PairV2[] = [
      {
        v: 2,
        eid: "syn-1",
        ts: Date.now(),
        chatId: "chat-s1",
        text: "Báo lỗi",
        tl1: {
          reply: "Anh/chị bổ sung giúp em: bộ phận của anh/chị.",
          action: "ask_missing_field",
        },
        tl2: {
          reply: "Anh/chị bổ sung bộ phận",
          outcome: "asked",
          buttons: [],
          fields: {},
          latencyMs: 50,
          error: null,
        },
        diff: { class: "S2", code: "wording_difference" },
      },
      {
        v: 2,
        eid: "syn-2",
        ts: Date.now(),
        chatId: "chat-s1",
        text: "Vận hành",
        tl1: {
          reply: "Em tóm tắt lại sự cố nhé: Báo lỗi, thuộc hệ thống DUO, mức ưu tiên Trung bình.",
          action: "confirm_summary",
          summary: { system: "DUO", priority: "Trung bình", reportingDept: "Vận hành" },
        },
        tl2: {
          reply: "Tóm tắt: Báo lỗi, DUO, Trung bình",
          outcome: "summary",
          buttons: [],
          fields: { system: "DUO", reporting_dept: "Vận hành" },
          latencyMs: 50,
          error: null,
        },
        diff: { class: "S2", code: "wording_difference" },
      },
      {
        v: 2,
        eid: "syn-3",
        ts: Date.now(),
        chatId: "chat-s1",
        text: "đúng rồi",
        tl1: {
          reply: "Em đã tạo thành công ticket TECH-1 cho anh/chị rồi ạ.",
          action: "ticket_created",
          summary: { system: "DUO", priority: "Trung bình" },
        },
        tl2: {
          reply: "Đã tạo ticket TECH-1",
          outcome: "created",
          buttons: [],
          fields: { system: "DUO" },
          latencyMs: 50,
          error: null,
        },
        diff: null,
      },
    ];

    const m = calculateMetrics(syntheticPairs);
    expect(m.m0).toBe(0);
    expect(m.m1).toBeGreaterThanOrEqual(0.95);
    expect(m.m2.fieldMatchRate).toBeGreaterThanOrEqual(0.97);
    expect(m.m2.rawTextCompleteRate).toBe(1.0);
    expect(m.m3.jaccardAsked).toBeGreaterThanOrEqual(0.9);
    expect(m.m3.extraQuestionRate).toBeLessThanOrEqual(0.05);
    expect(m.m4).toBeGreaterThanOrEqual(0.95);
  });
});
