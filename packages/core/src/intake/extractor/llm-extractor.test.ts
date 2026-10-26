/**
 * FieldExtractor integration tests with FakeLlm (RFC 0002 PR 5 observable acceptance).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { FakeLlm } from "../../llm/fake-llm";
import { FieldExtractor } from "./llm-extractor";
import { VALID_ERROR_CATEGORIES, VALID_PRODUCTS, VALID_SYSTEMS } from "./taxonomy";

describe("FieldExtractor với FakeLlm", () => {
  let fake: FakeLlm;

  beforeEach(() => {
    fake = new FakeLlm();
    fake.start();
  });

  afterEach(() => {
    fake.stop();
  });

  const makeExtractor = (model = "test-model") =>
    new FieldExtractor({
      baseUrl: fake.baseUrl("openai-chat"),
      apiKey: "test-key",
      model,
    });

  it("lược đồ hợp lệ (FakeLlm): trích xuất các trường cấu trúc từ JSON trả về", async () => {
    fake.script({
      text: JSON.stringify({
        userIntent: "report_issue",
        title: "CRM bị lỗi 500 khi mở đơn",
        product: "Tutor",
        system: "CRM_Vuihoc",
        symptoms: ["Lỗi 500 khi mở đơn"],
        blocksPayment: true,
        scope: "single_user",
      }),
    });

    const ex = makeExtractor();
    const res = await ex.extract("CRM bị lỗi 500 khi mở đơn");

    expect(res.userIntent).toBe("report_issue");
    expect(res.title).toBe("CRM bị lỗi 500 khi mở đơn");
    expect(res.product).toBe("Tutor");
    expect(res.system).toBe("CRM_Vuihoc");
    expect(res.blocksPayment).toBe(true);
    expect(res.scope).toBe("single_user");
    expect(res.values?.product).toBe("Tutor");
    expect(res.values?.system).toBe("CRM_Vuihoc");
    expect(res.evidence?.blocksPayment).toBe(true);
  });

  it("từ đồng nghĩa (FakeLlm): chuẩn hóa hệ thống bên thứ 3 và từ viết tắt", async () => {
    fake.script({
      text: JSON.stringify({
        userIntent: "report_issue",
        system: "zalo pc",
        symptoms: ["Zalo không gửi được file"],
      }),
    });

    const ex = makeExtractor();
    const res = await ex.extract("Zalo PC bị đơ không gửi được file");
    expect(res.system).toBe("Khác_Hạ tầng_IT");
  });

  it("bộ phận chỉ khi nhắc: LLM đoán mò bị bỏ, chỉ nhận khi tin có nhắc", async () => {
    // LLM bịa "Vận hành" nhưng tin nhắn không nhắc gì tới bộ phận
    fake.script({
      text: JSON.stringify({
        userIntent: "report_issue",
        reportingDept: "Vận hành",
        symptoms: ["Lỗi nạp tiền"],
      }),
    });

    const ex = makeExtractor();
    const res1 = await ex.extract("Lỗi nạp tiền không vào ví");
    expect(res1.reportingDept).toBeUndefined();

    // Tin nhắn có nhắc "em bên VH"
    fake.script({
      text: JSON.stringify({
        userIntent: "report_issue",
        reportingDept: "Vận hành",
        symptoms: ["Lỗi nạp tiền"],
      }),
    });
    const res2 = await ex.extract("Em bên VH báo lỗi nạp tiền không vào ví");
    expect(res2.reportingDept).toBe("Vận hành");
  });

  it("luật SĐT: số điện thoại 10 số trong customerId tự động chuyển sang studentAccount", async () => {
    fake.script({
      text: JSON.stringify({
        userIntent: "report_issue",
        customerId: "0900000005",
        symptoms: ["không đăng nhập được"],
      }),
    });

    const ex = makeExtractor();
    const res = await ex.extract("Số 0900000005 không đăng nhập được");
    expect(res.customerId).toBeUndefined();
    expect(res.studentAccount).toBe("0900000005");
    expect(res.identifiers?.customerId).toBeUndefined();
    expect(res.identifiers?.studentAccount).toBe("0900000005");
  });

  it("'LLM chết' không ra tiêu đề: khi hết chuỗi model dự phòng, không bịa tiêu đề từ dòng đầu", async () => {
    // Mô phỏng 2 model trong chuỗi dự phòng đều chết (500)
    fake.script({ status: 500, text: "Internal Server Error" });
    fake.script({ status: 500, text: "Internal Server Error" });

    const ex = makeExtractor("primary-model,fallback-model");
    const res = await ex.extract("Trần Văn A\nCode: 9000001\nhọc sinh bị mất âm thanh");

    expect(res.title).toBeUndefined();
    expect(res.userIntent).toBe("report_issue");
    expect(res.symptoms).toEqual(["Trần Văn A\nCode: 9000001\nhọc sinh bị mất âm thanh"]);
  });

  it("heuristic không phụ thuộc LLM: hoạt động độc lập khi không có LLM", async () => {
    const ex = new FieldExtractor(); // Không cấu hình LLM

    const r1 = await ex.extract("ok em");
    expect(r1.userIntent).toBe("confirm");

    const r2 = await ex.extract("thôi hủy ticket giúp em");
    expect(r2.userIntent).toBe("cancel");

    const r3 = await ex.extract("cảm ơn bạn nhiều nhé");
    expect(r3.userIntent).toBe("chitchat");

    const r4 = await ex.extract("Lỗi app Duo không vào được phòng học");
    expect(r4.userIntent).toBe("report_issue");
    expect(r4.system).toBe("DUO_Vuihoc");
    expect(r4.blocksLearning).toBe(true);
  });

  it("chuỗi model dự phòng: lỗi 4xx client dừng ngay không thử model tiếp theo", async () => {
    fake.script({ status: 400, text: "Bad Request" });

    const ex = makeExtractor("bad-model,fallback-model");
    const res = await ex.extract("Lỗi không vào được phòng học");
    expect(res.userIntent).toBe("report_issue");
    expect(res.blocksLearning).toBe(true);
  });

  it("hỏi lại đúng một lần khi JSON đầu tiên không hợp lệ", async () => {
    fake.script({ text: "đây không phải json" });
    fake.script({
      text: JSON.stringify({
        userIntent: "report_issue",
        title: "Lỗi thanh toán",
        symptoms: ["Không thanh toán được"],
      }),
    });

    const ex = makeExtractor();
    const res = await ex.extract("Không thanh toán được");
    expect(res.userIntent).toBe("report_issue");
    expect(res.title).toBe("Lỗi thanh toán");
  });

  it("ngữ cảnh LLM: câu hỏi kỹ thuật vừa hỏi được đưa vào ngữ cảnh kèm câu báo provide_info", async () => {
    let capturedUserPrompt = "";
    const ex = new FieldExtractor(
      { baseUrl: fake.baseUrl("openai-chat"), apiKey: "key", model: "test" },
      async (_cfg, _sys, user) => {
        capturedUserPrompt = user;
        return JSON.stringify({ userIntent: "provide_info" });
      },
    );

    await ex.extract({
      text: "Học sinh dùng iPad",
      attachments: 0,
      draftTitle: "Lỗi không nghe thấy tiếng",
      context: {
        draftTitle: "Lỗi không nghe thấy tiếng",
        draftDescription: "Học sinh báo vào phòng không có âm thanh",
        techQuestion: "Học sinh đang dùng thiết bị gì vậy ạ?",
      },
    });

    expect(capturedUserPrompt).toContain("Lỗi không nghe thấy tiếng");
    expect(capturedUserPrompt).toContain("Học sinh báo vào phòng không có âm thanh");
    expect(capturedUserPrompt).toContain(
      '(Trợ lý vừa hỏi người báo: "Học sinh đang dùng thiết bị gì vậy ạ?" — tin mới là câu trả lời, tức "provide_info".)',
    );
  });

  it("danh mục mặc định khớp legacy", () => {
    expect(VALID_PRODUCTS).toContain("Tự học");
    expect(VALID_PRODUCTS).toContain("Duo");
    expect(VALID_SYSTEMS[0]).toBe("CRM_Vuihoc");
    expect(VALID_SYSTEMS[1]).toBe("DUO_Vuihoc");
    expect(VALID_SYSTEMS[2]).toBe("TUTOR_Vuihoc");
    expect(VALID_ERROR_CATEGORIES).toContain("Lỗi hệ thống");
    expect(VALID_ERROR_CATEGORIES).toContain("Lỗi kỹ thuật");
  });
});
