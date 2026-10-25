import { describe, expect, it, afterEach, mock } from "bun:test";
import type { ItsaplanClient } from "@vuihoc/bot-core/itsaplan";
import type { MemgraphClient } from "../lib/kg/memgraph-client";
import type { TicketGraphNode } from "../lib/kg/types";
import {
  extractRootCauseAndResolutionFromText,
  parseIncidentMeta,
  synthesizeTicketKnowledge,
  syncDoneTicketToKnowledgeGraph,
  classifySymptomTaxon,
  UNKNOWN_ROOT_CAUSE,
  UNKNOWN_RESOLUTION,
  CAUSE_TAXONOMY,
  OTHER_NEW_PATTERN,
} from "./kg-sync";

describe("Ticket Knowledge Synthesizer — Edge cases đầy đủ", () => {
  it("TC1: comment có @tieulinh + dấu hai chấm đầy đủ", () => {
    const text =
      "Kỹ thuật kiểm tra thì nguyên nhân: driver micro của học sinh bị xung đột khiến track audio bị drop. Giải pháp: Hướng dẫn học sinh cấp lại quyền mic trong Cài đặt và khởi động lại app.";
    const r = extractRootCauseAndResolutionFromText(text);
    expect(r.rootCause).toContain("driver micro");
    expect(r.resolution).toContain("cấp lại quyền mic");
  });

  it("TC2: comment không có dấu hai chấm, chỉ có từ khoá", () => {
    const text =
      "@tieulinh Kỹ thuật kiểm tra: nguyên nhân phiên thi bị timeout. Giải pháp đã reset phiên.";
    const r = extractRootCauseAndResolutionFromText(text);
    expect(r.rootCause).toContain("phiên thi bị timeout");
    expect(r.resolution).toContain("reset phiên");
  });

  it("TC3: JSON thuần (LLM trả về JSON đúng schema)", () => {
    const text = `Phân tích: {"root_cause":"timeout mạng","resolution":"reset session"}`;
    const r = extractRootCauseAndResolutionFromText(text);
    expect(r.rootCause).toBe("timeout mạng");
    expect(r.resolution).toBe("reset session");
  });

  it("TC4: format 'do X ... đã Y' (câu không có key marker)", () => {
    const text =
      "Kỹ thuật kiểm tra thì do phiên làm bài bị timeout, đã reset phiên thi và học sinh đã nộp lại thành công.";
    const r = extractRootCauseAndResolutionFromText(text);
    expect(r.rootCause.length).toBeGreaterThan(5);
    expect(r.resolution.length).toBeGreaterThan(5);
  });

  it("TC5: comment hoàn toàn không có marker nào", () => {
    const text = "Đã reset server và restart container, hệ thống hoạt động bình thường trở lại.";
    const r = extractRootCauseAndResolutionFromText(text);
    // Fallback: resolution chứa toàn bộ text (vì không tách được rootCause)
    expect(r.resolution).toContain("reset server");
    expect(r.rootCause).toBe("Chưa ghi nhận rõ nguyên nhân");
  });

  it("TC6: comment rỗng / chỉ có chữ thừa", () => {
    const r1 = extractRootCauseAndResolutionFromText("");
    expect(r1.rootCause).toBe("Chưa ghi nhận rõ nguyên nhân");
    expect(r1.resolution).toBe("Đã xử lý và đóng ticket");

    const r2 = extractRootCauseAndResolutionFromText("   \n  \t  ");
    expect(r2.rootCause).toBe("Chưa ghi nhận rõ nguyên nhân");
  });

  it("TC7: PII bị redact (SĐT Việt Nam 10 số)", () => {
    const text =
      "Nguyên nhân: khách hàng 0900000005 báo lỗi thanh toán. Giải pháp: hoàn tiền cho khách.";
    const r = extractRootCauseAndResolutionFromText(text);
    expect(r.rootCause).not.toContain("0900000005");
    expect(r.rootCause).toContain("REDACTED_PHONE");
  });

  it("TC8: PII Telegram ID 10 số (không đầu 0)", () => {
    const text = "Nguyên nhân: 8000000006 báo lỗi. Giải pháp: xử lý.";
    const r = extractRootCauseAndResolutionFromText(text);
    expect(r.rootCause).not.toContain("8000000006");
  });

  it("TC9: Nhiều câu với nhiều marker — lấy câu đầu tiên match", () => {
    const text =
      "Hệ thống giám sát phát hiện. Nguyên nhân: database deadlock. Giải pháp: thêm index vào bảng. Đã triển khai và theo dõi.";
    const r = extractRootCauseAndResolutionFromText(text);
    expect(r.rootCause).toContain("database deadlock");
    expect(r.resolution).toContain("thêm index");
  });

  it("TC10: synthesizeTicketKnowledge không cần LLM vẫn hoạt động (fallback)", async () => {
    const r = await synthesizeTicketKnowledge(
      "Lỗi không nộp bài",
      "Học sinh làm đến câu 15 thì dừng",
      ["@tieulinh Kỹ thuật kiểm tra: nguyên nhân phiên thi bị timeout. Giải pháp: đã reset phiên."],
    );
    expect(r.rootCause).toContain("timeout");
    expect(r.resolution).toContain("reset");
  });

  it("TC11: synthesizeTicketKnowledge với LLM thật (model nội bộ)", async () => {
    const cfg = {
      baseUrl: process.env.OPENAI_BASE_URL || "http://localhost:20128/v1",
      apiKey: process.env.OPENAI_API_KEY || "",
      model: "mm3/MiniMax-M3",
    };
    // Gọi LLM thật: độ trễ M3 có lúc > 15s nên chỉ chạy khi bật rõ, để `bun test` tất định.
    if (!cfg.apiKey || process.env.RUN_LIVE_LLM !== "1") {
      console.log("[skip] Test LLM thật — đặt RUN_LIVE_LLM=1 (kèm OPENAI_API_KEY) để chạy");
      return;
    }
    try {
      const r = await synthesizeTicketKnowledge(
        "App Duo bị mất kết nối",
        "Học sinh không thể vào lớp học",
        ["Kỹ thuật kiểm tra nguyên nhân do network timeout, đã restart service."],
        cfg,
      );
      console.log("[LLM result]", JSON.stringify(r));
      // LLM có thể trả về format khác nhau, nhưng phải có giá trị
      expect(r.rootCause.length).toBeGreaterThan(0);
      expect(r.resolution.length).toBeGreaterThan(0);
    } catch (e) {
      console.log("[skip] LLM không khả dụng:", (e as Error).message);
    }
  }, 90000);

  it("TC12: Edge case — Comment có emoji và markdown", () => {
    const text = "🚨 **Nguyên nhân**: API rate limit exceeded. ✅ **Giải pháp**: đã tăng quota.";
    const r = extractRootCauseAndResolutionFromText(text);
    expect(r.rootCause.toLowerCase()).toContain("api rate limit");
    expect(r.resolution).toContain("tăng quota");
  });

  it("TC13: Edge case — Tên khóa bị viết HOA", () => {
    const text = "ROOT_CAUSE: timeout session. RESOLUTION: tăng thời gian.";
    const r = extractRootCauseAndResolutionFromText(text);
    expect(r.rootCause).toContain("timeout session");
    expect(r.resolution).toContain("tăng thời gian");
  });

  it("TC14: Edge case — Comment nhiều dấu chấm liên tiếp", () => {
    const text =
      "Kỹ thuật kiểm tra... nguyên nhân: server quá tải CPU 95%. Giải pháp: restart service và tăng timeout.";
    const r = extractRootCauseAndResolutionFromText(text);
    expect(r.rootCause).toContain("server quá tải CPU 95");
    expect(r.resolution).toContain("restart service");
  });
});

