import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { evidenceInComment, siblingIdentifiers } from "./duplicates";
import { type Harness, commentCreated, harness } from "./testkit";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.stop());

const verdict = (duplicate: boolean, evidence = "") => ({
  text: JSON.stringify({ duplicate, evidence }),
});
const botComments = () => h.fake.comments.filter((c) => c.actorUserId === "agent-user");

function twoTickets() {
  const x = h.fake.addIssue({
    title: "App treo khi đăng nhập",
    description: "Mô tả gốc của người báo.",
    columnId: 2,
  });
  const y = h.fake.addIssue({
    title: "Đăng nhập bị treo",
    description: "Báo cáo sớm hơn.",
    columnId: 3,
  });
  return { x, y };
}

describe("phát hiện ticket trùng", () => {
  test("technician nói trùng: chỉ để lại một comment gợi ý (sandbox), không đổi gì khác", async () => {
    const { x, y } = twoTickets();
    const { bot } = h.boot();
    h.llm.script(verdict(true, `trùng ${y.identifier}`));

    const body = `Ticket này trùng ${y.identifier}, cùng lỗi treo đăng nhập.`;
    await bot.handleEvent(commentCreated(x, body));

    const mine = botComments();
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).toContain("Gợi ý");
    expect(mine[0]!.body).toContain(y.identifier);
    expect(h.fake.count(/^(PATCH|PUT|DELETE) /)).toBe(0);
    expect(h.fake.links).toHaveLength(0);
    expect(h.fake.issues.find((i) => i.id === x.id)!.columnId).toBe(2);
    // comment gợi ý là comment của bot: không dội về người báo
    expect(h.channelLog()).toEqual([]);
  });

  test("cùng comment giao lại (webhook retry): chỉ một gợi ý", async () => {
    const { x, y } = twoTickets();
    const { bot } = h.boot();
    h.llm.script(verdict(true, `trùng ${y.identifier}`), verdict(true, `trùng ${y.identifier}`));
    const body = `trùng ${y.identifier}`;
    await bot.handleEvent(commentCreated(x, body, { id: 9100 }));
    await bot.handleEvent(commentCreated(x, body, { id: 9101 }));
    expect(botComments()).toHaveLength(1);
  });

  test("chỉ tham chiếu (LLM nói không trùng): không làm gì", async () => {
    const { x, y } = twoTickets();
    const { bot } = h.boot();
    h.llm.script(verdict(false));
    await bot.handleEvent(commentCreated(x, `Xem thêm ${y.identifier} để so sánh log.`));
    expect(botComments()).toHaveLength(0);
  });

  test("LLM bịa trích dẫn không có trong comment: không tin", async () => {
    const { x, y } = twoTickets();
    const { bot } = h.boot();
    h.llm.script(verdict(true, "đây là ticket trùng, hãy huỷ ngay"));
    await bot.handleEvent(commentCreated(x, `Xem thêm ${y.identifier}.`));
    expect(botComments()).toHaveLength(0);
  });

  test("comment không nhắc ticket anh em (hoặc chỉ nhắc chính nó): không gọi LLM", async () => {
    const { x } = twoTickets();
    const { bot } = h.boot();
    await bot.handleEvent(commentCreated(x, "Đang kiểm tra log."));
    await bot.handleEvent(commentCreated(x, `Cập nhật cho ${x.identifier}.`));
    expect(h.llm.requests).toHaveLength(0);
  });

  test("mã của dự án khác không tính là ticket anh em", async () => {
    const { x } = twoTickets();
    const { bot } = h.boot();
    await bot.handleEvent(commentCreated(x, "Trùng OTHER-9"));
    expect(h.llm.requests).toHaveLength(0);
  });

  test("chưa cấu hình LLM: bỏ qua êm, không comment", async () => {
    const { x, y } = twoTickets();
    const { bot } = h.boot({ llm: false });
    await bot.handleEvent(commentCreated(x, `trùng ${y.identifier}`));
    expect(botComments()).toHaveLength(0);
  });

  test("LLM lỗi: bỏ qua, không comment, không ném", async () => {
    const { x, y } = twoTickets();
    const { bot } = h.boot();
    h.llm.respond(() => ({ status: 503 }));
    await bot.handleEvent(commentCreated(x, `trùng ${y.identifier}`));
    expect(botComments()).toHaveLength(0);
  });

  test("ticket nguồn đã huỷ/hoàn tất: không xét", async () => {
    const { x, y } = twoTickets();
    h.fake.issues.find((i) => i.id === x.id)!.columnId = 5;
    const { bot } = h.boot();
    await bot.handleEvent(commentCreated(x, `trùng ${y.identifier}`));
    expect(h.llm.requests).toHaveLength(0);
  });

  test("ticket đích đã chuyển sang dự án khác: không gộp nhầm", async () => {
    const { x } = twoTickets();
    const away = h.fake.addIssue({ title: "Đã chuyển đi", identifier: "TECH2-77", projectId: 2 });
    const { bot } = h.boot();
    h.llm.script(verdict(true, `trùng ${away.identifier}`));
    await bot.handleEvent(commentCreated(x, `trùng ${away.identifier}`));
    expect(botComments()).toHaveLength(0);
    expect(h.llm.requests).toHaveLength(0);
  });

  test("comment do agent viết bị engine bỏ qua (không tự phán chính mình)", async () => {
    const { x, y } = twoTickets();
    const { bot } = h.boot();
    await bot.handleEvent(
      commentCreated(x, `trùng ${y.identifier}`, { actor: { type: "agent", id: "agent-user" } }),
    );
    expect(h.llm.requests).toHaveLength(0);
  });
});

