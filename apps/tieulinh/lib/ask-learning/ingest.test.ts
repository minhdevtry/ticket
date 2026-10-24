import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { ingest } from "./ingest";
import { AskLearnStore } from "./store";
import type { SourceTicket } from "./source";
import { commentIdOf } from "./source";

const cfg = { baseUrl: "http://x", apiKey: "", model: "m", api: "openai" as const };
const NOW = Date.parse("2026-10-16T00:00:00Z");

const tickets: SourceTicket[] = [
  {
    issueKey: "TECH-1",
    createdAt: "2026-10-01T00:00:00Z",
    title: "Lỗi CRM",
    description: "Không tạo được đơn\n- Hệ thống: CRM_Vuihoc",
    systemRaw: "CRM_Vuihoc",
    comments: [
      {
        commentId: commentIdOf("TECH-1", 0),
        actor: "TechUser_B",
        createdAt: "2026-10-01T02:00:00Z",
        body: "@Tiểu Linh bạn gửi mã đơn giúp em",
      },
      {
        commentId: commentIdOf("TECH-1", 1),
        actor: "SA_X",
        createdAt: "2026-10-01T03:00:00Z",
        body: "đã gửi",
      },
    ],
  },
  {
    issueKey: "TECH-2",
    createdAt: "2026-10-02T00:00:00Z",
    title: "Lỗi LMS",
    description: "- Hệ thống: LMS_Vuihoc",
    systemRaw: "LMS_Vuihoc",
    comments: [
      {
        commentId: commentIdOf("TECH-2", 0),
        actor: "TechUser_C",
        createdAt: "2026-10-02T02:00:00Z",
        body: "@SA_UserD cho em xin link LMS",
      },
    ],
  },
];

function fakeComplete(calls: string[], failOn?: string) {
  return async (_c: unknown, _s: string, user: string) => {
    calls.push(user);
    if (failOn && user.includes(failOn)) throw new Error("HTTP 503");
    return '{"needs_info": true, "kind": "supplement_request", "items": ["ORDER_CODE"], "already_in_report": false, "evidence": "gửi"}';
  };
}

describe("ingest", () => {
  it("phân loại ứng viên, ghi kho; chạy lại không gọi LLM lần nữa", async () => {
    const store = new AskLearnStore(new Database(":memory:"));
    const calls: string[] = [];
    const first = await ingest({
      store,
      tickets,
      llm: cfg,
      completeFn: fakeComplete(calls),
      now: () => NOW,
      concurrency: 4,
    });
    expect(first.candidates).toBe(2);
    expect(first.classified).toBe(2);
    expect(first.needsInfo).toBe(2);
    expect(calls.length).toBe(2);
    expect(store.ticketsOf("CRM_Vuihoc").length).toBe(1);

    const again = await ingest({
      store,
      tickets,
      llm: cfg,
      completeFn: fakeComplete(calls),
      now: () => NOW,
    });
    expect(again.alreadyClassified).toBe(2);
    expect(again.toClassify).toBe(0);
    expect(calls.length).toBe(2);
  });

  it("lỗi LLM không ghi gì, lần sau thử lại", async () => {
    const store = new AskLearnStore(new Database(":memory:"));
    const calls: string[] = [];
    const bad = await ingest({
      store,
      tickets,
      llm: cfg,
      completeFn: fakeComplete(calls, "mã đơn"),
      now: () => NOW,
    });
    expect(bad.errors).toBe(1);
    expect(store.hasComment(commentIdOf("TECH-1", 0))).toBe(false);
    const retry = await ingest({
      store,
      tickets,
      llm: cfg,
      completeFn: fakeComplete(calls),
      now: () => NOW,
    });
    expect(retry.toClassify).toBe(1);
    expect(retry.errors).toBe(0);
  });

  it("chạy thử: không gọi LLM, không ghi", async () => {
    const store = new AskLearnStore(new Database(":memory:"));
    const calls: string[] = [];
    const s = await ingest({
      store,
      tickets,
      llm: cfg,
      completeFn: fakeComplete(calls),
      dryRun: true,
      now: () => NOW,
    });
    expect(s.dryRun).toBe(true);
    expect(s.toClassify).toBe(2);
    expect(calls.length).toBe(0);
    expect(store.systems()).toEqual([]);
  });

  it("re-ingest làm mới metadata (system, created_at) cho ticket và bình luận đã có mà KHÔNG gọi LLM", async () => {
    const store = new AskLearnStore(new Database(":memory:"));
    const calls: string[] = [];
    const oldTickets: SourceTicket[] = [
      {
        issueKey: "TECH-1",
        createdAt: "",
        title: "Lỗi CRM",
        description: "",
        systemRaw: "",
        comments: [
          {
            commentId: commentIdOf("TECH-1", 0),
            actor: "TechUser_B",
            createdAt: "2026-10-01T02:00:00Z",
            body: "@Tiểu Linh gửi mã đơn",
          },
        ],
      },
    ];
    const s1 = await ingest({
      store,
      tickets: oldTickets,
      llm: cfg,
      completeFn: fakeComplete(calls),
      now: () => NOW,
    });
    expect(s1.classified).toBe(1);
    expect(calls.length).toBe(1);
    expect(store.ticketsOf("").length).toBe(1);
    expect(store.needsCommentsOf("").length).toBe(1);
    expect(store.ticketsOf("CRM_Vuihoc").length).toBe(0);
    expect(store.needsCommentsOf("CRM_Vuihoc").length).toBe(0);

    const refreshedTickets: SourceTicket[] = [
      {
        issueKey: "TECH-1",
        createdAt: "2026-10-01T00:00:00Z",
        title: "Lỗi CRM",
        description: "## Thông tin sự cố\n- Hệ thống: CRM_Vuihoc",
        systemRaw: "CRM_Vuihoc",
        comments: [
          {
            commentId: commentIdOf("TECH-1", 0),
            actor: "TechUser_B",
            createdAt: "2026-10-01T02:00:00Z",
            body: "@Tiểu Linh gửi mã đơn",
          },
        ],
      },
    ];
    const s2 = await ingest({
      store,
      tickets: refreshedTickets,
      llm: cfg,
      completeFn: fakeComplete(calls),
      now: () => NOW,
    });
    expect(s2.alreadyClassified).toBe(1);
    expect(s2.toClassify).toBe(0);
    expect(s2.classified).toBe(0);
    expect(calls.length).toBe(1);
    expect(store.ticketsOf("").length).toBe(0);
    expect(store.needsCommentsOf("").length).toBe(0);
    expect(store.ticketsOf("CRM_Vuihoc").length).toBe(1);
    expect(store.ticketsOf("CRM_Vuihoc")[0].createdAt).toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(store.needsCommentsOf("CRM_Vuihoc").length).toBe(1);
    expect(store.needsCommentsOf("CRM_Vuihoc")[0].system).toBe("CRM_Vuihoc");
  });
});
