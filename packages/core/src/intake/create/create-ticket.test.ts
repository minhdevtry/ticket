import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeOpenLazyDb } from "../../core/lazy-db";
import {
  intakeApplySchema,
  SqliteDraftRepository,
  newDraft,
  type DraftRepository,
  type IntakeDraft,
} from "../draft";
import { SqliteChannelBindingStore, createTicket } from "../create";
import { markSummaryShown, MIN_CONFIRM_DELAY_MS, CONFIRM_STALE_MS } from "../confirm";
import { makeCopyCatalog } from "../copy-catalog";
import { TEST_COPY } from "../engine/test-copy.fixture";
import type {
  Clock,
  CopyKey,
  CreateIssueInput,
  MediaResolver,
  TrackerIssue,
  TrackerPort,
} from "../ports";

// ── fakes ────────────────────────────────────────────────────────────────────

class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

class FakeTracker implements TrackerPort {
  created: CreateIssueInput[] = [];
  comments: Array<{ issueId: number; body: string }> = [];
  attached: Array<{ issueId: number; description: string; mediaPaths: string[] }> = [];
  private seq = 0;
  failNext = false;

  async createIssue(input: CreateIssueInput): Promise<TrackerIssue> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("tracker down");
    }
    this.created.push(input);
    const n = ++this.seq;
    return { id: 1000 + n, identifier: `TECH-${n}`, title: input.title, url: `https://t/${n}` };
  }
  async getIssue(id: number) {
    return { id, identifier: `TECH-${id - 1000}`, title: "x" };
  }
  async addComment(issueId: number, body: string) {
    this.comments.push({ issueId, body });
  }
  async attach(issueId: number, description: string, mediaPaths: string[]) {
    this.attached.push({ issueId, description, mediaPaths });
    return mediaPaths.length;
  }
  async findByIdentifier() {
    return null;
  }
}

const COPY: Record<CopyKey, string> = {
  ...TEST_COPY,
  "confirm.too_soon": "too soon",
  "confirm.in_progress": "in progress",
  "confirm.resend": "please resend",
  "ticket.created": "created {identifier} {url}",
  "ticket.already_created": "already {identifier}",
  "ticket.create_failed": "failed",
};

const collectAll: MediaResolver = { resolve: (p) => Array.from(new Set(p.filter(Boolean))) };

// ── harness ────────────────────────────────────────────────────────────────

interface Harness {
  db: Database;
  drafts: DraftRepository;
  bindings: SqliteChannelBindingStore;
  tracker: FakeTracker;
  clock: FakeClock;
  deps: Parameters<typeof createTicket>[0];
}

function harness(startTime = 1_000_000): Harness {
  // In-memory DB with the library-owned schema applied via the core hook.
  const db = new Database(":memory:");
  intakeApplySchema(db, { wal: false });
  const drafts = new SqliteDraftRepository(db);
  const bindings = new SqliteChannelBindingStore(db);
  const tracker = new FakeTracker();
  const clock = new FakeClock(startTime);
  const deps = {
    tracker,
    drafts,
    bindings,
    copy: makeCopyCatalog(COPY),
    clock,
    media: collectAll,
    identifierPrefix: "TECH",
  };
  return { db, drafts, bindings, tracker, clock, deps };
}

/** Put a chat into "summary shown now" with a ready ticket. */
function seedReadyDraft(
  h: Harness,
  chatId: string,
  overrides: Partial<IntakeDraft["ticket"]> = {},
): IntakeDraft {
  const nowIso = new Date(h.clock.now()).toISOString();
  const base = newDraft(`doc_${chatId}`, chatId, nowIso);
  base.ticket = {
    title: "Không vào được Classin",
    rawText: "Em không vào được Classin để dạy.",
    priority: "high",
    mediaPaths: [],
    ...overrides,
  };
  const shown = markSummaryShown(base, h.clock);
  h.drafts.saveRevision(shown);
  return shown;
}

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.db.close();
});

// ── confirmation protocol ────────────────────────────────────────────────────

describe("confirmation protocol", () => {
  test("confirm before a summary was shown cannot create", async () => {
    const nowIso = new Date(h.clock.now()).toISOString();
    h.drafts.saveRevision({ ...newDraft("d1", "c1", nowIso), status: "collecting" });
    const res = await createTicket(h.deps, { chatId: "c1" });
    expect(res.kind).toBe("needs_resend");
    expect(h.tracker.created).toHaveLength(0);
  });

  test("REAL INCIDENT: model self-click 1.1s after summary is rejected", async () => {
    seedReadyDraft(h, "c1");
    h.clock.advance(1_100); // gemini-flash-lite "đúng rồi" after 1.1s
    const res = await createTicket(h.deps, { chatId: "c1" });
    expect(res.kind).toBe("too_soon");
    expect(h.tracker.created).toHaveLength(0);
  });

  test("confirm accepted once >= minConfirmDelay elapsed", async () => {
    seedReadyDraft(h, "c1");
    h.clock.advance(MIN_CONFIRM_DELAY_MS);
    const res = await createTicket(h.deps, { chatId: "c1" });
    expect(res.kind).toBe("created");
    expect(h.tracker.created).toHaveLength(1);
  });

  test("REAL INCIDENT: stale confirm released after 2 min, then confirmable", async () => {
    const seeded = seedReadyDraft(h, "c1");
    // A stuck `confirmed` claim from a turn that never finished.
    const stuckIso = new Date(h.clock.now()).toISOString();
    h.drafts.saveRevision({
      ...seeded,
      revision: seeded.revision + 1,
      status: "confirmed",
      confirmingSince: stuckIso,
      updatedAt: stuckIso,
    });

    // Still inside the window → in progress, no new ticket.
    h.clock.advance(CONFIRM_STALE_MS - 1_000);
    expect((await createTicket(h.deps, { chatId: "c1" })).kind).toBe("in_progress");
    expect(h.tracker.created).toHaveLength(0);

    // Past the window → released and re-confirmable.
    h.clock.advance(2_000);
    const res = await createTicket(h.deps, { chatId: "c1" });
    expect(res.kind).toBe("created");
    expect(h.tracker.created).toHaveLength(1);
  });
});

