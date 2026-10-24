import { describe, expect, it } from "bun:test";
import { startIntakeWorker } from "./index";
import type { ItsaplanClient } from "../itsaplan/client";
import type { ChannelPort } from "../intake/ports";

/**
 * Lắp worker end-to-end bằng cổng 0 (hệ cấp cổng rảnh) + client Itsaplan giả.
 * Mục tiêu: chứng minh module đúc kết đúng các bước BẮT BUỘC của worker OP —
 * nghe cổng, SINH URL từ cổng đó (không lệch), dọn webhook thừa, đăng ký webhook
 * chuẩn — mà bot sau chỉ cần gọi một hàm.
 */

type Hook = { id: number; url: string; isActive: boolean; events: string[] };

function fakeItsaplan(hooks: Hook[]) {
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
      const h = { id: 500, url: body.url, isActive: true, events: body.events };
      hooks.push(h);
      return h as any;
    },
    async updateWebhook(id: number, patch: any) {
      const h = hooks.find((x) => x.id === id)!;
      Object.assign(h, patch);
      return h as any;
    },
    async addComment() {
      return { id: 1, body: "" };
    },
    async getIssue() {
      return null as any;
    },
  } as unknown as ItsaplanClient;
  return { client, deleted, hooks };
}

const nullChannel: ChannelPort = {
  channelType: "telegram",
  async sendComment() {
    return null;
  },
  async sendStateChange() {
    return null;
  },
};

const stores = {
  bindings: {
    getBindingByIssueId() {
      return null;
    },
  } as any,
  routes: {
    recordMessageRoute() {},
    getMessageRoute() {
      return null;
    },
  } as any,
};

describe("startIntakeWorker (đúc kết các bước worker OP)", () => {
  it("nghe cổng, sinh URL từ cổng thật, dọn webhook lệch cổng, đăng ký đúng một webhook chuẩn", async () => {
    const { client, deleted, hooks } = fakeItsaplan([
      // webhook cũ cùng host nhưng cổng chết — đúng tình huống OP 16/10
      { id: 14, url: "http://10.0.0.5:3102/webhook", isActive: true, events: [] },
    ]);
    const h = await startIntakeWorker({
      itsaplan: client,
      projectKey: "OP",
      port: 0, // hệ cấp cổng rảnh
      host: "10.0.0.5",
      dispatcher: { ...stores, channel: nullChannel, copy: { describe: () => null } },
      reply: {
        routes: stores.routes,
        tracker: {
          async addComment() {
            return { id: 1, body: "" };
          },
        } as any,
        copy: { comment: () => "", ack: () => "" },
      },
    });
    try {
      expect(h.port).toBeGreaterThan(0);
      // URL sinh từ CHÍNH cổng đang nghe — không lệch
      expect(h.webhookUrl).toBe(`http://10.0.0.5:${h.port}/webhook`);
      // webhook cổng chết đã bị dọn
      expect(deleted).toContain(14);
      // còn đúng một webhook, trỏ URL chuẩn, đang bật
      expect(hooks.length).toBe(1);
      expect(hooks[0]!.url).toBe(h.webhookUrl);
      expect(hooks[0]!.isActive).toBe(true);
    } finally {
      await h.stop();
    }
  });

  it("pruneStaleWebhooks=false thì không dọn webhook cũ", async () => {
    const { client, deleted } = fakeItsaplan([
      { id: 14, url: "http://10.0.0.5:3102/webhook", isActive: true, events: [] },
    ]);
    const h = await startIntakeWorker({
      itsaplan: client,
      projectKey: "OP",
      port: 0,
      host: "10.0.0.5",
      pruneStaleWebhooks: false,
      dispatcher: { ...stores, channel: nullChannel, copy: { describe: () => null } },
      reply: {
        routes: stores.routes,
        tracker: {
          async addComment() {
            return { id: 1, body: "" };
          },
        } as any,
        copy: { comment: () => "", ack: () => "" },
      },
    });
    try {
      expect(deleted).not.toContain(14);
    } finally {
      await h.stop();
    }
  });
});
