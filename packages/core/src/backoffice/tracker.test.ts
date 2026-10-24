import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ItsaplanClient } from "../itsaplan";
import { FakeItsaplan } from "../testing/fake-itsaplan";
import { OutOfProjectError, createScopedTracker, idempotencyMarker } from "./tracker";

let fake: FakeItsaplan;
const mk = () =>
  createScopedTracker(
    new ItsaplanClient(fake.baseUrl, fake.agentKey, { retryOptions: { maxRetries: 0 } }),
    "tech",
  );

beforeEach(() => {
  fake = new FakeItsaplan();
  fake.start();
});
afterEach(async () => {
  await fake.stop();
});

describe("createScopedTracker", () => {
  it("chuẩn hoá mã dự án và từ chối mã rỗng", () => {
    expect(mk().projectKey).toBe("TECH");
    expect(() => createScopedTracker(new ItsaplanClient(fake.baseUrl, "k"), "  ")).toThrow();
  });

  it("getIssue theo id và theo mã; issue dự án khác trả null", async () => {
    const a = fake.addIssue({ title: "A" });
    const foreign = fake.addIssue({ title: "B" });
    foreign.identifier = "OTHER-1";
    const t = mk();
    expect((await t.getIssue(a.id))?.identifier).toBe(a.identifier);
    expect((await t.getIssue(a.identifier))?.id).toBe(a.id);
    expect(await t.getIssue(foreign.id)).toBeNull();
    expect(await t.getIssue("OTHER-1")).toBeNull();
    expect(await t.getIssue(99999)).toBeNull();
  });

  it("lệnh ghi lên issue ngoài dự án bị từ chối bằng OutOfProjectError", async () => {
    const foreign = fake.addIssue({ title: "B" });
    foreign.identifier = "OTHER-1";
    const t = mk();
    await expect(t.comment(foreign.id, "hi")).rejects.toBeInstanceOf(OutOfProjectError);
    await expect(t.moveTo(foreign.id, "Done")).rejects.toBeInstanceOf(OutOfProjectError);
    expect(fake.comments).toHaveLength(0);
    expect(fake.count(/^PATCH/)).toBe(0);
  });

  it("comment gắn dấu bot, hỗ trợ replyToId và chống trùng theo khoá", async () => {
    const issue = fake.addIssue({ title: "A" });
    const t = mk();
    const first = await t.comment(issue.id, "chào", { replyToId: 77, idempotencyKey: "k1" });
    expect(first.created).toBe(true);
    const stored = fake.comments.at(-1)!;
    expect(stored.replyToId).toBe(77);
    expect(stored.body).toContain("chào");
    expect(stored.body).toContain("<!-- intake-bot -->");
    expect(stored.body).toContain(idempotencyMarker("k1"));

    const again = await t.comment(issue.id, "chào", { idempotencyKey: "k1" });
    expect(again).toEqual({ id: null, created: false });
    expect(fake.comments.filter((c) => c.actorUserId === "agent-user")).toHaveLength(1);

    const other = await t.comment(issue.id, "khác", { idempotencyKey: "k2", mark: false });
    expect(other.created).toBe(true);
    expect(fake.comments.at(-1)!.body).not.toContain("<!-- intake-bot -->");
  });

  it("moveTo theo tên cột không phân biệt hoa thường/dấu; cột lạ báo lỗi rõ", async () => {
    const issue = fake.addIssue({ title: "A" });
    const t = mk();
    await t.moveTo(issue.id, "can phan loai");
    expect(fake.issues[0]!.columnId).toBe(2);
    await t.moveTo(issue.id, 5);
    expect(fake.issues[0]!.columnId).toBe(5);
    await expect(t.moveTo(issue.id, "Không tồn tại")).rejects.toThrow(/không có cột/);
  });

  it("assign và setPriority gửi PATCH đúng", async () => {
    const issue = fake.addIssue({ title: "A" });
    const t = mk();
    await t.assign(issue.id, "user-9");
    await t.setPriority(issue.id, "high");
    expect(fake.issues[0]).toMatchObject({ assigneeUserId: "user-9", priority: "high" });
    await t.assign(issue.id, null);
    expect(fake.issues[0]!.assigneeUserId).toBeNull();
  });
});