// ── idempotent / safe creation ───────────────────────────────────────────────

describe("safe ticket creation", () => {
  test("REAL INCIDENT: double-confirm returns the SAME ticket (no duplicate)", async () => {
    seedReadyDraft(h, "c1");
    h.clock.advance(MIN_CONFIRM_DELAY_MS);
    const first = await createTicket(h.deps, { chatId: "c1" });
    expect(first.kind).toBe("created");
    const firstId = first.kind === "created" ? first.issue.identifier : "";

    const second = await createTicket(h.deps, { chatId: "c1" });
    expect(second.kind).toBe("already_created");
    expect(second.kind === "already_created" && second.issue.identifier).toBe(firstId);
    expect(h.tracker.created).toHaveLength(1); // never a second write
  });

  test("REAL INCIDENT PO-79: bare re-confirm never blanks the ticket — draft wins", async () => {
    seedReadyDraft(h, "c1", {
      title: "Order tính năng X",
      rawText: "Mô tả đầy đủ của người báo.",
      priority: "high",
    });
    h.clock.advance(MIN_CONFIRM_DELAY_MS);
    // The confirm turn re-sends an EMPTY payload plus a self-filled priority.
    const res = await createTicket(h.deps, {
      chatId: "c1",
      input: { priority: "medium", title: "", rawText: "" },
    });
    expect(res.kind).toBe("created");
    expect(h.tracker.created[0].title).toBe("Order tính năng X");
    expect(h.tracker.created[0].description).toBe("Mô tả đầy đủ của người báo.");
    expect(h.tracker.created[0].priority).toBe("high"); // not downgraded to medium
  });

  test("REAL INCIDENT TECH-637: media the draft gathered is not dropped on confirm", async () => {
    seedReadyDraft(h, "c1", { mediaPaths: ["/a.png", "/b.png"] });
    h.clock.advance(MIN_CONFIRM_DELAY_MS);
    // Confirm turn only remembers one of the paths.
    const res = await createTicket(h.deps, {
      chatId: "c1",
      input: { mediaPaths: ["/b.png", "/c.png"] },
    });
    expect(res.kind).toBe("created");
    const attach = h.tracker.attached[0];
    expect(attach.mediaPaths.sort()).toEqual(["/a.png", "/b.png", "/c.png"]);
  });

  test("REAL INCIDENT PO-88: bare confirm with no draft and no binding asks to resend", async () => {
    const res = await createTicket(h.deps, { chatId: "c1", input: {} });
    expect(res.kind).toBe("needs_resend");
    expect(h.tracker.created).toHaveLength(0);
  });

  test("bare confirm with a lost draft but an existing binding returns that ticket", async () => {
    h.bindings.saveBinding({ issueId: 42, chatId: "c1", identifier: "TECH-42", title: "cũ" });
    const res = await createTicket(h.deps, { chatId: "c1", input: {} });
    expect(res.kind).toBe("already_created");
    expect(res.kind === "already_created" && res.issue.identifier).toBe("TECH-42");
  });

  test("description = reporter verbatim; diagnosis goes to a marked bot comment", async () => {
    seedReadyDraft(h, "c1", {
      rawText: "lời nguyên văn của người báo",
      diagnosis: "suy luận của bot",
    });
    h.clock.advance(MIN_CONFIRM_DELAY_MS);
    const res = await createTicket(h.deps, { chatId: "c1" });
    expect(res.kind).toBe("created");
    expect(h.tracker.created[0].description).toBe("lời nguyên văn của người báo");
    expect(h.tracker.comments).toHaveLength(1);
    expect(h.tracker.comments[0].body).toContain("suy luận của bot");
    expect(h.tracker.comments[0].body).toContain("<!-- intake-bot -->"); // markBotComment
    // Inference never leaks into the description.
    expect(h.tracker.created[0].description).not.toContain("suy luận của bot");
  });

  test("binding saved before side effects (survives a comment path)", async () => {
    seedReadyDraft(h, "c1", { diagnosis: "x" });
    h.clock.advance(MIN_CONFIRM_DELAY_MS);
    const res = await createTicket(h.deps, { chatId: "c1" });
    expect(res.kind).toBe("created");
    const bound = h.bindings.getLatestBinding("c1", "TECH");
    expect(bound?.identifier).toBe(res.kind === "created" ? res.issue.identifier : "");
  });

  test("tracker failure keeps the draft recoverable and reports failure", async () => {
    seedReadyDraft(h, "c1");
    h.clock.advance(MIN_CONFIRM_DELAY_MS);
    h.tracker.failNext = true;
    const res = await createTicket(h.deps, { chatId: "c1" });
    expect(res.kind).toBe("failed");
    // Draft stepped back to ready_for_confirmation, so a retry works.
    const retry = await createTicket(h.deps, { chatId: "c1" });
    expect(retry.kind).toBe("created");
  });
});
