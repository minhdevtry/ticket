import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createAskLearnedLookup } from "./lookup";
import { AskLearnStore } from "./store";

const tmpDir = path.join(import.meta.dir, "..", "..", "..", "tmp", "lookup-test-" + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe("createAskLearnedLookup", () => {
  it("dbPath rỗng hoặc undefined → trả về undefined", () => {
    expect(createAskLearnedLookup(undefined)).toBeUndefined();
    expect(createAskLearnedLookup("")).toBeUndefined();
  });

  it("đường dẫn file không mở được → trả về undefined", () => {
    const fileObstacle = path.join(tmpDir, "obstacle.txt");
    fs.writeFileSync(fileObstacle, "not-a-directory");
    const badPath = path.join(fileObstacle, "sub", "store.sqlite");
    expect(createAskLearnedLookup(badPath)).toBeUndefined();
  });

  it("kho hợp lệ → trả về cả items và shares, vừa là mảng vừa có thuộc tính shares", () => {
    const dbPath = path.join(tmpDir, "test.sqlite");
    const rawDb = new Database(dbPath);
    const store = new AskLearnStore(rawDb);
    const now = Date.parse("2026-10-16T12:00:00Z");

    // 2 ticket cho CRM với STEPS
    for (let i = 0; i < 2; i++) {
      store.upsertTicket({ issueKey: `CRM-${i}`, system: "CRM_Vuihoc", createdAt: now, lastScannedAt: now });
      store.upsertComment({
        commentId: `c-${i}`, issueKey: `CRM-${i}`, system: "CRM_Vuihoc", createdAt: now,
        needsInfo: true, kind: "ask", items: ["STEPS"], alreadyInReport: false,
        model: "m", classifiedAt: now,
      });
    }

    const lookup = createAskLearnedLookup(dbPath, () => now);
    expect(lookup).toBeDefined();
    if (!lookup) return;

    const res = lookup("CRM_Vuihoc");
    // tương thích mảng
    expect(Array.isArray(res)).toBe(true);
    expect(res).toContain("STEPS");
    expect(res.items).toEqual(["STEPS"]);
    // có shares
    expect(res.shares).toBeDefined();
    expect(res.shares.STEPS).toBeGreaterThan(0.99);

    // Hệ thống không có ticket → mảng rỗng, shares rỗng
    const emptyRes = lookup("CARE_Vuihoc");
    expect(emptyRes.items).toEqual([]);
    expect(emptyRes.shares).toEqual({});
  });
});
