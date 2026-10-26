import { describe, expect, it } from "bun:test";
import { isDeclineAnswer, isExplicitCancel, isShortConfirmation } from "./heuristics";
import { FieldExtractor } from "./llm-extractor";
import { type LegacyDraftDocument, MAX_SYMPTOM_CHARS, mergeExtractedFields } from "./merger";
import { MAX_LLM_MESSAGE_CHARS } from "./taxonomy";

const fakeLlm = { baseUrl: "http://llm.fake", apiKey: "k", model: "m" };

function extractorReturning(json: Record<string, unknown>, seen?: { user?: string }) {
  return new FieldExtractor(fakeLlm, async (_cfg, _sys, user) => {
    if (seen) seen.user = user;
    return JSON.stringify(json);
  });
}

describe("Nhận diện xác nhận / huỷ (không LLM)", () => {
  it("chỉ coi là xác nhận khi CẢ tin nhắn là câu đồng ý ngắn", () => {
    for (const ok of [
      "ok",
      "OK em",
      "đúng rồi",
      "Chuẩn rồi em tạo đi",
      "Chuẩn rồi tạo giúp em",
      "xác nhận",
      "y",
      "Đồng ý nhé",
      "tạo đi",
    ]) {
      expect(isShortConfirmation(ok)).toBe(true);
    }
    for (const no of [
      "Yêu cầu hỗ trợ: app Duo lỗi đăng nhập",
      "ok app Duo lỗi không vào được",
      "Đúng là CRM bị lỗi 500 khi mở đơn",
      "yếu mạng quá",
      "dạ",
    ]) {
      expect(isShortConfirmation(no)).toBe(false);
    }
  });

  // TECH-1148: Cụm huỷ tường minh, "không vào được lớp" KHÔNG phải huỷ
  it("chỉ huỷ khi có cụm huỷ tường minh — 'không vào được lớp' KHÔNG phải huỷ", () => {
    for (const c of [
      "hủy",
      "huỷ đi em",
      "thôi hủy nhé",
      "cancel",
      "không cần tạo nữa",
      "thôi không cần đâu",
      "bỏ qua",
    ]) {
      expect(isExplicitCancel(c)).toBe(true);
    }
    for (const n of [
      "không vào được lớp học",
      "Hủy đơn hàng bị lỗi 500",
      "thôi rồi app lại sập",
      "không có âm thanh",
    ]) {
      expect(isExplicitCancel(n)).toBe(false);
    }
  });

  it("heuristic: tin nhắn báo lỗi bắt đầu bằng 'Yêu cầu' / 'không' vẫn là report_issue", async () => {
    const ex = new FieldExtractor();
    expect((await ex.extract("Yêu cầu hỗ trợ: học sinh không vào được lớp")).userIntent).toBe(
      "report_issue",
    );
    expect((await ex.extract("không vào được lớp trên app Duo")).userIntent).toBe("report_issue");
    expect((await ex.extract("Chuẩn rồi em tạo đi")).userIntent).toBe("confirm");
    expect((await ex.extract("hủy giúp em")).userIntent).toBe("cancel");
  });

  it("heuristic: lời cảm ơn là chitchat, không sinh triệu chứng", async () => {
    const res = await new FieldExtractor().extract("cảm ơn em nhé");
    expect(res.userIntent).toBe("chitchat");
    expect(res.symptoms).toEqual([]);
    expect(res.title).toBeUndefined();
  });

  it("heuristic: tin bổ sung ngắn kèm định danh là provide_info", async () => {
    const res = await new FieldExtractor().extract("bổ sung SĐT phụ huynh 0900000005");
    expect(res.userIntent).toBe("provide_info");
    expect(res.studentAccount).toBe("0900000005");
  });

  it("heuristic: nhận ra hệ thống từ từ khoá (app Duo → DUO_Vuihoc)", async () => {
    const res = await new FieldExtractor().extract("Lỗi app Duo không làm bài được");
    expect(res.system).toBe("DUO_Vuihoc");
  });

  it("nhận diện 'không biết' là câu từ chối trả lời, không nhầm với triệu chứng", () => {
    for (const d of ["không biết", "Em không rõ ạ", "ko biết", "chưa có ạ", "không có"]) {
      expect(isDeclineAnswer(d)).toBe(true);
    }
    for (const n of [
      "không vào được lớp",
      "không có âm thanh trong phòng học",
      "không biết sao app bị treo khi mở bài",
    ]) {
      expect(isDeclineAnswer(n)).toBe(false);
    }
  });
});

