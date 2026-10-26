import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intakeApplySchema } from "../draft";
import { notifyApplySchema } from "../notify";
import {
  BindingSchemaError,
  LEGACY_BINDING_TABLES,
  assertNotLegacyFile,
  detectBindingSchema,
  isLegacyFile,
  legacyBindingApplySchema,
  openLegacyBindingDb,
  resolveBindingSchema,
} from "./binding-schema";
import { SqliteChannelBindingStore } from "./binding-store";
import {
  LEGACY_SCHEMA_DDL,
  applyLegacySchemaFixture,
  schemaSnapshot,
  tl1BindIssueToChat,
  tl1GetBindingByIssueId,
} from "./legacy-schema.fixture";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "binding-schema-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function legacyDb(): Database {
  const db = new Database(":memory:");
  applyLegacySchemaFixture(db);
  return db;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
type Col = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
const cols = (db: Database, t: string) =>
  (db.query(`PRAGMA table_info(${t})`).all() as Col[]).map(
    ({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }),
  );

describe("nhận dạng schema", () => {
  test("không bảng: null; core: core; legacy: legacy", () => {
    const empty = new Database(":memory:");
    expect(detectBindingSchema(empty)).toBeNull();
    expect(resolveBindingSchema(empty)).toBe("core");

    const core = new Database(":memory:");
    intakeApplySchema(core, { wal: false });
    expect(detectBindingSchema(core)).toBe("core");

    expect(detectBindingSchema(legacyDb())).toBe("legacy");
  });

  test("có message_id mà thiếu cột lõi: không phải dạng đã biết, ném lỗi", () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE ticket_bindings (issue_id INTEGER PRIMARY KEY, message_id TEXT NOT NULL)`);
    expect(() => detectBindingSchema(db)).toThrow(BindingSchemaError);
  });

  test("isLegacyFile: dạng legacy, hoặc bảng đặc trưng của TL1, kể cả khi chưa có ticket_bindings", () => {
    expect(isLegacyFile(legacyDb())).toBe(true);
    const onlyMarker = new Database(":memory:");
    onlyMarker.run(
      `CREATE TABLE intake_sessions (session_id TEXT PRIMARY KEY, state_json TEXT NOT NULL)`,
    );
    expect(isLegacyFile(onlyMarker)).toBe(true);
    const core = new Database(":memory:");
    intakeApplySchema(core, { wal: false });
    // identity của core cũng tạo user_identities: không được coi đó là dấu hiệu của TL1
    core.run(`CREATE TABLE user_identities (telegram_user_id TEXT PRIMARY KEY)`);
    expect(isLegacyFile(core)).toBe(false);
  });
});

describe("migration không bao giờ đổi schema file legacy", () => {
  test("intakeApplySchema và notifyApplySchema từ chối file legacy, sqlite_master y nguyên", () => {
    const db = legacyDb();
    const before = schemaSnapshot(db);
    expect(() => intakeApplySchema(db, { wal: false })).toThrow(BindingSchemaError);
    expect(() => notifyApplySchema(db, { wal: false })).toThrow(BindingSchemaError);
    expect(() => assertNotLegacyFile(db, "x")).toThrow(/Tiểu Linh 1/);
    expect(schemaSnapshot(db)).toEqual(before);
  });

  test("tờ khai TL2 và TL1 không chung file: áp intakeApplySchema lên file chỉ có tờ khai TL1 cũng bị chặn", () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE intake_sessions (session_id TEXT PRIMARY KEY, state_json TEXT NOT NULL)`);
    db.run(`CREATE TABLE intake_documents (doc_id TEXT NOT NULL, state_json TEXT NOT NULL)`);
    expect(() => intakeApplySchema(db, { wal: false })).toThrow(BindingSchemaError);
  });

  test("hai file khác nhau cho cùng tên bảng intake_documents: mỗi file giữ hình dạng của mình", () => {
    const tl2Drafts = new Database(":memory:");
    intakeApplySchema(tl2Drafts, { wal: false });
    const tl1 = legacyDb();
    // cùng tên bảng, cùng cột; khác ở chỉ mục và ở nội dung state_json (IntakeDraft vs IntakeDocument)
    const idx = (db: Database) =>
      (
        db.query(`SELECT sql FROM sqlite_master WHERE name = 'idx_intake_docs_chat'`).get() as {
          sql: string;
        }
      ).sql;
    expect(norm(idx(tl2Drafts))).toContain("(chat_id, updated_at DESC)");
    expect(norm(idx(tl1))).toContain("(chat_id, revision DESC)");
  });

  test("áp lên file core vẫn như cũ (ALTER bù cột cho DB core cũ)", () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE ticket_bindings (
      issue_id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, identifier TEXT NOT NULL,
      title TEXT, reporter_username TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    intakeApplySchema(db, { wal: false });
    notifyApplySchema(db, { wal: false });
    expect(cols(db, "ticket_bindings").map((c) => c.name)).toContain("reporter_user_id");
  });
});

