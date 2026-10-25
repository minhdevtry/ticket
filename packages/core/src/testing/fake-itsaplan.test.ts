import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createScopedTracker } from "../backoffice/tracker";
import { ItsaplanClient } from "../itsaplan";
import { FakeItsaplan } from "./fake-itsaplan";

let fake: FakeItsaplan;
let client: ItsaplanClient;
beforeEach(() => {
  fake = new FakeItsaplan();
  fake.start();
  client = new ItsaplanClient(fake.baseUrl, fake.agentKey, { retryOptions: { maxRetries: 0 } });
});
afterEach(async () => {
  await fake.stop();
});

describe("FakeItsaplan: phần mở rộng cho bot hậu cần", () => {
  it("addIssue nhận priority, assigneeUserId, createdAt", () => {
    const issue = fake.addIssue({
      title: "x",
      priority: "high",
      assigneeUserId: "staff-1",
      createdAt: "2026-10-25T00:00:00.000Z",
    });
    expect(issue).toMatchObject({
      priority: "high",
      assigneeUserId: "staff-1",
      createdAt: "2026-10-25T00:00:00.000Z",
      updatedAt: "2026-10-25T00:00:00.000Z",
    });
    expect(fake.addIssue({ title: "y" })).toMatchObject({ priority: null, assigneeUserId: null });
  });

  it("POST /issues/:id/links ghi vào fake.links; issue lạ thì 404", async () => {
    const a = fake.addIssue({ title: "a" });
    const b = fake.addIssue({ title: "b" });
    await client.linkIssues(a.id, b.id, "duplicates");
    expect(fake.links).toEqual([
      { id: 1, sourceIssueId: a.id, targetIssueId: b.id, kind: "duplicates" },
    ]);
    await expect(client.linkIssues(9999, b.id)).rejects.toThrow();
  });

  it("tìm kiếm theo từ khoá trong mã, tiêu đề, mô tả (không phân biệt hoa thường)", async () => {
    fake.addIssue({ title: "Đăng nhập lỗi", description: "quay mãi" });
    fake.addIssue({ title: "Báo cáo chậm", description: "Đăng nhập xong mới chậm" });
    fake.addIssue({ title: "Khác hẳn" });
    const tracker = createScopedTracker(
      client,
      { team: "tech", project: "TECH" },
      { readRetries: 0 },
    );
    const hits = await tracker.search("đăng nhập");
    expect(hits.map((h) => h.title)).toEqual(["Đăng nhập lỗi", "Báo cáo chậm"]);
    expect(await tracker.search("không có gì")).toEqual([]);
  });
});
