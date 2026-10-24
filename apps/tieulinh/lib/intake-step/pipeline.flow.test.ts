import { ChecklistTechReviewer } from "./checklist-review";
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { applySchema } from "../storage/schema";
import { IntakeDocumentRepository } from "../intake-document/repository";
import { TicketBindingRepository } from "../storage/binding-repository";
import { DraftSessionRepository } from "../storage/session-repository";
import { FieldExtractor } from "./extractor";
import {
  IntakeStepPipeline,
  type IntakePipelineOptions,
  type PendingButtonsSink,
} from "./pipeline";
import type { ItsaplanClient, ItsaplanIssue } from "../itsaplan/client";
import type { InlineButton } from "../gate/types";
import type { IntakeDocument } from "../intake-document/types";
import type { UrgencyRules } from "../../mcp/shared/index";
import validationRules from "../../mcp/tieulinh/domain/validation-rules.json";
import fieldRequirements from "../../mcp/tieulinh/domain/required_fields.json";
import productMapping from "../../mcp/tieulinh/domain/product_mapping.json";
import urgencyRules from "../../mcp/tieulinh/domain/urgency-rules.json";

/** Itsaplan giả: ghi lại mọi cú gọi, có thể cho createIssue hỏng. */
function fakeItsaplan() {
  const calls = {
    createIssue: [] as any[],
    updateIssue: [] as any[],
    addComment: [] as any[],
    uploadAttachment: [] as string[],
    getIssue: [] as number[],
    linkIssues: [] as any[],
  };
  let failNext = 0;
  let seq = 100;
  const client: Partial<ItsaplanClient> = {
    listProjectColumns: async () =>
      [
        { id: 1, name: "Todo", stateType: "unstarted", position: 1 },
        { id: 9, name: "Canceled", stateType: "canceled", position: 9 },
      ] as any,
    listCustomFields: async () => [] as any,
    createIssue: async (_projectKey: string, payload: any) => {
      calls.createIssue.push(payload);
      // Nhường event loop để mô phỏng HTTP — lộ ra race khi hai cú xác nhận cùng lúc
      await new Promise((r) => setTimeout(r, 5));
      if (failNext > 0) {
        failNext--;
        throw new Error("Itsaplan API error: 502 upstream timeout (secret-internal-host:8080)");
      }
      seq++;
      return {
        id: seq,
        identifier: `TECHTEST-${seq}`,
        title: payload.title,
        sequenceNumber: seq,
      } as ItsaplanIssue;
    },
    updateIssue: async (issueId: number, patch: any) => {
      calls.updateIssue.push({ issueId, patch });
      return {} as any;
    },
    addComment: async (issueId: number, content: string) => {
      calls.addComment.push({ issueId, content });
      return { id: 1, body: content };
    },
    getIssueByNumber: async (_projectKey: string, n: number) =>
      ({
        id: 5000 + n,
        identifier: `TECHTEST-${n}`,
        title: `Ticket ${n}`,
        description: n === 888 ? "Người báo: X - telegram:99999" : "",
      }) as any,
    getIssue: async (id: number) => {
      calls.getIssue.push(id);
      return {
        id,
        identifier: `TECHTEST-${id - 5000}`,
        title: `Ticket ${id - 5000}`,
        columnId: id === 5796 ? 9 : 1,
        description:
          "## Thông tin sự cố\n\n- Tài khoản HS / SĐT: 0900000006\n- Bộ phận: CSKH\n\n### Mô tả\n\n> Nội dung ticket vừa tạo nhầm\n\n---\n",
      } as any;
    },
    linkIssues: async (a: number, b: number, kind?: string) => {
      calls.linkIssues.push({ a, b, kind });
      return { id: 1, kind } as any;
    },
    getIssueTimeline: async () => [
      {
        kind: "comment",
        actorName: "TechUser_B",
        body: "không có thông tin cụ thể là do đơn hàng nào sai à?",
      },
      { kind: "comment", actorName: "Tiểu Linh", body: "bot" },
    ],
    uploadAttachment: async (_issueId: number, filename: string) => {
      calls.uploadAttachment.push(filename);
      return { id: "att1", url: "/attachments/att1/raw", filename };
    },
  };
  return {
    client: client as ItsaplanClient,
    calls,
    failNextCreate: (n = 1) => {
      failNext = n;
    },
  };
}

function fakeButtons() {
  const saved = new Map<string, InlineButton[][]>();
  const sink: PendingButtonsSink = {
    save: (chatId, rows) => saved.set(chatId, rows),
    clear: (chatId) => saved.delete(chatId),
  };
  return { sink, saved };
}

