import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteChannelBindingStore, normalizeUserId, normalizeUsername } from "./binding-store";
import { intakeApplySchema } from "../draft/schema";

/**
 * Mục 1 (lưu theo id): binding định danh người báo theo USER ID (bền), không
 * dựa username/tên. Test chứng minh: lưu + đọc reporter_user_id, tra ticket
 * theo user id độc lập chat, và DB CŨ (bảng thiếu cột) được ALTER bù không mất
 * dữ liệu — tương thích ngược cho OP.
 */

function freshDb(): Database {
  const db = new Database(":memory:", { create: true });
  intakeApplySchema(db, { wal: false });
  return db;
}

describe("normalizeUserId", () => {
  it("bóc tiền tố telegram: và trim; rỗng → null", () => {
    expect(normalizeUserId("telegram:555000014")).toBe("555000014");
    expect(normalizeUserId("  123 ")).toBe("123");
    expect(normalizeUserId("")).toBeNull();
    expect(normalizeUserId(undefined)).toBeNull();
  });
  it("KHÔNG đụng username (giữ nguyên hành vi cũ)", () => {
    expect(normalizeUsername("@TE_UserA")).toBe("TE_UserA");
  });
});

describe("SqliteChannelBindingStore — lưu người báo theo user id", () => {
  it("lưu reporterUserId và tra lại được theo user id, độc lập chat", () => {
    const store = new SqliteChannelBindingStore(freshDb());
    store.saveBinding({
      issueId: 1168,
      chatId: "telegram:555000014",
      identifier: "OP-2",
      title: "Lỗi ClassIn",
      reporterUserId: "555000014",
      reporterUsername: "TE_UserA",
    });
    // tra theo user id — không cần biết chat
    const byUser = store.getLatestBindingByUserId("555000014");
    expect(byUser?.identifier).toBe("OP-2");
    expect(byUser?.issueId).toBe(1168);
    // tiền tố telegram: cũng chấp nhận
    expect(store.getLatestBindingByUserId("telegram:555000014")?.issueId).toBe(1168);
  });

  it("getLatestBindingByUserId lọc theo prefix dự án", () => {
    const store = new SqliteChannelBindingStore(freshDb());
    store.saveBinding({ issueId: 1, chatId: "c", identifier: "OP-5", reporterUserId: "u1" });
    store.saveBinding({ issueId: 2, chatId: "c", identifier: "TECH-9", reporterUserId: "u1" });
    expect(store.getLatestBindingByUserId("u1", "OP")?.identifier).toBe("OP-5");
    expect(store.getLatestBindingByUserId("u1", "TECH")?.identifier).toBe("TECH-9");
  });

  it("id rỗng hoặc chưa ghi id → null (không khớp binding id NULL)", () => {
    const store = new SqliteChannelBindingStore(freshDb());
    // binding không có user id (bot cũ)
    store.saveBinding({ issueId: 3, chatId: "c", identifier: "OP-7" });
    expect(store.getLatestBindingByUserId("")).toBeNull();
    expect(store.getLatestBindingByUserId("whoever")).toBeNull();
    // tra theo chat vẫn chạy như cũ
    expect(store.getLatestBinding("c")?.identifier).toBe("OP-7");
  });

  it("username KHÔNG phải khóa: hai binding cùng user id, username đổi → vẫn tra ra theo id", () => {
    const store = new SqliteChannelBindingStore(freshDb());
    store.saveBinding({
      issueId: 10,
      chatId: "c1",
      identifier: "OP-10",
      reporterUserId: "u9",
      reporterUsername: "old_name",
    });
    store.saveBinding({
      issueId: 11,
      chatId: "c2",
      identifier: "OP-11",
      reporterUserId: "u9",
      reporterUsername: "new_name",
    });
    // mới nhất theo id, bất kể username/chat
    expect(store.getLatestBindingByUserId("u9")?.identifier).toBe("OP-11");
  });

  it("rebindReporterUserId: đổi tài khoản → mọi binding chuyển sang id mới (A1)", () => {
    const store = new SqliteChannelBindingStore(freshDb());
    store.saveBinding({ issueId: 20, chatId: "c", identifier: "OP-20", reporterUserId: "old" });
    store.saveBinding({ issueId: 21, chatId: "c", identifier: "OP-21", reporterUserId: "old" });
    store.saveBinding({ issueId: 22, chatId: "c", identifier: "OP-22", reporterUserId: "khac" }); // người khác

    const moved = store.rebindReporterUserId("old", "new");
    expect(moved).toBe(2);
    // tra theo id mới ra ticket cũ (lịch sử theo người giữ nguyên)
    expect(store.getLatestBindingByUserId("new")?.identifier).toBe("OP-21");
    // id cũ không còn
    expect(store.getLatestBindingByUserId("old")).toBeNull();
    // người khác không bị đụng
    expect(store.getLatestBindingByUserId("khac")?.identifier).toBe("OP-22");
  });

  it("rebindReporterUserId: id rỗng/bằng nhau/tiền tố telegram: → an toàn", () => {
    const store = new SqliteChannelBindingStore(freshDb());
    store.saveBinding({ issueId: 30, chatId: "c", identifier: "OP-30", reporterUserId: "123" });
    expect(store.rebindReporterUserId("", "new")).toBe(0);
    expect(store.rebindReporterUserId("123", "123")).toBe(0); // bằng nhau
    // tiền tố telegram: được chuẩn hóa cả hai đầu
    expect(store.rebindReporterUserId("telegram:123", "telegram:456")).toBe(1);
    expect(store.getLatestBindingByUserId("456")?.identifier).toBe("OP-30");
  });
});

describe("tương thích DB cũ (bảng ticket_bindings thiếu reporter_user_id)", () => {
  it("ALTER bù cột, giữ nguyên dữ liệu cũ, rồi lưu id được", () => {
    const db = new Database(":memory:", { create: true });
    // Dựng bảng CŨ y như intake trước khi có cột id
    db.run(`CREATE TABLE ticket_bindings (
      issue_id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, identifier TEXT NOT NULL,
      title TEXT, reporter_username TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(
      `INSERT INTO ticket_bindings (issue_id, chat_id, identifier, reporter_username) VALUES (99, 'c', 'OP-99', 'old')`,
    );

    // Áp schema mới → ALTER bù cột, không mất dòng cũ
    intakeApplySchema(db, { wal: false });
    const cols = (
      db.query(`PRAGMA table_info(ticket_bindings)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("reporter_user_id");

    const store = new SqliteChannelBindingStore(db);
    expect(store.getLatestBinding("c")?.identifier).toBe("OP-99"); // dòng cũ còn nguyên
    // binding cũ chưa có id → tra theo id không ra
    expect(store.getLatestBindingByUserId("anything")).toBeNull();
    // ghi binding mới có id → tra được
    store.saveBinding({ issueId: 100, chatId: "c", identifier: "OP-100", reporterUserId: "u100" });
    expect(store.getLatestBindingByUserId("u100")?.issueId).toBe(100);
  });
});