describe("synthesizeTicketKnowledge — KHÔNG được âm thầm rơi xuống regex khi đã cấu hình LLM", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const cfg = { baseUrl: "http://fake-llm.local/v1", apiKey: "fake-key", model: "mm3/MiniMax-M3" };

  it("LLM trả lỗi HTTP (vd hết token) => throw, KHÔNG fallback regex", async () => {
    globalThis.fetch = mock(async () => new Response("hết token", { status: 500 })) as any;

    await expect(
      synthesizeTicketKnowledge("Lỗi X", "Mô tả có nguyên nhân: do timeout mạng", [], cfg),
    ).rejects.toThrow();
  });

  it("LLM trả 200 nhưng content rỗng => throw, KHÔNG fallback regex", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }),
    ) as any;

    await expect(
      synthesizeTicketKnowledge("Lỗi X", "Mô tả có nguyên nhân: do timeout mạng", [], cfg),
    ).rejects.toThrow();
  });

  it("LLM trả JSON thiếu field (chỉ có root_cause, thiếu resolution) => throw", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: '{"root_cause":"timeout mạng"}' } }] }),
          { status: 200 },
        ),
    ) as any;

    await expect(synthesizeTicketKnowledge("Lỗi X", "Mô tả", [], cfg)).rejects.toThrow();
  });

  it("LLM trả đúng schema => dùng thẳng kết quả LLM, không đụng tới regex", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"root_cause":"do X","resolution":"đã fix Y"}' } }],
          }),
          { status: 200 },
        ),
    ) as any;

    const r = await synthesizeTicketKnowledge(
      "Lỗi X",
      "Mô tả không có marker regex nào cả",
      [],
      cfg,
    );
    expect(r.rootCause).toBe("do X");
    expect(r.resolution).toBe("đã fix Y");
  });

  it("Không truyền llmConfig (chế độ nhẹ có chủ đích) vẫn dùng regex bình thường", async () => {
    const r = await synthesizeTicketKnowledge("Lỗi X", "Học sinh làm đến câu 15 thì dừng", [
      "@tieulinh Kỹ thuật kiểm tra: nguyên nhân phiên thi bị timeout. Giải pháp: đã reset phiên.",
    ]);
    expect(r.rootCause).toContain("timeout");
  });
});

describe("synthesizeTicketKnowledge — phân loại cause_taxon theo cause-taxonomy.json", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  const cfg = { baseUrl: "http://fake-llm.local/v1", apiKey: "fake-key", model: "mm3/MiniMax-M3" };

  const mockLlmContent = (content: string) => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
    ) as any;
  };

  it("cause_taxon hợp lệ (khớp id trong taxonomy) được giữ nguyên", async () => {
    mockLlmContent(
      '{"root_cause":"trùng tài khoản","resolution":"gỡ liên kết","cause_taxon":"ACCOUNT_LINK_DUPLICATE"}',
    );
    const r = await synthesizeTicketKnowledge("Lỗi X", "Mô tả", [], cfg);
    expect(r.causeTaxon).toBe("ACCOUNT_LINK_DUPLICATE");
    expect(CAUSE_TAXONOMY.some((t) => t.id === r.causeTaxon)).toBe(true);
  });

  it("cause_taxon model bịa (không có trong danh sách) bị quy về OTHER_NEW_PATTERN, KHÔNG throw", async () => {
    mockLlmContent(
      '{"root_cause":"lỗi lạ","resolution":"đã fix","cause_taxon":"MOT_LOAI_LOI_BIA_RA"}',
    );
    const r = await synthesizeTicketKnowledge("Lỗi X", "Mô tả", [], cfg);
    expect(r.causeTaxon).toBe(OTHER_NEW_PATTERN);
  });

  it("model không trả cause_taxon (thiếu field) => quy về OTHER_NEW_PATTERN, vẫn giữ rootCause/resolution", async () => {
    mockLlmContent('{"root_cause":"lỗi lạ","resolution":"đã fix"}');
    const r = await synthesizeTicketKnowledge("Lỗi X", "Mô tả", [], cfg);
    expect(r.rootCause).toBe("lỗi lạ");
    expect(r.causeTaxon).toBe(OTHER_NEW_PATTERN);
  });

  it("Không truyền llmConfig thì không có causeTaxon (regex không đủ khả năng phân loại)", async () => {
    const r = await synthesizeTicketKnowledge("Lỗi X", "Mô tả có nguyên nhân: do timeout mạng", []);
    expect(r.causeTaxon).toBeUndefined();
  });
});

