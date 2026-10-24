import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runCli } from "./ask-learn";
import type { ItsaplanReadSource } from "../lib/ask-learning/source";

const tmpRoot = path.join(import.meta.dir, "..", "..", "tmp", "ask-learn-test");
fs.mkdirSync(tmpRoot, { recursive: true });
const dir = fs.mkdtempSync(path.join(tmpRoot, "run-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const env = { OPENAI_BASE_URL: "http://fake.invalid/v1", OPENAI_MODEL: "fake-model", OPENAI_API_KEY: "" };

function writeJsonl(name: string, rows: unknown[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  return file;
}

const rows = [
  {
    ticket_id: "TECH-101", created_at: "2026-09-01T00:00:00Z", title: "Lỗi CRM", description: "Mô tả\n- Hệ thống: CRM_Vuihoc",
    system_reported: "CRM_Vuihoc",
    human_comments: [
      { actor_name: "TechUser_B", created_at: "2026-09-01T02:00:00Z", body: "@Tiểu Linh bạn gửi mã đơn giúp em" },
      { actor_name: "SA_UserE", created_at: "2026-09-01T03:00:00Z", body: "đã gửi" },
    ],
  },
  {
    ticket_id: "TECH-102", created_at: "2026-09-02T00:00:00Z", title: "Lỗi CRM 2", description: "Mô tả 2",
    system_reported: "CRM_Vuihoc",
    human_comments: [{ actor_name: "TechUser_C", created_at: "2026-09-02T02:00:00Z", body: "@SA_UserD cho em xin link contact" }],
  },
  {
    ticket_id: "TECH-103", created_at: "2026-09-03T00:00:00Z", title: "Lỗi LMS", description: "Mô tả 3",
    system_reported: "LMS_Vuihoc",
    human_comments: [{ actor_name: "TechUser_B", created_at: "2026-09-03T02:00:00Z", body: "Đã xử lý xong" }],
  },
];

describe("ask-learn CLI", () => {
  it("ingest từ JSONL với LLM giả, rồi report; chạy lại không gọi LLM", async () => {
    const db = path.join(dir, "kho.sqlite");
    const file = writeJsonl("tickets.jsonl", rows);
    const lines: string[] = [];
    const calls: string[] = [];
    const complete = async (_c: unknown, _s: string, user: string) => {
      calls.push(user);
      return '{"needs_info": true, "kind": "supplement_request", "items": ["ORDER_CODE"], "already_in_report": false, "evidence": "gửi mã đơn"}';
    };
    const code = await runCli(["ingest", "--db", db, "--from-jsonl", file, "--concurrency", "4"], {
      env, complete, out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(calls.length).toBe(2);
    expect(lines.some((l) => l.includes("quét 3 ticket") && l.includes("phân loại mới 2"))).toBe(true);

    const again: string[] = [];
    await runCli(["ingest", "--db", db, "--from-jsonl", file], { env, complete, out: (l) => again.push(l) });
    expect(calls.length).toBe(2);
    expect(again.some((l) => l.includes("phân loại mới 0"))).toBe(true);

    const rep: string[] = [];
    expect(await runCli(["report", "--db", db], { out: (l) => rep.push(l) })).toBe(0);
    expect(rep[0]).toContain("Hệ thống");
    expect(rep.some((l) => l.startsWith("CRM_Vuihoc | 2"))).toBe(true);
  });

  it("--exclude bỏ ticket theo query_id; --dry-run không gọi LLM", async () => {
    const db = path.join(dir, "kho2.sqlite");
    const file = writeJsonl("tickets2.jsonl", rows);
    const excl = writeJsonl("exclude.jsonl", [{ query_id: "TECH-101" }]);
    const lines: string[] = [];
    let calls = 0;
    await runCli(["ingest", "--db", db, "--from-jsonl", file, "--exclude", excl, "--dry-run"], {
      env, complete: async () => { calls++; return "{}"; }, out: (l) => lines.push(l),
    });
    expect(calls).toBe(0);
    expect(lines.some((l) => l.includes("quét 2 ticket"))).toBe(true);
  });

  it("nguồn Itsaplan chỉ đọc: không gọi hàm ghi nào", async () => {
    const db = path.join(dir, "kho3.sqlite");
    const touched = new Set<string>();
    const issues = [
      { id: 1, identifier: "TECH-201", sequenceNumber: 201, createdAt: "2026-09-05T00:00:00Z", title: "t",
        description: "- Hệ thống: DUO_Vuihoc", archivedAt: null },
    ];
    const itsaplan = new Proxy({} as ItsaplanReadSource, {
      get(_t, prop: string) {
        touched.add(prop);
        if (prop === "listProjectIssues") return async () => issues;
        if (prop === "listComments")
          return async () => [{ id: 9, body: "@Tiểu Linh gửi ảnh màn hình giúp em", author: { name: "TechLead_A" }, createdAt: "2026-09-05T01:00:00Z" }];
        throw new Error(`gọi phương thức không được phép: ${prop}`);
      },
    });
    const complete = async () => '{"needs_info": true, "kind": "ask", "items": ["SCREENSHOT"], "already_in_report": false, "evidence": ""}';
    const code = await runCli(["ingest", "--db", db, "--project", "TECH"], {
      env: { ...env, ITSAPLAN_BASE_URL: "http://unused", ITSAPLAN_API_KEY: "x" }, itsaplan, complete, out: () => {},
    });
    expect(code).toBe(0);
    expect([...touched].sort()).toEqual(["listComments", "listProjectIssues"]);
  });

  it("mã nguồn script không chứa lệnh ghi lên Itsaplan", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "ask-learn.ts"), "utf-8");
    const writes = ["addComment", "updateIssue", "setFieldValue", "createIssue", "deleteIssue", "setCustomFieldValue",
      "uploadAttachment", "linkIssues", "addLink", "deleteLink", "createLabel", "createProject", "createWebhook"];
    for (const w of writes) expect(src).not.toContain(w);
  });
});
