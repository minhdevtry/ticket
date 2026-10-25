import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { applySchema } from "../../../lib/storage/schema";
import { getSharedBindingRepo } from "../../../lib/storage/binding-repository";
import { getIssue, updateIssue } from "./issues";

/**
 * IRIS (PO 01/10): chỉ tra / bổ sung yêu cầu CỦA CHÍNH người đang chat, không kể về yêu cầu
 * người khác; bổ sung phải qua bản xem trước + nút bấm mới ghi.
 */
describe("IRIS — chỉ yêu cầu của mình, bổ sung phải xác nhận", () => {
  const originalFetch = globalThis.fetch;
  const tracker = { baseUrl: "https://mock.itsaplan.test", apiKey: "k", projectKey: "PO" };
  const vocab = {
    noun: "yêu cầu",
    handlerTeam: "Product team",
    commentAuthorFallback: "Người phụ trách",
  };
  let dbPath: string;
  let calls: { method: string; url: string; body?: any }[];

  const call = (tool: { inputSchema: any; handler: (i: any) => any }, input: any) =>
    tool.handler(z.object(tool.inputSchema).parse(input) as any);

  beforeEach(() => {
    calls = [];
    dbPath = `/tmp/test-own-tickets-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    const db = new Database(dbPath, { create: true });
    applySchema(db);
    db.close();
    const repo = getSharedBindingRepo(dbPath);
    repo.saveBinding({
      issueId: 801,
      channelType: "telegram",
      chatId: "telegram:111",
      messageId: "1",
      identifier: "PO-80",
    });
    repo.saveBinding({
      issueId: 802,
      channelType: "telegram",
      chatId: "telegram:222",
      messageId: "1",
      identifier: "PO-84",
    });

    const issues: Record<string, any> = {
      "PO-80": {
        id: 801,
        identifier: "PO-80",
        title: "Nút xuất Excel",
        priority: "medium",
        columnId: 8,
        description: "Người báo: A - telegram:111",
      },
      "PO-84": {
        id: 802,
        identifier: "PO-84",
        title: "Vòng quay may mắn",
        priority: "medium",
        columnId: 7,
        description: "Người báo: B - telegram:222",
      },
    };
    globalThis.fetch = mock(async (input: any, init?: any) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (b: unknown, status = 200) =>
        new Response(JSON.stringify(b), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.endsWith("/projects/PO")) {
        return json({
          id: 1,
          key: "PO",
          columns: [
            { id: 7, name: "Backlog", stateType: "backlog" },
            { id: 8, name: "Discussion", stateType: "unstarted" },
          ],
          issueTypes: [],
          labels: [],
          customFields: [],
        });
      }
      const byKey = Object.values(issues).find((i) =>
        url.includes(`/projects/PO/issues/${i.identifier.split("-")[1]}`),
      );
      if (byKey && method === "GET" && !url.includes("/timeline")) return json(byKey);
      const byId = Object.values(issues).find((i) => url.endsWith(`/issues/${i.id}`));
      if (byId && method === "GET") return json(byId);
      if (url.includes("/timeline")) return json([]);
      if (url.endsWith("/comments") && method === "POST") return json({ id: 1, body: "ok" }, 201);
      if (method === "PATCH") return json({ ok: true });
      return json({ error: "nf" }, 404);
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      fs.unlinkSync(dbPath);
    } catch {}
  });

  test("tra yêu cầu của người khác → không kể gì (kể cả tiêu đề)", async () => {
    const res = (await call(getIssue(tracker, dbPath, vocab, { ownTicketsOnly: true }), {
      identifier: "PO-84",
      chatId: "telegram:111",
    })) as any;
    expect(res.found).toBe(false);
    expect(res.reason).toBe("not_yours");
    expect(JSON.stringify(res)).not.toContain("Vòng quay");
  });

  test("tra yêu cầu của mình → đủ tin, trạng thái PO kèm lời giải thích", async () => {
    const res = (await call(getIssue(tracker, dbPath, vocab, { ownTicketsOnly: true }), {
      identifier: "PO-80",
      chatId: "111",
    })) as any;
    expect(res.found).toBe(true);
    expect(res.status.name).toBe("Discussion (PO nhặt ticket và bắt đầu trao đổi cùng các bên)");
  });

  test("không truyền chatId thì không chứng minh được là của mình → từ chối", async () => {
    const res = (await call(getIssue(tracker, dbPath, vocab, { ownTicketsOnly: true }), {
      identifier: "PO-80",
    })) as any;
    expect(res.found).toBe(false);
  });

  test("bổ sung vào yêu cầu người khác → từ chối, không xem trước, không ghi", async () => {
    const tool = updateIssue(tracker, dbPath, vocab, {
      ownTicketsOnly: true,
      requireConfirmation: true,
    });
    const res = (await call(tool, {
      identifier: "PO-84",
      note: "thêm ý",
      chatId: "telegram:111",
    })) as any;
    expect(res.reason).toBe("not_yours");
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  test("bổ sung: lần đầu chỉ xem trước (chưa ghi); bấm xác nhận mới ghi đúng bản đã xem", async () => {
    const tool = updateIssue(tracker, dbPath, vocab, {
      ownTicketsOnly: true,
      requireConfirmation: true,
    });
    const preview = (await call(tool, {
      identifier: "PO-80",
      note: "thêm: cần xuất theo tuần",
      chatId: "telegram:111",
    })) as any;
    expect(preview.needsConfirmation).toBe(true);
    expect(preview.message).toContain("PO-80");
    expect(preview.message).toContain("thêm: cần xuất theo tuần");
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);

    // Agent truyền lại nội dung khác ở bước xác nhận → vẫn chỉ ghi bản đã xem
    const done = (await call(tool, {
      userConfirmed: true,
      chatId: "telegram:111",
      identifier: "PO-80",
      note: "NỘI DUNG KHÁC",
    })) as any;
    expect(done.updated).toBe(true);
    const comment = calls.find((c) => c.method === "POST" && c.url.endsWith("/comments"));
    expect(comment?.body.body).toContain("thêm: cần xuất theo tuần");
    expect(JSON.stringify(comment?.body)).not.toContain("NỘI DUNG KHÁC");

    // Bấm lại lần nữa → không còn bản chờ, không ghi thêm
    const again = (await call(tool, { userConfirmed: true, chatId: "telegram:111" })) as any;
    expect(again.reason).toBe("no_pending");
  });

  test("bấm Huỷ → không ghi, bản chờ bị xoá", async () => {
    const tool = updateIssue(tracker, dbPath, vocab, {
      ownTicketsOnly: true,
      requireConfirmation: true,
    });
    await call(tool, { identifier: "PO-80", note: "thêm ý", chatId: "telegram:111" });
    const cancelled = (await call(tool, { cancel: true, chatId: "telegram:111" })) as any;
    expect(cancelled.cancelled).toBe(true);
    const after = (await call(tool, { userConfirmed: true, chatId: "telegram:111" })) as any;
    expect(after.reason).toBe("no_pending");
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });
});
