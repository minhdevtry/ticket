import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  intakeApplySchema,
  SqliteDraftRepository,
  newDraft,
  isExpiredDraft,
  chatIdVariants,
  INTAKE_DRAFT_TTL_MS,
} from ".";

let db: Database;
let repo: SqliteDraftRepository;

beforeEach(() => {
  db = new Database(":memory:");
  intakeApplySchema(db, { wal: false });
  repo = new SqliteDraftRepository(db);
});
afterEach(() => db.close());

describe("SqliteDraftRepository", () => {
  test("tryInsertRevision is a one-winner compare-and-set on (docId, revision)", () => {
    const d = newDraft("doc1", "c1", new Date().toISOString());
    const next = { ...d, revision: 2, status: "confirmed" as const };
    expect(repo.tryInsertRevision(next)).toBe(true);
    // A second writer racing for the same revision loses.
    expect(repo.tryInsertRevision({ ...next, confirmingSince: "later" })).toBe(false);
  });

  test("getLatestByChatId orders by write time, not revision number", () => {
    // An old doc abandoned at a high revision must not beat a new doc at rev 1.
    repo.saveRevision({ ...newDraft("old", "c1", new Date().toISOString()), revision: 5, status: "canceled" });
    repo.saveRevision({ ...newDraft("new", "c1", new Date().toISOString()), revision: 1, status: "collecting" });
    expect(repo.getLatestByChatId("c1")?.docId).toBe("new");
  });

  test("chat id variants collapse telegram-prefixed and bare numeric ids", () => {
    expect(chatIdVariants("telegram:123").sort()).toEqual(["123", "telegram:123"]);
    expect(chatIdVariants("abc")).toEqual(["abc"]);
    repo.saveRevision(newDraft("d", "telegram:555", new Date().toISOString()));
    expect(repo.getLatestByChatId("555")?.docId).toBe("d");
  });

  test("isExpiredDraft respects the TTL", () => {
    const now = Date.now();
    const d = { ...newDraft("d", "c", new Date(now - INTAKE_DRAFT_TTL_MS - 1).toISOString()) };
    expect(isExpiredDraft(d, now)).toBe(true);
    expect(isExpiredDraft({ ...d, updatedAt: new Date(now).toISOString() }, now)).toBe(false);
  });

  test("getByDocId reads a specific revision or the latest", () => {
    const base = newDraft("d", "c", new Date().toISOString());
    repo.saveRevision(base);
    repo.saveRevision({ ...base, revision: 2, status: "ready_for_confirmation" });
    expect(repo.getByDocId("d")?.revision).toBe(2);
    expect(repo.getByDocId("d", 1)?.status).toBe("collecting");
  });
});