describe("legacyBindingApplySchema / openLegacyBindingDb", () => {
  test("DDL tạo-khi-thiếu cùng hình dạng với schema TL1 (cột, kiểu, NOT NULL, DEFAULT, khoá)", () => {
    const made = new Database(":memory:");
    legacyBindingApplySchema(made);
    const tl1 = legacyDb();
    expect(cols(made, "ticket_bindings")).toEqual(cols(tl1, "ticket_bindings"));
    expect(cols(made, "message_routes")).toEqual(cols(tl1, "message_routes"));
    // và TL1 mở file này sau đó vẫn dùng được (applySchema của TL1 là CREATE IF NOT EXISTS + ALTER bắt lỗi)
    tl1BindIssueToChat(made, { id: 1, identifier: "TECH-1" }, "c");
    expect(tl1GetBindingByIssueId(made, 1)?.messageId).toBe("0");
  });

  test("file legacy đã có: không tạo, không ALTER, không thêm index", () => {
    const db = legacyDb();
    db.run(`DROP INDEX idx_bindings_reporter`); // file TL1 cũ thiếu một index
    const before = schemaSnapshot(db);
    legacyBindingApplySchema(db);
    expect(schemaSnapshot(db)).toEqual(before);
  });

  test("file dạng core bị từ chối", () => {
    const db = new Database(":memory:");
    intakeApplySchema(db, { wal: false });
    expect(() => legacyBindingApplySchema(db)).toThrow(BindingSchemaError);
  });

  test("openLegacyBindingDb: file mới tạo dạng legacy, quyền 0600; ghi bằng store, TL1 đọc lại", () => {
    const file = join(tmp(), "sub", "legacy.sqlite");
    const db = openLegacyBindingDb(file);
    try {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const store = new SqliteChannelBindingStore(db, { schema: "legacy" });
      store.saveBinding({ issueId: 7, chatId: "c", identifier: "TECH-7" });
      expect(tl1GetBindingByIssueId(db, 7)?.channelType).toBe("telegram");
    } finally {
      db.close();
    }
  });

  test("openLegacyBindingDb trên file TL1 có sẵn: không đổi schema, không đổi quyền file", () => {
    const file = join(tmp(), "tl1.sqlite");
    const seed = new Database(file, { create: true });
    applyLegacySchemaFixture(seed);
    tl1BindIssueToChat(seed, { id: 1, identifier: "TECH-1" }, "chat-A");
    const before = schemaSnapshot(seed);
    seed.close();
    chmodSync(file, 0o640); // quyền do TL1 / vận hành đặt: ta không được đổi

    const db = openLegacyBindingDb(file);
    try {
      expect(schemaSnapshot(db)).toEqual(before);
      expect(new SqliteChannelBindingStore(db).getLatestBinding("chat-A")?.identifier).toBe(
        "TECH-1",
      );
    } finally {
      db.close();
    }
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  test("openLegacyBindingDb trên file core: ném và không để kết nối mở", () => {
    const file = join(tmp(), "core.sqlite");
    const seed = new Database(file, { create: true });
    intakeApplySchema(seed, { wal: false });
    seed.close();
    expect(() => openLegacyBindingDb(file)).toThrow(BindingSchemaError);
    expect(existsSync(file)).toBe(true);
  });
});

describe("fixture không trôi khỏi schema legacy thật", () => {
  const source = join(import.meta.dir, "../../../../../apps/tieulinh-legacy/lib/storage/schema.ts");

  test.skipIf(!existsSync(source))(
    "LEGACY_SCHEMA_DDL khớp mảng SCHEMA của apps/tieulinh-legacy",
    () => {
      const text = readFileSync(source, "utf8");
      const start = text.indexOf("export const SCHEMA = [");
      const body = text.slice(start, text.indexOf("\n];", start));
      const real = [...body.matchAll(/`(CREATE[^`]*)`/g)].map((m) => norm(m[1] as string));
      expect(LEGACY_SCHEMA_DDL.map(norm)).toEqual(real);
    },
  );

  test.skipIf(!existsSync(source))(
    "LEGACY_BINDING_TABLES.ticket_bindings là nguyên văn các câu của legacy",
    () => {
      const real = new Set(LEGACY_SCHEMA_DDL.map(norm));
      for (const s of LEGACY_BINDING_TABLES.ticket_bindings) expect(real.has(norm(s))).toBe(true);
    },
  );
});