describe("classifySymptomTaxon — phân loại real-time cho ticket MỚI (best-effort, không chặn luồng)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  const cfg = { baseUrl: "http://fake-llm.local/v1", apiKey: "fake-key", model: "mm3/MiniMax-M3" };

  it("Không có llmConfig => trả undefined ngay, không gọi mạng", async () => {
    let called = false;
    globalThis.fetch = mock(async () => {
      called = true;
      return new Response("{}");
    }) as any;
    const r = await classifySymptomTaxon("Lỗi X", "Triệu chứng Y");
    expect(r).toBeUndefined();
    expect(called).toBe(false);
  });

  it("Text quá ngắn (title+symptoms < 5 ký tự) => trả undefined ngay, không gọi mạng", async () => {
    let called = false;
    globalThis.fetch = mock(async () => {
      called = true;
      return new Response("{}");
    }) as any;
    const r = await classifySymptomTaxon("", "", cfg);
    expect(r).toBeUndefined();
    expect(called).toBe(false);
  });

  it("LLM trả taxon hợp lệ => trả về đúng id", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"cause_taxon":"TIMEOUT_OVERLOAD_PERF"}' } }],
          }),
        ),
    ) as any;
    const r = await classifySymptomTaxon("CRM lỗi", "Trang bị treo, load rất lâu", cfg);
    expect(r).toBe("TIMEOUT_OVERLOAD_PERF");
  });

  it('LLM trả "OTHER_NEW_PATTERN" (nghĩa là không đoán được) => trả undefined, KHÔNG dùng làm điểm đối sánh', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"cause_taxon":"OTHER_NEW_PATTERN"}' } }],
          }),
        ),
    ) as any;
    const r = await classifySymptomTaxon("Lỗi lạ", "Không rõ triệu chứng gì", cfg);
    expect(r).toBeUndefined();
  });

  it('LLM trả "INSUFFICIENT_INFO" (trạng thái thiếu dữ kiện, không phải cơ chế lỗi) => trả undefined', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"cause_taxon":"INSUFFICIENT_INFO"}' } }],
          }),
        ),
    ) as any;
    const r = await classifySymptomTaxon("Lỗi gì đó", "Không có log", cfg);
    expect(r).toBeUndefined();
  });

  it("LLM trả id bịa (ngoài taxonomy) => trả undefined, không throw", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"cause_taxon":"KHONG_TON_TAI"}' } }],
          }),
        ),
    ) as any;
    const r = await classifySymptomTaxon("Lỗi X", "Triệu chứng Y", cfg);
    expect(r).toBeUndefined();
  });

  it("LLM lỗi HTTP => trả undefined, KHÔNG throw (không được chặn luồng intake)", async () => {
    globalThis.fetch = mock(async () => new Response("lỗi server", { status: 500 })) as any;
    const r = await classifySymptomTaxon("Lỗi X", "Triệu chứng Y", cfg);
    expect(r).toBeUndefined();
  });

  it("LLM chậm hơn timeout => trả undefined sau khoảng timeout, KHÔNG treo mãi", async () => {
    globalThis.fetch = mock(
      () => new Promise((resolve) => setTimeout(() => resolve(new Response("{}")), 500)),
    ) as any;
    const start = Date.now();
    const r = await classifySymptomTaxon("Lỗi X", "Triệu chứng Y", cfg, 50);
    expect(r).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(400);
  });
});

