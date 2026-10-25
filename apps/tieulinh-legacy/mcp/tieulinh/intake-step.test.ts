import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../../lib/storage/schema";
import { IntakeDocumentRepository } from "../../lib/intake-document/repository";
import { FieldExtractor } from "../../lib/intake-step/extractor";
import { intakeStep } from "./tools/intake-step";
import { inspectTools } from "./tools/inspect-tools";
import type { ItsaplanClient, ItsaplanIssue } from "@vuihoc/bot-core/itsaplan";
import validationRules from "./domain/validation-rules.json";
import fieldRequirements from "./domain/required_fields.json";
import productMapping from "./domain/product_mapping.json";
import urgencyRules from "./domain/urgency-rules.json";

describe("MCP Tools: intake_step & inspect_tools", () => {
  let db: Database;
  let repo: IntakeDocumentRepository;

  const mockItsaplan: Partial<ItsaplanClient> = {
    listProjectColumns: async () => [{ id: 1, name: "Todo", stateType: "unstarted", position: 1 }],
    createIssue: async (projectKey, payload) =>
      ({
        id: 999,
        identifier: "TECHTEST-999",
        title: payload.title,
        sequenceNumber: 999,
      }) as ItsaplanIssue,
  };

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    repo = new IntakeDocumentRepository(db);
  });

  it("gọi intake_step và kiểm tra inspect_tools qua các lượt", async () => {
    const stepTool = intakeStep({
      minConfirmDelayMs: 0, // test gọi liền mạch, không có độ trễ người thật
      repo,
      extractor: new FieldExtractor(),
      itsaplan: mockItsaplan as ItsaplanClient,
      projectKey: "TECHTEST",
      validationRules: validationRules as any,
      fieldRequirements: fieldRequirements as any,
      productMapping: productMapping as any,
      urgencyRules: urgencyRules as any,
      // Không ghi file nút thật vào ~/.vhbot trong test
      buttons: { save: () => {}, clear: () => {} },
    });

    const [getIntakeDoc, getSimilarTickets] = inspectTools(repo);

    // Turn 1
    const res1 = (await stepTool.handler({
      chatId: "chat_mcp_1",
      message: "Lỗi thanh toán ngân hàng app Duo Vuihoc",
    })) as any;

    expect(res1.action).toBe("ask_missing_field");
    expect(res1.status).toBe("collecting");
    // Bug thật 24/09: thấy callbackData của nút, MiniMax-M3 tự gọi lại intake_step với
    // "Sale" thay người dùng. Nút đã đẩy thẳng lên Telegram — model không cần thấy.
    expect(res1.buttons).toBeUndefined();
    expect(JSON.stringify(res1)).not.toContain("callbackData");
    expect(res1.agentInstruction).toMatch(/kết thúc lượt/i);

    // Tra cứu qua get_intake_doc
    const inspect1 = (await getIntakeDoc.handler({ chatId: "chat_mcp_1" })) as any;
    expect(inspect1.found).toBe(true);
    expect(inspect1.document.fields.product?.value).toBe("Duo");

    // Turn 2: Cung cấp phòng ban
    const res2 = (await stepTool.handler({
      chatId: "chat_mcp_1",
      message: "Em bên Sale ạ",
    })) as any;

    expect(res2.action).toBe("confirm_summary");
    expect(res2.status).toBe("ready_for_confirmation");
    expect(JSON.stringify(res2)).not.toContain("callbackData");

    // Kiểm tra lịch sử revision qua inspect
    const inspectHistory = (await getIntakeDoc.handler({
      chatId: "chat_mcp_1",
      includeHistory: true,
    })) as any;
    expect(inspectHistory.history.length).toBe(2);

    // Turn 3: Xác nhận tạo vé
    const res3 = (await stepTool.handler({
      chatId: "chat_mcp_1",
      message: "Chuẩn rồi tạo giúp em",
    })) as any;

    expect(res3.action).toBe("ticket_created");
    expect(res3.issue?.identifier).toBe("TECHTEST-999");
  });
});
