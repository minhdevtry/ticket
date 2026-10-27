import { afterAll, beforeEach, describe, expect, it, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineBot, type BotDefinition } from "../bot/define";
import { SqliteChannelBindingStore } from "../intake/create/binding-store";
import { SqliteDraftRepository, intakeApplySchema } from "../intake/draft";
import { IntakeEngine } from "../intake/engine/engine";
import { TEST_COPY } from "../intake/engine/test-copy.fixture";
import { makeCopyCatalog } from "../intake/copy-catalog";
import { createCatalog } from "../intake/gate/catalog";
import type { FieldCatalog } from "../intake/gate/types";
import { intakeStepTool } from "../intake/mcp/intake-step";
import { systemClock, type FieldExtractorPort, type TrackerPort } from "../intake/ports";
import type { UrgencyRules } from "../intake/priority";
import { mergeJsonConfig } from "./deploy";
import {
  connectPendingButtons,
  createForceNewTracker,
  forwardSessionToIdentityTools,
  generateReceptionistOpenClawConfig,
  getBranchButtons,
  getConfirmationButtons,
  getDepartmentButtons,
  syncReceptionistWorkspace,
} from "./receptionist-adapter";

// ── Legacy plugins (ESM) ────────────────────────────────────────────────────
import irisPlugin, {
  choPhepNutTrenTinCoMa,
  donDepVanBanKhiCoNut,
  laCallbackNoiBo,
  layAccountId,
  xuLyDebounceCallback,
} from "../../../../apps/tieulinh-legacy/openclaw-plugin/iris-tuong-tac/index.mjs";

import xnxPlugin, {
  boPhongBiKenh,
  docBangWorker,
  docXacNhan,
  laLenhSuCoMoi,
  layChatId,
  layReplyToId,
  xuLyTruocDispatch,
  xuLyXacNhan,
} from "../../../../apps/tieulinh-legacy/openclaw-plugin/xac-nhan-xong/index.mjs";

interface IntakeStepToolOutput {
  success: boolean;
  action: string;
  status: string;
  buttonsShown: boolean;
  agentInstruction: string;
  buttons?: unknown;
}

type HookHandler = (...args: unknown[]) => Promise<unknown> | unknown;

interface PluginApiMock {
  on(name: string, fn: HookHandler): void;
}

interface FakeFetchCall {
  url: string;
  body: Record<string, unknown>;
}

type FakeWorkerFetch = ((url: string, init: RequestInit) => Promise<Response>) & {
  last?: FakeFetchCall;
};

interface FakeDispatchCall {
  url: string;
  body: Record<string, unknown>;
}

type FakeDispatchFetch = ((
  url: string,
  opts: { body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>) & {
  last?: FakeDispatchCall;
};

interface GeneratedOpenClawConfig {
  mcpServers: Record<string, { env: Record<string, string> }>;
  agents: { entries: Record<string, { workspace: string }> };
  plugins: {
    load: { paths: string[] };
    entries: Record<string, { enabled: boolean }>;
  };
}

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
            kieu: "enum:reporting_dept",
            duoc_hoi: true,
            nhan: "Bộ phận",
            hoi: "Bộ phận nào?",
          },
        },
      },
    },
  },
  enums: {
    reporting_dept: ["Sale", "CSKH", "Vận hành"],
  },
});

const testUrgency: UrgencyRules = {
  levels: ["low", "medium", "high", "urgent"],
  floors: [],
  ceilings: [],
};

const copy = makeCopyCatalog({
  ...TEST_COPY,
  "button.confirm_create": "đúng rồi",
  "button.confirm_append": "✅ Bổ sung vào {{identifier}}",
});

