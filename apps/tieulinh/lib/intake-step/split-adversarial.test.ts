/**
 * W29-SPLIT — Đánh giá đối kháng qua PIPELINE THẬT (Vòng 3 — deploy/tieulinh-fixes-20261019b).
 * Port từ research/data/work/split_review/round2_review/split_adversarial.test.ts.
 * Bao gồm các ca kiểm chứng P1, P2, P3, P4 từ REVIEW2 §5.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../storage/schema";
import { IntakeDocumentRepository } from "../intake-document/repository";
import { TicketBindingRepository } from "../storage/binding-repository";
import { DraftSessionRepository } from "../storage/session-repository";
import { FieldExtractor } from "./extractor";
import { IntakeStepPipeline, type IntakePipelineOptions } from "./pipeline";
import type { ItsaplanClient, ItsaplanIssue } from "../itsaplan/client";
import type { IntakeDocument } from "../intake-document/types";
import type { IntakePacket } from "../intake-document/packet";
import { isInvalidTitle, deriveFallbackTitle, splitMultiIncidentReport } from "./multi-incident";
import validationRules from "../../mcp/tieulinh/domain/validation-rules.json";
import fieldRequirements from "../../mcp/tieulinh/domain/required_fields.json";
import productMapping from "../../mcp/tieulinh/domain/product_mapping.json";
import urgencyRules from "../../mcp/tieulinh/domain/urgency-rules.json";

interface FakeItsaplan {
  client: ItsaplanClient;
  calls: {
    createIssue: Array<Record<string, unknown>>;
    updateIssue: Array<{ issueId: number; patch: unknown }>;
    addComment: Array<{ issueId: number; content: string }>;
    uploadAttachment: Array<{ issueId: number; filename: string }>;
  };
}

function fakeItsaplan(): FakeItsaplan {
  const calls: FakeItsaplan["calls"] = {
    createIssue: [],
    updateIssue: [],
    addComment: [],
    uploadAttachment: [],
  };
  let seq = 2000;
  const client = {
    listProjectColumns: async () => [
      { id: 1, name: "Todo", stateType: "unstarted", position: 1 },
      { id: 9, name: "Canceled", stateType: "canceled", position: 9 },
    ],
    listCustomFields: async () => [],
    createIssue: async (_pk: string, payload: Record<string, unknown>) => {
      calls.createIssue.push(payload);
      seq++;
      return {
        id: seq,
        identifier: `TECHTEST-${seq}`,
        title: payload.title as string | undefined,
        sequenceNumber: seq,
      } as unknown as ItsaplanIssue;
    },
    updateIssue: async (issueId: number, patch: unknown) => {
      calls.updateIssue.push({ issueId, patch });
      return {};
    },
    addComment: async (issueId: number, content: string) => {
      calls.addComment.push({ issueId, content });
      return { id: 1, body: content };
    },
    getIssueByNumber: async (_pk: string, n: number) =>
      ({
        id: 5000 + n,
        identifier: `TECHTEST-${n}`,
        title: `Ticket ${n}`,
        description: "",
      }) as unknown as ItsaplanIssue,
    getIssue: async (id: number) =>
      ({
        id,
        identifier: `TECHTEST-${id}`,
        title: `Ticket ${id}`,
        columnId: 1,
        description: "",
      }) as unknown as ItsaplanIssue,
    uploadAttachment: async (issueId: number, filename: string) => {
      calls.uploadAttachment.push({ issueId, filename });
      return { id: `att-${filename}`, url: `/attachments/${filename}/raw`, filename };
    },
    getIssueTimeline: async () => [],
    linkIssues: async () => ({ id: 1 }),
  };
  return { client: client as unknown as ItsaplanClient, calls };
}

function buildPipeline(
  repo: IntakeDocumentRepository,
  bindingRepo: TicketBindingRepository,
  draftRepo: DraftSessionRepository,
  it$: FakeItsaplan,
) {
  return new IntakeStepPipeline({
    repo,
    extractor: new FieldExtractor(),
    itsaplan: it$.client,
    itsaplanBaseUrl: "https://mock.itsaplan.test",
    projectKey: "TECHTEST",
    validationRules: validationRules as unknown as IntakePipelineOptions["validationRules"],
    fieldRequirements: fieldRequirements as unknown as IntakePipelineOptions["fieldRequirements"],
    productMapping: productMapping as unknown as IntakePipelineOptions["productMapping"],
    urgencyRules: urgencyRules as unknown as IntakePipelineOptions["urgencyRules"],
    bindingRepo,
    draftRepo,
    buttons: { save: () => {}, clear: () => {} },
    minConfirmDelayMs: 0,
  });
}

const TWO_STUDENTS = `Bạn A
Code: 9100004
Mã học sinh: 900101
HS không vào được lớp học ạ

Bạn B
Code: 90000001
Mã học sinh: 900104
App Duo bị treo khi làm bài tập`;

describe("W29-SPLIT pipeline đối kháng (Vòng 3)", () => {
  let repo: IntakeDocumentRepository;
  let bindingRepo: TicketBindingRepository;
  let draftRepo: DraftSessionRepository;
  let it$: FakeItsaplan;
  let pipeline: IntakeStepPipeline;
  let chat = 9000;

  beforeEach(() => {
    const db = new Database(":memory:");
    applySchema(db);
    repo = new IntakeDocumentRepository(db);
    bindingRepo = new TicketBindingRepository(db);
    draftRepo = new DraftSessionRepository(db);
    it$ = fakeItsaplan();
    pipeline = buildPipeline(repo, bindingRepo, draftRepo, it$);
    chat++;
  });

  async function toSplitQuestion(
    report = TWO_STUDENTS,
    extra: { message?: string; mediaPaths?: string[] } = {},
  ) {
    const r = await pipeline.run({ chatId: String(chat), message: report, ...extra });
    return r;
  }

  async function confirmTo_ticket(doc: any) {
    let r = await pipeline.run({ chatId: doc.chatId, message: "Quản lý lớp" });
    for (let i = 0; i < 4 && r.action !== "confirm_summary" && r.action !== "ticket_created"; i++) {
      r = await pipeline.run({ chatId: doc.chatId, message: "Quản lý lớp" });
    }
    if (r.action === "confirm_summary")
      r = await pipeline.run({ chatId: doc.chatId, message: "đúng rồi" });
    return r;
  }

  it("A. trạng thái chuẩn: hỏi tách → 'Tách 2 ticket' → 2 ticket, nội dung/ảnh không lẫn", async () => {
    const r1 = await toSplitQuestion(TWO_STUDENTS, { mediaPaths: ["/tmp/a.png", "/tmp/b.png"] });
    expect(r1.action).toBe("ask_split_or_merge");
    expect(String(r1.voiceText)).toContain("2 học sinh/sự cố");

    const r2 = await pipeline.run({ chatId: String(chat), message: "Tách 2 ticket" });
    expect(r2.document.pendingSplit).toBeUndefined();
    expect(r2.document.pendingSplitQueue?.length).toBe(1);

    // xác nhận ticket 1
    let r3 = await confirmTo_ticket(r2.document);
    for (let i = 0; i < 5 && it$.calls.createIssue.length < 1; i++)
      r3 = await pipeline.run({ chatId: String(chat), message: "đúng rồi" });
    expect(it$.calls.createIssue.length).toBe(1);

    // xác nhận ticket 2 (doc mới đang chờ xác nhận)
    let r4 = await pipeline.run({ chatId: String(chat), message: "đúng rồi" });
    for (
      let i = 0;
      i < 4 && it$.calls.createIssue.length < 2 && r4.action !== "ticket_created";
      i++
    )
      r4 = await pipeline.run({ chatId: String(chat), message: "đúng rồi" });
    expect(it$.calls.createIssue.length).toBe(2);
  });

  it("B. phủ định/hủy/gộp tại câu hỏi tách (Bug 5/6, P2: thôi/khỏi = merge)", async () => {
    const cases: Array<[string, "split" | "merge" | "other"]> = [
      ["không tách", "merge"],
      ["ko tách", "merge"],
      ["không cần tách ra đâu", "merge"],
      ["gộp 1 ticket", "merge"],
      ["để chung 1 ticket nhé", "merge"],
      ["không", "merge"],
      ["ừ", "split"],
      ["ok", "split"],
      ["tách", "split"],
      ["Tách 2 ticket", "split"],
      // P2 (Vòng 3): "thôi" / "khỏi" trần = KHÔNG tách (gộp 1 ticket giữ trọn nội dung)
      ["thôi", "merge"],
      ["khỏi", "merge"],
      ["thôi ạ", "merge"],
      ["khỏi nhé", "merge"],
    ];
    for (const [msg, expectKind] of cases) {
      const db = new Database(":memory:");
      applySchema(db);
      const r0 = new IntakeDocumentRepository(db);
      const b0 = new TicketBindingRepository(db);
      const d0 = new DraftSessionRepository(db);
      const it0 = fakeItsaplan();
      const p = buildPipeline(r0, b0, d0, it0);
      const c = String(20000 + cases.indexOf([msg, expectKind] as any));
      await p.run({ chatId: c, message: TWO_STUDENTS });
      const second = await p.run({ chatId: c, message: msg });
      const kind = second.document.pendingSplitQueue?.length
        ? "split"
        : second.document.pendingSplit
          ? "other"
          : "merge";
      expect(kind).toBe(expectKind);
      expect(second.document.pendingSplit).toBeUndefined();
    }
  });

  it("C. P1 (Blocker): câu trả lời KHÔNG rõ ý giữ nguyên báo cáo + ảnh, hỏi lại 1 lần, vẫn không rõ thì gộp 1 ticket", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const r0 = new IntakeDocumentRepository(db);
    const it0 = fakeItsaplan();
    const p = buildPipeline(
      r0,
      new TicketBindingRepository(db),
      new DraftSessionRepository(db),
      it0,
    );
    const c = "30001";
    await p.run({ chatId: c, message: TWO_STUDENTS, mediaPaths: ["/tmp/ev.png"] });

    // Lần 1 trả lời không rõ: "sao cũng được em" -> PHẢI HỎI LẠI 1 LẦN, KHÔNG ĐÁNH RƠI BÁO CÁO
    const r2 = await p.run({ chatId: c, message: "sao cũng được em" });
    expect(r2.action).toBe("ask_split_or_merge");
    expect(r2.document.pendingSplit).toBeDefined();
    expect(r2.document.pendingSplit!.clarifyCount).toBe(1);
    expect(r2.document.pendingSplit!.mediaPaths).toContain("/tmp/ev.png");
    expect(r2.document.pendingSplit!.extraText).toContain("sao cũng được em");

    // Lần 2 vẫn không rõ: "tuỳ em nhé" -> MẶC ĐỊNH GỘP 1 TICKET, GIỮ TRỌN NỘI DUNG VÀ ẢNH
    const r3 = await p.run({ chatId: c, message: "tuỳ em nhé" });
    expect(r3.document.pendingSplit).toBeUndefined();
    const raw = r3.document.fields.rawText?.value ?? "";
    const media = r3.document.fields.mediaPaths?.value ?? [];

    // Cả 2 học sinh và các lời trả lời đều được giữ trong rawText
    expect(raw).toContain("900101");
    expect(raw).toContain("900104");
    expect(raw).toContain("sao cũng được em");
    expect(raw).toContain("tuỳ em nhé");
    // Toàn bộ ảnh được giữ nguyên
    expect(media).toContain("/tmp/ev.png");
  });

  it("D. dán lại y nguyên báo cáo 2 HS khi đang ở câu hỏi tách", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const r0 = new IntakeDocumentRepository(db);
    const it0 = fakeItsaplan();
    const p = buildPipeline(
      r0,
      new TicketBindingRepository(db),
      new DraftSessionRepository(db),
      it0,
    );
    const c = "30002";
    await p.run({ chatId: c, message: TWO_STUDENTS });
    const r2 = await p.run({ chatId: c, message: TWO_STUDENTS });
    // Báo cáo được giữ nguyên, hỏi lại một lần, không nhân bản khối
    expect(r2.action).toBe("ask_split_or_merge");
    expect(r2.document.pendingSplit).toBeDefined();
    expect(r2.document.pendingSplit!.blocks.length).toBe(2);
  });

  it("E. trả lời bằng MỘT báo cáo mới có định danh KHÁC (HS thứ 3) khi đang hỏi tách", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const r0 = new IntakeDocumentRepository(db);
    const it0 = fakeItsaplan();
    const p = buildPipeline(
      r0,
      new TicketBindingRepository(db),
      new DraftSessionRepository(db),
      it0,
    );
    const c = "30003";
    await p.run({ chatId: c, message: TWO_STUDENTS });
    const r2 = await p.run({
      chatId: c,
      message: "Bạn C\nCode: 55555555\nMã học sinh: 777777\nHS khác bị lỗi điểm số ạ",
    });
    // Không bị crash hay mất dữ liệu: hỏi lại câu tách
    expect(r2.action).toBe("ask_split_or_merge");
    expect(r2.document.pendingSplit).toBeDefined();
    expect(r2.document.pendingSplit!.extraText?.some((t: string) => t.includes("777777"))).toBe(
      true,
    );
  });

  it("F. không tách được — các dạng KHÔNG phải 2 sự cố độc lập", async () => {
    const negs: Array<[string, string]> = [
      [
        "SĐT + Mã HS cùng 1 HS",
        "**Phạm Văn O**\nCode: 9100004\nMã học sinh: 900101\nHS còn buổi học nhưng vào làm bài báo lỗi ạ\n\ntài khoản:\nTK: 0900000005\nMK: 0900000008",
      ],
      [
        "danh sách VD: dưới 1 lỗi hệ thống",
        "Anh/chị kiểm tra giúp em HS có ca học hôm nay bị đẩy hết về Hoàn thành ạ.\n=> Vdu: Hoàng Văn F (SID: 900013)\nPhạm Thị E (SID: 900012)",
      ],
      ["2 mã đơn DH", "DH900003 bị lỗi không vào được lớp ạ, cả DH900005 cũng lỗi tương tự ạ"],
      [
        "mã phiếu thu TNX",
        "Mã phiếu thu TNX123456789 bị sai số tiền ạ, không hiện trên care nữa ạ",
      ],
      [
        "URL có cid=",
        "Link khóa gốc https://se-lms.example.com/module/lms/courseSectionModule/index?cid=670&id=90107 bị lỗi không hiển thị Loại đề ạ\nLink khác ?cid=1035&id=90108 cũng lỗi ạ",
      ],
      [
        "Code: 123 hai lần cùng giá trị",
        "Code: 12345678 bị lỗi không vào được lớp ạ\n\nCode: 12345678 lại bị lỗi điểm không hiện ạ",
      ],
      [
        "2 HS trong 1 báo cáo hệ thống có VD:",
        "Lỗi hiển thị điểm toàn hệ thống ạ, các HS bị: Hoàng Văn F (SID: 900013) và Phạm Thị E (SID: 900012) ạ",
      ],
    ];
    for (const [name, text] of negs) {
      const db = new Database(":memory:");
      applySchema(db);
      const r0 = new IntakeDocumentRepository(db);
      const it0 = fakeItsaplan();
      const p = buildPipeline(
        r0,
        new TicketBindingRepository(db),
        new DraftSessionRepository(db),
        it0,
      );
      const c = `3100${negs.indexOf([name, text] as any) + 1}`;
      const r = await p.run({ chatId: c, message: text });
      const direct = splitMultiIncidentReport(text);
      expect(r.action).not.toBe("ask_split_or_merge");
      expect(direct).toBeNull();
    }
  });

  it("G. P3: gói tin sau khi tạo ticket 1 khi còn hàng đợi rõ ràng contract (createdIssue + nextDraft)", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const r0 = new IntakeDocumentRepository(db);
    const it0 = fakeItsaplan();
    const p = buildPipeline(
      r0,
      new TicketBindingRepository(db),
      new DraftSessionRepository(db),
      it0,
    );
    const c = "30004";
    await p.run({ chatId: c, message: TWO_STUDENTS });
    await p.run({ chatId: c, message: "Tách 2 ticket" });
    let r = await p.run({ chatId: c, message: "Quản lý lớp" });
    if (r.action !== "confirm_summary") r = await p.run({ chatId: c, message: "Quản lý lớp" });
    const created = await p.run({ chatId: c, message: "đúng rồi" });

    expect(created.action).toBe("ticket_created");
    expect((created.issue as any)?.identifier).toBe("TECHTEST-2001");
    // P3 (Vòng 3): xác nhận rõ createdIssue (ticket vừa tạo) và nextDraft (tờ khai kế tiếp)
    expect((created as any).createdIssue?.identifier).toBe("TECHTEST-2001");
    expect((created as any).nextDraft?.docId).toBeDefined();
    expect((created as any).nextDraft?.action).toBe("confirm_summary");
    expect((created as any).nextDraft?.status).toBe("ready_for_confirmation");
    expect(created.document.docId).toBe((created as any).nextDraft.docId);
  });

  it("H. P1 (tin chỉ có ảnh / noop): ảnh được gộp vào báo cáo đã park và hỏi lại; noop không mất dữ liệu", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const r0 = new IntakeDocumentRepository(db);
    const it0 = fakeItsaplan();
    const p = buildPipeline(
      r0,
      new TicketBindingRepository(db),
      new DraftSessionRepository(db),
      it0,
    );
    const c = "30005";
    await p.run({ chatId: c, message: TWO_STUDENTS, mediaPaths: ["/tmp/photo1.png"] });

    // Gửi tin CHỈ CÓ ẢNH: thêm ảnh vào pendingSplit.mediaPaths và hỏi lại
    const rPhoto = await p.run({ chatId: c, message: "", mediaPaths: ["/tmp/photo2.png"] });
    expect(rPhoto.action).toBe("ask_split_or_merge");
    expect(rPhoto.document.pendingSplit).toBeDefined();
    expect(rPhoto.document.pendingSplit!.mediaPaths).toContain("/tmp/photo1.png");
    expect(rPhoto.document.pendingSplit!.mediaPaths).toContain("/tmp/photo2.png");

    // "noop" tới khi đang hỏi tách: hỏi lại, không mất pendingSplit
    const cNoop = "30005b";
    await p.run({ chatId: cNoop, message: TWO_STUDENTS });
    const rNoop = await p.run({ chatId: cNoop, message: "noop" });
    expect(rNoop.action).toBe("ask_split_or_merge");
    expect(rNoop.document.pendingSplit).toBeDefined();
  });

  it("I. TTL: im lặng quá lâu ở câu hỏi tách", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const r0 = new IntakeDocumentRepository(db);
    const it0 = fakeItsaplan();
    let clock = 1_700_000_000_000;
    const p = new IntakeStepPipeline({
      repo: r0,
      extractor: new FieldExtractor(),
      itsaplan: it0.client,
      itsaplanBaseUrl: "https://mock.itsaplan.test",
      projectKey: "TECHTEST",
      validationRules,
      fieldRequirements,
      productMapping,
      urgencyRules,
      bindingRepo: new TicketBindingRepository(db),
      draftRepo: new DraftSessionRepository(db),
      buttons: { save: () => {}, clear: () => {} },
      minConfirmDelayMs: 0,
      now: () => clock,
    } as any);
    const c = "30006";
    await p.run({ chatId: c, message: TWO_STUDENTS });
    clock += 1000 * 60 * 60 * 24 * 30; // 30 ngày
    const r = await p.run({ chatId: c, message: "chào em" });
    expect(r.action).toBe("clarify_intent");
  });

  it("J. P4: cụm mức ưu tiên và nhãn phòng ban/hệ thống trần KHÔNG BAO GIỜ là tiêu đề", () => {
    // Cụm mức ưu tiên trần
    expect(isInvalidTitle("MỨC ĐỘ CAO")).toBe(true);
    expect(isInvalidTitle("gấp")).toBe(true);
    expect(isInvalidTitle("cao")).toBe(true);
    expect(isInvalidTitle("thấp")).toBe(true);

    // Nhãn phòng ban / hệ thống trần
    expect(isInvalidTitle("Sale ạ")).toBe(true);
    expect(isInvalidTitle("Quản lý lớp")).toBe(true);
    expect(isInvalidTitle("CSKH")).toBe(true);
    expect(isInvalidTitle("LMS_Vuihoc")).toBe(true);
    expect(isInvalidTitle("CARE_Vuihoc")).toBe(true);

    // Dòng mô tả sự cố thực sự vẫn hợp lệ
    expect(isInvalidTitle("Lỗi không hiển thị bài tập môn Toán")).toBe(false);
    expect(isInvalidTitle("Đổi Lịch Học")).toBe(false);

    // Fallback title bỏ qua câu trả lời trần và lấy dòng mô tả lỗi
    const textWithBareDept = `Sale ạ\nHS không vào được app Duo làm bài tập ạ`;
    const fallback = deriveFallbackTitle(textWithBareDept);
    expect(fallback).not.toBe("Sale ạ");
    expect(fallback).toContain("không vào được app Duo");
  });
});