describe("gộp ticket (TIEULINH_DUPLICATE_MERGE=true, hành vi legacy)", () => {
  const env = { TIEULINH_DUPLICATE_MERGE: "true" };

  test("chép mô tả gốc sang ticket đích, nối link duplicates, huỷ ticket trùng, báo cả hai bên", async () => {
    h.fake.columns.push({ id: 6, name: "Canceled", stateType: "canceled", position: 5 });
    const { x, y } = twoTickets();
    const { bot } = h.boot({ env });
    h.llm.script(verdict(true, `trùng ${y.identifier}`));
    await bot.handleEvent(commentCreated(x, `Ticket này trùng ${y.identifier}.`));

    const onTarget = h.fake.comments.filter((c) => c.issueId === y.id);
    expect(onTarget).toHaveLength(1);
    expect(onTarget[0]!.body).toContain(`Gộp từ ${x.identifier}`);
    expect(onTarget[0]!.body).toContain("Mô tả gốc của người báo."); // ADR-0010: nguyên văn
    expect(h.fake.links).toHaveLength(1);
    expect(h.fake.links[0]).toMatchObject({ kind: "duplicates" });
    expect(h.fake.issues.find((i) => i.id === x.id)!.columnId).toBe(6);
    const onSource = botComments().filter((c) => c.issueId === x.id);
    expect(onSource).toHaveLength(1);
    expect(onSource[0]!.body).toContain(y.identifier);
  });

  test("webhook giao lại: ticket đích chỉ nhận một comment gộp", async () => {
    h.fake.columns.push({ id: 6, name: "Canceled", stateType: "canceled", position: 5 });
    const { x, y } = twoTickets();
    const { bot } = h.boot({ env });
    h.llm.script(verdict(true, `trùng ${y.identifier}`), verdict(true, `trùng ${y.identifier}`));
    const body = `trùng ${y.identifier}`;
    await bot.handleEvent(commentCreated(x, body, { id: 9200 }));
    await bot.handleEvent(commentCreated(x, body, { id: 9201 }));
    expect(h.fake.comments.filter((c) => c.issueId === y.id)).toHaveLength(1);
  });

  test("dự án không có cột huỷ: vẫn chép mô tả và nối link, không chuyển cột", async () => {
    const { x, y } = twoTickets();
    const { bot } = h.boot({ env });
    h.llm.script(verdict(true, `trùng ${y.identifier}`));
    await bot.handleEvent(commentCreated(x, `trùng ${y.identifier}`));
    expect(h.fake.links).toHaveLength(1);
    expect(h.fake.issues.find((i) => i.id === x.id)!.columnId).toBe(2);
  });
});

describe("hàm thuần", () => {
  test("siblingIdentifiers", () => {
    expect(
      siblingIdentifiers("trùng tech2-7 và TECH2-9, TECH2-7 nữa; XTECH2-3", "TECH2", "TECH2-9"),
    ).toEqual(["TECH2-7"]);
  });
  test("evidenceInComment bỏ dấu và hoa thường, từ chối trích dẫn ngắn", () => {
    expect(evidenceInComment("TRÙNG tech2-7", "ticket này trùng TECH2-7 nhé")).toBe(true);
    expect(evidenceInComment("ok", "ok")).toBe(false);
    expect(evidenceInComment("không có", "ticket này trùng")).toBe(false);
  });
});
