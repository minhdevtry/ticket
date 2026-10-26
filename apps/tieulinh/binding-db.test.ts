/**
 * `TIEULINH_BINDING_DB` (RFC 0002 mục 6.2): binding và tuyến tin của hậu cần TL2 nằm trong file dạng legacy chung với
 * TL1. Mặc định (không đặt biến) không đổi. Dữ liệu giả; "TL1" ghi bằng câu SQL y như `TicketBindingRepository`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { intakeApplySchema, openLegacyBindingDb } from "@vuihoc/bot-core/intake";
import { CHAT, type Harness, RESOLVED, commentCreated, harness, stateChanged } from "./testkit";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.stop());

const tables = (db: Database) =>
  (
    db.query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);

/** Dựng file như TL1: bảng legacy, rồi một binding do TL1 ghi (`channel_type`, `message_id` giữ chỗ). */
function seedTl1File(issueId: number, identifier: string): string {
  const file = join(h.dir, "tl1.sqlite");
  const db = openLegacyBindingDb(file);
  db.prepare(
    `INSERT INTO ticket_bindings (issue_id, channel_type, chat_id, message_id, identifier, title, reporter_username, updated_at)
     VALUES (?, 'telegram', ?, '0', ?, 'Không vào được app', 'user_cs_a', CURRENT_TIMESTAMP)`,
  ).run(issueId, CHAT, identifier);
  db.close();
  return file;
}

describe("TIEULINH_BINDING_DB", () => {
  test("mặc định: binding ở tieulinh-app.sqlite, không tạo file legacy nào", () => {
    const { app } = h.boot();
    const svc = app.services();
    expect(svc.bindingDb).toBe(svc.db);
    expect(tables(svc.db)).toContain("ticket_bindings");
    expect(existsSync(join(h.dir, "tl1.sqlite"))).toBe(false);
  });

  test("đặt biến: binding TL1 ghi được hậu cần TL2 đọc, tin chuyển về chat, route ghi vào file legacy", async () => {
    const issue = h.fake.addIssue({ title: "Không vào được app", columnId: 3 });
    const file = seedTl1File(issue.id, issue.identifier);
    const { app, bot } = h.boot({ env: { TIEULINH_BINDING_DB: file } });
    const svc = app.services();
    expect(svc.bindingDb).not.toBe(svc.db);
    expect(svc.bindingStore.schema).toBe("legacy");
    expect(svc.bindings.getBindingByIssueId(issue.id)).toMatchObject({
      chatId: CHAT,
      channelType: "telegram",
      reporterUsername: "user_cs_a",
    });

    await bot.handleEvent(commentCreated(issue, "Đã sửa, anh/chị thử lại giúp."));
    const sent = h.channelLog().filter((r) => r.kind === "comment");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chatId: CHAT });

    // route nằm trong file legacy (để TL1 và TL2 cùng tra reply), vòng đời nằm ở kho của app
    const legacy = new Database(file, { readonly: true });
    expect(legacy.query(`SELECT COUNT(*) AS n FROM message_routes`).get()).toEqual({ n: 1 });
    legacy.close();
    // (kho của app vẫn dựng đủ bảng như mặc định, nhưng hai bảng này ở đó phải rỗng)
    for (const t of ["ticket_bindings", "message_routes"]) {
      expect(svc.db.query(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    }

    h.fake.issues[0]!.columnId = RESOLVED.id;
    await bot.handleEvent(stateChanged(issue, RESOLVED));
    expect(h.channelLog().filter((r) => r.kind === "state")).toHaveLength(1);
    expect(svc.db.query(`SELECT COUNT(*) AS n FROM ticket_states`).get()).toEqual({ n: 1 });
  });

  test("sandbox: binding do app ghi có dạng legacy, TL1 đọc được", () => {
    const file = join(h.dir, "tl1.sqlite");
    const { app } = h.boot({ env: { TIEULINH_BINDING_DB: file, TIEULINH_SANDBOX_CHAT: CHAT } });
    const svc = app.services();
    expect(svc.ensureBinding({ id: 77, identifier: "TECH2-77", title: "Thử" })).toBe(true);
    const row = svc.bindingDb
      .query(`SELECT channel_type, message_id, chat_id FROM ticket_bindings WHERE issue_id = 77`)
      .get();
    expect(row).toEqual({ channel_type: "telegram", message_id: "0", chat_id: CHAT });
  });

  test("file không phải dạng legacy: app dừng to, không ghi gì", () => {
    const file = join(h.dir, "core.sqlite");
    const core = new Database(file, { create: true });
    intakeApplySchema(core, { wal: false });
    core.close();
    const { app } = h.boot({ env: { TIEULINH_BINDING_DB: file } });
    expect(() => app.services()).toThrow(/legacy|core/);
  });
});
