import { describe, expect, it } from "bun:test";
import { deriveWebhookUrl, pruneForeignWebhooks, ensureItsaplanWebhook } from "./ensure-webhook";
import type { ItsaplanClient } from "./client";

/**
 * `deriveWebhookUrl` + `pruneForeignWebhooks` sinh ra từ sự cố dựng worker OP
 * (16/10): URL đăng ký trỏ cổng 3102 còn worker nghe 3104 → Itsaplan bắn vào
 * cổng chết. Hai hàm này đảm bảo URL luôn sinh từ cổng nghe, và dọn webhook cùng
 * host nhưng lệch cổng.
 */

type Hook = { id: number; url: string; isActive: boolean; events: string[] };

function fakeClient(hooks: Hook[]) {
  const deleted: number[] = [];
  const client = {
    async listWebhooks() {
      return hooks as any;
    },
    async deleteWebhook(id: number) {
      deleted.push(id);
      const i = hooks.findIndex((h) => h.id === id);
      if (i >= 0) hooks.splice(i, 1);
    },
    async createWebhook(_pk: string, body: any) {
      const h = { id: 99, url: body.url, isActive: true, events: body.events };
      hooks.push(h);
      return h as any;
    },
    async updateWebhook(id: number, patch: any) {
      const h = hooks.find((x) => x.id === id)!;
      Object.assign(h, patch);
      return h as any;
    },
  } as unknown as ItsaplanClient;
  return { client, deleted, hooks };
}

describe("deriveWebhookUrl", () => {
  it("sinh URL từ chính cổng nghe (không còn hai biến phải khớp tay)", () => {
    expect(deriveWebhookUrl({ host: "10.0.0.5", port: 3104 })).toBe(
      "http://10.0.0.5:3104/webhook",
    );
    expect(deriveWebhookUrl({ host: "10.0.0.5", port: 8080, path: "hook", scheme: "https" })).toBe(
      "https://10.0.0.5:8080/hook",
    );
  });
});

describe("pruneForeignWebhooks", () => {
  it("xoá webhook cùng host nhưng lệch cổng, giữ webhook chuẩn và webhook host khác", async () => {
    const canonical = "http://10.0.0.5:3104/webhook";
    const { client, deleted } = fakeClient([
      { id: 13, url: "http://10.0.0.5:3104/webhook", isActive: true, events: [] }, // chuẩn — giữ
      { id: 14, url: "http://10.0.0.5:3102/webhook", isActive: true, events: [] }, // cùng host lệch cổng — xoá
      { id: 15, url: "http://10.0.0.6:3102/webhook", isActive: true, events: [] }, // host khác — giữ
    ]);
    const removed = await pruneForeignWebhooks(client, "OP", canonical);
    expect(removed).toEqual([14]);
    expect(deleted).toEqual([14]);
  });

  it("không có gì để xoá khi chỉ có webhook chuẩn", async () => {
    const { client, deleted } = fakeClient([
      { id: 13, url: "http://10.0.0.5:3104/webhook", isActive: true, events: [] },
    ]);
    const removed = await pruneForeignWebhooks(client, "OP", "http://10.0.0.5:3104/webhook");
    expect(removed).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("ensureItsaplanWebhook + prune: kết quả chỉ còn đúng một webhook chuẩn, đang bật, đủ sự kiện", async () => {
    const canonical = "http://10.0.0.5:3104/webhook";
    const { client, hooks } = fakeClient([
      { id: 14, url: "http://10.0.0.5:3102/webhook", isActive: true, events: [] },
    ]);
    await pruneForeignWebhooks(client, "OP", canonical);
    const res = await ensureItsaplanWebhook(client, "OP", canonical);
    expect(res.success).toBe(true);
    expect(hooks.length).toBe(1);
    expect(hooks[0]!.url).toBe(canonical);
    expect(hooks[0]!.isActive).toBe(true);
    expect(hooks[0]!.events).toContain("comment.created");
  });

  it("idempotent KHÔNG prune: webhook cùng host lệch cổng được TRỎ LẠI url đúng, tái dùng id, không đẻ webhook mới", async () => {
    const canonical = "http://10.0.0.5:3104/webhook";
    const { client, hooks } = fakeClient([
      { id: 14, url: "http://10.0.0.5:3102/webhook", isActive: true, events: ["comment.created"] },
    ]);
    const res = await ensureItsaplanWebhook(client, "OP", canonical);
    expect(res.success).toBe(true);
    expect(res.webhookId).toBe(14); // tái dùng, không phải id mới (99)
    expect(hooks.length).toBe(1); // không đẻ thêm
    expect(hooks[0]!.id).toBe(14);
    expect(hooks[0]!.url).toBe(canonical); // đã trỏ lại cổng đúng
    expect(hooks[0]!.isActive).toBe(true);
    expect(hooks[0]!.events).toContain("issue.created"); // merge đủ event
  });

  it("idempotent: webhook của HOST KHÁC lệch cổng KHÔNG bị trỏ lại — tạo mới cho host này", async () => {
    const canonical = "http://10.0.0.5:3104/webhook";
    const { client, hooks } = fakeClient([
      { id: 15, url: "http://10.0.0.6:3102/webhook", isActive: true, events: [] }, // máy khác, để yên
    ]);
    const res = await ensureItsaplanWebhook(client, "OP", canonical);
    expect(res.success).toBe(true);
    expect(res.webhookId).toBe(99); // tạo mới
    expect(hooks.length).toBe(2); // webhook host khác vẫn còn
    expect(hooks.find((h) => h.id === 15)).toBeTruthy();
  });
});
