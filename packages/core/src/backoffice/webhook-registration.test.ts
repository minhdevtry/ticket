import { describe, expect, it } from "bun:test";
import { ItsaplanApiError, type ItsaplanClient, type WebhookSubscription } from "../itsaplan";
import { WebhookPermissionError, ensureRuleWebhook } from "./webhook-registration";

const URL = "https://bot.example.com/webhook";
const hook = (id: number, extra: Partial<WebhookSubscription> = {}): WebhookSubscription => ({
  id,
  projectId: 1,
  url: URL,
  secret: `whsec_${id}`,
  events: ["issue.state_changed"],
  isActive: true,
  createdAt: "",
  ...extra,
});

/** Client giả: danh sách webhook sống, có thể chèn "process khác" tạo webhook xen giữa. */
function stub(initial: WebhookSubscription[] = [], opts: { rejectSecret?: boolean } = {}) {
  const hooks = [...initial];
  const calls: string[] = [];
  let nextId = Math.max(0, ...hooks.map((h) => h.id)) + 1;
  const hooksBetween: (() => void)[] = [];
  const client = {
    async listWebhooks() {
      calls.push("list");
      return hooks.map((h) => ({ ...h }));
    },
    async createWebhook(_ref: string, payload: Record<string, unknown>) {
      calls.push(`create${"secret" in payload ? "+secret" : ""}`);
      if (opts.rejectSecret && "secret" in payload) {
        throw new ItsaplanApiError(400, "/x", "bad");
      }
      hooksBetween.shift()?.(); // process khác tạo xong NGAY TRƯỚC khi bản của ta có id
      nextId = Math.max(nextId, ...hooks.map((x) => x.id + 1));
      const h = hook(nextId++, {
        events: payload.events as string[],
        secret: typeof payload.secret === "string" ? payload.secret : "server-secret",
      });
      hooks.push(h);
      return h;
    },
    async updateWebhook(id: number, patch: Partial<WebhookSubscription>) {
      calls.push(`update:${id}:${Object.keys(patch).join(",")}`);
      Object.assign(hooks.find((h) => h.id === id) as WebhookSubscription, patch);
      return hooks.find((h) => h.id === id) as WebhookSubscription;
    },
    async deleteWebhook(id: number) {
      calls.push(`delete:${id}`);
      hooks.splice(
        hooks.findIndex((h) => h.id === id),
        1,
      );
    },
  };
  return { client: client as unknown as ItsaplanClient, hooks, calls, hooksBetween };
}

const base = {
  projectRef: "tech.TECH",
  projectId: 1,
  url: URL,
  events: ["comment.created", "issue.state_changed"],
};

describe("ensureRuleWebhook", () => {
  it("tạo mới khi chưa có; unchanged khi đã đủ", async () => {
    const s = stub();
    expect(await ensureRuleWebhook({ client: s.client, ...base })).toMatchObject({
      action: "created",
    });
    expect(s.hooks).toHaveLength(1);
    expect(await ensureRuleWebhook({ client: s.client, ...base })).toMatchObject({
      action: "unchanged",
    });
  });

  it("hai bot khởi động đồng thời: chỉ giữ webhook id nhỏ nhất, xoá bản VỪA TẠO của mình", async () => {
    const s = stub();
    // Trước khi bản của ta được tạo, "bot kia" đã tạo id 1 (ta sẽ là id 2).
    s.hooksBetween.push(() => s.hooks.push(hook(1, { events: base.events })));
    const out = await ensureRuleWebhook({ client: s.client, ...base });
    expect(out).toMatchObject({ action: "unchanged", webhookId: 1 });
    expect(s.hooks.map((h) => h.id)).toEqual([1]);
    expect(s.calls.filter((c) => c.startsWith("delete"))).toEqual(["delete:2"]);
  });

  it("nếu bản của ta là nhỏ nhất thì giữ (bên kia sẽ tự xoá bản của họ)", async () => {
    const s = stub();
    const out = await ensureRuleWebhook({ client: s.client, ...base });
    expect(out.action).toBe("created");
    expect(s.calls.some((c) => c.startsWith("delete"))).toBe(false);
  });

  it("webhook đang tắt: không bật lại, không sửa, báo disabled kèm sự kiện thiếu", async () => {
    const s = stub([hook(5, { isActive: false })]);
    const out = await ensureRuleWebhook({ client: s.client, ...base });
    expect(out).toMatchObject({
      action: "disabled",
      webhookId: 5,
      missingEvents: ["comment.created"],
    });
    expect(s.calls).toEqual(["list"]);
    expect(s.hooks[0]).toMatchObject({ isActive: false, events: ["issue.state_changed"] });
  });

  it("webhook đang bật thiếu sự kiện: bổ sung, giữ sự kiện sẵn có, không đổi isActive", async () => {
    const s = stub([hook(5, { events: ["comment.updated"] })]);
    const out = await ensureRuleWebhook({ client: s.client, ...base });
    expect(out).toMatchObject({ action: "updated" });
    expect(s.calls).toContain("update:5:events");
    expect(s.hooks[0].events).toEqual([
      "comment.created",
      "comment.updated",
      "issue.state_changed",
    ]);
  });

  it("gửi secret khi tạo; API từ chối (400) thì tạo lại không có secret", async () => {
    const ok = stub();
    expect(await ensureRuleWebhook({ client: ok.client, ...base, secret: "mine" })).toMatchObject({
      action: "created",
      secretSent: true,
      secretMatches: true,
    });
    expect(ok.calls).toContain("create+secret");

    const strict = stub([], { rejectSecret: true });
    const out = await ensureRuleWebhook({ client: strict.client, ...base, secret: "mine" });
    expect(out).toMatchObject({ action: "created", secretSent: false, secretMatches: false });
    expect(strict.calls.filter((c) => c.startsWith("create"))).toEqual(["create+secret", "create"]);
  });

  it("so secret của webhook có sẵn với secret cấu hình (không trả giá trị)", async () => {
    const s = stub([hook(5, { events: base.events, secret: "khac" })]);
    const out = await ensureRuleWebhook({ client: s.client, ...base, secret: "mine" });
    expect(out.secretMatches).toBe(false);
    expect(JSON.stringify(out)).not.toContain("khac");
  });

  it("chỉ xét webhook của dự án mình (projectId)", async () => {
    const s = stub([hook(5, { projectId: 2, events: base.events })]);
    expect(await ensureRuleWebhook({ client: s.client, ...base })).toMatchObject({
      action: "created",
    });
  });

  it("401/403 thành WebhookPermissionError", async () => {
    const client = {
      async listWebhooks() {
        throw new ItsaplanApiError(403, "/x", "no");
      },
    } as unknown as ItsaplanClient;
    await expect(ensureRuleWebhook({ client, ...base })).rejects.toBeInstanceOf(
      WebhookPermissionError,
    );
  });
});
