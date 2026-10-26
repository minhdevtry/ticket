/**
 * Port các ca test tách báo cáo nhiều sự cố từ legacy `apps/tieulinh-legacy/lib/intake-step/multi-incident.test.ts`
 * (RFC 0002 PR 9, issue #23).
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { intakeApplySchema, SqliteDraftRepository } from "../draft";
import { SqliteChannelBindingStore } from "../create";
import { makeCopyCatalog } from "../copy-catalog";
import { tieuLinhCopy } from "../../../examples/tieulinh/copy";
import { TEST_COPY } from "./test-copy.fixture";
import { createCatalog } from "../gate/catalog";
import { FieldExtractor } from "../extractor/llm-extractor";
import { IntakeEngine } from "./engine";
import { legacyActionForOutcome } from "./action-map";
import { URGENCY } from "./engine-harness.fixture";
import { MIN_CONFIRM_DELAY_MS } from "../confirm";
import type { TrackerPort, TrackerIssue, CopyKey, FieldExtractorPort } from "../ports";
import type { InlineButton } from "../gate/types";

interface FakeItsaplanCalls {
  createIssue: Array<{ title?: string; description?: string; columnId?: number }>;
  updateIssue: Array<{ issueId: number; patch: unknown }>;
  addComment: Array<{ issueId: number; content: string }>;
  uploadAttachment: string[];
}

interface FakeItsaplan {
  calls: FakeItsaplanCalls;
  tracker: TrackerPort;
}

function fakeItsaplan(): FakeItsaplan {
  const calls: FakeItsaplanCalls = {
    createIssue: [],
    updateIssue: [],
    addComment: [],
    uploadAttachment: [],
  };
  let seq = 1200;
  const tracker: TrackerPort = {
    async createIssue(payload: { title?: string; description?: string }): Promise<TrackerIssue> {
      calls.createIssue.push(payload);
      seq++;
      return {
        id: seq,
        identifier: `TECH-${seq}`,
        title: payload.title ?? "",
        url: `https://mock.itsaplan.test/TECH-${seq}`,
      };
    },
    async getIssue(id: number) {
      return { id, identifier: `TECH-${id}`, title: `Ticket ${id}` };
    },
    async addComment(issueId: number, content: string) {
      calls.addComment.push({ issueId, content });
    },
    async attach(_issueId: number, _description: string, mediaPaths: string[]) {
      for (const m of mediaPaths) {
        const filename = m.split("/").pop() ?? m;
        calls.uploadAttachment.push(filename);
      }
      return mediaPaths.length;
    },
    async findByIdentifier() {
      return null;
    },
  };
  return { calls, tracker };
}

const testCatalog = createCatalog({
  fields: {
    nhanh: {
      tech: {
        ten: "Tech",
        truong_mo_dau: "reportingDept",
        recap: ["reportingDept"],
        truong: {
          reportingDept: {
            bat_buoc: true,
            kieu: "text",
            duoc_hoi: true,
            nhan: "Bộ phận",
            hoi: "Bộ phận nào?",
            role: "department",
          },
        },
      },
    },
  },
});

interface PipelineDocFields {
  customerId?: { value?: string };
  studentAccount?: { value?: string };
  reportingDept?: { value?: string };
  title?: { value?: string };
  rawText?: { value?: string };
  mediaPaths?: { value?: string[] };
  priority?: { value?: string };
}

interface PipelineResult {
  action: string;
  outcome: string;
  status: string;
  docId: string;
  document: {
    docId: string;
    chatId: string;
    status?: string;
    mediaAmbiguous?: boolean;
    pendingSplit?: unknown;
    pendingSplitQueue?: unknown[];
    reporter?: { name?: string; username?: string; nameCode?: string };
    fields: PipelineDocFields;
  };
  voiceText: string;
  displayMarkdown: string;
  buttons: InlineButton[][];
  issue?: { id: number; identifier: string; url?: string };
  createdIssue?: { id: number; identifier: string; title?: string; url?: string };
  nextDraft?: { docId: string; outcome?: string; status?: string; action?: string };
}

interface PipelineTester {
  run(input: {
    chatId: string;
    message: string;
    mediaPaths?: string[];
    reporter?: { name?: string; username?: string; nameCode?: string };
    forceNew?: boolean;
  }): Promise<PipelineResult>;
}

function buildPipeline(
  db: Database,
  repo: SqliteDraftRepository,
  it$: FakeItsaplan,
  clockRef: { now: number },
  options?: {
    copy?: Record<CopyKey, string>;
    extractor?: FieldExtractorPort;
  },
): PipelineTester {
  const bindingRepo = new SqliteChannelBindingStore(db);
  const extractor =
    options?.extractor ??
    new FieldExtractor({
      domain: {
        reportingDepts: ["Quản lý lớp", "Sale", "CSKH", "Vận hành"],
      },
    });

  const engine = new IntakeEngine({
    tracker: it$.tracker,
    drafts: repo,
    bindings: bindingRepo,
    copy: makeCopyCatalog(options?.copy ?? tieuLinhCopy),
    clock: {
      now: () => clockRef.now,
    },
    catalog: testCatalog,
    variant: "tech",
    urgencyRules: URGENCY,
    extractor,
    departmentField: "reportingDept",
  });

  return {
    async run(input: {
      chatId: string;
      message: string;
      mediaPaths?: string[];
      reporter?: { name?: string; username?: string; nameCode?: string };
      forceNew?: boolean;
    }) {
      const out = await engine.step(input);
      const activeDocId = out.docId ?? repo.getLatestByChatId(input.chatId)?.docId ?? "";
      const latestDraft =
        (activeDocId ? repo.getByDocId(activeDocId) : null) ?? repo.getLatestByChatId(input.chatId);
      const action = legacyActionForOutcome(out.outcome) ?? out.outcome;
      return {
        action,
        outcome: out.outcome,
        status: latestDraft?.status ?? "",
        docId: activeDocId,
        document: {
          docId: activeDocId,
          chatId: input.chatId,
          status: latestDraft?.status,
          mediaAmbiguous: latestDraft?.mediaAmbiguous,
          pendingSplit: latestDraft?.pendingSplit,
          pendingSplitQueue: latestDraft?.pendingSplitQueue,
          reporter: latestDraft?.reporter,
          fields: {
            customerId: { value: latestDraft?.record?.values?.customerId },
            studentAccount: { value: latestDraft?.record?.values?.studentAccount },
            reportingDept: { value: latestDraft?.record?.values?.reportingDept },
            title: { value: latestDraft?.ticket.title },
            rawText: { value: latestDraft?.ticket.rawText },
            mediaPaths: { value: latestDraft?.ticket.mediaPaths },
            priority: { value: latestDraft?.ticket.priority },
          },
        },
        voiceText: out.messages.map((m) => m.text).join(" "),
        displayMarkdown: out.messages.map((m) => m.text).join("\n\n"),
        buttons: out.messages.flatMap((m) => m.buttons ?? []),
        issue: out.issue,
        createdIssue: out.createdIssue,
        nextDraft: out.nextDraft,
      };
    },
  };
}

describe("W29-SPLIT — Tích hợp Pipeline (Port từ legacy multi-incident.test.ts)", () => {
  let db: Database;
  let repo: SqliteDraftRepository;
  let it$: FakeItsaplan;
  let pipeline: PipelineTester;
  let clockRef: { now: number };
  const CHAT = "telegram:1000000010";

  beforeEach(() => {
    db = new Database(":memory:");
    intakeApplySchema(db);
    repo = new SqliteDraftRepository(db);
    it$ = fakeItsaplan();
    clockRef = { now: 1_000_000 };
    pipeline = buildPipeline(db, repo, it$, clockRef);
  });

  it("TECH-1248 + TECH-1249: gửi 2 sự cố ở 2 lượt khác nhau — tách thành 2 ticket riêng, nội dung và ảnh không bị lẫn", async () => {
    // Lượt 1: Báo lịch học cũ của KH 90000001 kèm ảnh 1
    const t1 = await pipeline.run({
      chatId: CHAT,
      message: `90000001\nBộ phận QLL\ncon được đổi lịch rồi nhưng trên app vẫn hiện lịch học cũ, check giúp t\napp gia sư vui học của môn toán gia sư, app làm bài tập về nhà nhé\nLịch mới: 14:00 - 16:00 (T7) 14:00 - 16:00 (CN)\nLịch cũ: t4 CN`,
      mediaPaths: ["/tmp/image-schedule-old.png"],
    });

    expect(t1.status).toBe("ready_for_confirmation");
    expect(t1.document.fields.customerId?.value).toBe("90000001");
    expect(t1.document.fields.mediaPaths?.value).toEqual(["/tmp/image-schedule-old.png"]);

    // Lượt 2: Trong khi tờ khai đang chờ xác nhận, gửi tiếp sự cố KHÁC của KH 90000002 kèm ảnh 2
    const t2 = await pipeline.run({
      chatId: CHAT,
      message: `90000002\nBộ phận QLL\napp gia sư vui học\ncon không hiện bài tập ngày 13/10, check giúp em`,
      mediaPaths: ["/tmp/image-homework-missing.png"],
    });

    // Pipeline PHẢI phát hiện định danh xung đột (90000002 vs 90000001), KHÔNG gộp lặng lẽ
    expect(t2.action).toBe("ask_new_or_continue");
    expect(t2.buttons).toBeDefined();
    expect(t2.buttons?.length).toBeGreaterThan(0);
    // Tờ khai 1 vẫn giữ NGUYÊN ảnh 1 và mã 90000001 — không bị lẫn ảnh 2 hay text 2 vào
    const doc1Before = repo.getByDocId(t1.docId);
    expect(doc1Before?.record?.values?.customerId).toBe("90000001");
    expect(doc1Before?.ticket.mediaPaths).toEqual(["/tmp/image-schedule-old.png"]);
    expect(doc1Before?.ticket.rawText).not.toContain("90000002");

    // Lượt 3: Người báo chọn "Sự cố mới"
    const t3 = await pipeline.run({
      chatId: CHAT,
      message: "Sự cố mới",
    });

    // Mở tờ khai 2 cho KH 90000002 với ĐÚNG ảnh 2 và mã 90000002
    expect(t3.status).toBe("ready_for_confirmation");
    expect(t3.document.fields.customerId?.value).toBe("90000002");
    expect(t3.document.fields.mediaPaths?.value).toEqual(["/tmp/image-homework-missing.png"]);
    expect(t3.document.fields.rawText?.value).toContain("90000002");
    expect(t3.document.fields.rawText?.value).not.toContain("90000001");

    // Lượt 4: Xác nhận tạo ticket cho sự cố 2 (TECH-1248 thật sự)
    clockRef.now += MIN_CONFIRM_DELAY_MS + 1000;
    const createdTicket2 = await pipeline.run({
      chatId: CHAT,
      message: "đúng rồi",
    });

    expect(createdTicket2.action).toBe("ticket_created");
    expect(it$.calls.createIssue.length).toBe(1);
    const created2 = it$.calls.createIssue[0];
    expect(created2.description).toContain("90000002");
    expect(created2.description).not.toContain("90000001");
    expect(it$.calls.uploadAttachment).toEqual(["image-homework-missing.png"]);

    // Bot nhắc về sự cố 1 còn đang chờ
    expect(createdTicket2.voiceText).toContain("đang chờ xác nhận");

    // Lượt 5: Tiếp tục tờ khai 1 (bấm nút "Tiếp tục sự cố đang chờ")
    const resumed1 = await pipeline.run({
      chatId: CHAT,
      message: "Tiếp tục sự cố đang chờ",
    });

    expect(resumed1.status).toBe("ready_for_confirmation");
    expect(resumed1.document.fields.customerId?.value).toBe("90000001");
    expect(resumed1.document.fields.mediaPaths?.value).toEqual(["/tmp/image-schedule-old.png"]);

    // Lượt 6: Xác nhận tạo ticket 1 (TECH-1249)
    it$.calls.uploadAttachment.length = 0;
    clockRef.now += MIN_CONFIRM_DELAY_MS + 1000;
    const createdTicket1 = await pipeline.run({
      chatId: CHAT,
      message: "đúng rồi",
    });

    expect(createdTicket1.action).toBe("ticket_created");
    expect(it$.calls.createIssue.length).toBe(2);
    const created1 = it$.calls.createIssue[1];
    expect(created1.description).toContain("90000001");
    expect(created1.description).not.toContain("90000002");
    expect(it$.calls.uploadAttachment).toEqual(["image-schedule-old.png"]);
  });

  const MULTI_STUDENT_MSG = `**Lê Văn Anh C**
Code: 9100002
Mã học sinh: 900103 HS us bị lỗi buổi, chính xác có 48 buổi, nhờ tech sửa lại giúp e ạ
Quản lý lớp
app gia sư vui học

**Trần Thị B**
Code: 9100003
Mã học sinh: 90106
HS trước đó có 2 khóa học 48 buổi và 24 buổi đã học hết… => Số buổi đúng phải là 72/120 buổi nhưng hệ thống đang hiển thị là 0/96 buổi. Nhờ tech sửa lại giúp e ạ
app gia sư vui học`;

  it("TECH-1146: một tin nhắn chứa 2 học sinh — hỏi tách ticket, khi tách mỗi ticket chỉ có đúng học sinh của mình", async () => {
    // Lượt 1: Gửi cả 2 học sinh kèm 2 ảnh
    const res1 = await pipeline.run({
      chatId: CHAT,
      message: MULTI_STUDENT_MSG,
      mediaPaths: ["/tmp/student-nhi.png", "/tmp/student-chi.png"],
    });

    // Bot nhận diện 2 học sinh và hỏi tách ticket
    expect(res1.action).toBe("ask_split_or_merge");
    expect(res1.voiceText).toContain("2 học sinh");
    expect(res1.voiceText).toContain("tách 2 ticket");

    // Lượt 2: Người báo chọn "Tách 2 ticket"
    const res2 = await pipeline.run({
      chatId: CHAT,
      message: "Tách 2 ticket",
    });

    // Tờ khai 1 (Lê Văn Anh C) sẵn sàng xác nhận
    expect(res2.action).toBe("confirm_summary");
    // Tiêu đề KHÔNG ĐƯỢC là "Lê Văn Anh C" mà phải là tóm tắt lỗi
    expect(res2.document.fields.title?.value).not.toBe("Lê Văn Anh C");
    expect(res2.document.fields.title?.value).toContain("lỗi buổi");
    expect(res2.document.fields.customerId?.value).toBe("9100002");
    expect(res2.document.fields.studentAccount?.value).toBe("900103");
    // Bug 10 Vòng 2: KHÔNG chia ảnh mù theo số khối — cả hai ảnh đi cùng cả hai ticket
    // và cờ mediaAmbiguous bật lên để mô tả nói rõ "ảnh đính kèm chung".
    expect(res2.document.mediaAmbiguous).toBe(true);
    expect(res2.document.fields.mediaPaths?.value).toEqual([
      "/tmp/student-nhi.png",
      "/tmp/student-chi.png",
    ]);
    expect(res2.document.fields.rawText?.value).toContain("Lê Văn Anh C");
    expect(res2.document.fields.rawText?.value).not.toContain("Trần Thị B");

    // Lượt 3: Xác nhận tạo ticket 1
    clockRef.now += MIN_CONFIRM_DELAY_MS + 1000;
    const res3 = await pipeline.run({
      chatId: CHAT,
      message: "đúng rồi",
    });

    // Bug 8: gói tin vẫn phải là `ticket_created` KÈM `issue` của ticket vừa tạo
    expect(res3.action).toBe("ticket_created");
    expect(res3.issue?.identifier).toBe("TECH-1201");
    expect(it$.calls.createIssue.length).toBe(1);
    const issue1 = it$.calls.createIssue[0];
    expect(issue1.title).not.toBe("Lê Văn Anh C");
    expect(issue1.description).toContain("9100002");
    expect(issue1.description).not.toContain("9100003");
    expect(issue1.description).not.toContain("Trần Thị B");

    // Bot thông báo đã tạo ticket 1 và hiện tóm tắt cho Trần Thị B
    expect(res3.voiceText).toContain("tiếp tục tạo ticket");
    expect(res3.document.fields.title?.value).not.toBe("Trần Thị B");
    expect(res3.document.fields.title?.value).toContain("Số buổi đúng");
    expect(res3.document.fields.customerId?.value).toBe("9100003");
    expect(res3.document.fields.studentAccount?.value).toBe("90106");
    expect(res3.document.fields.mediaPaths?.value).toEqual([
      "/tmp/student-nhi.png",
      "/tmp/student-chi.png",
    ]);
    expect(res3.document.fields.rawText?.value).toContain("Trần Thị B");
    expect(res3.document.fields.rawText?.value).not.toContain("Lê Văn Anh C");

    // Lượt 4: Xác nhận tạo ticket 2
    clockRef.now += MIN_CONFIRM_DELAY_MS + 1000;
    await pipeline.run({
      chatId: CHAT,
      message: "đúng rồi",
    });

    expect(it$.calls.createIssue.length).toBe(2);
    const issue2 = it$.calls.createIssue[1];
    expect(issue2.title).not.toBe("Trần Thị B");
    expect(issue2.description).toContain("9100003");
    expect(issue2.description).not.toContain("9100002");
    expect(issue2.description).not.toContain("Lê Văn Anh C");
  });

  it("TECH-1146 (chọn gộp 1 ticket): tiêu đề tóm tắt cả 2 học sinh, KHÔNG BAO GIỜ lấy tên người làm tiêu đề", async () => {
    await pipeline.run({
      chatId: CHAT,
      message: MULTI_STUDENT_MSG,
    });

    // Người báo chọn Gộp 1 ticket
    const resMerged = await pipeline.run({
      chatId: CHAT,
      message: "Gộp 1 ticket",
    });

    expect(resMerged.document.fields.title?.value).not.toBe("Trần Thị B");
    expect(resMerged.document.fields.title?.value).not.toBe("Lê Văn Anh C");
    expect(resMerged.document.fields.title?.value?.length).toBeGreaterThan(10);

    clockRef.now += MIN_CONFIRM_DELAY_MS + 1000;
    const resCreated = await pipeline.run({
      chatId: CHAT,
      message: "đúng rồi",
    });

    expect(resCreated.action).toBe("ticket_created");
    expect(it$.calls.createIssue.length).toBe(1);
    const issue = it$.calls.createIssue[0];
    expect(issue.title).not.toBe("Trần Thị B");
    expect(issue.title).not.toBe("Lê Văn Anh C");
  });

  it("ảnh đính kèm không phân biệt được thuộc học sinh nào: đính kèm cả hai và có ghi chú rõ ràng", async () => {
    const MSG = `**Lê Văn Anh C**
Code: 9100002
Mã học sinh: 900103 HS us bị lỗi buổi
Quản lý lớp
app gia sư vui học

**Trần Thị B**
Code: 9100003
Mã học sinh: 90106
HS trước đó có 2 khóa học 48 buổi nhưng hệ thống đang hiển thị 0 buổi
app gia sư vui học`;

    await pipeline.run({
      chatId: CHAT,
      message: MSG,
      mediaPaths: ["/tmp/single-unclear-image.png"],
    });

    const splitRes = await pipeline.run({
      chatId: CHAT,
      message: "Tách 2 ticket",
    });

    // Cả 2 đều nhận ảnh và có cờ mediaAmbiguous
    expect(splitRes.document.mediaAmbiguous).toBe(true);
    expect(splitRes.document.fields.mediaPaths?.value).toEqual(["/tmp/single-unclear-image.png"]);

    clockRef.now += MIN_CONFIRM_DELAY_MS + 1000;
    await pipeline.run({ chatId: CHAT, message: "đúng rồi" });

    const issue1 = it$.calls.createIssue[0];
    expect(issue1.description).toContain("Ảnh đính kèm chung cho các sự cố");
  });

  it('BUG 5 — người báo gõ "không tách" thì GỘP, tuyệt đối không tách', async () => {
    const asked = await pipeline.run({ chatId: CHAT, message: MULTI_STUDENT_MSG });
    expect(asked.action).toBe("ask_split_or_merge");

    const merged = await pipeline.run({ chatId: CHAT, message: "không tách" });
    expect(merged.docId).toBe(asked.docId);
    expect(merged.action).toBe("confirm_summary");
    expect(repo.getByDocId(asked.docId)?.pendingSplit).toBeUndefined();

    clockRef.now += MIN_CONFIRM_DELAY_MS + 1000;
    const created = await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
    expect(created.action).toBe("ticket_created");
    expect(it$.calls.createIssue.length).toBe(1);
    expect(it$.calls.createIssue[0].description).toContain("9100002");
    expect(it$.calls.createIssue[0].description).toContain("9100003");
  });

  it("BUG 6/7 — đang hỏi tách mà người báo huỷ: thoát câu hỏi, xoá luôn hàng đợi tách", async () => {
    const THREE_STUDENTS = `**Nguyễn Văn A**
Code: 1111111
Mã học sinh: 200001
HS A bị sai số buổi học trên app
Quản lý lớp
app gia sư vui học

**Trần Thị B**
Code: 2222222
Mã học sinh: 200002
HS B không hiện bài tập về nhà
Quản lý lớp
app gia sư vui học

**Lê Văn C**
Code: 3333333
Mã học sinh: 200003
HS C hiển thị sai lịch học
Quản lý lớp
app gia sư vui học`;

    const asked = await pipeline.run({ chatId: CHAT, message: THREE_STUDENTS });
    expect(asked.action).toBe("ask_split_or_merge");

    const split = await pipeline.run({ chatId: CHAT, message: "Tách 3 ticket" });
    expect(split.action).toBe("confirm_summary");
    expect(repo.getByDocId(split.docId)?.pendingSplitQueue?.length).toBe(2);

    clockRef.now += MIN_CONFIRM_DELAY_MS + 1000;
    const createdA = await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
    expect(createdA.action).toBe("ticket_created");
    expect(repo.getByDocId(createdA.docId)?.pendingSplitQueue?.length).toBe(1);

    const canceledB = await pipeline.run({ chatId: CHAT, message: "thôi huỷ đi em" });
    expect(canceledB.action).toBe("canceled");
    const orphans = repo.getByDocId(createdA.docId);
    expect(orphans?.pendingSplit).toBeUndefined();
    expect(orphans?.pendingSplitQueue?.length ?? 0).toBe(0);
  });

  it("BUG 6 (Vòng 3 — P1): đang hỏi tách mà người báo nhắn câu khác: hỏi lại 1 lần, vẫn không rõ thì gộp 1 ticket không mất nội dung", async () => {
    const asked = await pipeline.run({ chatId: CHAT, message: MULTI_STUDENT_MSG });
    expect(asked.action).toBe("ask_split_or_merge");

    // Lần 1: Nhắn việc khác -> hỏi lại 1 lần, KHÔNG đánh rơi báo cáo đã park (P1)
    const reask = await pipeline.run({
      chatId: CHAT,
      message: "App Duo bị lỗi đăng nhập, em không vào được lớp học",
    });
    expect(reask.action).toBe("ask_split_or_merge");
    expect(repo.getByDocId(asked.docId)?.pendingSplit).toBeDefined();

    // Lần 2: Vẫn chưa chọn tách/gộp -> mặc định gộp 1 ticket, giữ TRỌN cả báo cáo gốc và tin mới
    const defaulted = await pipeline.run({
      chatId: CHAT,
      message: "nhờ tech kiểm tra giúp",
    });
    expect(defaulted.action).not.toBe("ask_split_or_merge");
    expect(repo.getByDocId(asked.docId)?.pendingSplit).toBeUndefined();
    const raw = defaulted.document.fields.rawText?.value ?? "";
    expect(raw).toContain("900103");
    expect(raw).toContain("90106");
    expect(raw).toContain("App Duo bị lỗi đăng nhập");
    expect(raw).toContain("nhờ tech kiểm tra giúp");
  });

  it("khẳng định chuỗi copy split.question* và split.next_ticket_notice* giữ nguyên từng byte tiếng Việt cũ", () => {
    const copy = makeCopyCatalog(tieuLinhCopy);

    // 1. split.question (có summary tên/mã)
    const qWithNames = copy.text("split.question", {
      count: 2,
      summary: "Lê Văn Anh C, Trần Thị B",
    });
    expect(qWithNames).toBe(
      "Dạ em thấy tin nhắn có 2 học sinh/sự cố khác nhau (Lê Văn Anh C, Trần Thị B) — em tách 2 ticket nhé?",
    );

    // 2. split.question_no_names (không có tên/mã thô)
    const qNoNames = copy.text("split.question_no_names", { count: 2 });
    expect(qNoNames).toBe(
      "Dạ em thấy tin nhắn có 2 học sinh/sự cố khác nhau (2 sự cố) — em tách 2 ticket nhé?",
    );

    // 3. split.next_ticket_notice_student (có tên học sinh)
    const nextWithStudent = copy.text("split.next_ticket_notice_student", {
      identifier: "TECH-100",
      studentName: "Trần Thị B",
    });
    expect(nextWithStudent).toBe(
      "Bây giờ em tiếp tục tạo ticket cho sự cố tiếp theo (học sinh Trần Thị B) nhé ạ!",
    );

    // 4. split.next_ticket_notice (không có tên học sinh)
    const nextNoStudent = copy.text("split.next_ticket_notice", {
      identifier: "TECH-100",
    });
    expect(nextNoStudent).toBe("Bây giờ em tiếp tục tạo ticket cho sự cố tiếp theo nhé ạ!");
  });

  it("pipeline: thông báo tiếp theo chọn đúng khoá khi khối kế tiếp không có studentName", async () => {
    const NO_NAME_SECOND_BLOCK = `**Lê Văn Anh C**
Code: 9100002
Mã học sinh: 900103
Lỗi buổi học
Quản lý lớp

Code: 9100003
Mã học sinh: 900104
Lỗi tài khoản không đăng nhập được
Quản lý lớp`;

    const asked = await pipeline.run({
      chatId: "chat-no-student-2",
      message: NO_NAME_SECOND_BLOCK,
    });
    expect(asked.action).toBe("ask_split_or_merge");

    const split = await pipeline.run({ chatId: "chat-no-student-2", message: "Tách 2 ticket" });
    expect(split.action).toBe("confirm_summary");

    clockRef.now += MIN_CONFIRM_DELAY_MS + 1000;
    const created = await pipeline.run({ chatId: "chat-no-student-2", message: "đúng rồi" });
    expect(created.action).toBe("ticket_created");
    // Khối thứ hai không có studentName -> thông báo tiếp theo dùng split.next_ticket_notice (không chứa "học sinh")
    expect(created.voiceText).toContain(
      "Bây giờ em tiếp tục tạo ticket cho sự cố tiếp theo nhé ạ!",
    );
    expect(created.voiceText).not.toContain("học sinh");
  });
  it('bấm nút callbackData thật ("Split N tickets" / "Keep 1 ticket") hoạt động chính xác với bản copy tiếng Anh (TEST_COPY), tờ khai không rơi chữ', async () => {
    const enPipeline = buildPipeline(db, repo, it$, clockRef, { copy: TEST_COPY });
    // 1. Nhánh bấm nút tách
    const r1 = await enPipeline.run({
      chatId: "en-chat-split",
      message: MULTI_STUDENT_MSG,
    });
    expect(r1.outcome).toBe("split_question");
    const splitButton = r1.buttons[0]?.[0];
    const mergeButton = r1.buttons[0]?.[1];
    expect(splitButton?.text).toBe("Split 2 tickets");
    expect(splitButton?.callbackData).toBe("Split 2 tickets");
    expect(mergeButton?.text).toBe("Keep 1 ticket");
    expect(mergeButton?.callbackData).toBe("Keep 1 ticket");

    // Bấm nút split thật bằng callbackData của nút
    const rSplit = await enPipeline.run({
      chatId: "en-chat-split",
      message: splitButton?.callbackData ?? "",
    });
    // Không bị đứng yên ở split_question
    expect(rSplit.outcome).not.toBe("split_question");
    expect(rSplit.document.pendingSplit).toBeUndefined();
    expect(rSplit.document.pendingSplitQueue?.length).toBe(1);
    // Tờ khai CÓ chứa chữ của khối 1 (không rơi chữ, rawText không rỗng)
    const rawFirst = rSplit.document.fields.rawText?.value ?? "";
    expect(rawFirst.length).toBeGreaterThan(0);
    expect(rawFirst).toContain("Lê Văn Anh C");
    expect(rawFirst).toContain("900103");

    // 2. Nhánh bấm nút gộp
    const r2 = await enPipeline.run({
      chatId: "en-chat-merge",
      message: MULTI_STUDENT_MSG,
    });
    expect(r2.outcome).toBe("split_question");
    const rMerge = await enPipeline.run({
      chatId: "en-chat-merge",
      message: mergeButton?.callbackData ?? "",
    });
    expect(rMerge.outcome).not.toBe("split_question");
    expect(rMerge.document.pendingSplit).toBeUndefined();
    expect(rMerge.document.pendingSplitQueue?.length ?? 0).toBe(0);
    const rawMerged = rMerge.document.fields.rawText?.value ?? "";
    expect(rawMerged).toContain("Lê Văn Anh C");
    expect(rawMerged).toContain("Trần Thị B");
  });

  it('bấm nút callbackData thật ("Tách 2 ticket" / "Gộp 1 ticket") hoạt động chính xác với bản copy tiếng Việt (tieuLinhCopy), tờ khai không rơi chữ', async () => {
    // 1. Nhánh bấm nút tách
    const r1 = await pipeline.run({
      chatId: "vi-chat-split",
      message: MULTI_STUDENT_MSG,
    });
    expect(r1.action).toBe("ask_split_or_merge");
    const splitButton = r1.buttons[0]?.[0];
    const mergeButton = r1.buttons[0]?.[1];
    expect(splitButton?.callbackData).toBe("Tách 2 ticket");
    expect(mergeButton?.callbackData).toBe("Gộp 1 ticket");

    const rSplit = await pipeline.run({
      chatId: "vi-chat-split",
      message: splitButton?.callbackData ?? "",
    });
    expect(rSplit.action).not.toBe("ask_split_or_merge");
    expect(rSplit.document.pendingSplit).toBeUndefined();
    expect(rSplit.document.pendingSplitQueue?.length).toBe(1);
    const rawFirst = rSplit.document.fields.rawText?.value ?? "";
    expect(rawFirst.length).toBeGreaterThan(0);
    expect(rawFirst).toContain("Lê Văn Anh C");

    // 2. Nhánh bấm nút gộp
    await pipeline.run({
      chatId: "vi-chat-merge",
      message: MULTI_STUDENT_MSG,
    });
    const rMerge = await pipeline.run({
      chatId: "vi-chat-merge",
      message: mergeButton?.callbackData ?? "",
    });
    expect(rMerge.action).not.toBe("ask_split_or_merge");
    expect(rMerge.document.pendingSplit).toBeUndefined();
    const rawMerged = rMerge.document.fields.rawText?.value ?? "";
    expect(rawMerged).toContain("Lê Văn Anh C");
    expect(rawMerged).toContain("Trần Thị B");
  });

  it("thứ tự tách-trước-huỷ: tin nhắn tách được dù extractor đoán intent cancel vẫn hỏi tách (khớp legacy)", async () => {
    const cancelExtractor: FieldExtractorPort = {
      async extract(input) {
        return {
          userIntent: "cancel",
          ticket: { rawText: input.text },
          symptoms: [],
        };
      },
    };

    const cancelPipeline = buildPipeline(db, repo, it$, clockRef, { extractor: cancelExtractor });
    const res = await cancelPipeline.run({
      chatId: "chat-split-over-cancel",
      message: MULTI_STUDENT_MSG,
    });
    // Kiểm tra tách trước: vẫn phải hỏi tách ticket, không bị huỷ thẳng
    expect(res.action).toBe("ask_split_or_merge");
    expect(res.status).not.toBe("canceled");
    expect(res.document.pendingSplit).toBeDefined();
  });

  it("nhánh huỷ không kích hoạt khi tin huỷ có kèm ảnh (mediaPaths.length > 0) (khớp legacy)", async () => {
    const cancelExtractor: FieldExtractorPort = {
      async extract(input) {
        return {
          userIntent: "cancel",
          ticket: { rawText: input.text },
          symptoms: [],
        };
      },
    };

    const cancelPipeline = buildPipeline(db, repo, it$, clockRef, { extractor: cancelExtractor });
    const res = await cancelPipeline.run({
      chatId: "chat-cancel-with-media",
      message: "thôi huỷ đi em",
      mediaPaths: ["/tmp/evidence.png"],
    });
    // Có ảnh đính kèm: không bị coi là huỷ thẳng (khớp legacy pipeline.ts:773)
    expect(res.status).not.toBe("canceled");
    expect(res.action).not.toBe("canceled");
  });

  it("câu hỏi tách cho khối không có tên học sinh/khách hàng dùng 'sự cố' (sự cố, sự cố) khớp legacy", async () => {
    const NO_NAME_BLOCKS = `UID: 900017
lỗi buổi học nè bạn ơi

UID: 900018
lỗi tài khoản nè bạn ơi`;
    const res = await pipeline.run({
      chatId: "chat-nameless-split",
      message: NO_NAME_BLOCKS,
    });
    expect(res.action).toBe("ask_split_or_merge");
    expect(res.voiceText).toContain("(sự cố, sự cố)");
  });

  it("định danh người báo KHÔNG rơi khi gác câu hỏi tách (khớp legacy pipeline.ts:737-741)", async () => {
    // Legacy gộp `input.reporter` vào tờ khai ở ĐẦU `collect()` — tức là trước cả
    // nhánh gác câu hỏi tách. Core gộp muộn (ở `mergeIntoDraft`) nên tờ khai đang
    // gác mất người báo, và ticket sinh ra từ tờ khai đó không biết báo lại ai.
    const res = await pipeline.run({
      chatId: "chat-reporter-split",
      message: MULTI_STUDENT_MSG,
      reporter: { username: "anh_te", name: "Anh Tè" },
    });
    expect(res.action).toBe("ask_split_or_merge");
    expect(res.document.reporter?.username).toBe("anh_te");
    expect(res.document.reporter?.name).toBe("Anh Tè");

    // Đầu-cuối: sau khi tách và tạo ticket, binding phải còn người báo.
    await pipeline.run({ chatId: "chat-reporter-split", message: "Tách 2 ticket" });
    clockRef.now += MIN_CONFIRM_DELAY_MS + 1000;
    const created = await pipeline.run({ chatId: "chat-reporter-split", message: "đúng rồi" });
    expect(created.action).toBe("ticket_created");
    const rows = db.query("SELECT reporter_username FROM ticket_bindings").all() as Array<{
      reporter_username: string | null;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.reporter_username).toBe("anh_te");
  });

  it("/new KHÔNG bị nuốt khi đang treo câu hỏi tách (khớp legacy pipeline.ts:537-548)", async () => {
    // Legacy kiểm cờ `/new` TRƯỚC khi vào `collect()` (nơi mới kiểm
    // `pendingSplit`), nên `/new` lúc đang treo câu hỏi tách vẫn mở sự cố mới.
    // PR 9 đưa nhánh `pendingSplit` lên trước nhánh `/new` → cờ bị nuốt, người
    // báo bấm `/new` vẫn bị hỏi lại "tách hay gộp" (ADR-0008, A12).
    const res1 = await pipeline.run({ chatId: "chat-forcenew-split", message: MULTI_STUDENT_MSG });
    expect(res1.action).toBe("ask_split_or_merge");
    const docIdBefore = res1.docId;

    const res2 = await pipeline.run({
      chatId: "chat-forcenew-split",
      message: "sự cố mới của em, app không mở được",
      forceNew: true,
    });
    // Tờ khai mới đã mở — không còn treo câu hỏi tách.
    expect(res2.docId).not.toBe(docIdBefore);
    expect(res2.document.pendingSplit).toBeUndefined();
  });

  it("tờ khai đang treo câu hỏi tách GIỮ được câu hỏi khi phục hồi (khớp legacy pipeline.ts:1505-1511)", async () => {
    // Legacy `resumeParkedDraft` gọi `collect()` — mà `collect()` kiểm
    // `pendingSplit` ở ĐẦU — nên câu hỏi tách được hỏi lại, không mất.
    const res1 = await pipeline.run({ chatId: "chat-resume-split", message: MULTI_STUDENT_MSG });
    expect(res1.action).toBe("ask_split_or_merge");
    const parkedDocId = res1.docId;

    // `/new` gác tờ khai đang treo lại, rồi tạo ticket sự cố mới.
    await pipeline.run({
      chatId: "chat-resume-split",
      message: "90000009\nQuản lý lớp\nsự cố mới của em, app không mở được",
      forceNew: true,
    });
    clockRef.now += MIN_CONFIRM_DELAY_MS + 1000;
    const created = await pipeline.run({
      chatId: "chat-resume-split",
      message: tieuLinhCopy["button.confirm_create"],
    });
    expect(created.action).toBe("ticket_created");

    // Bấm nút phục hồi → câu hỏi tách của tờ khai cũ phải còn.
    const resumed = await pipeline.run({
      chatId: "chat-resume-split",
      message: tieuLinhCopy["button.resume_parked"],
    });
    expect(resumed.action).toBe("ask_split_or_merge");
    expect(resumed.voiceText).toContain("tách 2 ticket");
    expect(resumed.docId).toBe(parkedDocId);
  });
});
