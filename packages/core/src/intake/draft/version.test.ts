/**
 * Draft v2 (RFC 0002 PR 4) — tờ khai có phiên bản, đọc được tờ khai cũ.
 *
 * Bốn ca đầu là BẢN PORT của `apps/tieulinh-legacy/lib/intake-document/repository.test.ts`
 * — cùng hành vi, chạy trên kho của core: đọc revision mới nhất, chọn tài liệu mới
 * theo thời gian, giành revision bằng CAS, gộp biến thể chat id.
 *
 * Hai ca kế là hành vi CỦA CORE, KHÁC legacy (sổ đối chiếu ghi `deferred` cho hai
 * dòng legacy tương ứng): đọc tờ khai cũ không có `version` (legacy đọc bảng
 * `intake_sessions` và chuẩn hoá nhãn 15→9 giá trị), và bản nháp quá hạn (legacy trả
 * `null`, core đọc được rồi mới đo tuổi).
 *
 * NGUỒN: legacy `lib/intake-document/repository.test.ts`; RFC 0002 mục 2.1
 * ("PR 4 thêm các trường này theo kiểu cộng thêm, có phiên bản, đọc được bản
 * draft cũ").
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { intakeApplySchema, SqliteDraftRepository, newDraft } from ".";
import { DRAFT_VERSION, migrateDraft } from "./version";
import { INTAKE_DRAFT_TTL_MS } from "./repository";

let db: Database;
let repo: SqliteDraftRepository;

beforeEach(() => {
  db = new Database(":memory:");
  intakeApplySchema(db, { wal: false });
  repo = new SqliteDraftRepository(db);
});
afterEach(() => db.close());

/** Ghi thẳng một tờ khai có hình dạng bất kỳ (như bản cũ đã lưu trong kho). */
function writeRaw(state: unknown, chatId = "chat_legacy"): void {
  db.run(
    `INSERT INTO intake_documents (doc_id, chat_id, revision, status, state_json, updated_at)
     VALUES (?, ?, 1, 'collecting', ?, CURRENT_TIMESTAMP)`,
    ["doc_raw", chatId, JSON.stringify(state)],
  );
}

describe("port của legacy — IntakeDocumentRepository (4 ca)", () => {
  test("lưu và đọc revision mới nhất theo chatId", () => {
    const iso = new Date().toISOString();
    const doc1 = {
      ...newDraft("doc_1", "chat_123", iso),
      ticket: {
        title: "Lỗi đăng nhập CRM",
        rawText: "Lỗi đăng nhập CRM",
        priority: "medium" as const,
        mediaPaths: [],
      },
    };
    repo.saveRevision(doc1);

    const latest1 = repo.getLatestByChatId("chat_123");
    expect(latest1).not.toBeNull();
    expect(latest1?.revision).toBe(1);
    expect(latest1?.ticket.title).toBe("Lỗi đăng nhập CRM");

    const doc2 = {
      ...doc1,
      revision: 2,
      ticket: { ...doc1.ticket, title: "Lỗi đăng nhập CRM" },
      record: {
        variant: "tech",
        values: { he_thong: "CRM_Vuihoc" },
        questionCount: {},
        explicitlyMissing: [],
      },
    };
    repo.saveRevision(doc2);

    const latest2 = repo.getLatestByChatId("chat_123");
    expect(latest2?.revision).toBe(2);
    expect(latest2?.record?.values.he_thong).toBe("CRM_Vuihoc");
    expect(latest2?.ticket.title).toBe("Lỗi đăng nhập CRM");
  });

  test("tài liệu mới (revision thấp) thắng tài liệu cũ đã huỷ (revision cao)", () => {
    const iso = new Date().toISOString();
    repo.saveRevision({ ...newDraft("doc_old", "chat_x", iso), revision: 5, status: "canceled" });
    repo.saveRevision({ ...newDraft("doc_new", "chat_x", iso), revision: 1, status: "collecting" });
    expect(repo.getLatestByChatId("chat_x")?.docId).toBe("doc_new");
  });

  test("tryInsertRevision chỉ cho một bên giành được cùng một revision", () => {
    const doc = {
      ...newDraft("doc_claim", "chat_x", new Date().toISOString()),
      revision: 3,
      status: "confirmed" as const,
    };
    expect(repo.tryInsertRevision(doc)).toBe(true);
    expect(repo.tryInsertRevision({ ...doc, status: "created" as const })).toBe(false);
    expect(repo.getByDocId("doc_claim")?.status).toBe("confirmed");
  });

  test("chatId dạng 'telegram:123' và '123' là cùng một phiên", () => {
    const iso = new Date().toISOString();
    repo.saveRevision(newDraft("doc_tg", "telegram:123", iso));
    expect(repo.getLatestByChatId("123")?.docId).toBe("doc_tg");
    expect(repo.getLatestByChatId("telegram:123")?.docId).toBe("doc_tg");
    // chatId không phải số thì không tự suy biến thể
    expect(repo.getLatestByChatId("chat_123")).toBeNull();
  });
});

