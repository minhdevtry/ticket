import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { isBotComment } from "../../core/formatting";
import { ReplyRouter, type ReplyCopy } from "./reply-router";
import { SqliteMessageRouteStore, SqliteNotifyBindingReader, notifyApplySchema } from "./stores";
import { intakeApplySchema } from "../draft/schema";
import type { MessageRoute, MessageRouteStore, TrackerPort } from "../ports";

const copy: ReplyCopy = {
  comment: ({ who, text, time }) => `**${who}** phản hồi: ${text} (${time}).`,
  ack: ({ identifier }) => `Dạ em đã chuyển phản hồi vào ${identifier} ạ.`,
};

function fakeTracker() {
  const comments: Array<{ issueId: number; body: string }> = [];
  const tracker: Pick<TrackerPort, "addComment"> = {
    async addComment(issueId, body) {
      comments.push({ issueId, body });
    },
  };
  return { tracker, comments };
}

function routeStore(route: MessageRoute | null): MessageRouteStore {
  return {
    saveMessageRoute() {},
    getMessageRoute: (messageId, channelType, chatId) =>
      route && route.messageId === messageId && route.chatId === chatId ? route : null,
  };
}

describe("ReplyRouter (25c68db + ADR-0006)", () => {
  const route: MessageRoute = {
    messageId: "55",
    channelType: "telegram",
    chatId: "123",
    issueId: 7,
    identifier: "TECH-7",
  };

  test("a reply to a known notification becomes a comment on that ticket (not the agent)", async () => {
    const t = fakeTracker();
    const r = new ReplyRouter({
      routes: routeStore(route),
      tracker: t.tracker,
      copy,
      formatTime: () => "08:00 16/10",
      clock: { now: () => 0 },
      projectKey: "TECH",
    });
    const res = await r.recordReporterReply({
      chatId: "123",
      messageId: "55",
      text: "chưa ổn ạ",
      userName: "Cô A",
    });
    expect(res.handled).toBe(true);
    if (res.handled) expect(res.replyText).toContain("TECH-7");
    expect(t.comments).toHaveLength(1);
    expect(t.comments[0].issueId).toBe(7);
    expect(t.comments[0].body).toContain("chưa ổn ạ");
    // the comment carries the bot marker so the dispatcher never echoes it back
    expect(isBotComment(t.comments[0].body)).toBe(true);
  });

  test("a reply to an UNKNOWN message is handled:false (falls through to the agent)", async () => {
    const t = fakeTracker();
    const r = new ReplyRouter({
      routes: routeStore(route),
      tracker: t.tracker,
      copy,
      projectKey: "TECH",
    });
    const res = await r.recordReporterReply({
      chatId: "123",
      messageId: "999",
      text: "lạc đề",
      userName: "X",
    });
    expect(res.handled).toBe(false);
    expect(t.comments).toHaveLength(0);
  });

  test("a reply to a ticket of another project is NOT recorded (project-lock)", async () => {
    const t = fakeTracker();
    const poRoute: MessageRoute = { ...route, identifier: "PO-7" };
    const r = new ReplyRouter({
      routes: routeStore(poRoute),
      tracker: t.tracker,
      copy,
      projectKey: "TECH",
    });
    const res = await r.recordReporterReply({
      chatId: "123",
      messageId: "55",
      text: "x",
      userName: "X",
    });
    expect(res.handled).toBe(false);
    expect(t.comments).toHaveLength(0);
  });

  test("chat id with telegram: prefix still resolves the route", async () => {
    const t = fakeTracker();
    const prefixed: MessageRoute = { ...route, chatId: "telegram:123" };
    const r = new ReplyRouter({
      routes: routeStore(prefixed),
      tracker: t.tracker,
      copy,
      projectKey: "TECH",
    });
    const res = await r.recordReporterReply({
      chatId: "telegram:123",
      messageId: "55",
      text: "ok",
      userName: "X",
    });
    expect(res.handled).toBe(true);
  });
});

describe("SqliteMessageRouteStore (fd48c6e chat-scoped lookup)", () => {
  function freshDb(): Database {
    const db = new Database(":memory:");
    intakeApplySchema(db, { wal: false });
    notifyApplySchema(db, { wal: false });
    return db;
  }

  test("exact (messageId, channel, chat) match round-trips", () => {
    const db = freshDb();
    const store = new SqliteMessageRouteStore(db);
    store.saveMessageRoute({
      messageId: "55",
      channelType: "telegram",
      chatId: "123",
      issueId: 7,
      identifier: "TECH-7",
      kind: "comment",
    });
    const got = store.getMessageRoute("55", "telegram", "123");
    expect(got).toMatchObject({ issueId: 7, identifier: "TECH-7" });
  });

  test("a route from a different chat does not match", () => {
    const db = freshDb();
    const store = new SqliteMessageRouteStore(db);
    store.saveMessageRoute({
      messageId: "55",
      channelType: "telegram",
      chatId: "123",
      issueId: 7,
      identifier: "TECH-7",
      kind: "comment",
    });
    expect(store.getMessageRoute("55", "telegram", "999")).toBeNull();
  });

  test("an empty-chat route is used only as a fallback when the asking chat holds the binding", () => {
    const db = freshDb();
    const store = new SqliteMessageRouteStore(db);
    // legacy row with no chat id
    store.saveMessageRoute({
      messageId: "55",
      channelType: "telegram",
      chatId: "",
      issueId: 7,
      identifier: "TECH-7",
      kind: "comment",
    });
    // no binding yet → fallback refuses
    expect(store.getMessageRoute("55", "telegram", "123")).toBeNull();
    // bind issue 7 to chat 123 → fallback now resolves
    db.prepare(
      `INSERT INTO ticket_bindings (issue_id, chat_id, identifier) VALUES (7, '123', 'TECH-7')`,
    ).run();
    expect(store.getMessageRoute("55", "telegram", "123")).toMatchObject({ issueId: 7 });
    // but a different chat still gets nothing
    expect(store.getMessageRoute("55", "telegram", "456")).toBeNull();
  });
});

describe("SqliteNotifyBindingReader", () => {
  test("reads a binding by issue id, including the channel_type column", () => {
    const db = new Database(":memory:");
    intakeApplySchema(db, { wal: false });
    notifyApplySchema(db, { wal: false }); // adds channel_type
    db.prepare(
      `INSERT INTO ticket_bindings (issue_id, chat_id, identifier, title, channel_type) VALUES (7, '123', 'TECH-7', 'Lỗi ClassIn', 'telegram')`,
    ).run();
    const reader = new SqliteNotifyBindingReader(db);
    const b = reader.getBindingByIssueId(7);
    expect(b).toMatchObject({
      issueId: 7,
      chatId: "123",
      identifier: "TECH-7",
      channelType: "telegram",
      title: "Lỗi ClassIn",
    });
    expect(reader.getBindingByIssueId(999)).toBeNull();
  });
});
