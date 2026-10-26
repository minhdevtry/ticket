/**
 * PR 11: Lệnh nhắm vào ticket đã có trong luồng chat một người (RFC 0002 §1.4 D1-D7, D9, issue #25).
 *
 * Các ca test port từ legacy:
 * - apps/tieulinh-legacy/lib/intake-step/ticket-reply-router.test.ts (2 ca)
 * - apps/tieulinh-legacy/lib/intake-step/pipeline.flow.test.ts (11 ca)
 * - apps/tieulinh-legacy/mcp/shared/tools/confirmation-and-binding.test.ts (1 ca)
 * - D9: Tra cứu tiến độ không nêu mã (cửa sổ 30 phút)
 */
import { describe, expect, it, beforeEach } from "bun:test";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { intakeApplySchema, SqliteDraftRepository } from "../draft";
import { SqliteChannelBindingStore } from "../create";
import { notifyApplySchema, SqliteMessageRouteStore } from "../notify";
import { makeCopyCatalog } from "../copy-catalog";
import { tieuLinhCopy } from "../../../examples/tieulinh/copy";
import { createCatalog } from "../gate/catalog";
import { FakeClock, URGENCY } from "./engine-harness.fixture";
import { IntakeEngine, type IntakeEngineDeps } from "./engine";
import { legacyActionForOutcome } from "./action-map";
import { LlmTicketCommandInterpreter } from "./command-interpreter";
import { MIN_CONFIRM_DELAY_MS } from "../confirm";
import type {
  TrackerPort,
  TrackerIssue,
  Priority,
  TicketCommand,
  TicketCommandInput,
  ReplyCandidate,
  ExtractInput,
  ExtractedFields,
} from "../ports";

const CHAT = "7001";
const REPORT = "Lỗi app Duo học sinh 0900000005 không làm bài được";

interface FakeItsaplanCalls {
  createIssue: Array<{
    title?: string;
    description?: string;
    columnId?: number;
    priority?: Priority;
  }>;
  updateIssue: Array<{
    issueId: number;
    patch: { priority?: Priority; title?: string; description?: string; columnId?: number };
  }>;
  addComment: Array<{ issueId: number; content: string }>;
  uploadAttachment: string[];
  linkIssues: Array<{ fromId: number; toId: number; linkType: string }>;
}

interface FakeItsaplan {
  calls: FakeItsaplanCalls;
  tracker: TrackerPort;
  issues: Map<number, TrackerIssue>;
  closedIssues: Set<number>;
  timelines: Map<number, unknown[]>;
}