describe("parseIncidentMeta — bóc tách System/Product/Category từ description", () => {
  it("Ưu tiên khối JSON ẩn <!-- vuihoc-meta --> khi có", () => {
    const description = [
      "## Thông tin sự cố",
      "",
      "- Sản phẩm: Duo",
      "",
      '<!-- vuihoc-meta: {"product":"Tutor","system":"CRM_Vuihoc"} -->',
    ].join("\n");
    const meta = parseIncidentMeta(description);
    // JSON thắng Markdown khi cả hai đều có field product
    expect(meta.product).toBe("Tutor");
    expect(meta.system).toBe("CRM_Vuihoc");
  });

  it("Fallback sang Markdown khi không có <!-- vuihoc-meta --> (ticket thật điển hình)", () => {
    // Format thật lấy từ TECH-496 / TECH-619 — không có khối JSON ẩn
    const description = [
      "## Thông tin sự cố",
      "",
      "- Người báo: SA_HangNTB2 - 1000000009",
      "",
      "- Sản phẩm: Tutor",
      "",
      "- Hệ thống: CRM_Vuihoc",
      "",
      "- Bộ phận: Sale",
      "",
      "- Phân loại lỗi: Lỗi kỹ thuật",
      "",
      "",
      "### Mô tả",
      "",
      "> trên crm k hiên phần thanh toán thêm ạ",
    ].join("\n");
    const meta = parseIncidentMeta(description);
    expect(meta.product).toBe("Tutor");
    expect(meta.system).toBe("CRM_Vuihoc");
    expect(meta.reportingDept).toBe("Sale");
    expect(meta.category).toBe("Lỗi kỹ thuật");
  });

  it("Nhận cả 2 biến thể nhãn 'Tài khoản HS' và 'Tài khoản HS / SĐT'", () => {
    const withSlash = parseIncidentMeta("## Thông tin sự cố\n\n- Tài khoản HS / SĐT: 0900000020\n");
    expect(withSlash.studentAccount).toBe("0900000020");

    const withoutSlash = parseIncidentMeta("## Thông tin sự cố\n\n- Tài khoản HS: 0900000023\n");
    expect(withoutSlash.studentAccount).toBe("0900000023");
  });

  it("JSON thiếu field thì Markdown bù vào (merge, không ghi đè field JSON đã có)", () => {
    const description = [
      "## Thông tin sự cố",
      "",
      "- Sản phẩm: Duo",
      "- Hệ thống: Vuihoc (App/Web_Vuihoc + ERP_DUO)",
      "",
      '<!-- vuihoc-meta: {"product":"Duo"} -->',
    ].join("\n");
    const meta = parseIncidentMeta(description);
    expect(meta.product).toBe("Duo");
    expect(meta.system).toBe("Vuihoc (App/Web_Vuihoc + ERP_DUO)");
  });

  it("Không có khối '## Thông tin sự cố' thì trả về object rỗng, không throw", () => {
    expect(parseIncidentMeta("### Mô tả\n\n> lỗi gì đó")).toEqual({});
    expect(parseIncidentMeta("")).toEqual({});
  });
});

describe("syncDoneTicketToKnowledgeGraph — loại self-loop và fallback rỗng khỏi Graph", () => {
  const makeMockItsaplan = (issue: any, timeline: any[] = []): ItsaplanClient =>
    ({
      getIssue: async () => issue,
      getIssueTimeline: async () => timeline,
    }) as unknown as ItsaplanClient;

  it("Ticket tự trỏ vào chính nó trong Related Tickets thì bị loại (chặn self-loop)", async () => {
    let captured: TicketGraphNode | undefined;
    const mockMemgraph = {
      recomputeCauseClusters: async () => ({ tickets: 0, clusters: 0 }),
      upsertTicketNode: async (node: TicketGraphNode) => {
        captured = node;
      },
    } as unknown as MemgraphClient;

    const issue = {
      identifier: "TECH-999",
      title: "Lỗi tự tham chiếu",
      description: "## Thông tin sự cố\n\n- Sản phẩm: Tutor\n\n### Mô tả\n\n> lỗi gì đó",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      links: [{ issue: { identifier: "tech-999" } }, { issue: { identifier: "TECH-800" } }],
      fields: [],
    };

    const humanLinks = [
      {
        kind: "activity",
        action: "link_add",
        actorName: "TechLead_A",
        payload: { to: { value: "TECH-999" } },
      },
      {
        kind: "activity",
        action: "link_add",
        actorName: "TechLead_A",
        payload: { to: { value: "TECH-800" } },
      },
    ];
    const result = await syncDoneTicketToKnowledgeGraph(
      makeMockItsaplan(issue, humanLinks),
      mockMemgraph,
      1,
    );

    expect(result.success).toBe(true);
    expect(captured?.relatedTickets).toEqual(["TECH-800"]);
  });

  it("node.description/humanNotes: bỏ mục bot sinh, chỉ giữ comment người thật, ghim xếp trước", async () => {
    let captured: TicketGraphNode | undefined;
    const mockMemgraph = {
      recomputeCauseClusters: async () => ({ tickets: 0, clusters: 0 }),
      upsertTicketNode: async (node: TicketGraphNode) => {
        captured = node;
      },
    } as unknown as MemgraphClient;

    const issue = {
      identifier: "TECH-950",
      title: "Không tạo được đơn do trùng tài khoản",
      description:
        "## Thông tin sự cố\n\n- Sản phẩm: Duo\n\n### Mô tả\n\n> Không lên được đơn do trùng tài khoản.\n\n" +
        "### Chẩn đoán & Gợi ý\n\n- Tương đồng với TECH-1: đã bị trùng trước đó.\n\n---\n\n*Nguồn: ticket-intake*",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      links: [],
      fields: [],
    };
    const timeline = [
      {
        kind: "comment",
        actorName: "TechUser_B",
        body: "Đã kiểm tra CRM, đúng là trùng contact.",
        pinned: false,
      },
      { kind: "comment", actorName: "Tiểu Linh", body: "Đã ghi nhận.", pinned: false },
      {
        kind: "comment",
        actorName: "TechLead_A",
        body: "**Nguyên nhân:** Trùng tài khoản do cùng tên.",
        pinned: true,
      },
    ];

    const result = await syncDoneTicketToKnowledgeGraph(
      makeMockItsaplan(issue, timeline),
      mockMemgraph,
      1,
    );

    expect(result.success).toBe(true);
    expect(captured?.description).toContain("Không lên được đơn do trùng tài khoản");
    expect(captured?.description).not.toContain("Chẩn đoán");
    expect(captured?.description).not.toContain("Tương đồng với TECH-1");
    expect(captured?.humanNotes?.startsWith("**Nguyên nhân:** Trùng tài khoản do cùng tên.")).toBe(
      true,
    );
    expect(captured?.humanNotes).toContain("Đã kiểm tra CRM, đúng là trùng contact.");
    expect(captured?.humanNotes).not.toContain("Đã ghi nhận.");
  });

  it("comment bot ghi dưới actor không khớp isSystemActor (vd Iris + dấu <!-- intake-bot -->) KHÔNG đổi fingerprint", async () => {
    const issue = {
      identifier: "TECH-951",
      title: "Sự cố lặt vặt",
      description: "### Mô tả\n\n> sự cố abc",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      links: [],
      fields: [],
    };
    const timeline: any[] = [];
    const memgraph = {
      recomputeCauseClusters: async () => ({ tickets: 0, clusters: 0 }),
      upsertTicketNode: async () => {},
    } as unknown as MemgraphClient;
    const store = new Map<string, { fingerprint: string; syncedAt: number }>();
    const ledger = {
      get: (id: string) => store.get(id) ?? null,
      record: (id: string, fingerprint: string, syncedAt: number) =>
        void store.set(id, { fingerprint, syncedAt }),
    };
    const opts = { projectKey: "TECH", ledger, now: () => 1_000 };
    const client = makeMockItsaplan(issue, timeline);

    const first = await syncDoneTicketToKnowledgeGraph(client, memgraph, 1, undefined, opts);
    expect(first.skipped).toBeFalsy();

    timeline.push({ kind: "comment", actorName: "Iris", body: "Đã đóng <!-- intake-bot -->" });
    const second = await syncDoneTicketToKnowledgeGraph(client, memgraph, 1, undefined, opts);
    expect(second).toMatchObject({ success: true, skipped: true });
  });

  it("RootCause/Resolution fallback không được nạp vào Graph (giữ nguyên là undefined)", async () => {
    let captured: TicketGraphNode | undefined;
    const mockMemgraph = {
      recomputeCauseClusters: async () => ({ tickets: 0, clusters: 0 }),
      upsertTicketNode: async (node: TicketGraphNode) => {
        captured = node;
      },
    } as unknown as MemgraphClient;

    const issue = {
      identifier: "TECH-1000",
      title: "Ticket không có comment kỹ thuật",
      description: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      links: [],
      fields: [],
    };

    // Description + comment đều rỗng => synthesizeTicketKnowledge rơi vào fallback UNKNOWN_*
    const result = await syncDoneTicketToKnowledgeGraph(
      makeMockItsaplan(issue, []),
      mockMemgraph,
      1,
    );

    expect(result.success).toBe(true);
    expect(result.node?.rootCause).toBeUndefined();
    expect(result.node?.resolution).toBeUndefined();
    // Không có rootCause thật thì cũng không có gì để phân loại — causeTaxon
    // phải rỗng theo, không được đứng một mình trỏ vào RootCause không tồn tại.
    expect(result.node?.causeTaxon).toBeUndefined();
    expect(captured?.rootCause).toBeUndefined();
    expect(captured?.resolution).toBeUndefined();
  });
});

