/**
 * PR 12 của RFC 0002 — Huỷ và đóng ticket theo yêu cầu người báo (ADR-0006).
 * Port 12 ca test từ legacy: 7 ca flow (pipeline.flow.test.ts) và 5 ca router (ticket-reply-router.test.ts).
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { IntakeEngine, type IntakeEngineDeps } from "./engine";
import { legacyActionForOutcome } from "./action-map";
import { LlmTicketCommandInterpreter } from "./command-interpreter";
import {
  classifyCancelOrCloseIntent,
  isCancelOrCloseTicketRequest,
  countSpecialistTimelineComments,
  MIN_SPECIALIST_COMMENTS_FOR_DONE,
} from "./text";
import { makeCopyCatalog } from "../copy-catalog";
import { tieuLinhCopy } from "../../../examples/tieulinh/copy";
import { DEFAULT_TIEULINH_IGNORED_ACTORS } from "../../../examples/tieulinh/engine-config";
import { intakeApplySchema, SqliteDraftRepository } from "../draft";
import { SqliteChannelBindingStore } from "../create";
import { notifyApplySchema, SqliteMessageRouteStore } from "../notify";
import { createCatalog } from "../gate/catalog";
import { FakeClock, URGENCY } from "./engine-harness.fixture";
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
    async getIssueTimeline(issueId: number) {
      return itObj.timelines.get(issueId) ?? [];
    },
    async listProjectColumns() {
      return [
        { id: 1, name: "Backlog", stateType: "backlog" },
        { id: 2, name: "Todo", stateType: "unstarted" },
        { id: 3, name: "In Progress", stateType: "started" },
        { id: 6, name: "Resolved", stateType: "started" },
        { id: 4, name: "Done", stateType: "completed" },
        { id: 5, name: "Canceled", stateType: "canceled" },
      ];
    },
    async getProjectAssignees() {
      const assignees = [];
      for (let i = 0; i < 10; i++) {
        assignees.push({
          userId: `u-tech-${i}`,
          name: `Tech_Specialist_${i}`,
          username: `tech_specialist_${i}`,
          kind: "member",
        });
      }
      return assignees;
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

describe("RFC 0002 PR 12 — Huỷ và đóng ticket theo yêu cầu người báo (ADR-0006)", () => {
  let db: Database;
  let drafts: SqliteDraftRepository;
  let bindings: SqliteChannelBindingStore;
  let routes: SqliteMessageRouteStore;
  let it$: FakeItsaplan;
  let clock: FakeClock;

  const own = (n: number) => {
    const id = n > 1000 ? n : 5000 + n;
    it$.issues.set(id, {
      id,
      identifier: `TECHTEST-${n}`,
      title: `Ticket ${n}`,
      columnId: 2,
      description: `## Thông tin sự cố\n\n- Người báo: A - telegram:${CHAT}\n- Tài khoản HS / SĐT: 0900000006\n- Bộ phận: CSKH\n\n### Mô tả\n\n> Khoá gia hạn sai hạn\n\n---`,
    });
    bindings.saveBinding({
      issueId: id,
      chatId: CHAT,
      identifier: `TECHTEST-${n}`,
      title: `Ticket ${n}`,
    });
  };

  const setupTechColumnsAndIssue = (opts: {
    columnId: number;
    specialistComments: number;
    issueId?: number;
    identifier?: string;
  }) => {
    const issueId = opts.issueId ?? 5951;
    const identifier = opts.identifier ?? "TECHTEST-951";
    it$.tracker.listProjectColumns = async () => [
      { id: 1, name: "Backlog", stateType: "backlog" },
      { id: 2, name: "Todo", stateType: "unstarted" },
      { id: 3, name: "In Progress", stateType: "started" },
      { id: 6, name: "Resolved", stateType: "started" },
      { id: 4, name: "Done", stateType: "completed" },
      { id: 5, name: "Canceled", stateType: "canceled" },
    ];
    it$.issues.set(issueId, {
      id: issueId,
      identifier,
      title: `Ticket ${identifier}`,
      columnId: opts.columnId,
      description: `## Thông tin sự cố\n\n- Người báo: A - telegram:${CHAT}\n- Tài khoản HS / SĐT: 0900000006\n- Bộ phận: CSKH\n\n### Mô tả\n\n> Khoá gia hạn sai hạn\n\n---`,
    });

    const timeline: unknown[] = [];
    for (let i = 0; i < opts.specialistComments; i++) {
      timeline.push({
        kind: "comment",
        actorUserId: `u-tech-${i}`,
        actorName: `Tech_Specialist_${i}`,
        actorUsername: `tech_specialist_${i}`,
        body: `Bình luận chuyên viên kỹ thuật ${i + 1}`,
      });
    }
    // Thêm bình luận bot và người báo (không được tính là chuyên viên)
    timeline.push(
      {
        kind: "comment",
        actorUserId: "u-bot",
        actorName: "Tiểu Linh",
        body: "**SA_User*** bổ sung:\nthông tin thêm\n\n<!-- intake-bot -->",
      },
      {
        kind: "comment",
        actorUserId: "u-rep",
        actorName: "SA_User***",
        body: "Bình luận của người báo",
      },
    );
    it$.timelines.set(issueId, timeline);
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
          return {
            userIntent: "report_issue",
            title: "Lỗi test",
            values: { van_de: input.text },
          };
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
    it$ = fakeItsaplan();
    clock = new FakeClock();
  });

  describe("7 ca flow (pipeline.flow.test.ts)", () => {
    it("hủy rõ (chưa xử lý / đang xử lý dở kể cả có ≥3 comment chuyên viên / đã xử lý Resolved) → luôn chuyển Canceled (cột 5) + escapeItsaplanMarkdown", async () => {
      own(951);
      for (const [colId, specCount, msg] of [
        [2, 0, "Hủy TECHTEST-951"],
        [3, 4, "hủy TECHTEST-951 vì học sinh <P***> đã vào được rồi"],
        [6, 3, "TECHTEST-951 không cần sửa nữa ạ"],
      ] as const) {
        it$.calls.updateIssue.length = 0;
        it$.calls.addComment.length = 0;
        setupTechColumnsAndIssue({
          columnId: colId,
          specialistComments: specCount,
          issueId: 5951,
          identifier: "TECHTEST-951",
        });
        const engine = buildEngine({
          commands: interp({
            action: "cancel_or_close",
            identifier: "TECHTEST-951",
            content: msg,
            intent: "cancel",
          }),
        });
        const preview = await engine.step({
          chatId: CHAT,
          message: msg,
          reporter: { name: "SA_User***" },
        });
        expect(legacyActionForOutcome(preview.outcome)).toBe("confirm_ticket_action");
        const btnTexts = preview.messages[0].buttons?.flat().map((b) => b.text) ?? [];
        expect(btnTexts).toEqual(["✅ Hủy TECHTEST-951", "Giữ lại"]);
        expect(btnTexts).not.toContain("Huỷ");
        expect(it$.calls.updateIssue).toHaveLength(0);
        expect(it$.calls.addComment).toHaveLength(0);

        const done = await engine.step({
          chatId: CHAT,
          message: "✅ Hủy TECHTEST-951",
          reporter: { name: "SA_User***" },
        });
        expect(legacyActionForOutcome(done.outcome)).toBe("post_create_update");
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
        setupTechColumnsAndIssue({
          columnId: 3,
          specialistComments: specCount,
          issueId: 5999,
          identifier: "TECHTEST-999",
        });
        const engine = buildEngine({
          commands: interp({
            action: "cancel_or_close",
            identifier: "TECHTEST-999",
            content: "Đóng ticket TECHTEST-999",
            intent: "close",
          }),
        });
        const preview = await engine.step({ chatId: CHAT, message: "Đóng ticket TECHTEST-999" });
        expect(legacyActionForOutcome(preview.outcome)).toBe("confirm_ticket_action");
        expect(preview.messages[0].buttons?.flat().map((b) => b.text)).toEqual([
          "✅ Hủy TECHTEST-999",
          "Giữ lại",
        ]);
        const executed = await engine.step({ chatId: CHAT, message: "✅ Hủy TECHTEST-999" });
        expect(legacyActionForOutcome(executed.outcome)).toBe("post_create_update");
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
        setupTechColumnsAndIssue({
          columnId: colId,
          specialistComments: specCount,
          issueId: 5999,
          identifier: "TECHTEST-999",
        });
        const engine = buildEngine({
          commands: interp({
            action: "cancel_or_close",
            identifier: "TECHTEST-999",
            content: msg,
            intent: "close",
          }),
        });
        const preview = await engine.step({
          chatId: CHAT,
          message: msg,
          reporter: { name: "SC_User***" },
        });
        expect(legacyActionForOutcome(preview.outcome)).toBe("confirm_ticket_action");
        expect(preview.messages[0].buttons?.flat().map((b) => b.text)).toEqual([
          "✅ Đóng TECHTEST-999",
          "Giữ lại",
        ]);

        const executed = await engine.step({
          chatId: CHAT,
          message: "✅ Đóng TECHTEST-999",
          reporter: { name: "SC_User***" },
        });
        expect(legacyActionForOutcome(executed.outcome)).toBe("post_create_update");
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
        setupTechColumnsAndIssue({
          columnId: colId,
          specialistComments: 4,
          issueId: 5999,
          identifier: "TECHTEST-999",
        });
        const engine = buildEngine({
          commands: interp({
            action: "cancel_or_close",
            identifier: "TECHTEST-999",
            content: "Đóng ticket TECHTEST-999",
            intent: "close",
          }),
        });
        const res = await engine.step({ chatId: CHAT, message: "Đóng ticket TECHTEST-999" });
        expect(legacyActionForOutcome(res.outcome)).toBe("post_create_update");
        expect(res.messages[0].text).toContain("hiện đã đóng");
        expect(it$.calls.updateIssue).toHaveLength(0);
        expect(it$.calls.addComment).toHaveLength(0);
      }
    });

    it("không phải chủ ticket (ownTicket = false) → từ chối hủy/đóng, không đổi cột, không ghi comment", async () => {
      setupTechColumnsAndIssue({
        columnId: 3,
        specialistComments: 4,
        issueId: 5777,
        identifier: "TECHTEST-777",
      });
      const engine = buildEngine({
        commands: interp({
          action: "cancel_or_close",
          identifier: "TECHTEST-777",
          content: "Hủy TECHTEST-777",
          intent: "cancel",
        }),
      });
      const res = await engine.step({ chatId: CHAT, message: "Hủy TECHTEST-777" });
      expect(legacyActionForOutcome(res.outcome)).toBe("post_create_update");
      expect(res.messages[0].text).toContain("không phải ticket anh/chị báo");
      expect(it$.calls.updateIssue).toHaveLength(0);
      expect(it$.calls.addComment).toHaveLength(0);
    });

    it("bấm nút 'Giữ lại' hoặc fallback trong proposeEdit khi ops=[] hoạt động chuẩn, và chốt chặn không bao giờ chuyển Done khi chưa đủ điều kiện", async () => {
      own(951);
      setupTechColumnsAndIssue({
        columnId: 3,
        specialistComments: 1,
        issueId: 5951,
        identifier: "TECHTEST-951",
      });
      // Fallback khi bộ đọc lệnh trả nhầm 'edit' và editPlanner trả ops = []
      let engine = buildEngine({
        commands: interp({
          action: "edit",
          identifier: "TECHTEST-951",
          instruction: "Hủy TECHTEST-951",
        }),
        editPlanner: async () => [],
      });
      const preview = await engine.step({ chatId: CHAT, message: "Hủy TECHTEST-951" });
      expect(legacyActionForOutcome(preview.outcome)).toBe("confirm_ticket_action");
      expect(preview.messages[0].buttons?.flat().map((b) => b.text)).toEqual([
        "✅ Hủy TECHTEST-951",
        "Giữ lại",
      ]);

      const aborted = await engine.step({ chatId: CHAT, message: "Giữ lại" });
      expect(legacyActionForOutcome(aborted.outcome)).toBe("canceled");
      expect(aborted.messages[0].text).toContain("giữ nguyên TECHTEST-951");
      expect(it$.calls.updateIssue).toHaveLength(0);
      expect(it$.calls.addComment).toHaveLength(0);

      // Chốt chặn an toàn: lúc hiện nút đang ở Resolved (1 comment), nhưng trước khi bấm xác nhận bị kéo lại In Progress (1 comment < 3) → không được chuyển Done!
      own(999);
      setupTechColumnsAndIssue({
        columnId: 6,
        specialistComments: 1,
        issueId: 5999,
        identifier: "TECHTEST-999",
      });
      engine = buildEngine({
        commands: interp({
          action: "cancel_or_close",
          identifier: "TECHTEST-999",
          content: "Đóng ticket TECHTEST-999",
          intent: "close",
        }),
      });
      const askDone = await engine.step({ chatId: CHAT, message: "Đóng ticket TECHTEST-999" });
      expect(askDone.messages[0].buttons?.flat().map((b) => b.text)).toEqual([
        "✅ Đóng TECHTEST-999",
        "Giữ lại",
      ]);
      // Chuyên viên kéo ngược từ Resolved (6) về In Progress (3) và chỉ có 1 comment chuyên viên
      setupTechColumnsAndIssue({
        columnId: 3,
        specialistComments: 1,
        issueId: 5999,
        identifier: "TECHTEST-999",
      });
      await engine.step({ chatId: CHAT, message: "✅ Đóng TECHTEST-999" });
      expect(it$.calls.updateIssue).toEqual([{ issueId: 5999, patch: { columnId: 5 } }]);
    });

    it("người khác (chat khác) không bấm hộ nút xác nhận hủy được; câu mô tả sự cố có chữ đóng/hủy khi unclear hỏi lại Bổ sung/Sự cố mới chứ không hủy vé", async () => {
      own(951);
      setupTechColumnsAndIssue({
        columnId: 3,
        specialistComments: 2,
        issueId: 5951,
        identifier: "TECHTEST-951",
      });
      const engine = buildEngine({
        commands: {
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
      const preview = await engine.step({ chatId: CHAT, message: "Hủy TECHTEST-951" });
      expect(preview.messages[0].buttons?.flat().map((b) => b.text)).toEqual([
        "✅ Hủy TECHTEST-951",
        "Giữ lại",
      ]);

      // Người lạ ở chat khác gửi đúng chuỗi callback "✅ Hủy TECHTEST-951" → không thực thi hủy vé của CHAT
      const stranger = await engine.step({
        chatId: "telegram:88888",
        message: "✅ Hủy TECHTEST-951",
      });
      expect(legacyActionForOutcome(stranger.outcome)).not.toBe("confirm_ticket_action");
      expect(it$.calls.updateIssue).toHaveLength(0);
      expect(it$.calls.addComment).toHaveLength(0);

      // Huỷ bản xem trước hiện tại của CHAT rồi gửi câu mô tả sự cố có chữ đóng/hủy khi LLM trả unclear → chỉ hỏi Bổ sung / Sự cố mới
      await engine.step({ chatId: CHAT, message: "Giữ lại" });
      for (const bugMsg of [
        "TECHTEST-951: khi bấm đóng cửa sổ thì màn hình bị đóng băng",
        "TECHTEST-951: phụ huynh báo hủy đơn hàng của học sinh không được",
        "TECHTEST-951: chương trình đóng/hủy lớp báo lỗi",
      ]) {
        const ask = await engine.step({ chatId: CHAT, message: bugMsg });
        expect(legacyActionForOutcome(ask.outcome)).toBe("confirm_ticket_action");
        expect(ask.messages[0].buttons?.flat().map((b) => b.text)).toEqual([
          "✅ Bổ sung vào TECHTEST-951",
          "Sự cố mới",
        ]);
        await engine.step({ chatId: CHAT, message: "Huỷ" });
      }
      expect(it$.calls.updateIssue).toHaveLength(0);
    });
  });

  describe("3 bản sửa của coordinator sau vòng soi", () => {
    it("ô #7 — ticket đã đóng TRƯỚC khi bấm nút xác nhận thì từ chối, không đổi cột", async () => {
      // Lúc hiện bản xem trước ticket còn mở; bấm xác nhận thì nó đã bị đóng.
      own(999);
      setupTechColumnsAndIssue({ columnId: 3, specialistComments: 4 });
      const engine = buildEngine();
      await engine.step({ chatId: CHAT, message: "Đóng ticket TECHTEST-999" });
      // Chuyên viên đóng ticket trong lúc người báo đang nhìn bản xem trước.
      const issue999 = it$.issues.get(5999);
      if (!issue999) throw new Error("thiếu issue 5999 trong fake tracker");
      issue999.columnId = 4; // cột Done
      it$.calls.updateIssue.length = 0;
      it$.calls.addComment.length = 0;
      const out = await engine.step({ chatId: CHAT, message: "✅ Đóng TECHTEST-999" });
      expect(out.outcome).toBe("closed_refusal");
      expect(out.messages[0].text).toContain("TECHTEST-999");
      // Không chuyển cột, không ghi comment.
      expect(it$.calls.updateIssue).toHaveLength(0);
      expect(it$.calls.addComment).toHaveLength(0);
    });

    it("ảnh đi kèm lệnh huỷ KHÔNG ghi đè mô tả ticket (ADR-0010)", async () => {
      // `tracker.attach` GHI ĐÈ mô tả ticket bằng chuỗi truyền vào — truyền ""
      // sẽ xoá sạch mô tả gốc của người báo. Ảnh phải đi vào COMMENT.
      own(951);
      setupTechColumnsAndIssue({ columnId: 2, specialistComments: 0 });
      const engine = buildEngine({
        tracker: {
          ...it$.tracker,
          async uploadMedia(_issueId: number, files: string[]) {
            return files.map((f) => ({ filename: f, markdown: `![${f}](http://x/${f})` }));
          },
        } as TrackerPort,
      });
      await engine.step({ chatId: CHAT, message: "Hủy TECHTEST-951" });
      await engine.step({
        chatId: CHAT,
        message: "✅ Hủy TECHTEST-951",
        mediaPaths: ["/tmp/evidence.png"],
      });
      // Không lần nào ghi đè mô tả ticket.
      const descPatches = it$.calls.updateIssue.filter((c) => "description" in c.patch);
      expect(descPatches).toHaveLength(0);
      // Ảnh tới được người báo qua comment dấu vết, không qua mô tả.
      expect(it$.calls.addComment.at(-1)?.content).toContain("evidence.png");
    });

    it("app không có cổng uploadMedia thì ảnh bị bỏ, KHÔNG ghi đè mô tả ticket", async () => {
      own(951);
      setupTechColumnsAndIssue({ columnId: 2, specialistComments: 0 });
      const engine = buildEngine();
      await engine.step({ chatId: CHAT, message: "Hủy TECHTEST-951" });
      await engine.step({
        chatId: CHAT,
        message: "✅ Hủy TECHTEST-951",
        mediaPaths: ["/tmp/evidence.png"],
      });
      const descPatches = it$.calls.updateIssue.filter((c) => "description" in c.patch);
      expect(descPatches).toHaveLength(0);
    });

    it("thiếu cột đích thì trả lời lịch sự, KHÔNG ném lỗi ra khỏi step()", async () => {
      // Ném lỗi sẽ làm mất lượt chat của người báo — không có phản hồi nào.
      own(951);
      setupTechColumnsAndIssue({ columnId: 2, specialistComments: 0 });
      const engine = buildEngine({
        tracker: {
          ...it$.tracker,
          async listProjectColumns() {
            return [];
          },
        } as TrackerPort,
      });
      await engine.step({ chatId: CHAT, message: "Hủy TECHTEST-951" });
      const out = await engine.step({ chatId: CHAT, message: "✅ Hủy TECHTEST-951" });
      expect(out.messages.length).toBeGreaterThan(0);
      expect(out.messages[0].text).toContain("TECHTEST-951");
      // Không chuyển cột nào khi không tìm thấy cột đích.
      expect(it$.calls.updateIssue).toHaveLength(0);
    });

    it("comment dấu vết KHÔNG ghi chat ID (chat ID là dữ liệu riêng của kênh)", async () => {
      // Repo công khai: chat ID không được ghi vào ticket. Legacy dùng "Người báo".
      own(951);
      setupTechColumnsAndIssue({ columnId: 2, specialistComments: 0 });
      const engine = buildEngine();
      await engine.step({ chatId: CHAT, message: "Hủy TECHTEST-951" });
      await engine.step({ chatId: CHAT, message: "✅ Hủy TECHTEST-951" });
      const trace = it$.calls.addComment.at(-1)?.content ?? "";
      expect(trace).not.toContain(CHAT);
      expect(trace).toContain("Người báo");
    });

    it("core không hardcode chuỗi tiếng Việt cho nhãn hành động và trạng thái", () => {
      // Nguyên tắc repo: mọi chuỗi gửi người báo (kể cả chuỗi ghi vào comment
      // trên ticket) phải đi qua CopyCatalog.
      const engineSrc = readFileSync(new URL("./engine.ts", import.meta.url).pathname, "utf8");
      expect(engineSrc).not.toMatch(/"đóng"|"hủy"|"Done"|"Canceled"/);
    });
  });

  describe("5 ca phân loại (ticket-reply-router.test.ts)", () => {
    const llm = { baseUrl: "", apiKey: "", model: "m" };
    const cand: ReplyCandidate = {
      identifier: "TECH-795",
      issueId: 795,
      ownTicket: true,
      mentioned: true,
    };
    const cand951: ReplyCandidate = {
      identifier: "TECH-951",
      issueId: 824,
      ownTicket: true,
      mentioned: true,
    };
    const cand999: ReplyCandidate = {
      identifier: "TECH-999",
      issueId: 872,
      ownTicket: true,
      mentioned: true,
    };
    const cand1126: ReplyCandidate = {
      identifier: "TECH-1126",
      issueId: 1009,
      ownTicket: true,
      mentioned: true,
    };
    const cand1162: ReplyCandidate = {
      identifier: "TECH-1162",
      issueId: 1048,
      ownTicket: true,
      mentioned: false,
      recentlyRelayed: true,
    };
    const cand509: ReplyCandidate = {
      identifier: "TECH-509",
      issueId: 509,
      ownTicket: true,
      mentioned: true,
    };

    it("phân loại tất định các câu thật yêu cầu HỦY rõ → intent = 'cancel'", () => {
      const cancelCases = [
        "Hủy TECH-951",
        "Mình muốn hủy ticket TECH-951",
        "Hủy ticket TECH-951",
        "hủy TECH-951 vì học sinh đã vào được rồi",
        "hủy ticket TECH-999",
        "hủy ticket TECH-1126",
        "TECH-1126 dự kiến sẽ điều chỉnh sang form mới, nên không cần sửa nữa ạ",
        "HỦY ticket TECH-509",
        "TECH-926 crm mình gọi đc r, hủy ticket giúp mình",
        "bỏ ticket TECH-951",
        "TECH-951 không cần nữa ạ",
        "TECH-951 hủy giúp em nhé",
      ];
      for (const msg of cancelCases) {
        expect(isCancelOrCloseTicketRequest(msg)).toBe(true);
        expect(classifyCancelOrCloseIntent(msg)).toBe("cancel");
      }
    });

    it("phân loại tất định các câu yêu cầu ĐÓNG / báo đã dùng được (không kèm từ hủy) → intent = 'close'", () => {
      const closeCases = [
        "Đóng ticket TECH-999",
        "được rồi ạ, có thể đóc ticket TECH-999",
        "xin đóng TECH-999",
        "TECH-999 học sinh đã vào được rồi",
        "TECH-999 HS đã dùng được",
        "TECH-999 đã ổn rồi ạ",
      ];
      for (const msg of closeCases) {
        expect(isCancelOrCloseTicketRequest(msg)).toBe(true);
        expect(classifyCancelOrCloseIntent(msg)).toBe("close");
      }
    });

    it("không bắt nhầm câu sửa thật, chuyển ticket trùng, câu thiếu mã ticket hay mô tả sự cố có chữ hủy/đóng (≥20 câu thực tế)", () => {
      const nonCancelCases = [
        // Câu thiếu mã ticket (bắt buộc phải hỏi lại, không tự đoán):
        "không cần sửa nữa",
        "đóng cửa sổ",
        "hủy đơn hàng của học sinh",
        "đóng băng",
        "chương trình đóng/hủy lớp",
        "crm mình gọi đc r, hủy ticket giudp mình",
        // Câu mô tả sự cố thực tế có chữ hủy / đóng / vào được / ổn (không mã và có mã ticket):
        "Khi bấm đóng cửa sổ popup thì màn hình bị trắng xóa",
        "Em nhờ kỹ thuật hủy đơn hàng DH900002 của học sinh 0900000005 để tạo lại đơn mới",
        "Tài khoản học sinh đang bị đóng băng không mở khóa được",
        "Chương trình đóng/hủy lớp trên CRM báo lỗi 500",
        "Phụ huynh bấm nút hủy trên màn hình thanh toán thì bị treo",
        "Nhờ hỗ trợ đóng băng gói học cho học sinh Nguyễn Văn A",
        "Khi giáo viên đóng phòng học ROOM-5511 trên Zoom thì học sinh vẫn kẹt trong phòng",
        "Lỗi không hủy được quyền truy cập của giáo viên cũ trên CMS",
        "Học sinh vào được rồi nhưng sau 5 phút lại bị văng ra khỏi phòng học",
        "Lúc sáng đã vào được bình thường nhưng chiều nay lại báo lỗi không kết nối được",
        "Mạng nhà học sinh đã ổn rồi nhưng vào app Vuihoc vẫn quay tròn không tải được bài",
        "TECH-951 bổ sung: khi học sinh bấm đóng cửa sổ bài tập thì bị văng ra ngoài",
        "TECH-951 khách báo hủy gói cước gia hạn tự động không hoạt động",
        "TECH-999 học sinh vào được rồi nhưng không nghe thấy tiếng giáo viên",
        "TECH-999 lỗi giống lúc đóng băng bảo lưu tài khoản học sinh",
        "Bổ sung TECH-951: phần mềm tự đóng khi mở video bài giảng",
        "TECH-951: nút hủy bài kiểm tra bị liệt không bấm được",
        "TECH-951: nhờ tech hủy kích hoạt mã thẻ học thử giúp em",
        "TECH-951: giáo viên báo câu 3 không cần sửa nữa mà câu 4 bị lỗi hiển thị",
        "TECH-951: phụ huynh muốn hủy đơn hàng của học sinh",
        "TECH-951: chương trình đóng/hủy lớp không bấm được",
        "Lỗi giống TECH-951, học sinh đóng cửa sổ xong không mở lại được",
        // Câu sửa thật, gộp vé trùng, tra cứu, mơ hồ:
        "sửa TECH-795 SĐT thành 0900000015",
        "sửa mô tả TECH-795 thành học sinh không vào được phòng học",
        "đổi tiêu đề TECH-795 thành Lỗi đóng học phí",
        "sửa TECH-795: phụ huynh báo hủy lịch học",
        "nhầm rồi, cái này bổ sung cho TECH-795",
        "Đơn hàng gia hạn ạ",
        "TECH-795 học sinh vẫn không vào được",
        "TECH-795 tới đâu rồi",
        "TECH-795 ạ",
      ];
      for (const msg of nonCancelCases) {
        expect(isCancelOrCloseTicketRequest(msg)).toBe(false);
        expect(classifyCancelOrCloseIntent(msg)).toBeNull();
      }
    });

    it("LlmTicketCommandInterpreter định tuyến tất định sang cancel_or_close kể cả khi LLM trả edit / unclear", async () => {
      const misclassifiedEdit = new LlmTicketCommandInterpreter(
        llm,
        async () => '{"action":"edit","ticket":"TECH-951","instruction":"Hủy TECH-951"}',
      );
      expect(
        await misclassifiedEdit.interpret({
          message: "Hủy TECH-951",
          attachments: 0,
          candidates: [cand951],
        }),
      ).toEqual({
        action: "cancel_or_close",
        identifier: "TECH-951",
        content: "Hủy TECH-951",
        intent: "cancel",
      });
      expect(
        await misclassifiedEdit.interpret({
          message: "hủy TECH-951 vì học sinh đã vào được rồi",
          attachments: 0,
          candidates: [cand951],
        }),
      ).toEqual({
        action: "cancel_or_close",
        identifier: "TECH-951",
        content: "hủy TECH-951 vì học sinh đã vào được rồi",
        intent: "cancel",
      });

      const misclassifiedUnclear = new LlmTicketCommandInterpreter(
        llm,
        async () => '{"action":"unclear"}',
      );
      expect(
        await misclassifiedUnclear.interpret({
          message: "Đóng ticket TECH-999",
          attachments: 0,
          candidates: [cand999],
        }),
      ).toEqual({
        action: "cancel_or_close",
        identifier: "TECH-999",
        content: "Đóng ticket TECH-999",
        intent: "close",
      });
      expect(
        await misclassifiedUnclear.interpret({
          message: "được rồi ạ, có thể đóc ticket TECH-999",
          attachments: 0,
          candidates: [cand999],
        }),
      ).toEqual({
        action: "cancel_or_close",
        identifier: "TECH-999",
        content: "được rồi ạ, có thể đóc ticket TECH-999",
        intent: "close",
      });
      expect(
        await misclassifiedUnclear.interpret({
          message: "hủy ticket TECH-1126",
          attachments: 0,
          candidates: [cand1126],
        }),
      ).toEqual({
        action: "cancel_or_close",
        identifier: "TECH-1126",
        content: "hủy ticket TECH-1126",
        intent: "cancel",
      });
      // Ưu tiên ticket được nhắc mã (TECH-509) thay vì ticket khác vừa chuyển tiếp (TECH-1162).
      expect(
        await misclassifiedUnclear.interpret({
          message: "HỦY ticket TECH-509",
          attachments: 0,
          candidates: [cand1162, cand509],
        }),
      ).toEqual({
        action: "cancel_or_close",
        identifier: "TECH-509",
        content: "HỦY ticket TECH-509",
        intent: "cancel",
      });

      // Câu sửa mô tả thật vẫn là edit; câu mơ hồ vẫn là unclear.
      const editInterp = new LlmTicketCommandInterpreter(
        llm,
        async () =>
          '{"action":"edit","ticket":"TECH-795","instruction":"sửa mô tả thành học sinh không mở được bài"}',
      );
      expect(
        await editInterp.interpret({
          message: "sửa mô tả TECH-795 thành học sinh không mở được bài",
          attachments: 0,
          candidates: [cand],
        }),
      ).toEqual({
        action: "edit",
        identifier: "TECH-795",
        instruction: "sửa mô tả thành học sinh không mở được bài",
      });
      expect(
        await misclassifiedUnclear.interpret({
          message: "TECH-795 ạ",
          attachments: 0,
          candidates: [cand],
        }),
      ).toEqual({ action: "unclear" });
      // Không có mã ticket trong câu hoặc câu mô tả sự cố có chữ đóng/hủy → không tự đoán cancel_or_close.
      const hallucinatedCancel = new LlmTicketCommandInterpreter(
        llm,
        async () =>
          '{"action":"cancel_or_close","ticket":"TECH-1162","content":"không cần sửa nữa"}',
      );
      expect(
        await hallucinatedCancel.interpret({
          message: "không cần sửa nữa",
          attachments: 0,
          candidates: [cand1162],
        }),
      ).toEqual({ action: "unclear" });
      const appendInterp = new LlmTicketCommandInterpreter(
        llm,
        async () =>
          '{"action":"append","ticket":"TECH-951","content":"khi bấm đóng cửa sổ thì bị đóng băng"}',
      );
      expect(
        await appendInterp.interpret({
          message: "TECH-951: khi bấm đóng cửa sổ thì bị đóng băng",
          attachments: 0,
          candidates: [cand951],
        }),
      ).toEqual({
        action: "append",
        identifier: "TECH-951",
        content: "khi bấm đóng cửa sổ thì bị đóng băng",
      });
    });

    it("countSpecialistTimelineComments chỉ đếm bình luận của chuyên viên TECH, loại bỏ bot và người báo", () => {
      expect(MIN_SPECIALIST_COMMENTS_FOR_DONE).toBe(3);
      const timeline = [
        {
          kind: "comment",
          actorUserId: "u-techlead-a",
          actorName: "TechLead_A",
          body: "@tieulinh Bạn gửi thêm danh sách lớp nhé",
        },
        {
          kind: "comment",
          actorUserId: "u-bot",
          actorName: "Tiểu Linh",
          body: "**SA_User*** bổ sung:\ndanh sách lớp\n\n<!-- intake-bot -->",
        },
        {
          kind: "comment",
          actorUserId: "u-bot2",
          actorName: "VUIHOC Tiểu Linh",
          body: "Thông báo tự động",
        },
        { kind: "comment", actorUserId: "u-admin", actorName: "admin", body: "script cập nhật" },
        { kind: "comment", actorUserId: "u-rep", actorName: "SA_User***", body: "Em gửi thêm" },
        {
          kind: "comment",
          actorUserId: "u-techlead-a",
          actorName: "TechLead_A",
          body: "@techuser_i Kiểm tra lại DB",
        },
        { kind: "comment", actorUserId: "u-loc", actorName: "TechUser_I", body: "Đã đồng bộ xong" },
        { kind: "activity", actorName: "TechLead_A", body: "status changed" },
      ];
      expect(
        countSpecialistTimelineComments(timeline, {
          // Danh sách bot của APP — data miền, app truyền vào (core không hardcode).
          ignoredActors: DEFAULT_TIEULINH_IGNORED_ACTORS,
          reporterNames: ["SA_User***"],
          projectAssignees: [
            { userId: "u-techlead-a", name: "TechLead_A", username: "techlead_a", kind: "member" },
            { userId: "u-loc", name: "TechUser_I", username: "techuser_i", kind: "member" },
            { userId: "u-bot", name: "Tiểu Linh", username: "tieulinh", kind: "agent" },
            {
              userId: "u-bot2",
              name: "VUIHOC Tiểu Linh",
              username: "bot-ticket-intake",
              kind: "member",
            },
          ],
        }),
      ).toBe(3);
    });
  });
});
