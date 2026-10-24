import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../storage/schema";
import { IntakeDocumentRepository } from "../intake-document/repository";
import { FieldExtractor } from "./extractor";
import { IntakeStepPipeline } from "./pipeline";
import { ItsaplanClient, type ItsaplanIssue, type ItsaplanProject } from "../itsaplan/client";
import validationRules from "../../mcp/tieulinh/domain/validation-rules.json";
import fieldRequirements from "../../mcp/tieulinh/domain/required_fields.json";
import productMapping from "../../mcp/tieulinh/domain/product_mapping.json";
import urgencyRules from "../../mcp/tieulinh/domain/urgency-rules.json";
import { createIssue } from "../../mcp/shared/tools/create-issue";
import { ticketDomain } from "../../mcp/tieulinh/domain";
import type {
  ValidationRules,
  FieldRequirementsTable,
  ProductMappingConfig,
  UrgencyRules,
} from "../../mcp/shared/index";

describe("TECH-1148: Chặn tin noop và chặn tạo ticket với tiêu đề/mô tả rỗng hoặc noop", () => {
  let db: Database;
  let repo: IntakeDocumentRepository;
  let pipeline: IntakeStepPipeline;
  let createdIssues: Array<{
    projectKey: string;
    payload: { title: string; description?: string };
  }>;

  function makeItsaplan(): ItsaplanClient {
    createdIssues = [];
    const client: Partial<ItsaplanClient> = {
      listProjects: async () =>
        [
          { id: 1, key: "TECH", name: "Tech", raw: { issueTypes: [{ id: 1, isDefault: true }] } },
        ] as unknown as ItsaplanProject[],
      listProjectColumns: async () => [
        { id: 1, name: "Todo", stateType: "unstarted", position: 1 },
      ],
      listCustomFields: async () => [{ id: 42, name: "Related Tickets", fieldType: "markdown" }],
      setCustomFieldValue: async () => {},
      getIssueByNumber: async (_pk, seq) =>
        ({ id: 9000 + seq, identifier: `TECH-${seq}` }) as unknown as ItsaplanIssue,
      addLink: async () => ({ id: 1, kind: "relates" }),
      updateIssue: async () => ({ id: 1 }) as unknown as ItsaplanIssue,
      addComment: async (_id, body) => ({ id: 1, body }),
      createIssue: async (projectKey, payload) => {
        createdIssues.push({ projectKey, payload });
        return {
          id: 1000 + createdIssues.length,
          identifier: `TECHTEST-${1000 + createdIssues.length}`,
          title: payload.title,
          sequenceNumber: 1000 + createdIssues.length,
        } as unknown as ItsaplanIssue;
      },
    };
    Object.setPrototypeOf(client, ItsaplanClient.prototype);
    return client as unknown as ItsaplanClient;
  }

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    repo = new IntakeDocumentRepository(db);

    const client = makeItsaplan();

    pipeline = new IntakeStepPipeline({
      minConfirmDelayMs: 0,
      repo,
      extractor: new FieldExtractor(),
      itsaplan: client,
      projectKey: "TECHTEST",
      validationRules: validationRules as unknown as ValidationRules,
      fieldRequirements: fieldRequirements as unknown as FieldRequirementsTable,
      productMapping: productMapping as unknown as ProductMappingConfig,
      urgencyRules: urgencyRules as unknown as UrgencyRules,
      buttons: { save: () => {}, clear: () => {} },
    });
  });

  it("1. Tin noop độc lập: bị bỏ qua, KHÔNG tạo tờ khai trong DB, KHÔNG tạo ticket", async () => {
    const res = await pipeline.run({
      chatId: "chat_noop_standalone",
      message: "noop",
    });

    // Không được tạo tờ khai lưu trong DB
    const saved = repo.getLatestByChatId("chat_noop_standalone");
    expect(saved).toBeNull();

    // Không được gọi tạo ticket
    expect(createdIssues).toHaveLength(0);
  });

  it("2. Tin callback_data: noop khi chưa có tờ khai: bị bỏ qua, không tạo tờ khai trong DB", async () => {
    const res = await pipeline.run({
      chatId: "chat_cb_noop_standalone",
      message: "callback_data: noop",
    });

    const saved = repo.getLatestByChatId("chat_cb_noop_standalone");
    expect(saved).toBeNull();
    expect(createdIssues).toHaveLength(0);
  });

  it("3. Mô phỏng đúng chuỗi sự cố TECH-1148: sau khi tạo ticket, bấm nhầm nút noop không làm mở ticket noop mới", async () => {
    // Bước 1: Người dùng báo sự cố hợp lệ và tạo ticket thành công (như TECH-1146)
    await pipeline.run({
      chatId: "chat_tech_1148",
      message: "Lỗi app Duo hệ thống Vuihoc học sinh 0900000005 không làm bài được",
    });
    await pipeline.run({
      chatId: "chat_tech_1148",
      message: "Vận hành",
    });
    const confirmRes = await pipeline.run({
      chatId: "chat_tech_1148",
      message: "đúng rồi",
    });
    expect(confirmRes.action).toBe("ticket_created");
    expect(createdIssues).toHaveLength(1);

    // Bước 2: Người dùng bấm vào nút đã khoá [ đúng rồi ✓ ] -> Telegram gửi callback_data: noop
    const noopRes = await pipeline.run({
      chatId: "chat_tech_1148",
      message: "callback_data: noop",
    });

    // Tin noop phải bị bỏ qua, không được gán pendingNewIncident
    const docAfterNoop = repo.getLatestByChatId("chat_tech_1148");
    expect(docAfterNoop?.pendingNewIncident).toBeUndefined();
    expect(noopRes.action).toBe("already_created");

    // Bước 3: Người dùng bấm "Sự cố mới" -> KHÔNG được lấy chữ "noop" tạo thành ticket mới!
    const newIncRes = await pipeline.run({
      chatId: "chat_tech_1148",
      message: "Sự cố mới",
    });

    // Lúc này chỉ mở tờ khai rỗng hỏi mô tả, không được tạo ticket tiêu đề noop
    expect(createdIssues).toHaveLength(1); // Vẫn chỉ là ticket ban đầu
    const currentDoc = repo.getLatestByChatId("chat_tech_1148");
    expect(currentDoc?.fields?.title?.value).not.toBe("noop");
    expect(currentDoc?.fields?.rawText?.value).not.toBe("noop");
  });

  it("4. Tin noop trong khi đang thu thập thông tin (collecting): không làm ô nhiễm title hay rawText", async () => {
    await pipeline.run({
      chatId: "chat_collecting",
      message: "CRM bị lỗi đơn hàng không mở được SĐT 0900000005",
    });

    const docBefore = repo.getLatestByChatId("chat_collecting");
    const titleBefore = docBefore?.fields?.title?.value;
    const turnBefore = docBefore?.currentTurn;

    // Gửi tin noop
    await pipeline.run({
      chatId: "chat_collecting",
      message: "noop",
    });

    const docAfter = repo.getLatestByChatId("chat_collecting");
    expect(docAfter?.fields?.title?.value).toBe(titleBefore);
    expect(docAfter?.fields?.rawText?.value).not.toContain("noop");
    expect(docAfter?.currentTurn).toBe(turnBefore);
  });

  it("5. Hàng rào tạo ticket: từ chối tạo ticket khi title hoặc description rỗng hoặc chỉ là noop", async () => {
    // Tạo giả một doc trong repo với title="noop", symptoms=["noop"], rawText="noop"
    const badDoc = {
      docId: "doc_bad_noop",
      chatId: "chat_bad_noop",
      revision: 1,
      status: "ready_for_confirmation" as const,
      currentTurn: 2,
      fields: {
        title: {
          value: "noop",
          source: "user_message" as const,
          turn: 1,
          updatedAt: new Date().toISOString(),
        },
        rawText: {
          value: "noop",
          source: "user_message" as const,
          turn: 1,
          updatedAt: new Date().toISOString(),
        },
        symptoms: {
          value: ["noop"],
          source: "user_message" as const,
          turn: 1,
          updatedAt: new Date().toISOString(),
        },
      },
      evidence: {},
      askedCount: {},
      similarTickets: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    repo.saveRevision(badDoc);

    // Người dùng bấm xác nhận
    const res = await pipeline.run({
      chatId: "chat_bad_noop",
      message: "đúng rồi",
    });

    // Phải bị từ chối tạo ticket
    expect(createdIssues).toHaveLength(0);
    expect(res.action).not.toBe("ticket_created");
  });

  it("6. create_issue tool: từ chối tạo ticket khi title hoặc description chỉ là noop", async () => {
    const tracker = { baseUrl: "https://mock.itsaplan.test", apiKey: "k", projectKey: "TECH" };
    const tool = createIssue(tracker, ticketDomain);

    const res = await tool.handler({
      title: "noop",
      description: "noop",
      rawText: "noop",
      userConfirmed: true,
      reporterName: "Nguyễn Văn A",
      reporterChatId: "12345",
    });

    expect(createdIssues).toHaveLength(0);
    const outcome = res as Record<string, unknown>;
    expect(outcome.created).toBe(false);
  });
});