describe("syncDoneTicketToKnowledgeGraph — status thật lấy từ cột, không hardcode Done", () => {
  function setup(
    issue: any,
    timeline: any[] = [],
    columnState?: "open" | "resolved" | "done" | "canceled",
  ) {
    let captured: TicketGraphNode | undefined;
    const client = {
      getIssue: async () => issue,
      getIssueTimeline: async () => timeline,
    } as unknown as ItsaplanClient;
    const memgraph = {
      recomputeCauseClusters: async () => ({ tickets: 0, clusters: 0 }),
      upsertTicketNode: async (node: TicketGraphNode) => {
        captured = node;
      },
    } as unknown as MemgraphClient;
    // ProjectColumnStates giả: tra (dự án, columnId) → trạng thái theo nghĩa
    // CONTEXT.md. null = dự án không có cột đó (API không trả được).
    const columnStates = {
      stateOf: async (_pk: string, _col: number) =>
        columnState
          ? ({
              state: columnState,
              column: { id: _col, name: "x", stateType: "started", position: 1 },
            } as any)
          : null,
    };
    return { client, memgraph, columnStates, node: () => captured };
  }

  const base = {
    identifier: "TECH-700",
    title: "Ticket đổi trạng thái sau khi Done",
    description: "### Mô tả\n\nNguyên nhân: hàng đợi kẹt. Giải pháp: khởi động lại worker.",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
    columnId: 9,
    links: [],
    fields: [],
  };
  const opts = (t: ReturnType<typeof setup>) => ({
    projectKey: "TECH",
    columnStates: t.columnStates as any,
  });

  it("Ticket bị Canceled SAU khi từng Done thì KG ghi Canceled (không phải Done)", async () => {
    // Sync cũ ghi cứng status: "Done" nên ticket bị huỷ/archive sau đó vẫn
    // được gợi ý như tri thức sống — đúng loại nhiễu khiến tech lead phải gỡ.
    const t = setup({ ...base }, [], "canceled");
    await syncDoneTicketToKnowledgeGraph(t.client, t.memgraph, 1, undefined, opts(t));
    expect(t.node()?.status).toBe("Canceled");
  });

  it("Ticket còn ở Done thì ghi Done", async () => {
    const t = setup({ ...base }, [], "done");
    await syncDoneTicketToKnowledgeGraph(t.client, t.memgraph, 1, undefined, opts(t));
    expect(t.node()?.status).toBe("Done");
  });

  it("Không tra được trạng thái (API không trả cột) thì giữ Done — không phá dữ liệu đang có", async () => {
    const t = setup({ ...base });
    await syncDoneTicketToKnowledgeGraph(t.client, t.memgraph, 1, undefined, opts(t));
    expect(t.node()?.status).toBe("Done");
  });
});