function fakeItsaplan(): FakeItsaplan {
  const calls: FakeItsaplanCalls = {
    createIssue: [],
    updateIssue: [],
    addComment: [],
    uploadAttachment: [],
    linkIssues: [],
  };
  const issues = new Map<number, TrackerIssue>();
  const closedIssues = new Set<number>();
  let seq = 100;

  const itObj: FakeItsaplan = {
    calls,
    tracker: null as unknown as TrackerPort,
    issues,
    closedIssues,
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
        description: payload.description ?? "",
        url: `https://mock.itsaplan.test/TECHTEST-${seq}`,
        priority: payload.priority,
        columnId: 2,
      };
      issues.set(issue.id, issue);
      return issue;
    },
    async getIssue(id: number) {
      return (
        issues.get(id) ?? {
          id,
          identifier: `TECHTEST-${id}`,
          title: `Ticket ${id}`,
          columnId: 2,
          description: "",
        }
      );
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
    async updateIssue(
      issueId: number,
      patch: { priority?: Priority; title?: string; description?: string; columnId?: number },
    ) {
      calls.updateIssue.push({ issueId, patch });
      const iss = issues.get(issueId);
      if (iss) {
        if (patch.priority) iss.priority = patch.priority;
        if (patch.title) iss.title = patch.title;
        if (patch.description) iss.description = patch.description;
        if (patch.columnId) iss.columnId = patch.columnId;
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
    async getIssueTimeline(issueId: number) {
      return itObj.timelines.get(issueId) ?? [];
    },
    async linkIssues(
      fromId: number,
      toId: number,
      linkType: "duplicates" | "relates_to" | "blocks" | "blocked_by",
    ) {
      calls.linkIssues.push({ fromId, toId, linkType });
    },
    async listProjectColumns() {
      return [
        { id: 1, name: "Backlog", stateType: "backlog" },
        { id: 2, name: "Todo", stateType: "unstarted" },
        { id: 3, name: "In Progress", stateType: "started" },
        { id: 4, name: "Resolved", stateType: "resolved" },
        { id: 5, name: "Done", stateType: "completed" },
        { id: 9, name: "Canceled", stateType: "canceled" },
      ];
    },
  };

  return itObj;
}

const testCatalog = createCatalog({
  fields: {
    _toi_da_hoi_lai: 2,
    _toi_da_truong_moi_luot: 1,
    nhanh: {
      tech: {
        ten: "Tech incident",
        truong_mo_dau: "van_de",
        recap: ["van_de", "bo_phan"],
        truong: {
          van_de: {
            bat_buoc: true,
            kieu: "text",
            duoc_hoi: true,
            nhan: "Problem",
            hoi: "What's the problem?",
          },
          bo_phan: {
            bat_buoc: true,
            nen_hoi: true,
            kieu: "text",
            duoc_hoi: true,
            nhan: "Department",
            hoi: "Which team?",
          },
        },
      },
    },
  },
});

describe("PR 11 — Lệnh nhắm vào ticket đã có", () => {
  let db: Database;
  let drafts: SqliteDraftRepository;
  let bindings: SqliteChannelBindingStore;
  let routes: SqliteMessageRouteStore;
  let it$: FakeItsaplan;
  let clock: FakeClock;

  const own = (n: number) => {
    it$.issues.set(n > 1000 ? n : 5000 + n, {
      id: n > 1000 ? n : 5000 + n,
      identifier: `TECHTEST-${n}`,
      title: `Ticket ${n}`,
      columnId: 2,
      description: `## Thông tin sự cố\n\n- Người báo: A - telegram:${CHAT}\n- Tài khoản HS / SĐT: 0900000006\n- Bộ phận: CSKH\n\n### Mô tả\n\n> Khoá gia hạn sai hạn\n\n---`,
    });
    bindings.saveBinding({
      issueId: n > 1000 ? n : 5000 + n,
      chatId: CHAT,
      identifier: `TECHTEST-${n}`,
      title: `Ticket ${n}`,
    });
  };

  const techAsked = () => {
    routes.saveMessageRoute({
      messageId: "1234",
      channelType: "telegram",
      chatId: CHAT,
      issueId: 5795,
      identifier: "TECHTEST-795",
      kind: "comment",
    });
    it$.timelines.set(5795, [
      {
        kind: "comment",
        actorName: "Tech Specialist",
        body: "đơn hàng nào sai vậy bạn?",
      },
    ]);
    own(795);
  };

  const interp = (cmd: TicketCommand) => {
    const seen: TicketCommandInput[] = [];
    return {
      seen,
      interpret: async (input: TicketCommandInput) => {
        seen.push(input);
        return cmd;
      },
    };
  };

  function buildEngine(overrides: Partial<IntakeEngineDeps> = {}): IntakeEngine {
    const copy = makeCopyCatalog(tieuLinhCopy);
    const deps: IntakeEngineDeps = {
      tracker: it$.tracker,
      drafts,
      bindings,
      routes,
      copy,
      clock,
      identifierPrefix: "TECHTEST",
      extractor: {
        async extract(input: ExtractInput): Promise<ExtractedFields> {
          const t = input.text.toLowerCase();
          if (t.includes("đúng rồi") || t.includes("tạo ticket") || t.includes("ok tạo đi")) {
            return { userIntent: "confirm" };
          }
          if (t.includes("vận hành")) {
            return {
              userIntent: "provide_info",
              values: { bo_phan: "Vận hành" },
            };
          }
          if (t.includes("lỗi app duo")) {
            return {
              userIntent: "report_issue",
              symptoms: ["không làm bài được"],
              values: { van_de: "Lỗi app Duo" },
            };
          }
          return { userIntent: "provide_info" };
        },
      },
      catalog: testCatalog,
      variant: "tech",
      urgencyRules: URGENCY,
      ...overrides,
    };
    return new IntakeEngine(deps);
  }

  beforeEach(() => {
    db = new Database(":memory:");
    intakeApplySchema(db);
    notifyApplySchema(db);
    drafts = new SqliteDraftRepository(db);
    bindings = new SqliteChannelBindingStore(db);
    routes = new SqliteMessageRouteStore(db);
    clock = new FakeClock(Date.now());
    it$ = fakeItsaplan();
  });

  // ── 1. Từ ticket-reply-router.test.ts ───────────────────────────────────────

  it("append / edit / lookup chỉ nhận mã trong ứng viên; câu kỹ thuật hỏi vào prompt", async () => {
    const llm = { baseUrl: "", apiKey: "", model: "m" };
    const cand: ReplyCandidate = {
      identifier: "TECHTEST-795",
      issueId: 1,
      title: "Khoá gia hạn sai hạn",
      techQuestion: "đơn hàng nào sai?",
      ownTicket: true,
      mentioned: false,
    };
    let userPromptSeen = "";
    const interpreter = new LlmTicketCommandInterpreter(llm, async (_c, _s, u) => {
      userPromptSeen = u;
      return '{"action":"append","ticket":"techtest-795","content":"Đơn hàng gia hạn ạ"}';
    });
    const cmd = await interpreter.interpret({
      message: "Đơn hàng gia hạn ạ",
      attachments: 0,
      candidates: [cand],
    });
    expect(cmd).toEqual({
      action: "append",
      identifier: "TECHTEST-795",
      content: "Đơn hàng gia hạn ạ",
    });
    expect(userPromptSeen).toContain("đơn hàng nào sai?");

    const editInterp = new LlmTicketCommandInterpreter(
      llm,
      async () => '{"action":"edit","ticket":"TECHTEST-795","instruction":"SĐT thành 0393"}',
    );
    expect(
      await editInterp.interpret({
        message: "SĐT thành 0393",
        attachments: 0,
        candidates: [cand],
      }),
    ).toEqual({
      action: "edit",
      identifier: "TECHTEST-795",
      instruction: "SĐT thành 0393",
    });

    const lookupInterp = new LlmTicketCommandInterpreter(
      llm,
      async () => '{"action":"lookup","ticket":"TECHTEST-795"}',
    );
    expect(
      await lookupInterp.interpret({
        message: "check",
        attachments: 0,
        candidates: [cand],
      }),
    ).toEqual({
      action: "lookup",
      identifier: "TECHTEST-795",
    });

    const bogusInterp = new LlmTicketCommandInterpreter(
      llm,
      async () => '{"action":"append","ticket":"TECHTEST-1"}',
    );
    expect(
      await bogusInterp.interpret({
        message: "x",
        attachments: 0,
        candidates: [cand],
      }),
    ).toEqual({ action: "unclear" });

    const newInterp = new LlmTicketCommandInterpreter(llm, async () => '{"action":"new"}');
    expect(
      await newInterp.interpret({
        message: "báo lỗi mới",
        attachments: 0,
        candidates: [cand],
      }),
    ).toEqual({ action: "new" });
  });

  it("move_created cần ticket vừa tạo làm nguồn", async () => {
    const llm = { baseUrl: "", apiKey: "", model: "m" };
    const cand: ReplyCandidate = {
      identifier: "TECHTEST-795",
      issueId: 1,
      ownTicket: true,
      mentioned: false,
    };
    const created: ReplyCandidate = {
      identifier: "TECHTEST-975",
      issueId: 2,
      ownTicket: true,
      mentioned: false,
      justCreated: true,
    };
    const interp1 = new LlmTicketCommandInterpreter(
      llm,
      async () => '{"action":"move_created","ticket":"TECHTEST-795","from":"TECHTEST-975"}',
    );
    expect(
      await interp1.interpret({
        message: "cái này của 795",
        attachments: 0,
        candidates: [cand, created],
      }),
    ).toEqual({
      action: "move_created",
      from: "TECHTEST-975",
      identifier: "TECHTEST-795",
    });

    // Không có ticket justCreated thì không chuyển được
    expect(
      await interp1.interpret({
        message: "cái này của 795",
        attachments: 0,
        candidates: [cand],
      }),
    ).toEqual({ action: "unclear" });
  });

  // ── 2. Từ pipeline.flow.test.ts ─────────────────────────────────────────────

  it("kỹ thuật vừa hỏi → GỢI Ý bổ sung, chưa ghi gì; bấm xác nhận mới ghi", async () => {
    techAsked();
    const c = interp({
      action: "append",
      identifier: "TECHTEST-795",
      content: "Đơn hàng gia hạn ạ",
    });
    const engine = buildEngine({ commands: c });
    const r1 = await engine.step({
      chatId: CHAT,
      message: "Đơn hàng gia hạn ạ- ac check tt hộ e ạ",
    });
    expect(legacyActionForOutcome(r1.outcome)).toBe("confirm_ticket_action");
    expect(r1.messages[0].buttons?.flat().map((b) => b.text)).toEqual([
      "✅ Bổ sung vào TECHTEST-795",
      "Sự cố mới",
    ]);
    expect(it$.calls.addComment).toHaveLength(0);
    expect(c.seen[0].candidates[0].techQuestion).toContain("đơn hàng nào sai");

    // Người dùng bấm xác nhận (bỏ emoji hoặc có emoji)
    const r2 = await engine.step({ chatId: CHAT, message: "Bổ sung vào TECHTEST-795" });
    expect(legacyActionForOutcome(r2.outcome)).toBe("post_create_update");
    expect(it$.calls.addComment).toHaveLength(1);
    expect(it$.calls.addComment[0].issueId).toBe(5795);
    expect(it$.calls.addComment[0].content).toContain("Đơn hàng gia hạn ạ");
    expect(it$.calls.createIssue).toHaveLength(0);
  });

  it("giục gấp có lý do vào ticket có sẵn → chỉ khi bấm xác nhận mới nâng mức + ghi lý do (thay escalate_issue cũ)", async () => {
    own(795);
    const engine = buildEngine({
      commands: interp({
        action: "append",
        identifier: "TECHTEST-795",
        content: "gấp lắm ạ, PH sắp khiếu nại",
      }),
      extractor: {
        async extract() {
          return {
            userIntent: "provide_info",
            requestedPriority: "urgent",
            requestedPriorityReason: "PH sắp khiếu nại",
          };
        },
      },
    });

    const r1 = await engine.step({
      chatId: CHAT,
      message: "TECHTEST-795 gấp lắm ạ, PH sắp khiếu nại",
    });
    expect(legacyActionForOutcome(r1.outcome)).toBe("confirm_ticket_action");
    expect(it$.calls.updateIssue).toHaveLength(0);
    expect(it$.calls.addComment).toHaveLength(0);

    await engine.step({ chatId: CHAT, message: "Bổ sung vào TECHTEST-795" });
    expect(
      it$.calls.updateIssue.some((u) => u.issueId === 5795 && u.patch.priority === "urgent"),
    ).toBe(true);
    expect(it$.calls.addComment.at(-1)?.content).toContain("Lý do: PH sắp khiếu nại");
  });

  it("gợi ý → 'Sự cố mới' thì tin vào tờ khai, không ghi ticket cũ", async () => {
    techAsked();
    const engine = buildEngine({ commands: interp({ action: "unclear" }) });
    await engine.step({ chatId: CHAT, message: REPORT });
    const r2 = await engine.step({ chatId: CHAT, message: "Sự cố mới" });
    expect(legacyActionForOutcome(r2.outcome)).toBe("ask_missing_field");
    expect(drafts.getLatestByChatId(CHAT)?.ticket.rawText).toContain(REPORT);
    expect(it$.calls.addComment).toHaveLength(0);
  });

  it("'bổ sung TECHTEST-795 …' khi đang soạn dở → xem trước + Huỷ; Huỷ thì không ghi, tờ khai giữ nguyên", async () => {
    own(795);
    let engine = buildEngine();
    await engine.step({ chatId: CHAT, message: REPORT });

    engine = buildEngine({
      commands: interp({
        action: "append",
        identifier: "TECHTEST-795",
        content: "mã đơn DH900002",
      }),
    });
    const r = await engine.step({
      chatId: CHAT,
      message: "bổ sung TECHTEST-795 mã đơn DH900002",
    });
    expect(legacyActionForOutcome(r.outcome)).toBe("confirm_ticket_action");
    expect(r.messages[0].text).toContain("DH900002");
    expect(r.messages[0].buttons?.flat().map((b) => b.text)).toEqual([
      "✅ Bổ sung vào TECHTEST-795",
      "Huỷ",
    ]);

    const r2 = await engine.step({ chatId: CHAT, message: "Huỷ" });
    expect(legacyActionForOutcome(r2.outcome)).toBe("canceled");
    expect(it$.calls.addComment).toHaveLength(0);

    const r3 = await engine.step({ chatId: CHAT, message: "Em bên Vận hành nhé" });
    expect(legacyActionForOutcome(r3.outcome)).toBe("confirm_summary");
  });

  it("đang chờ xác nhận mà nhắn việc khác → bỏ bản xem trước, xử lý tin mới như thường", async () => {
    own(795);
    let engine = buildEngine({
      commands: interp({ action: "append", identifier: "TECHTEST-795", content: "x" }),
    });
    await engine.step({ chatId: CHAT, message: "bổ sung TECHTEST-795 x" });

    engine = buildEngine({ commands: interp({ action: "new" }) });
    const r = await engine.step({ chatId: CHAT, message: REPORT });
    expect(legacyActionForOutcome(r.outcome)).toBe("ask_missing_field");
    expect(it$.calls.addComment).toHaveLength(0);
  });

  it("ticket có Telegram ID người báo trong mô tả cũng là của mình (ticket bot cũ)", async () => {
    it$.issues.set(888, {
      id: 888,
      identifier: "TECHTEST-888",
      title: "Ticket 888",
      columnId: 2,
      description: "Người báo: A - telegram:99999",
    });
    const engine = buildEngine({
      commands: interp({ action: "lookup", identifier: "TECHTEST-888" }),
    });
    const l = await engine.step({ chatId: "99999", message: "TECHTEST-888" });
    expect(l.messages[0].text).toContain("Ticket 888");
  });

  it("sửa: xem trước cũ → mới, xác nhận thì sửa thẳng + comment dấu vết", async () => {
    own(795);
    const engine = buildEngine({
      commands: interp({
        action: "edit",
        identifier: "TECHTEST-795",
        instruction: "SĐT thành 0900000015",
      }),
      editPlanner: async () => [
        { type: "field", label: "Tài khoản HS / SĐT", value: "0900000015" },
      ],
    });
    const r = await engine.step({
      chatId: CHAT,
      message: "sửa TECHTEST-795 SĐT thành 0900000015",
    });
    expect(legacyActionForOutcome(r.outcome)).toBe("confirm_ticket_action");
    expect(r.messages[0].text).toContain("0900000006 → 0900000015");
    expect(it$.calls.updateIssue).toHaveLength(0);

    const r2 = await engine.step({ chatId: CHAT, message: "✅ Sửa TECHTEST-795" });
    expect(r2.messages[0].text).toContain("đã sửa");
    expect(it$.calls.updateIssue[0].patch.description).toContain(
      "- Tài khoản HS / SĐT: 0900000015",
    );
    expect(it$.calls.addComment[0].content).toContain("0900000006 → 0900000015");
  });

  it("bot vừa tạo nhầm → 'cái này bổ sung cho TECHTEST-795' → xác nhận: chép sang 795, nối trùng, huỷ bản vừa tạo", async () => {
    own(795);
    let engine = buildEngine();
    // Tạo ticket nhầm
    await engine.step({ chatId: CHAT, message: "Lỗi app Duo" });
    await engine.step({ chatId: CHAT, message: "Em bên Vận hành nhé" });
    clock.advance(MIN_CONFIRM_DELAY_MS + 10);
    const created = await engine.step({ chatId: CHAT, message: "✅ Đúng rồi, tạo ticket" });
    expect(legacyActionForOutcome(created.outcome)).toBe("ticket_created");
    const createdIssue = created.issue;
    expect(createdIssue).toBeDefined();
    const newId = createdIssue?.identifier ?? "";
    const newIssueId = createdIssue?.id ?? 0;

    // Giả lập description cho ticket vừa tạo nhầm
    it$.issues.set(newIssueId, {
      id: newIssueId,
      identifier: newId,
      title: "Ticket vừa tạo nhầm",
      columnId: 2,
      description: "## Thông tin sự cố\n\n### Mô tả\n\nNội dung ticket vừa tạo nhầm\n\n---",
    });

    engine = buildEngine({
      commands: interp({ action: "move_created", from: newId, identifier: "TECHTEST-795" }),
    });
    const r = await engine.step({
      chatId: CHAT,
      message: "nhầm rồi, cái này bổ sung cho TECHTEST-795",
    });
    expect(legacyActionForOutcome(r.outcome)).toBe("confirm_ticket_action");
    expect(r.messages[0].text).toContain(`huỷ ${newId}`);

    await engine.step({ chatId: CHAT, message: "✅ Chuyển sang TECHTEST-795" });
    expect(it$.calls.addComment.find((c) => c.issueId === 5795)?.content).toContain(
      "Nội dung ticket vừa tạo nhầm",
    );
    expect(it$.calls.linkIssues[0]).toEqual({
      fromId: newIssueId,
      toId: 5795,
      linkType: "duplicates",
    });
    expect(it$.calls.updateIssue.find((u) => u.issueId === newIssueId)?.patch.columnId).toBe(9);
  });

  it("tin báo trạng thái, ticket đã huỷ, hay lời 'huỷ'/'cảm ơn' → không gợi ý ghi vào ticket", async () => {
    const c = interp({ action: "append", identifier: "TECHTEST-795", content: "x" });
    const engine = buildEngine({ commands: c });
    routes.saveMessageRoute({
      messageId: "9101",
      channelType: "telegram",
      chatId: CHAT,
      issueId: 5795,
      identifier: "TECHTEST-795",
      kind: "state",
    });
    expect(
      legacyActionForOutcome(
        (await engine.step({ chatId: CHAT, message: "Đơn hàng gia hạn ạ" })).outcome,
      ),
    ).not.toBe("confirm_ticket_action");

    // huỷ
    await engine.step({ chatId: CHAT, message: "huỷ" });
    routes.saveMessageRoute({
      messageId: "9102",
      channelType: "telegram",
      chatId: CHAT,
      issueId: 5796,
      identifier: "TECHTEST-796",
      kind: "comment",
    });
    it$.closedIssues.add(5796);
    expect(
      legacyActionForOutcome(
        (await engine.step({ chatId: CHAT, message: "Đơn hàng gia hạn ạ" })).outcome,
      ),
    ).not.toBe("confirm_ticket_action");

    // tech question nhưng tin là 'huỷ' hoặc 'cảm ơn em'
    techAsked();
    expect(
      legacyActionForOutcome((await engine.step({ chatId: CHAT, message: "huỷ" })).outcome),
    ).not.toBe("confirm_ticket_action");
    expect(
      legacyActionForOutcome((await engine.step({ chatId: CHAT, message: "cảm ơn em" })).outcome),
    ).not.toBe("confirm_ticket_action");
    expect(c.seen).toHaveLength(0);
  });

  it("không có câu hỏi kỹ thuật, không nhắc mã → không gọi bộ đọc lệnh", async () => {
    const c = interp({ action: "append", identifier: "TECHTEST-795", content: "x" });
    const engine = buildEngine({ commands: c });
    await engine.step({ chatId: CHAT, message: REPORT });
    expect(c.seen).toHaveLength(0);
  });

  it("đang soạn dở tờ khai → câu trả lời cho tờ khai không bị kéo sang ticket kỹ thuật vừa hỏi", async () => {
    const c = interp({ action: "append", identifier: "TECHTEST-795", content: "x" });
    const engine = buildEngine({ commands: c });
    await engine.step({ chatId: CHAT, message: REPORT });
    techAsked();
    const r2 = await engine.step({ chatId: CHAT, message: "Em bên Vận hành nhé" });
    expect(legacyActionForOutcome(r2.outcome)).toBe("confirm_summary");
    expect(c.seen).toHaveLength(0);
  });

  it("TECH-1218: người báo gửi ảnh trước rồi gõ 'update vào tick TECHTEST-X' (hoặc ngược lại) → bảo toàn ảnh đính kèm và không ghi câu lệnh trần thành comment", async () => {
    const img1 = "/tmp/test-attach-1218-a.jpg";
    const img2 = "/tmp/test-attach-1218-b.jpg";
    fs.writeFileSync(img1, "fake-jpeg-1218-a");
    fs.writeFileSync(img2, "fake-jpeg-1218-b");

    try {
      // Luồng 1: Tạo vé xong → gửi ảnh → gõ "update vào tick TECHTEST-101" → bấm xác nhận
      const engine = buildEngine({
        commands: {
          interpret: async () => ({ action: "unclear" }),
        },
      });

      await engine.step({ chatId: CHAT, message: "Lỗi app Duo" });
      await engine.step({ chatId: CHAT, message: "Em bên Vận hành nhé" });
      clock.advance(MIN_CONFIRM_DELAY_MS + 10);
      const created = await engine.step({ chatId: CHAT, message: "✅ Đúng rồi, tạo ticket" });
      const createdIssue = created.issue;
      expect(createdIssue).toBeDefined();
      const createdId = createdIssue?.identifier ?? "";

      const stepImg = await engine.step({ chatId: CHAT, message: "", mediaPaths: [img1] });
      expect(legacyActionForOutcome(stepImg.outcome)).toBe("confirm_ticket_action");
      expect(drafts.getLatestByChatId(CHAT)?.pendingTicketAction?.mediaPaths).toEqual([img1]);

      const stepCmd = await engine.step({
        chatId: CHAT,
        message: `update vào tick ${createdId}`,
        mediaPaths: [],
      });
      expect(legacyActionForOutcome(stepCmd.outcome)).toBe("confirm_ticket_action");
      expect(drafts.getLatestByChatId(CHAT)?.pendingTicketAction?.mediaPaths).toEqual([img1]);
      expect(drafts.getLatestByChatId(CHAT)?.pendingTicketAction?.content).toBe("");
      expect(stepCmd.messages[0].text).toContain("(kèm 1 ảnh/tệp)");
      expect(stepCmd.messages[0].text).not.toContain(`> update vào tick ${createdId}`);

      const done1 = await engine.step({
        chatId: CHAT,
        message: `✅ Bổ sung vào ${createdId}`,
      });
      expect(legacyActionForOutcome(done1.outcome)).toBe("post_create_update");
      expect(it$.calls.uploadAttachment).toContain(img1);
      expect(it$.calls.addComment).toHaveLength(1);
      expect(it$.calls.addComment[0].content).not.toContain("update vào tick");

      // Luồng 2: Câu lệnh trần chưa có ảnh/nội dung → clarify → gửi ảnh → bấm xác nhận
      it$.calls.uploadAttachment.length = 0;
      it$.calls.addComment.length = 0;

      const askPayload = await engine.step({
        chatId: CHAT,
        message: `update vào tick ${createdId}`,
        mediaPaths: [],
      });
      expect(legacyActionForOutcome(askPayload.outcome)).toBe("clarify_intent");
      expect(askPayload.messages[0].text).toContain(
        `gửi ảnh chụp màn hình hoặc nội dung cần bổ sung vào ${createdId}`,
      );

      const sendImg = await engine.step({ chatId: CHAT, message: "", mediaPaths: [img2] });
      expect(legacyActionForOutcome(sendImg.outcome)).toBe("confirm_ticket_action");
      expect(sendImg.messages[0].text).toContain("(kèm 1 ảnh/tệp)");

      const done2 = await engine.step({
        chatId: CHAT,
        message: `✅ Bổ sung vào ${createdId}`,
      });
      expect(legacyActionForOutcome(done2.outcome)).toBe("post_create_update");
      expect(it$.calls.uploadAttachment).toContain(img2);
      expect(it$.calls.addComment).toHaveLength(1);
    } finally {
      try {
        fs.unlinkSync(img1);
        fs.unlinkSync(img2);
      } catch {}
    }
  });

  // ── 3. Từ confirmation-and-binding.test.ts ───────────────────────────────────

  it("update_issue: báo updated=false khi cả ghi mô tả lẫn comment đều lỗi, không được báo thành công giả", async () => {
    own(888);
    it$.tracker.updateIssue = async () => {
      throw new Error("db unavailable");
    };
    it$.tracker.addComment = async () => {
      throw new Error("db unavailable");
    };

    const engine = buildEngine({
      commands: interp({
        action: "edit",
        identifier: "TECHTEST-888",
        instruction: "SĐT thành 0900000019",
      }),
      editPlanner: async () => [
        { type: "field", label: "Tài khoản HS / SĐT", value: "0900000019" },
      ],
    });

    await engine.step({
      chatId: CHAT,
      message: "sửa TECHTEST-888 SĐT thành 0900000019",
    });

    // Thao tác sửa bị lỗi khi ghi vào tracker thì không được báo thành công giả
    expect(async () => {
      await engine.step({ chatId: CHAT, message: "✅ Sửa TECHTEST-888" });
    }).toThrow();
  });

  // ── 4. D9: Tra cứu tiến độ không nêu mã ─────────────────────────────────────

  it("D9: tra cứu tiến độ không nêu mã trong cửa sổ 30 phút nhận diện ticket gần nhất", async () => {
    own(795);
    const engine = buildEngine();

    // Hỏi tiến độ tự nhiên trong 30 phút
    const res = await engine.step({
      chatId: CHAT,
      message: "tình trạng thế nào rồi em",
    });
    expect(res.outcome).toBe("lookup");
    expect(legacyActionForOutcome(res.outcome)).toBe("lookup_result");
    expect(res.messages[0].text).toContain("TECHTEST-795");
    expect(res.messages[0].text).toContain("Ticket 795");

    // Quá 30 phút -> hỏi mã cụ thể
    clock.advance(31 * 60_000);
    const expiredRes = await engine.step({
      chatId: CHAT,
      message: "tiến độ tới đâu rồi",
    });
    expect(expiredRes.outcome).toBe("clarify");
    expect(expiredRes.messages[0].text).toContain("mã ticket");
  });
  // ── 5. Review fixes (PR 11 issue #25) ──────────────────────────────────────

  it("kiểm nền khi sửa: ticket bị sửa trên tracker trong lúc chờ xác nhận → từ chối ghi đè (action.edit_conflict_rejected)", async () => {
    own(795);
    const engine = buildEngine({
      commands: interp({
        action: "edit",
        identifier: "TECHTEST-795",
        instruction: "SĐT thành 0900000015",
      }),
      editPlanner: async () => [
        { type: "field", label: "Tài khoản HS / SĐT", value: "0900000015" },
      ],
    });
    const r = await engine.step({
      chatId: CHAT,
      message: "sửa TECHTEST-795 SĐT thành 0900000015",
    });
    expect(legacyActionForOutcome(r.outcome)).toBe("confirm_ticket_action");
    expect(r.messages[0].text).toContain("0900000006 → 0900000015");

    // Kỹ thuật viên cập nhật mô tả trên tracker trong lúc người báo chờ bấm nút
    const issue = it$.issues.get(5795);
    if (issue) {
      issue.description = (issue.description ?? "") + "\nKỹ thuật viên đã cập nhật thêm.";
    }

    // Người báo bấm xác nhận sửa
    const r2 = await engine.step({ chatId: CHAT, message: "✅ Sửa TECHTEST-795" });
    expect(r2.outcome).toBe("action_done");
    expect(r2.messages[0].text).toContain("cập nhật sau khi em lập bản sửa");
    expect(it$.calls.updateIssue).toHaveLength(0);
    expect(drafts.getLatestByChatId(CHAT)?.pendingTicketAction).toBeUndefined();
  });

  it("checkIssueClosed fallback: tracker chỉ có getIssue + listProjectColumns (cột Done) → trả về closed_refusal", async () => {
    const customTracker: TrackerPort = {
      async createIssue() {
        throw new Error("not used");
      },
      async addComment() {
        throw new Error("not used");
      },
      async attach() {
        throw new Error("not used");
      },
      async getIssue(id: number) {
        return {
          id,
          identifier: "TECHTEST-999",
          title: "Ticket đã đóng",
          columnId: 5,
          description: `## Thông tin sự cố\n\n- Người báo: A - telegram:${CHAT}\n\n### Mô tả\n\nLỗi cũ`,
        };
      },
      async listProjectColumns() {
        return [
          { id: 1, name: "Todo", stateType: "unstarted" },
          { id: 5, name: "Done", stateType: "completed" },
        ];
      },
      async findByIdentifier(identifier: string) {
        if (identifier === "TECHTEST-999") {
          return {
            id: 999,
            identifier: "TECHTEST-999",
            title: "Ticket đã đóng",
            columnId: 5,
            description: `## Thông tin sự cố\n\n- Người báo: A - telegram:${CHAT}\n\n### Mô tả\n\nLỗi cũ`,
          };
        }
        return null;
      },
    };

    own(999);
    const engine = buildEngine({
      tracker: customTracker,
      commands: interp({
        action: "append",
        identifier: "TECHTEST-999",
        content: "thêm thông tin này nhé",
      }),
    });

    const res = await engine.step({
      chatId: CHAT,
      message: "bổ sung TECHTEST-999 thêm thông tin này nhé",
    });

    expect(res.outcome).toBe("closed_refusal");
    expect(legacyActionForOutcome(res.outcome)).toBe("post_create_update");
    expect(res.messages[0].text).toContain("hiện đã đóng");
    expect(res.messages[0].text).toContain("Hoàn tất (Done)");
  });

  it("LlmTicketCommandInterpreter cho phép override systemPrompt qua options", async () => {
    let capturedPrompt = "";
    const interpCustom = new LlmTicketCommandInterpreter(
      { baseUrl: "", apiKey: "", model: "m" },
      async (_llm, prompt) => {
        capturedPrompt = prompt;
        return '{"action":"lookup","ticket":"TECHTEST-795"}';
      },
      { systemPrompt: "Custom system prompt for ticket commands" },
    );
    await interpCustom.interpret({
      message: "check TECHTEST-795",
      candidates: [{ identifier: "TECHTEST-795", issueId: 795, ownTicket: true, mentioned: true }],
      attachments: 0,
    });
    expect(capturedPrompt).toBe("Custom system prompt for ticket commands");
  });
});
