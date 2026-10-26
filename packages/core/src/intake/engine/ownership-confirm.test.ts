import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { intakeApplySchema, SqliteDraftRepository } from "../draft";
import { SqliteChannelBindingStore } from "../create";
import { makeCopyCatalog } from "../copy-catalog";
import { tieuLinhCopy } from "../../../examples/tieulinh/copy";
import { engineTestCatalog } from "./catalog.fixture";
import { FakeClock, URGENCY } from "./engine-harness.fixture";
import { IntakeEngine, type IntakeEngineDeps } from "./engine";
import { legacyActionForOutcome } from "./action-map";
import type { TrackerPort, TrackerIssue } from "../ports";
describe("IRIS — chỉ yêu cầu của mình, bổ sung phải xác nhận", () => {
  let db: Database;
  let drafts: SqliteDraftRepository;
  let bindings: SqliteChannelBindingStore;
  let trackerCalls: { addComment: Array<{ issueId: number; content: string }> };
  let issues: Map<number, TrackerIssue>;
  let engine: IntakeEngine;
  let clock: FakeClock;

  beforeEach(() => {
    db = new Database(":memory:");
    intakeApplySchema(db);
    drafts = new SqliteDraftRepository(db);
    bindings = new SqliteChannelBindingStore(db);
    clock = new FakeClock();
    trackerCalls = { addComment: [] };
    issues = new Map<number, TrackerIssue>();

    const issue801: TrackerIssue = {
      id: 801,
      identifier: "PO-80",
      title: "Nút xuất Excel",
      columnId: 8,
      stateType: "unstarted",
      description: "Người báo: A - telegram:111",
    };
    const issue802: TrackerIssue = {
      id: 802,
      identifier: "PO-84",
      title: "Vòng quay may mắn",
      columnId: 7,
      stateType: "backlog",
      description: "Người báo: B - telegram:222",
    };
    issues.set(801, issue801);
    issues.set(802, issue802);

    bindings.saveBinding({
      issueId: 801,
      chatId: "telegram:111",
      identifier: "PO-80",
      title: "Nút xuất Excel",
    });
    bindings.saveBinding({
      issueId: 802,
      chatId: "telegram:222",
      identifier: "PO-84",
      title: "Vòng quay may mắn",
    });

    const tracker: TrackerPort = {
      async createIssue() {
        throw new Error("not used");
      },
      async getIssue(id: number) {
        return issues.get(id) ?? null;
      },
      async addComment(issueId: number, content: string) {
        trackerCalls.addComment.push({ issueId, content });
      },
      async attach() {
        return 0;
      },
      async findByIdentifier(identifier: string) {
        for (const iss of issues.values()) {
          if (iss.identifier.toUpperCase() === identifier.toUpperCase()) return iss;
        }
        return null;
      },
      async listProjectColumns() {
        return [
          { id: 7, name: "Backlog", stateType: "backlog" },
          {
            id: 8,
            name: "Discussion (PO nhặt ticket và bắt đầu trao đổi cùng các bên)",
            stateType: "unstarted",
          },
        ];
      },
      async getIssueTimeline() {
        return [];
      },
    };

    const copy = makeCopyCatalog(tieuLinhCopy);
    const catalog = engineTestCatalog;
    const deps: IntakeEngineDeps = {
      tracker,
      drafts,
      bindings,
      copy,
      clock,
      identifierPrefix: "PO",
      extractor: {
        async extract() {
          return { userIntent: "provide_info" };
        },
      },
      catalog,
      variant: "tech",
      urgencyRules: URGENCY,
    };

    engine = new IntakeEngine(deps);
  });

  it("tra yêu cầu của người khác → không kể gì (kể cả tiêu đề)", async () => {
    const res = await engine.step({
      chatId: "telegram:111",
      message: "PO-84 tới đâu rồi",
    });
    expect(res.outcome).toBe("lookup");
    expect(legacyActionForOutcome(res.outcome)).toBe("lookup_result");
    const text = res.messages[0].text;
    expect(text).toContain("PO-84");
    expect(text).toContain("Backlog");
    expect(text).not.toContain("Vòng quay");
  });

  it("tra yêu cầu của mình → đủ tin, trạng thái PO kèm lời giải thích", async () => {
    const res = await engine.step({
      chatId: "111",
      message: "PO-80 tới đâu rồi",
    });
    expect(res.outcome).toBe("lookup");
    expect(legacyActionForOutcome(res.outcome)).toBe("lookup_result");
    const text = res.messages[0].text;
    expect(text).toContain("PO-80");
    expect(text).toContain("Nút xuất Excel");
    expect(text).toContain("Discussion (PO nhặt ticket và bắt đầu trao đổi cùng các bên)");
  });

  it("không truyền chatId thì không chứng minh được là của mình → từ chối", async () => {
    const res = await engine.step({
      chatId: "",
      message: "PO-80 tới đâu rồi",
    });
    // Không có chatId thì tra cứu không nhận diện được chủ sở hữu
    expect(res.outcome).toBe("lookup");
    expect(res.messages[0].text).not.toContain("Nút xuất Excel");
  });

  it("bổ sung vào yêu cầu người khác → từ chối, không xem trước, không ghi", async () => {
    const res = await engine.step({
      chatId: "telegram:111",
      message: "bổ sung PO-84 thêm ý",
    });
    expect(res.outcome).toBe("not_owner");
    expect(legacyActionForOutcome(res.outcome)).toBe("post_create_update");
    expect(res.messages[0].text).toContain("không phải ticket anh/chị báo");
    expect(trackerCalls.addComment).toHaveLength(0);
  });

  it("bổ sung: lần đầu chỉ xem trước (chưa ghi); bấm xác nhận mới ghi đúng bản đã xem", async () => {
    const preview = await engine.step({
      chatId: "telegram:111",
      message: "bổ sung PO-80 thêm: cần xuất theo tuần",
    });
    expect(preview.outcome).toBe("action_preview");
    expect(legacyActionForOutcome(preview.outcome)).toBe("confirm_ticket_action");
    expect(preview.messages[0].text).toContain("PO-80");
    expect(preview.messages[0].text).toContain("thêm: cần xuất theo tuần");
    expect(trackerCalls.addComment).toHaveLength(0);

    // Xác nhận bằng nhãn nút
    const done = await engine.step({
      chatId: "telegram:111",
      message: "✅ Bổ sung vào PO-80",
    });
    expect(done.outcome).toBe("action_done");
    expect(legacyActionForOutcome(done.outcome)).toBe("post_create_update");
    expect(trackerCalls.addComment).toHaveLength(1);
    expect(trackerCalls.addComment[0].content).toContain("thêm: cần xuất theo tuần");

    // Bấm lại lần nữa → không còn bản chờ, không ghi thêm
    trackerCalls.addComment.length = 0;
    await engine.step({
      chatId: "telegram:111",
      message: "✅ Bổ sung vào PO-80",
    });
    expect(trackerCalls.addComment).toHaveLength(0);
  });

  it("bấm Huỷ → không ghi, bản chờ bị xoá", async () => {
    await engine.step({
      chatId: "telegram:111",
      message: "bổ sung PO-80 thêm ý",
    });
    expect(drafts.getLatestByChatId("telegram:111")?.pendingTicketAction).toBeTruthy();

    const cancelled = await engine.step({
      chatId: "telegram:111",
      message: "Huỷ",
    });
    expect(cancelled.outcome).toBe("action_canceled");
    expect(legacyActionForOutcome(cancelled.outcome)).toBe("canceled");
    expect(trackerCalls.addComment).toHaveLength(0);
    expect(drafts.getLatestByChatId("telegram:111")?.pendingTicketAction).toBeUndefined();
  });
});