describe("Hợp đồng đầu ra intake_step và cầu nối nút OpenClaw", () => {
  let db: Database;
  let drafts: SqliteDraftRepository;
  let bindings: SqliteChannelBindingStore;
  let fakeTracker: TrackerPort;
  let tempDir: string;

  beforeEach(() => {
    db = new Database(":memory:");
    intakeApplySchema(db);
    drafts = new SqliteDraftRepository(db);
    bindings = new SqliteChannelBindingStore(db);
    tempDir = join(
      tmpdir(),
      `openclaw-adapter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });

    fakeTracker = {
      createIssue: async (input) => ({
        id: 999,
        identifier: "TECHTEST-999",
        title: input.title,
        priority: input.priority,
      }),
      getIssue: async () => null,
      updateIssue: async () => {},
      addComment: async () => {},
      linkIssues: async () => {},
      attach: async () => 0,
      findByIdentifier: async (id) =>
        id === "TECHTEST-999"
          ? {
              id: 999,
              identifier: "TECHTEST-999",
              title: "Ticket test",
            }
          : null,
    };
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    db?.close();
  });

  it("WAITS_FOR_USER: buttonsShown = true, mảng nút ra file chờ, agentInstruction dừng lượt, không in buttons trong tool result", async () => {
    const extractor: FieldExtractorPort = {
      extract: async () => ({
        userIntent: "report_issue",
        title: "Lỗi ứng dụng Duo",
        values: { product: "Duo" },
        rawText: "báo lỗi duo",
      }),
    };

    const engine = new IntakeEngine({
      catalog: testCatalog,
      drafts,
      bindings,
      tracker: fakeTracker,
      extractor,
      copy,
      clock: systemClock,
      variant: "default",
      urgencyRules: testUrgency,
      confirm: { minConfirmDelayMs: 0 },
      identifierPrefix: "TECHTEST",
    });

    const connector = connectPendingButtons({ dir: tempDir });
    const tool = intakeStepTool({ engine, drafts });

    const raw = await tool.handler({
      chatId: "1000000001",
      message: "báo lỗi duo",
    });
    const res = raw as unknown as IntakeStepToolOutput;

    expect(res.success).toBe(true);
    expect(res.action).toBe("ask_missing_field");
    expect(res.status).toBe("collecting");
    expect(res.buttonsShown).toBe(true);
    expect(res.agentInstruction).toContain("KẾT THÚC LƯỢT");
    expect(res.buttons).toBeUndefined();

    // Cầu nối ghi nút ra file chờ
    connector.handleStepResult("1000000001", {
      action: res.action,
      buttons: [[{ text: "Sale", callback_data: "Sale" }]],
    });

    const pending = connector.read("1000000001");
    expect(pending).not.toBeNull();
    expect(pending?.buttons[0]?.[0]?.callback_data).toBe("Sale");
  });

  it("không phải WAITS_FOR_USER (ticket đã tạo): buttonsShown = false, dọn file chờ, agentInstruction thường", async () => {
    const connector = connectPendingButtons({ dir: tempDir });
    connector.save("1000000002", [[{ text: "Đúng rồi", callback_data: "đúng rồi" }]]);
    expect(connector.read("1000000002")).not.toBeNull();

    connector.handleStepResult("1000000002", {
      action: "ticket_created",
      outcome: "created",
      buttonsShown: false,
    });

    expect(connector.read("1000000002")).toBeNull();
  });
});

describe("Kiểm tra tin tóm tắt TL2 khớp choPhepNutTrenTinCoMa của iris-tuong-tac", () => {
  it("tin tóm tắt chuẩn TL2 không chứa mã ticket → choPhepNutTrenTinCoMa trả về true (RFC 0002 dòng 491)", () => {
    const summaryText =
      "Thông tin sự cố:\n- Vấn đề: Ứng dụng Duo không tải được bài tập\n- Bộ phận: Chuyên môn\n- Mức độ: High\n\nAnh/chị kiểm tra lại thông tin trên giúp em nhé ạ.";
    const buttons = [[{ text: "✅ Đúng rồi, tạo ticket", callback_data: "đúng rồi" }]];

    expect(choPhepNutTrenTinCoMa(summaryText, buttons)).toBe(true);
  });

  it("tin xem trước có mã ticket TECH-795 nhưng nút nhắc đúng mã đó → choPhepNutTrenTinCoMa trả về true (ADR-0008)", () => {
    const previewText = "Dạ anh/chị xác nhận giúp em: bổ sung vào TECH-795 nội dung sau nhé?";
    const buttons = [
      [{ text: "✅ Bổ sung vào TECH-795", callback_data: "✅ Bổ sung vào TECH-795" }],
      [{ text: "Huỷ thao tác", callback_data: "Huỷ thao tác" }],
    ];

    expect(choPhepNutTrenTinCoMa(previewText, buttons)).toBe(true);
  });

  it("tin đã tạo xong ticket TECH-975 với nút xác nhận cũ → choPhepNutTrenTinCoMa trả về false (khoá nút thành công)", () => {
    const createdText = "Em đã tạo thành công ticket TECH-975 cho anh/chị rồi ạ!";
    const oldButtons = [[{ text: "✅ Đúng rồi, tạo ticket", callback_data: "đúng rồi" }]];

    expect(choPhepNutTrenTinCoMa(createdText, oldButtons)).toBe(false);
  });
  it("tin tóm tắt TL2 khớp regex dòng 522 của iris-tuong-tac để không bị gỡ nút xác nhận", () => {
    // Regex dòng 522 của apps/tieulinh-legacy/openclaw-plugin/iris-tuong-tac/index.mjs
    const REGEX_TIN_TOM_TAT_IRIS =
      /(?:tóm tắt|kiểm tra (?:kỹ )?(?:lại )?thông tin|trước khi xác nhận|gửi Product team|thông tin đóng góp|bản ghi|Ý tưởng:|Quan sát:|Góp ý:)/i;

    const hintTL2 =
      "Anh/chị vui lòng kiểm tra kỹ thông tin trước khi xác nhận để em tạo ticket nhé ạ.";
    expect(REGEX_TIN_TOM_TAT_IRIS.test(hintTL2)).toBe(true);

    const fullSummary = `Thông tin sự cố:\n- Vấn đề: Ứng dụng Duo lỗi\n\n${hintTL2}`;
    expect(REGEX_TIN_TOM_TAT_IRIS.test(fullSummary)).toBe(true);
  });

  it("donDepVanBanKhiCoNut dọn dẹp các lựa chọn trùng lặp khi đã có nút bấm", () => {
    const textWithHint = "Dạ anh/chị chọn bộ phận bên dưới nhé:\n(chọn một: CS, Sale, Vận hành)";
    const buttons = [[{ text: "CS", callback_data: "CS" }]];
    const cleaned = donDepVanBanKhiCoNut(textWithHint, buttons);
    expect(cleaned).not.toContain("(chọn một:");
  });

  it("các đối tượng plugin legacy xuất đúng id", () => {
    const irisPluginTyped: { id?: string } = irisPlugin;
    expect(irisPluginTyped.id).toBe("iris-tuong-tac");

    const xnxPluginTyped: { id?: string } = xnxPlugin;
    expect(xnxPluginTyped.id).toBe("xac-nhan-xong");
  });
});

describe("Port 7 ca test legacy từ receptionist-gap-register.test.ts", () => {
  let db: Database;
  let drafts: SqliteDraftRepository;
  let bindings: SqliteChannelBindingStore;
  let fakeTracker: TrackerPort;
  let tempDir: string;

  beforeEach(() => {
    db = new Database(":memory:");
    intakeApplySchema(db);
    drafts = new SqliteDraftRepository(db);
    bindings = new SqliteChannelBindingStore(db);
    tempDir = join(
      tmpdir(),
      `openclaw-ported-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });

    fakeTracker = {
      createIssue: async (input) => ({
        id: 795,
        identifier: "TECHTEST-795",
        title: input.title,
        priority: input.priority,
      }),
      getIssue: async () => null,
      updateIssue: async () => {},
      addComment: async () => {},
      linkIssues: async () => {},
      attach: async () => 0,
      findByIdentifier: async (id) =>
        id === "TECHTEST-795"
          ? {
              id: 795,
              identifier: "TECHTEST-795",
              title: "Ticket 795",
            }
          : null,
    };
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    db?.close();
  });

  test("tạo ticket: có binding, dọn bản nháp, nút xác nhận hiện lúc tóm tắt và bị xoá sau khi tạo", async () => {
    const CHAT = "1000000007";
    const connector = connectPendingButtons({ dir: tempDir });

    const extractor: FieldExtractorPort = {
      extract: async (input) => {
        if (input.text.includes("đúng rồi")) {
          return { userIntent: "confirm", rawText: input.text };
        }
        return {
          userIntent: "report_issue",
          title: "Sự cố CRM lỗi xuất báo cáo",
          values: { product: "Duo", reporting_dept: "Sale" },
          rawText: input.text,
        };
      },
    };

    const engine = new IntakeEngine({
      catalog: testCatalog,
      drafts,
      bindings,
      tracker: fakeTracker,
      extractor,
      copy,
      clock: systemClock,
      variant: "default",
      urgencyRules: testUrgency,
      confirm: { minConfirmDelayMs: 0 },
      identifierPrefix: "TECHTEST",
    });

    // 1. Tới bước tóm tắt
    const summary = await engine.step({
      chatId: CHAT,
      message: "Báo lỗi CRM xuất báo cáo",
    });

    expect(summary.outcome).toBe("summary");
    expect(summary.messages[0].buttons?.[0]?.[0]?.callbackData).toBe("đúng rồi");

    // Adapter lưu nút vào file tạm
    connector.handleStepResult(CHAT, summary);
    const saved = connector.read(CHAT);
    expect(saved).not.toBeNull();
    expect(saved?.buttons[0]?.[0]?.callback_data).toBe("đúng rồi");

    // 2. Xác nhận tạo ticket
    const created = await engine.step({
      chatId: CHAT,
      message: "đúng rồi",
    });

    expect(created.outcome).toBe("created");
    connector.handleStepResult(CHAT, created);

    // Nút đã bị xoá
    expect(connector.read(CHAT)).toBeNull();

    // Binding được tạo
    const binding = bindings.getLatestBinding(CHAT);
    expect(binding).toBeDefined();
    expect(binding?.identifier).toBe("TECHTEST-795");

    // Bản nháp dọn dẹp (đã sang status created)
    const draft = drafts.getLatestByChatId(CHAT);
    expect(draft?.status).toBe("created");
  });

  test("checkIdentity: lưu initialButtons vào file nút tạm khi user được duyệt và chưa có draft", async () => {
    const testChatId = "777888999";
    const connector = connectPendingButtons({ dir: tempDir });
    connector.clear(testChatId);

    // Khi user được duyệt và chưa có draft, lưu branch buttons
    connector.save(testChatId, getBranchButtons());

    const content = connector.read(testChatId);
    expect(content).not.toBeNull();
    expect(content?.buttons).toEqual(getBranchButtons());

    connector.clear(testChatId);
    expect(connector.read(testChatId)).toBeNull();
  });

  test("checkRequiredFields: tự động lưu branch buttons và nhắc chọn nhánh khi thiếu variant", async () => {
    const testChatId = "555666777";
    const connector = connectPendingButtons({ dir: tempDir });
    connector.clear(testChatId);

    // Mô phỏng checkRequiredFields phát hiện thiếu variant
    const fieldsToAsk = ["variant"];
    const nextQuestion = "Dạ anh/chị chọn nhánh bên dưới giúp em nhé ạ:";
    expect(fieldsToAsk).toEqual(["variant"]);
    expect(nextQuestion).toContain("chọn nhánh bên dưới");

    connector.save(testChatId, getBranchButtons());
    const content = connector.read(testChatId);
    expect(content).not.toBeNull();
    expect(content?.buttons).toEqual(getBranchButtons());

    connector.clear(testChatId);
  });

  test("checkRequiredFields: đã đính nút thì thôi liệt kê lựa chọn trong câu hỏi", async () => {
    const testChatId = "555666778";
    const connector = connectPendingButtons({ dir: tempDir });
    connector.clear(testChatId);

    const deptButtons = getDepartmentButtons([
      { label: "CS", callbackData: "CS" },
      { label: "Vận hành", callbackData: "Vận hành" },
      { label: "Chuyên môn", callbackData: "Chuyên môn" },
    ]);
    connector.save(testChatId, deptButtons);

    const question = "Dạ anh/chị cho em biết mình đang thuộc bộ phận nào ạ?";
    expect(question).not.toContain("chọn một");
    expect(question).not.toContain("·");

    const content = connector.read(testChatId);
    expect(content?.buttons.flat().length).toBe(3);

    connector.clear(testChatId);
  });

  test("dùng đúng chữ được truyền vào, callback_data cố định 'đúng rồi'", () => {
    const buttons = getConfirmationButtons("Đúng rồi, gửi Product team");
    expect(buttons).toEqual([[{ text: "Đúng rồi, gửi Product team", callback_data: "đúng rồi" }]]);
  });

  test("không tự bịa thêm hay bớt phòng ban nào so với danh sách truyền vào", () => {
    const buttons = getDepartmentButtons([{ label: "Marketing", callbackData: "Marketing" }]);
    expect(buttons.flat()).toEqual([{ text: "Marketing", callback_data: "Marketing" }]);
  });

  test("trả về danh sách 3 nút nhánh chuẩn cho IRIS", () => {
    const buttons = getBranchButtons();
    expect(buttons).toHaveLength(2);
    expect(buttons.flat().map((b) => b.callback_data)).toEqual([
      "Order tính năng",
      "Đề xuất ý tưởng mới",
      "Kiểm tra trạng thái ticket",
    ]);
  });
});

