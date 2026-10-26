/**
 * Port 18 ca test luồng hậu tạo ticket từ legacy:
 * - 12 ca flow từ `apps/tieulinh-legacy/lib/intake-step/pipeline.flow.test.ts`
 * - 6 ca notify từ `apps/tieulinh-legacy/lib/intake-step/pipeline.notify-supplement.test.ts`
 * (RFC 0002 PR 10, issue #24).
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { intakeApplySchema, SqliteDraftRepository, newDraft } from "../draft";
import { SqliteChannelBindingStore } from "../create";
import { makeCopyCatalog } from "../copy-catalog";
import { tieuLinhCopy } from "../../../examples/tieulinh/copy";
import { createCatalog } from "../gate/catalog";
import { FieldExtractor } from "../extractor/llm-extractor";
import { IntakeEngine } from "./engine";
import { legacyActionForOutcome } from "./action-map";
import { URGENCY, FakeClock } from "./engine-harness.fixture";
import { MIN_CONFIRM_DELAY_MS } from "../confirm";
import type { TrackerPort, TrackerIssue, TicketCommand, Priority } from "../ports";
import type { ProjectAssignee } from "../../itsaplan";

interface FakeItsaplanCalls {
  createIssue: Array<{
    title?: string;
    description?: string;
    columnId?: number;
    priority?: Priority;
  }>;
  updateIssue: Array<{ issueId: number; patch: { priority?: Priority; title?: string } }>;
  addComment: Array<{ issueId: number; content: string }>;
  uploadAttachment: string[];
}

interface FakeItsaplan {
  calls: FakeItsaplanCalls;
  tracker: TrackerPort;
  issues: Map<number, TrackerIssue>;
  closedIssues: Set<number>;
  assignees: ProjectAssignee[];
  timelines: Map<number, unknown[]>;
}

function fakeItsaplan(): FakeItsaplan {
  const calls: FakeItsaplanCalls = {
    createIssue: [],
    updateIssue: [],
    addComment: [],
    uploadAttachment: [],
  };
  const issues = new Map<number, TrackerIssue>();
  const closedIssues = new Set<number>();
  let seq = 100;

  const itObj: FakeItsaplan = {
    calls,
    tracker: null as unknown as TrackerPort,
    issues,
    closedIssues,
    assignees: [],
    timelines: new Map(),
  };

  itObj.tracker = {
    async createIssue(payload: {
      title?: string;
      description?: string;
      priority?: Priority;
    }): Promise<TrackerIssue> {
      calls.createIssue.push(payload);
      seq++;
      const issue: TrackerIssue = {
        id: seq,
        identifier: `TECHTEST-${seq}`,
        title: payload.title ?? "",
        url: `https://mock.itsaplan.test/TECHTEST-${seq}`,
        priority: payload.priority,
      };
      issues.set(issue.id, issue);
      return issue;
    },
    async getIssue(id: number) {
      return issues.get(id) ?? { id, identifier: `TECHTEST-${id}`, title: `Ticket ${id}` };
    },
    async addComment(issueId: number, content: string) {
      calls.addComment.push({ issueId, content });
    },
    async attach(_id: number, _desc: string, files: string[]) {
      calls.uploadAttachment.push(...files);
      return files.length;
    },
    async findByIdentifier(identifier: string) {
      for (const iss of issues.values()) {
        if (iss.identifier.toUpperCase() === identifier.toUpperCase()) return iss;
      }
      return null;
    },
    async updateIssue(issueId: number, patch: { priority?: Priority; title?: string }) {
      calls.updateIssue.push({ issueId, patch });
      const iss = issues.get(issueId);
      if (iss) {
        if (patch.priority) iss.priority = patch.priority;
        if (patch.title) iss.title = patch.title;
      }
    },
    async isIssueClosed(issueId: number) {
      if (closedIssues.has(issueId)) return true;
      const iss = issues.get(issueId);
      return iss?.stateType === "completed" || iss?.stateType === "canceled";
    },
    async getIssueState(issueId: number) {
      if (closedIssues.has(issueId)) {
        return { state: "done" as const, stateType: "completed" };
      }
      const iss = issues.get(issueId);
      if (iss?.stateType === "canceled")
        return { state: "canceled" as const, stateType: "canceled" };
      if (iss?.stateType === "completed") return { state: "done" as const, stateType: "completed" };
      return { state: "open" as const, stateType: "started" };
    },
    async getProjectAssignees() {
      return itObj.assignees;
    },
    async getIssueTimeline(issueId: number) {
      return itObj.timelines.get(issueId) ?? [];
    },
  };

  return itObj;
}

const postCreateCatalog = createCatalog({
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

describe("PR 10: Tin sau khi tạo ticket (issue #24)", () => {
  const CHAT = "telegram:7001";
  let db: Database;
  let drafts: SqliteDraftRepository;
  let bindings: SqliteChannelBindingStore;
  let clock: FakeClock;
  let it$: FakeItsaplan;

  beforeEach(() => {
    db = new Database(":memory:");
    intakeApplySchema(db);
    drafts = new SqliteDraftRepository(db);
    bindings = new SqliteChannelBindingStore(db);
    clock = new FakeClock(1_000_000);
    it$ = fakeItsaplan();
  });

  function makeEngine(
    extractorFn: (prompt: string) => Record<string, unknown>,
    overrides: {
      commands?: { interpret: (opts: unknown) => Promise<TicketCommand> };
      identifierPrefix?: string;
    } = {},
  ) {
    const extractor = new FieldExtractor(
      { baseUrl: "http://mock-llm", apiKey: "key", model: "mock-model" },
      async (_c, _s, prompt) => JSON.stringify(extractorFn(prompt)),
    );

    return new IntakeEngine({
      tracker: it$.tracker,
      drafts,
      bindings,
      copy: makeCopyCatalog(tieuLinhCopy),
      clock,
      catalog: postCreateCatalog,
      variant: "tech",
      urgencyRules: URGENCY,
      extractor,
      identifierPrefix: overrides.identifierPrefix ?? "TECHTEST",
      commands: overrides.commands,
      departmentField: "reportingDept",
    });
  }

  function seedCreatedDoc(
    chatId: string,
    issueId: number,
    identifier: string,
    fields: Record<string, string> = {},
  ) {
    const nowIso = new Date().toISOString();
    const draft = {
      ...newDraft(`doc-${issueId}`, chatId, nowIso),
      status: "created" as const,
      issueId,
      issueIdentifier: identifier,
      record: {
        variant: "tech",
        values: { reportingDept: "CSKH", ...fields },
        questionCount: {},
        explicitlyMissing: [],
      },
      ticket: {
        title: `Sự cố ${issueId}`,
        rawText: "mô tả",
        priority: "medium" as const,
        mediaPaths: [],
      },
    };
    drafts.saveRevision(draft);
    bindings.saveBinding({ issueId, identifier, chatId });
    return draft;
  }

  // ── 1. pipeline.flow.test.ts (12 ca flow) ──────────────────────────────────

  it("ticket đã tạo, xin khẩn cấp kèm lý do → nâng mức trên ticket + comment lý do", async () => {
    const replies: Record<string, unknown>[] = [
      {
        userIntent: "report_issue",
        title: "Sai hạn khoá Tự học",
        symptoms: ["khoá tự học sai hạn"],
        reportingDept: "CSKH",
        system: "LMS_Vuihoc",
      },
      { userIntent: "confirm" },
      {
        userIntent: "provide_info",
        symptoms: [],
        requestedPriority: "urgent",
        requestedPriorityReason: "PH đang gay gắt",
      },
    ];
    let i = 0;
    const engine = makeEngine(() => replies[Math.min(i++, replies.length - 1)]);

    // 1. Tạo ticket
    await engine.step({ chatId: CHAT, message: "khoá tự học sai hạn, em bên CSKH" });
    clock.advance(MIN_CONFIRM_DELAY_MS + 10);
    const created = await engine.step({ chatId: CHAT, message: "đúng rồi" });
    expect(legacyActionForOutcome(created.outcome)).toBe("ticket_created");
    expect(it$.calls.createIssue).toHaveLength(1);

    // 2. Xin đổi mức ưu tiên
    const asked = await engine.step({
      chatId: CHAT,
      message: "đổi mức ưu tiên thành URGENT hộ em, PH đang gay gắt",
    });
    expect(legacyActionForOutcome(asked.outcome)).toBe("confirm_ticket_action");
    expect(it$.calls.updateIssue).toHaveLength(0);

    // 3. Bấm xác nhận
    const confirmButton = asked.messages[0].buttons?.[0]?.[0]?.callbackData ?? "";
    const res = await engine.step({ chatId: CHAT, message: confirmButton });
    expect(legacyActionForOutcome(res.outcome)).toBe("post_create_update");
    expect(it$.calls.updateIssue.some((u) => u.patch.priority === "urgent")).toBe(true);
    expect(it$.calls.addComment.at(-1)?.content).toContain("Lý do: PH đang gay gắt");
  });

  it("'cảm ơn em' sau khi tạo không đụng tới ticket", async () => {
    const replies: Record<string, unknown>[] = [
      { userIntent: "report_issue", symptoms: ["lỗi"], reportingDept: "CSKH", title: "Sự cố" },
      { userIntent: "confirm" },
      { userIntent: "chitchat", symptoms: [] },
    ];
    let i = 0;
    const engine = makeEngine(() => replies[Math.min(i++, replies.length - 1)]);

    await engine.step({ chatId: CHAT, message: "báo lỗi, CSKH" });
    clock.advance(MIN_CONFIRM_DELAY_MS + 10);
    await engine.step({ chatId: CHAT, message: "đúng rồi" });

    const r = await engine.step({ chatId: CHAT, message: "cảm ơn em nhé" });
    expect(legacyActionForOutcome(r.outcome)).toBe("already_created");
    expect(it$.calls.addComment).toHaveLength(0);
    expect(it$.calls.updateIssue).toHaveLength(0);
  });

  it("thông tin bổ sung sau khi tạo → comment, KHÔNG ghi đè mô tả", async () => {
    const replies: Record<string, unknown>[] = [
      { userIntent: "report_issue", symptoms: ["lỗi"], reportingDept: "CSKH", title: "Sự cố" },
      { userIntent: "confirm" },
      { userIntent: "provide_info", symptoms: [], studentAccount: "0900000008" },
    ];
    let i = 0;
    const engine = makeEngine(() => replies[Math.min(i++, replies.length - 1)]);

    await engine.step({ chatId: CHAT, message: "báo lỗi, CSKH" });
    clock.advance(MIN_CONFIRM_DELAY_MS + 10);
    const created = await engine.step({ chatId: CHAT, message: "đúng rồi" });

    const asked = await engine.step({
      chatId: CHAT,
      message: "bổ sung thêm SĐT phụ huynh 0900000008",
    });
    expect(legacyActionForOutcome(asked.outcome)).toBe("confirm_ticket_action");
    expect(it$.calls.addComment).toHaveLength(0);

    const confirmButton = asked.messages[0].buttons?.[0]?.[0]?.callbackData ?? "";
    const r = await engine.step({ chatId: CHAT, message: confirmButton });
    expect(legacyActionForOutcome(r.outcome)).toBe("post_create_update");
    expect(it$.calls.updateIssue).toHaveLength(0);
    expect(it$.calls.addComment).toHaveLength(1);
    expect(it$.calls.addComment[0].issueId).toBe(created.issue?.id ?? 0);
    expect(it$.calls.addComment[0].content).toContain("0900000008");
  });

  it("tin có ảnh, không xung đột định danh → hỏi, chưa ghi gì", async () => {
    const replies: Record<string, unknown>[] = [
      {
        userIntent: "report_issue",
        symptoms: ["lỗi iPad"],
        reportingDept: "CSKH",
        title: "Sự cố iPad",
      },
      { userIntent: "confirm" },
      { userIntent: "provide_info", symptoms: ["iPad báo connecting"] },
    ];
    let i = 0;
    const engine = makeEngine(() => replies[Math.min(i++, replies.length - 1)]);

    await engine.step({ chatId: CHAT, message: "lỗi iPad, CSKH" });
    clock.advance(MIN_CONFIRM_DELAY_MS + 10);
    await engine.step({ chatId: CHAT, message: "đúng rồi" });

    const img = "/tmp/anh-ipad.jpg";
    const asked = await engine.step({
      chatId: CHAT,
      message: "0900000013 học sinh dùng iPad bị lỗi connecting",
      mediaPaths: [img],
    });
    expect(legacyActionForOutcome(asked.outcome)).toBe("confirm_ticket_action");
    const labels = (asked.messages[0].buttons ?? []).flat().map((b) => b.text);
    expect(labels).toContain("Sự cố mới");
    expect(labels[0]).toMatch(/^✅ Bổ sung vào /);
    expect(it$.calls.addComment).toHaveLength(0);
    expect(it$.calls.updateIssue).toHaveLength(0);
  });

  it("chỉ gửi ảnh → cũng hỏi, không ghi", async () => {
    const replies: Record<string, unknown>[] = [
      { userIntent: "report_issue", symptoms: ["lỗi"], reportingDept: "CSKH", title: "Sự cố" },
      { userIntent: "confirm" },
      { userIntent: "provide_info", symptoms: [] },
    ];
    let i = 0;
    const engine = makeEngine(() => replies[Math.min(i++, replies.length - 1)]);

    await engine.step({ chatId: CHAT, message: "báo lỗi, CSKH" });
    clock.advance(MIN_CONFIRM_DELAY_MS + 10);
    await engine.step({ chatId: CHAT, message: "đúng rồi" });

    const asked = await engine.step({ chatId: CHAT, message: "", mediaPaths: ["/tmp/anh.jpg"] });
    expect(legacyActionForOutcome(asked.outcome)).toBe("confirm_ticket_action");
    expect(it$.calls.addComment).toHaveLength(0);
  });

  it('hỏi rồi người báo GÕ "ticket mới ạ" → sự cố mới từ tin đang chờ, ticket cũ không bị đụng', async () => {
    const report = {
      userIntent: "report_issue",
      title: "Sai hạn khoá Tự học",
      symptoms: ["khoá tự học sai hạn"],
      reportingDept: "CSKH",
      system: "LMS_Vuihoc",
    };
    const provide = { userIntent: "provide_info", symptoms: ["iPad báo connecting"] };
    const reportNewWithoutDept = {
      userIntent: "report_issue",
      title: "Sự cố iPad",
      symptoms: ["iPad báo connecting"],
    };
    const replies: Record<string, unknown>[] = [
      report,
      { userIntent: "confirm" },
      provide,
      reportNewWithoutDept,
    ];
    let i = 0;
    const engine = makeEngine(() => replies[Math.min(i++, replies.length - 1)]);

    await engine.step({ chatId: CHAT, message: "khoá tự học sai hạn, em bên CSKH" });
    clock.advance(MIN_CONFIRM_DELAY_MS + 10);
    await engine.step({ chatId: CHAT, message: "đúng rồi" });
    const createdDoc = drafts.getLatestByChatId(CHAT);
    const createdDocId = createdDoc?.docId ?? "";

    await engine.step({
      chatId: CHAT,
      message: "0900000013 học sinh dùng iPad bị lỗi connecting",
    });

    const r = await engine.step({ chatId: CHAT, message: "ticket mới ạ" });
    expect(r.docId).not.toBe(createdDocId);
    const newDraftDoc = drafts.getByDocId(r.docId ?? "");
    expect(newDraftDoc?.status).toBe("collecting");
    expect(it$.calls.addComment).toHaveLength(0);
  });

  it('vừa tạo xong, người báo chỉ nhắn "ticket mới ạ" → mở tài liệu mới xin mô tả, không ghi gì', async () => {
    const replies: Record<string, unknown>[] = [
      { userIntent: "report_issue", symptoms: ["lỗi"], reportingDept: "CSKH", title: "Sự cố" },
      { userIntent: "confirm" },
      { userIntent: "provide_info", symptoms: [] },
    ];
    let i = 0;
    const engine = makeEngine(() => replies[Math.min(i++, replies.length - 1)]);

    await engine.step({ chatId: CHAT, message: "báo lỗi, CSKH" });
    clock.advance(MIN_CONFIRM_DELAY_MS + 10);
    await engine.step({ chatId: CHAT, message: "đúng rồi" });

    const r = await engine.step({ chatId: CHAT, message: "ticket mới ạ" });
    expect(legacyActionForOutcome(r.outcome)).toBe("clarify_intent");
    expect(it$.calls.addComment).toHaveLength(0);
  });

  it("hiểu ý chọn ticket cũ, mỗi ticket đang mở có nút riêng; bấm nút ticket cũ mới ghi vào ticket cũ", async () => {
    bindings.saveBinding({
      issueId: 5795,
      chatId: CHAT,
      identifier: "TECHTEST-795",
      title: "Sự cố thanh toán cũ",
    });
    it$.issues.set(5795, {
      id: 5795,
      identifier: "TECHTEST-795",
      title: "Sự cố thanh toán cũ",
      stateType: "started",
    });

    const replies: Record<string, unknown>[] = [
      {
        userIntent: "report_issue",
        symptoms: ["sai hạn"],
        reportingDept: "CSKH",
        title: "Sai hạn khoá học",
      },
      { userIntent: "confirm" },
      { userIntent: "provide_info", symptoms: [] },
    ];
    let i = 0;

    const commandInterpreter = {
      interpret: async () =>
        ({
          action: "append" as const,
          identifier: "TECHTEST-795",
          content: "thêm: PH đang giục gấp",
        }) as TicketCommand,
    };

    const engine = makeEngine(() => replies[Math.min(i++, replies.length - 1)], {
      commands: commandInterpreter,
    });

    await engine.step({ chatId: CHAT, message: "khoá tự học sai hạn, em bên CSKH" });
    clock.advance(MIN_CONFIRM_DELAY_MS + 10);
    await engine.step({ chatId: CHAT, message: "đúng rồi" });

    const asked = await engine.step({ chatId: CHAT, message: "thêm: PH đang giục gấp" });
    expect(legacyActionForOutcome(asked.outcome)).toBe("confirm_ticket_action");
    const labels = (asked.messages[0].buttons ?? []).flat().map((b) => b.text);
    expect(labels[0]).toBe("✅ Bổ sung vào TECHTEST-795");
    expect(labels.some((l) => /^✅ Bổ sung vào TECHTEST-1\d\d$/.test(l))).toBe(true);
    expect(labels).toContain("Sự cố mới");
    expect(asked.messages[0].text).toContain("TECHTEST-795");
    expect(it$.calls.addComment).toHaveLength(0);

    await engine.step({ chatId: CHAT, message: "✅ Bổ sung vào TECHTEST-795" });
    expect(it$.calls.addComment).toHaveLength(1);
    expect(it$.calls.addComment[0].issueId).toBe(5795);
  });

  it("không rõ ticket nào → gợi ý ticket vừa tạo, nhưng ticket cũ vẫn có nút để chọn đúng", async () => {
    bindings.saveBinding({
      issueId: 5795,
      chatId: CHAT,
      identifier: "TECHTEST-795",
      title: "Sự cố thanh toán cũ",
    });
    it$.issues.set(5795, {
      id: 5795,
      identifier: "TECHTEST-795",
      title: "Sự cố thanh toán cũ",
      stateType: "started",
    });

    const replies: Record<string, unknown>[] = [
      {
        userIntent: "report_issue",
        symptoms: ["sai hạn"],
        reportingDept: "CSKH",
        title: "Sai hạn khoá học",
      },
      { userIntent: "confirm" },
      { userIntent: "provide_info", symptoms: [] },
    ];
    let i = 0;

    const commandInterpreter = {
      interpret: async () => ({ action: "unclear" as const }) as TicketCommand,
    };

    const engine = makeEngine(() => replies[Math.min(i++, replies.length - 1)], {
      commands: commandInterpreter,
    });

    await engine.step({ chatId: CHAT, message: "khoá tự học sai hạn, em bên CSKH" });
    clock.advance(MIN_CONFIRM_DELAY_MS + 10);
    await engine.step({ chatId: CHAT, message: "đúng rồi" });

    const asked = await engine.step({ chatId: CHAT, message: "thêm: PH đang giục gấp" });
    const labels = (asked.messages[0].buttons ?? []).flat().map((b) => b.text);
    expect(labels[0]).toMatch(/^✅ Bổ sung vào TECHTEST-1\d\d$/);
    expect(labels).toContain("✅ Bổ sung vào TECHTEST-795");

    await engine.step({ chatId: CHAT, message: "✅ Bổ sung vào TECHTEST-795" });
    expect(it$.calls.addComment.map((c) => c.issueId)).toEqual([5795]);
  });

  it("sự cố mới sau khi tạo → tài liệu mới, không ghi vào ticket cũ", async () => {
    const replies: Record<string, unknown>[] = [
      { userIntent: "report_issue", symptoms: ["lỗi"], reportingDept: "CSKH", title: "Sự cố LMS" },
      { userIntent: "confirm" },
      {
        userIntent: "report_issue",
        title: "Lỗi CRM 500",
        system: "CRM_Vuihoc",
        studentAccount: "0900000014",
        symptoms: ["CRM bị lỗi 500"],
      },
    ];
    let i = 0;
    const engine = makeEngine(() => replies[Math.min(i++, replies.length - 1)]);

    await engine.step({ chatId: CHAT, message: "báo lỗi, CSKH" });
    clock.advance(MIN_CONFIRM_DELAY_MS + 10);
    const created = await engine.step({ chatId: CHAT, message: "đúng rồi" });

    const r = await engine.step({
      chatId: CHAT,
      message: "CRM bị lỗi 500 khi mở đơn hàng của phụ huynh 0900000014",
    });
    expect(r.docId).not.toBe(created.docId);
    const currentDoc = drafts.getByDocId(r.docId ?? "");
    expect(currentDoc?.status).toBe("collecting");
    expect(it$.calls.addComment).toHaveLength(0);
    expect(currentDoc?.record?.values.system).toBe("CRM_Vuihoc");
  });

  it("ticket đã tạo + tin có mã khác → hỏi sự cố mới hay bổ sung, không tự ghi bổ sung", async () => {
    const replies: Record<string, unknown>[] = [
      {
        userIntent: "report_issue",
        title: "Sự cố A",
        symptoms: ["lỗi"],
        reportingDept: "CSKH",
        studentAccount: "0900000003",
      },
      { userIntent: "confirm" },
      {
        userIntent: "provide_info",
        symptoms: [],
        studentAccount: "0900000004",
      },
      {
        userIntent: "report_issue",
        title: "Sự cố B",
        symptoms: ["lỗi mới"],
        studentAccount: "0900000004",
      },
    ];
    let i = 0;
    const engine = makeEngine(() => replies[Math.min(i++, replies.length - 1)]);

    await engine.step({ chatId: CHAT, message: "báo sự cố A, SĐT 0900000003, CSKH" });
    clock.advance(MIN_CONFIRM_DELAY_MS + 10);
    const created = await engine.step({ chatId: CHAT, message: "đúng rồi" });
    expect(legacyActionForOutcome(created.outcome)).toBe("ticket_created");

    const asked = await engine.step({ chatId: CHAT, message: "mã học sinh 0900000004 bị lỗi" });
    expect(legacyActionForOutcome(asked.outcome)).toBe("confirm_ticket_action");
    expect(asked.docId).toBe(created.docId);

    const fresh = await engine.step({ chatId: CHAT, message: "Sự cố mới" });
    expect(fresh.docId).not.toBe(created.docId);
    const freshDoc = drafts.getByDocId(fresh.docId ?? "");
    expect(freshDoc?.record?.values.studentAccount).toBe("0900000004");
  });

  it('ticket đã tạo + tin có mã khác + chọn "Bổ sung" → ghi bổ sung vào ticket đó', async () => {
    const replies: Record<string, unknown>[] = [
      {
        userIntent: "report_issue",
        title: "Sự cố A",
        symptoms: ["lỗi"],
        reportingDept: "CSKH",
        studentAccount: "0900000003",
      },
      { userIntent: "confirm" },
      {
        userIntent: "provide_info",
        symptoms: [],
        studentAccount: "0900000004",
      },
    ];
    let i = 0;
    const engine = makeEngine(() => replies[Math.min(i++, replies.length - 1)]);

    await engine.step({ chatId: CHAT, message: "báo sự cố A, SĐT 0900000003, CSKH" });
    clock.advance(MIN_CONFIRM_DELAY_MS + 10);
    const created = await engine.step({ chatId: CHAT, message: "đúng rồi" });

    const askedB = await engine.step({ chatId: CHAT, message: "mã học sinh 0900000004 bị lỗi" });
    const cb = askedB.messages[0].buttons?.[0]?.[0]?.callbackData ?? "";
    const appended = await engine.step({
      chatId: CHAT,
      message: cb,
    });
    expect(legacyActionForOutcome(appended.outcome)).toBe("post_create_update");
    expect(appended.docId).toBe(created.docId);
    // Bổ sung không đè định danh của ticket đã tạo
    const createdDoc = drafts.getByDocId(created.docId ?? "");
    expect(createdDoc?.record?.values.studentAccount).toBe("0900000003");
  });

  // ── 2. pipeline.notify-supplement.test.ts (6 ca notify) ───────────────────

  it("khi ticket đang xử lý có assignee (u-techlead-a) → comment bổ sung mention @techlead_a", async () => {
    const engine = makeEngine(() => ({
      userIntent: "provide_info",
      symptoms: [],
      studentAccount: "0900000005",
    }));

    it$.issues.set(101, {
      id: 101,
      identifier: "TECHTEST-101",
      title: "Sự cố 101",
      columnId: 2,
      stateType: "started",
      assigneeUserId: "u-techlead-a",
    });
    it$.assignees = [{ userId: "u-techlead-a", username: "techlead_a", name: "TechLead_A" }];

    seedCreatedDoc(CHAT, 101, "TECHTEST-101");

    // Bước 1: Người báo gửi tin nhắn bổ sung, bot hỏi xác nhận (ADR-0008)
    const asked = await engine.step({
      chatId: CHAT,
      message: "Phụ huynh gửi thêm SĐT 0900000005",
    });
    expect(legacyActionForOutcome(asked.outcome)).toBe("confirm_ticket_action");
    expect(it$.calls.addComment).toHaveLength(0);

    // Bước 2: Người báo bấm nút xác nhận
    const cb = asked.messages[0].buttons?.[0]?.[0]?.callbackData ?? "";
    const res = await engine.step({
      chatId: CHAT,
      message: cb,
    });

    expect(legacyActionForOutcome(res.outcome)).toBe("post_create_update");
    expect(it$.calls.addComment).toHaveLength(1);
    const added = it$.calls.addComment[0];
    expect(added.issueId).toBe(101);
    expect(added.content).toContain("(cc @techlead_a)");
    expect(added.content).not.toContain("(cc @techlead_a))");
    expect(added.content).toContain("0900000005");
  });

  it("khi ticket không có assignee nhưng timeline có trao đổi của KTV (TechUser_B) → mention @techuser_b", async () => {
    const engine = makeEngine(() => ({
      userIntent: "provide_info",
      symptoms: [],
    }));

    it$.issues.set(102, {
      id: 102,
      identifier: "TECHTEST-102",
      title: "Sự cố 102",
      columnId: 2,
      stateType: "started",
      assigneeUserId: null,
    });
    it$.assignees = [{ userId: "u-chung", username: "techuser_b", name: "TechUser_B" }];
    it$.timelines.set(102, [
      {
        kind: "comment",
        actorUserId: "u-chung",
        actorName: "TechUser_B",
        body: "Kỹ thuật đã nhận và đang tra log",
      },
      { kind: "comment", actorName: "Tiểu Linh", body: "Thông báo tự động <!-- intake-bot -->" },
    ]);

    seedCreatedDoc(CHAT, 102, "TECHTEST-102");

    const asked = await engine.step({
      chatId: CHAT,
      message: "Mã giao dịch là VUIHOC-88992",
    });
    expect(legacyActionForOutcome(asked.outcome)).toBe("confirm_ticket_action");

    const cb = asked.messages[0].buttons?.[0]?.[0]?.callbackData ?? "";
    const res = await engine.step({
      chatId: CHAT,
      message: cb,
    });

    expect(legacyActionForOutcome(res.outcome)).toBe("post_create_update");
    expect(it$.calls.addComment).toHaveLength(1);
    const added = it$.calls.addComment[0];
    expect(added.issueId).toBe(102);
    expect(added.content).toContain("(cc @techuser_b)");
    expect(added.content).not.toContain("(cc @techuser_b))");
    expect(added.content).toContain("VUIHOC-88992");
  });

  it("khi ticket không có assignee và timeline chỉ có bot/hệ thống → none (không cc ai)", async () => {
    const engine = makeEngine(() => ({
      userIntent: "provide_info",
      symptoms: [],
    }));

    it$.issues.set(103, {
      id: 103,
      identifier: "TECHTEST-103",
      title: "Sự cố 103",
      columnId: 2,
      stateType: "started",
      assigneeUserId: null,
    });
    it$.timelines.set(103, [
      { kind: "comment", actorName: "Tiểu Linh", body: "Ticket tạo tự động <!-- intake-bot -->" },
      { kind: "comment", actorName: "admin", body: "Gán nhãn tự động" },
    ]);

    seedCreatedDoc(CHAT, 103, "TECHTEST-103");

    const asked = await engine.step({
      chatId: CHAT,
      message: "Học sinh dùng Android 14",
    });
    expect(legacyActionForOutcome(asked.outcome)).toBe("confirm_ticket_action");

    const cb = asked.messages[0].buttons?.[0]?.[0]?.callbackData ?? "";
    const res = await engine.step({
      chatId: CHAT,
      message: cb,
    });

    expect(legacyActionForOutcome(res.outcome)).toBe("post_create_update");
    expect(it$.calls.addComment).toHaveLength(1);
    const added = it$.calls.addComment[0];
    expect(added.issueId).toBe(103);
    expect(added.content).not.toContain("cc @");
    expect(added.content).toContain("Android 14");
  });

  it("ticket đã ở Done (cột 4) → từ chối bổ sung, không addComment, hướng dẫn tạo ticket mới", async () => {
    const engine = makeEngine(() => ({
      userIntent: "provide_info",
      symptoms: [],
    }));

    it$.issues.set(104, {
      id: 104,
      identifier: "TECHTEST-104",
      title: "Sự cố 104",
      columnId: 4,
      stateType: "completed",
      assigneeUserId: "u-techlead-a",
    });
    it$.closedIssues.add(104);

    seedCreatedDoc(CHAT, 104, "TECHTEST-104");

    const res = await engine.step({
      chatId: CHAT,
      message: "bổ sung thêm: học sinh vẫn bị lỗi trên máy tính",
    });
    expect(legacyActionForOutcome(res.outcome)).toBe("post_create_update");
    expect(it$.calls.addComment).toHaveLength(0);
    expect(it$.calls.updateIssue).toHaveLength(0);
    expect(res.messages[0].text).toContain("đã đóng");
    expect(res.messages[0].text).toContain("tạo ticket mới");
  });

  it("ticket đã ở Canceled (cột 5) → từ chối bổ sung, không addComment, hướng dẫn tạo ticket mới", async () => {
    const engine = makeEngine(() => ({
      userIntent: "provide_info",
      symptoms: [],
    }));

    it$.issues.set(105, {
      id: 105,
      identifier: "TECHTEST-105",
      title: "Sự cố 105",
      columnId: 5,
      stateType: "canceled",
      assigneeUserId: "u-chung",
    });
    it$.closedIssues.add(105);

    seedCreatedDoc(CHAT, 105, "TECHTEST-105");

    const res = await engine.step({
      chatId: CHAT,
      message: "Em muốn thêm thông tin",
    });

    expect(legacyActionForOutcome(res.outcome)).toBe("post_create_update");
    expect(it$.calls.addComment).toHaveLength(0);
    expect(it$.calls.updateIssue).toHaveLength(0);
    expect(res.messages[0].text).toContain("đã đóng");
    expect(res.messages[0].text).toContain("tạo ticket mới");
  });

  it("người dùng gõ lệnh bổ sung chỉ định ticket đã đóng (bổ sung TECHTEST-104) → từ chối ngay lập tức", async () => {
    it$.issues.set(104, {
      id: 104,
      identifier: "TECHTEST-104",
      title: "Sự cố 104",
      columnId: 4,
      stateType: "completed",
      assigneeUserId: "u-techlead-a",
    });
    it$.closedIssues.add(104);

    const chatId = "telegram:7006";
    bindings.saveBinding({
      issueId: 104,
      identifier: "TECHTEST-104",
      chatId,
    });

    const engine = makeEngine(() => ({ userIntent: "provide_info", symptoms: [] }));

    const res = await engine.step({
      chatId,
      message: "bổ sung TECHTEST-104: số điện thoại là 0900000016",
    });

    expect(legacyActionForOutcome(res.outcome)).toBe("post_create_update");
    expect(it$.calls.addComment).toHaveLength(0);
    expect(it$.calls.updateIssue).toHaveLength(0);
    expect(res.messages[0].text).toContain("TECHTEST-104");
    expect(res.messages[0].text).toContain("đã đóng");
    expect(res.messages[0].text).toContain("tạo ticket mới");
  });
});
