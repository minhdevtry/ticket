import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { createIssue, withChatLock, type IssueDomain } from "./create-issue";
import { applySchema } from "../../../lib/storage/schema";
import { getSharedIntakeDocRepo } from "../../../lib/intake-document/repository";
import { getSharedBindingRepo } from "../../../lib/storage/binding-repository";
import { clearPendingButtons } from "../../../lib/telegram/buttons";
import type { IntakeDocument } from "../../../lib/intake-document/types";

/**
 * intake_step là đường chính tạo ticket. Model đôi khi vẫn gọi thêm
 * create_issue(userConfirmed: true) sau khi intake_step đã tạo xong — không
 * được ra ticket thứ hai cho cùng một sự cố.
 */
describe("create_issue ↔ IntakeDocument: chống tạo trùng", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;
  let dbPath: string;
  let createCalls = 0;
  const CHAT = "555001";

  const domain: IssueDomain<any> = {
    description: "Tạo ticket sự cố",
    inputShape: {
      title: z.string(),
      description: z.string(),
      reporterName: z.string(),
      reporterChatId: z.string().optional(),
    },
    build: (input: any) => ({
      title: String(input.title),
      description: String(input.description),
      priority: "medium",
      confirmation: "Đã tạo {identifier}",
    }),
  };

  const tracker = { baseUrl: "https://mock.itsaplan.test", apiKey: "k", projectKey: "TECH" };

  const doc = (over: Partial<IntakeDocument>): IntakeDocument => ({
    docId: "doc_dedupe",
    chatId: CHAT,
    revision: 3,
    status: "created",
    currentTurn: 3,
    fields: { title: { value: "App Duo lỗi", source: "user_message", turn: 1, updatedAt: "" } },
    evidence: {},
    askedCount: {},
    similarTickets: [],
    issueId: 700,
    issueIdentifier: "TECH-700",
    issueCreatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  });

  beforeEach(() => {
    createCalls = 0;
    dbPath = `/tmp/test-intake-dedupe-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    const db = new Database(dbPath, { create: true });
    applySchema(db);
    db.close();

    mockFetch = mock(async (input: any, init?: any) => {
      const url = String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.endsWith("/projects/TECH")) {
        return json({
          id: 1,
          key: "TECH",
          name: "Tech",
          columns: [{ id: 10, name: "Backlog", stateType: "backlog" }],
          issueTypes: [],
          labels: [],
          customFields: [],
        });
      }
      if (url.endsWith("/projects/TECH/issues") && init?.method === "POST") {
        createCalls++;
        const body = JSON.parse(init.body);
        return json({ id: 888, identifier: "TECH-888", title: body.title, columnId: 10 }, 201);
      }
      return json({ error: "Not found" }, 404);
    });
    globalThis.fetch = mockFetch as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearPendingButtons(CHAT);
    try {
      fs.unlinkSync(dbPath);
    } catch {}
  });

  test("intake_step vừa tạo ticket → create_issue(userConfirmed) trả lại ticket đó, không tạo mới", async () => {
    getSharedIntakeDocRepo(dbPath).saveRevision(doc({}));
    const tool = createIssue(tracker, domain, dbPath);
    const res = (await tool.handler({
      title: "App Duo lỗi",
      description: "Học sinh không vào được lớp",
      reporterName: "Khách A",
      reporterChatId: `telegram:${CHAT}`,
      userConfirmed: true,
    })) as any;

    expect(res.created).toBe(false);
    expect(res.alreadyCreated).toBe(true);
    expect(res.issue.identifier).toBe("TECH-700");
    expect(createCalls).toBe(0);
  });

  test("ticket intake đã cũ (ngoài cửa sổ chống trùng) → create_issue tạo bình thường", async () => {
    const old = new Date(Date.now() - 3 * 3600_000).toISOString();
    getSharedIntakeDocRepo(dbPath).saveRevision(doc({ issueCreatedAt: old, updatedAt: old }));
    const tool = createIssue(tracker, domain, dbPath);
    const res = (await tool.handler({
      title: "Sự cố khác",
      description: "CRM lỗi 500",
      reporterName: "Khách A",
      reporterChatId: CHAT,
      userConfirmed: true,
    })) as any;
    expect(res.created).toBe(true);
    expect(createCalls).toBe(1);
  });

  test("create_issue tạo ticket → chỉ đóng tài liệu intake đang MỞ, ghi issueCreatedAt", async () => {
    const repo = getSharedIntakeDocRepo(dbPath);
    repo.saveRevision(
      doc({
        status: "collecting",
        issueId: undefined,
        issueIdentifier: undefined,
        issueCreatedAt: undefined,
      }),
    );
    const tool = createIssue(tracker, domain, dbPath);
    await tool.handler({
      title: "CRM lỗi",
      description: "CRM lỗi 500",
      reporterName: "Khách A",
      reporterChatId: CHAT,
      userConfirmed: true,
    });

    const latest = repo.getLatestByChatId(CHAT)!;
    expect(latest.status).toBe("created");
    expect(latest.issueIdentifier).toBe("TECH-888");
    expect(latest.issueCreatedAt).toBeTruthy();
    expect(getSharedBindingRepo(dbPath).getLatestBinding(CHAT)?.identifier).toBe("TECH-888");
  });

  test("create_issue KHÔNG đánh dấu tài liệu đã huỷ thành created", async () => {
    const repo = getSharedIntakeDocRepo(dbPath);
    repo.saveRevision(
      doc({
        status: "canceled",
        issueId: undefined,
        issueIdentifier: undefined,
        issueCreatedAt: undefined,
      }),
    );
    const tool = createIssue(tracker, domain, dbPath);
    await tool.handler({
      title: "CRM lỗi",
      description: "CRM lỗi 500",
      reporterName: "Khách A",
      reporterChatId: CHAT,
      userConfirmed: true,
    });
    expect(repo.getLatestByChatId(CHAT)!.status).toBe("canceled");
  });

  test("withChatLock tuần tự hoá hai việc cùng chat (kể cả khác dạng chatId)", async () => {
    const order: string[] = [];
    const slow = withChatLock(`telegram:${CHAT}`, async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-end");
    });
    const fast = withChatLock(CHAT, async () => {
      order.push("b");
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });
});
