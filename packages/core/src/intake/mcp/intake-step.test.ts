import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runOnHttp } from "../../core/mcp-server";
import { intakeApplySchema, SqliteDraftRepository } from "../draft";
import { SqliteChannelBindingStore } from "../create/binding-store";
import { createCatalog } from "../gate/catalog";
import type { FieldCatalog } from "../gate/types";
import { makeCopyCatalog } from "../copy-catalog";
import { TEST_COPY } from "../engine/test-copy.fixture";
import { IntakeEngine } from "../engine/engine";
import type { FieldExtractorPort, TrackerPort } from "../ports";
import type { UrgencyRules } from "../priority";
import { intakeStepTool } from "./intake-step";
import { inspectTools } from "./inspect-tools";
import { lookupTools } from "./lookup-tools";
import { createReceptionistMcpServer } from "./server";
import { exportSkillPack } from "./skill-pack";
import { defineBot } from "../../bot/define";

const testCatalog: FieldCatalog = createCatalog({
  fields: {
    _toi_da_hoi_lai: 2,
    _toi_da_truong_moi_luot: 1,
    nhanh: {
      default: {
        ten: "Mặc định",
        truong_mo_dau: "product",
        recap: ["product", "reporting_dept"],
        truong: {
          product: {
            bat_buoc: true,
            kieu: "text",
            duoc_hoi: true,
            nhan: "Sản phẩm",
            hoi: "Sản phẩm nào?",
          },
          reporting_dept: {
            bat_buoc: true,
            kieu: "text",
            duoc_hoi: true,
            nhan: "Bộ phận",
            hoi: "Bộ phận nào?",
          },
        },
      },
    },
  },
});

const testUrgency: UrgencyRules = {
  levels: ["low", "medium", "high", "urgent"],
  floors: [],
  ceilings: [],
};