describe("syncDoneTicketToKnowledgeGraph — khoá dự án & chống nạp lại", () => {
  function setup(identifier = "TECH-1") {
    const issue: any = {
      identifier,
      title: "Lỗi đồng bộ",
      description: "### Mô tả\n\nNguyên nhân: hàng đợi kẹt. Giải pháp: khởi động lại worker.",
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-02T00:00:00Z",
      links: [],
      fields: [],
    };
    const timeline: any[] = [];
    const client = {
      getIssue: async () => issue,
      getIssueTimeline: async () => timeline,
    } as unknown as ItsaplanClient;
    let upserts = 0;
    const memgraph = {
      recomputeCauseClusters: async () => ({ tickets: 0, clusters: 0 }),
      upsertTicketNode: async () => {
        upserts++;
      },
    } as unknown as MemgraphClient;
    const store = new Map<string, { fingerprint: string; syncedAt: number }>();
    const ledger = {
      get: (id: string) => store.get(id) ?? null,
      record: (id: string, fingerprint: string, syncedAt: number) =>
        void store.set(id, { fingerprint, syncedAt }),
    };
    return { issue, timeline, client, memgraph, ledger, upserts: () => upserts };
  }

  it("ticket không thuộc dự án worker thì bỏ qua, không nạp", async () => {
    const t = setup("PO-5");
    const result = await syncDoneTicketToKnowledgeGraph(t.client, t.memgraph, 5, undefined, {
      projectKey: "TECH",
    });
    expect(result).toMatchObject({ success: true, skipped: true });
    expect(t.upserts()).toBe(0);
  });

  it("nội dung không đổi thì lần 2 bỏ qua (không gọi LLM/Memgraph); đổi nội dung thì nạp lại", async () => {
    const t = setup();
    const opts = { projectKey: "TECH", ledger: t.ledger, now: () => 1_000 };

    const first = await syncDoneTicketToKnowledgeGraph(t.client, t.memgraph, 1, undefined, opts);
    const second = await syncDoneTicketToKnowledgeGraph(t.client, t.memgraph, 1, undefined, opts);
    expect(first.success && !first.skipped).toBe(true);
    expect(second).toMatchObject({ success: true, skipped: true });
    expect(t.upserts()).toBe(1);

    // Comment do bot ghi (có dấu intake-bot) không tính là nội dung mới.
    t.timeline.push({ kind: "comment", actorName: "Iris", body: "Đã đóng <!-- intake-bot -->" });
    await syncDoneTicketToKnowledgeGraph(t.client, t.memgraph, 1, undefined, opts);
    expect(t.upserts()).toBe(1);

    t.timeline.push({
      kind: "comment",
      actorName: "Kỹ thuật viên",
      body: "Bổ sung: đã tăng timeout.",
    });
    const third = await syncDoneTicketToKnowledgeGraph(t.client, t.memgraph, 1, undefined, opts);
    expect(third.skipped).toBeFalsy();
    expect(t.upserts()).toBe(2);
  });

  it("hết cửa sổ chống trùng thì nạp lại dù nội dung không đổi", async () => {
    const t = setup();
    let now = 0;
    const opts = { ledger: t.ledger, now: () => now, dedupeWindowMs: 1000 };
    await syncDoneTicketToKnowledgeGraph(t.client, t.memgraph, 1, undefined, opts);
    now = 5000;
    await syncDoneTicketToKnowledgeGraph(t.client, t.memgraph, 1, undefined, opts);
    expect(t.upserts()).toBe(2);
  });

  it("Memgraph lỗi thì không ghi sổ đã nạp (lần sau còn thử lại)", async () => {
    const t = setup();
    (t.memgraph as any).upsertTicketNode = async () => {
      throw new Error("bolt down");
    };
    const result = await syncDoneTicketToKnowledgeGraph(t.client, t.memgraph, 1, undefined, {
      ledger: t.ledger,
    });
    expect(result.success).toBe(false);
    expect(t.ledger.get("TECH-1")).toBeNull();
  });
});

