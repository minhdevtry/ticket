import { afterAll, describe, expect, test, mock } from "bun:test";
import { DuplicateMerger, mentionedSiblingTickets } from "./duplicate-merger";
import { isBotComment } from "../lib/formatting";
import type { LlmConfig } from "./llm";
import type { ItsaplanClient } from "../lib/itsaplan/client";

/**
 * LLM giả: một máy chủ HTTP thật (như worker/llm.test.ts) — tránh giả lập
 * bằng cách ghi đè export của module, vốn không đáng tin với ESM live bindings.
 * Model được chọn quyết định câu trả lời, mô phỏng cách phân biệt "tuyên bố
 * trùng" khỏi "chỉ tham khảo".
 */
const fakeLlmServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const body = (await req.json()) as { model: string };
    if (body.model === "vo-lien-lac")
      return new Response('{"error":"ECONNREFUSED"}', { status: 503 });
    const content =
      body.model === "tuyen-bo-trung"
        ? JSON.stringify({ duplicate: true, evidence: "Báo trùng TECH-943 => Hủy TECH-944" })
        : JSON.stringify({ duplicate: false, evidence: "" });
    return Response.json({ choices: [{ message: { content } }] });
  },
});
afterAll(() => fakeLlmServer.stop(true));
const baseUrl = `http://127.0.0.1:${fakeLlmServer.port}`;

const LLM_DUPLICATE: LlmConfig = { api: "openai", baseUrl, apiKey: "", model: "tuyen-bo-trung" };
const LLM_NOT_DUPLICATE: LlmConfig = { api: "openai", baseUrl, apiKey: "", model: "chi-tham-khao" };
const LLM_ERROR: LlmConfig = { api: "openai", baseUrl, apiKey: "", model: "vo-lien-lac" };
const LLM_UNCONFIGURED: LlmConfig = { api: "openai", baseUrl: "", apiKey: "", model: "" };

/** Itsaplan giả: TECH-944 (X, ticket trùng) và TECH-943 (Y, ticket còn giữ). */
function fakeIssues(over: { xColumnId?: number; xLinks?: any[]; yTimeline?: any[] } = {}) {
  const columns = [
    { id: 1, name: "Đang xử lý", stateType: "started" as const, position: 1 },
    { id: 2, name: "Done", stateType: "completed" as const, position: 2 },
    { id: 5, name: "Huỷ", stateType: "canceled" as const, position: 3 },
  ];
  const issues: Record<number, any> = {
    944: {
      id: 944,
      identifier: "TECH-944",
      title: "Lỗi đăng nhập",
      description:
        "### Mô tả\n\n> Không đăng nhập được app\n> kèm ảnh lỗi\n\n### 📸 Ảnh đính kèm\n\n![loi.png](https://x.test/loi.png)\n",
      columnId: over.xColumnId ?? 1,
      createdAt: "2026-09-28T03:00:00.000Z",
      links: over.xLinks ?? [],
    },
    943: {
      id: 943,
      identifier: "TECH-943",
      title: "Lỗi đăng nhập gốc",
      description: "### Mô tả\n\n> Lỗi đăng nhập gốc\n",
      columnId: 1,
      createdAt: "2026-09-27T03:00:00.000Z",
      links: [],
    },
  };
  const writes: string[] = [];
  const itsaplan = {
    getIssue: mock(async (id: number) => issues[id]),
    getIssueByNumber: mock(async (_p: string, seq: number) =>
      Object.values(issues).find((i: any) => i.identifier.endsWith(`-${seq}`)),
    ),
    addComment: mock(async (issueId: number, body: string) => {
      writes.push(`comment #${issueId}: ${body}`);
      return { id: writes.length, body };
    }),
    linkIssues: mock(async (from: number, to: number, kind: string) => {
      writes.push(`link ${from}->${to} (${kind})`);
      return { id: 1, kind };
    }),
    updateIssue: mock(async (issueId: number, patch: any) => {
      writes.push(`updateIssue #${issueId} ${JSON.stringify(patch)}`);
      return issues[issueId];
    }),
    listProjectColumns: mock(async () => columns),
    getIssueTimeline: mock(async (issueId: number) =>
      issueId === 943 ? (over.yTimeline ?? []) : [],
    ),
  };
  return { itsaplan, writes };
}