describe("IntakeStepPipeline — vòng đời tài liệu", () => {
  let db: Database;
  let repo: IntakeDocumentRepository;
  let bindingRepo: TicketBindingRepository;
  let draftRepo: DraftSessionRepository;
  let it$: ReturnType<typeof fakeItsaplan>;
  let btn: ReturnType<typeof fakeButtons>;
  let pipeline: IntakeStepPipeline;
  const tmpFiles: string[] = [];

  const build = (over: Partial<IntakePipelineOptions> = {}) =>
    new IntakeStepPipeline({
      repo,
      extractor: new FieldExtractor(),
      itsaplan: it$.client,
      itsaplanBaseUrl: "https://mock.itsaplan.test",
      projectKey: "TECHTEST",
      validationRules: validationRules as any,
      fieldRequirements: fieldRequirements as any,
      productMapping: productMapping as any,
      urgencyRules: urgencyRules as UrgencyRules,
      bindingRepo,
      draftRepo,
      buttons: btn.sink,
      // Test gọi liền mạch không có độ trễ người thật; ca chặn tự-xác-nhận có test riêng
      minConfirmDelayMs: 0,
      ...over,
    });

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    repo = new IntakeDocumentRepository(db);
    bindingRepo = new TicketBindingRepository(db);
    draftRepo = new DraftSessionRepository(db);
    it$ = fakeItsaplan();
    btn = fakeButtons();
    pipeline = build();
  });

  afterEach(() => {
    for (const f of tmpFiles.splice(0)) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  });

  const CHAT = "7001";
  const REPORT = "Lỗi app Duo học sinh 0900000005 không làm bài được";

  /** Đưa tài liệu tới bước tóm tắt chờ xác nhận. */
  async function toSummary(chatId = CHAT, first = REPORT) {
    const r1 = await pipeline.run({ chatId, message: first });
    expect(r1.action).toBe("ask_missing_field");
    const r2 = await pipeline.run({ chatId, message: "Em bên Vận hành nhé" });
    expect(r2.action).toBe("confirm_summary");
    return r2;
  }

  async function toCreated(chatId = CHAT) {
    await toSummary(chatId);
    const r = await pipeline.run({ chatId, message: "đúng rồi" });
    expect(r.action).toBe("ticket_created");
    return r;
  }

  // ── Model tự "bấm nút" xác nhận thay người dùng ─────────────────────
  it("xác nhận tới ngay sau tóm tắt (model tự gọi) KHÔNG tạo ticket; người thật xác nhận sau đó thì tạo", async () => {
    // Bug thật 24/09: gemini-flash-lite đọc callbackData "đúng rồi" trong tool result
    // rồi tự gọi intake_step 1,1s sau khi nhận tóm tắt → TECHTEST-96 tạo khi người dùng chưa bấm.
    let clock = 1_000_000;
    pipeline = build({ minConfirmDelayMs: 5000, now: () => clock });
    await toSummary();
    clock += 1100;
    const self = await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
    expect(self.action).toBe("awaiting_user_confirmation");
    expect(self.status).toBe("ready_for_confirmation");
    expect(it$.calls.createIssue).toHaveLength(0);

    clock += 8000;
    const human = await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
    expect(human.action).toBe("ticket_created");
    expect(it$.calls.createIssue).toHaveLength(1);
  });

  it("tóm tắt hiện mức ưu tiên bằng tiếng Việt, không in 'MEDIUM'", async () => {
    const r = await toSummary();
    expect(r.voiceText).not.toContain("MEDIUM");
    expect(r.displayMarkdown).toContain("Trung bình");
  });

  // ── Bug 3: xác nhận nhầm ──────────────────────────────────────────────
  it("tin đầu 'Yêu cầu hỗ trợ: …' / 'ok app Duo lỗi…' không bao giờ tạo ticket", async () => {
    const a = await pipeline.run({
      chatId: "7101",
      message: "Yêu cầu hỗ trợ: app Duo lỗi không vào được lớp, em bên Sale",
    });
    expect(a.action).not.toBe("ticket_created");
    const b = await pipeline.run({
      chatId: "7102",
      message: "ok app Duo lỗi đăng nhập, em bên Sale",
    });
    expect(b.action).not.toBe("ticket_created");
    expect(it$.calls.createIssue.length).toBe(0);
  });

  it("'ok' khi tài liệu chưa từng được tóm tắt không tạo ticket", async () => {
    await pipeline.run({ chatId: CHAT, message: REPORT });
    const r = await pipeline.run({ chatId: CHAT, message: "ok" });
    expect(r.action).not.toBe("ticket_created");
    expect(it$.calls.createIssue.length).toBe(0);
  });

  it("'không vào được lớp' không huỷ tài liệu (không LLM)", async () => {
    const r = await pipeline.run({ chatId: CHAT, message: "không vào được lớp trên app Duo" });
    expect(r.status).not.toBe("canceled");
    expect(r.action).toBe("ask_missing_field");
  });

  // ── Bug 7: câu hỏi gộp, nút bấm, explicitlyMissing ────────────────────
  it("câu hỏi dùng nhãn tiếng Việt, không lộ tên trường nội bộ, và nút được đẩy ra Telegram", async () => {
    const r = await pipeline.run({ chatId: CHAT, message: REPORT });
    expect(r.voiceText).toContain("bộ phận");
    expect(r.voiceText).not.toContain("reporting_dept");
    expect(r.buttons?.length).toBeGreaterThan(0);
    // Hình dạng nút thống nhất: callbackData
    expect(r.buttons![0][0].callbackData).toBeTruthy();
    expect(btn.saved.get(CHAT)).toEqual(r.buttons!);
  });

  it("'không biết' được ghi vào explicitlyMissing và bot thôi hỏi trường đó", async () => {
    await pipeline.run({ chatId: CHAT, message: REPORT });
    const r = await pipeline.run({ chatId: CHAT, message: "em không biết ạ" });
    expect(r.document.explicitlyMissing).toContain("reporting_dept");
    expect(r.missingFields).not.toContain("reporting_dept");
    expect(r.action).toBe("confirm_summary");
    expect(r.displayMarkdown).toContain("Chưa xác định phòng ban");
    // Câu "không biết" không bị ghi thành triệu chứng
    expect(r.document.fields.symptoms?.value.join(" ")).not.toContain("không biết");
  });

  // ── Bug 4: mức ưu tiên ────────────────────────────────────────────────
  it("mặc định Medium (không còn rơi về Low) và gửi Itsaplan chữ thường", async () => {
    const summary = await toSummary();
    expect(summary.document.fields.priority?.value).toBe("medium");
    await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
    expect(it$.calls.createIssue[0].priority).toBe("medium");
  });

  it("bằng chứng chặn thanh toán nâng lên urgent", async () => {
    const llm = { baseUrl: "http://llm.fake", apiKey: "k", model: "m" };
    pipeline = build({
      extractor: new FieldExtractor(llm, async () =>
        JSON.stringify({
          userIntent: "report_issue",
          title: "Lỗi thanh toán",
          symptoms: ["bấm thanh toán ra 404"],
          blocksPayment: true,
          system: "CRM_Vuihoc",
          reportingDept: "Sale",
        }),
      ),
    });
    const r = await pipeline.run({
      chatId: CHAT,
      message: "Phụ huynh bấm thanh toán ra 404, em bên Sale",
    });
    expect(r.document.fields.priority?.value).toBe("urgent");
  });

  describe("người báo xin gấp (29/09: có lý do thì cho hết)", () => {
    const llm = { baseUrl: "http://llm.fake", apiKey: "k", model: "m" };
    const base = {
      userIntent: "report_issue",
      title: "Sai hạn khoá Tự học",
      symptoms: ["khoá tự học sai hạn"],
      system: "LMS_Vuihoc",
      reportingDept: "CSKH",
      studentAccount: "0900000006",
    };
    const withLlm = (replies: Record<string, unknown>[]) => {
      let i = 0;
      return build({
        extractor: new FieldExtractor(llm, async () =>
          JSON.stringify(replies[Math.min(i++, replies.length - 1)]),
        ),
      });
    };

    it("xin khẩn cấp kèm lý do → Urgent, lý do vào ticket", async () => {
      pipeline = withLlm([
        { ...base, requestedPriority: "urgent", requestedPriorityReason: "PH khiếu nại cả tuần" },
        { userIntent: "confirm" },
      ]);
      const r = await pipeline.run({
        chatId: CHAT,
        message: "khoá tự học sai hạn, em bên CSKH, khẩn cấp vì PH khiếu nại cả tuần",
      });
      expect(r.action).toBe("confirm_summary");
      expect(r.document.fields.priority?.value).toBe("urgent");
      await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
      expect(it$.calls.createIssue[0].priority).toBe("urgent");
      expect(it$.calls.createIssue[0].description).toContain(
        "Lý do ưu tiên (người báo): PH khiếu nại cả tuần",
      );
    });

    it("xin gấp chưa có lý do → hỏi một lần; trả lời lý do → High", async () => {
      pipeline = withLlm([
        { ...base, requestedPriority: "high" },
        { userIntent: "provide_info", symptoms: [] },
      ]);
      const r1 = await pipeline.run({
        chatId: CHAT,
        message: "khoá tự học sai hạn, em bên CSKH, xử lý gấp giúp em",
      });
      expect(r1.action).toBe("ask_missing_field");
      expect(r1.voiceText).toContain("lý do");
      const r2 = await pipeline.run({ chatId: CHAT, message: "học sinh mai thi rồi ạ" });
      expect(r2.action).toBe("confirm_summary");
      expect(r2.document.fields.priority?.value).toBe("high");
      expect(r2.document.requestedPriority?.reason).toBe("học sinh mai thi rồi ạ");
    });

    it("ticket đã tạo, xin khẩn cấp kèm lý do → nâng mức trên ticket + comment lý do", async () => {
      pipeline = withLlm([
        base,
        { userIntent: "confirm" },
        {
          userIntent: "provide_info",
          symptoms: [],
          requestedPriority: "urgent",
          requestedPriorityReason: "PH đang gay gắt",
        },
      ]);
      await pipeline.run({ chatId: CHAT, message: "khoá tự học sai hạn, em bên CSKH" });
      await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
      const asked = await pipeline.run({
        chatId: CHAT,
        message: "đổi mức ưu tiên thành URGENT hộ em, PH đang gay gắt",
      });
      expect(asked.action).toBe("confirm_ticket_action");
      expect(it$.calls.updateIssue.length).toBe(0);
      await pipeline.run({ chatId: CHAT, message: asked.buttons![0][0].callbackData });
      expect(it$.calls.updateIssue.some((u) => u.patch.priority === "urgent")).toBe(true);
      expect(it$.calls.addComment.at(-1)?.content).toContain("Lý do: PH đang gay gắt");
    });

    it("xin gấp mà 'không có' lý do → giữ mức theo bằng chứng", async () => {
      pipeline = withLlm([
        { ...base, requestedPriority: "urgent" },
        { userIntent: "provide_info", symptoms: [] },
      ]);
      await pipeline.run({ chatId: CHAT, message: "khoá tự học sai hạn, em bên CSKH, urgent nhé" });
      const r2 = await pipeline.run({ chatId: CHAT, message: "không có" });
      expect(r2.action).toBe("confirm_summary");
      expect(r2.document.fields.priority?.value).not.toBe("urgent");
    });
  });

  // ── Bug 5: tạo ticket dùng chung phần việc của create_issue ───────────
  it("tạo ticket: có binding, dọn bản nháp, nút xác nhận hiện lúc tóm tắt và bị xoá sau khi tạo", async () => {
    draftRepo.saveDraft(CHAT, { title: "bản nháp create_issue cũ" });
    const summary = await toSummary();
    expect(summary.buttons?.[0]?.[0]?.callbackData).toBe("đúng rồi");
    expect(btn.saved.get(CHAT)?.[0]?.[0]?.callbackData).toBe("đúng rồi");

    const created = await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
    expect(created.action).toBe("ticket_created");
    expect(created.status).toBe("created");
    expect(bindingRepo.getLatestBinding(CHAT)?.identifier).toBe(created.issue!.identifier);
    expect(draftRepo.getDraft(CHAT)).toBeNull();
    expect(btn.saved.has(CHAT)).toBe(false);
    expect(created.document.issueCreatedAt).toBeTruthy();
  });

  it("tin chỉ có ảnh không làm sập, ảnh được gắn vào tài liệu rồi tải lên ticket", async () => {
    const img = `/tmp/intake-step-test-${Date.now()}.png`;
    fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
    tmpFiles.push(img);

    const r0 = await pipeline.run({ chatId: CHAT, message: "", mediaPaths: [img] });
    expect(r0.success).toBe(true);
    expect(r0.document.fields.mediaPaths?.value).toEqual([img]);

    await pipeline.run({ chatId: CHAT, message: REPORT });
    const r2 = await pipeline.run({ chatId: CHAT, message: "Em bên Vận hành nhé" });
    expect(r2.action).toBe("confirm_summary");
    const r3 = await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
    expect(r3.action).toBe("ticket_created");
    expect(it$.calls.uploadAttachment.length).toBe(1);
    expect(it$.calls.updateIssue.length).toBe(1); // chèn ảnh vào mô tả
  });

  // ── Bug 6: tạo lỗi ────────────────────────────────────────────────────
  it("tạo ticket lỗi: không báo thành công, không lộ lỗi nội bộ, giữ tóm tắt để thử lại", async () => {
    await toSummary();
    it$.failNextCreate();
    const r = await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
    expect(r.success).toBe(false);
    expect(r.action).toBe("create_failed");
    expect(r.status).toBe("ready_for_confirmation");
    expect(r.issue).toBeUndefined();
    expect(r.voiceText).not.toContain("502");
    expect(r.voiceText).not.toContain("secret-internal-host");
    expect(r.buttons?.[0]?.[0]?.callbackData).toBe("đúng rồi");

    const retry = await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
    expect(retry.action).toBe("ticket_created");
    expect(it$.calls.createIssue.length).toBe(2);
  });

  // ── Bug 1: sau khi tạo ────────────────────────────────────────────────
  it("xác nhận lần hai: không tạo thêm, không comment rác", async () => {
    const first = await toCreated();
    const again = await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
    expect(again.action).toBe("already_created");
    expect(again.issue?.identifier).toBe(first.issue!.identifier);
    expect(it$.calls.createIssue.length).toBe(1);
    expect(it$.calls.addComment.length).toBe(0);
    expect(it$.calls.updateIssue.length).toBe(0);
  });

  it("hai cú xác nhận đồng thời chỉ tạo MỘT ticket", async () => {
    await toSummary();
    const [a, b] = await Promise.all([
      pipeline.run({ chatId: CHAT, message: "đúng rồi" }),
      pipeline.run({ chatId: `telegram:${CHAT}`, message: "đúng rồi" }),
    ]);
    expect(it$.calls.createIssue.length).toBe(1);
    expect([a.action, b.action].sort()).toEqual(["already_created", "ticket_created"]);
  });

  it("'cảm ơn em' sau khi tạo không đụng tới ticket", async () => {
    await toCreated();
    const r = await pipeline.run({ chatId: CHAT, message: "cảm ơn em nhé" });
    expect(r.action).toBe("already_created");
    expect(it$.calls.addComment.length).toBe(0);
    expect(it$.calls.updateIssue.length).toBe(0);
  });

  it("thông tin bổ sung sau khi tạo → comment, KHÔNG ghi đè mô tả", async () => {
    const created = await toCreated();
    // SĐT khác SĐT trong ticket → hỏi trước (có thể là sự cố khác, test E2E 28/09); chọn "Bổ sung" mới ghi.
    const asked = await pipeline.run({
      chatId: CHAT,
      message: "bổ sung thêm SĐT phụ huynh 0900000008",
    });
    expect(asked.action).toBe("confirm_ticket_action");
    expect(it$.calls.addComment.length).toBe(0);
    const r = await pipeline.run({ chatId: CHAT, message: asked.buttons![0][0].callbackData });
    expect(r.action).toBe("post_create_update");
    expect(it$.calls.updateIssue.length).toBe(0);
    expect(it$.calls.addComment.length).toBe(1);
    expect(it$.calls.addComment[0].issueId).toBe(created.issue!.id);
    expect(it$.calls.addComment[0].content).toContain("0900000008");
  });

  // TECH-1013 (30/09): sự cố iPad của phụ huynh khác bị ghi thẳng vào ticket vừa tạo (tin có ảnh,
  // không có định danh nào xung đột) rồi "ticket mới ạ" ghi tiếp vào đó. Nay luôn hỏi trước.
  describe("tin sau khi tạo ticket không bao giờ tự ghi vào ticket cũ (TECH-1013)", () => {
    const llm = { baseUrl: "http://llm.fake", apiKey: "k", model: "m" };
    const report = {
      userIntent: "report_issue",
      title: "Sai hạn khoá Tự học",
      symptoms: ["khoá tự học sai hạn"],
      system: "LMS_Vuihoc",
      reportingDept: "CSKH",
    };
    const provide = { userIntent: "provide_info", symptoms: ["iPad báo connecting"] };
    const withLlm = (replies: Record<string, unknown>[]) => {
      let i = 0;
      return build({
        extractor: new FieldExtractor(llm, async () =>
          JSON.stringify(replies[Math.min(i++, replies.length - 1)]),
        ),
      });
    };
    const createdWith = async (replies: Record<string, unknown>[]) => {
      pipeline = withLlm(replies);
      await pipeline.run({ chatId: CHAT, message: "khoá tự học sai hạn, em bên CSKH" });
      await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
      expect(it$.calls.createIssue.length).toBe(1);
    };

    it("tin có ảnh, không xung đột định danh → hỏi, chưa ghi gì", async () => {
      await createdWith([report, { userIntent: "confirm" }, provide]);
      const img = "/tmp/anh-ipad.jpg";
      const asked = await pipeline.run({
        chatId: CHAT,
        message: "0900000013 học sinh dùng iPad bị lỗi connecting",
        mediaPaths: [img],
      });
      expect(asked.action).toBe("confirm_ticket_action");
      expect(asked.buttons?.flat().map((b) => b.text)).toContain("Sự cố mới");
      expect(asked.buttons?.flat()[0].text).toMatch(/^✅ Bổ sung vào /);
      expect(it$.calls.addComment.length).toBe(0);
      expect(it$.calls.updateIssue.length).toBe(0);
    });

    it("chỉ gửi ảnh → cũng hỏi, không ghi", async () => {
      await createdWith([report, { userIntent: "confirm" }, provide]);
      const asked = await pipeline.run({ chatId: CHAT, message: "", mediaPaths: ["/tmp/anh.jpg"] });
      expect(asked.action).toBe("confirm_ticket_action");
      expect(it$.calls.addComment.length).toBe(0);
    });

    it('hỏi rồi người báo GÕ "ticket mới ạ" → sự cố mới từ tin đang chờ, ticket cũ không bị đụng', async () => {
      await createdWith([report, { userIntent: "confirm" }, provide, report]);
      const created = repo.getByDocId(
        (await pipeline.run({ chatId: CHAT, message: "cảm ơn em" })).docId,
      )!;
      await pipeline.run({
        chatId: CHAT,
        message: "0900000013 học sinh dùng iPad bị lỗi connecting",
      });
      const r = await pipeline.run({ chatId: CHAT, message: "ticket mới ạ" });
      expect(r.docId).not.toBe(created.docId);
      expect(r.status).toBe("collecting");
      expect(it$.calls.addComment.length).toBe(0);
    });

    it('vừa tạo xong, người báo chỉ nhắn "ticket mới ạ" → mở tài liệu mới xin mô tả, không ghi gì', async () => {
      await createdWith([report, { userIntent: "confirm" }, provide]);
      const r = await pipeline.run({ chatId: CHAT, message: "ticket mới ạ" });
      expect(r.action).toBe("clarify_intent");
      expect(it$.calls.addComment.length).toBe(0);
    });

    describe("người báo có nhiều ticket đang mở (TECH-989 ↔ TECH-1001, 30/09)", () => {
      const own = (n: number) =>
        bindingRepo.saveBinding({
          issueId: 5000 + n,
          channelType: "telegram",
          chatId: CHAT,
          messageId: "1",
          identifier: `TECHTEST-${n}`,
        });
      const interp = (cmd: any) => ({ interpret: async () => cmd });
      const build2 = (cmd: any) =>
        build({
          ticketCommands: interp(cmd),
          extractor: new FieldExtractor(llm, async (_c: any, _s: any, prompt: string) =>
            JSON.stringify(
              /đúng rồi/i.test(prompt)
                ? { userIntent: "confirm" }
                : /thêm:/i.test(prompt)
                  ? provide
                  : report,
            ),
          ),
        });
      const toCreated2 = async (cmd: any) => {
        pipeline = build2(cmd);
        await pipeline.run({ chatId: CHAT, message: "khoá tự học sai hạn, em bên CSKH" });
        await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
      };

      it("hiểu ý chọn ticket cũ, mỗi ticket đang mở có nút riêng; bấm nút ticket cũ mới ghi vào ticket cũ", async () => {
        own(795);
        await toCreated2({
          action: "append",
          identifier: "TECHTEST-795",
          content: "thêm: PH đang giục gấp",
        });
        const asked = await pipeline.run({ chatId: CHAT, message: "thêm: PH đang giục gấp" });
        expect(asked.action).toBe("confirm_ticket_action");
        const labels = asked.buttons!.flat().map((b) => b.text);
        expect(labels[0]).toBe("✅ Bổ sung vào TECHTEST-795");
        expect(labels.some((l) => /^✅ Bổ sung vào TECHTEST-1\d\d$/.test(l))).toBe(true);
        expect(labels).toContain("Sự cố mới");
        expect(asked.voiceText).toContain("TECHTEST-795");
        expect(it$.calls.addComment.length).toBe(0);
        await pipeline.run({ chatId: CHAT, message: "✅ Bổ sung vào TECHTEST-795" });
        expect(it$.calls.addComment.length).toBe(1);
        expect(it$.calls.addComment[0].issueId).toBe(5795);
      });

      it("không rõ ticket nào → gợi ý ticket vừa tạo, nhưng ticket cũ vẫn có nút để chọn đúng", async () => {
        own(795);
        await toCreated2({ action: "unclear" });
        const asked = await pipeline.run({ chatId: CHAT, message: "thêm: PH đang giục gấp" });
        const labels = asked.buttons!.flat().map((b) => b.text);
        expect(labels[0]).toMatch(/^✅ Bổ sung vào TECHTEST-1\d\d$/);
        expect(labels).toContain("✅ Bổ sung vào TECHTEST-795");
        await pipeline.run({ chatId: CHAT, message: "✅ Bổ sung vào TECHTEST-795" });
        expect(it$.calls.addComment.map((c) => c.issueId)).toEqual([5795]);
      });
    });

    it("chỉ khi bấm nút xác nhận mới ghi comment vào ticket", async () => {
      await createdWith([report, { userIntent: "confirm" }, provide, provide]);
      const asked = await pipeline.run({
        chatId: CHAT,
        message: "thêm: học sinh dùng iPad",
        mediaPaths: [],
      });
      expect(it$.calls.addComment.length).toBe(0);
      const r = await pipeline.run({ chatId: CHAT, message: asked.buttons![0][0].callbackData });
      expect(r.action).toBe("post_create_update");
      expect(it$.calls.addComment.length).toBe(1);
    });
  });

  it("sự cố mới sau khi tạo → tài liệu mới, không ghi vào ticket cũ", async () => {
    const created = await toCreated();
    const r = await pipeline.run({
      chatId: CHAT,
      message: "CRM bị lỗi 500 khi mở đơn hàng của phụ huynh 0900000014",
    });
    expect(r.docId).not.toBe(created.docId);
    expect(r.status).toBe("collecting");
    expect(it$.calls.addComment.length).toBe(0);
    expect(r.document.fields.system?.value).toBe("CRM_Vuihoc");
  });

  // ── Bug 2: huỷ ────────────────────────────────────────────────────────
  it("sau khi huỷ, lượt tiếp theo mở tài liệu mới và KHÔNG quên thông tin các lượt sau", async () => {
    const r1 = await pipeline.run({ chatId: CHAT, message: REPORT });
    for (let i = 0; i < 3; i++) await pipeline.run({ chatId: CHAT, message: "máy iPad iOS 17" }); // đẩy revision lên cao
    const c = await pipeline.run({ chatId: CHAT, message: "thôi hủy đi em" });
    expect(c.action).toBe("canceled");
    expect(c.status).toBe("canceled");

    const n1 = await pipeline.run({
      chatId: CHAT,
      message: "CRM bị lỗi 500 khi mở đơn hàng của phụ huynh 0900000014",
    });
    expect(n1.docId).not.toBe(r1.docId);
    const n2 = await pipeline.run({ chatId: CHAT, message: "Em bên Sale ạ" });
    // Cùng tài liệu mới, vẫn nhớ lượt trước
    expect(n2.docId).toBe(n1.docId);
    expect(n2.document.fields.system?.value).toBe("CRM_Vuihoc");
    expect(n2.action).toBe("confirm_summary");
  });

  // ── Hết hạn ───────────────────────────────────────────────────────────
  it("bản nháp im lặng quá 24h hết hạn, tin mới mở tài liệu mới", async () => {
    const r1 = await pipeline.run({ chatId: CHAT, message: REPORT });
    const stale: IntakeDocument = {
      ...r1.document,
      revision: r1.document.revision + 1,
      updatedAt: new Date(Date.now() - 25 * 3600_000).toISOString(),
    };
    repo.saveRevision(stale);

    const r2 = await pipeline.run({ chatId: CHAT, message: "CRM bị lỗi 500 khi mở đơn hàng" });
    expect(r2.docId).not.toBe(r1.docId);
    expect(r2.document.fields.studentAccount).toBeUndefined();
    expect(repo.getByDocId(r1.docId)?.status).toBe("expired");
  });

  // ── Bug 10: hệ thống chưa rõ ──────────────────────────────────────────
  it("thiếu hệ thống: hỏi MỘT lần kèm nút, không biết thì tóm tắt ghi rõ 'Chưa xác định'", async () => {
    const r1 = await pipeline.run({
      chatId: CHAT,
      message: "Học sinh 0900000005 không làm bài được, em bên Vận hành",
    });
    expect(r1.action).toBe("ask_missing_field");
    expect(r1.missingFields).toEqual(["system"]);
    expect(r1.buttons?.flat().map((b) => b.callbackData)).toContain("CRM_Vuihoc");

    const r2 = await pipeline.run({ chatId: CHAT, message: "không rõ" });
    expect(r2.action).toBe("confirm_summary");
    expect(r2.displayMarkdown).toContain("Chưa xác định");
  });

  it("chọn hệ thống qua nút thì điền đúng giá trị", async () => {
    await pipeline.run({
      chatId: CHAT,
      message: "Học sinh 0900000005 không làm bài được, em bên Vận hành",
    });
    const r = await pipeline.run({ chatId: CHAT, message: "VH_Tự học" });
    expect(r.document.fields.system?.value).toBe("VH_Tự học");
    expect(r.action).toBe("confirm_summary");
  });

  // ── Bug 9: KG chỉ tra một lần, chạy NỀN sau khi tạo (không chặn câu trả lời) ──
  it("Knowledge Graph chỉ được tra một lần mỗi tài liệu, chạy nền SAU khi tạo ticket", async () => {
    let kgCalls = 0;
    pipeline = build({
      similarTickets: {
        find: async () => {
          kgCalls++;
          return {
            clusterId: "TECH-1",
            share: 1,
            members: [
              {
                identifier: "TECH-1",
                title: "cũ",
                humanCause: "Cache hỏng",
                humanFix: "Xoá cache app",
              },
            ],
            advice: { cause: "Cache hỏng", fix: "Xoá cache app", from: "TECH-1" },
          };
        },
      } as any,
    });
    await pipeline.run({ chatId: CHAT, message: REPORT });
    expect(kgCalls).toBe(0);
    await pipeline.run({ chatId: CHAT, message: "Em bên Vận hành nhé" });
    await pipeline.run({ chatId: CHAT, message: "máy iPad" });
    // Vẫn ở bước tóm tắt xin xác nhận — KG chưa chạy, mô tả ticket chưa có gợi ý
    // (kiến trúc mới chạy nền SAU khi tạo, không chặn bản tóm tắt xin xác nhận).
    expect(kgCalls).toBe(0);
    const created = await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
    expect(created.action).toBe("ticket_created");
    expect(it$.calls.createIssue[0].description).not.toContain("Xoá cache app");

    await pipeline.flushBackgroundForTests();
    expect(kgCalls).toBe(1);
    // Gợi ý KG nằm ở comment riêng, không viết lại mô tả (TECH-1084).
    expect(it$.calls.addComment[0]?.content).toContain("Xoá cache app");

    // Chạy nền lại lần nữa (vd tin nhắn thêm sau khi tạo) không tra KG lại.
    await pipeline.run({ chatId: CHAT, message: "Cảm ơn em nhé" });
    await pipeline.flushBackgroundForTests();
    expect(kgCalls).toBe(1);
  });

  // ── TECH-956 (28/09/2026): "chưa chắc" hiển thị thay vì im lặng hoàn toàn ──
  it("KG không có gì CHẮC CHẮN nhưng có cụm 'có thể liên quan' → gợi ý ở comment riêng, KHÔNG ghi Related Tickets/link (TECH-956)", async () => {
    pipeline = build({
      similarTickets: {
        find: async () => ({
          clusterId: null,
          share: 0,
          members: [],
          question: "Anh/chị kiểm tra CRM xem 2 tài khoản có chung SĐT không nhé.",
          possible: [
            {
              clusterId: "TECH-337",
              cause: "Hai hồ sơ học sinh gắn cùng một SĐT",
              sampleIds: ["TECH-712", "TECH-889"],
            },
          ],
        }),
      } as any,
    });
    await pipeline.run({ chatId: CHAT, message: REPORT });
    await pipeline.run({ chatId: CHAT, message: "Em bên Vận hành nhé" });
    const created = await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
    expect(created.action).toBe("ticket_created");

    await pipeline.flushBackgroundForTests();

    // Gợi ý chuyển sang comment riêng (TECH-1084): mô tả ticket sạch, bot không
    // viết suy luận vào mô tả nữa.
    const commentBody = it$.calls.addComment[0]?.content ?? "";
    expect(commentBody).toContain("Có thể liên quan (chưa chắc)");
    expect(commentBody).toContain("Hai hồ sơ học sinh gắn cùng một SĐT");
    expect(commentBody).toContain("TECH-712");
    expect(commentBody).toContain("kiểm tra CRM");
    // Không ghi Related Tickets (custom field) hay native link — chỉ comment gợi ý.
    expect(it$.calls.addComment.length).toBe(1);
  });

  it("KG không tìm được ứng viên nào chắc chắn hay có thể liên quan → im lặng như trước (không kgAdvice)", async () => {
    pipeline = build({
      similarTickets: { find: async () => null } as any,
    });
    await pipeline.run({ chatId: CHAT, message: REPORT });
    await pipeline.run({ chatId: CHAT, message: "Em bên Vận hành nhé" });
    await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
    await pipeline.flushBackgroundForTests();
    // Gợi ý KG giờ đi qua `addComment`, không phải `updateIssue` (TECH-1084) —
    // phải chặn đúng kênh ghi, nếu không khẳng định này luôn đúng.
    expect(it$.calls.addComment.length).toBe(0);
  });

  // ── TECH-924 (26/09): phong bì OpenClaw lọt vào mô tả ticket ─────────
  it("phong bì kênh (Conversation info / Sender / context) không lọt vào mô tả ticket", async () => {
    const envelope = `${REPORT}\nConversation info (untrusted metadata):\n{\n  "chat_id": "telegram:1000000003",\n  "username": "SA_UserH"\n}\n`;
    await pipeline.run({ chatId: CHAT, message: envelope });
    await pipeline.run({ chatId: CHAT, message: "Em bên Vận hành nhé" });
    await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
    const description = it$.calls.createIssue[0].description;
    expect(description).not.toContain("untrusted");
    expect(description).not.toContain("SA_UserH");
  });

  // ── Bug 10: tin rất dài ───────────────────────────────────────────────
  it("tin nhắn rất dài không thổi phồng mô tả ticket", async () => {
    const huge = `App Duo lỗi đăng nhập ${"log ".repeat(20000)}`;
    await pipeline.run({ chatId: CHAT, message: huge });
    await pipeline.run({ chatId: CHAT, message: "Em bên Vận hành nhé" });
    await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
    expect(it$.calls.createIssue[0].description.length).toBeLessThan(12000);
  });

  // ── TECH-928 phần 2 (đo lại 28/09/2026 — nguyên nhân thật) ───────────
  // Tờ khai sự cố A đang chờ xác nhận. Tin nhắn kế tiếp của CHÍNH người báo
  // lại là một sự cố B khác hẳn (đơn hàng khác, SĐT khác). Trước khi vá,
  // pipeline gộp lặng lẽ: A mất SĐT thật, B mất trắng, ticket ra đời lẫn lộn
  // cả hai (TECH-928: tiêu đề của A, SĐT của B). Vá generic bằng cách so
  // dãy chữ số của định danh (không phải keyword) — xung đột thì hỏi rõ.
  describe("định danh xung đột với tờ khai đang mở (TECH-928)", () => {
    const REPORT_A = "Lỗi app Duo học sinh 0900000003 không làm bài được";
    const CONFLICTING_B = "Đơn hàng DH900004 báo sai thời hạn khoá học, SĐT phụ huynh 0900000004";

    it("tin có SĐT khác với tờ khai đang chờ KHÔNG bị gộp lặng lẽ — hỏi sự cố mới hay bổ sung", async () => {
      const before = await toSummary(CHAT, REPORT_A);
      const asked = await pipeline.run({ chatId: CHAT, message: CONFLICTING_B });

      expect(asked.action).toBe("ask_new_or_continue");
      // A vẫn y nguyên — không bị B ghi đè.
      expect(asked.document.fields.studentAccount?.value).toBe("0900000003");
      expect(asked.docId).toBe(before.docId);
      const labels = (asked.buttons ?? []).flat().map((b) => b.callbackData);
      expect(labels).toEqual(expect.arrayContaining(["Sự cố mới", "Bổ sung sự cố đang chờ"]));
    });

    it('chọn "Sự cố mới" → tờ khai A giữ nguyên không đổi, tin B mở một tài liệu độc lập với đúng dữ liệu của B', async () => {
      const before = await toSummary(CHAT, REPORT_A);
      await pipeline.run({ chatId: CHAT, message: CONFLICTING_B });
      const created = await pipeline.run({ chatId: CHAT, message: "Sự cố mới" });

      expect(created.docId).not.toBe(before.docId);
      expect(created.status).toBe("collecting");
      expect(created.document.fields.studentAccount?.value).toBe("0900000004");

      // Tờ khai A không hề bị đụng vào — đọc lại đúng docId cũ, SĐT vẫn là của A.
      const parkedA = repo.getByDocId(before.docId);
      expect(parkedA?.fields.studentAccount?.value).toBe("0900000003");
      expect(parkedA?.pendingNewIncident).toBeUndefined();
    });

    it('chọn "Bổ sung sự cố đang chờ" → gộp tin B vào CHÍNH tờ khai A (người dùng đã xác nhận là cùng sự cố)', async () => {
      const before = await toSummary(CHAT, REPORT_A);
      await pipeline.run({ chatId: CHAT, message: CONFLICTING_B });
      const merged = await pipeline.run({ chatId: CHAT, message: "Bổ sung sự cố đang chờ" });

      expect(merged.docId).toBe(before.docId);
      expect(merged.document.fields.studentAccount?.value).toBe("0900000004");
    });

    it("trả lời không rõ (không bấm 1 trong 2 nút) → hỏi lại, không đoán, không mất dữ liệu bên nào", async () => {
      const before = await toSummary(CHAT, REPORT_A);
      await pipeline.run({ chatId: CHAT, message: CONFLICTING_B });
      const unclear = await pipeline.run({ chatId: CHAT, message: "hmm để em xem lại đã" });

      expect(unclear.action).toBe("ask_new_or_continue");
      expect(unclear.docId).toBe(before.docId);
      expect(unclear.document.fields.studentAccount?.value).toBe("0900000003");
    });

    // Test E2E 28/09: ticket đã TẠO (TECH-956, mã 9100001), người báo gửi sự cố khác
    // (mã 90000005) → trước đây LLM đoán "bổ sung", ghi nhầm vào ticket cũ.
    it("ticket đã tạo + tin có mã khác → hỏi sự cố mới hay bổ sung, không tự ghi bổ sung", async () => {
      await toSummary(CHAT, REPORT_A);
      const created = await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
      expect(created.action).toBe("ticket_created");
      const asked = await pipeline.run({ chatId: CHAT, message: CONFLICTING_B });
      expect(asked.action).toBe("confirm_ticket_action");
      expect(asked.docId).toBe(created.docId);

      const fresh = await pipeline.run({ chatId: CHAT, message: "Sự cố mới" });
      expect(fresh.docId).not.toBe(created.docId);
      expect(fresh.document.fields.studentAccount?.value).toBe("0900000004");
      expect(repo.getByDocId(created.docId)?.pendingNewIncident).toBeUndefined();
    });

    it('ticket đã tạo + tin có mã khác + chọn "Bổ sung" → ghi bổ sung vào ticket đó', async () => {
      await toSummary(CHAT, REPORT_A);
      const created = await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
      const askedB = await pipeline.run({ chatId: CHAT, message: CONFLICTING_B });
      const appended = await pipeline.run({
        chatId: CHAT,
        message: askedB.buttons![0][0].callbackData,
      });
      expect(appended.action).toBe("post_create_update");
      expect(appended.docId).toBe(created.docId);
      // Bổ sung không đè định danh của ticket đã tạo.
      expect(appended.document.fields.studentAccount?.value).toBe("0900000003");
    });

    it('đang hỏi sự cố mới hay bổ sung, người dùng gõ "thôi huỷ" → bỏ tin vừa rồi, tờ khai A giữ nguyên', async () => {
      const before = await toSummary(CHAT, REPORT_A);
      await pipeline.run({ chatId: CHAT, message: CONFLICTING_B });
      const c = await pipeline.run({ chatId: CHAT, message: "thôi huỷ đi em" });
      expect(c.action).toBe("canceled");
      const a = repo.getByDocId(before.docId);
      expect(a?.pendingNewIncident).toBeUndefined();
      expect(a?.fields.studentAccount?.value).toBe("0900000003");
      expect(a?.status).toBe("ready_for_confirmation");
    });

    it("nhắc lại ĐÚNG SĐT đã cho (cùng sự cố, không phải số khác) — không hỏi lại, không chặn nhầm", async () => {
      await toSummary(CHAT, REPORT_A);
      const res = await pipeline.run({
        chatId: CHAT,
        message: "Vâng SĐT của em là 0900000003 đúng rồi ạ",
      });

      expect(res.action).not.toBe("ask_new_or_continue");
      expect(res.document.fields.studentAccount?.value).toBe("0900000003");
    });

    // Test E2E 28/09: tờ khai A (sự cố C trong báo cáo) đang chờ xác nhận bị GÁC
    // LẠI khi chọn "Sự cố mới" cho B — trước khi vá, B tạo ticket xong thì A mồ
    // côi vĩnh viễn: getLatestByChatId chỉ còn trả B, không ai nhắc lại A nữa.
    describe("tờ khai bị gác lại không mồ côi sau khi sự cố mới xong việc", () => {
      it('B tạo ticket xong → ticket_created nhắc tên A kèm nút "Tiếp tục sự cố đang chờ"; bấm nút → quay lại đúng A (docId, SĐT, tiêu đề của A) chờ xác nhận', async () => {
        const before = await toSummary(CHAT, REPORT_A);
        await pipeline.run({ chatId: CHAT, message: CONFLICTING_B });
        const fresh = await pipeline.run({ chatId: CHAT, message: "Sự cố mới" });
        expect(fresh.docId).not.toBe(before.docId);
        expect(fresh.status).toBe("collecting");

        // Dẫn B đủ trường để hoàn tất tóm tắt (CONFLICTING_B không có mô tả lỗi rõ
        // ràng nên bot hỏi lại mô tả, rồi bộ phận, rồi hệ thống — như một sự cố mới bình thường).
        await pipeline.run({
          chatId: CHAT,
          message: "Lỗi hiển thị sai thời hạn khoá học trên đơn hàng ạ",
        });
        await pipeline.run({ chatId: CHAT, message: "Em bên Sale ạ" });
        const summaryB = await pipeline.run({ chatId: CHAT, message: "CRM_Vuihoc" });
        expect(summaryB.action).toBe("confirm_summary");
        const createdB = await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
        expect(createdB.action).toBe("ticket_created");

        // Nhắc về A: tiêu đề của A xuất hiện trong voiceText, kèm nút riêng.
        const titleA = before.document.fields.title?.value;
        expect(titleA).toBeTruthy();
        expect(createdB.voiceText).toContain(titleA!);
        expect(createdB.voiceText).toContain("đang chờ xác nhận");
        const labels = (createdB.buttons ?? []).flat().map((b) => b.callbackData);
        expect(labels).toContain("Tiếp tục sự cố đang chờ");

        // Bấm nút: A trở lại làm tài liệu đang mở, đúng docId, đúng dữ liệu gốc.
        const resumed = await pipeline.run({ chatId: CHAT, message: "Tiếp tục sự cố đang chờ" });
        expect(resumed.docId).toBe(before.docId);
        expect(resumed.action).toBe("confirm_summary");
        expect(resumed.document.fields.studentAccount?.value).toBe("0900000003");
        expect(resumed.document.fields.title?.value).toBe(titleA);

        // Không tạo thêm ticket nào ngoài B — bấm nút chỉ tóm tắt lại, không tự tạo.
        expect(it$.calls.createIssue.length).toBe(1);
      });

      it("không có tờ khai nào bị gác lại → ticket_created bình thường, không có câu nhắc/nút phụ", async () => {
        const created = await toCreated();
        expect(created.voiceText).not.toContain("đang chờ xác nhận");
        expect((created.buttons ?? []).flat().map((b) => b.callbackData)).not.toContain(
          "Tiếp tục sự cố đang chờ",
        );
      });

      it('B bị HUỶ (không tạo ticket) → packet "canceled" cũng nhắc về A còn đang chờ', async () => {
        const before = await toSummary(CHAT, REPORT_A);
        await pipeline.run({ chatId: CHAT, message: CONFLICTING_B });
        await pipeline.run({ chatId: CHAT, message: "Sự cố mới" });
        const canceledB = await pipeline.run({ chatId: CHAT, message: "thôi hủy đi em" });
        expect(canceledB.action).toBe("canceled");

        const titleA = before.document.fields.title?.value;
        expect(canceledB.voiceText).toContain(titleA!);
        const labels = (canceledB.buttons ?? []).flat().map((b) => b.callbackData);
        expect(labels).toContain("Tiếp tục sự cố đang chờ");

        const resumed = await pipeline.run({ chatId: CHAT, message: "Tiếp tục sự cố đang chờ" });
        expect(resumed.docId).toBe(before.docId);
        expect(resumed.document.fields.studentAccount?.value).toBe("0900000003");
      });
    });
  });

  // ── TECH-956 (28/09/2026 — regression từ 1f2f5f1) ────────────────────
  // Người báo (qua Telegram): "[TEST] 9100001 K TẠO ĐƯỢC ĐƠN HÀNG DO TRÙNG TÀI
  // KHOẢN 2 CON ĐỀU LÀ CÙNG 1 SĐT. Hệ thống CRM, sản phẩm Tutor, em bên Sale".
  // Extractor (LLM) diễn giải `symptoms` thành câu paraphrase KHÔNG còn chữ số
  // nào, còn `customerId="9100001"` thì trích đúng. `describe()` từng dựng
  // incident cho `formatTicketDescription` mà KHÔNG kèm `rawText` của người
  // báo, nên `groundIdentifierFields` phải đối chiếu tạm bằng `symptoms` (đã
  // paraphrase, không còn "9100001") và xoá mất mã khách hàng có thật. Vá:
  // `describe()` phải truyền `doc.fields.rawText` — lời kể GỐC — vào incident.
  // Test E2E 28/09: tờ khai "bài tập" đang hỏi bộ phận (chưa có định danh), người báo gửi sự cố
  // khác (9100001, trùng tài khoản) → trước đây gộp, tóm tắt mang tiêu đề "bài tập".
  it("tờ khai đang hỏi trường thiếu + tin mới là lời báo sự cố trọn vẹn → hỏi sự cố mới hay bổ sung", async () => {
    const llm = { baseUrl: "http://llm.fake", apiKey: "k", model: "m" };
    pipeline = build({
      extractor: new FieldExtractor(llm, async (_cfg, _sys, userPrompt: string) => {
        if (userPrompt.includes("9100001"))
          return JSON.stringify({
            userIntent: "report_issue",
            title: "Không tạo được đơn do trùng tài khoản",
            symptoms: ["trùng tài khoản 2 con"],
            customerId: "9100001",
            system: "CRM_Vuihoc",
            reportingDept: "Sale",
            product: "Tutor",
          });
        if (/Sự cố mới/i.test(userPrompt)) return JSON.stringify({ userIntent: "provide_info" });
        return JSON.stringify({
          userIntent: "report_issue",
          title: "Học sinh bấm bài tập báo đăng ký tài khoản",
          symptoms: ["bấm bài tập báo đăng ký tài khoản"],
          system: "TUTOR_Vuihoc",
          product: "Tutor",
        });
      }),
    });
    const r1 = await pipeline.run({
      chatId: CHAT,
      message: "HS bấm vào bài tập vẫn báo đăng ký tài khoản",
    });
    expect(r1.action).toBe("ask_missing_field");
    const r2 = await pipeline.run({
      chatId: CHAT,
      message: "9100001 không tạo được đơn hàng do trùng tài khoản 2 con cùng 1 SĐT, em bên Sale",
    });
    expect(r2.action).toBe("ask_new_or_continue");
    expect(r2.document.fields.title?.value).toBe("Học sinh bấm bài tập báo đăng ký tài khoản");
    const r3 = await pipeline.run({ chatId: CHAT, message: "Sự cố mới" });
    expect(r3.docId).not.toBe(r1.docId);
    expect(r3.document.fields.title?.value).toBe("Không tạo được đơn do trùng tài khoản");
  });

  it("customerId thật không bị reground/xoá dù symptoms LLM paraphrase không còn chữ số (TECH-956)", async () => {
    const raw =
      "[TEST] 9100001 K TẠO ĐƯỢC ĐƠN HÀNG DO TRÙNG TÀI KHOẢN 2 CON ĐỀU LÀ CÙNG 1 SĐT. Hệ thống CRM, sản phẩm Tutor, em bên Sale";
    const llm = { baseUrl: "http://llm.fake", apiKey: "k", model: "m" };
    pipeline = build({
      extractor: new FieldExtractor(llm, async (_cfg, _sys, userPrompt: string) => {
        if (/đúng rồi/i.test(userPrompt)) {
          return JSON.stringify({ userIntent: "confirm" });
        }
        return JSON.stringify({
          userIntent: "report_issue",
          title: "Trùng tài khoản khi tạo đơn hàng CRM",
          // Paraphrase của LLM — cố tình KHÔNG còn chữ số nào của "9100001".
          symptoms: ["Trùng tài khoản khi tạo đơn hàng do hai con dùng chung một số điện thoại"],
          customerId: "9100001",
          product: "Tutor",
          system: "CRM_Vuihoc",
          reportingDept: "Sale",
        });
      }),
    });

    const r1 = await pipeline.run({ chatId: CHAT, message: raw });
    expect(r1.action).toBe("confirm_summary");
    expect(r1.document.fields.customerId?.value).toBe("9100001");
    expect(r1.document.fields.rawText?.value).toContain("9100001");

    const r2 = await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
    expect(r2.action).toBe("ticket_created");

    const description = it$.calls.createIssue[0].description;
    expect(description).toContain("Mã khách hàng: 9100001");
  });

  describe("soát dữ kiện kỹ thuật trước khi xin xác nhận (TECH-759: 'theo đơn hàng nào?')", () => {
    const reviewer = (result: { missing: string[]; question?: string }) => {
      const seen: string[] = [];
      return {
        seen,
        review: async (input: { description: string }) => {
          seen.push(input.description);
          return result;
        },
      };
    };

    it("thiếu dữ kiện → hỏi MỘT lượt, câu trả lời vào mô tả rồi mới tóm tắt", async () => {
      const r = reviewer({
        missing: ["mã đơn hàng"],
        question: "Anh/chị cho em xin mã đơn hàng (DH…) nhé ạ.",
      });
      pipeline = build({ techReviewer: r });
      const r1 = await pipeline.run({ chatId: CHAT, message: REPORT });
      expect(r1.action).toBe("ask_missing_field");
      const r2 = await pipeline.run({ chatId: CHAT, message: "Em bên Vận hành nhé" });
      expect(r2.action).toBe("ask_missing_field");
      expect(r2.voiceText).toContain("mã đơn hàng");
      expect(r2.buttons?.flat().map((b) => b.text)).toContain("Không có");
      // Câu trả lời đọc như một lời báo đầy đủ vẫn là bổ sung, không bị hỏi "sự cố mới hay bổ sung"
      const r3 = await pipeline.run({
        chatId: CHAT,
        message: "Đơn DH900002 bị lỗi, hạn đang hiện 2026 nhưng đúng phải là 2030",
      });
      expect(r3.action).toBe("confirm_summary");
      expect(r3.document.fields.symptoms?.value?.join("\n")).toContain("DH900002");
      expect(r.seen.length).toBe(1);
      const created = await pipeline.run({ chatId: CHAT, message: "ok tạo đi" });
      expect(created.action).toBe("ticket_created");
      const description = it$.calls.createIssue[0].description as string;
      // Mô tả là nguyên văn MỌI lời kể, không chỉ tin đầu (TECH-972 mất câu trả lời bổ sung)
      expect(description).toContain("không làm bài được");
      expect(description).toContain("DH900002");
    });

    it("câu trả lời chỉ gồm một mã vẫn vào mô tả", async () => {
      pipeline = build({
        techReviewer: reviewer({ missing: ["mã đơn hàng"], question: "Cho em xin mã đơn ạ." }),
      });
      await pipeline.run({ chatId: CHAT, message: REPORT });
      await pipeline.run({ chatId: CHAT, message: "Em bên Vận hành nhé" });
      const r3 = await pipeline.run({ chatId: CHAT, message: "DH900002" });
      expect(r3.action).toBe("confirm_summary");
      expect(r3.document.fields.rawText?.value).toContain("DH900002");
      expect(r3.document.fields.rawText?.value).not.toContain("Vận hành nhé");
    });

    it("mã đơn / link có trong lời báo được đưa vào 'Trường đã có'", async () => {
      const r = reviewer({ missing: [] });
      let known: Record<string, string> = {};
      pipeline = build({
        techReviewer: { review: async (input: any) => ((known = input.known), r.review(input)) },
      });
      await pipeline.run({
        chatId: CHAT,
        message: `${REPORT}, đơn DH900006, https://se-care.example.com/x/1`,
      });
      await pipeline.run({ chatId: CHAT, message: "Em bên Vận hành nhé" });
      expect(known["Mã đơn hàng"]).toBe("DH900006");
      expect(known["Link"]).toContain("se-care.example.com");
    });

    it("người báo bấm 'Không có' → tóm tắt luôn, không hỏi lại", async () => {
      pipeline = build({
        techReviewer: reviewer({
          missing: ["ảnh báo lỗi"],
          question: "Anh/chị gửi em ảnh báo lỗi nhé.",
        }),
      });
      await pipeline.run({ chatId: CHAT, message: REPORT });
      await pipeline.run({ chatId: CHAT, message: "Em bên Vận hành nhé" });
      const r3 = await pipeline.run({ chatId: CHAT, message: "Không có" });
      expect(r3.action).toBe("confirm_summary");
    });

    it("hỏi hết (checklist): một tin có ảnh màn hình, trả lời/'Không có' đều đi tiếp tới tóm tắt", async () => {
      pipeline = build({ techReviewer: new ChecklistTechReviewer() });
      await pipeline.run({ chatId: CHAT, message: REPORT });
      const r2 = await pipeline.run({ chatId: CHAT, message: "Em bên Vận hành nhé" });
      expect(r2.action).toBe("ask_missing_field");
      expect(r2.voiceText).toContain("Ảnh chụp màn hình");
      expect(r2.buttons?.flat().map((b) => b.text)).toContain("Không có");
      const r3 = await pipeline.run({ chatId: CHAT, message: "Không có" });
      expect(r3.action).toBe("confirm_summary");
    });

    it("đủ dữ kiện hoặc soát lỗi → tóm tắt như cũ", async () => {
      pipeline = build({ techReviewer: reviewer({ missing: [] }) });
      await toSummary();
      pipeline = build({
        techReviewer: {
          review: async () => {
            throw new Error("LLM chết");
          },
        },
      });
      await toSummary("7002");
    });
  });

  describe("ghi vào ticket ĐÃ CÓ luôn phải xác nhận (ADR-0008; TECH-795 → TECH-975)", () => {
    const interp = (cmd: any) => {
      const seen: any[] = [];
      return { seen, interpret: async (input: any) => (seen.push(input), cmd) };
    };
    const techAsked = () =>
      bindingRepo.saveMessageRoute("9001", "telegram", 5795, "TECHTEST-795", CHAT, "comment");
    const own = (n: number) =>
      bindingRepo.saveBinding({
        issueId: 5000 + n,
        channelType: "telegram",
        chatId: CHAT,
        messageId: "1",
        identifier: `TECHTEST-${n}`,
      });

    it("kỹ thuật vừa hỏi → GỢI Ý bổ sung, chưa ghi gì; bấm xác nhận mới ghi", async () => {
      techAsked();
      const c = interp({
        action: "append",
        identifier: "TECHTEST-795",
        content: "Đơn hàng gia hạn ạ",
      });
      pipeline = build({ ticketCommands: c });
      const r1 = await pipeline.run({
        chatId: CHAT,
        message: "Đơn hàng gia hạn ạ- ac check tt hộ e ạ",
      });
      expect(r1.action).toBe("confirm_ticket_action");
      expect(r1.buttons?.flat().map((b) => b.text)).toEqual([
        "✅ Bổ sung vào TECHTEST-795",
        "Sự cố mới",
      ]);
      expect(it$.calls.addComment).toHaveLength(0);
      expect(c.seen[0].candidates[0].techQuestion).toContain("đơn hàng nào sai");
      // model có thể bỏ emoji khi chuyển nhãn nút
      const r2 = await pipeline.run({ chatId: CHAT, message: "Bổ sung vào TECHTEST-795" });
      expect(r2.action).toBe("post_create_update");
      expect(it$.calls.addComment).toHaveLength(1);
      expect(it$.calls.addComment[0].issueId).toBe(5795);
      expect(it$.calls.addComment[0].content).toContain("Đơn hàng gia hạn ạ");
      expect(it$.calls.createIssue).toHaveLength(0);
    });

    it("giục gấp có lý do vào ticket có sẵn → chỉ khi bấm xác nhận mới nâng mức + ghi lý do (thay escalate_issue cũ)", async () => {
      own(795);
      const llm = { baseUrl: "http://llm.fake", apiKey: "k", model: "m" };
      pipeline = build({
        ticketCommands: interp({
          action: "append",
          identifier: "TECHTEST-795",
          content: "gấp lắm ạ, PH sắp khiếu nại",
        }),
        extractor: new FieldExtractor(llm, async () =>
          JSON.stringify({
            userIntent: "provide_info",
            symptoms: [],
            requestedPriority: "urgent",
            requestedPriorityReason: "PH sắp khiếu nại",
          }),
        ),
      });
      const r1 = await pipeline.run({
        chatId: CHAT,
        message: "TECHTEST-795 gấp lắm ạ, PH sắp khiếu nại",
      });
      expect(r1.action).toBe("confirm_ticket_action");
      expect(it$.calls.updateIssue).toHaveLength(0);
      expect(it$.calls.addComment).toHaveLength(0);
      await pipeline.run({ chatId: CHAT, message: "Bổ sung vào TECHTEST-795" });
      expect(
        it$.calls.updateIssue.some((u) => u.issueId === 5795 && u.patch.priority === "urgent"),
      ).toBe(true);
      expect(it$.calls.addComment.at(-1)?.content).toContain("Lý do: PH sắp khiếu nại");
    });

    it("gợi ý → 'Sự cố mới' thì tin vào tờ khai, không ghi ticket cũ", async () => {
      techAsked();
      pipeline = build({ ticketCommands: interp({ action: "unclear" }) });
      await pipeline.run({ chatId: CHAT, message: REPORT });
      const r2 = await pipeline.run({ chatId: CHAT, message: "Sự cố mới" });
      expect(r2.action).toBe("ask_missing_field");
      expect(r2.document.fields.symptoms?.value?.join(" ")).toContain("không làm bài được");
      expect(it$.calls.addComment).toHaveLength(0);
    });

    it("'bổ sung TECHTEST-795 …' khi đang soạn dở → xem trước + Huỷ; Huỷ thì không ghi, tờ khai giữ nguyên", async () => {
      own(795);
      await pipeline.run({ chatId: CHAT, message: REPORT });
      pipeline = build({
        ticketCommands: interp({
          action: "append",
          identifier: "TECHTEST-795",
          content: "mã đơn DH900002",
        }),
      });
      const r = await pipeline.run({
        chatId: CHAT,
        message: "bổ sung TECHTEST-795 mã đơn DH900002",
      });
      expect(r.action).toBe("confirm_ticket_action");
      expect(r.voiceText).toContain("DH900002");
      expect(r.buttons?.flat().map((b) => b.text)).toEqual(["✅ Bổ sung vào TECHTEST-795", "Huỷ"]);
      const r2 = await pipeline.run({ chatId: CHAT, message: "Huỷ" });
      expect(r2.action).toBe("canceled");
      expect(it$.calls.addComment).toHaveLength(0);
      const r3 = await pipeline.run({ chatId: CHAT, message: "Em bên Vận hành nhé" });
      expect(r3.action).toBe("confirm_summary");
    });

    it("đang chờ xác nhận mà nhắn việc khác → bỏ bản xem trước, xử lý tin mới như thường", async () => {
      own(795);
      pipeline = build({
        ticketCommands: interp({ action: "append", identifier: "TECHTEST-795", content: "x" }),
      });
      await pipeline.run({ chatId: CHAT, message: "bổ sung TECHTEST-795 x" });
      pipeline = build({ ticketCommands: interp({ action: "new" }) });
      const r = await pipeline.run({ chatId: CHAT, message: REPORT });
      expect(r.action).toBe("ask_missing_field");
      expect(it$.calls.addComment).toHaveLength(0);
    });

    it("ticket của người khác: không cho bổ sung, tra cứu chỉ thấy trạng thái", async () => {
      pipeline = build({
        ticketCommands: interp({ action: "append", identifier: "TECHTEST-777", content: "x" }),
      });
      const r = await pipeline.run({ chatId: CHAT, message: "bổ sung TECHTEST-777 x" });
      expect(r.voiceText).toContain("không phải ticket anh/chị báo");
      pipeline = build({
        ticketCommands: interp({ action: "lookup", identifier: "TECHTEST-777" }),
      });
      const l = await pipeline.run({ chatId: CHAT, message: "TECHTEST-777 tới đâu rồi" });
      expect(l.action).toBe("lookup_result");
      expect(l.voiceText).toContain("Todo");
      expect(l.voiceText).not.toContain("Ticket 777");
    });

    it("ticket có Telegram ID người báo trong mô tả cũng là của mình (ticket bot cũ)", async () => {
      pipeline = build({
        ticketCommands: interp({ action: "lookup", identifier: "TECHTEST-888" }),
      });
      const l = await pipeline.run({ chatId: "99999", message: "TECHTEST-888" });
      expect(l.voiceText).toContain("Ticket 888");
    });

    it("sửa: xem trước cũ → mới, xác nhận thì sửa thẳng + comment dấu vết", async () => {
      own(795);
      pipeline = build({
        ticketCommands: interp({
          action: "edit",
          identifier: "TECHTEST-795",
          instruction: "SĐT thành 0900000015",
        }),
        editPlanner: async () => [
          { type: "field", label: "Tài khoản HS / SĐT", value: "0900000015" },
        ],
      });
      const r = await pipeline.run({
        chatId: CHAT,
        message: "sửa TECHTEST-795 SĐT thành 0900000015",
      });
      expect(r.action).toBe("confirm_ticket_action");
      expect(r.voiceText).toContain("0900000006 → 0900000015");
      expect(it$.calls.updateIssue).toHaveLength(0);
      const r2 = await pipeline.run({ chatId: CHAT, message: "✅ Sửa TECHTEST-795" });
      expect(r2.voiceText).toContain("đã sửa");
      expect(it$.calls.updateIssue[0].patch.description).toContain(
        "- Tài khoản HS / SĐT: 0900000015",
      );
      expect(it$.calls.addComment[0].content).toContain("0900000006 → 0900000015");
    });

    it("bot vừa tạo nhầm → 'cái này bổ sung cho TECHTEST-795' → xác nhận: chép sang 795, nối trùng, huỷ bản vừa tạo", async () => {
      own(795);
      await toSummary();
      const created = await pipeline.run({ chatId: CHAT, message: "ok tạo đi" });
      expect(created.action).toBe("ticket_created");
      const newId = created.document.issueIdentifier!;
      pipeline = build({
        ticketCommands: interp({ action: "move_created", from: newId, identifier: "TECHTEST-795" }),
      });
      const r = await pipeline.run({
        chatId: CHAT,
        message: "nhầm rồi, cái này bổ sung cho TECHTEST-795",
      });
      expect(r.action).toBe("confirm_ticket_action");
      expect(r.voiceText).toContain(`huỷ ${newId}`);
      await pipeline.run({ chatId: CHAT, message: "✅ Chuyển sang TECHTEST-795" });
      expect(it$.calls.addComment.find((c) => c.issueId === 5795)?.content).toContain(
        "Nội dung ticket vừa tạo nhầm",
      );
      expect(it$.calls.linkIssues[0]).toEqual({
        a: created.document.issueId,
        b: 5795,
        kind: "duplicates",
      });
      expect(
        it$.calls.updateIssue.find((u) => u.issueId === created.document.issueId)?.patch.columnId,
      ).toBe(9);
    });

    it("tin báo trạng thái, ticket đã huỷ, hay lời 'huỷ'/'cảm ơn' → không gợi ý ghi vào ticket", async () => {
      const c = interp({ action: "append", identifier: "TECHTEST-795", content: "x" });
      pipeline = build({ ticketCommands: c });
      bindingRepo.saveMessageRoute("9101", "telegram", 5795, "TECHTEST-795", CHAT, "state");
      expect((await pipeline.run({ chatId: CHAT, message: "Đơn hàng gia hạn ạ" })).action).not.toBe(
        "confirm_ticket_action",
      );
      await pipeline.run({ chatId: CHAT, message: "huỷ" });
      await new Promise((r) => setTimeout(r, 1100));
      bindingRepo.saveMessageRoute("9102", "telegram", 5796, "TECHTEST-796", CHAT, "comment");
      expect((await pipeline.run({ chatId: CHAT, message: "Đơn hàng gia hạn ạ" })).action).not.toBe(
        "confirm_ticket_action",
      );
      await pipeline.run({ chatId: CHAT, message: "huỷ" });
      await new Promise((r) => setTimeout(r, 1100));
      techAsked();
      expect((await pipeline.run({ chatId: CHAT, message: "huỷ" })).action).not.toBe(
        "confirm_ticket_action",
      );
      expect((await pipeline.run({ chatId: CHAT, message: "cảm ơn em" })).action).not.toBe(
        "confirm_ticket_action",
      );
      expect(c.seen).toHaveLength(0);
    });

    it("không có câu hỏi kỹ thuật, không nhắc mã → không gọi bộ đọc lệnh", async () => {
      const c = interp({ action: "append", identifier: "TECHTEST-795", content: "x" });
      pipeline = build({ ticketCommands: c });
      await pipeline.run({ chatId: CHAT, message: REPORT });
      expect(c.seen).toHaveLength(0);
    });

    it("đang soạn dở tờ khai → câu trả lời cho tờ khai không bị kéo sang ticket kỹ thuật vừa hỏi", async () => {
      const c = interp({ action: "append", identifier: "TECHTEST-795", content: "x" });
      pipeline = build({ ticketCommands: c });
      await pipeline.run({ chatId: CHAT, message: REPORT });
      techAsked();
      const r2 = await pipeline.run({ chatId: CHAT, message: "Em bên Vận hành nhé" });
      expect(r2.action).toBe("confirm_summary");
      expect(c.seen).toHaveLength(0);
    });

    it("'/new' (cờ plugin) → mở sự cố mới, gác tờ khai đang dở", async () => {
      await pipeline.run({ chatId: CHAT, message: REPORT });
      bindingRepo.setChatFlag(CHAT, "force_new");
      const r = await pipeline.run({
        chatId: CHAT,
        message: "CRM không gọi được, số nào cũng báo máy bận",
      });
      expect(r.document.fields.symptoms?.value?.join(" ")).toContain("CRM không gọi được");
      expect(r.document.fields.symptoms?.value?.join(" ")).not.toContain("không làm bài được");
      expect(r.document.parkedDocId).toBeTruthy();
    });

    describe("người báo yêu cầu HỦY / ĐÓNG ticket theo quy tắc nghiệp vụ 2026-10-10 (TECH-951, TECH-999)", () => {
      const setupTechColumnsAndIssue = (opts: { columnId: number; specialistComments: number }) => {
        it$.client.listProjectColumns = async () => [
          { id: 1, name: "Backlog", stateType: "backlog", position: 0 },
          { id: 2, name: "Todo", stateType: "unstarted", position: 1 },
          { id: 3, name: "In Progress", stateType: "started", position: 2 },
          { id: 6, name: "Resolved", stateType: "completed", position: 3 },
          { id: 4, name: "Done", stateType: "completed", position: 4 },
          { id: 5, name: "Canceled", stateType: "canceled", position: 5 },
        ];
        it$.client.getIssue = async (id: number) => {
          it$.calls.getIssue.push(id);
          return {
            id,
            projectId: 1,
            sequenceNumber: id - 5000,
            identifier: `TECHTEST-${id - 5000}`,
            title: `Ticket ${id - 5000}`,
            columnId: opts.columnId,
            priority: "medium",
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
            description:
              "## Thông tin sự cố\n\n- Tài khoản HS / SĐT: 0900000006\n- Bộ phận: CSKH\n\n### Mô tả\n\n> Mô tả gốc\n\n---\n",
          };
        };
        it$.client.getIssueTimeline = async () => [
          ...Array.from({ length: opts.specialistComments }, (_, idx) => ({
            id: idx + 1,
            kind: "comment",
            actorUserId: `spec-${idx + 1}`,
            actorName: idx % 2 === 0 ? "TechLead_A" : "TechUser_I",
            body: `Phản hồi chuyên viên lần ${idx + 1}`,
          })),
          // Bình luận của bot / người báo qua bot không được tính là bình luận chuyên viên
          {
            id: 900,
            kind: "comment",
            actorUserId: "bot-1",
            actorName: "Tiểu Linh",
            body: "**SA_User*** bổ sung:\nthông tin thêm\n\n<!-- intake-bot -->",
          },
        ];
      };

      it("hủy rõ (chưa xử lý / đang xử lý dở kể cả có ≥3 comment chuyên viên / đã xử lý Resolved) → luôn chuyển Canceled (cột 5) + escapeItsaplanMarkdown", async () => {
        own(951);
        for (const [colId, specCount, msg] of [
          [2, 0, "Hủy TECHTEST-951"],
          [3, 4, "hủy TECHTEST-951 vì học sinh <P***> đã vào được rồi"],
          [6, 3, "TECHTEST-951 không cần sửa nữa ạ"],
        ] as const) {
          it$.calls.updateIssue.length = 0;
          it$.calls.addComment.length = 0;
          setupTechColumnsAndIssue({ columnId: colId, specialistComments: specCount });
          pipeline = build({
            ticketCommands: interp({
              action: "cancel_or_close",
              identifier: "TECHTEST-951",
              content: msg,
              intent: "cancel",
            }),
          });
          const preview = await pipeline.run({
            chatId: CHAT,
            message: msg,
            reporter: { name: "SA_User***" },
          });
          expect(preview.action).toBe("confirm_ticket_action");
          const btnTexts = preview.buttons?.flat().map((b) => b.text) ?? [];
          expect(btnTexts).toEqual(["✅ Hủy TECHTEST-951", "Giữ lại"]);
          expect(btnTexts).not.toContain("Huỷ");
          expect(it$.calls.updateIssue).toHaveLength(0);
          expect(it$.calls.addComment).toHaveLength(0);

          const done = await pipeline.run({
            chatId: CHAT,
            message: "✅ Hủy TECHTEST-951",
            reporter: { name: "SA_User***" },
          });
          expect(done.action).toBe("post_create_update");
          expect(it$.calls.updateIssue).toEqual([{ issueId: 5951, patch: { columnId: 5 } }]);
          expect(it$.calls.addComment).toHaveLength(1);
          expect(it$.calls.addComment[0].content).toContain("chuyển **Canceled**");
          if (msg.includes("<P***>")) {
            expect(it$.calls.addComment[0].content).toContain("&lt;P***&gt;");
          }
        }
      });

      it("nói 'đóng' khi chưa xử lý (0, 1 hoặc 2 bình luận chuyên viên, chưa ở Resolved) → chuyển Canceled (cột 5), nút [✅ Hủy ... / Giữ lại]", async () => {
        own(999);
        for (const specCount of [0, 1, 2]) {
          it$.calls.updateIssue.length = 0;
          it$.calls.addComment.length = 0;
          setupTechColumnsAndIssue({ columnId: 3, specialistComments: specCount });
          pipeline = build({
            ticketCommands: interp({
              action: "cancel_or_close",
              identifier: "TECHTEST-999",
              content: "Đóng ticket TECHTEST-999",
              intent: "close",
            }),
          });
          const preview = await pipeline.run({ chatId: CHAT, message: "Đóng ticket TECHTEST-999" });
          expect(preview.action).toBe("confirm_ticket_action");
          expect(preview.buttons?.flat().map((b) => b.text)).toEqual([
            "✅ Hủy TECHTEST-999",
            "Giữ lại",
          ]);
          const executed = await pipeline.run({ chatId: CHAT, message: "✅ Hủy TECHTEST-999" });
          expect(executed.action).toBe("post_create_update");
          expect(it$.calls.updateIssue).toEqual([{ issueId: 5999, patch: { columnId: 5 } }]);
          expect(it$.calls.addComment[0].content).toContain("chuyển **Canceled**");
        }
      });

      it("nói 'đóng' khi đã có chuyên viên xử lý (≥ 3 bình luận chuyên viên HOẶC đang ở cột Resolved) → chuyển Done (cột 4), nút [✅ Đóng ... / Giữ lại]", async () => {
        own(999);
        for (const [colId, specCount, msg] of [
          [3, 3, "Đóng ticket TECHTEST-999"],
          [3, 4, "được rồi ạ, có thể đóc ticket TECHTEST-999"],
          [6, 1, "Đóng ticket TECHTEST-999"],
        ] as const) {
          it$.calls.updateIssue.length = 0;
          it$.calls.addComment.length = 0;
          setupTechColumnsAndIssue({ columnId: colId, specialistComments: specCount });
          pipeline = build({
            ticketCommands: interp({
              action: "cancel_or_close",
              identifier: "TECHTEST-999",
              content: msg,
              intent: "close",
            }),
          });
          const preview = await pipeline.run({
            chatId: CHAT,
            message: msg,
            reporter: { name: "SC_User***" },
          });
          expect(preview.action).toBe("confirm_ticket_action");
          expect(preview.buttons?.flat().map((b) => b.text)).toEqual([
            "✅ Đóng TECHTEST-999",
            "Giữ lại",
          ]);

          const executed = await pipeline.run({
            chatId: CHAT,
            message: "✅ Đóng TECHTEST-999",
            reporter: { name: "SC_User***" },
          });
          expect(executed.action).toBe("post_create_update");
          expect(it$.calls.updateIssue).toEqual([{ issueId: 5999, patch: { columnId: 4 } }]);
          expect(it$.calls.addComment[0].content).toContain("chuyển **Done**");
          expect(it$.calls.addComment[0].content).toContain(msg);
        }
      });

      it("ticket đã ở Done (cột 4) hoặc Canceled (cột 5) → không chuyển lại, không ghi comment, trả lời lịch sự", async () => {
        own(999);
        for (const colId of [4, 5]) {
          it$.calls.updateIssue.length = 0;
          it$.calls.addComment.length = 0;
          setupTechColumnsAndIssue({ columnId: colId, specialistComments: 4 });
          pipeline = build({
            ticketCommands: interp({
              action: "cancel_or_close",
              identifier: "TECHTEST-999",
              content: "Đóng ticket TECHTEST-999",
              intent: "close",
            }),
          });
          const res = await pipeline.run({ chatId: CHAT, message: "Đóng ticket TECHTEST-999" });
          expect(res.action).toBe("post_create_update");
          expect(res.voiceText).toContain("hiện đã đóng");
          expect(it$.calls.updateIssue).toHaveLength(0);
          expect(it$.calls.addComment).toHaveLength(0);
        }
      });

      it("không phải chủ ticket (ownTicket = false) → từ chối hủy/đóng, không đổi cột, không ghi comment", async () => {
        setupTechColumnsAndIssue({ columnId: 3, specialistComments: 4 });
        pipeline = build({
          ticketCommands: interp({
            action: "cancel_or_close",
            identifier: "TECHTEST-777",
            content: "Hủy TECHTEST-777",
            intent: "cancel",
          }),
        });
        const res = await pipeline.run({ chatId: CHAT, message: "Hủy TECHTEST-777" });
        expect(res.action).toBe("post_create_update");
        expect(res.voiceText).toContain("không phải ticket anh/chị báo");
        expect(it$.calls.updateIssue).toHaveLength(0);
        expect(it$.calls.addComment).toHaveLength(0);
      });

      it("bấm nút 'Giữ lại' hoặc fallback trong proposeEdit khi ops=[] hoạt động chuẩn, và chốt chặn không bao giờ chuyển Done khi chưa đủ điều kiện", async () => {
        own(951);
        setupTechColumnsAndIssue({ columnId: 3, specialistComments: 1 });
        // Fallback khi bộ đọc lệnh trả nhầm 'edit' và editPlanner trả ops = []
        pipeline = build({
          ticketCommands: interp({
            action: "edit",
            identifier: "TECHTEST-951",
            instruction: "Hủy TECHTEST-951",
          }),
          editPlanner: async () => [],
        });
        const preview = await pipeline.run({ chatId: CHAT, message: "Hủy TECHTEST-951" });
        expect(preview.action).toBe("confirm_ticket_action");
        expect(preview.buttons?.flat().map((b) => b.text)).toEqual([
          "✅ Hủy TECHTEST-951",
          "Giữ lại",
        ]);

        const aborted = await pipeline.run({ chatId: CHAT, message: "Giữ lại" });
        expect(aborted.action).toBe("canceled");
        expect(aborted.voiceText).toContain("giữ nguyên TECHTEST-951");
        expect(it$.calls.updateIssue).toHaveLength(0);
        expect(it$.calls.addComment).toHaveLength(0);

        // Chốt chặn an toàn: lúc hiện nút đang ở Resolved (1 comment), nhưng trước khi bấm xác nhận bị kéo lại In Progress (1 comment < 3) → không được chuyển Done!
        own(999);
        setupTechColumnsAndIssue({ columnId: 6, specialistComments: 1 });
        pipeline = build({
          ticketCommands: interp({
            action: "cancel_or_close",
            identifier: "TECHTEST-999",
            content: "Đóng ticket TECHTEST-999",
            intent: "close",
          }),
        });
        const askDone = await pipeline.run({ chatId: CHAT, message: "Đóng ticket TECHTEST-999" });
        expect(askDone.buttons?.flat().map((b) => b.text)).toEqual([
          "✅ Đóng TECHTEST-999",
          "Giữ lại",
        ]);
        // Chuyên viên kéo ngược từ Resolved (6) về In Progress (3) và chỉ có 1 comment chuyên viên
        setupTechColumnsAndIssue({ columnId: 3, specialistComments: 1 });
        await pipeline.run({ chatId: CHAT, message: "✅ Đóng TECHTEST-999" });
        expect(it$.calls.updateIssue).toEqual([{ issueId: 5999, patch: { columnId: 5 } }]);
      });

      it("người khác (chat khác) không bấm hộ nút xác nhận hủy được; câu mô tả sự cố có chữ đóng/hủy khi unclear hỏi lại Bổ sung/Sự cố mới chứ không hủy vé", async () => {
        own(951);
        setupTechColumnsAndIssue({ columnId: 3, specialistComments: 2 });
        pipeline = build({
          ticketCommands: {
            interpret: async (input) =>
              input.candidates.some((c) => c.ownTicket) && input.message === "Hủy TECHTEST-951"
                ? {
                    action: "cancel_or_close",
                    identifier: "TECHTEST-951",
                    content: input.message,
                    intent: "cancel",
                  }
                : { action: "unclear" },
          },
        });
        const preview = await pipeline.run({ chatId: CHAT, message: "Hủy TECHTEST-951" });
        expect(preview.buttons?.flat().map((b) => b.text)).toEqual([
          "✅ Hủy TECHTEST-951",
          "Giữ lại",
        ]);

        // Người lạ ở chat khác gửi đúng chuỗi callback "✅ Hủy TECHTEST-951" → không thực thi hủy vé của CHAT
        const stranger = await pipeline.run({
          chatId: "telegram:88888",
          message: "✅ Hủy TECHTEST-951",
        });
        expect(stranger.action).not.toBe("confirm_ticket_action");
        expect(it$.calls.updateIssue).toHaveLength(0);
        expect(it$.calls.addComment).toHaveLength(0);

        // Huỷ bản xem trước hiện tại của CHAT rồi gửi câu mô tả sự cố có chữ đóng/hủy khi LLM trả unclear → chỉ hỏi Bổ sung / Sự cố mới
        await pipeline.run({ chatId: CHAT, message: "Giữ lại" });
        for (const bugMsg of [
          "TECHTEST-951: khi bấm đóng cửa sổ thì màn hình bị đóng băng",
          "TECHTEST-951: phụ huynh báo hủy đơn hàng của học sinh không được",
          "TECHTEST-951: chương trình đóng/hủy lớp báo lỗi",
        ]) {
          const ask = await pipeline.run({ chatId: CHAT, message: bugMsg });
          expect(ask.action).toBe("confirm_ticket_action");
          expect(ask.buttons?.flat().map((b) => b.text)).toEqual([
            "✅ Bổ sung vào TECHTEST-951",
            "Sự cố mới",
          ]);
          await pipeline.run({ chatId: CHAT, message: "Huỷ" });
        }
        expect(it$.calls.updateIssue).toHaveLength(0);
      });

      it("TECH-1218: người báo gửi ảnh trước rồi gõ 'update vào tick TECHTEST-X' (hoặc ngược lại) → bảo toàn ảnh đính kèm và không ghi câu lệnh trần thành comment", async () => {
        const img1 = "/tmp/test-attach-1218-a.jpg";
        const img2 = "/tmp/test-attach-1218-b.jpg";
        fs.writeFileSync(img1, "fake-jpeg-1218-a");
        fs.writeFileSync(img2, "fake-jpeg-1218-b");
        try {
          // Luồng 1: Tạo vé xong → người báo gửi ảnh (chưa kèm chữ) → gõ "update vào tick TECHTEST-101" → bấm xác nhận
          pipeline = build({
            ticketCommands: {
              interpret: async () => ({ action: "unclear" }),
            },
          });
          await toSummary();
          const created = await pipeline.run({ chatId: CHAT, message: "ok tạo đi" });
          expect(created.action).toBe("ticket_created");
          const createdId = created.document.issueIdentifier!;
          bindingRepo.saveBinding({
            issueId: created.document.issueId!,
            channelType: "telegram",
            chatId: CHAT,
            messageId: "1",
            identifier: createdId,
          });

          const stepImg = await pipeline.run({ chatId: CHAT, message: "", mediaPaths: [img1] });
          expect(stepImg.action).toBe("confirm_ticket_action");
          expect(stepImg.document.pendingTicketAction?.mediaPaths).toEqual([img1]);

          const stepCmd = await pipeline.run({
            chatId: CHAT,
            message: `update vào tick ${createdId}`,
            mediaPaths: [],
          });
          expect(stepCmd.action).toBe("confirm_ticket_action");
          expect(stepCmd.document.pendingTicketAction?.mediaPaths).toEqual([img1]);
          expect(stepCmd.document.pendingTicketAction?.content).toBe("");
          expect(stepCmd.voiceText).toContain("(kèm 1 ảnh/tệp)");
          expect(stepCmd.voiceText).not.toContain(`> update vào tick ${createdId}`);

          const done1 = await pipeline.run({
            chatId: CHAT,
            message: `✅ Bổ sung vào ${createdId}`,
          });
          expect(done1.action).toBe("post_create_update");
          expect(it$.calls.uploadAttachment).toContain("test-attach-1218-a.jpg");
          expect(it$.calls.addComment).toHaveLength(1);
          expect(it$.calls.addComment[0].content).toContain("test-attach-1218-a.jpg");
          expect(it$.calls.addComment[0].content).not.toContain("update vào tick");

          // Luồng 2: Lượt ảnh trước bị rớt (do gateway restart) nên chỉ nhận được "update vào tick TECHTEST-101" rỗng → hỏi xin ảnh/nội dung → lượt sau gửi ảnh → bấm xác nhận
          it$.calls.uploadAttachment.length = 0;
          it$.calls.addComment.length = 0;
          const askPayload = await pipeline.run({
            chatId: CHAT,
            message: `update vào tick ${createdId}`,
            mediaPaths: [],
          });
          expect(askPayload.action).toBe("clarify_intent");
          expect(askPayload.voiceText).toContain(
            `gửi ảnh chụp màn hình hoặc nội dung cần bổ sung vào ${createdId}`,
          );
          expect(askPayload.voiceText).not.toContain(`> update vào tick ${createdId}`);

          const withPhoto = await pipeline.run({ chatId: CHAT, message: "", mediaPaths: [img2] });
          expect(withPhoto.action).toBe("confirm_ticket_action");
          expect(withPhoto.document.pendingTicketAction?.mediaPaths).toEqual([img2]);
          expect(withPhoto.voiceText).toContain("(kèm 1 ảnh/tệp)");

          const done2 = await pipeline.run({
            chatId: CHAT,
            message: `✅ Bổ sung vào ${createdId}`,
          });
          expect(done2.action).toBe("post_create_update");
          expect(it$.calls.uploadAttachment).toContain("test-attach-1218-b.jpg");
          expect(it$.calls.addComment).toHaveLength(1);
          expect(it$.calls.addComment[0].content).toContain("test-attach-1218-b.jpg");
        } finally {
          try {
            fs.unlinkSync(img1);
            fs.unlinkSync(img2);
          } catch {}
        }
      });
    });
  });
});
