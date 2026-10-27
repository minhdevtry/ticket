import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { defineBot } from "./define";
import { createReceptionistMcpServer } from "./receptionist-mcp";
import { createCatalog } from "../intake/gate/catalog";
import { FieldExtractor } from "../intake/extractor/llm-extractor";
import { makeCopyCatalog } from "../intake/copy-catalog";
import { tieuLinhCopy } from "../../examples/tieulinh/copy";
import { SqliteDraftRepository, intakeApplySchema, newDraft } from "../intake/draft";
import fixtureUrgency from "../intake/priority/urgency-rules.fixture.json" with { type: "json" };
import { checkIdentityTool } from "../identity/tools";
import type { IdentityService } from "../identity/service";
import type { IdentityRepository } from "../identity/repository";
import type { IdentityCopyRenderer } from "../identity/tools";
import type { RelinkOptions } from "../identity/relink";
import type { UrgencyRules } from "../intake/priority/priority";
import type { TrackerIssue, TrackerPort } from "../intake/ports";

describe("MCP Tools: intake_step & inspect_tools", () => {
  let db: Database;
  let repo: SqliteDraftRepository;

  const fakeTracker: TrackerPort = {
    createIssue: async (input) =>
      ({
        id: 999,
        identifier: "TECHTEST-999",
        title: input.title,
        sequenceNumber: 999,
      }) as TrackerIssue,
    getIssue: async () => null,
    addComment: async () => {},
    attach: async () => 0,
    findByIdentifier: async () => null,
  };

  const catalog = createCatalog({
    fields: {
      _toi_da_hoi_lai: 2,
      _toi_da_truong_moi_luot: 1,
      chung: {
        tieu_de: { bat_buoc: true, kieu: "text", duoc_hoi: false, nhan: "Tiêu đề" },
      },
      nhanh: {
        default: {
          ten: "Tiếp nhận sự cố",
          truong_mo_dau: "product",
          recap: ["tieu_de", "product", "reportingDept"],
          truong: {
            product: { bat_buoc: true, kieu: "text", duoc_hoi: true, nhan: "Sản phẩm" },
            reportingDept: { bat_buoc: true, kieu: "text", duoc_hoi: true, nhan: "Bộ phận" },
          },
        },
      },
    },
    enums: {},
  });

  const botDef = defineBot({
    id: "tieulinh-step",
    tracker: { team: "tech", project: "TECHTEST" },
    persona: makeCopyCatalog(tieuLinhCopy),
    receptionist: {
      catalog,
      priorityRules: fixtureUrgency as unknown as UrgencyRules,
      extractor: new FieldExtractor(),
    },
    backoffice: { on: { mention: async () => "ok" } },
  });

  beforeEach(() => {
    db = new Database(":memory:");
    intakeApplySchema(db);
    repo = new SqliteDraftRepository(db);
  });

  it("gọi intake_step và kiểm tra inspect_tools qua các lượt", async () => {
    const server = createReceptionistMcpServer(botDef, {
      tracker: fakeTracker,
      drafts: repo,
      confirm: { minConfirmDelayMs: 0 },
    });

    const stepTool = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (input: unknown) => Promise<{ content: Array<{ text: string }> }> }
        >;
      }
    )._registeredTools.intake_step;

    const docTool = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (input: unknown) => Promise<{ content: Array<{ text: string }> }> }
        >;
      }
    )._registeredTools.get_intake_doc;

    // Turn 1
    const out1 = await stepTool.handler({
      chatId: "chat_mcp_1",
      message: "Lỗi thanh toán ngân hàng app Duo Vuihoc",
    });
    const res1 = JSON.parse(out1.content[0].text);

    expect(res1.action).toBe("ask_missing_field");
    expect(res1.status).toBe("collecting");
    // Bug thật 24/09: thấy callbackData của nút, MiniMax-M3 tự gọi lại intake_step với
    // "Sale" thay người dùng. Nút đã đẩy thẳng lên Telegram — model không cần thấy.
    expect(res1.buttons).toBeUndefined();
    expect(JSON.stringify(res1)).not.toContain("callbackData");
    expect(res1.agentInstruction).toMatch(/kết thúc lượt/i);

    // Tra cứu qua get_intake_doc
    const outInspect1 = await docTool.handler({ chatId: "chat_mcp_1" });
    const inspect1 = JSON.parse(outInspect1.content[0].text);
    expect(inspect1.found).toBe(true);
    expect(inspect1.document.fields.product?.value).toBe("Duo");

    // Turn 2: Cung cấp phòng ban
    const out2 = await stepTool.handler({
      chatId: "chat_mcp_1",
      message: "Em bên Sale ạ",
    });
    const res2 = JSON.parse(out2.content[0].text);

    expect(res2.action).toBe("confirm_summary");
    expect(res2.status).toBe("ready_for_confirmation");
    expect(JSON.stringify(res2)).not.toContain("callbackData");

    // Kiểm tra lịch sử revision qua inspect
    const outInspectHistory = await docTool.handler({
      chatId: "chat_mcp_1",
      includeHistory: true,
    });
    const inspectHistory = JSON.parse(outInspectHistory.content[0].text);
    expect(inspectHistory.history.length).toBe(2);

    // Turn 3: Xác nhận tạo vé
    const out3 = await stepTool.handler({
      chatId: "chat_mcp_1",
      message: "Chuẩn rồi tạo giúp em",
    });
    const res3 = JSON.parse(out3.content[0].text);

    expect(res3.action).toBe("ticket_created");
    expect(res3.issue?.identifier).toBe("TECHTEST-999");
  });

  it("check_identity: trả về pendingDraft khi có bản nháp ticket đang gom dở", async () => {
    const draft = newDraft("doc-draft-1", "tele_draft", new Date().toISOString());
    draft.ticket.title = "Lỗi đăng nhập app";
    draft.status = "collecting";
    repo.saveRevision(draft);

    const mockService: Partial<IdentityService> = {
      checkUserApproval: () => ({
        isApproved: true,
        isPending: false,
        isRejected: false,
        account: {
          accountId: "tele_draft",
          channelType: "telegram",
          nameCode: "CS_user_a",
          status: "approved",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }),
    };

    const mockCopy: IdentityCopyRenderer = {
      check: () => "Đã duyệt",
      register: () => "Đã đăng ký",
      approve: () => "Đã duyệt",
      reject: () => "Đã từ chối",
      relink: () => "Đã chuyển",
      notAdmin: () => "Không phải admin",
    };
    const tool = checkIdentityTool({
      service: mockService as IdentityService,
      repo: {} as IdentityRepository,
      copy: mockCopy,
      relink: {} as RelinkOptions,
      drafts: repo,
    });

    const result = (await tool.handler({
      telegramUserId: "tele_draft",
    })) as { pendingDraft?: { state?: { title?: string } } };

    expect(result.pendingDraft).not.toBeNull();
    expect(result.pendingDraft?.state?.title).toBe("Lỗi đăng nhập app");
  });
});