describe("syncDoneTicketToKnowledgeGraph — resolvedAt không lấy từ updatedAt", () => {
  // Bài học 25/09 (tech lead gỡ 158 link bot gợi ý sai bên Itsaplan): mỗi
  // lần vé bị chỉnh sửa về sau, `updatedAt` bị đạp lại, nên time-decay
  // half-life 14 ngày coi vé cũ là vé mới. Đo trên 128 node live: 45% lệch
  // mốc Done thật ≥ 1 ngày, 11% lệch ≥ 7 ngày (đỉnh 27,6 ngày → thổi điểm
  // 3,9x). resolvedAt phải là mốc vào cột hoàn tất.
  const desc = "### Mô tả\n\nNguyên nhân: hàng đợi kẹt. Giải pháp: khởi động lại worker.";

  function makeIssue(extra: Record<string, any> = {}) {
    return {
      identifier: "TECH-1",
      title: "Lỗi đồng bộ",
      description: desc,
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-20T00:00:00Z",
      links: [],
      fields: [],
      ...extra,
    };
  }

  function setup(issue: any, timeline: any[] = []) {
    let captured: TicketGraphNode | undefined;
    const client = {
      getIssue: async () => issue,
      getIssueTimeline: async () => timeline,
    } as unknown as ItsaplanClient;
    const memgraph = {
      recomputeCauseClusters: async () => ({ tickets: 0, clusters: 0 }),
      upsertTicketNode: async (node: TicketGraphNode) => {
        captured = node;
      },
    } as unknown as MemgraphClient;
    return { client, memgraph, node: () => captured };
  }

  it("ưu tiên statusSince của Itsaplan (vé sửa sau khi Done vẫn giữ mốc Done)", async () => {
    const t = setup(makeIssue({ statusSince: "2026-09-02T00:00:00Z" }));
    const result = await syncDoneTicketToKnowledgeGraph(t.client, t.memgraph, 1);
    expect(result.success).toBe(true);
    expect(t.node()?.resolvedAt).toBe("2026-09-02T00:00:00Z");
  });

  it("thiếu statusSince thì lấy mốc sự kiện status cuối trong timeline", async () => {
    const t = setup(makeIssue(), [
      { kind: "activity", action: "status", createdAt: "2026-09-03T00:00:00Z" },
      { kind: "activity", action: "status", createdAt: "2026-09-04T00:00:00Z" },
      {
        kind: "comment",
        actorName: "Kỹ thuật viên",
        body: "đã sửa",
        createdAt: "2026-09-05T00:00:00Z",
      },
    ]);
    const result = await syncDoneTicketToKnowledgeGraph(t.client, t.memgraph, 1);
    expect(result.success).toBe(true);
    expect(t.node()?.resolvedAt).toBe("2026-09-04T00:00:00Z");
  });

  it("thiếu cả hai (dữ liệu cũ) thì vẫn rơi về updatedAt", async () => {
    const t = setup(makeIssue());
    const result = await syncDoneTicketToKnowledgeGraph(t.client, t.memgraph, 1);
    expect(result.success).toBe(true);
    expect(t.node()?.resolvedAt).toBe("2026-09-20T00:00:00Z");
  });

  // Bài học tech lead (audit 25/09 — 158/158 link_remove là người gỡ):
  // kg-sync phải trích xuất các link_remove do người thật thực hiện vào
  // negativeTickets để ghi nhận cạnh REJECTED_RELATION trong graph.
  it("link_remove do người thật thực hiện được trích xuất vào negativeTickets (âm mẫu)", async () => {
    const issue = makeIssue({
      identifier: "TECH-100",
      links: [{ issue: { identifier: "TECH-200" } }],
    });
    const timeline = [
      {
        action: "link_remove",
        actorName: "TechLead_A",
        payload: { subject: { value: "relates" }, to: { value: "TECH-300", id: 300 } },
      },
      {
        action: "link_remove",
        actorName: "Tiểu Linh",
        payload: { subject: { value: "relates" }, to: { value: "TECH-400", id: 400 } },
      },
    ];
    const t = setup(issue, timeline);
    await syncDoneTicketToKnowledgeGraph(t.client, t.memgraph, 1);
    // TECH-300 (do người gỡ) vào negativeTickets; TECH-400 (bot) bị loại
    expect(t.node()?.negativeTickets).toEqual(["TECH-300"]);
    // TECH-200 là link hiện có nhưng không rõ ai gắn → không phải tri thức (ADR-0007)
    expect(t.node()?.relatedTickets).toEqual([]);
  });
});

