import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "./schema";
import { TicketBindingRepository } from "./binding-repository";

function freshRepo(): { db: Database; repo: TicketBindingRepository } {
  const db = new Database(":memory:");
  applySchema(db);
  return { db, repo: new TicketBindingRepository(db) };
}

describe("message_routes theo chat", () => {
  // message_id của Telegram chỉ duy nhất trong một chat. Hai bot dùng chung DB
  // → cùng message_id 55 có thể tồn tại ở chat A lẫn chat B.
  test("cùng message_id ở hai chat khác nhau không đè nhau, tra đúng ticket theo chat", () => {
    const { repo } = freshRepo();
    repo.saveMessageRoute("55", "telegram", 1, "TECH-1", "chat-A");
    repo.saveMessageRoute("55", "telegram", 2, "PO-2", "chat-B");

    expect(repo.getMessageRoute("55", "telegram", "chat-A")?.identifier).toBe("TECH-1");
    expect(repo.getMessageRoute("55", "telegram", "chat-B")?.identifier).toBe("PO-2");
    expect(repo.getMessageRoute("55", "telegram", "chat-C")).toBeNull();
  });

  test("dòng cũ không có chat_id chỉ khớp khi binding của ticket đó nằm đúng chat", () => {
    const { db, repo } = freshRepo();
    repo.saveBinding({
      issueId: 7,
      channelType: "telegram",
      chatId: "chat-A",
      messageId: "1",
      identifier: "TECH-7",
    });
    // Mô phỏng worker bản cũ còn chạy song song: ghi route không kèm chat_id.
    db.run(
      `INSERT INTO message_routes (message_id, channel_type, issue_id, identifier) VALUES ('77', 'telegram', 7, 'TECH-7')`,
    );

    expect(repo.getMessageRoute("77", "telegram", "chat-A")?.identifier).toBe("TECH-7");
    expect(repo.getMessageRoute("77", "telegram", "chat-B")).toBeNull();
  });

  test("dòng có chat_id đúng được ưu tiên hơn dòng cũ không rõ chat", () => {
    const { db, repo } = freshRepo();
    repo.saveBinding({
      issueId: 8,
      channelType: "telegram",
      chatId: "chat-A",
      messageId: "1",
      identifier: "TECH-8",
    });
    db.run(
      `INSERT INTO message_routes (message_id, channel_type, issue_id, identifier) VALUES ('88', 'telegram', 8, 'TECH-8')`,
    );
    repo.saveMessageRoute("88", "telegram", 9, "TECH-9", "chat-A");

    expect(repo.getMessageRoute("88", "telegram", "chat-A")?.identifier).toBe("TECH-9");
  });
});

describe("migration message_routes (DB cũ khoá (message_id, channel_type))", () => {
  function legacyDb(): Database {
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
    // Route của ticket không còn binding — không suy ra được chat.
    db.run(
      `INSERT INTO message_routes (message_id, channel_type, issue_id, identifier) VALUES ('200', 'telegram', 99, 'TECH-99')`,
    );
    return db;
  }

  test("giữ nguyên mọi dòng, điền chat_id từ binding, dòng không suy ra được để rỗng", () => {
    const db = legacyDb();
    applySchema(db);

    const cols = (
      db.query(`PRAGMA table_info(message_routes)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("chat_id");

    const rows = db
      .query(
        `SELECT message_id, chat_id, issue_id, created_at FROM message_routes ORDER BY message_id`,
      )
      .all() as Array<{
      message_id: string;
      chat_id: string;
      issue_id: number;
      created_at: string;
    }>;
    expect(rows).toEqual([
      { message_id: "100", chat_id: "chat-A", issue_id: 1, created_at: "2026-09-01 10:00:00" },
      { message_id: "200", chat_id: "", issue_id: 99, created_at: rows[1].created_at },
    ]);

    const repo = new TicketBindingRepository(db);
    expect(repo.getMessageRoute("100", "telegram", "chat-A")?.identifier).toBe("TECH-1");
    // Sau migration, cùng message_id ở chat khác ghi được mà không đè dòng cũ.
    repo.saveMessageRoute("100", "telegram", 2, "PO-2", "chat-B");
    expect(repo.getMessageRoute("100", "telegram", "chat-A")?.identifier).toBe("TECH-1");
    expect(repo.getMessageRoute("100", "telegram", "chat-B")?.identifier).toBe("PO-2");
  });

  test("chạy lại applySchema nhiều lần không mất dữ liệu (idempotent)", () => {
    const db = legacyDb();
    applySchema(db);
    applySchema(db);
    applySchema(db);
    const count = (db.query(`SELECT COUNT(*) AS n FROM message_routes`).get() as { n: number }).n;
    expect(count).toBe(2);
  });
});

describe("getLatestBinding theo dự án (hai bot dùng chung DB)", () => {
  // 28/09: người dùng bấm "Kiểm tra trạng thái ticket" ở IRIS (dự án PO) → IRIS
  // trả TECHTEST-110 của Tiểu Linh vì cùng chat_id, ticket Tiểu Linh mới hơn.
  test("lọc theo projectKey: không lấy nhầm ticket của bot kia dù mới hơn", () => {
    const { db, repo } = freshRepo();
    repo.saveBinding({
      issueId: 1,
      channelType: "telegram",
      chatId: "chat-A",
      messageId: "1",
      identifier: "PO-80",
      reporterUsername: "user_c",
    });
    repo.saveBinding({
      issueId: 2,
      channelType: "telegram",
      chatId: "chat-A",
      messageId: "2",
      identifier: "TECHTEST-110",
      reporterUsername: "user_c",
    });
    db.run(`UPDATE ticket_bindings SET updated_at = '2026-09-20 10:00:00' WHERE issue_id = 1`);
    db.run(`UPDATE ticket_bindings SET updated_at = '2026-09-25 10:00:00' WHERE issue_id = 2`);

    expect(repo.getLatestBinding("chat-A")?.identifier).toBe("TECHTEST-110");
    expect(repo.getLatestBinding("chat-A", undefined, "PO")?.identifier).toBe("PO-80");
    expect(repo.getLatestBinding("chat-A", undefined, "TECHTEST")?.identifier).toBe("TECHTEST-110");
    expect(repo.getLatestBinding("chat-B", "user_c", "PO")?.identifier).toBe("PO-80");
  });

  test("tiền tố phải khớp đủ: dự án TECH không lấy TECHTEST", () => {
    const { repo } = freshRepo();
    repo.saveBinding({
      issueId: 2,
      channelType: "telegram",
      chatId: "chat-A",
      messageId: "2",
      identifier: "TECHTEST-110",
    });
    expect(repo.getLatestBinding("chat-A", undefined, "TECH")).toBeNull();
  });
});
