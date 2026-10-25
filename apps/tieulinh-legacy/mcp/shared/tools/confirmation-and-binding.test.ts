import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";
import { createIssue, type IssueDomain } from "./create-issue";
import { checkIdentity } from "./identity";
import { checkRequiredFields } from "./check-required-fields";
import { getIssue, updateIssue } from "./issues";
import { escalateIssue } from "./escalate-issue";
import { getSharedBindingRepo } from "../../../lib/storage/binding-repository";
import { getSharedDraftSessionRepo } from "../../../lib/storage/session-repository";
import { Database } from "bun:sqlite";
import { applySchema } from "../../../lib/storage/schema";
import { IdentityRepository } from "../../../lib/storage/identity-repository";
import { fixtureCatalog } from "../../../lib/gate/catalog.fixture";
import { getBranchButtons, clearPendingButtons } from "../../../lib/telegram/buttons";

describe("Confirmation Step, Binding & Latest Ticket Context", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;
  let testDbPath: string;
  let attachmentUploadCount: number;
  let lastCreatedIssuePayload: any = null;
  let customFieldUpdates: Array<{ fieldId: number; value: any }> = [];

  const dummyDomain: IssueDomain<any> = {
    description: "Tạo ticket sự cố",
    inputShape: {
      title: z.string(),
      description: z.string(),
      // `optional`, không `.default()` — giống hai domain thật. Xem test
      // "không domain nào khai `.default()`" trong iris/tieulinh domain.test.ts.
      priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
      reporterName: z.string(),
      reporterUsername: z.string().optional(),
      reporterChatId: z.string().optional(),
      telegramUserId: z.string().optional(),
    },
    build: (input: any) => ({
      title: String(input.title),
      description: String(input.description),
      priority: input.priority ?? "medium",
      confirmation: "Đã ghi nhận ticket {identifier} tại {url}",
    }),
  };

  /**
   * Gọi tool đúng như MCP SDK gọi: tham số đi qua `z.object(inputSchema).parse`
   * TRƯỚC khi vào handler.
   *
   * Gọi thẳng `tool.handler` bỏ mất đúng bước sinh ra lỗi PO-79 — zod chèn mọi
   * `.default()` vào input kể cả khi model không gửi, và chính giá trị mặc định
   * đó đè lên bản nháp ở lượt xác nhận.
   */
  async function callTool(tool: { inputSchema: any; handler: (input: any) => any }, input: any) {
    return await tool.handler(z.object(tool.inputSchema).parse(input) as any);
  }

  const trackerConfig = {
    baseUrl: "https://mock.itsaplan.test",
    apiKey: "test-api-key",
    projectKey: "TECH",
    webUrl: "https://itsaplan.test",
  };

  beforeEach(() => {
    attachmentUploadCount = 0;
    lastCreatedIssuePayload = null;
    customFieldUpdates = [];
    testDbPath = `/tmp/test-intake-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    // Khởi tạo DB test
    const db = new Database(testDbPath, { create: true });
    applySchema(db);
    const idRepo = new IdentityRepository(db);
    idRepo.saveUserIdentity({
      telegramUserId: "tele_999",
      nameCode: "CS_lananh",
      fullName: "Lê Thị N",
      username: "user_cs_a",
      status: "approved",
    });
    db.close();

    mockFetch = mock(async (input: any, init?: any) => {
      const url = String(input);
      if (url.endsWith("/projects/TECH")) {
        return new Response(
          JSON.stringify({
            id: 1,
            key: "TECH",
            name: "Tech Support",
            columns: [{ id: 10, name: "Backlog", stateType: "backlog" }],
            issueTypes: [{ id: 1, name: "Task", isDefault: true }],
            labels: [{ id: 55, name: "Feature request" }],
            customFields: [
              { id: 101, name: "Causes", fieldType: "markdown" },
              { id: 102, name: "Solutions", fieldType: "markdown" },
              { id: 103, name: "Related Tickets", fieldType: "markdown" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/fields/") && init?.method === "PUT") {
        const match = url.match(/\/fields\/(\d+)/);
        const fieldId = match ? Number(match[1]) : 0;
        const body = init?.body ? JSON.parse(init.body) : {};
        customFieldUpdates.push({ fieldId, value: body.value });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/projects/TECH/issues") && init?.method === "POST") {
        const body = JSON.parse(init.body);
        lastCreatedIssuePayload = body;
        return new Response(
          JSON.stringify({
            id: 888,
            identifier: "TECH-888",
            title: body.title,
            columnId: 10,
            priority: body.priority,
            typeId: body.typeId,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/projects/TECH/issues/888") || url.endsWith("/issues/888")) {
        return new Response(
          JSON.stringify({
            id: 888,
            identifier: "TECH-888",
            title: "Lỗi thanh toán",
            priority: "medium",
            columnId: 10,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/issues/888/timeline")) {
        return new Response(
          JSON.stringify([{ kind: "comment", author: "IT Support", body: "Đang kiểm tra log" }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/issues/888/comments") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: 12, issueId: 888, body: "Comment added" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/issues/888") && init?.method === "PATCH") {
        return new Response(
          JSON.stringify({ id: 888, identifier: "TECH-888", priority: "urgent" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/issues/888/attachments") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            id: `att-${attachmentUploadCount++}`,
            url: "/attachments/fake/raw",
            filename: "fake.jpg",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    });
    globalThis.fetch = mockFetch as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    } catch {}
  });

  test("create_issue: bước xác nhận userConfirmed = false không tạo ticket và yêu cầu xác nhận", async () => {
    const tool = createIssue(trackerConfig, dummyDomain, testDbPath);
    const res = (await tool.handler({
      title: "Lỗi thanh toán học phí",
      description: "Phụ huynh chuyển khoản nhưng app chưa kích hoạt",
      priority: "high",
      reporterName: "Lê Thị N",
      reporterChatId: "tele_999",
      userConfirmed: false,
    })) as any;

    expect(res.created).toBe(false);
    expect(res.needsConfirmation).toBe(true);
    expect(res.draft.title).toBe("Lỗi thanh toán học phí");
    expect(res.draft.priority).toBe("high");
    expect(res.message).toContain("tóm tắt lại sự cố");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("create_issue: bước userConfirmed = true tạo ticket trên Itsaplan và lưu binding vào SQLite", async () => {
    const tool = createIssue(trackerConfig, dummyDomain, testDbPath);
    const res = (await tool.handler({
      title: "Lỗi thanh toán học phí",
      description: "Phụ huynh chuyển khoản nhưng app chưa kích hoạt",
      priority: "high",
      reporterName: "Lê Thị N",
      reporterChatId: "tele_999",
      reporterUsername: "user_cs_a",
      userConfirmed: true,
    })) as any;

    expect(res.created).toBe(true);
    expect(res.issue.identifier).toBe("TECH-888");

    // Kiểm tra binding đã được ghi vào SQLite
    const repo = getSharedBindingRepo(testDbPath);
    const binding = repo.getBindingByIssueId(888);
    expect(binding).not.toBeNull();
    expect(binding?.chatId).toBe("tele_999");
    expect(binding?.identifier).toBe("TECH-888");
  });

  test("create_issue: bước userConfirmed = true tự động khôi phục từ bản nháp SQLite nếu input chỉ có userConfirmed", async () => {
    const tool = createIssue(trackerConfig, dummyDomain, testDbPath);
    // Bước 1: userConfirmed = false lưu draft
    await tool.handler({
      title: "Lỗi thanh toán học phí",
      description: "Phụ huynh chuyển khoản nhưng app chưa kích hoạt",
      priority: "high",
      reporterName: "Lê Thị N",
      reporterChatId: "tele_999",
      reporterUsername: "user_cs_a",
      userConfirmed: false,
    });

    // Bước 2: Người dùng bấm nút xác nhận -> model chỉ truyền userConfirmed: true và reporterChatId
    const res = (await tool.handler({
      reporterChatId: "tele_999",
      userConfirmed: true,
    })) as any;

    expect(res.created).toBe(true);
    expect(res.issue.title).toBe("Lỗi thanh toán học phí");
    expect(res.issue.identifier).toBe("TECH-888");

    // Bản nháp phải được dọn sau khi tạo thành công
    const draftRepo = getSharedDraftSessionRepo(testDbPath);
    expect(draftRepo.getDraft("tele_999")).toBeNull();
  });

  /**
   * Telegram vẫn gửi callback cho nút cũ kể cả sau khi đã khoá bàn phím, và cú
   * khoá nút của plugin có lúc hỏng thật (`message is not modified`). Bấm lần
   * hai mà không chặn thì bản nháp đã bị xoá ở lượt trước, `build` nhận input
   * rỗng, và ra một ticket trắng gửi lên Product team.
   */
  test("create_issue: bấm nút xác nhận lần hai không tạo thêm ticket", async () => {
    const tool = createIssue(trackerConfig, dummyDomain, testDbPath);
    await tool.handler({
      title: "Lỗi trùng tài khoản học",
      description: "Tạo đơn bị chặn vì trùng tài khoản",
      priority: "high",
      reporterName: "Khách C",
      reporterChatId: "tele_777",
      userConfirmed: false,
    });

    const first = (await tool.handler({ reporterChatId: "tele_777", userConfirmed: true })) as any;
    expect(first.created).toBe(true);

    const second = (await tool.handler({ reporterChatId: "tele_777", userConfirmed: true })) as any;
    expect(second.created).toBe(false);
    expect(second.alreadyCreated).toBe(true);
    expect(second.issue.identifier).toBe(first.issue.identifier);
    expect(second.message).toContain(first.issue.identifier);
  });

  // TECH-637 (đo thật 15/09/2026): ticket chỉ có 1/nhiều ảnh dù người dùng gửi
  // cả loạt. `effectiveInput = { ...draftState, ...input }` ở lượt xác nhận đè
  // NÔNG lên `mediaPaths` — nếu model nhắc lại lượt xác nhận chỉ kèm 1 đường
  // dẫn (không nhớ hết mảng đã gom ở Bước 1), các ảnh còn lại trong draft bị rớt.
  test("create_issue: mediaPaths ở lượt xác nhận được gộp với bản nháp, không bị đè mất ảnh", async () => {
    const tool = createIssue(trackerConfig, dummyDomain, testDbPath);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tech637-"));
    const anh1 = path.join(dir, "anh1.jpg");
    const anh2 = path.join(dir, "anh2.jpg");
    fs.writeFileSync(anh1, "a");
    fs.writeFileSync(anh2, "b");

    // Bước 1: gom đủ 2 ảnh vào draft
    await tool.handler({
      title: "Không đối soát được đơn hàng",
      description: "Đơn lên từ trưa qua nhưng không đối soát được",
      priority: "high",
      reporterName: "Khách B",
      reporterChatId: "tele_637",
      mediaPaths: [anh1, anh2],
      userConfirmed: false,
    });

    // Bước 2: model gọi lại lúc xác nhận, chỉ nhớ đúng 1 đường dẫn (bug quan sát được)
    const res = (await tool.handler({
      reporterChatId: "tele_637",
      mediaPaths: [anh1],
      userConfirmed: true,
    })) as any;

    expect(res.created).toBe(true);
    expect(attachmentUploadCount).toBe(2);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * PO-79 (đo thật 16/09/2026): bước tóm tắt gửi đủ tiêu đề, vấn đề, phòng ban,
   * nhãn `Feature request`, priority `high`; bước xác nhận model gọi lại với
   * đúng bộ khoá đó nhưng giá trị RỖNG hết. Gộp nông cho chuỗi rỗng đè lên bản
   * nháp và ticket ra Itsaplan trắng trơn — tiêu đề rơi về "Order tính năng
   * chưa có tiêu đề", mô tả chỉ còn tên người đóng góp.
   */
  test("create_issue: giá trị rỗng ở lượt xác nhận không được đè lên bản nháp", async () => {
    const tool = createIssue(trackerConfig, dummyDomain, testDbPath);

    await callTool(tool, {
      title: "Cải thiện tỷ lệ hoàn thành bài tập của học sinh tiểu học",
      description: "Bài tập dài và nhàm chán khiến học sinh bỏ cuộc giữa chừng",
      priority: "high",
      reporterName: "Trần Thị M",
      reporterChatId: "tele_po79",
      labels: ["Feature request"],
      userConfirmed: false,
    });

    const res = (await callTool(tool, {
      title: "",
      description: "",
      labels: [],
      reporterName: "Trần Thị M",
      reporterChatId: "tele_po79",
      userConfirmed: true,
    })) as any;

    expect(res.created).toBe(true);
    expect(lastCreatedIssuePayload.title).toBe(
      "Cải thiện tỷ lệ hoàn thành bài tập của học sinh tiểu học",
    );
    expect(lastCreatedIssuePayload.description).toBe(
      "Bài tập dài và nhàm chán khiến học sinh bỏ cuộc giữa chừng",
    );
    expect(lastCreatedIssuePayload.priority).toBe("high");
    // Nhãn cũng là nạn nhân: draft có ["Feature request"], lượt xác nhận gửi [].
    expect(lastCreatedIssuePayload.labelIds).toEqual([55]);
  });

  /**
   * Cùng gốc với PO-79: `.default()` của zod được chèn vào `input` kể cả khi
   * model không gửi, nên `priority: "medium"` mặc định đè mất `high` của bản
   * nháp. Domain nào còn `.default()` thì lỗi này quay lại y nguyên.
   */
  test("create_issue: mức ưu tiên của bản nháp không bị mặc định của lượt xác nhận đè", async () => {
    const tool = createIssue(trackerConfig, dummyDomain, testDbPath);

    await callTool(tool, {
      title: "Server thanh toán trả 502",
      description: "Toàn bộ giao dịch đang lỗi",
      priority: "urgent",
      reporterName: "Khách B",
      reporterChatId: "tele_prio",
      userConfirmed: false,
    });

    // Model chỉ gửi cờ xác nhận; zod tự chèn `priority: "medium"` vào input.
    await callTool(tool, {
      title: "Server thanh toán trả 502",
      description: "Toàn bộ giao dịch đang lỗi",
      reporterName: "Khách B",
      reporterChatId: "tele_prio",
      userConfirmed: true,
    });

    expect(lastCreatedIssuePayload.priority).toBe("urgent");
  });

  /**
   * Không bản nháp, không nội dung, không bản ghi cũ để trả về: dựng tiếp thì
   * một ticket trắng lên tracker. Thà xin lại thông tin.
   */
  test("create_issue: xác nhận trần mà mất sạch ngữ cảnh thì xin lại, không tạo ticket trắng", async () => {
    const tool = createIssue(trackerConfig, dummyDomain, testDbPath);

    const res = (await tool.handler({
      reporterName: "Khách B",
      reporterChatId: "tele_trong",
      title: "",
      description: "",
      userConfirmed: true,
    })) as any;

    expect(res.created).toBe(false);
    expect(lastCreatedIssuePayload).toBeNull();
  });

  // PO-88 (thật, 24/09): tin "callback_data: confirm_done:…" rơi vào LLM của Iris, model gọi
  // create_issue({userConfirmed:true, reporterName:"User"}) KHÔNG kèm chatId → lưới chặn ticket
  // trắng nằm trong nhánh `if (targetChatId)` nên bị bỏ qua, ra "Order tính năng chưa có tiêu đề".
  test("create_issue: xác nhận trần KHÔNG có chatId cũng không được tạo ticket trắng", async () => {
    const tool = createIssue(trackerConfig, dummyDomain, testDbPath);
    const res = (await tool.handler({ userConfirmed: true, reporterName: "User" })) as any;
    expect(res.created).toBe(false);
    expect(lastCreatedIssuePayload).toBeNull();
  });

  test("create_issue: tự động gắn typeId; mã ticket tương tự do model tự đưa KHÔNG được ghi (ADR-0007)", async () => {
    const tool = createIssue(trackerConfig, dummyDomain, testDbPath);

    const res = (await tool.handler({
      title: "Học sinh không vào được phòng học",
      description: "App báo lỗi mạng dù wifi bình thường",
      relatedTickets: "TECH-500, TECH-501",
      reporterName: "Khách C",
      reporterChatId: "tele_custom_fields",
      userConfirmed: true,
    })) as any;

    expect(res.created).toBe(true);
    expect(lastCreatedIssuePayload).not.toBeNull();
    // typeId phải được gán từ defaultType (Task id = 1)
    expect(lastCreatedIssuePayload.typeId).toBe(1);

    // Model tự đưa mã → không ghi Related Tickets, không link.
    expect(customFieldUpdates).toEqual([]);
  });

  test("check_identity: trả về latestTicket khi người dùng đã có ticket trong SQLite", async () => {
    // Bước 1: Lưu ticket
    const repo = getSharedBindingRepo(testDbPath);
    repo.saveBinding({
      issueId: 888,
      channelType: "telegram",
      chatId: "tele_999",
      messageId: "0",
      identifier: "TECH-888",
      title: "Lỗi thanh toán học phí",
      reporterUsername: "user_cs_a",
    });

    const identityTool = checkIdentity({ dbPath: testDbPath });
    const result = (await identityTool.handler({
      telegramUserId: "tele_999",
    })) as any;

    expect(result.isApproved).toBe(true);
    expect(result.latestTicket).not.toBeNull();
    expect(result.latestTicket?.identifier).toBe("TECH-888");
    expect(result.latestTicket?.title).toBe("Lỗi thanh toán học phí");
    expect(result.latestTicket?.needsConfirmation).toBe(true);
    expect(result.pendingDraft).toBeNull();
  });

  test("check_identity: không trả về latestTicket khi ticket đã cũ hơn 30 phút", async () => {
    const repo = getSharedBindingRepo(testDbPath);
    repo.saveBinding({
      issueId: 889,
      channelType: "telegram",
      chatId: "tele_stale",
      messageId: "0",
      identifier: "TECH-889",
    });
    const staleTimestamp = new Date(Date.now() - 45 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    const raw = (repo as any).db as Database;
    raw
      .prepare(`UPDATE ticket_bindings SET updated_at = ? WHERE issue_id = ?`)
      .run(staleTimestamp, 889);

    const identityTool = checkIdentity({ dbPath: testDbPath });
    const result = (await identityTool.handler({
      telegramUserId: "tele_stale",
    })) as any;

    expect(result.latestTicket).toBeNull();
  });

  test("check_identity: trả về pendingDraft khi có bản nháp ticket đang gom dở", async () => {
    const draftRepo = getSharedDraftSessionRepo(testDbPath);
    draftRepo.saveDraft("tele_draft", { title: "Lỗi đăng nhập app", product: "Duo" });

    const identityTool = checkIdentity({ dbPath: testDbPath });
    const result = (await identityTool.handler({
      telegramUserId: "tele_draft",
    })) as any;

    expect(result.pendingDraft).not.toBeNull();
    expect(result.pendingDraft?.state?.title).toBe("Lỗi đăng nhập app");
  });

  test("get_issue: tự động tra cứu ticket gần nhất khi không truyền identifier", async () => {
    const repo = getSharedBindingRepo(testDbPath);
    repo.saveBinding({
      issueId: 888,
      channelType: "telegram",
      chatId: "tele_999",
      messageId: "0",
      identifier: "TECH-888",
      title: "Lỗi thanh toán học phí",
    });

    const getTool = getIssue(trackerConfig, testDbPath);
    const res = (await getTool.handler({
      chatId: "tele_999",
    })) as any;

    expect(res.found).toBe(true);
    expect(res.identifier).toBe("TECH-888");
    expect(res.comments).toHaveLength(1);
    expect(res.status).toBeDefined();
    expect(res.status.name).toBe("Mới tiếp nhận");
    expect(res.humanSummary).toContain("TECH-888");
  });

  test("update_issue: bắt buộc identifier, không còn tự đoán ticket gần nhất", async () => {
    const updateTool = updateIssue(trackerConfig, testDbPath);
    expect((updateTool.inputSchema.identifier as any).safeParse(undefined).success).toBe(false);

    const res = (await updateTool.handler({
      identifier: "TECH-888",
      note: "Phụ huynh gửi biên lai qua Zalo",
    })) as any;

    expect(res.updated).toBe(true);
    expect(res.identifier).toBe("TECH-888");
  });

  test("update_issue: báo updated=false khi cả ghi mô tả lẫn comment đều lỗi, không được báo thành công giả", async () => {
    globalThis.fetch = mock(async (input: any, init?: any) => {
      const url = String(input);
      if (url.endsWith("/issues/888") && (!init || !init.method)) {
        return new Response(
          JSON.stringify({
            id: 888,
            identifier: "TECH-888",
            title: "Lỗi thanh toán",
            priority: "medium",
            columnId: 10,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/issues/888") && init?.method === "PATCH") {
        return new Response(JSON.stringify({ error: "db unavailable" }), { status: 500 });
      }
      if (url.endsWith("/issues/888/comments") && init?.method === "POST") {
        return new Response(JSON.stringify({ error: "db unavailable" }), { status: 500 });
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }) as any;

    const updateTool = updateIssue(trackerConfig, testDbPath);
    const res = (await updateTool.handler({
      identifier: "TECH-888",
      note: "Mã KH: 0900000019",
    })) as any;

    expect(res.updated).toBe(false);
    expect(res.reason).toBe("write_failed");
    expect(res.identifier).toBe("TECH-888");
  });

  test("escalate_issue: bắt buộc identifier, không còn tự đoán ticket gần nhất", async () => {
    const escalateTool = escalateIssue(trackerConfig, {
      noun: "ticket",
      acknowledgement: "Đã nâng mức ưu tiên {identifier}",
      alertTemplate: "Cảnh báo khẩn {identifier}",
    });
    expect((escalateTool.inputSchema.identifier as any).safeParse(undefined).success).toBe(false);

    const res = (await escalateTool.handler({
      identifier: "TECH-888",
      reporterName: "Lê Thị N",
      reason: "Học sinh đang chờ vào lớp",
    })) as any;

    expect(res.escalated).toBe(true);
    expect(res.identifier).toBe("TECH-888");
    expect(res.message).toContain("TECH-888");
  });

  test("checkIdentity: lưu initialButtons vào file nút tạm khi user được duyệt và chưa có draft", async () => {
    const testChatId = "777888999";
    clearPendingButtons(testChatId);

    const identityTool = checkIdentity({
      dbPath: testDbPath,
      requireApproval: false,
      initialButtons: getBranchButtons,
    });

    const res = (await identityTool.handler({
      telegramUserId: testChatId,
    })) as any;

    expect(res.isApproved).toBe(true);

    const buttonFile = path.join(os.homedir(), ".vhbot", "iris-nut-bam", `${testChatId}.json`);
    expect(fs.existsSync(buttonFile)).toBe(true);
    const content = JSON.parse(fs.readFileSync(buttonFile, "utf-8"));
    expect(content.buttons).toEqual(getBranchButtons());

    clearPendingButtons(testChatId);
  });

  test("checkRequiredFields: tự động lưu branch buttons và nhắc chọn nhánh khi thiếu variant", async () => {
    const testChatId = "555666777";
    clearPendingButtons(testChatId);

    const fieldsTool = checkRequiredFields(fixtureCatalog);
    const res = (await fieldsTool.handler({
      reporterChatId: testChatId,
    })) as any;

    expect(res.isComplete).toBe(false);
    expect(res.fieldsToAsk).toEqual(["variant"]);
    expect(res.nextQuestion).toContain("chọn nhánh bên dưới");

    const buttonFile = path.join(os.homedir(), ".vhbot", "iris-nut-bam", `${testChatId}.json`);
    expect(fs.existsSync(buttonFile)).toBe(true);
    const content = JSON.parse(fs.readFileSync(buttonFile, "utf-8"));
    expect(content.buttons).toEqual(getBranchButtons());

    clearPendingButtons(testChatId);
  });

  /**
   * Người dùng báo 14/09/2026: IRIS in cả danh sách lựa chọn bằng chữ ngay bên
   * cạnh hàng nút. Plugin `iris-tuong-tac` có dọn `(chọn một: …)` nhưng không
   * biết dạng `(có thể chọn một hoặc nhiều: …)` sinh sau nó — nên chỗ quyết
   * định phải nằm ở đây, nơi biết chắc đã đính nút hay chưa.
   */
  test("checkRequiredFields: đã đính nút thì thôi liệt kê lựa chọn trong câu hỏi", async () => {
    const testChatId = "555666778";
    clearPendingButtons(testChatId);

    const fieldsTool = checkRequiredFields(fixtureCatalog);
    const res = (await fieldsTool.handler({
      variant: "1",
      captured: { van_de: "Đơn hàng bị trùng" },
      reporterChatId: testChatId,
    })) as any;

    expect(res.fieldsToAsk[0]).toBe("phong_ban");
    expect(res.nextQuestion).not.toContain("chọn một");
    expect(res.nextQuestion).not.toContain("·");

    const buttonFile = path.join(os.homedir(), ".vhbot", "iris-nut-bam", `${testChatId}.json`);
    expect(JSON.parse(fs.readFileSync(buttonFile, "utf-8")).buttons.flat().length).toBe(3);

    clearPendingButtons(testChatId);
  });

  test("checkRequiredFields: nhớ phòng ban vào sqlite, phiên sau thôi hỏi lại", async () => {
    const testChatId = "555666779";
    const memory = { dbPath: testDbPath, field: "phong_ban" };
    new IdentityRepository(new Database(testDbPath)).saveUserIdentity({
      telegramUserId: testChatId,
      nameCode: "CS_test",
      status: "approved",
    });

    const first = (await checkRequiredFields(fixtureCatalog, memory).handler({
      variant: "1",
      captured: { van_de: "Đơn hàng bị trùng", phong_ban: "bên CS" },
      telegramUserId: testChatId,
    })) as any;
    expect(first.fieldsToAsk).not.toContain("phong_ban");

    // Phiên sau không gửi `phong_ban` nữa: giá trị phải tự quay lại, và quay
    // lại dưới dạng CHUẨN ("CS") chứ không phải nguyên văn người gõ ("bên CS").
    const second = (await checkRequiredFields(fixtureCatalog, memory).handler({
      variant: "1",
      captured: { van_de: "Đơn hàng bị trùng" },
      telegramUserId: testChatId,
    })) as any;
    expect(second.effectiveValues.phong_ban).toBe("CS");
    expect(second.fieldsToAsk).not.toContain("phong_ban");

    clearPendingButtons(testChatId);
  });

  test("checkRequiredFields: không khai bộ nhớ thì giữ nguyên hành vi cũ — vẫn hỏi lại", async () => {
    const testChatId = "555666780";
    const res = (await checkRequiredFields(fixtureCatalog).handler({
      variant: "1",
      captured: { van_de: "Đơn hàng bị trùng" },
      telegramUserId: testChatId,
    })) as any;
    expect(res.fieldsToAsk).toContain("phong_ban");
    clearPendingButtons(testChatId);
  });
});
