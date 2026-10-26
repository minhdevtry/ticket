import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createIssue } from "./create-issue-description";
import { ticketDomain } from "./domain";

/**
 * TECH-1084 (02/10/2026): mô tả ticket phải là LỜI NGUYÊN VĂN của người báo, còn
 * suy luận của bot nằm ở comment riêng. Test ở mức tool `create_issue` — nơi
 * LLM gọi trực tiếp — vì đó chính là đường đã sinh ra TECH-1084.
 */
describe("create_issue: mô tả sạch, gợi ý ở comment riêng (TECH-1084)", () => {
  const originalFetch = globalThis.fetch;
  let created: Array<{ title?: string; description?: string }> = [];
  let comments: Array<{ issueId: string; body: string }> = [];
  const CHAT = "1000000005";

  const tracker = {
    baseUrl: "https://mock.itsaplan.test",
    apiKey: "k",
    projectKey: "TECH",
    webUrl: "https://x",
  };

  beforeEach(() => {
    created = [];
    comments = [];
    const m = mock(async (input: unknown, init?: RequestInit) => {
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
        const body = JSON.parse(init.body as string) as { title?: string; description?: string };
        created.push(body);
        return json(
          {
            id: 963,
            identifier: "TECH-1084",
            title: body.title,
            columnId: 10,
            sequenceNumber: 1084,
          },
          201,
        );
      }
      if (/\/issues\/\d+\/comments$/.test(url) && init?.method === "POST") {
        const body = JSON.parse(init.body as string) as { body: string };
        comments.push({ issueId: url.split("/issues/")[1].split("/")[0], body: body.body });
        return json({ id: 1, body: body.body }, 201);
      }
      return json({ error: "Not found" }, 404);
    });
    globalThis.fetch = m as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const baseInput = {
    reporterName: "UserJ",
    reporterUsername: "SA_UserJ",
    reporterNameCode: "SA_UserJ",
    reporterChatId: CHAT,
    title: "Học sinh không thấy bài kiểm tra BTVN",
    description:
      "Học sinh Nguyễn Văn Anh D báo không thấy bài kiểm tra. Cần đối chiếu dữ liệu lịch học.",
    rawText: "con bé Nguyễn Văn Anh D không thấy bài kiểm tra ạ, em hỗ trợ chị với",
    hasSpecificSubject: false,
    product: "Tutor",
    system: "TUTOR_Vuihoc",
    diagnosis: "Triệu chứng khớp cụm lịch sử: kiểm tra dữ liệu BTVN buổi học (TECH-768).",
    priority: "medium" as const,
    userConfirmed: true,
  };

  test("mô tả = lời nguyên văn, suy luận của bot sang comment", async () => {
    const tool = createIssue(tracker, ticketDomain);
    await tool.handler({ ...baseInput });

    expect(created).toHaveLength(1);
    const description = created[0].description as string;
    expect(description).toContain("> con bé Nguyễn Văn Anh D không thấy bài kiểm tra ạ");
    expect(description).not.toContain("Cần đối chiếu dữ liệu lịch học");
    expect(description).not.toContain("TECH-768");
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Gợi ý chuyên môn");
    expect(comments[0].body).toContain("TECH-768");
  });

  test("comment gợi ý phải mang dấu bot, nếu không sẽ bị học thành 'lời người thật'", async () => {
    const tool = createIssue(tracker, ticketDomain);
    await tool.handler({ ...baseInput });

    expect(comments[0].body).toContain("<!-- intake-bot -->");
  });

  test("bản xem trước hiện đúng lời sẽ ghi vào mô tả (ADR-0008)", async () => {
    const tool = createIssue(tracker, ticketDomain);
    const res = (await tool.handler({ ...baseInput, userConfirmed: false })) as {
      created: boolean;
      needsConfirmation: boolean;
      message: string;
    };

    expect(res.created).toBe(false);
    expect(res.needsConfirmation).toBe(true);
    expect(res.message).toContain("con bé Nguyễn Văn Anh D không thấy bài kiểm tra ạ");
    expect(res.message).not.toContain("Cần đối chiếu dữ liệu lịch học");
    expect(created).toHaveLength(0);
  });

  test("khi model không đưa rawText, bản xem trước nói rõ đó là lời tóm tắt", async () => {
    const tool = createIssue(tracker, ticketDomain);
    const res = (await tool.handler({
      ...baseInput,
      rawText: undefined,
      userConfirmed: false,
    })) as { message: string };

    expect(res.message).toContain("Em tự tóm lại phần này");
  });

  test("lời người gõ có Markdown không làm vỡ bản xem trước", async () => {
    const tool = createIssue(tracker, ticketDomain);
    const nasty = "lỗi *đậm* _nghiêng_ `code` [link](x) # heading | pipe";
    const res = (await tool.handler({
      ...baseInput,
      rawText: nasty,
      userConfirmed: false,
    })) as { message: string };

    expect(res.message).toContain("\\*đậm\\*");
    expect(res.message).not.toMatch(/(^|\n)\s*\*đậm\*/);
  });

  test("hỏng khi ghi comment thì ticket vẫn được tạo (best-effort)", async () => {
    const m = mock(async (input: unknown, init?: RequestInit) => {
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
        const body = JSON.parse(init.body as string) as { title?: string; description?: string };
        created.push(body);
        return json(
          {
            id: 963,
            identifier: "TECH-1084",
            title: body.title,
            columnId: 10,
            sequenceNumber: 1084,
          },
          201,
        );
      }
      if (/\/issues\/\d+\/comments$/.test(url)) {
        return json({ error: "db unavailable" }, 500);
      }
      return json({ error: "Not found" }, 404);
    });
    globalThis.fetch = m as unknown as typeof fetch;

    const tool = createIssue(tracker, ticketDomain);
    const res = (await tool.handler({ ...baseInput })) as {
      created: boolean;
      issue: { identifier?: string };
    };

    expect(res.created).toBe(true);
    expect(res.issue.identifier).toBe("TECH-1084");
    expect(created).toHaveLength(1);
  });

  test("không tạo comment rác khi không có diagnosis", async () => {
    const tool = createIssue(tracker, ticketDomain);
    await tool.handler({ ...baseInput, diagnosis: undefined });

    expect(created).toHaveLength(1);
    expect(comments).toHaveLength(0);
  });
});
