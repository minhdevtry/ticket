import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
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
import type { UrgencyRules } from "../../mcp/shared/index";
import validationRules from "../../mcp/tieulinh/domain/validation-rules.json";
import fieldRequirements from "../../mcp/tieulinh/domain/required_fields.json";
import productMapping from "../../mcp/tieulinh/domain/product_mapping.json";
import urgencyRules from "../../mcp/tieulinh/domain/urgency-rules.json";
import {
  isPersonNameOnly,
  isInvalidTitle,
  deriveFallbackTitle,
  extractBlockInfo,
  identityConflict,
  splitMultiIncidentReport,
} from "./multi-incident";

interface FakeItsaplanCalls {
  createIssue: Array<{ title?: string; description?: string; columnId?: number }>;
  updateIssue: Array<{ issueId: number; patch: unknown }>;
  addComment: Array<{ issueId: number; content: string }>;
  uploadAttachment: string[];
}

interface FakeItsaplan {
  client: ItsaplanClient;
  calls: FakeItsaplanCalls;
}

interface FakeButtons {
  sink: PendingButtonsSink;
  saved: Map<string, InlineButton[][]>;
}

function fakeItsaplan(): FakeItsaplan {
  const calls: FakeItsaplanCalls = {
    createIssue: [],
    updateIssue: [],
    addComment: [],
    uploadAttachment: [],
  };
  let seq = 1200;
  const client = {
    listProjectColumns: async () => [
      { id: 1, name: "Todo", stateType: "unstarted", position: 1 },
      { id: 9, name: "Canceled", stateType: "canceled", position: 9 },
    ],
    listCustomFields: async () => [],
    createIssue: async (_projectKey: string, payload: { title?: string; description?: string }) => {
      calls.createIssue.push(payload);
      seq++;
      return {
        id: seq,
        identifier: `TECH-${seq}`,
        title: payload.title,
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
    uploadAttachment: async (_issueId: number, filename: string) => {
      calls.uploadAttachment.push(filename);
      return { id: `att-${filename}`, url: `/attachments/${filename}/raw`, filename };
    },
  };
  return {
    client: client as unknown as ItsaplanClient,
    calls,
  };
}

function fakeButtons(): FakeButtons {
  const saved = new Map<string, InlineButton[][]>();
  const sink: PendingButtonsSink = {
    save: (chatId, rows) => saved.set(chatId, rows),
    clear: (chatId) => saved.delete(chatId),
  };
  return { sink, saved };
}

describe("W29-SPLIT Vòng 2 — Đơn vị: tên người, chốt tiêu đề, định danh có nhãn, tách khối", () => {
  it("chỉ coi là tên người khi từ ĐẦU là họ Việt và mọi từ viết hoa Unicode thật", () => {
    expect(isPersonNameOnly("Trần Thị B")).toBe(true);
    expect(isPersonNameOnly("Lê Văn Anh C")).toBe(true);
    expect(isPersonNameOnly("Nguyễn Văn P")).toBe(true);
    expect(isPersonNameOnly("Nguyễn Văn Anh D")).toBe(true);

    // Bug 1 + Bug 2 của REVIEW.md §4: chữ thường có dấu KHÔNG phải chữ hoa, và
    // cụm Title-Case không có họ người Việt thì không phải tên người.
    expect(isPersonNameOnly("Sale ạ")).toBe(false);
    expect(isPersonNameOnly("Zalo PC ạ")).toBe(false);
    expect(isPersonNameOnly("MỨC ĐỘ CAO")).toBe(false);
    expect(isPersonNameOnly("Đổi Lịch Học")).toBe(false);
    expect(isPersonNameOnly("Đồng Bộ Dữ Liệu")).toBe(false);
    expect(isPersonNameOnly("Không hiển thị bài tập ngày 13/10")).toBe(false);
    expect(isPersonNameOnly("Code: 9100002")).toBe(false);
  });

  it("chốt tiêu đề: nhận 8 tiêu đề Title-Case, từ chối tên người / mã trần / lời chào", () => {
    for (const ok of [
      "Báo Cáo Buổi Học",
      "Đổi Lịch Học",
      "Chuyển Khóa Học",
      "Đồng Bộ Dữ Liệu",
      "Sai Số Buổi Học",
      "Lỗi Hiển Thị Bài Tập",
      "Không Vào Được App",
      "Mất Kết Nối Mạng",
    ]) {
      expect(isInvalidTitle(ok)).toBe(false);
    }

    expect(isInvalidTitle("Trần Thị B")).toBe(true);
    expect(isInvalidTitle("9100002")).toBe(true);
    expect(isInvalidTitle("Code: 9100003")).toBe(true);
    expect(isInvalidTitle("Hỗ trợ em với ạ")).toBe(true);
    // Có ngữ cảnh: chỉ từ chối khi tên đó thật sự là một dòng tên trong báo cáo
    const report = "**Lê Văn Anh C**\nCode: 9100002\nHS bị lỗi buổi học";
    expect(isInvalidTitle("Lê Văn Anh C", report)).toBe(true);
    expect(isInvalidTitle("Trần Thị B", report)).toBe(false);
  });

  it("deriveFallbackTitle lấy dòng mô tả lỗi, không lấy tên học sinh (TECH-1146)", () => {
    const textMaiKhanhChi = `**Trần Thị B**
Code: 9100003
Mã học sinh: 90106

HS trước đó có 2 khóa học 48 buổi và 24 buổi đã học hết. Nay mua thêm gói 48 buổi là 120 buổi.
=> Số buổi đúng phải là 72/120 buổi nhưng hệ thống đang hiển thị là 0/96 buổi. Nhờ tech sửa lại giúp e ạ`;

    const title = deriveFallbackTitle(textMaiKhanhChi);
    expect(title).not.toContain("Trần Thị B");
    expect(title).toContain("Số buổi đúng phải là 72/120");
  });

  it("extractBlockInfo bỏ qua tham số URL, SĐT, TK/MK, mã phiếu thu; chỉ lấy định danh có nhãn", () => {
    // FP-06: cid=… trong link LMS không phải Mã khách hàng
    expect(
      extractBlockInfo("- Link: https://se-lms.example.com/module/lms/index?cid=670&id=90107")
        .customerId,
    ).toBeUndefined();
    // FP-05: mã học sinh thật vẫn lấy được, nhưng TK/MK không bị bóc thành định danh
    expect(extractBlockInfo("Code: 90000007\nMã học sinh: 900102").studentAccount).toBe("900102");
    const loginBlock = extractBlockInfo("tài khoản:\nTK: 0900000009\nMK: 0900000009");
    expect(loginBlock.studentAccount).toBeUndefined();
    expect(loginBlock.customerId).toBeUndefined();
    // FP-10: mã phiếu thu (TNX…) không thành định danh
    expect(extractBlockInfo("mã phiếu thu: TNX0123456789").customerId).toBeUndefined();
    // Mã CRM 7-10 số đứng riêng một dòng (dữ liệu thật TECH-1248/1249)
    expect(extractBlockInfo("90000002\nBộ phận QLL\ncon không hiện bài tập").customerId).toBe(
      "90000002",
    );
  });

  it("identityConflict chỉ so CÙNG LỚP định danh, và chỉ khi cả hai bên đều có", () => {
    expect(identityConflict({ customer: "90000001" }, { customer: "90000002" })).toBe("customer");
    expect(identityConflict({ customer: "90000001" }, { customer: "90000001" })).toBeUndefined();
    // Giá trị tờ khai chưa từng có thì không phải xung đột
    expect(identityConflict({}, { customer: "90000002" })).toBeUndefined();
    // Khác lớp: mã học sinh vs SĐT vs mã khách hàng không đụng nhau (FP-05)
    expect(identityConflict({ student: "900102" }, { phone: "0900000009" })).toBeUndefined();
    expect(identityConflict({ customer: "90000007" }, { student: "900102" })).toBeUndefined();
  });

  it("splitMultiIncidentReport tách đúng 2 học sinh từ văn bản thật TECH-1146", () => {
    const text = `**Lê Văn Anh C**
Code: 9100002
Mã học sinh: 900103 HS us bị lỗi buổi, chính xác có 48 buổi, nhờ tech sửa lại giúp e ạ
Quản lý lớp

**Trần Thị B**
Code: 9100003
Mã học sinh: 90106
HS trước đó có 2 khóa học 48 buổi và 24 buổi đã học hết… => Số buổi đúng phải là 72/120 buổi nhưng hệ thống đang hiển thị là 0/96 buổi. Nhờ tech sửa lại giúp e ạ`;

    const blocks = splitMultiIncidentReport(text);
    expect(blocks).not.toBeNull();
    expect(blocks?.length).toBe(2);

    expect(blocks![0].studentName).toBe("Lê Văn Anh C");
    expect(blocks![0].customerId).toBe("9100002");
    expect(blocks![0].studentAccount).toBe("900103");
    expect(blocks![0].reportingDept).toBe("Quản lý lớp");
    expect(blocks![0].text).not.toContain("Trần Thị B");

    expect(blocks![1].studentName).toBe("Trần Thị B");
    expect(blocks![1].customerId).toBe("9100003");
    expect(blocks![1].studentAccount).toBe("90106");
    expect(blocks![1].text).not.toContain("Lê Văn Anh C");
  });

  it("splitMultiIncidentReport tách đúng 2 ca độc lập từ mã CRM (TECH-1248/1249)", () => {
    const text = `90000001
Bộ phận QLL
con được đổi lịch rồi nhưng trên app vẫn hiện lịch học cũ, check giúp t

90000002
Bộ phận QLL
con không hiện bài tập ngày 13/10, check giúp em`;

    const blocks = splitMultiIncidentReport(text);
    expect(blocks).not.toBeNull();
    expect(blocks?.length).toBe(2);
    expect(blocks![0].customerId).toBe("90000001");
    expect(blocks![1].customerId).toBe("90000002");
  });

  it("splitMultiIncidentReport vẫn bắt được ca thật có 2 UID khác nhau (TECH-938)", () => {
    const text = `90000003 - 0900000003 DH900003 UID: 900017

Đơn hàng không có sản phẩm liên quan đến khóa Khoa học Tự nhiên, nhưng trên LMS lại được mở Duo KHTN 6.
90000010 - 0900000010 DH900005
UID: 9100005`;

    const blocks = splitMultiIncidentReport(text);
    expect(blocks).not.toBeNull();
    expect(blocks?.length).toBe(2);
  });

  it("danh sách học sinh VÍ DỤ dưới một sự cố hệ thống KHÔNG bị tách (TECH-462, TECH-603)", () => {
    const tech462 = `Anh/chị kiểm tra giúp em HS có ca học hôm nay bị đẩy hết về trạng thái Hoàn thành ở Màn Xử lý ClassIn ạ.

=> Vdu: Hoàng Văn F (SID: 900013)

Phạm Thị E (SID: 900012)

HS chưa hoàn thành Classin nhưng lại đẩy khỏi màn xác nhận => đẩy về Hoàn thành`;
    expect(splitMultiIncidentReport(tech462)).toBeNull();

    const tech603 = `Bài test đầu vào của lớp 2 Toán CLC bị lỗi, đầu HS hiển thị tháng 12 năm 2025.
CM đã kiểm tra 1 số HS gần đây đều thấy vậy, dưới đây là 2 HS làm bài gần nhất:

- SĐT: 0900000011, link test: https://vuihoc.vn/kiem-tra-dau-vao-ket-qua-32489628

- SĐT: 0900000012, link test: https://vuihoc.vn/kiem-tra-dau-vao-ket-qua-32492494`;
    expect(splitMultiIncidentReport(tech603)).toBeNull();
  });

  it("cùng một học sinh nhắc lại ở 2 đoạn (mã KH ở đoạn này, thiếu ở đoạn kia) KHÔNG bị tách (TECH-560)", () => {
    const tech560 = `**Phạm Văn O**

Code: 9100004

Mã học sinh: 900101

HS đăng ký khóa học 1 năm có 100 buổi thôi, khóa cũ HS đã học hết, số buổi đúng của HS là 48/148 buổi.

Thông tin trên ảnh: học sinh Phạm Văn O, Code: 9100004, mã học sinh: 900101.`;
    expect(splitMultiIncidentReport(tech560)).toBeNull();
  });
});

describe("W29-SPLIT — Tích hợp Pipeline", () => {
  let db: Database;
  let repo: IntakeDocumentRepository;
  let bindingRepo: TicketBindingRepository;
  let draftRepo: DraftSessionRepository;
  let it$: FakeItsaplan;
  let btn: FakeButtons;
  let pipeline: IntakeStepPipeline;
  const tmpFiles: string[] = [];

  beforeEach(() => {
    const dbPath = `/tmp/test-split-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
    tmpFiles.push(dbPath);
    db = new Database(dbPath);
    applySchema(db);
    repo = new IntakeDocumentRepository(db);
    bindingRepo = new TicketBindingRepository(db);
    draftRepo = new DraftSessionRepository(db);
    it$ = fakeItsaplan();
    btn = fakeButtons();
    const dummyImages = [
      "/tmp/image-schedule-old.png",
      "/tmp/image-homework-missing.png",
      "/tmp/student-nhi.png",
      "/tmp/student-chi.png",
      "/tmp/single-unclear-image.png",
    ];
    for (const p of dummyImages) {
      fs.writeFileSync(p, "dummy image content");
      tmpFiles.push(p);
    }

    pipeline = new IntakeStepPipeline({
      repo,
      extractor: new FieldExtractor(),
      itsaplan: it$.client,
      itsaplanBaseUrl: "https://mock.itsaplan.test",
      projectKey: "TECH",
      validationRules: validationRules as unknown as IntakePipelineOptions["validationRules"],
      fieldRequirements: fieldRequirements as unknown as IntakePipelineOptions["fieldRequirements"],
      productMapping: productMapping as unknown as IntakePipelineOptions["productMapping"],
      urgencyRules: urgencyRules as UrgencyRules,
      bindingRepo,
      draftRepo,
      buttons: btn.sink,
      minConfirmDelayMs: 0,
    });
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {}
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  });

  const CHAT = "telegram:1000000010";

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
    expect(doc1Before?.fields.customerId?.value).toBe("90000001");
    expect(doc1Before?.fields.mediaPaths?.value).toEqual(["/tmp/image-schedule-old.png"]);
    expect(doc1Before?.fields.rawText?.value).not.toContain("90000002");

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
    const createdTicket2 = await pipeline.run({
      chatId: CHAT,
      message: "đúng rồi",
    });

    expect(createdTicket2.action).toBe("ticket_created");
    expect(it$.calls.createIssue.length).toBe(1);
    const created2 = it$.calls.createIssue[0];
    // Ticket 2 CHỈ có nội dung của 90000002, KHÔNG có 90000001
    expect(created2.description).toContain("90000002");
    expect(created2.description).not.toContain("90000001");
    expect(created2.description).toContain("Mã khách hàng: 90000002");
    expect(it$.calls.uploadAttachment).toEqual(["image-homework-missing.png"]);

    // Bot nhắc về sự cố 1 còn đang chờ
    expect(createdTicket2.voiceText).toContain("đang chờ xác nhận");

    // Lượt 5: Tiếp tục tờ khai 1 (bấm nút "Xem lại sự cố ...")
    const resumed1 = await pipeline.run({
      chatId: CHAT,
      message: "Tiếp tục sự cố đang chờ",
    });

    expect(resumed1.status).toBe("ready_for_confirmation");
    expect(resumed1.document.fields.customerId?.value).toBe("90000001");
    expect(resumed1.document.fields.mediaPaths?.value).toEqual(["/tmp/image-schedule-old.png"]);

    // Lượt 6: Xác nhận tạo ticket 1 (TECH-1249)
    it$.calls.uploadAttachment.length = 0;
    const createdTicket1 = await pipeline.run({
      chatId: CHAT,
      message: "đúng rồi",
    });

    expect(createdTicket1.action).toBe("ticket_created");
    expect(it$.calls.createIssue.length).toBe(2);
    const created1 = it$.calls.createIssue[1];
    // Ticket 1 CHỈ có nội dung của 90000001, KHÔNG có 90000002
    expect(created1.description).toContain("90000001");
    expect(created1.description).not.toContain("90000002");
    expect(created1.description).toContain("Mã khách hàng: 90000001");
    expect(it$.calls.uploadAttachment).toEqual(["image-schedule-old.png"]);
  });

  it("TECH-1146: một tin nhắn chứa 2 học sinh — hỏi tách ticket, khi tách mỗi ticket chỉ có đúng học sinh của mình", async () => {
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
    const res3 = await pipeline.run({
      chatId: CHAT,
      message: "đúng rồi",
    });

    // Bug 8: gói tin vẫn phải là `ticket_created` KÈM `issue` của ticket vừa tạo —
    // phần tóm tắt sự cố kế tiếp chỉ nối thêm vào nội dung hiển thị.
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
    const res4 = await pipeline.run({
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
    const MULTI_STUDENT_MSG = `**Lê Văn Anh C**
Code: 9100002
Mã học sinh: 900103 HS us bị lỗi buổi
Quản lý lớp
app gia sư vui học

**Trần Thị B**
Code: 9100003
Mã học sinh: 90106
HS trước đó có 2 khóa học 48 buổi nhưng hệ thống đang hiển thị 0 buổi
app gia sư vui học`;
    // Chỉ gửi 1 ảnh cho 2 học sinh -> không thể biết ảnh của bạn nào
    await pipeline.run({
      chatId: CHAT,
      message: MULTI_STUDENT_MSG,
      mediaPaths: ["/tmp/single-unclear-image.png"],
    });

    const splitRes = await pipeline.run({
      chatId: CHAT,
      message: "Tách 2 ticket",
    });

    // Cả 2 đều nhận ảnh và có cờ mediaAmbiguous
    expect(splitRes.document.mediaAmbiguous).toBe(true);
    expect(splitRes.document.fields.mediaPaths?.value).toEqual(["/tmp/single-unclear-image.png"]);

    await pipeline.run({ chatId: CHAT, message: "đúng rồi" });

    const issue1 = it$.calls.createIssue[0];
    expect(issue1.description).toContain("Ảnh đính kèm chung cho các sự cố");
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

  it('BUG 5 — người báo gõ "không tách" thì GỘP, tuyệt đối không tách', async () => {
    const asked = await pipeline.run({ chatId: CHAT, message: MULTI_STUDENT_MSG });
    expect(asked.action).toBe("ask_split_or_merge");

    const merged = await pipeline.run({ chatId: CHAT, message: "không tách" });
    expect(merged.docId).toBe(asked.docId);
    expect(merged.action).toBe("confirm_summary");
    expect(repo.getByDocId(asked.docId)?.pendingSplit).toBeUndefined();

    const created = await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
    expect(created.action).toBe("ticket_created");
    // Đúng 1 ticket, chứa cả hai học sinh
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
app gia sư vui học

**Lê Văn C**
Code: 3333333
Mã học sinh: 200003
HS C hiển thị sai lịch học
app gia sư vui học`;
    const asked = await pipeline.run({ chatId: CHAT, message: THREE_STUDENTS });
    expect(asked.action).toBe("ask_split_or_merge");

    const split = await pipeline.run({ chatId: CHAT, message: "Tách 3 ticket" });
    expect(split.action).toBe("confirm_summary");
    expect(repo.getByDocId(split.docId)?.pendingSplitQueue?.length).toBe(2);

    const createdA = await pipeline.run({ chatId: CHAT, message: "đúng rồi" });
    expect(createdA.action).toBe("ticket_created");
    // Tờ khai B đang mở vẫn còn 1 khối trong hàng đợi
    expect(repo.getByDocId(createdA.docId)?.pendingSplitQueue?.length).toBe(1);

    const canceledB = await pipeline.run({ chatId: CHAT, message: "thôi huỷ đi em" });
    expect(canceledB.action).toBe("canceled");
    // Không còn khối mồ côi nào trong DB
    const orphans = repo.getByDocId(createdA.docId);
    expect(orphans?.pendingSplit).toBeUndefined();
    expect(orphans?.pendingSplitQueue).toBeUndefined();
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
});
