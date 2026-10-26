/**
 * PR 13 của RFC 0002 — Soát thông tin (danh sách, LLM, tự học) (issue #27).
 * Port 6 ca flow từ legacy pipeline.flow.test.ts và kiểm tra chính sách techReviewPolicy (F1-F4).
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { IntakeEngine, type IntakeEngineDeps } from "./engine";
import { legacyActionForOutcome } from "./action-map";
import { ChecklistTechReviewer } from "../review/checklist-review";
import { makeCopyCatalog } from "../copy-catalog";
import { tieuLinhCopy } from "../../../examples/tieulinh/copy";
import { intakeApplySchema, SqliteDraftRepository } from "../draft";
import { SqliteChannelBindingStore } from "../create";
import { notifyApplySchema, SqliteMessageRouteStore } from "../notify";
import { createCatalog } from "../gate/catalog";
import { FakeClock, URGENCY } from "./engine-harness.fixture";
import type {
  TrackerPort,
  TrackerIssue,
  Priority,
  TechReviewInput,
  TechReviewOutput,
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
  let seq = 100;

  const tracker: TrackerPort = {
    async createIssue(payload) {
      seq += 1;
      const id = seq;
      const identifier = `TECHTEST-${id}`;
      calls.createIssue.push(payload);
      const issue: TrackerIssue = {
        id,
        identifier,
        title: payload.title,
        description: payload.description,
        columnId: 1,
        url: `https://mock.itsaplan.test/issues/${identifier}`,
        priority: payload.priority,
      };
      issues.set(id, issue);
      return issue;
    },
    async updateIssue(issueId, patch) {
      calls.updateIssue.push({ issueId, patch });
      const cur = issues.get(issueId);
      if (cur) {
        Object.assign(cur, patch);
      }
    },
    async addComment(issueId: number, content: string): Promise<void> {
      calls.addComment.push({ issueId, content });
    },
    async attach(_issueId, _desc, mediaPaths) {
      calls.uploadAttachment.push(...mediaPaths);
      return mediaPaths.length;
    },
    async getIssue(id) {
      return issues.get(id) ?? null;
    },
    async findByIdentifier(identifier: string) {
      for (const iss of issues.values()) {
        if (iss.identifier === identifier) return iss;
      }
      return null;
    },
  };

  return { calls, tracker, issues };
}

const testCatalog = createCatalog({
  fields: {
    nhanh: {
      tech: {
        ten: "Tech incident",
        truong_mo_dau: "van_de",
        recap: ["van_de", "reportingDept"],
        truong: {
          van_de: {
            bat_buoc: true,
            kieu: "text",
            duoc_hoi: true,
            nhan: "Problem",
            hoi: "What's the problem?",
          },
          reportingDept: {
            bat_buoc: true,
            nen_hoi: true,
            kieu: "enum",
            danh_muc: ["Vận hành", "CSKH", "Kế toán"],
            duoc_hoi: true,
            nhan: "Department",
            hoi: "Which team?",
          },
          system: {
            bat_buoc: false,
            nen_hoi: false,
            kieu: "text",
            duoc_hoi: true,
            nhan: "System",
            hoi: "Which system?",
          },
          studentAccount: {
            bat_buoc: false,
            nen_hoi: false,
            kieu: "text",
            duoc_hoi: true,
            nhan: "Student Account",
            hoi: "Which account?",
          },
        },
      },
    },
  },
});

describe("PR 13 — Soát dữ kiện kỹ thuật trước khi xác nhận (F1-F4)", () => {
  let db: Database;
  let drafts: SqliteDraftRepository;
  let bindings: SqliteChannelBindingStore;
  let routes: SqliteMessageRouteStore;
  let it$: FakeItsaplan;
  let clock: FakeClock;

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

  function reviewer(result: { missing: string[]; question?: string }) {
    const seen: TechReviewInput[] = [];
    return {
      seen,
      review: async (input: TechReviewInput): Promise<TechReviewOutput> => {
        seen.push(input);
        return result;
      },
    };
  }

  function buildEngine(overrides: Partial<IntakeEngineDeps> = {}): IntakeEngine {
    const copy = makeCopyCatalog(tieuLinhCopy);
    const deps: IntakeEngineDeps = {
      tracker: it$.tracker,
      drafts,
      bindings,
      routes,
      copy,
      clock,
      confirm: { minConfirmDelayMs: 0 },
      identifierPrefix: "TECHTEST",
      catalog: testCatalog,
      variant: "tech",
      systemField: "system",
      departmentField: "reportingDept",
      urgencyRules: URGENCY,
      extractor: {
        async extract(input: ExtractInput): Promise<ExtractedFields> {
          const t = input.text.toLowerCase();
          if (t.includes("ok tạo đi") || t.includes("tạo ticket") || t.includes("đúng rồi")) {
            return { userIntent: "confirm" };
          }
          if (t.includes("không có")) {
            return { userIntent: "provide_info", symptoms: [] };
          }
          const values: Record<string, string> = {};
          if (t.includes("vận hành")) {
            values.reportingDept = "Vận hành";
          }
          if (t.includes("0900000005")) {
            values.studentAccount = "0900000005";
          }
          if (t.includes("duo")) {
            values.system = "DUO_Vuihoc";
          }
          if (t.includes("vận hành") || t.includes("dh900002") || t.startsWith("dh")) {
            return {
              userIntent: "provide_info",
              symptoms: t.includes("lỗi") ? [input.text] : [],
              values,
            };
          }
          return {
            userIntent: "report_issue",
            title: "Lỗi app Duo",
            symptoms: [input.text],
            values: { van_de: input.text, ...values },
            identifiers: values.studentAccount
              ? { studentAccount: values.studentAccount }
              : undefined,
          };
        },
      },
      ...overrides,
    };
    return new IntakeEngine(deps);
  }

  async function toSummary(chatId = CHAT, first = REPORT, engineOverride?: IntakeEngine) {
    const engine = engineOverride ?? buildEngine();
    await engine.step({ chatId, message: first });
    const r2 = await engine.step({ chatId, message: "Em bên Vận hành nhé" });
    return r2;
  }

  describe("soát dữ kiện kỹ thuật trước khi xin xác nhận (TECH-759)", () => {
    it("thiếu dữ kiện → hỏi MỘT lượt, câu trả lời vào mô tả rồi mới tóm tắt", async () => {
      const r = reviewer({
        missing: ["mã đơn hàng"],
        question: "Anh/chị cho em xin mã đơn hàng (DH…) nhé ạ.",
      });
      const engine = buildEngine({ techReviewer: r });
      const r1 = await engine.step({ chatId: CHAT, message: REPORT });
      expect(legacyActionForOutcome(r1.outcome)).toBe("ask_missing_field");

      const r2 = await engine.step({ chatId: CHAT, message: "Em bên Vận hành nhé" });
      expect(legacyActionForOutcome(r2.outcome)).toBe("ask_missing_field");
      expect(r2.messages[0].text).toContain("mã đơn hàng");
      expect(r2.messages[0].buttons?.flat().map((b) => b.text)).toContain("Không có");

      // Câu trả lời đọc như một lời báo đầy đủ vẫn là bổ sung, không bị hỏi "sự cố mới hay bổ sung"
      const r3 = await engine.step({
        chatId: CHAT,
        message: "Đơn DH900002 bị lỗi, hạn đang hiện 2026 nhưng đúng phải là 2030",
      });
      expect(legacyActionForOutcome(r3.outcome)).toBe("confirm_summary");
      const d3 = drafts.getLatestByChatId(CHAT);
      expect(d3?.ticket.rawText).toContain("DH900002");
      expect(r.seen.length).toBe(1);

      clock.advance(1000);
      const created = await engine.step({ chatId: CHAT, message: "ok tạo đi" });
      expect(legacyActionForOutcome(created.outcome)).toBe("ticket_created");
      const description = it$.calls.createIssue[0].description as string;
      // Mô tả là nguyên văn MỌI lời kể, không chỉ tin đầu (TECH-972 mất câu trả lời bổ sung)
      expect(description).toContain("không làm bài được");
      expect(description).toContain("DH900002");
    });

    it("câu trả lời chỉ gồm một mã vẫn vào mô tả", async () => {
      const engine = buildEngine({
        techReviewer: reviewer({ missing: ["mã đơn hàng"], question: "Cho em xin mã đơn ạ." }),
      });
      await engine.step({ chatId: CHAT, message: REPORT });
      await engine.step({ chatId: CHAT, message: "Em bên Vận hành nhé" });
      const r3 = await engine.step({ chatId: CHAT, message: "DH900002" });
      expect(legacyActionForOutcome(r3.outcome)).toBe("confirm_summary");
      const d3 = drafts.getLatestByChatId(CHAT);
      expect(d3?.ticket.rawText).toContain("DH900002");
      expect(d3?.ticket.rawText).not.toContain("Vận hành nhé");
    });

    it("mã đơn / link có trong lời báo được đưa vào 'Trường đã có'", async () => {
      const r = reviewer({ missing: [] });
      let known: Record<string, string> = {};
      const engine = buildEngine({
        techReviewer: {
          review: async (input: TechReviewInput) => {
            known = input.known;
            return r.review(input);
          },
        },
      });
      await engine.step({
        chatId: CHAT,
        message: `${REPORT}, đơn DH900006, https://se-care.example.com/x/1`,
      });
      await engine.step({ chatId: CHAT, message: "Em bên Vận hành nhé" });
      expect(known["Mã đơn hàng"]).toBe("DH900006");
      expect(known.Link).toContain("se-care.example.com");
    });

    it("người báo bấm 'Không có' → tóm tắt luôn, không hỏi lại", async () => {
      const engine = buildEngine({
        techReviewer: reviewer({
          missing: ["ảnh báo lỗi"],
          question: "Anh/chị gửi em ảnh báo lỗi nhé.",
        }),
      });
      await engine.step({ chatId: CHAT, message: REPORT });
      await engine.step({ chatId: CHAT, message: "Em bên Vận hành nhé" });
      const r3 = await engine.step({ chatId: CHAT, message: "Không có" });
      expect(legacyActionForOutcome(r3.outcome)).toBe("confirm_summary");
    });

    it("hỏi hết (checklist): một tin có ảnh màn hình, trả lời/'Không có' đều đi tiếp tới tóm tắt", async () => {
      const engine = buildEngine({
        techReviewer: new ChecklistTechReviewer(undefined, makeCopyCatalog(tieuLinhCopy)),
      });
      await engine.step({ chatId: CHAT, message: REPORT });
      const r2 = await engine.step({ chatId: CHAT, message: "Em bên Vận hành nhé" });
      expect(legacyActionForOutcome(r2.outcome)).toBe("ask_missing_field");
      expect(r2.messages[0].text).toContain("Ảnh chụp màn hình");
      expect(r2.messages[0].buttons?.flat().map((b) => b.text)).toContain("Không có");
      const r3 = await engine.step({ chatId: CHAT, message: "Không có" });
      expect(legacyActionForOutcome(r3.outcome)).toBe("confirm_summary");
    });

    it("đủ dữ kiện hoặc soát lỗi → tóm tắt như cũ", async () => {
      const engine1 = buildEngine({ techReviewer: reviewer({ missing: [] }) });
      const r1 = await toSummary("7001", REPORT, engine1);
      expect(legacyActionForOutcome(r1.outcome)).toBe("confirm_summary");

      const engine2 = buildEngine({
        techReviewer: {
          review: async () => {
            throw new Error("LLM chết");
          },
        },
      });
      const r2 = await toSummary("7002", REPORT, engine2);
      expect(legacyActionForOutcome(r2.outcome)).toBe("confirm_summary");
    });
  });

  describe("công tắc chính sách soát (F4: techReviewPolicy)", () => {
    it("policy 'off' → bỏ qua soát thông tin dù techReviewer có mặt", async () => {
      let reviewed = false;
      const engine = buildEngine({
        techReviewPolicy: "off",
        techReviewer: {
          review: async () => {
            reviewed = true;
            return { missing: ["mã đơn"], question: "Xin mã đơn" };
          },
        },
      });
      const r = await toSummary("7003", REPORT, engine);
      expect(reviewed).toBe(false);
      expect(legacyActionForOutcome(r.outcome)).toBe("confirm_summary");
    });

    it("policy 'checklist' mà không tiêm reviewer → tự dùng ChecklistTechReviewer", async () => {
      const engine = buildEngine({
        techReviewPolicy: "checklist",
      });
      await engine.step({ chatId: CHAT, message: REPORT });
      const r2 = await engine.step({ chatId: CHAT, message: "Em bên Vận hành nhé" });
      expect(legacyActionForOutcome(r2.outcome)).toBe("ask_missing_field");
      expect(r2.messages[0].text).toContain("Ảnh chụp màn hình");
    });

    it("policy 'llm' với reviewer → thực thi reviewer bình thường", async () => {
      let called = false;
      const engine = buildEngine({
        techReviewPolicy: "llm",
        techReviewer: {
          review: async () => {
            called = true;
            return { missing: ["link"], question: "Xin link" };
          },
        },
      });
      await engine.step({ chatId: CHAT, message: REPORT });
      const r2 = await engine.step({ chatId: CHAT, message: "Em bên Vận hành nhé" });
      expect(called).toBe(true);
      expect(r2.messages[0].text).toContain("Xin link");
    });
  });
});