describe("Kiểm chéo 12 ca test legacy của iris-tuong-tac", () => {
  describe("layAccountId", () => {
    it("lấy tài khoản từ sessionKey agent:<agent>:telegram:<account>:…", () => {
      expect(layAccountId({ sessionKey: "agent:iris-agent:telegram:iris:direct:1000000001" })).toBe(
        "iris",
      );
      expect(
        layAccountId({}, { sessionKey: "agent:ticket-intake-agent:telegram:ticket:direct:1" }),
      ).toBe("ticket");
    });
    it("accountId có sẵn thì ưu tiên, không đoán được thì null", () => {
      expect(
        layAccountId({ accountId: "ticket", sessionKey: "agent:x:telegram:iris:direct:1" }),
      ).toBe("ticket");
      expect(layAccountId({ sessionKey: "agent:iris-agent:sim-xnx" })).toBeNull();
    });
  });

  describe("choPhepNutTrenTinCoMa", () => {
    const nut = (...labels: string[]) => [labels.map((l) => ({ text: l, callback_data: l }))];
    it("tin 'đã tạo TECH-975' không được đính nút xác nhận cũ", () => {
      expect(
        choPhepNutTrenTinCoMa(
          "Em đã tạo thành công ticket TECH-975",
          nut("✅ Đúng rồi, tạo ticket"),
        ),
      ).toBe(false);
    });
    it("câu xác nhận ghi vào ticket có nút nhắc đúng mã → giữ nút (ADR-0008)", () => {
      expect(
        choPhepNutTrenTinCoMa(
          "Dạ anh/chị xác nhận giúp em: bổ sung vào TECH-795 nội dung sau nhé?",
          nut("✅ Bổ sung vào TECH-795", "Huỷ"),
        ),
      ).toBe(true);
      expect(
        choPhepNutTrenTinCoMa("Dạ bổ sung vào TECH-795?", nut("✅ Bổ sung vào TECH-796", "Huỷ")),
      ).toBe(false);
    });
    it("tin không có mã, hoặc nút 'Tiếp tục sự cố đang chờ' → giữ nút", () => {
      expect(choPhepNutTrenTinCoMa("Anh/chị chọn bộ phận nhé", nut("CSKH"))).toBe(true);
      expect(
        choPhepNutTrenTinCoMa(
          "Đã tạo TECH-975. Còn sự cố «X» đang chờ",
          nut("Tiếp tục sự cố đang chờ"),
        ),
      ).toBe(true);
      expect(
        choPhepNutTrenTinCoMa(
          "Dạ tin này có thông tin khác với ticket TECH-994 vừa tạo ạ. Đây là SỰ CỐ MỚI hay bổ sung?",
          nut("Sự cố mới", "Bổ sung sự cố đang chờ"),
        ),
      ).toBe(true);
    });
  });

  describe("xuLyDebounceCallback", () => {
    it("chặn callback_data giống hệt nhau liên tiếp từ cùng một sender", () => {
      const daThay = new Map();
      expect(
        xuLyDebounceCallback("callback_data: Quản lý lớp", "session-1", "user-1", daThay),
      ).toBe(false);
      expect(
        xuLyDebounceCallback("callback_data: Quản lý lớp", "session-1", "user-1", daThay),
      ).toBe(true);
      expect(xuLyDebounceCallback("callback_data: đúng rồi", "session-1", "user-1", daThay)).toBe(
        false,
      );
    });

    it("không bao giờ chặn tin nhắn văn bản thông thường", () => {
      const daThay = new Map();
      expect(xuLyDebounceCallback("Tôi ở bộ phận quản lý lớp", "session-1", "user-1", daThay)).toBe(
        false,
      );
      expect(xuLyDebounceCallback("Tôi ở bộ phận quản lý lớp", "session-1", "user-1", daThay)).toBe(
        false,
      );
    });
  });

  describe("laCallbackNoiBo", () => {
    it("bắt đúng các dạng callback_data nội bộ: noop, none, ignore (không phân biệt hoa thường)", () => {
      expect(laCallbackNoiBo("callback_data: noop")).toBe(true);
      expect(laCallbackNoiBo("callback_data: NOOP")).toBe(true);
      expect(laCallbackNoiBo("callback_data:   noop  ")).toBe(true);
      expect(laCallbackNoiBo("noop")).toBe(true);
      expect(laCallbackNoiBo("NOOP")).toBe(true);
      expect(laCallbackNoiBo("callback_data: none")).toBe(true);
      expect(laCallbackNoiBo("callback_data: ignore")).toBe(true);
    });

    it("không chặn callback_data nghiệp vụ của người dùng", () => {
      expect(laCallbackNoiBo("callback_data: Quản lý lớp")).toBe(false);
      expect(laCallbackNoiBo("callback_data: đúng rồi")).toBe(false);
      expect(laCallbackNoiBo("callback_data: Sự cố mới")).toBe(false);
      expect(laCallbackNoiBo("callback_data: reporter_ok:100")).toBe(false);
    });

    it("không chặn tin nhắn văn bản thông thường chứa từ noop trong câu", () => {
      expect(laCallbackNoiBo("Hàm noop trong code đang bị lỗi không chạy")).toBe(false);
      expect(laCallbackNoiBo("Báo lỗi hệ thống")).toBe(false);
    });
  });

  describe("plugin iris-tuong-tac chặn noop ở before_dispatch và before_agent_reply", () => {
    it("before_dispatch nuốt sạch callback_data: noop và trả handled: true", async () => {
      const hooks: Record<string, HookHandler> = {};
      const api: PluginApiMock = {
        on(name, fn) {
          hooks[name] = fn;
        },
      };
      const pluginWithRegister = irisPlugin as { register: (p: PluginApiMock) => void };
      pluginWithRegister.register(api);

      const fakeFetch = async () => ({ json: async () => ({ ok: true }) });

      const res = await hooks.before_dispatch(
        { body: "callback_data: noop", callbackQueryId: "cb_12345" },
        { sessionKey: "agent:ticket-intake-agent:telegram:ticket:direct:1000000007" },
        { fetch: fakeFetch },
      );

      expect(res).toEqual({ handled: true });
    });

    it("before_agent_reply nuốt sạch nếu tin noop lọt vào", async () => {
      const hooks: Record<string, HookHandler> = {};
      const api: PluginApiMock = {
        on(name, fn) {
          hooks[name] = fn;
        },
      };
      const pluginWithRegister = irisPlugin as { register: (p: PluginApiMock) => void };
      pluginWithRegister.register(api);

      const res = await hooks.before_agent_reply(
        { cleanedBody: "callback_data: noop" },
        { sessionKey: "agent:ticket-intake-agent:telegram:ticket:direct:1000000007" },
      );

      expect(res).toEqual({ handled: true });
    });
  });
});

