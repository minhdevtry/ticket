import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ItsaplanClient } from "../itsaplan";
import { FakeItsaplan } from "../testing/fake-itsaplan";
import {
  OutOfProjectError,
  RunAbortedError,
  createScopedTracker,
  idempotencyMarker,
} from "./tracker";

let fake: FakeItsaplan;
const mk = () =>
  createScopedTracker(
    new ItsaplanClient(fake.baseUrl, fake.agentKey, { retryOptions: { maxRetries: 0 } }),
    { team: "tech", project: "tech" },
    { readRetries: 0 },
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
    expect(String(t.ref)).toBe("tech.TECH");
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

  it("listIssues: fake giống itsaplan fork (lọc cột/ngày, updatedAt giảm dần, limit, bỏ qua page)", async () => {
    const mkAt = (title: string, createdAt: string, columnId = 1) =>
      fake.addIssue({ title, createdAt, columnId });
    const a = mkAt("A", "2026-10-25T01:00:00.000Z");
    const b = mkAt("B", "2026-10-25T02:00:00.000Z");
    mkAt("C", "2026-10-25T03:00:00.000Z", 2);
    const t = mk();
    expect((await t.listIssues({ columnId: 1 })).map((i) => i.id)).toEqual([b.id, a.id]);
    expect(
      (
        await t.listIssues({
          createdFrom: "2026-10-25T02:00:00.000Z",
          createdTo: "2026-10-25T03:00:00.000Z",
        })
      ).map((i) => i.id),
    ).toEqual([b.id]);
    expect(await t.listIssues({ limit: 2 })).toHaveLength(2);
    expect(await t.listIssues({ limit: 1, page: 2 })).toHaveLength(1); // page bị bỏ qua
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
    const foreign = fake.addIssue({ title: "B", projectId: 2, identifier: "OTHER-1" });
    const t = mk();
    expect((await t.getIssue(a.id))?.identifier).toBe(a.identifier);
    expect((await t.getIssue(a.identifier))?.id).toBe(a.id);
    expect(await t.getIssue(foreign.id)).toBeNull();
    expect(await t.getIssue("OTHER-1")).toBeNull();
    expect(await t.getIssue(99999)).toBeNull();
  });

  it("lệnh ghi lên issue ngoài dự án bị từ chối bằng OutOfProjectError", async () => {
    const foreign = fake.addIssue({ title: "B", projectId: 2, identifier: "OTHER-1" });
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

  it("link nối hai issue của dự án; issue ngoài dự án (một trong hai đầu) bị từ chối, không nối gì", async () => {
    const a = fake.addIssue({ title: "A" });
    const b = fake.addIssue({ title: "B" });
    const away = fake.addIssue({ title: "Dự án khác", projectId: 9 });
    const t = mk();
    await t.link(a.id, b.id, "duplicates");
    expect(fake.links).toEqual([
      { id: 1, sourceIssueId: a.id, targetIssueId: b.id, kind: "duplicates" },
    ]);
    await t.link(b.id, a.id);
    expect(fake.links[1]!.kind).toBe("relates");
    await expect(t.link(a.id, away.id)).rejects.toBeInstanceOf(OutOfProjectError);
    await expect(t.link(away.id, a.id)).rejects.toBeInstanceOf(OutOfProjectError);
    expect(fake.links).toHaveLength(2);
  });

  it("ranh giới là projectId: mã trùng tiền tố nhưng khác dự án vẫn bị loại, issue đã chuyển dự án bị loại", async () => {
    // cùng khoá TECH ở team khác: mã giống hệt nhưng projectId khác
    const lookalike = fake.addIssue({ title: "Team khác", projectId: 9 });
    const mine = fake.addIssue({ title: "Của mình" });
    const t = mk();
    expect(await t.getIssue(lookalike.id)).toBeNull();
    expect(await t.getIssue(lookalike.identifier)).toBeNull();
    expect((await t.getIssue(mine.identifier))?.id).toBe(mine.id);
    await expect(t.comment(lookalike.id, "x")).rejects.toBeInstanceOf(OutOfProjectError);
    expect((await t.ready()).projectId).toBe(1);
  });

  it("chỉ 404 là 'không có': 5xx/429 nổi lên thành lỗi, không bị nuốt thành null", async () => {
    const issue = fake.addIssue({ title: "A" });
    const t = mk();
    fake.fail(/^GET \/issues\/\d+$/, 503, 1);
    await expect(t.getIssue(issue.id)).rejects.toMatchObject({ status: 503 });
    fake.fail(/^GET \/projects\/tech\.TECH\/issues\/\d+$/, 429, 1);
    await expect(t.getIssue(issue.identifier)).rejects.toMatchObject({ status: 429 });
    expect(await t.getIssue(99999)).toBeNull(); // 404 thật
  });

  it("lệnh ĐỌC thử lại lỗi tạm thời rồi thành công; lệnh GHI không bao giờ thử lại", async () => {
    const issue = fake.addIssue({ title: "A" });
    const t = createScopedTracker(
      new ItsaplanClient(fake.baseUrl, fake.agentKey, { retryOptions: { maxRetries: 0 } }),
      { team: "tech", project: "TECH" },
      { readRetries: 2, readRetryBaseMs: 1 },
    );
    fake.fail(/^GET \/issues\/\d+$/, 503, 2);
    expect((await t.getIssue(issue.id))?.id).toBe(issue.id);
    expect(fake.count(/^GET \/issues\/\d+$/)).toBe(3);

    fake.fail(/^POST \/issues\/\d+\/comments$/, 503, 1);
    await expect(t.comment(issue.id, "x")).rejects.toMatchObject({ status: 503 });
    expect(fake.count(/^POST \/issues\/\d+\/comments$/)).toBe(1); // không thử lại
    expect(fake.comments).toHaveLength(0);
  });

  it("ready() không nhớ thất bại, và từ chối dự án trả sai mã", async () => {
    const t = mk();
    fake.fail(/^GET \/projects\/tech\.TECH$/, 503, 1);
    await expect(t.ready()).rejects.toMatchObject({ status: 503 });
    expect((await t.ready()).projectId).toBe(1);
    const nope = createScopedTracker(
      new ItsaplanClient(fake.baseUrl, fake.agentKey, { retryOptions: { maxRetries: 0 } }),
      { team: "tech", project: "NOPE" },
      { readRetries: 0 },
    );
    await expect(nope.ready()).rejects.toMatchObject({ status: 404 });
  });

  it("forSignal: ghi bị từ chối khi signal đã huỷ, kể cả huỷ giữa chừng; đọc vẫn được", async () => {
    const issue = fake.addIssue({ title: "A" });
    const controller = new AbortController();
    const t = mk().forSignal(controller.signal);
    await t.comment(issue.id, "trước khi huỷ");
    controller.abort();
    await expect(t.comment(issue.id, "sau khi huỷ")).rejects.toBeInstanceOf(RunAbortedError);
    await expect(t.moveTo(issue.id, 2)).rejects.toBeInstanceOf(RunAbortedError);
    await expect(t.assign(issue.id, "u")).rejects.toBeInstanceOf(RunAbortedError);
    await expect(t.setPriority(issue.id, "low")).rejects.toBeInstanceOf(RunAbortedError);
    expect(fake.comments.filter((c) => c.actorUserId === "agent-user")).toHaveLength(1);
    expect((await t.getIssue(issue.id))?.id).toBe(issue.id);

    // huỷ trong lúc đang kiểm quyền (trước lệnh ghi thật)
    const c2 = new AbortController();
    const t2 = mk().forSignal(c2.signal);
    const pending = t2.comment(issue.id, "giữa chừng");
    c2.abort();
    await expect(pending).rejects.toBeInstanceOf(RunAbortedError);
  });
});
