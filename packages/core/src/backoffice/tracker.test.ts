import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ItsaplanClient } from "../itsaplan";
import { FakeItsaplan } from "../testing/fake-itsaplan";
import { OutOfProjectError, createScopedTracker, idempotencyMarker } from "./tracker";

let fake: FakeItsaplan;
const mk = () =>
  createScopedTracker(
    new ItsaplanClient(fake.baseUrl, fake.agentKey, { retryOptions: { maxRetries: 0 } }),
    { team: "tech", project: "tech" },
  );

beforeEach(() => {
  fake = new FakeItsaplan();
  fake.start();
});
afterEach(async () => {
  await fake.stop();
});

describe("createScopedTracker", () => {
  it("chuẩn hoá mã dự án, lộ ref đủ team.KEY, từ chối team/mã rỗng", () => {
    const t = mk();
    expect(t.projectKey).toBe("TECH");
    expect(t.team).toBe("tech");
    expect(t.ref).toBe("tech.TECH");
    const client = new ItsaplanClient(fake.baseUrl, "k");
    expect(() => createScopedTracker(client, { team: "tech", project: "  " })).toThrow();
    expect(() => createScopedTracker(client, { team: " ", project: "TECH" })).toThrow();
  });

  it("MỌI lời gọi chỉ dự án dùng ref đủ team.KEY, không bao giờ khoá trần", async () => {
    const issue = fake.addIssue({ title: "A" });
    const t = mk();
    await t.columns();
    await t.listIssues();
    await t.getIssue(issue.identifier);
    await t.getIssue(issue.id);
    const projectPaths = fake.requests.map((r) => r.path).filter((p) => p.startsWith("/projects/"));
    expect(projectPaths.length).toBeGreaterThanOrEqual(3);
    for (const p of projectPaths) expect(p).toMatch(/^\/projects\/tech\.TECH(\/|$)/);
  });

  it("fake từ chối khoá trần (mơ hồ giữa team) và team lạ; allowBareKeys cho phép khoá trần", async () => {
    const client = new ItsaplanClient(fake.baseUrl, fake.agentKey, {
      retryOptions: { maxRetries: 0 },
    });
    await expect(client.getProject("TECH")).rejects.toMatchObject({ status: 404 });
    await expect(client.getProject("other.TECH")).rejects.toMatchObject({ status: 404 });
    expect((await client.getProject("tech.TECH")).key).toBe("TECH");

    const lenient = new FakeItsaplan({ allowBareKeys: true });
    lenient.start();
    try {
      const c = new ItsaplanClient(lenient.baseUrl, lenient.agentKey);
      expect((await c.getProject("TECH")).key).toBe("TECH");
    } finally {
      await lenient.stop();
    }
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