describe("FieldExtractor với LLM (giả lập)", () => {
  // TECH-1146: Số điện thoại nằm trong customerId phải chuyển sang studentAccount
  it("SĐT nằm trong customerId được chuyển sang studentAccount", async () => {
    const ex = extractorReturning({
      userIntent: "report_issue",
      customerId: "0900 000 005",
      symptoms: ["không đăng nhập được"],
    });
    const res = await ex.extract("KH 0900 000 005 không đăng nhập được");
    expect(res.customerId).toBeUndefined();
    expect(res.studentAccount).toBe("0900 000 005");
  });

  it("giá trị ngoài danh mục từ LLM bị bỏ, không làm sập extractor", async () => {
    const ex = extractorReturning({
      userIntent: "báo lỗi",
      product: "Duo app",
      errorCategory: "Lỗi lạ",
      deviceType: "Tủ lạnh",
      scope: "cả trường",
      customerId: 12345678,
      blocksLearning: "có",
      symptoms: ["a", 3, null],
    });
    const res = await ex.extract("app lỗi");
    expect(res.userIntent).toBe("report_issue");
    expect(res.product).toBeUndefined();
    expect(res.errorCategory).toBeUndefined();
    expect(res.deviceType).toBeUndefined();
    expect(res.scope).toBeUndefined();
    expect(res.customerId).toBe("12345678");
    expect(res.blocksLearning).toBeUndefined();
    expect(res.symptoms).toEqual(["a"]);
  });

  it("tin nhắn rất dài bị cắt trước khi gửi LLM", async () => {
    const seen: { user?: string } = {};
    const ex = extractorReturning({ userIntent: "report_issue", symptoms: [] }, seen);
    await ex.extract("x".repeat(MAX_LLM_MESSAGE_CHARS * 5));
    const userPromptLength = seen.user?.length ?? 0;
    expect(userPromptLength).toBeLessThan(MAX_LLM_MESSAGE_CHARS + 2000);
  });

  it("LLM lỗi thì rơi về heuristic", async () => {
    const ex = new FieldExtractor(fakeLlm, async () => {
      throw new Error("timeout");
    });
    const res = await ex.extract("không vào được lớp");
    expect(res.userIntent).toBe("report_issue");
  });

  // 07/10/2026: hết hạn mức 429 làm heuristic chép dòng đầu thành tiêu đề, ra
  // "Trần Thị B" (TECH-1146), "Mức Cấp thiết" (TECH-1152) — tên người chứ
  // không phải tóm tắt lỗi. LLM chết thì bỏ tiêu đề, giữ nguyên phần còn lại.
  it("hết cả chuỗi model thì KHÔNG bịa tiêu đề từ dòng đầi", async () => {
    const exhausted = new FieldExtractor(fakeLlm, async () => {
      throw new Error("429 The usage limit has been reached");
    });
    const res = await exhausted.extract("Trần Thị B\nCode: 90000004\nhọc sinh vào lớp bị báo lỗi");
    expect(res.title).toBeUndefined();
    expect(res.userIntent).toBe("report_issue");
    // Mô tả vẫn là lời nguyên văn nên không mất thông tin khi pipeline tạo ticket.
    expect(res.symptoms).toEqual(["Trần Thị B\nCode: 90000004\nhọc sinh vào lớp bị báo lỗi"]);
  });
});