describe("mentionedSiblingTickets", () => {
  test("lấy mã cùng dự án, bỏ chính mình", () => {
    expect(mentionedSiblingTickets("Báo trùng TECH-943 => Hủy TECH-944", "TECH-944")).toEqual([
      "TECH-943",
    ]);
  });

  test("bỏ mã dự án khác", () => {
    expect(mentionedSiblingTickets("liên quan PO-12 và TECH-501", "TECH-944")).toEqual([
      "TECH-501",
    ]);
  });

  test("không có mã nào thì rỗng", () => {
    expect(mentionedSiblingTickets("bên em đang kiểm tra giúp anh nhé", "TECH-944")).toEqual([]);
  });
});

describe("DuplicateMerger.handleComment", () => {
  test("ca trùng thật (944→943): gộp mô tả + ảnh sang Y, nối link, huỷ X kèm comment", async () => {
    const { itsaplan, writes } = fakeIssues();
    const merger = new DuplicateMerger({
      itsaplan: itsaplan as any,
      llm: LLM_DUPLICATE,
      projectKey: "TECH",
    });

    const outcome = await merger.handleComment({
      issueId: 944,
      identifier: "TECH-944",
      commentBody: "@tieulinh Báo trùng TECH-943 => Hủy TECH-944",
      actorName: "Nguyễn Văn Kỹ Thuật",
    });
    expect(outcome).toEqual({ merged: true, target: "TECH-943" });

    const commentOnY = writes.find((w) => w.startsWith("comment #943"));
    expect(commentOnY).toBeDefined();
    expect(commentOnY).toContain("🔀 Gộp từ TECH-944");
    expect(commentOnY).toContain("Không đăng nhập được app");
    expect(commentOnY).toContain("kèm ảnh lỗi");
    expect(commentOnY).toContain("![loi.png](https://x.test/loi.png)");
    expect(isBotComment(commentOnY!)).toBe(true);

    expect(writes.some((w) => w === "link 944->943 (duplicates)")).toBe(true);
    expect(writes.some((w) => w === 'updateIssue #944 {"columnId":5}')).toBe(true);
    const infoOnX = writes.find((w) => w.startsWith("comment #944"));
    expect(infoOnX).toContain("Đã gộp vào TECH-943");
    expect(infoOnX).toContain("Nguyễn Văn Kỹ Thuật");
  });

  test("ca chỉ tham khảo: LLM trả false, không làm gì", async () => {
    const { itsaplan, writes } = fakeIssues();
    const merger = new DuplicateMerger({
      itsaplan: itsaplan as any,
      llm: LLM_NOT_DUPLICATE,
      projectKey: "TECH",
    });

    const outcome = await merger.handleComment({
      issueId: 944,
      identifier: "TECH-944",
      commentBody: "tham khảo TECH-943 xem có giống không nhé",
      actorName: "Kỹ thuật",
    });
    expect(outcome).toEqual({ merged: false, reason: "not_duplicate" });
    expect(writes.length).toBe(0);
  });

  test("không nhắc ticket nào thì bỏ qua, không gọi LLM", async () => {
    const { itsaplan, writes } = fakeIssues();
    const merger = new DuplicateMerger({
      itsaplan: itsaplan as any,
      llm: LLM_ERROR,
      projectKey: "TECH",
    });

    const outcome = await merger.handleComment({
      issueId: 944,
      identifier: "TECH-944",
      commentBody: "@techuser_b xử lý giúp em với ạ",
      actorName: "Kỹ thuật",
    });
    expect(outcome).toEqual({ merged: false, reason: "no_mention" });
    expect(writes.length).toBe(0);
  });

  test("ca idempotent: webhook gửi lại, Y đã có comment gộp từ trước thì bỏ qua", async () => {
    const marker =
      "🔀 Gộp từ TECH-944 (@a, 2026-09-28 10:00):\n\n(không có mô tả)\n\n<!-- intake-bot -->";
    const { itsaplan, writes } = fakeIssues({ yTimeline: [{ kind: "comment", body: marker }] });
    const merger = new DuplicateMerger({
      itsaplan: itsaplan as any,
      llm: LLM_DUPLICATE,
      projectKey: "TECH",
    });

    const outcome = await merger.handleComment({
      issueId: 944,
      identifier: "TECH-944",
      commentBody: "Báo trùng TECH-943 => Hủy TECH-944",
      actorName: "Kỹ thuật",
    });
    expect(outcome).toEqual({ merged: false, reason: "already_merged" });
    expect(writes.length).toBe(0);
  });

  test("ca X đã canceled từ trước: vẫn gộp/nối link nhưng không chuyển cột hay ghi info lần nữa", async () => {
    const { itsaplan, writes } = fakeIssues({ xColumnId: 5 });
    const merger = new DuplicateMerger({
      itsaplan: itsaplan as any,
      llm: LLM_DUPLICATE,
      projectKey: "TECH",
    });

    const outcome = await merger.handleComment({
      issueId: 944,
      identifier: "TECH-944",
      commentBody: "Báo trùng TECH-943 => Hủy TECH-944",
      actorName: "Kỹ thuật",
    });
    expect(outcome).toEqual({ merged: true, target: "TECH-943" });
    expect(writes.some((w) => w.startsWith("comment #943"))).toBe(true);
    expect(writes.some((w) => w.startsWith("updateIssue"))).toBe(false);
    expect(writes.some((w) => w.startsWith("comment #944"))).toBe(false);
  });

  test("ca LLM lỗi: chỉ log, không gộp, không ghi gì", async () => {
    const { itsaplan, writes } = fakeIssues();
    const merger = new DuplicateMerger({
      itsaplan: itsaplan as any,
      llm: LLM_ERROR,
      projectKey: "TECH",
    });

    const outcome = await merger.handleComment({
      issueId: 944,
      identifier: "TECH-944",
      commentBody: "Báo trùng TECH-943 => Hủy TECH-944",
      actorName: "Kỹ thuật",
    });
    expect(outcome).toEqual({ merged: false, reason: "error" });
    expect(writes.length).toBe(0);
  });

  test("bỏ qua bình luận của system actor (Tiểu Linh/bot)", async () => {
    const { itsaplan, writes } = fakeIssues();
    const merger = new DuplicateMerger({
      itsaplan: itsaplan as any,
      llm: LLM_DUPLICATE,
      projectKey: "TECH",
    });

    const outcome = await merger.handleComment({
      issueId: 944,
      identifier: "TECH-944",
      commentBody: "Báo trùng TECH-943 => Hủy TECH-944",
      actorName: "Tiểu Linh",
    });
    expect(outcome).toEqual({ merged: false, reason: "no_mention" });
    expect(writes.length).toBe(0);
  });

  test("thiếu cấu hình LLM thì bỏ qua, không gọi mạng", async () => {
    const { itsaplan, writes } = fakeIssues();
    const merger = new DuplicateMerger({
      itsaplan: itsaplan as any,
      llm: LLM_UNCONFIGURED,
      projectKey: "TECH",
    });

    const outcome = await merger.handleComment({
      issueId: 944,
      identifier: "TECH-944",
      commentBody: "Báo trùng TECH-943 => Hủy TECH-944",
      actorName: "Kỹ thuật",
    });
    expect(outcome).toEqual({ merged: false, reason: "llm_unconfigured" });
    expect(writes.length).toBe(0);
  });

  test("ticket đích đã chuyển sang dự án khác (#493) → không gộp nhầm", async () => {
    const { itsaplan, writes } = fakeIssues();
    itsaplan.getIssueByNumber = mock(async () => ({
      id: 943,
      identifier: "PO-200",
      title: "Đã chuyển sang PO",
      description: "",
      columnId: 1,
    }));
    const merger = new DuplicateMerger({
      itsaplan: itsaplan as unknown as ItsaplanClient,
      llm: LLM_DUPLICATE,
      projectKey: "TECH",
    });

    const outcome = await merger.handleComment({
      issueId: 944,
      identifier: "TECH-944",
      commentBody: "@tieulinh Báo trùng TECH-943 => Hủy TECH-944",
      actorName: "Kỹ thuật",
    });
    expect(outcome).toEqual({ merged: false, reason: "error" });
    expect(writes).toHaveLength(0);
  });
});