describe("MCP Tools: intake_step & inspect_tools", () => {
  let db: Database;
  let drafts: SqliteDraftRepository;
  let bindings: SqliteChannelBindingStore;
  let fakeTracker: TrackerPort;

  beforeEach(() => {
    db = new Database(":memory:");
    intakeApplySchema(db);
    drafts = new SqliteDraftRepository(db);
    bindings = new SqliteChannelBindingStore(db);

    fakeTracker = {
      createIssue: async (input) => ({
        id: 999,
        identifier: "TECHTEST-999",
        title: input.title,
        priority: input.priority,
      }),
      getIssue: async () => null,
      addComment: async () => {},
      attach: async () => 0,
      findByIdentifier: async (id) =>
        id === "TECHTEST-999"
          ? {
              id: 999,
              identifier: "TECHTEST-999",
              title: "Lỗi thanh toán ngân hàng app Duo Vuihoc",
              stateType: "Mới tiếp nhận",
            }
          : null,
    };
  });

  afterAll(() => {
    db?.close();
  });

  it("gọi intake_step và kiểm tra inspect_tools qua các lượt", async () => {
    const mockExtractor: FieldExtractorPort = {
      extract: async (input) => {
        const text = input.text.toLowerCase();
        if (text.includes("chuẩn rồi") || text.includes("tạo giúp")) {
          return {
            userIntent: "confirm" as const,
            rawText: input.text,
          };
        }
        const extracted: Record<string, string> = {};
        if (text.includes("duo")) {
          extracted.product = "Duo";
        }
        if (text.includes("sale")) {
          extracted.reporting_dept = "Sale";
        }
        return {
          userIntent: "report_issue" as const,
          title: "Lỗi thanh toán ngân hàng app Duo Vuihoc",
          values: extracted,
          rawText: input.text,
        };
      },
    };

    const copy = makeCopyCatalog({
      ...TEST_COPY,
      "confirm.too_soon": "xem lại tóm tắt rồi bấm xác nhận nhé ạ",
    });

    const engine = new IntakeEngine({
      drafts,
      bindings,
      tracker: fakeTracker,
      copy,
      catalog: testCatalog,
      urgencyRules: testUrgency,
      variant: "default",
      extractor: mockExtractor,
      confirm: { minConfirmDelayMs: 0 },
      clock: { now: () => 1_000_000 },
    });

    const stepTool = intakeStepTool({ engine, drafts });
    const [getIntakeDoc, getSimilarTickets] = inspectTools({ drafts });

    // Turn 1: Báo lỗi với sản phẩm Duo, còn thiếu bộ phận
    const res1 = (await stepTool.handler({
      chatId: "chat_mcp_1",
      message: "Lỗi thanh toán ngân hàng app Duo Vuihoc",
    })) as Record<string, unknown>;

    expect(res1.action).toBe("ask_missing_field");
    expect(res1.status).toBe("collecting");
    expect(res1.buttons).toBeUndefined();
    expect(JSON.stringify(res1)).not.toContain("callbackData");
    expect(res1.agentInstruction as string).toMatch(/kết thúc lượt/i);

    // Tra cứu qua get_intake_doc
    const inspect1 = (await getIntakeDoc.handler({ chatId: "chat_mcp_1" })) as {
      found: boolean;
      document: { fields: Record<string, { value: string }> };
    };
    expect(inspect1.found).toBe(true);
    expect(inspect1.document.fields.product?.value).toBe("Duo");

    // Tra cứu qua get_similar_tickets
    const similar1 = (await getSimilarTickets.handler({ chatId: "chat_mcp_1" })) as {
      found: boolean;
      similarTickets: unknown[];
    };
    expect(similar1.found).toBe(true);
    expect(similar1.similarTickets).toEqual([]);

    // Turn 2: Cung cấp phòng ban
    const res2 = (await stepTool.handler({
      chatId: "chat_mcp_1",
      message: "Em bên Sale ạ",
    })) as Record<string, unknown>;

    expect(res2.action).toBe("confirm_summary");
    expect(res2.status).toBe("ready_for_confirmation");
    expect(JSON.stringify(res2)).not.toContain("callbackData");

    // Kiểm tra lịch sử revision qua inspect
    const inspectHistory = (await getIntakeDoc.handler({
      chatId: "chat_mcp_1",
      includeHistory: true,
    })) as { history: unknown[] };
    expect(inspectHistory.history.length).toBe(2);

    // Turn 3: Xác nhận tạo vé
    const res3 = (await stepTool.handler({
      chatId: "chat_mcp_1",
      message: "Chuẩn rồi tạo giúp em",
    })) as {
      action: string;
      issue?: { identifier: string };
    };

    expect(res3.action).toBe("ticket_created");
    expect(res3.issue?.identifier).toBe("TECHTEST-999");
  });

  it("MCP server lễ tân liệt kê đúng tool và gọi được qua stdio (in-memory) và HTTP", async () => {
    const mockExtractor: FieldExtractorPort = {
      extract: async () => ({
        userIntent: "report_issue" as const,
        title: "Test issue",
        values: { product: "Duo" },
        rawText: "test",
      }),
    };

    const copy = makeCopyCatalog(TEST_COPY);

    const def = defineBot({
      id: "tieulinh-test",
      tracker: { team: "tech", project: "TECHTEST" },
      receptionist: {
        catalog: testCatalog,
        priorityRules: testUrgency,
        extractor: mockExtractor,
      },
    });

    const server = createReceptionistMcpServer({
      def,
      db,
      tracker: fakeTracker,
      copy,
      clock: { now: () => 1_000_000 },
    });

    // 1. Kiểm tra qua InMemoryTransport (tương đương stdio trần trong process)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name);
    expect(toolNames).toContain("intake_step");
    expect(toolNames).toContain("get_intake_doc");
    expect(toolNames).toContain("get_similar_tickets");
    expect(toolNames).toContain("get_issue");

    const callResult = await client.callTool({
      name: "intake_step",
      arguments: {
        chatId: "stdio_chat_1",
        message: "Lỗi thanh toán app Duo",
      },
    });
    expect(callResult.content).toBeDefined();
    const parsedText = JSON.parse(
      (callResult.content as Array<{ type: string; text: string }>)[0].text,
    );
    expect(parsedText.action).toBe("ask_missing_field");

    // Tra cứu ticket qua get_issue
    const issueCall = await client.callTool({
      name: "get_issue",
      arguments: {
        identifier: "TECHTEST-999",
      },
    });
    const parsedIssue = JSON.parse(
      (issueCall.content as Array<{ type: string; text: string }>)[0].text,
    );
    expect(parsedIssue.found).toBe(true);
    expect(parsedIssue.identifier).toBe("TECHTEST-999");

    // 2. Kiểm tra qua HTTP transport
    const httpServer = runOnHttp(
      () =>
        createReceptionistMcpServer({
          def,
          db,
          tracker: fakeTracker,
          copy,
          clock: { now: () => 1_000_000 },
        }),
      { port: 0 },
    );

    const httpUrl = new URL(`http://127.0.0.1:${httpServer.port}/mcp`);
    const httpClientTransport = new StreamableHTTPClientTransport(httpUrl);
    const httpClient = new Client({ name: "http-client", version: "1.0.0" });
    await httpClient.connect(httpClientTransport);

    const httpToolsResult = await httpClient.listTools();
    expect(httpToolsResult.tools.map((t) => t.name)).toContain("intake_step");

    const httpCallResult = await httpClient.callTool({
      name: "intake_step",
      arguments: {
        chatId: "http_chat_1",
        message: "Lỗi thanh toán app Duo",
      },
    });
    const parsedHttpText = JSON.parse(
      (httpCallResult.content as Array<{ type: string; text: string }>)[0].text,
    );
    expect(parsedHttpText.action).toBe("ask_missing_field");

    httpServer.stop(true);
  });

  it("mọi lỗi tool MCP trả về kết quả thường kèm cờ loi: true, không ném lên host", async () => {
    const errorTool = lookupTools({
      tracker: {
        createIssue: async () => {
          throw new Error("Tracker sập");
        },
        getIssue: async () => null,
        addComment: async () => {},
        attach: async () => 0,
        findByIdentifier: async () => {
          throw new Error("Tracker sập hoàn toàn");
        },
      },
    })[0];

    const res = (await errorTool.handler({
      identifier: "TECH-123",
    })) as {
      loi: boolean;
      ma_loi: string;
      thong_bao_cho_nguoi_dung: string;
      chi_tiet: string;
    };

    expect(res.loi).toBe(true);
    expect(typeof res.ma_loi).toBe("string");
    expect(res.thong_bao_cho_nguoi_dung).toContain("Mã lỗi:");
    expect(res.chi_tiet).toContain("Tracker sập hoàn toàn");
  });

  it("gói skill sinh ra đúng cấu trúc thư mục", async () => {
    const def = defineBot({
      id: "tieulinh",
      tracker: { team: "tech", project: "TECH" },
      receptionist: {
        catalog: testCatalog,
        priorityRules: testUrgency,
        extractor: {
          extract: async () => ({
            userIntent: "report_issue" as const,
            title: "t",
            values: {},
            rawText: "",
          }),
        },
      },
    });

    const copy = makeCopyCatalog(TEST_COPY);
    const pack = exportSkillPack(def, { copy, botDisplayName: "Tiểu Linh" });

    expect(pack.botId).toBe("tieulinh");
    const paths = pack.files.map((f) => f.path);

    expect(paths).toContain("bot.json");
    expect(paths).toContain("IDENTITY.md");
    expect(paths).toContain("SOUL.md");
    expect(paths).toContain("AGENTS.md");
    expect(paths).toContain("messages/greeting.md");
    expect(paths).toContain("messages/help.md");
    expect(paths).toContain("messages/after-reset.md");
    expect(paths).toContain("skills/incident-intake/SKILL.md");
    expect(paths).toContain("skills/check-status/SKILL.md");
    expect(paths).toContain("references/priority-matrix.md");
    expect(paths).toContain("references/incident-taxonomy.md");

    const botJson = JSON.parse(pack.files.find((f) => f.path === "bot.json")?.content ?? "{}");
    expect(botJson.id).toBe("tieulinh");
    expect(botJson.tracker.projectKey).toBe("TECH");

    const greeting = pack.files.find((f) => f.path === "messages/greeting.md")?.content;
    expect(greeting).toBe(TEST_COPY["skill.message.greeting"]);
  });
});