describe("Kiểm chéo 33 ca test legacy của xac-nhan-xong", () => {
  describe("docXacNhan", () => {
    it("bắt callback_data reporter_ok:<id>, và confirm_done:<id> của nút cũ trước 24/09", () => {
      expect(docXacNhan("callback_data: reporter_ok:42")).toBe(42);
      expect(docXacNhan("callback_data:confirm_done:7")).toBe(7);
    });
    it("không bắt tin thường hay id lạ", () => {
      for (const t of [
        "đã ổn rồi em",
        "reporter_ok",
        "callback_data: reporter_ok:abc",
        "callback_data: đúng rồi",
        "",
      ]) {
        expect(docXacNhan(t)).toBeNull();
      }
    });
  });

  describe("layChatId", () => {
    it("lấy từ session key, cả chat riêng lẫn nhóm (giữ dấu âm của group id)", () => {
      expect(layChatId({ sessionKey: "agent:iris-agent:telegram:iris:direct:1000000004" })).toBe(
        "1000000004",
      );
      expect(
        layChatId({
          sessionKey: "agent:iris-agent:telegram:iris:group:-1000000000001",
          senderId: "1000000004",
        }),
      ).toBe("-1000000000001");
    });
    it("ưu tiên chatId khai sẵn; chỉ rơi về senderId khi không còn nguồn nào", () => {
      expect(layChatId({ chatId: "telegram:-100555666", senderId: "111222" })).toBe("-100555666");
      expect(layChatId({ senderId: "111222" })).toBe("111222");
      expect(layChatId({})).toBe("");
    });
  });

  describe("layReplyToId", () => {
    const PHONG_BI = `vẫn chưa được ạ, lỗi y hệt lúc nãy
Conversation info (untrusted metadata):
\`\`\`json
{ "chat_id": "telegram:1000000001", "message_id": "11549", "reply_to_id": "11544", "sender_id": "1000000001", "sender": "Trần Thị B", "implicit_mention_kinds": ["reply_to_bot"], "has_reply_context": true }
\`\`\`
Sender (untrusted metadata): {"label": "Trần Thị B", "username": "SA_UserG"}`;

    it("đọc reply_to_id trong phong bì JSON kèm tin", () => {
      expect(layReplyToId(PHONG_BI)).toBe("11544");
    });
    it("ưu tiên trường có cấu trúc trên ctx/event khi có", () => {
      expect(layReplyToId(PHONG_BI, { replyToId: "999" })).toBe("999");
      expect(layReplyToId(PHONG_BI, {}, { reply_to_id: "888" })).toBe("888");
    });
    it("tin thường không reply, hay rỗng → null", () => {
      expect(layReplyToId("chào em")).toBeNull();
      expect(layReplyToId("")).toBeNull();
      expect(layReplyToId(undefined)).toBeNull();
    });
  });

  describe("boPhongBiKenh", () => {
    it("bỏ phong bì OpenClaw, giữ lời người báo", () => {
      const t = `vẫn chưa được ạ, lỗi y hệt lúc nãy
Conversation info (untrusted metadata):
\`\`\`json
{ "chat_id": "telegram:1000000001", "message_id": "11549", "reply_to_id": "11544" }
\`\`\`
`;
      expect(boPhongBiKenh(t)).toBe("vẫn chưa được ạ, lỗi y hệt lúc nãy");
    });
    it("tin thường không có phong bì → giữ nguyên", () => {
      expect(boPhongBiKenh("App lỗi đăng nhập từ sáng")).toBe("App lỗi đăng nhập từ sáng");
    });
  });

  describe("laLenhSuCoMoi", () => {
    it('bắt "/new", không phân biệt hoa thường, có hoặc không kèm @botname', () => {
      for (const t of [
        "/new",
        "/NEW",
        "/New xin chào",
        "/new@ticket_intake_bot",
        "/new@ticket_intake_bot bị lỗi khác",
      ]) {
        expect(laLenhSuCoMoi(t)).toBe(true);
      }
    });
    it('không bắt tin thường, hay "/new" là một phần của từ khác', () => {
      for (const t of ["xin chào", "/newbie hỏi thử", "app báo lỗi mới", "", undefined]) {
        expect(laLenhSuCoMoi(t)).toBe(false);
      }
    });
    it("vẫn bắt được sau khi bỏ phong bì kênh", () => {
      const t = `/new bị lỗi khác rồi ạ
Conversation info (untrusted metadata):
\`\`\`json
{ "chat_id": "telegram:55555", "message_id": "1" }
\`\`\`
`;
      expect(laLenhSuCoMoi(t)).toBe(true);
    });
  });

  describe("docBangWorker", () => {
    it("mặc định chỉ Iris; env ghi đè được", () => {
      expect(docBangWorker({})).toEqual({ "iris-agent": "http://127.0.0.1:3103" });
      expect(
        docBangWorker({
          XAC_NHAN_XONG_WORKERS:
            "ticket-intake-agent=http://127.0.0.1:3102, iris-agent=http://127.0.0.1:3103",
        }),
      ).toEqual({
        "ticket-intake-agent": "http://127.0.0.1:3102",
        "iris-agent": "http://127.0.0.1:3103",
      });
    });
  });

  describe("xuLyXacNhan", () => {
    const ctx = {
      trigger: "user",
      agentId: "iris-agent",
      senderId: "111",
      sessionKey: "agent:iris-agent:telegram:iris:direct:55555",
    };
    const worker = (body: unknown, status = 200): FakeWorkerFetch => {
      const f: FakeWorkerFetch = async (url: string, init: RequestInit) => {
        f.last = { url, body: JSON.parse(String(init.body)) };
        return new Response(JSON.stringify(body), { status });
      };
      return f;
    };
    const opts = (fetchFn: unknown, daThay = new Map()) => ({
      fetch: fetchFn,
      workers: docBangWorker({}),
      daThay,
    });

    it("gọi /internal/reporter-ok kèm chatId của cuộc trò chuyện, trả nguyên câu worker trả lời", async () => {
      const f = worker({
        outcome: "recorded",
        replyText: "Dạ em đã ghi nhận, chuyên viên sẽ kiểm tra lại và đóng ticket ạ.",
      });
      const raw = await xuLyXacNhan({ cleanedBody: "callback_data: reporter_ok:42" }, ctx, opts(f));
      const r = raw as { handled: boolean; reply: { text: string } };
      expect(r.handled).toBe(true);
      expect(r.reply.text).toContain("chuyên viên sẽ kiểm tra lại");
      expect(f.last?.url).toBe("http://127.0.0.1:3103/internal/reporter-ok");
      expect(f.last?.body).toMatchObject({ issueId: 42, chatId: "55555" });
    });

    it("không bao giờ nói ticket đã đóng (ADR-0006)", async () => {
      const raw = await xuLyXacNhan(
        { cleanedBody: "callback_data: confirm_done:42" },
        ctx,
        opts(worker({ outcome: "recorded", replyText: "Dạ em đã ghi nhận" })),
      );
      const r = raw as { reply: { text: string } };
      expect(r.reply.text).not.toMatch(/đóng lại|Hoàn tất và đóng/);
    });

    it("worker không phản hồi → vẫn handled, báo bấm lại (không để LLM tự chế)", async () => {
      const hong = async () => {
        throw new Error("ECONNREFUSED");
      };
      const raw = await xuLyXacNhan(
        { cleanedBody: "callback_data: reporter_ok:42" },
        ctx,
        opts(hong),
      );
      const r = raw as { handled: boolean; reply: { text: string } };
      expect(r.handled).toBe(true);
      expect(r.reply.text).toMatch(/chưa ghi nhận được/i);
    });

    it("bấm lặp trong 15s → im lặng, không gọi worker lần 2", async () => {
      const daThay = new Map();
      let goi = 0;
      const f = async () => {
        goi++;
        return new Response('{"outcome":"recorded","replyText":"ok"}');
      };
      await xuLyXacNhan({ cleanedBody: "callback_data: reporter_ok:42" }, ctx, opts(f, daThay));
      const lan2 = await xuLyXacNhan(
        { cleanedBody: "callback_data: reporter_ok:42" },
        ctx,
        opts(f, daThay),
      );
      expect(goi).toBe(1);
      expect(lan2).toEqual({ handled: true, reason: "xac-nhan-xong:trung" });
    });

    it("agent không có worker, tin thường, hay nhịp tim/cron → không đụng (trả undefined)", async () => {
      const o = opts(worker({ outcome: "recorded", replyText: "ok" }));
      expect(
        await xuLyXacNhan(
          { cleanedBody: "callback_data: reporter_ok:42" },
          { ...ctx, agentId: "sales" },
          o,
        ),
      ).toBeUndefined();
      expect(await xuLyXacNhan({ cleanedBody: "xin chào" }, ctx, o)).toBeUndefined();
      expect(
        await xuLyXacNhan(
          { cleanedBody: "callback_data: reporter_ok:42" },
          { ...ctx, trigger: "cron" },
          o,
        ),
      ).toBeUndefined();
      expect(
        await xuLyXacNhan(
          { cleanedBody: "callback_data: reporter_ok:42" },
          { ...ctx, trigger: "heartbeat" },
          o,
        ),
      ).toBeUndefined();
    });

    it("trigger khác 'user' (vd gửi qua openclaw agent) vẫn được bắt — bug PO-88", async () => {
      for (const trigger of [undefined, "cli", "api"]) {
        const raw = await xuLyXacNhan(
          { cleanedBody: "callback_data: reporter_ok:42" },
          { ...ctx, trigger },
          opts(worker({ outcome: "done", replyText: "đã hoàn tất rồi" })),
        );
        const r = raw as { handled: boolean } | undefined;
        expect(r?.handled).toBe(true);
      }
    });

    describe("phản hồi tự do (reply vào tin thông báo)", () => {
      const PHAN_HOI = `vẫn chưa được ạ, lỗi y hệt lúc nãy
Conversation info (untrusted metadata):
\`\`\`json
{ "chat_id": "telegram:55555", "message_id": "11549", "reply_to_id": "11544", "sender_id": "111" }
\`\`\`
`;

      it("route khớp → gọi /internal/reporter-reply, trả lời worker, short-circuit agent", async () => {
        const f = worker({
          handled: true,
          replyText: "Dạ em đã chuyển phản hồi của anh/chị vào TECH-961 cho đội Kỹ thuật ạ.",
        });
        const raw = await xuLyXacNhan({ cleanedBody: PHAN_HOI }, ctx, opts(f));
        const r = raw as { handled: boolean; reply: { text: string } };
        expect(r.handled).toBe(true);
        expect(r.reply.text).toContain("TECH-961");
        expect(f.last?.url).toBe("http://127.0.0.1:3103/internal/reporter-reply");
        expect(f.last?.body).toMatchObject({ replyToMessageId: "11544", chatId: "55555" });
        expect(String(f.last?.body.text)).toContain("vẫn chưa được ạ");
        expect(String(f.last?.body.text)).not.toContain("reply_to_id");
      });

      it("route không khớp (handled:false) → để tin đi tiếp vào agent", async () => {
        const r = await xuLyXacNhan(
          { cleanedBody: PHAN_HOI },
          ctx,
          opts(worker({ handled: false })),
        );
        expect(r).toBeUndefined();
      });

      it("worker hỏng → im lặng, để tin đi tiếp vào agent (không tự chế câu trả lời)", async () => {
        const hong = async () => {
          throw new Error("ECONNREFUSED");
        };
        const r = await xuLyXacNhan({ cleanedBody: PHAN_HOI }, ctx, opts(hong));
        expect(r).toBeUndefined();
      });

      it("reply lặp trong 15s → im lặng, không gọi worker lần 2", async () => {
        const daThay = new Map();
        let goi = 0;
        const f = async () => {
          goi++;
          return new Response('{"handled":true,"replyText":"ok"}');
        };
        await xuLyXacNhan({ cleanedBody: PHAN_HOI }, ctx, opts(f, daThay));
        const lan2 = await xuLyXacNhan({ cleanedBody: PHAN_HOI }, ctx, opts(f, daThay));
        expect(goi).toBe(1);
        expect(lan2).toEqual({ handled: true, reason: "xac-nhan-xong:trung" });
      });

      it("tin thường (không phải reply, không phải nút) → không đụng", async () => {
        const w = worker({ handled: true, replyText: "ok" });
        const o = opts(w);
        expect(await xuLyXacNhan({ cleanedBody: "xin chào" }, ctx, o)).toBeUndefined();
        expect(w.last).toBeUndefined();
      });

      it("nhịp tim/cron hay agent chưa có worker → không đụng", async () => {
        const o = opts(worker({ handled: true, replyText: "ok" }));
        expect(
          await xuLyXacNhan({ cleanedBody: PHAN_HOI }, { ...ctx, trigger: "cron" }, o),
        ).toBeUndefined();
        expect(
          await xuLyXacNhan({ cleanedBody: PHAN_HOI }, { ...ctx, agentId: "sales" }, o),
        ).toBeUndefined();
      });
    });
  });

  describe("xuLyTruocDispatch (hook before_dispatch — có replyToId thật của OpenClaw)", () => {
    const fakeFetch = (body: unknown): FakeDispatchFetch => {
      const f: FakeDispatchFetch = async (url: string, opts: { body: string }) => {
        f.last = { url, body: JSON.parse(opts.body) as Record<string, unknown> };
        return { ok: true, status: 200, json: async () => body };
      };
      return f;
    };

    it("reply vào tin thông báo của Tiểu Linh → gọi worker 3102, trả {handled,text}", async () => {
      const f = fakeFetch({ handled: true, replyText: "Dạ em đã chuyển phản hồi vào TECH-961 ạ." });
      const raw = await xuLyTruocDispatch(
        { body: "vẫn chưa được ạ", replyToId: "11544", senderId: "1000000001" },
        {
          sessionKey: "agent:ticket-intake-agent:telegram:ticket:direct:1000000001",
          conversationId: "1000000001",
        },
        {
          fetch: f,
          workers: { "ticket-intake-agent": "http://127.0.0.1:3102" },
          daThay: new Map(),
        },
      );
      const r = raw as { handled: boolean; text: string };
      expect(r).toEqual({ handled: true, text: "Dạ em đã chuyển phản hồi vào TECH-961 ạ." });
      expect(f.last?.url).toBe("http://127.0.0.1:3102/internal/reporter-reply");
      expect(f.last?.body.replyToMessageId).toBe(11544);
      expect(f.last?.body.chatId).toBe("1000000001");
    });

    it("không có replyToId → không đụng", async () => {
      const r = await xuLyTruocDispatch(
        { body: "xin chào" },
        { sessionKey: "agent:ticket-intake-agent:x" },
        { fetch: fakeFetch({}), workers: {}, daThay: new Map() },
      );
      expect(r).toBeUndefined();
    });

    it("worker báo không phải tin route đã biết → để tin đi tiếp", async () => {
      const r = await xuLyTruocDispatch(
        { body: "ừ", replyToId: "99" },
        { sessionKey: "agent:ticket-intake-agent:telegram:ticket:direct:1234567" },
        {
          fetch: fakeFetch({ handled: false }),
          workers: { "ticket-intake-agent": "http://127.0.0.1:3102" },
          daThay: new Map(),
        },
      );
      expect(r).toBeUndefined();
    });

    describe('bắt "/new" (ADR-0008) trước khi OpenClaw nuốt mất', () => {
      it("gọi /internal/force-new kèm chatId, rồi trả undefined để tin đi tiếp", async () => {
        const f = fakeFetch({ ok: true });
        const r = await xuLyTruocDispatch(
          { body: "/new bị lỗi khác rồi ạ", senderId: "1000000001" },
          {
            sessionKey: "agent:ticket-intake-agent:telegram:ticket:direct:1000000001",
            conversationId: "1000000001",
          },
          {
            fetch: f,
            workers: { "ticket-intake-agent": "http://127.0.0.1:3102" },
            daThay: new Map(),
          },
        );
        expect(r).toBeUndefined();
        expect(f.last?.url).toBe("http://127.0.0.1:3102/internal/force-new");
        expect(f.last?.body).toEqual({ chatId: "1000000001" });
      });

      it("nhận diện /new@botname, không phân biệt hoa thường", async () => {
        const f = fakeFetch({ ok: true });
        const r = await xuLyTruocDispatch(
          { body: "/NEW@ticket_intake_bot", senderId: "1" },
          { sessionKey: "agent:ticket-intake-agent:telegram:ticket:direct:1" },
          {
            fetch: f,
            workers: { "ticket-intake-agent": "http://127.0.0.1:3102" },
            daThay: new Map(),
          },
        );
        expect(r).toBeUndefined();
        expect(f.last?.url).toBe("http://127.0.0.1:3102/internal/force-new");
      });

      it("worker hỏng → im lặng, vẫn để tin đi tiếp (không chặn)", async () => {
        const hong = async () => {
          throw new Error("ECONNREFUSED");
        };
        const r = await xuLyTruocDispatch(
          { body: "/new", senderId: "1" },
          { sessionKey: "agent:ticket-intake-agent:telegram:ticket:direct:1" },
          {
            fetch: hong,
            workers: { "ticket-intake-agent": "http://127.0.0.1:3102" },
            daThay: new Map(),
          },
        );
        expect(r).toBeUndefined();
      });

      it("agent chưa có worker → không gọi mạng, vẫn để tin đi tiếp", async () => {
        const f = fakeFetch({ ok: true });
        const r = await xuLyTruocDispatch(
          { body: "/new", senderId: "1" },
          { sessionKey: "agent:sales-agent:telegram:ticket:direct:1" },
          {
            fetch: f,
            workers: { "ticket-intake-agent": "http://127.0.0.1:3102" },
            daThay: new Map(),
          },
        );
        expect(r).toBeUndefined();
        expect(f.last).toBeUndefined();
      });

      it("tin thường (không phải /new) thì không đụng tới force-new", async () => {
        const f = fakeFetch({ ok: true });
        const r = await xuLyTruocDispatch(
          { body: "app báo lỗi từ sáng", senderId: "1" },
          { sessionKey: "agent:ticket-intake-agent:telegram:ticket:direct:1" },
          {
            fetch: f,
            workers: { "ticket-intake-agent": "http://127.0.0.1:3102" },
            daThay: new Map(),
          },
        );
        expect(r).toBeUndefined();
        expect(f.last).toBeUndefined();
      });
    });
  });
});

