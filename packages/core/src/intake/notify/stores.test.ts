import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { notifyApplySchema, SqliteTicketStateStore } from "./stores";

function store() {
  const db = new Database(":memory:");
  notifyApplySchema(db);
  return new SqliteTicketStateStore(db);
}

describe("SqliteTicketStateStore", () => {
  it("chưa thấy ticket thì null; enter ghi trạng thái, setPrompt nhớ tin mang nút", () => {
    const s = store();
    expect(s.get(1)).toBeNull();
    s.enter({ issueId: 1, identifier: "TECH2-1", state: "resolved", columnId: 4, now: 100 });
    s.setPrompt(1, "m-9");
    expect(s.get(1)).toEqual({
      issueId: 1,
      identifier: "TECH2-1",
      state: "resolved",
      columnId: 4,
      promptMessageId: "m-9",
      reporterOkAt: null,
      updatedAt: 100,
    });
  });

  it("markReporterOk ghi dấu mà không đổi trạng thái; enter lại xoá tin-nút và dấu cũ", () => {
    const s = store();
    s.enter({ issueId: 1, identifier: "TECH2-1", state: "resolved", columnId: 4, now: 100 });
    s.setPrompt(1, "m-9");
    s.markReporterOk(1, 200);
    expect(s.get(1)).toMatchObject({
      state: "resolved",
      reporterOkAt: 200,
      promptMessageId: "m-9",
    });
    s.enter({ issueId: 1, identifier: "TECH2-1", state: "open", columnId: 3, now: 300 });
    expect(s.get(1)).toMatchObject({
      state: "open",
      columnId: 3,
      promptMessageId: null,
      reporterOkAt: null,
    });
  });
});