// ADR-0007 (26/09, TECH-920): ticket tương tự chỉ học từ tín hiệu người.
describe("syncDoneTicketToKnowledgeGraph — học từ comment ghim và tín hiệu người", () => {
  const PIN =
    "Anh @TechUser_B\n\n- **Nguyên nhân:** Bị gắn trùng tk học do cùng tên\n\n- **Cách khắc phục:** Gỡ tk học 1 con bị trùng & thêm chữ BỎ";
  const baseIssue = (over: any = {}) => ({
    id: 793,
    identifier: "TECH-920",
    title: "Trùng tài khoản con, sale không lên được đơn",
    description:
      "## Thông tin sự cố\n\n- Hệ thống: CRM_Vuihoc\n\n### Mô tả\n\n> bị trùng tài khoản con, sale không lên được đơn\n> callback_data: đúng rồi\n\n### Chẩn đoán & Gợi ý\n\n- Hướng xử lý: … (tham chiếu TECH-769)\n",
    createdAt: "2026-09-26T01:38:59Z",
    updatedAt: "2026-09-26T01:54:15Z",
    statusSince: "2026-09-26T05:00:00Z",
    links: [
      { issue: { identifier: "TECH-775" } },
      { issue: { identifier: "TECH-840" } },
      { issue: { identifier: "TECH-769" } },
    ],
    fields: [
      { fieldId: 3, name: "Related Tickets", value: "TECH-775, TECH-840, TEST-KG-TAXON-A-1" },
    ],
    ...over,
  });
  const timeline = [
    {
      kind: "activity",
      action: "field",
      actorName: "Tiểu Linh",
      createdAt: "2026-09-26T01:39:00Z",
      payload: {
        subject: { value: "Related Tickets", id: 3 },
        to: { value: "TECH-775, TECH-840, TEST-KG-TAXON-A-1" },
      },
    },
    {
      kind: "activity",
      action: "link_add",
      actorName: "Tiểu Linh",
      createdAt: "2026-09-26T01:39:01Z",
      payload: { to: { value: "TECH-775" } },
    },
    {
      kind: "activity",
      action: "link_add",
      actorName: "Tiểu Linh",
      createdAt: "2026-09-26T01:39:01Z",
      payload: { to: { value: "TECH-840" } },
    },
    {
      kind: "activity",
      action: "link_add",
      actorName: "TechLead_A",
      createdAt: "2026-09-26T01:50:00Z",
      payload: { to: { value: "TECH-769" } },
    },
    {
      kind: "activity",
      action: "link_remove",
      actorName: "TechLead_A",
      createdAt: "2026-09-26T02:02:00Z",
      payload: { to: { value: "TECH-840" } },
    },
    {
      kind: "comment",
      pinned: true,
      actorName: "TechLead_A",
      body: PIN,
      createdAt: "2026-09-26T01:54:10Z",
    },
    {
      kind: "comment",
      pinned: false,
      actorName: "admin",
      body: "🚨 **Người báo giục gấp.** Anh cần xử lý gấp",
      createdAt: "2026-09-26T01:55:00Z",
    },
  ];
  const setup = (issue: any, tl: any[] = timeline) => {
    let captured: TicketGraphNode | undefined;
    let clustersRecomputed = 0;
    const memgraph = {
      upsertTicketNode: async (node: TicketGraphNode) => {
        captured = node;
      },
      recomputeCauseClusters: async () => {
        clustersRecomputed++;
        return { tickets: 1, clusters: 1 };
      },
    } as unknown as MemgraphClient;
    const client = {
      getIssue: async () => issue,
      getIssueTimeline: async () => tl,
    } as unknown as ItsaplanClient;
    return { client, memgraph, node: () => captured, recomputed: () => clustersRecomputed };
  };

  it("nguyên nhân / cách khắc phục lấy nguyên văn comment ghim của người", async () => {
    const t = setup(baseIssue());
    const r = await syncDoneTicketToKnowledgeGraph(t.client, t.memgraph, 793, undefined, {
      projectKey: "TECH",
    });
    expect(r.success).toBe(true);
    expect(t.node()?.humanCause).toBe("Bị gắn trùng tk học do cùng tên");
    expect(t.node()?.humanFix).toBe("Gỡ tk học 1 con bị trùng & thêm chữ BỎ");
    expect(t.node()?.rootCause).toBe("Bị gắn trùng tk học do cùng tên");
    expect(t.node()?.resolution).toBe("Gỡ tk học 1 con bị trùng & thêm chữ BỎ");
  });

  it("chỉ link người gắn thành RELATES_TO; link/trường bot ghi và mã test bỏ qua; người gỡ thành âm", async () => {
    const t = setup(baseIssue());
    await syncDoneTicketToKnowledgeGraph(t.client, t.memgraph, 793, undefined, {
      projectKey: "TECH",
    });
    expect(t.node()?.relatedTickets).toEqual(["TECH-769"]);
    expect(t.node()?.negativeTickets).toEqual(["TECH-840"]);
  });

  it("kho tìm kiếm là lời người báo — không lẫn gợi ý bot ('Chẩn đoán & Gợi ý') hay callback", async () => {
    const t = setup(baseIssue());
    await syncDoneTicketToKnowledgeGraph(t.client, t.memgraph, 793, undefined, {
      projectKey: "TECH",
    });
    expect(t.node()?.symptomsText).toBe("bị trùng tài khoản con, sale không lên được đơn");
  });

  it("ticket nhãn IT Support được đánh dấu (kho gợi ý không nối chéo sang ticket kỹ thuật)", async () => {
    const t = setup(baseIssue({ labelIds: [9] }));
    (t.client as any).getProject = async () => ({
      labels: [
        { id: 8, name: "Hỗ trợ" },
        { id: 9, name: "IT Support" },
      ],
    });
    await syncDoneTicketToKnowledgeGraph(t.client, t.memgraph, 793, undefined, {
      projectKey: "TECH",
    });
    expect(t.node()?.itSupport).toBe(true);
  });

  it("nạp xong thì tính lại cụm nguyên nhân", async () => {
    const t = setup(baseIssue());
    await syncDoneTicketToKnowledgeGraph(t.client, t.memgraph, 793, undefined, {
      projectKey: "TECH",
    });
    expect(t.recomputed()).toBe(1);
  });

  it("có comment ghim mà LLM lỗi → vẫn nạp bằng chữ người viết (không chặn), chỉ thiếu nhóm nguyên nhân", async () => {
    const t = setup(baseIssue());
    const brokenLlm = { baseUrl: "http://127.0.0.1:1", apiKey: "x", model: "m" };
    const r = await syncDoneTicketToKnowledgeGraph(t.client, t.memgraph, 793, brokenLlm as any, {
      projectKey: "TECH",
    });
    expect(r.success).toBe(true);
    expect(t.node()?.rootCause).toBe("Bị gắn trùng tk học do cùng tên");
    expect(t.node()?.causeTaxon).toBeUndefined();
  });

  it("ghim thêm / đổi comment ghim là nội dung mới — không bị chặn bởi sổ chống nạp lại", async () => {
    const ledger = new Map<string, { fingerprint: string; syncedAt: number }>();
    const opts = {
      projectKey: "TECH",
      ledger: {
        get: (id: string) => ledger.get(id) ?? null,
        record: (id: string, fingerprint: string, syncedAt: number) =>
          void ledger.set(id, { fingerprint, syncedAt }),
      },
    };
    const noPin = timeline.filter((e) => e.kind !== "comment");
    const t1 = setup(
      baseIssue(),
      noPin.concat([
        {
          kind: "comment",
          pinned: false,
          actorName: "TechLead_A",
          body: PIN,
          createdAt: "2026-09-26T01:54:10Z",
        } as any,
      ]),
    );
    await syncDoneTicketToKnowledgeGraph(t1.client, t1.memgraph, 793, undefined, opts);
    const t2 = setup(baseIssue());
    const r = await syncDoneTicketToKnowledgeGraph(t2.client, t2.memgraph, 793, undefined, opts);
    expect(r.skipped).toBeFalsy();
    expect(t2.node()?.humanCause).toBe("Bị gắn trùng tk học do cùng tên");
  });
});