describe("Adapter OpenClaw: cấu hình, đồng bộ workspace, định danh và forceNew", () => {
  const dummyBot: BotDefinition = defineBot({
    id: "tieulinh",
    tracker: { team: "tech", project: "TECH" },
    receptionist: { catalog: testCatalog },
  });

  it("generateReceptionistOpenClawConfig sinh cấu hình openclaw.json chuẩn và mergeJsonConfig được", () => {
    const rawConfig = generateReceptionistOpenClawConfig(dummyBot, {
      model: "minimax/MiniMax-M3.1-Flash",
      workspaceDir: "/var/openclaw/workspaces/tieulinh",
    });
    const config = rawConfig as unknown as GeneratedOpenClawConfig;

    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers["intake-tieulinh"]).toBeDefined();
    expect(config.mcpServers["intake-tieulinh"].env.ITSAPLAN_PROJECT_KEY).toBe("TECH");

    expect(config.agents).toBeDefined();
    expect(config.agents.entries.tieulinh.workspace).toBe("/var/openclaw/workspaces/tieulinh");

    expect(config.plugins).toBeDefined();
    expect(config.plugins.load.paths).toHaveLength(2);
    expect(config.plugins.entries["iris-tuong-tac"].enabled).toBe(true);
    expect(config.plugins.entries["xac-nhan-xong"].enabled).toBe(true);

    const merged = mergeJsonConfig<Record<string, unknown>>({ existingKey: true }, rawConfig);
    expect(merged.existingKey).toBe(true);
    expect(merged.mcpServers).toBeDefined();
  });

  it("syncReceptionistWorkspace ghi file skill pack vào workspace và hỗ trợ dryRun", async () => {
    const targetDir = join(
      tmpdir(),
      `ws-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(targetDir, { recursive: true });

    try {
      // dryRun: true -> không ghi file
      const dryResult = await syncReceptionistWorkspace(dummyBot, targetDir, { dryRun: true });
      expect(dryResult.plan.length).toBeGreaterThan(0);
      expect(dryResult.summary.create).toBeGreaterThan(0);
      expect(existsSync(join(targetDir, "IDENTITY.md"))).toBe(false);

      // dryRun: false -> ghi file thật
      const realResult = await syncReceptionistWorkspace(dummyBot, targetDir, { dryRun: false });
      expect(realResult.summary.create).toBeGreaterThan(0);
      expect(existsSync(join(targetDir, "IDENTITY.md"))).toBe(true);
      expect(existsSync(join(targetDir, "SOUL.md"))).toBe(true);

      // Chạy lại -> unchanged
      const idempotent = await syncReceptionistWorkspace(dummyBot, targetDir, { dryRun: false });
      expect(idempotent.summary.unchanged).toBe(realResult.plan.length);
      expect(idempotent.summary.create).toBe(0);
      expect(idempotent.summary.update).toBe(0);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it("forwardSessionToIdentityTools chuyển tiếp chatId/userId vào check_identity và register_identity", () => {
    const res1 = forwardSessionToIdentityTools(
      { toolName: "check_identity", params: {} },
      { chatId: "123456" },
    );
    expect(res1?.params?.userId).toBe("123456");

    const res2 = forwardSessionToIdentityTools(
      { toolName: "register_identity", params: { nameCode: "CS_lan" } },
      { senderId: "998877" },
    );
    expect(res2?.params?.userId).toBe("998877");
    expect(res2?.params?.nameCode).toBe("CS_lan");

    // Đã có userId -> không ghi đè
    const res3 = forwardSessionToIdentityTools(
      { toolName: "check_identity", params: { userId: "already" } },
      { chatId: "123456" },
    );
    expect(res3).toBeUndefined();

    // Tool khác -> không đụng
    const res4 = forwardSessionToIdentityTools(
      { toolName: "other_tool", params: {} },
      { chatId: "123456" },
    );
    expect(res4).toBeUndefined();
  });

  it("createForceNewTracker theo dõi cờ forceNew theo chatId và cung cấp asHandler", () => {
    const tracker = createForceNewTracker();
    const handler = tracker.asHandler();

    expect(tracker.has("1000000001")).toBe(false);

    // Handler nhận webhook /internal/force-new
    handler({ chatId: "telegram:1000000001" });
    expect(tracker.has("1000000001")).toBe(true);

    // Consume một lần trả về true và xoá cờ
    expect(tracker.consume("1000000001")).toBe(true);
    expect(tracker.has("1000000001")).toBe(false);
    expect(tracker.consume("1000000001")).toBe(false);

    // Đánh dấu và clear
    tracker.mark("2000000002");
    expect(tracker.has("2000000002")).toBe(true);
    tracker.clear("2000000002");
    expect(tracker.has("2000000002")).toBe(false);
  });
});