describe("hành vi của core — KHÁC legacy (2 ca, sổ đối chiếu ghi `deferred`)", () => {
  test("đọc tờ khai cũ không có `version` thì nâng lên bản 2 (khác legacy: legacy đọc bảng `intake_sessions`)", () => {
    // Legacy: `migrateFromLegacyDraft` đọc bảng `intake_sessions` và chuẩn hoá
    // nhãn 15→9 giá trị. Core đọc tờ khai cũ trong `intake_documents` nên chỉ
    // nâng phiên bản — hành vi khác legacy, chưa port.
    writeRaw(
      {
        docId: "doc_legacy_456",
        chatId: "chat_legacy_456",
        revision: 1,
        status: "collecting",
        ticket: {
          title: "Sự cố mạng phòng học",
          rawText: "Sự cố mạng phòng học",
          priority: "medium",
        },
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
      "chat_legacy_456",
    );

    const migrated = repo.getLatestByChatId("chat_legacy_456");
    expect(migrated).not.toBeNull();
    expect(migrated?.ticket.title).toBe("Sự cố mạng phòng học");
    expect(migrated?.version).toBe(DRAFT_VERSION);
    expect(migrated?.ticket.mediaPaths).toEqual([]);
    expect(migrated?.lastAskedFields).toEqual([]);
    expect(migrated?.techReviewDone).toBe(false);
  });

  test("tờ khai quá hạn vẫn đọc được, tuổi đo lúc đọc (khác legacy: legacy trả `null`)", () => {
    // Legacy: `migrateFromLegacyDraft` trả `null` cho bản nháp quá hạn (không
    // đọc được). Core đọc được rồi mới đo tuổi — hành vi khác legacy ở tầng
    // kho, chưa port; engine đóng tờ khai quá hạn ở tầng trên.
    const now = Date.now();
    const stale = {
      ...newDraft("doc_stale", "chat_stale", new Date(now - INTAKE_DRAFT_TTL_MS - 1).toISOString()),
    };
    writeRaw(
      { ...stale, updatedAt: new Date(now - INTAKE_DRAFT_TTL_MS - 1).toISOString() },
      "chat_stale",
    );
    const read = repo.getLatestByChatId("chat_stale");
    expect(read).not.toBeNull();
    // Tờ khai quá hạn vẫn đọc được (để engine tự đóng và mở tờ khai mới), nhưng
    // KHÔNG được coi là còn hiệu lực.
    expect(now - Date.parse(read!.updatedAt)).toBeGreaterThan(INTAKE_DRAFT_TTL_MS);
  });
});

describe("draft v2 — trường mới và migrate lúc đọc", () => {
  test("tờ khai mới ghi phiên bản hiện hành", () => {
    const draft = newDraft("doc_v2", "chat_v2", new Date().toISOString());
    expect(draft.version).toBe(DRAFT_VERSION);
  });

  test("migrate giữ nguyên dữ liệu cũ và điền mặc định cho trường mới", () => {
    const migrated = migrateDraft({
      docId: "doc_old",
      chatId: "chat_old",
      revision: 4,
      status: "collecting",
      ticket: {
        title: "Lỗi CRM",
        rawText: "Lỗi CRM",
        priority: "high",
        mediaPaths: ["/tmp/a.png"],
      },
      record: {
        variant: "tech",
        values: { van_de: "Lỗi CRM" },
        questionCount: { van_de: 1 },
        explicitlyMissing: [],
      },
      evidence: { blocksPayment: true },
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(migrated).not.toBeNull();
    expect(migrated?.version).toBe(DRAFT_VERSION);
    expect(migrated?.revision).toBe(4);
    expect(migrated?.ticket.priority).toBe("high");
    expect(migrated?.ticket.mediaPaths).toEqual(["/tmp/a.png"]);
    expect(migrated?.record?.values.van_de).toBe("Lỗi CRM");
    expect(migrated?.record?.questionCount.van_de).toBe(1);
    expect(migrated?.evidence).toEqual({ blocksPayment: true });
    // trường mới: có mặc định rõ ràng
    expect(migrated?.lastAskedFields).toEqual([]);
    expect(migrated?.techReviewDone).toBe(false);
    expect(migrated?.mediaAmbiguous).toBe(false);
    expect(migrated?.pendingSplitQueue).toEqual([]);
  });

  test("migrate giữ nguyên trường v2 đã có (không ghi đè dữ liệu)", () => {
    const migrated = migrateDraft({
      docId: "doc_new",
      chatId: "chat_new",
      revision: 1,
      status: "collecting",
      version: DRAFT_VERSION,
      ticket: { title: "t", rawText: "r", priority: "medium", mediaPaths: [] },
      lastAskedFields: ["he_thong"],
      requestedPriority: { level: "urgent", reason: "PH khiếu nại" },
      techReviewDone: true,
      techQuestion: "Cho em xin mã đơn",
      unrecognizedDept: "Kế toán",
      mediaAmbiguous: true,
      pendingNewIncident: { message: "tin", mediaPaths: [], askedAt: "2026-10-01T00:00:00.000Z" },
      pendingSplit: {
        blocks: [{ text: "học sinh A" }],
        mediaPaths: [],
        askedAt: "2026-10-01T00:00:00.000Z",
        extraText: ["chưa rõ"],
        clarifyCount: 1,
      },
      pendingSplitQueue: [{ text: "học sinh B" }],
      backgroundWork: { kind: "similar_tickets", startedAt: "2026-10-01T00:00:00.000Z" },
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(migrated?.lastAskedFields).toEqual(["he_thong"]);
    expect(migrated?.requestedPriority).toEqual({ level: "urgent", reason: "PH khiếu nại" });
    expect(migrated?.techReviewDone).toBe(true);
    expect(migrated?.techQuestion).toBe("Cho em xin mã đơn");
    expect(migrated?.unrecognizedDept).toBe("Kế toán");
    expect(migrated?.mediaAmbiguous).toBe(true);
    expect(migrated?.pendingNewIncident?.message).toBe("tin");
    expect(migrated?.pendingSplit?.clarifyCount).toBe(1);
    expect(migrated?.pendingSplitQueue).toHaveLength(1);
    expect(migrated?.backgroundWork?.kind).toBe("similar_tickets");
  });

  test("migrate là idempotent và không hạ cấp bản mới hơn", () => {
    const once = migrateDraft({
      docId: "d",
      chatId: "c",
      revision: 1,
      status: "collecting",
      ticket: { title: "t", rawText: "r", priority: "medium" },
    });
    const twice = migrateDraft(once);
    expect(twice).toEqual(once);

    const newer = migrateDraft({
      docId: "d",
      chatId: "c",
      revision: 1,
      status: "collecting",
      version: DRAFT_VERSION + 1,
      ticket: { title: "t", rawText: "r", priority: "medium" },
    });
    expect(newer?.version).toBe(DRAFT_VERSION + 1);
  });

  test("migrate trả null cho dữ liệu không phải tờ khai", () => {
    expect(migrateDraft(null)).toBeNull();
    expect(migrateDraft("abc")).toBeNull();
    expect(migrateDraft({})).toBeNull();
    expect(migrateDraft({ docId: "d" })).toBeNull();
  });
});
