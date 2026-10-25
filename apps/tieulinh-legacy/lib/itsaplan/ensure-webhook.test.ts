import { describe, expect, test } from "bun:test";
import type { ItsaplanClient } from "@vuihoc/bot-core/itsaplan";
import { TIEULINH_WEBHOOK_EVENTS, ensureTieuLinhWebhook } from "./ensure-webhook";

type Hook = { id: number; url: string; isActive: boolean; events: string[] };

function fakeClient(hooks: Hook[]) {
  const deleted: number[] = [];
  const client = {
    async listWebhooks() {
      return hooks;
    },
    async deleteWebhook(id: number) {
      deleted.push(id);
      hooks.splice(
        hooks.findIndex((h) => h.id === id),
        1,
      );
    },
    async createWebhook(_k: string, body: { url: string; events: string[] }) {
      const h = { id: 99, url: body.url, isActive: true, events: body.events };
      hooks.push(h);
      return h;
    },
    async updateWebhook(id: number, patch: Partial<Hook>) {
      const h = hooks.find((x) => x.id === id) as Hook;
      Object.assign(h, patch);
      return h;
    },
  } as unknown as ItsaplanClient;
  return { client, hooks, deleted };
}

const URL_OK = "http://10.0.0.5:3104/webhook";

// Hành vi cũ của Tiểu Linh: khớp URL chính xác; webhook tắt thì xoá-tạo lại; không
// tự trỏ lại webhook cùng host lệch cổng; không đăng ký issue.created.
describe("ensureTieuLinhWebhook (hành vi cũ)", () => {
  test("tạo mới với đúng 4 sự kiện cũ, không có issue.created", async () => {
    const { client, hooks } = fakeClient([]);
    await ensureTieuLinhWebhook(client, "TECH", URL_OK);
    expect(hooks[0]?.events).toEqual([...TIEULINH_WEBHOOK_EVENTS]);
    expect(hooks[0]?.events).not.toContain("issue.created");
  });

  test("webhook khớp URL nhưng đang tắt → xoá rồi tạo mới (id mới), không bật lại tại chỗ", async () => {
    const { client, hooks, deleted } = fakeClient([
      { id: 7, url: URL_OK, isActive: false, events: [] },
    ]);
    const res = await ensureTieuLinhWebhook(client, "TECH", URL_OK);
    expect(deleted).toEqual([7]);
    expect(res.webhookId).toBe(99);
    expect(hooks.map((h) => h.id)).toEqual([99]);
  });

  test("webhook cùng host lệch cổng KHÔNG bị trỏ lại: giữ nguyên và tạo thêm webhook mới", async () => {
    const stale = "http://10.0.0.5:3102/webhook";
    const { client, hooks } = fakeClient([
      { id: 14, url: stale, isActive: true, events: ["comment.created"] },
    ]);
    const res = await ensureTieuLinhWebhook(client, "TECH", URL_OK);
    expect(res.webhookId).toBe(99);
    expect(hooks.find((h) => h.id === 14)?.url).toBe(stale);
    expect(hooks).toHaveLength(2);
  });

  test("webhook khớp, đang bật, thiếu sự kiện → chỉ bổ sung phần thiếu", async () => {
    const { client, hooks } = fakeClient([
      { id: 7, url: URL_OK, isActive: true, events: ["comment.created"] },
    ]);
    await ensureTieuLinhWebhook(client, "TECH", URL_OK);
    expect([...(hooks[0]?.events ?? [])].sort()).toEqual([...TIEULINH_WEBHOOK_EVENTS].sort());
  });
});
