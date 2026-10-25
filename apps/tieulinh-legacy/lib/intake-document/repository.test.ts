import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../storage/schema";
import { IntakeDocumentRepository } from "./repository";
import type { IntakeDocument } from "./types";

describe("IntakeDocumentRepository", () => {
  let db: Database;
  let repo: IntakeDocumentRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    repo = new IntakeDocumentRepository(db);
  });

  it("lưu và đọc revision mới nhất theo chatId", () => {
    const doc1: IntakeDocument = {
      docId: "doc_1",
      chatId: "chat_123",
      revision: 1,
      status: "collecting",
      currentTurn: 1,
      fields: {
        title: {
          value: "Lỗi đăng nhập CRM",
          source: "user_message",
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

    repo.saveRevision(doc1);

    const latest1 = repo.getLatestByChatId("chat_123");
    expect(latest1).not.toBeNull();
    expect(latest1?.revision).toBe(1);
    expect(latest1?.fields.title?.value).toBe("Lỗi đăng nhập CRM");

    // Revision 2
    const doc2: IntakeDocument = {
      ...doc1,
      revision: 2,
      currentTurn: 2,
      fields: {
        ...doc1.fields,
        system: {
          value: "CRM_Vuihoc",
          source: "user_message",
          turn: 2,
          updatedAt: new Date().toISOString(),
        },
      },
      updatedAt: new Date().toISOString(),
    };

    repo.saveRevision(doc2);

    const latest2 = repo.getLatestByChatId("chat_123");
    expect(latest2?.revision).toBe(2);
    expect(latest2?.fields.system?.value).toBe("CRM_Vuihoc");
    expect(latest2?.fields.title?.value).toBe("Lỗi đăng nhập CRM");

    // Đọc lịch sử tất cả các revision
    const history = repo.getRevisions("doc_1");
    expect(history.length).toBe(2);
    expect(history[0].revision).toBe(1);
    expect(history[1].revision).toBe(2);
  });

  it("migrate bản nháp từ intake_sessions thành công", () => {
    db.run(
      `INSERT INTO intake_sessions (session_id, state_json)
       VALUES (?, ?)`,
      [
        "chat_legacy_456",
        JSON.stringify({
          title: "Sự cố mạng phòng học",
          system: "Vuihoc (App/Web_Vuihoc + ERP_DUO)",
          category: "Lỗi hệ thống",
          studentAccount: "0900000005",
        }),
      ],
    );

    const migrated = repo.migrateFromLegacyDraft("chat_legacy_456");
    expect(migrated).not.toBeNull();
    expect(migrated?.fields.title?.value).toBe("Sự cố mạng phòng học");
    // Legacy draft dùng nhãn 15-giá trị cũ — migrate phải chuẩn hoá về danh mục 9 giá trị
    expect(migrated?.fields.system?.value).toBe("VH_Tự học");
    expect(migrated?.fields.errorCategory?.value).toBe("Lỗi hệ thống");
    expect(migrated?.fields.studentAccount?.value).toBe("0900000005");

    // Kiểm tra đã được lưu vào intake_documents
    const latest = repo.getLatestByChatId("chat_legacy_456");
    expect(latest).not.toBeNull();
    expect(latest?.revision).toBe(1);
  });
});

describe("IntakeDocumentRepository — chọn tài liệu mới nhất theo thời gian", () => {
  let db: Database;
  let repo: IntakeDocumentRepository;

  const makeDoc = (
    docId: string,
    revision: number,
    status: IntakeDocument["status"],
    chatId = "chat_x",
  ): IntakeDocument => ({
    docId,
    chatId,
    revision,
    status,
    currentTurn: revision,
    fields: {},
    evidence: {},
    askedCount: {},
    similarTickets: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    repo = new IntakeDocumentRepository(db);
  });

  it("tài liệu mới (revision thấp) thắng tài liệu cũ đã huỷ (revision cao)", () => {
    // Bug cũ: ORDER BY revision DESC → doc đã huỷ rev 5 luôn thắng doc mới rev 1
    repo.saveRevision(makeDoc("doc_old", 5, "canceled"));
    repo.saveRevision(makeDoc("doc_new", 1, "collecting"));

    const latest = repo.getLatestByChatId("chat_x");
    expect(latest?.docId).toBe("doc_new");
  });

  it("tryInsertRevision chỉ cho một bên giành được cùng một revision", () => {
    const doc = makeDoc("doc_claim", 3, "confirmed");
    expect(repo.tryInsertRevision(doc)).toBe(true);
    expect(repo.tryInsertRevision({ ...doc, status: "created" })).toBe(false);
    expect(repo.getByDocId("doc_claim")?.status).toBe("confirmed");
  });

  it("chatId dạng 'telegram:123' và '123' là cùng một phiên", () => {
    repo.saveRevision(makeDoc("doc_tg", 1, "collecting", "telegram:123"));
    expect(repo.getLatestByChatId("123")?.docId).toBe("doc_tg");
    expect(repo.getLatestByChatId("telegram:123")?.docId).toBe("doc_tg");
    // chatId không phải số thì không tự suy biến thể
    expect(repo.getLatestByChatId("chat_123")).toBeNull();
  });

  it("bỏ qua bản nháp legacy quá hạn khi migrate", () => {
    db.run(
      `INSERT INTO intake_sessions (session_id, state_json, updated_at) VALUES (?, ?, datetime('now', '-3 days'))`,
      ["chat_stale", JSON.stringify({ title: "Bản nháp cũ" })],
    );
    expect(repo.migrateFromLegacyDraft("chat_stale", { maxAgeMs: 24 * 3600_000 })).toBeNull();
    expect(repo.getLatestByChatId("chat_stale")).toBeNull();
  });
});
