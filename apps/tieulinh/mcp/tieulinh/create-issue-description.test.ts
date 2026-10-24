import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { createIssue } from "../shared/tools/create-issue";
import { ticketDomain } from "./domain";

/**
 * TECH-1084 (02/10/2026): mô tả ticket phải là LỜI NGUYÊN VĂN của người báo, còn
 * suy luận của bot nằm ở comment riêng. Test ở mức tool `create_issue` — nơi
 * LLM gọi trực tiếp — vì đó chính là đường đã sinh ra TECH-1084.
 */
describe("create_issue: mô tả sạch, gợi ý ở comment riêng (TECH-1084)", () => {
  const originalFetch = globalThis.fetch;
  let created: any[] = [];
  let comments: Array<{ issueId: string; body: string }> = [];
  const CHAT = "1000000005";

  const tracker = { baseUrl: "https://mock.itsaplan.test", apiKey: "k", projectKey: "TECH", webUrl: "https://x" } as any;

  beforeEach(() => {
    created = [];
    comments = [];
    const m = mock(async (input: any, init?: any) => {
      const url = String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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
        const body = JSON.parse(init.body);
        created.push(body);
        return json({ id: 963, identifier: "TECH-1084", title: body.title, columnId: 10, sequenceNumber: 1084 }, 201);
      }
      if (/\/issues\/\d+\/comments$/.test(url) && init?.method === "POST") {
        const body = JSON.parse(init.body);
        comments.push({ issueId: url.split("/issues/")[1].split("/")[0], body: body.body });
        return json({ id: 1, body: body.body }, 201);
      }
      return json({ error: "Not found" }, 404);
    });
    globalThis.fetch = m as any;
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
    // Bản model viết lại — KHÔNG được phép làm nội dung mô tả.
    description: "Học sinh Nguyễn Văn Anh D báo không thấy bài kiểm tra. Cần đối chiếu dữ liệu lịch học.",
    // Nguyên văn người báo — đây mới là mô tả.
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
    await tool.handler({ ...baseInput } as any);

    expect(created).toHaveLength(1);
    const description = created[0].description as string;
    // Toàn bộ phần người đọc thấy: chỉ lời nguyên văn.
    expect(description).toContain("> con bé Nguyễn Văn Anh D không thấy bài kiểm tra ạ");
    expect(description).not.toContain("Cần đối chiếu dữ liệu lịch học");
    expect(description).not.toContain("TECH-768");
    // Suy luận nằm ở comment riêng.
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Gợi ý chuyên môn");
    expect(comments[0].body).toContain("TECH-768");
  });

  test("comment gợi ý phải mang dấu bot, nếu không sẽ bị học thành 'lời người thật'", async () => {
    const tool = createIssue(tracker, ticketDomain);
    await tool.handler({ ...baseInput } as any);

    // Gợi ý của bot nhắc mã ticket đồng nghiệp và suy luận nguyên nhân. Nếu thiếu
    // dấu `<!-- intake-bot -->` thì kg-sync học nó thành humanNotes và đẩy vào KG
    // (human-signals.ts), còn duplicate-merger có thể tự huỷ ticket trùng.
    expect(comments[0].body).toContain("<!-- intake-bot -->");
  });

  test("bản xem trước hiện đúng lời sẽ ghi vào mô tả (ADR-0008)", async () => {
    const tool = createIssue(tracker, ticketDomain);
    const res = (await tool.handler({ ...baseInput, userConfirmed: false } as any)) as any;

    expect(res.created).toBe(false);
    expect(res.needsConfirmation).toBe(true);
    // Người báo phải thấy lời của chính mình trước khi bấm xác nhận.
    expect(res.message).toContain("con bé Nguyễn Văn Anh D không thấy bài kiểm tra ạ");
    // Bản viết lại của model không được hiện như lời người báo.
    expect(res.message).not.toContain("Cần đối chiếu dữ liệu lịch học");
    // Chưa ghi gì cả.
    expect(created).toHaveLength(0);
  });

  test("khi model không đưa rawText, bản xem trước nói rõ đó là lời tóm tắt", async () => {
    const tool = createIssue(tracker, ticketDomain);
    const res = (await tool.handler({ ...baseInput, rawText: undefined, userConfirmed: false } as any)) as any;

    expect(res.message).toContain("Em tự tóm lại phần này");
  });

  test("lời người gõ có Markdown không làm vỡ bản xem trước", async () => {
    const tool = createIssue(tracker, ticketDomain);
    const nasty = "lỗi *đậm* _nghiêng_ `code` [link](x) # heading | pipe";
    const res = (await tool.handler({ ...baseInput, rawText: nasty, userConfirmed: false } as any)) as any;

    // Ký tự Markdown phải được escape, không nằm nguyên trong tin Telegram.
    expect(res.message).toContain("\\*đậm\\*");
    expect(res.message).not.toMatch(/(^|\n)\s*\*đậm\*/);
  });

  test("hỏng khi ghi comment thì ticket vẫn được tạo (best-effort)", async () => {
    const m = mock(async (input: any, init?: any) => {
      const url = String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url.endsWith("/projects/TECH")) {
        return json({
          id: 1, key: "TECH", name: "Tech",
          columns: [{ id: 10, name: "Backlog", stateType: "backlog" }],
          issueTypes: [], labels: [], customFields: [],
        });
      }
      if (url.endsWith("/projects/TECH/issues") && init?.method === "POST") {
        const body = JSON.parse(init.body);
        created.push(body);
        return json({ id: 963, identifier: "TECH-1084", title: body.title, columnId: 10, sequenceNumber: 1084 }, 201);
      }
      if (/\/issues\/\d+\/comments$/.test(url)) {
        return json({ error: "db unavailable" }, 500);
      }
      return json({ error: "Not found" }, 404);
    });
    globalThis.fetch = m as any;

    const tool = createIssue(tracker, ticketDomain);
    const res = (await tool.handler({ ...baseInput } as any)) as any;

    // Ghi gợi ý hỏng KHÔNG được làm hỏng cả ticket — nếu không, một lỗi comment
    // im lặng sẽ khiến người báo mất trọn sự cố.
    expect(res.created).toBe(true);
    expect(res.issue.identifier).toBe("TECH-1084");
    expect(created).toHaveLength(1);
  });

  test("không tạo comment rác khi không có diagnosis", async () => {
    const tool = createIssue(tracker, ticketDomain);
    await tool.handler({ ...baseInput, diagnosis: undefined } as any);

    expect(created).toHaveLength(1);
    expect(comments).toHaveLength(0);
  });
});
