/**
 * PR 3 của RFC 0002 (mục 6.2): kho binding của core sống chung file SQLite với Tiểu Linh 1.
 *
 * Schema legacy dựng từ `legacy-schema.fixture.ts` (DDL sao từ `apps/tieulinh-legacy/lib/storage/schema.ts`), "TL1"
 * là các câu SQL sao nguyên văn của `TicketBindingRepository` trong cùng fixture. Không import code legacy.
 *
 * Port từ legacy (sổ đối chiếu):
 *  - `lib/storage/binding-repository.test.ts` (7): 3 test `message_routes` theo chat, 2 test migration, 2 test
 *    `getLatestBinding` theo dự án. Migration của TL1 là việc của TL1: ở đây thành "core KHÔNG migrate file legacy" (`by-design`).
 *    Nhánh `reporterUsername` của `getLatestBinding` legacy không có trong `ChannelBindingStore` của core (`by-design`).
 *  - `mcp/shared/tools/confirmation-and-binding.test.ts`, phần binding: "create_issue userConfirmed lưu binding",
 *    "check_identity latestTicket" (có binding, và cũ hơn 30 phút), "get_issue tra ticket gần nhất theo chat".
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteDraftRepository, intakeApplySchema, newDraft } from "../draft";
import { markSummaryShown, MIN_CONFIRM_DELAY_MS } from "../confirm";
import { makeCopyCatalog } from "../copy-catalog";
import { TEST_COPY } from "../engine/test-copy.fixture";
import { SqliteMessageRouteStore, SqliteNotifyBindingReader, notifyApplySchema } from "../notify";
import type { CreateIssueInput, TrackerIssue, TrackerPort } from "../ports";
import {
  BindingSchemaError,
  LEGACY_MESSAGE_ID_PLACEHOLDER,
  legacyBindingApplySchema,
} from "./binding-schema";
import { SqliteChannelBindingStore } from "./binding-store";
import { createTicket } from "./create-ticket";
import {
  applyLegacySchemaFixture,
  schemaSnapshot,
  tl1BindIssueToChat,
  tl1GetBindingByIssueId,
  tl1GetLatestBinding,
  tl1GetMessageRoute,
  tl1SaveBinding,
  tl1SaveMessageRoute,
} from "./legacy-schema.fixture";

function legacyDb(): Database {
  const db = new Database(":memory:");
  applyLegacySchemaFixture(db);
  return db;
}

function coreDb(): Database {
  const db = new Database(":memory:");
  intakeApplySchema(db, { wal: false });
  notifyApplySchema(db, { wal: false });
  return db;
}

const SHAPES = [
  ["legacy", legacyDb],
  ["core", coreDb],
] as const;

describe("chốt dạng schema (explicit, dò cột)", () => {
  test("auto: dò ra legacy / core theo bảng đang có", () => {
    expect(new SqliteChannelBindingStore(legacyDb()).schema).toBe("legacy");
    expect(new SqliteChannelBindingStore(coreDb()).schema).toBe("core");
    expect(new SqliteChannelBindingStore(legacyDb()).supportsReporterUserId).toBe(false);
    expect(new SqliteChannelBindingStore(coreDb()).supportsReporterUserId).toBe(true);
  });

  test("cờ khẳng định lệch dạng thật thì ném ngay ở constructor, không ghi gì", () => {
    expect(() => new SqliteChannelBindingStore(legacyDb(), { schema: "core" })).toThrow(
      BindingSchemaError,
    );
    expect(() => new SqliteChannelBindingStore(coreDb(), { schema: "legacy" })).toThrow(
      BindingSchemaError,
    );
    expect(new SqliteChannelBindingStore(legacyDb(), { schema: "legacy" }).schema).toBe("legacy");
  });

  test("schema=legacy mà chưa có bảng: ném (phải mở bằng openLegacyBindingDb)", () => {
    expect(
      () => new SqliteChannelBindingStore(new Database(":memory:"), { schema: "legacy" }),
    ).toThrow(BindingSchemaError);
  });

  test("bảng core nhưng ghi thẳng câu INSERT của core vào file legacy thì vi phạm NOT NULL (vì sao cần dạng legacy)", () => {
    const db = legacyDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO ticket_bindings (issue_id, chat_id, identifier) VALUES (1, 'c', 'TECH-1')`,
        )
        .run(),
    ).toThrow(/NOT NULL/);
  });
});

describe("hai chiều: core ghi vào file legacy, TL1 đọc", () => {
  test("TL1 đọc được binding core ghi: channel_type telegram, message_id giữ chỗ như bindIssueToChat", () => {
    const db = legacyDb();
    const store = new SqliteChannelBindingStore(db);
    store.saveBinding({
      issueId: 888,
      chatId: "chat-A",
      identifier: "TECH-888",
      title: "Lỗi thanh toán học phí",
      reporterUsername: "@user_cs_a",
      reporterUserId: "555000014", // không có chỗ lưu ở legacy: bỏ, không được làm hỏng ghi
    });
    expect(tl1GetBindingByIssueId(db, 888)).toEqual({
      issueId: 888,
      channelType: "telegram",
      chatId: "chat-A",
      messageId: LEGACY_MESSAGE_ID_PLACEHOLDER,
      identifier: "TECH-888",
      title: "Lỗi thanh toán học phí",
      reporterUsername: "user_cs_a",
    });
    expect(tl1GetLatestBinding(db, "chat-A", undefined, "TECH")?.identifier).toBe("TECH-888");
    expect(tl1GetLatestBinding(db, "chat-B", "USER_CS_A")?.identifier).toBe("TECH-888");
  });

  test("ghi y như TL1: cùng issue ghi lại thì cập nhật, title/username cũ giữ khi lần sau bỏ trống", () => {
    const db = legacyDb();
    const store = new SqliteChannelBindingStore(db);
    tl1BindIssueToChat(db, { id: 5, identifier: "TECH-5", title: "Tiêu đề TL1" }, "chat-A", "u1");
    store.saveBinding({ issueId: 5, chatId: "chat-B", identifier: "TECH-5" });
    expect(tl1GetBindingByIssueId(db, 5)).toMatchObject({
      chatId: "chat-B",
      title: "Tiêu đề TL1",
      reporterUsername: "u1",
      channelType: "telegram",
      messageId: "0",
    });
    // title rỗng như TL1: `""` thành NULL, không đè title cũ
    store.saveBinding({ issueId: 5, chatId: "chat-B", identifier: "TECH-5", title: "" });
    expect(tl1GetBindingByIssueId(db, 5)?.title).toBe("Tiêu đề TL1");
  });

  test("không đụng schema: ghi nhiều lần xong sqlite_master y nguyên", () => {
    const db = legacyDb();
    const before = schemaSnapshot(db);
    const store = new SqliteChannelBindingStore(db);
    for (let i = 1; i <= 3; i++) {
      store.saveBinding({ issueId: i, chatId: "c", identifier: `TECH-${i}` });
    }
    store.getLatestBinding("c");
    store.getLatestBindingByUserId("u");
    store.rebindReporterUserId("a", "b");
    expect(schemaSnapshot(db)).toEqual(before);
  });
});

describe("hai chiều: TL1 ghi vào file legacy, core đọc", () => {
  test("getLatestBinding đọc binding do TL1 ghi (kể cả chat id có tiền tố)", () => {
    const db = legacyDb();
    tl1BindIssueToChat(db, { id: 1, identifier: "TECH-1", title: "Một" }, "-1000000000001", "u1");
    const store = new SqliteChannelBindingStore(db);
    expect(store.getLatestBinding("-1000000000001")).toEqual({
      issueId: 1,
      identifier: "TECH-1",
      title: "Một",
    });
    expect(store.getLatestBinding("telegram:-1000000000001")?.issueId).toBe(1);
    expect(store.getLatestBinding("-1000000000002")).toBeNull();
  });

  test("SqliteNotifyBindingReader (đường worker/closure của TL2) đọc binding TL1: kênh telegram, user id rỗng", () => {
    const db = legacyDb();
    tl1BindIssueToChat(db, { id: 9, identifier: "TECH-9", title: "Chín" }, 12345, "@Nguoi_Bao");
    const reader = new SqliteNotifyBindingReader(db);
    expect(reader.getBindingByIssueId(9)).toEqual({
      issueId: 9,
      chatId: "12345",
      identifier: "TECH-9",
      channelType: "telegram",
      title: "Chín",
      reporterUsername: "Nguoi_Bao",
      reporterUserId: undefined,
    });
    expect(reader.getBindingByIssueId(10)).toBeNull();
  });

  test("tra theo user id: legacy không có cột nên null, rebind trả 0, không ném", () => {
    const db = legacyDb();
    tl1BindIssueToChat(db, { id: 1, identifier: "TECH-1" }, "c", "u1");
    const store = new SqliteChannelBindingStore(db);
    expect(store.getLatestBindingByUserId("u1")).toBeNull();
    expect(store.rebindReporterUserId("u1", "u2")).toBe(0);
  });
});

describe("hai chiều trên dạng core (cùng store, cùng hợp đồng)", () => {
  test("core ghi rồi core đọc, có reporter_user_id", () => {
    const store = new SqliteChannelBindingStore(coreDb());
    store.saveBinding({
      issueId: 1,
      chatId: "c",
      identifier: "TECH-1",
      title: "Một",
      reporterUserId: "u1",
    });
    expect(store.getLatestBinding("c")?.identifier).toBe("TECH-1");
    expect(store.getLatestBindingByUserId("u1")?.issueId).toBe(1);
  });

  test("dạng core: TL1 không đọc được (thiếu cột), đó là lý do dùng file legacy khi chung với TL1", () => {
    const db = coreDb();
    new SqliteChannelBindingStore(db).saveBinding({
      issueId: 1,
      chatId: "c",
      identifier: "TECH-1",
    });
    expect(() => tl1GetBindingByIssueId(db, 1)).toThrow(/message_id|channel_type/);
    expect(() =>
      tl1SaveBinding(db, {
        issueId: 2,
        channelType: "telegram",
        chatId: "c",
        messageId: "0",
        identifier: "TECH-2",
      }),
    ).toThrow(/message_id|channel_type/);
  });
});

// ── port: binding-repository.test.ts, message_routes theo chat (cả hai dạng) ─────────────────────────────────

describe.each(SHAPES)("message_routes theo chat, dạng %s", (_name, open) => {
  let db: Database;
  let routes: SqliteMessageRouteStore;
  const route = (messageId: string, issueId: number, identifier: string, chatId: string) => ({
    messageId,
    channelType: "telegram",
    chatId,
    issueId,
    identifier,
    kind: "" as const,
  });
  beforeEach(() => {
    db = open();
    routes = new SqliteMessageRouteStore(db);
  });

  test("cùng message_id ở hai chat khác nhau không đè nhau, tra đúng ticket theo chat", () => {
    routes.saveMessageRoute(route("55", 1, "TECH-1", "chat-A"));
    routes.saveMessageRoute(route("55", 2, "PO-2", "chat-B"));
    expect(routes.getMessageRoute("55", "telegram", "chat-A")?.identifier).toBe("TECH-1");
    expect(routes.getMessageRoute("55", "telegram", "chat-B")?.identifier).toBe("PO-2");
    expect(routes.getMessageRoute("55", "telegram", "chat-C")).toBeNull();
  });

  test("dòng cũ không có chat_id chỉ khớp khi binding của ticket đó nằm đúng chat", () => {
    new SqliteChannelBindingStore(db).saveBinding({
      issueId: 7,
      chatId: "chat-A",
      identifier: "TECH-7",
    });
    // worker bản cũ ghi route không kèm chat_id
    db.run(
      `INSERT INTO message_routes (message_id, channel_type, issue_id, identifier) VALUES ('77', 'telegram', 7, 'TECH-7')`,
    );
    expect(routes.getMessageRoute("77", "telegram", "chat-A")?.identifier).toBe("TECH-7");
    expect(routes.getMessageRoute("77", "telegram", "chat-B")).toBeNull();
  });

  test("dòng có chat_id đúng được ưu tiên hơn dòng cũ không rõ chat", () => {
    new SqliteChannelBindingStore(db).saveBinding({
      issueId: 8,
      chatId: "chat-A",
      identifier: "TECH-8",
    });
    db.run(
      `INSERT INTO message_routes (message_id, channel_type, issue_id, identifier) VALUES ('88', 'telegram', 8, 'TECH-8')`,
    );
    routes.saveMessageRoute(route("88", 9, "TECH-9", "chat-A"));
    expect(routes.getMessageRoute("88", "telegram", "chat-A")?.identifier).toBe("TECH-9");
  });
});

describe("hai chiều: route", () => {
  test("TL1 ghi route (có kind), core đọc; core ghi route, TL1 đọc", () => {
    const db = legacyDb();
    const routes = new SqliteMessageRouteStore(db);
    tl1SaveMessageRoute(db, 100, "telegram", 3, "TECH-3", "chat-A", "comment");
    expect(routes.getMessageRoute("100", "telegram", "chat-A")).toEqual({
      messageId: "100",
      channelType: "telegram",
      chatId: "chat-A",
      issueId: 3,
      identifier: "TECH-3",
    });
    routes.saveMessageRoute({
      messageId: "200",
      channelType: "telegram",
      chatId: "chat-A",
      issueId: 4,
      identifier: "TECH-4",
      kind: "state",
    });
    expect(tl1GetMessageRoute(db, 200, "telegram", "chat-A")).toEqual({
      messageId: "200",
      chatId: "chat-A",
      issueId: 4,
      identifier: "TECH-4",
    });
    expect(
      (
        db.query(`SELECT kind FROM message_routes WHERE message_id = '200'`).get() as {
          kind: string;
        }
      ).kind,
    ).toBe("state");
  });
});

// ── port: binding-repository.test.ts, getLatestBinding theo dự án (cả hai dạng) ──────────────────────────────

describe.each(SHAPES)(
  "getLatestBinding theo dự án (hai bot dùng chung DB), dạng %s",
  (_name, open) => {
    test("lọc theo tiền tố dự án: không lấy nhầm ticket của bot kia dù mới hơn", () => {
      const db = open();
      const store = new SqliteChannelBindingStore(db);
      store.saveBinding({
        issueId: 1,
        chatId: "chat-A",
        identifier: "PO-80",
        reporterUsername: "user_c",
      });
      store.saveBinding({
        issueId: 2,
        chatId: "chat-A",
        identifier: "TECHTEST-110",
        reporterUsername: "user_c",
      });
      db.run(`UPDATE ticket_bindings SET updated_at = '2026-09-20 10:00:00' WHERE issue_id = 1`);
      db.run(`UPDATE ticket_bindings SET updated_at = '2026-09-25 10:00:00' WHERE issue_id = 2`);

      expect(store.getLatestBinding("chat-A")?.identifier).toBe("TECHTEST-110");
      expect(store.getLatestBinding("chat-A", "PO")?.identifier).toBe("PO-80");
      expect(store.getLatestBinding("chat-A", "TECHTEST")?.identifier).toBe("TECHTEST-110");
    });

    test("tiền tố phải khớp đủ: dự án TECH không lấy TECHTEST", () => {
      const store = new SqliteChannelBindingStore(open());
      store.saveBinding({ issueId: 2, chatId: "chat-A", identifier: "TECHTEST-110" });
      expect(store.getLatestBinding("chat-A", "TECH")).toBeNull();
    });
  },
);

// ── port: binding-repository.test.ts, migration message_routes ───────────────────────────────────────────────

describe("migration message_routes: core KHÔNG migrate file legacy", () => {
  /** File TL1 cũ: message_routes khoá (message_id, channel_type), thiếu chat_id và kind. */
  function oldLegacyFile(): Database {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE ticket_bindings (
      issue_id INTEGER PRIMARY KEY, channel_type TEXT NOT NULL, chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL, identifier TEXT NOT NULL, title TEXT, reporter_username TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE message_routes (
      message_id TEXT NOT NULL, channel_type TEXT NOT NULL, issue_id INTEGER NOT NULL,
      identifier TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id, channel_type))`);
    db.run(
      `INSERT INTO ticket_bindings (issue_id, channel_type, chat_id, message_id, identifier) VALUES (1, 'telegram', 'chat-A', '10', 'TECH-1')`,
    );
    db.run(
      `INSERT INTO message_routes (message_id, channel_type, issue_id, identifier, created_at) VALUES ('100', 'telegram', 1, 'TECH-1', '2026-09-01 10:00:00')`,
    );
    return db;
  }

  test("file chưa qua migration của TL1 bị từ chối, schema và dữ liệu y nguyên", () => {
    const db = oldLegacyFile();
    const before = schemaSnapshot(db);
    expect(() => legacyBindingApplySchema(db)).toThrow(BindingSchemaError);
    expect(schemaSnapshot(db)).toEqual(before);
    expect(db.query(`SELECT COUNT(*) AS n FROM message_routes`).get()).toEqual({ n: 1 });
  });

  test("chạy lại legacyBindingApplySchema nhiều lần trên file TL1 không đổi gì (idempotent)", () => {
    const db = legacyDb();
    new SqliteChannelBindingStore(db).saveBinding({
      issueId: 1,
      chatId: "c",
      identifier: "TECH-1",
    });
    const before = schemaSnapshot(db);
    legacyBindingApplySchema(db);
    legacyBindingApplySchema(db);
    legacyBindingApplySchema(db);
    expect(schemaSnapshot(db)).toEqual(before);
    expect(db.query(`SELECT COUNT(*) AS n FROM ticket_bindings`).get()).toEqual({ n: 1 });
  });
});

// ── port: confirmation-and-binding.test.ts, phần binding ─────────────────────────────────────────────────────

class FakeTracker implements TrackerPort {
  async createIssue(input: CreateIssueInput): Promise<TrackerIssue> {
    return { id: 888, identifier: "TECH-888", title: input.title, url: "https://t/888" };
  }
  async getIssue(id: number) {
    return { id, identifier: "TECH-888", title: "x" };
  }
  async addComment() {}
  async attach() {
    return 0;
  }
  async findByIdentifier() {
    return null;
  }
}

describe("tạo ticket qua createTicket với kho binding dạng legacy (tờ khai ở file riêng)", () => {
  function setup() {
    // Hai file khác nhau: tờ khai TL2 (dạng core) và binding (dạng legacy, chung với TL1).
    const draftsDb = new Database(":memory:");
    intakeApplySchema(draftsDb, { wal: false });
    const bindingDb = legacyDb();
    let now = 1_000_000;
    const clock = { now: () => now };
    const drafts = new SqliteDraftRepository(draftsDb);
    const nowIso = new Date(now).toISOString();
    const base = newDraft("doc_1", "tele_999", nowIso);
    base.ticket = {
      title: "Lỗi thanh toán học phí",
      rawText: "Phụ huynh chuyển khoản nhưng app chưa kích hoạt",
      priority: "high",
      mediaPaths: [],
    };
    drafts.saveRevision(markSummaryShown(base, clock));
    now += MIN_CONFIRM_DELAY_MS;
    const deps = {
      tracker: new FakeTracker(),
      drafts,
      bindings: new SqliteChannelBindingStore(bindingDb, { schema: "legacy" }),
      copy: makeCopyCatalog({ ...TEST_COPY, "ticket.created": "created {identifier} {url}" }),
      clock,
      identifierPrefix: "TECH",
    };
    return { deps, bindingDb, draftsDb, clock, advance: (ms: number) => (now += ms) };
  }

  test("xác nhận tạo ticket thì binding ghi vào file legacy, TL1 đọc được (create_issue userConfirmed)", async () => {
    const { deps, bindingDb, draftsDb } = setup();
    const res = await createTicket(deps, {
      chatId: "tele_999",
      reporter: { username: "user_cs_a", userId: "999" },
    });
    expect(res.kind).toBe("created");
    expect(tl1GetBindingByIssueId(bindingDb, 888)).toMatchObject({
      channelType: "telegram",
      chatId: "tele_999",
      messageId: "0",
      identifier: "TECH-888",
      reporterUsername: "user_cs_a",
    });
    // Không có bảng binding nào lọt vào file tờ khai, và ngược lại: hai file tách bạch.
    expect(draftsDb.query(`SELECT COUNT(*) AS n FROM ticket_bindings`).get()).toEqual({ n: 0 });
    expect(bindingDb.query(`SELECT COUNT(*) AS n FROM intake_documents`).get()).toEqual({ n: 0 });
  });

  test("bấm xác nhận lần hai không tạo thêm ticket và không nhân đôi binding", async () => {
    const { deps, bindingDb } = setup();
    await createTicket(deps, { chatId: "tele_999" });
    const second = await createTicket(deps, { chatId: "tele_999" });
    expect(second.kind).toBe("already_created");
    expect(bindingDb.query(`SELECT COUNT(*) AS n FROM ticket_bindings`).get()).toEqual({ n: 1 });
  });
});

describe("ngữ cảnh ticket gần nhất theo chat (check_identity / get_issue)", () => {
  test("có binding thì tra ra ticket gần nhất của chat (TL1 ghi, core đọc)", () => {
    const db = legacyDb();
    tl1SaveBinding(db, {
      issueId: 888,
      channelType: "telegram",
      chatId: "tele_999",
      messageId: "0",
      identifier: "TECH-888",
      title: "Lỗi thanh toán học phí",
      reporterUsername: "user_cs_a",
    });
    const latest = new SqliteChannelBindingStore(db).getLatestBinding("tele_999");
    expect(latest).toEqual({
      issueId: 888,
      identifier: "TECH-888",
      title: "Lỗi thanh toán học phí",
    });
  });

  test("binding cũ hơn 30 phút vẫn tra được; người gọi quyết định theo updated_at (core không ẩn)", () => {
    // legacy `check_identity` tự lọc theo tuổi (30 phút) ở tầng tool, không ở kho: kho chỉ trả ticket mới nhất.
    // Test giữ hợp đồng cho phần kho: updated_at của dòng TL1 ghi là mốc người gọi dùng.
    const db = legacyDb();
    tl1BindIssueToChat(db, { id: 889, identifier: "TECH-889" }, "tele_stale");
    const stale = new Date(Date.now() - 45 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    db.prepare(`UPDATE ticket_bindings SET updated_at = ? WHERE issue_id = ?`).run(stale, 889);
    expect(new SqliteChannelBindingStore(db).getLatestBinding("tele_stale")?.identifier).toBe(
      "TECH-889",
    );
    const row = db.query(`SELECT updated_at FROM ticket_bindings WHERE issue_id = 889`).get() as {
      updated_at: string;
    };
    expect(row.updated_at).toBe(stale);
  });

  test("chat không có binding thì null", () => {
    expect(new SqliteChannelBindingStore(legacyDb()).getLatestBinding("tele_none")).toBeNull();
  });
});
