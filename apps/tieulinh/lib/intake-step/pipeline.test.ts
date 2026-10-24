import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../storage/schema";
import { IntakeDocumentRepository } from "../intake-document/repository";
import { FieldExtractor } from "./extractor";
import { IntakeStepPipeline } from "./pipeline";
import type { ItsaplanClient, ItsaplanIssue } from "../itsaplan/client";
import validationRules from "../../mcp/tieulinh/domain/validation-rules.json";
import fieldRequirements from "../../mcp/tieulinh/domain/required_fields.json";
import productMapping from "../../mcp/tieulinh/domain/product_mapping.json";
import urgencyRules from "../../mcp/tieulinh/domain/urgency-rules.json";

describe("IntakeStepPipeline", () => {
  let db: Database;
  let repo: IntakeDocumentRepository;
  let pipeline: IntakeStepPipeline;

  /** Ghi lại mọi thao tác Related Tickets/links để test chặn ghi rẻ tiền. */
  function makeItsaplan() {
    const calls = {
      setCustomFieldValue: [] as Array<{ issueId: number; fieldId: number; value: string }>,
      addLink: [] as Array<{ issueId: number; targetId: number; type: string }>,
      updateIssue: [] as Array<{ issueId: number; patch: any }>,
      addComment: [] as Array<{ issueId: number; body: string }>,
    };
    const client: Partial<ItsaplanClient> = {
      listProjectColumns: async () => [{ id: 1, name: "Todo", stateType: "unstarted", position: 1 }],
      listCustomFields: async () => [{ id: 42, name: "Related Tickets", fieldType: "markdown" }],
      setCustomFieldValue: async (issueId, fieldId, value) => {
        calls.setCustomFieldValue.push({ issueId, fieldId, value: String(value) });
        return {} as any;
      },
      getIssueByNumber: async (_pk, seq) => ({ id: 9000 + seq, identifier: `TECH-${seq}` }) as any,
      addLink: async (issueId, targetId, type = "relates") => {
        calls.addLink.push({ issueId, targetId, type });
        return { id: 1 } as any;
      },
      updateIssue: async (issueId, patch) => {
        calls.updateIssue.push({ issueId, patch });
        return {} as any;
      },
      // Gợi ý KG đi ra comment riêng, không viết vào mô tả (TECH-1084).
      addComment: async (issueId, body) => {
        calls.addComment.push({ issueId, body });
        return { id: calls.addComment.length, body };
      },
      createIssue: async (projectKey, payload) =>
        ({
          id: 789,
          identifier: "TECHTEST-789",
          title: payload.title,
          sequenceNumber: 789,
        }) as ItsaplanIssue,
    };
    return { client: client as ItsaplanClient, calls };
  }
  let it$: ReturnType<typeof makeItsaplan>;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    repo = new IntakeDocumentRepository(db);

    it$ = makeItsaplan();

    pipeline = new IntakeStepPipeline({
      minConfirmDelayMs: 0, // test gọi liền mạch, không có độ trễ người thật
      repo,
      extractor: new FieldExtractor(), // Heuristic extractor
      itsaplan: it$.client,
      projectKey: "TECHTEST",
      validationRules: validationRules as any,
      fieldRequirements: fieldRequirements as any,
      productMapping: productMapping as any,
      urgencyRules: urgencyRules as any,
      // Không ghi file nút thật vào ~/.vhbot trong test
      buttons: { save: () => {}, clear: () => {} },
    });
  });

  it("Turn 1: Thiếu reporting_dept -> Action ask_missing_field", async () => {
    const res = await pipeline.run({
      chatId: "chat_step_1",
      message: "CRM bị lỗi đơn hàng không mở được SĐT 0900000005",
    });

    expect(res.action).toBe("ask_missing_field");
    expect(res.missingFields).toContain("reporting_dept");
    expect(res.status).toBe("collecting");
    expect(res.document.fields.studentAccount?.value).toBe("0900000005");
  });

  it("Turn 2: Điền đủ thông tin -> confirm_summary, Turn 3: Xác nhận -> ticket_created", async () => {
    // Turn 1: Báo sự cố có đủ sản phẩm, hệ thống, SĐT học sinh
    await pipeline.run({
      chatId: "chat_step_2",
      message: "Lỗi app Duo hệ thống Vuihoc học sinh 0900000005 không làm bài được",
    });

    // Turn 2: Cung cấp phòng ban
    const res2 = await pipeline.run({
      chatId: "chat_step_2",
      message: "Em bên Vận hành nhé",
    });

    expect(res2.action).toBe("confirm_summary");
    expect(res2.status).toBe("ready_for_confirmation");
    expect(res2.document.fields.reportingDept?.value).toBe("Vận hành");

    // Turn 3: Người dùng xác nhận
    const res3 = await pipeline.run({
      chatId: "chat_step_2",
      message: "Chuẩn rồi em tạo đi",
    });

    expect(res3.action).toBe("ticket_created");
    expect(res3.status).toBe("created");
    expect(res3.issue?.identifier).toBe("TECHTEST-789");
  });

  it("ticket_created: gợi ý chưa xác thực (verifiedOnTracker=false) KHÔNG được ghi vào Related Tickets", async () => {
    // Bài học tech lead: bot ghi thẳng mọi gợi ý Onyx (đúng ~40%) vào field —
    // ~59% bị người gỡ. Ghi field chỉ dành cho gợi ý đã xác thực tồn tại;
    // gợi ý chỉ nằm trong tóm tắt cho người dùng xem, không đụng ticket.
    const searchClient = {
      searchSimilar: async () => [
        {
          identifier: "TECH-123",
          title: "Gợi ý chưa xác thực",
          verifiedOnTracker: false,
        },
      ],
    };
    const p2 = new IntakeStepPipeline({
      ...(pipeline as any).options,
      searchClient: searchClient as any,
    });

    await p2.run({ chatId: "chat_related_1", message: "Lỗi app Duo hệ thống Vuihoc học sinh 0900000005 không làm bài được" });
    await p2.run({ chatId: "chat_related_1", message: "Em bên Vận hành nhé" });
    await p2.run({ chatId: "chat_related_1", message: "Chuẩn rồi em tạo đi" });

    expect(it$.calls.setCustomFieldValue).toHaveLength(0);
    expect(it$.calls.addLink).toHaveLength(0);
  });

  it("ticket_created: kết quả Onyx dù đã xác thực tồn tại cũng KHÔNG được ghi (chỉ là tìm theo chữ)", async () => {
    // TECH-920 (26/09): 8 mã Onyx "đã xác thực" vì trùng chữ "không tạo được đơn"
    // nhưng khác nguyên nhân hẳn — đều bị ghi vào ticket.
    const searchClient = {
      searchSimilar: async () => [
        { identifier: "TECH-456", title: "Tồn tại nhưng khác nguyên nhân", verifiedOnTracker: true, source: "onyx", score: 10 },
      ],
    };
    const p2 = new IntakeStepPipeline({ ...(pipeline as any).options, searchClient: searchClient as any });

    await p2.run({ chatId: "chat_related_2", message: "Lỗi app Duo hệ thống Vuihoc học sinh 0900000005 không làm bài được" });
    await p2.run({ chatId: "chat_related_2", message: "Em bên Vận hành nhé" });
    await p2.run({ chatId: "chat_related_2", message: "Chuẩn rồi em tạo đi" });

    expect(it$.calls.setCustomFieldValue).toHaveLength(0);
    expect(it$.calls.addLink).toHaveLength(0);
  });

  // ADR-0007: ghi ĐỦ cụm cùng nguyên nhân người đã xác định, kèm gợi ý người viết.
  const clusterSource = (members: Array<{ identifier: string; humanCause?: string; humanFix?: string }>) => {
    const calls: Array<{ text: string; excludeIds?: string[] }> = [];
    return {
      calls,
      find: async (text: string, opts?: { excludeIds?: string[] }) => {
        calls.push({ text, excludeIds: opts?.excludeIds });
        return members.length
          ? {
              clusterId: members[0].identifier,
              share: 0.8,
              members: members.map((m) => ({ title: `Ticket ${m.identifier}`, ...m })),
              advice: members[0].humanCause
                ? { cause: members[0].humanCause!, fix: members[0].humanFix!, from: members[0].identifier }
                : undefined,
            }
          : null;
      },
    };
  };

  it("ticket_created: cụm nguyên nhân từ KG được ghi đủ vào Related Tickets + link, gợi ý là chữ người viết (chạy NỀN sau khi tạo)", async () => {
    const source = clusterSource([
      { identifier: "TECH-769", humanCause: "Bị gắn trùng tk học do cùng tên", humanFix: "Gỡ tk học 1 con bị trùng & thêm chữ BỎ" },
      { identifier: "TECH-775" },
      { identifier: "TECH-909" },
    ]);
    const p2 = new IntakeStepPipeline({ ...(pipeline as any).options, similarTickets: source as any });

    await p2.run({ chatId: "chat_kg_1", message: "Lỗi app Duo hệ thống Vuihoc học sinh 0900000005 không làm bài được" });
    await p2.run({ chatId: "chat_kg_1", message: "Em bên Vận hành nhé" });
    // Chưa tạo ticket -> chưa tra KG (kiến trúc mới chạy nền SAU khi tạo).
    expect(source.calls).toHaveLength(0);

    await p2.run({ chatId: "chat_kg_1", message: "Chuẩn rồi em tạo đi" });
    await p2.flushBackgroundForTests();

    expect(it$.calls.setCustomFieldValue).toHaveLength(1);
    expect(it$.calls.setCustomFieldValue[0].value).toBe("TECH-769, TECH-775, TECH-909");
    expect(it$.calls.addLink.map((c) => c.targetId)).toEqual([9769, 9775, 9909]);
    // Gợi ý KG nằm ở comment riêng, không lẫn vào mô tả (TECH-1084).
    expect(it$.calls.addComment[0]?.body).toContain("Bị gắn trùng tk học do cùng tên");
    expect(source.calls).toHaveLength(1);
    expect(source.calls[0].text).toContain("không làm bài được");
  });

  it("KG không đủ tự tin (null) → không ghi gì, kể cả khi Onyx có kết quả", async () => {
    const searchClient = {
      searchSimilar: async () => [{ identifier: "TECH-111", title: "Onyx", verifiedOnTracker: true, source: "onyx" }],
    };
    const p2 = new IntakeStepPipeline({
      ...(pipeline as any).options,
      searchClient: searchClient as any,
      similarTickets: clusterSource([]) as any,
    });

    await p2.run({ chatId: "chat_kg_2", message: "Lỗi app Duo hệ thống Vuihoc học sinh 0900000005 không làm bài được" });
    await p2.run({ chatId: "chat_kg_2", message: "Em bên Vận hành nhé" });
    await p2.run({ chatId: "chat_kg_2", message: "Chuẩn rồi em tạo đi" });
    await p2.flushBackgroundForTests();

    expect(it$.calls.setCustomFieldValue).toHaveLength(0);
    expect(it$.calls.addLink).toHaveLength(0);
    // Gợi ý KG giờ đi qua `addComment`, không phải `updateIssue` (TECH-1084) —
    // phải chặn đúng kênh ghi, nếu không khẳng định này luôn đúng.
    expect(it$.calls.addComment).toHaveLength(0);
    expect(repo.getLatestByChatId("chat_kg_2")?.kgAdvice).toBeUndefined();
  });

  it("cùng mã ở cả KG và Onyx → bản KG (chữ người viết) thay bản Onyx, KG xếp trước (ghi lại sau khi tạo)", async () => {
    const searchClient = {
      searchSimilar: async () => [
        { identifier: "TECH-ONYX", title: "Chỉ Onyx", verifiedOnTracker: true, source: "onyx" },
        { identifier: "TECH-769", title: "Bản thô Onyx", verifiedOnTracker: true, source: "onyx" },
      ],
    };
    const p2 = new IntakeStepPipeline({
      ...(pipeline as any).options,
      searchClient: searchClient as any,
      similarTickets: clusterSource([{ identifier: "TECH-769", humanCause: "Nguyên nhân người viết", humanFix: "Cách khắc phục người viết" }]) as any,
    });

    await p2.run({ chatId: "chat_kg_3", message: "Lỗi app Duo hệ thống Vuihoc học sinh 0900000005 không làm bài được" });
    await p2.run({ chatId: "chat_kg_3", message: "Em bên Vận hành nhé" });
    await p2.run({ chatId: "chat_kg_3", message: "Chuẩn rồi em tạo đi" });
    await p2.flushBackgroundForTests();

    const saved = repo.getLatestByChatId("chat_kg_3");
    const tickets = saved?.similarTickets ?? [];
    expect(tickets.map((t) => t.identifier)).toEqual(["TECH-769", "TECH-ONYX"]);
    expect(tickets[0]).toMatchObject({ source: "kg", rootCause: "Nguyên nhân người viết", resolution: "Cách khắc phục người viết" });
    expect(saved?.kgAdvice).toContain("Nguyên nhân người viết");
    expect(it$.calls.addComment[0]?.body).toContain("Nguyên nhân người viết");
  });
});