describe("Sửa tiêu đề / bỏ triệu chứng", () => {
  const baseDoc = (): LegacyDraftDocument => ({
    docId: "d",
    chatId: "c",
    revision: 1,
    status: "collecting",
    currentTurn: 1,
    fields: {
      title: { value: "Lỗi app", source: "user_message", turn: 1, updatedAt: "" },
      symptoms: {
        value: ["Không vào được phòng", "Mất âm thanh"],
        source: "user_message",
        turn: 1,
        updatedAt: "",
      },
    },
    evidence: {},
    askedCount: {},
    similarTickets: [],
    createdAt: "",
    updatedAt: "",
  });

  // A14: "sửa tiêu đề thành …" đổi được tiêu đề đã có
  it("'sửa tiêu đề thành …' đổi được tiêu đề đã có", async () => {
    const ex = await new FieldExtractor().extract("sửa tiêu đề thành Lỗi đăng nhập CRM");
    expect(ex.titleExplicit).toBe(true);
    expect(ex.title).toBe("Lỗi đăng nhập CRM");
    expect(ex.symptoms).toEqual([]);
    const merged = mergeExtractedFields(baseDoc(), ex, 2, "sửa tiêu đề thành Lỗi đăng nhập CRM");
    expect(merged.fields.title?.value).toBe("Lỗi đăng nhập CRM");
    expect(merged.fields.symptoms?.value).toEqual(["Không vào được phòng", "Mất âm thanh"]);
  });

  // E4: Bằng chứng ưu tiên đã ghi nhận không bị false mặc định ở lượt sau hạ xuống
  it("bằng chứng ưu tiên đã ghi nhận không bị false mặc định ở lượt sau hạ xuống", () => {
    const doc = { ...baseDoc(), evidence: { scope: "group", blocksLearning: true } };
    const merged = mergeExtractedFields(
      doc,
      { userIntent: "provide_info", symptoms: [], blocksLearning: false, scope: "single_user" },
      2,
      "SĐT 0900000005",
    );
    expect(merged.evidence.blocksLearning).toBe(true);
    expect(merged.evidence.scope).toBe("group");
  });

  it("tiêu đề suy ra ở lượt sau KHÔNG đè tiêu đề cũ khi người dùng không yêu cầu", () => {
    const merged = mergeExtractedFields(
      baseDoc(),
      { userIntent: "provide_info", title: "Khác", symptoms: [] },
      2,
      "x",
    );
    expect(merged.fields.title?.value).toBe("Lỗi app");
  });

  // TECH-941, TECH-943: Lượt sau có mô tả mới thì tiêu đề được tóm tắt lại
  it("lượt sau có mô tả mới thì tiêu đề được tóm tắt lại (lời mở đầu không thành tiêu đề mãi)", () => {
    const doc: LegacyDraftDocument = {
      ...baseDoc(),
      fields: {
        ...baseDoc().fields,
        title: {
          value: "hỗ trợ em với ạ",
          source: "user_message",
          turn: 1,
          updatedAt: "",
        },
      },
    };
    const merged = mergeExtractedFields(
      doc,
      {
        userIntent: "provide_info",
        title: "Không lên được đơn cho SĐT 0900000007",
        symptoms: ["em không lên được đơn"],
      },
      2,
      "x",
    );
    expect(merged.fields.title?.value).toBe("Không lên được đơn cho SĐT 0900000007");
  });

  // A14: Tiêu đề do người đặt bị khoá, LLM không đè được
  it("tiêu đề người dùng tự đặt thì LLM tóm tắt lại không đè được", async () => {
    const ex = await new FieldExtractor().extract("sửa tiêu đề thành Lỗi đăng nhập CRM");
    const locked = mergeExtractedFields(baseDoc(), ex, 2, "sửa tiêu đề thành Lỗi đăng nhập CRM");
    const next = mergeExtractedFields(
      locked,
      { userIntent: "provide_info", title: "Tiêu đề LLM", symptoms: ["mất âm thanh"] },
      3,
      "x",
    );
    expect(next.fields.title?.value).toBe("Lỗi đăng nhập CRM");
  });

  // TECH-1146, TECH-941, TECH-952: Tiêu đề lấy dòng tả lỗi, không lấy dòng tên học sinh
  it("không có LLM: tiêu đề lấy dòng tả lỗi, không lấy dòng tên học sinh", async () => {
    const ex = await new FieldExtractor().extract(
      "**Vũ Thị Bảo G**\nCode: 90000004\nHs chuyển phí sang Toán nhưng môn Hóa không cho chuyển",
    );
    expect(ex.title).toBe("Hs chuyển phí sang Toán nhưng môn Hóa không cho chuyển");
  });

  // A14: "bỏ ý …" gỡ triệu chứng khỏi danh sách
  it("'bỏ ý …' gỡ triệu chứng khỏi danh sách", async () => {
    const ex = await new FieldExtractor().extract("bỏ ý mất âm thanh");
    expect(ex.removeSymptoms).toEqual(["mất âm thanh"]);
    const merged = mergeExtractedFields(baseDoc(), ex, 2, "bỏ ý mất âm thanh");
    expect(merged.fields.symptoms?.value).toEqual(["Không vào được phòng"]);
  });

  it("structuredOnly: tin xác nhận không bị ghi thành triệu chứng", () => {
    const merged = mergeExtractedFields(
      baseDoc(),
      { userIntent: "confirm", title: "ok", symptoms: ["ok"], reportingDept: "Sale" },
      2,
      "ok",
      { structuredOnly: true },
    );
    expect(merged.fields.symptoms?.value).toEqual(["Không vào được phòng", "Mất âm thanh"]);
    expect(merged.fields.reportingDept?.value).toBe("Sale");
  });

  it("triệu chứng quá dài bị cắt", () => {
    const merged = mergeExtractedFields(
      baseDoc(),
      { userIntent: "provide_info", symptoms: ["y".repeat(MAX_SYMPTOM_CHARS * 3)] },
      2,
      "y",
    );
    const symptoms = Array.isArray(merged.fields.symptoms?.value)
      ? (merged.fields.symptoms?.value as string[])
      : [];
    const last = symptoms.at(-1) ?? "";
    expect(last.length).toBeLessThanOrEqual(MAX_SYMPTOM_CHARS + 3);
  });
});
