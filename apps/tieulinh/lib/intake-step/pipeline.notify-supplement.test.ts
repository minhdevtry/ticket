/**
 * Tests for W29-NOTIFY (06/10/2026):
 * 1. in-progress → mention assignee
 * 2. no assignee → mention last technician commenter or none
 * 3. closed → no append, reporter told to create a new ticket
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { applySchema } from "../storage/schema";
import { IntakeDocumentRepository } from "../intake-document/repository";
import { TicketBindingRepository } from "../storage/binding-repository";
import { DraftSessionRepository } from "../storage/session-repository";
import { FieldExtractor } from "./extractor";
import { IntakeStepPipeline, type IntakePipelineOptions } from "./pipeline";
import type {
  ItsaplanClient,
  ItsaplanIssue,
  ProjectAssignee,
  ProjectColumn,
} from "@vuihoc/bot-core/itsaplan";
import type { IntakeDocument } from "../intake-document/types";
import type { ValidationRules, FieldRequirementsTable, UrgencyRules } from "../../mcp/shared/index";
import validationRules from "../../mcp/tieulinh/domain/validation-rules.json";
import fieldRequirements from "../../mcp/tieulinh/domain/required_fields.json";
import productMapping from "../../mcp/tieulinh/domain/product_mapping.json";
import urgencyRules from "../../mcp/tieulinh/domain/urgency-rules.json";

describe("W29-NOTIFY: Supplement notification & closed-ticket handling", () => {
  let db: Database;
  let repo: IntakeDocumentRepository;
  let bindingRepo: TicketBindingRepository;
  let draftRepo: DraftSessionRepository;
  let dbPath: string;

  const projectAssignees: ProjectAssignee[] = [
    { userId: "u-techlead-a", username: "techlead_a", name: "TechLead_A" },
    { userId: "u-chung", username: "techuser_b", name: "TechUser_B" },
    { userId: "u-techuser-o", username: "techuser_o", name: "TechUser_O" },
  ];

  const projectColumns: ProjectColumn[] = [
    { id: 1, name: "Backlog", stateType: "backlog", position: 1 },
    { id: 2, name: "In Progress", stateType: "started", position: 2 },
    { id: 3, name: "Resolved", stateType: "completed", position: 3 },
    { id: 4, name: "Done", stateType: "completed", position: 4 },
    { id: 5, name: "Canceled", stateType: "canceled", position: 5 },
  ];

  function createFakeItsaplan(initialIssue: Partial<ItsaplanIssue>, timeline: unknown[] = []) {
    const calls = {
      addComment: [] as Array<{ issueId: number; content: string }>,
      updateIssue: [] as Array<{ issueId: number; patch: unknown }>,
      getIssue: [] as number[],
    };

    let issue: ItsaplanIssue = {
      id: initialIssue.id ?? 101,
      projectId: 1,
      sequenceNumber: 101,
      identifier: initialIssue.identifier ?? "TECHTEST-101",
      title: initialIssue.title ?? "Học sinh không vào được phòng học",
      description: initialIssue.description ?? "Người báo: Nguyễn Văn A (telegram:7001)",
      priority: initialIssue.priority ?? "medium",
      columnId: initialIssue.columnId ?? 2, // default: In Progress
      stateType: initialIssue.stateType ?? "started",
      assigneeUserId: initialIssue.assigneeUserId ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const client: Partial<ItsaplanClient> = {
      listProjectColumns: async () => projectColumns,
      getProject: async () => ({
        id: 1,
        key: "TECHTEST",
        name: "Tech Test",
        columns: projectColumns,
        assignees: projectAssignees,
      }),
      getIssue: async (id: number) => {
        calls.getIssue.push(id);
        return issue;
      },
      getIssueByNumber: async (_projectKey: string, seq: number) => {
        if (issue.sequenceNumber === seq || issue.id === seq) return issue;
        return { ...issue, id: seq, sequenceNumber: seq, identifier: `TECHTEST-${seq}` };
      },
      getIssueTimeline: async (_issueId: number) => timeline,
      addComment: async (issueId: number, content: string) => {
        calls.addComment.push({ issueId, content });
        return { id: calls.addComment.length, body: content };
      },
      updateIssue: async (issueId: number, patch: unknown) => {
        calls.updateIssue.push({ issueId, patch });
        issue = { ...issue, ...(patch as Partial<ItsaplanIssue>) };
        return issue;
      },
    };

    return {
      client: client as ItsaplanClient,
      calls,
      setIssue: (patch: Partial<ItsaplanIssue>) => {
        issue = { ...issue, ...patch };
      },
    };
  }

  function setupPipeline(client: ItsaplanClient, overrides: Partial<IntakePipelineOptions> = {}) {
    return new IntakeStepPipeline({
      repo,
      bindingRepo,
      draftRepo,
      extractor: new FieldExtractor(),
      itsaplan: client,
      projectKey: "TECHTEST",
      columnId: 1,
      validationRules: validationRules as unknown as ValidationRules,
      fieldRequirements: fieldRequirements as unknown as FieldRequirementsTable,
      productMapping,
      urgencyRules: urgencyRules as UrgencyRules,
      buttons: { save: () => {}, clear: () => {} },
      now: () => Date.now(),
      ...overrides,
    });
  }

  function seedCreatedDoc(chatId: string, issueId: number, identifier: string): IntakeDocument {
    const now = new Date().toISOString();
    const doc: IntakeDocument = {
      docId: `doc_${chatId}_${Date.now()}`,
      chatId,
      revision: 1,
      status: "created",
      issueId,
      issueIdentifier: identifier,
      currentTurn: 1,
      createdAt: now,
      updatedAt: now,
      evidence: {},
      askedCount: {},
      similarTickets: [],
      fields: {
        title: { value: "Sự cố phòng học", source: "user_message", turn: 1, updatedAt: now },
      },
    };
    repo.saveRevision(doc);
    return doc;
  }

  beforeEach(() => {
    dbPath = `/tmp/test-notify-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
    db = new Database(dbPath);
    applySchema(db);
    repo = new IntakeDocumentRepository(db);
    bindingRepo = new TicketBindingRepository(db);
    draftRepo = new DraftSessionRepository(db);
  });

  afterEach(() => {
    try {
      db.close();
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    } catch {}
  });

  describe("1. in-progress → mention assignee", () => {
    it("khi ticket đang xử lý có assignee (u-techlead-a) → comment bổ sung mention @techlead_a", async () => {
      const { client, calls } = createFakeItsaplan({
        id: 101,
        identifier: "TECHTEST-101",
        columnId: 2, // In Progress
        stateType: "started",
        assigneeUserId: "u-techlead-a",
      });

      const pipeline = setupPipeline(client);
      const chatId = "7001";
      seedCreatedDoc(chatId, 101, "TECHTEST-101");

      // Bước 1: Người báo gửi tin nhắn bổ sung, bot hỏi xác nhận (ADR-0008)
      const asked = await pipeline.run({
        chatId,
        message: "Phụ huynh gửi thêm SĐT 0900000005",
      });
      expect(asked.action).toBe("confirm_ticket_action");
      expect(calls.addComment).toHaveLength(0);

      // Bước 2: Người báo bấm nút xác nhận
      const res = await pipeline.run({
        chatId,
        message: asked.buttons![0][0].callbackData,
      });

      expect(res.action).toBe("post_create_update");
      expect(calls.addComment).toHaveLength(1);
      const added = calls.addComment[0];
      expect(added.issueId).toBe(101);
      // Phải có mention @techlead_a trong định dạng Itsaplan
      expect(added.content).toContain("(cc @techlead_a)");
      expect(added.content).not.toContain("(cc @techlead_a))");
      expect(added.content).toContain("0900000005");
    });
  });

  describe("2. no assignee → mention last technician commenter or none", () => {
    it("khi ticket không có assignee nhưng timeline có trao đổi của KTV (TechUser_B) → mention @techuser_b", async () => {
      const timeline = [
        {
          kind: "comment",
          actorUserId: "u-chung",
          actorName: "TechUser_B",
          body: "Kỹ thuật đã nhận và đang tra log",
        },
        { kind: "comment", actorName: "Tiểu Linh", body: "Thông báo tự động <!-- intake-bot -->" },
      ];

      const { client, calls } = createFakeItsaplan(
        {
          id: 102,
          identifier: "TECHTEST-102",
          columnId: 2, // In Progress
          stateType: "started",
          assigneeUserId: null, // Chưa gán ai
        },
        timeline,
      );

      const pipeline = setupPipeline(client);
      const chatId = "7002";
      seedCreatedDoc(chatId, 102, "TECHTEST-102");

      const asked = await pipeline.run({
        chatId,
        message: "Mã giao dịch là VUIHOC-88992",
      });
      expect(asked.action).toBe("confirm_ticket_action");

      const res = await pipeline.run({
        chatId,
        message: asked.buttons![0][0].callbackData,
      });

      expect(res.action).toBe("post_create_update");
      expect(calls.addComment).toHaveLength(1);
      const added = calls.addComment[0];
      expect(added.issueId).toBe(102);
      // Mention kỹ thuật viên bình luận gần nhất
      expect(added.content).toContain("(cc @techuser_b)");
      expect(added.content).not.toContain("(cc @techuser_b))");
      expect(added.content).toContain("VUIHOC-88992");
    });

    it("khi ticket không có assignee và timeline chỉ có bot/hệ thống → none (không cc ai)", async () => {
      const timeline = [
        { kind: "comment", actorName: "Tiểu Linh", body: "Ticket tạo tự động <!-- intake-bot -->" },
        { kind: "comment", actorName: "admin", body: "Gán nhãn tự động" },
      ];

      const { client, calls } = createFakeItsaplan(
        {
          id: 103,
          identifier: "TECHTEST-103",
          columnId: 2,
          stateType: "started",
          assigneeUserId: null,
        },
        timeline,
      );

      const pipeline = setupPipeline(client);
      const chatId = "7003";
      seedCreatedDoc(chatId, 103, "TECHTEST-103");

      const asked = await pipeline.run({
        chatId,
        message: "Học sinh dùng Android 14",
      });
      expect(asked.action).toBe("confirm_ticket_action");

      const res = await pipeline.run({
        chatId,
        message: asked.buttons![0][0].callbackData,
      });

      expect(res.action).toBe("post_create_update");
      expect(calls.addComment).toHaveLength(1);
      const added = calls.addComment[0];
      expect(added.issueId).toBe(103);
      // Không có mention vì không có KTV
      expect(added.content).not.toContain("cc @");
      expect(added.content).toContain("Android 14");
    });
  });

  describe("3. closed → no append, reporter told to create a new ticket", () => {
    it("ticket đã ở Done (cột 4) → từ chối bổ sung, không addComment, hướng dẫn tạo ticket mới", async () => {
      const { client, calls } = createFakeItsaplan({
        id: 104,
        identifier: "TECHTEST-104",
        columnId: 4, // Done
        stateType: "completed",
        assigneeUserId: "u-techlead-a",
      });

      const pipeline = setupPipeline(client);
      const chatId = "7004";
      seedCreatedDoc(chatId, 104, "TECHTEST-104");

      const res = await pipeline.run({
        chatId,
        message: "bổ sung thêm: học sinh vẫn bị lỗi trên máy tính",
      });
      expect(res.action).toBe("post_create_update");
      // Tuyệt đối không append vào ticket đã đóng
      expect(calls.addComment).toHaveLength(0);
      expect(calls.updateIssue).toHaveLength(0);
      // Lời nhắn phải lịch sự, thông báo ticket đã đóng và bảo tạo ticket mới
      expect(res.voiceText).toContain("đã đóng");
      expect(res.voiceText).toContain("tạo ticket mới");
    });

    it("ticket đã ở Canceled (cột 5) → từ chối bổ sung, không addComment, hướng dẫn tạo ticket mới", async () => {
      const { client, calls } = createFakeItsaplan({
        id: 105,
        identifier: "TECHTEST-105",
        columnId: 5, // Canceled
        stateType: "canceled",
        assigneeUserId: "u-chung",
      });

      const pipeline = setupPipeline(client);
      const chatId = "7005";
      seedCreatedDoc(chatId, 105, "TECHTEST-105");

      const res = await pipeline.run({
        chatId,
        message: "Em muốn thêm thông tin",
      });

      expect(res.action).toBe("post_create_update");
      expect(calls.addComment).toHaveLength(0);
      expect(calls.updateIssue).toHaveLength(0);
      expect(res.voiceText).toContain("đã đóng");
      expect(res.voiceText).toContain("tạo ticket mới");
    });

    it("người dùng gõ lệnh bổ sung chỉ định ticket đã đóng (bổ sung TECHTEST-104) → từ chối ngay lập tức", async () => {
      const { client, calls } = createFakeItsaplan({
        id: 104,
        identifier: "TECHTEST-104",
        columnId: 4, // Done
        stateType: "completed",
        assigneeUserId: "u-techlead-a",
      });

      // Binding thuộc chat này
      bindingRepo.saveBinding({
        issueId: 104,
        identifier: "TECHTEST-104",
        chatId: "7006",
        channelType: "telegram",
        messageId: "msg-104",
      });

      const pipeline = setupPipeline(client);
      const chatId = "7006";

      const res = await pipeline.run({
        chatId,
        message: "bổ sung TECHTEST-104: số điện thoại là 0900000016",
      });

      expect(res.action).toBe("post_create_update");
      expect(calls.addComment).toHaveLength(0);
      expect(calls.updateIssue).toHaveLength(0);
      expect(res.voiceText).toContain("TECHTEST-104");
      expect(res.voiceText).toContain("đã đóng");
      expect(res.voiceText).toContain("tạo ticket mới");
    });
  });
});
