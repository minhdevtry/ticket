import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { AskLearnStore } from "./store";

describe("AskLearnStore", () => {
  it("upsert idempotent và hasComment", () => {
    const store = new AskLearnStore(new Database(":memory:"));
    const row = {
      commentId: "c1",
      issueKey: "TECH-1",
      system: "CRM_Vuihoc",
      createdAt: 1000,
      needsInfo: true,
      kind: "ask",
      items: ["TIME" as const],
      alreadyInReport: false,
      model: "m",
      classifiedAt: 2000,
    };
    expect(store.hasComment("c1")).toBe(false);
    store.upsertComment(row);
    store.upsertComment({ ...row, items: ["STEPS"] });
    expect(store.hasComment("c1")).toBe(true);
    const got = store.needsCommentsOf("CRM_Vuihoc");
    expect(got.length).toBe(1);
    expect(got[0].items).toEqual(["STEPS"]);
  });

  it("ticket upsert và liệt kê theo hệ thống", () => {
    const store = new AskLearnStore(new Database(":memory:"));
    store.upsertTicket({
      issueKey: "TECH-1",
      system: "LMS_Vuihoc",
      createdAt: 5,
      lastScannedAt: 6,
    });
    store.upsertTicket({
      issueKey: "TECH-1",
      system: "LMS_Vuihoc",
      createdAt: 5,
      lastScannedAt: 7,
    });
    expect(store.ticketsOf("LMS_Vuihoc")).toEqual([
      { issueKey: "TECH-1", system: "LMS_Vuihoc", createdAt: 5, lastScannedAt: 7 },
    ]);
    expect(store.systems()).toEqual(["LMS_Vuihoc"]);
  });
});
