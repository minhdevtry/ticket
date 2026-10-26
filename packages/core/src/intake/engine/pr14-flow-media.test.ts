/**
 * Port ca test J1 từ legacy pipeline.flow.test.ts (RFC 0002 PR 14, issue #28):
 * - "tin chỉ có ảnh không làm sập, ảnh được gắn vào tài liệu rồi tải lên ticket"
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { tieuLinhCopy } from "../../../examples/tieulinh/copy";
import { DEFAULT_TIEULINH_IGNORED_ACTORS } from "../../../examples/tieulinh/engine-config";
import { passthroughMediaResolver } from "../ports";
import { MIN_CONFIRM_DELAY_MS } from "../confirm";
import { makeCopyCatalog } from "../copy-catalog";
import { SqliteChannelBindingStore } from "../create";
import { intakeApplySchema, SqliteDraftRepository } from "../draft";
import { FieldExtractor } from "../extractor/llm-extractor";
import { createCatalog } from "../gate/catalog";
import type { Priority, TrackerIssue, TrackerPort } from "../ports";
import { legacyActionForOutcome } from "./action-map";
import { FakeClock, URGENCY } from "./engine-harness.fixture";
import { IntakeEngine } from "./engine";

interface FakeItsaplanCalls {
  createIssue: Array<{
    title?: string;
    description?: string;
    columnId?: number;
    priority?: Priority;
  }>;
  attach: Array<{
    issueId: number;
    description: string;
    mediaPaths: string[];
  }>;
}

interface FakeItsaplan {
  calls: FakeItsaplanCalls;
  tracker: TrackerPort;
}

function fakeItsaplan(): FakeItsaplan {
  const calls: FakeItsaplanCalls = {
    createIssue: [],
    attach: [],
  };
  let seq = 100;

  const tracker: TrackerPort = {
    async createIssue(payload) {
      seq += 1;
      const issue: TrackerIssue = {
        id: seq,
        identifier: `TECHTEST-${seq}`,
        title: payload.title ?? "",
        url: `https://mock.itsaplan.test/TECHTEST-${seq}`,
        priority: payload.priority,
      };
      calls.createIssue.push(payload);
      return issue;
    },
    async getIssue(id: number) {
      return { id, identifier: `TECHTEST-${id}`, title: `Ticket ${id}` };
    },
    async addComment() {},
    async attach(issueId: number, description: string, mediaPaths: string[]) {
      calls.attach.push({ issueId, description, mediaPaths });
      return mediaPaths.length;
    },
    async findByIdentifier(identifier: string) {
      return { id: 101, identifier, title: `Ticket ${identifier}` };
    },
  };

  return { calls, tracker };
}

const catalog = createCatalog({
  fields: {
    _toi_da_hoi_lai: 2,
    _toi_da_truong_moi_luot: 1,
    nhanh: {
      tech: {
        ten: "Sự cố kỹ thuật",
        recap: ["reportingDept"],
        truong: {
          reportingDept: {
            bat_buoc: true,
            kieu: "enum:reportingDept",
            duoc_hoi: true,
            nhan: "Bộ phận",
            hoi: "Anh/chị thuộc bộ phận nào ạ?",
            role: "department",
          },
        },
      },
    },
  },
  enums: {
    reportingDept: ["Vận hành", "Vận đơn", "CSKH", "CSHV", "Chuyên môn", "Sale", "Quản lý lớp"],
  },
});

describe("PR 14 — Media (J1): tin chỉ có ảnh và gắn ảnh vào ticket", () => {
  let db: Database;
  let drafts: SqliteDraftRepository;
  let bindings: SqliteChannelBindingStore;
  let it$: FakeItsaplan;
  let clock: FakeClock;
  let engine: IntakeEngine;

  const CHAT = "chat_media_pr14";
  const REPORT = "Lỗi app Duo học sinh 0900000005 không làm bài được";

  beforeEach(() => {
    db = new Database(":memory:");
    intakeApplySchema(db);
    drafts = new SqliteDraftRepository(db);
    bindings = new SqliteChannelBindingStore(db);
    it$ = fakeItsaplan();
    clock = new FakeClock();

    engine = new IntakeEngine({
      tracker: it$.tracker,
      drafts,
      bindings,
      copy: makeCopyCatalog(tieuLinhCopy),
      clock,
      media: passthroughMediaResolver,
      identifierPrefix: "TECHTEST",
      extractor: new FieldExtractor(),
      catalog,
      variant: "tech",
      urgencyRules: URGENCY,
      botName: "Tiểu Linh",
      ignoredActors: DEFAULT_TIEULINH_IGNORED_ACTORS,
    });
  });

  it("tin chỉ có ảnh không làm sập, ảnh được gắn vào tài liệu rồi tải lên ticket", async () => {
    const fakeImg = "/tmp/test-image-j1.png";

    // 1. Gửi tin chỉ có ảnh
    const r0 = await engine.step({ chatId: CHAT, message: "", mediaPaths: [fakeImg] });
    expect(legacyActionForOutcome(r0.outcome)).toBeDefined();

    // 2. Gửi lời báo
    await engine.step({ chatId: CHAT, message: REPORT });

    // 3. Gửi bổ sung bộ phận
    const r2 = await engine.step({ chatId: CHAT, message: "Em bên Vận hành nhé" });
    expect(legacyActionForOutcome(r2.outcome)).toBe("confirm_summary");

    // 4. Xác nhận tạo ticket
    clock.advance(MIN_CONFIRM_DELAY_MS + 1000);
    const r3 = await engine.step({ chatId: CHAT, message: "đúng rồi" });
    expect(legacyActionForOutcome(r3.outcome)).toBe("ticket_created");

    // Đã gọi createIssue và attach media
    expect(it$.calls.createIssue).toHaveLength(1);
    expect(it$.calls.attach).toHaveLength(1);
    expect(it$.calls.attach[0].mediaPaths).toContain(fakeImg);
  });
});
