/**
 * Conversation-engine flow tests (ticket 09) — the Tiểu Linh pipeline
 * invariants, ported to run through the PUBLIC `IntakeEngine.step()` seam with a
 * fake clock, fake tracker, scripted fake extractor and a :memory: SQLite draft
 * store. Each invariant has at least one test whose name cites the incident it
 * encodes (research §2).
 *
 * NGUỒN of the scenarios: intake `lib/intake-step/pipeline.flow.test.ts`,
 * `pipeline.test.ts`, `confirmation-and-binding.test.ts`,
 * `ticket-reply-router.test.ts`, `identifier-grounding.test.ts`.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  intakeApplySchema,
  SqliteDraftRepository,
  type DraftRepository,
} from "../draft";
import { SqliteChannelBindingStore } from "../create";
import { makeCopyCatalog } from "../copy-catalog";
import { MIN_CONFIRM_DELAY_MS } from "../confirm";
import type {
  Clock,
  CreateIssueInput,
  ExtractedFields,
  ExtractInput,
  FieldExtractorPort,
  TechReviewerPort,
  TicketActionExecutorPort,
  TicketActionResult,
  TicketAction,
  TicketCommandInterpreterPort,
  TicketCommand,
  TicketCommandInput,
  OwnershipPort,
  TrackerIssue,
  TrackerPort,
} from "../ports";
import { IntakeEngine, type IntakeEngineDeps } from "./engine";
import { TEST_COPY } from "./test-copy.fixture";
import { engineTestCatalog } from "./catalog.fixture";
import type { UrgencyRules } from "../priority";
import type { StepInput } from "./types";

// ── fakes ────────────────────────────────────────────────────────────────────

class FakeClock implements Clock {
  constructor(private t = 1_000_000) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

class FakeTracker implements TrackerPort {
  created: CreateIssueInput[] = [];
  private seq = 0;
  async createIssue(input: CreateIssueInput): Promise<TrackerIssue> {
    this.created.push(input);
    const n = ++this.seq;
    return { id: 1000 + n, identifier: `TECH-${n}`, title: input.title, url: `https://t/${n}` };
  }
  async getIssue(id: number) {
    return { id, identifier: `TECH-${id - 1000}`, title: "x" };
  }
  async addComment() {}
  async attach(_i: number, _d: string, m: string[]) {
    return m.length;
  }
  async findByIdentifier() {
    return null;
  }
}

/** Scripted extractor: returns the queued result for each call, in order. */
class ScriptedExtractor implements FieldExtractorPort {
  private queue: ExtractedFields[] = [];
  calls: ExtractInput[] = [];
  push(...fields: ExtractedFields[]) {
    this.queue.push(...fields);
    return this;
  }
  async extract(input: ExtractInput): Promise<ExtractedFields> {
    this.calls.push(input);
    return this.queue.shift() ?? { userIntent: "chitchat" };
  }
}

const URGENCY: UrgencyRules = {
  levels: ["Low", "Medium", "High", "Urgent"],
  floors: [{ when: { blocksPayment: true }, minLevel: "Urgent", reason: "payment blocked" }],
  ceilings: [],
};

// ── harness ───────────────────────────────────────────────────────────────────

interface Harness {
  engine: IntakeEngine;
  clock: FakeClock;
  tracker: FakeTracker;
  extractor: ScriptedExtractor;
  drafts: DraftRepository;
  bindings: SqliteChannelBindingStore;
  deps: IntakeEngineDeps;
}

function makeHarness(overrides: Partial<IntakeEngineDeps> = {}): Harness {
  const db = new Database(":memory:");
  intakeApplySchema(db);
  const clock = new FakeClock();
  const tracker = new FakeTracker();
  const extractor = new ScriptedExtractor();
  const drafts = new SqliteDraftRepository(db);
  const bindings = new SqliteChannelBindingStore(db);
  let idCounter = 0;
  const deps: IntakeEngineDeps = {
    tracker,
    drafts,
    bindings,
    copy: makeCopyCatalog(TEST_COPY),
    clock,
    extractor,
    catalog: engineTestCatalog,
    variant: "tech",
    urgencyRules: URGENCY,
    identifierPrefix: "TECH",
    genDocId: () => `doc-${++idCounter}`,
    ...overrides,
  };
  return { engine: new IntakeEngine(deps), clock, tracker, extractor, drafts, bindings, deps };
}

const CHAT = "telegram:555";

function report(symptoms: string[], extra: Partial<ExtractedFields> = {}): ExtractedFields {
  return { userIntent: "report_issue", symptoms, title: symptoms[0], ...extra };
}

async function driveToSummary(h: Harness, text = "login is broken"): Promise<void> {
  h.extractor.push(report(["login is broken"], { values: { van_de: "login is broken" } }));
  const out = await h.engine.step({ chatId: CHAT, message: text });
  expect(out.outcome).toBe("summary");
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("IntakeEngine.step — collection → summary → create", () => {
  let h: Harness;
  beforeEach(() => (h = makeHarness()));

  test("incomplete report asks the next question (gate ask-back)", async () => {
    h.extractor.push({ userIntent: "report_issue", symptoms: [], title: null });
    const out = await h.engine.step({ chatId: CHAT, message: "help me" });
    expect(out.outcome).toBe("asked");
    expect(out.messages[0].text).toContain("What's the problem?");
  });

  test("complete report shows a summary with a confirm button", async () => {
    await driveToSummary(h);
    const latest = h.drafts.getLatestByChatId(CHAT)!;
    expect(latest.status).toBe("ready_for_confirmation");
    expect(latest.summaryShownAt).toBeDefined();
  });

  test("MIN_CONFIRM_DELAY_MS: a confirm <5s after the summary is rejected (gemini 1.1s self-click)", async () => {
    await driveToSummary(h);
    h.extractor.push({ userIntent: "confirm" });
    h.clock.advance(1_100); // 1.1s — the measured self-click
    const out = await h.engine.step({ chatId: CHAT, message: "đúng rồi" });
    expect(out.outcome).toBe("too_soon");
    expect(h.tracker.created).toHaveLength(0);
  });

  test("confirm after the delay creates exactly one ticket; description = verbatim text (ADR-0010)", async () => {
    await driveToSummary(h);
    h.extractor.push({ userIntent: "confirm" });
    h.clock.advance(MIN_CONFIRM_DELAY_MS + 1);
    const out = await h.engine.step({ chatId: CHAT, message: "yes" });
    expect(out.outcome).toBe("created");
    expect(h.tracker.created).toHaveLength(1);
    expect(h.tracker.created[0].description).toBe("login is broken");
    expect(out.issue?.identifier).toBe("TECH-1");
  });

  test("idempotent create: a second confirm returns the same ticket, never a duplicate", async () => {
    await driveToSummary(h);
    h.extractor.push({ userIntent: "confirm" }, { userIntent: "confirm" });
    h.clock.advance(MIN_CONFIRM_DELAY_MS + 1);
    const first = await h.engine.step({ chatId: CHAT, message: "yes" });
    const second = await h.engine.step({ chatId: CHAT, message: "yes again" });
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("already_created");
    expect(h.tracker.created).toHaveLength(1);
    expect(second.issue?.identifier).toBe("TECH-1");
  });

  test("channel envelope never enters the ticket description (TECH-924)", async () => {
    const enveloped = [
      'Sender: Minh (telegram:555), username: minh (untrusted metadata)',
      "the app crashes on open",
    ].join("\n");
    h.extractor.push(report(["the app crashes on open"], { values: { van_de: "the app crashes on open" } }));
    await h.engine.step({ chatId: CHAT, message: enveloped });
    // the extractor must have seen the STRIPPED text, not the envelope
    expect(h.extractor.calls[0].text).not.toContain("untrusted");
    expect(h.extractor.calls[0].text).not.toContain("telegram:555");
    expect(h.extractor.calls[0].text).toContain("the app crashes on open");
  });

  test("description cap: a huge paste is truncated to MAX_DESCRIPTION_CHARS", async () => {
    const huge = "x".repeat(10_000);
    h.extractor.push(report([huge], { title: "big", values: { van_de: "big" } }));
    await h.engine.step({ chatId: CHAT, message: huge });
    const latest = h.drafts.getLatestByChatId(CHAT)!;
    expect(latest.ticket.rawText.length).toBeLessThanOrEqual(6001); // 6000 + ellipsis
  });
});

describe("IntakeEngine.step — priority (floor/ceiling + requested)", () => {
  test("blocksPayment floor raises the created ticket to Urgent", async () => {
    const h = makeHarness();
    h.extractor.push(report(["cannot pay"], { values: { van_de: "cannot pay" }, evidence: { blocksPayment: true } }));
    await h.engine.step({ chatId: CHAT, message: "payment fails" });
    h.extractor.push({ userIntent: "confirm" });
    h.clock.advance(MIN_CONFIRM_DELAY_MS + 1);
    await h.engine.step({ chatId: CHAT, message: "yes" });
    expect(h.tracker.created[0].priority).toBe("urgent");
  });

  test("requested priority honoured only with a reason (29/09 decision)", async () => {
    const h = makeHarness();
    h.extractor.push(
      report(["slow page"], { values: { van_de: "slow page" }, requestedPriority: "high", requestedPriorityReason: "PH complaining all week" }),
    );
    await h.engine.step({ chatId: CHAT, message: "slow, please prioritise, PH complaining all week" });
    h.extractor.push({ userIntent: "confirm" });
    h.clock.advance(MIN_CONFIRM_DELAY_MS + 1);
    await h.engine.step({ chatId: CHAT, message: "yes" });
    expect(h.tracker.created[0].priority).toBe("high");
  });

  test("requested priority with NO reason is ignored", async () => {
    const h = makeHarness();
    h.extractor.push(report(["slow page"], { values: { van_de: "slow page" }, requestedPriority: "urgent", requestedPriorityReason: null }));
    await h.engine.step({ chatId: CHAT, message: "make it urgent" });
    h.extractor.push({ userIntent: "confirm" });
    h.clock.advance(MIN_CONFIRM_DELAY_MS + 1);
    await h.engine.step({ chatId: CHAT, message: "yes" });
    expect(h.tracker.created[0].priority).toBe("medium");
  });
});

describe("IntakeEngine.step — parking", () => {
  test("identifier-conflict parks and asks new-incident-or-append (TECH-928)", async () => {
    const h = makeHarness();
    // incident A: order with student account 0900000003
    h.extractor.push(report(["order DH000001 wrong"], { values: { van_de: "order wrong" }, identifiers: { studentAccount: "0900000003" } }));
    await h.engine.step({ chatId: CHAT, message: "order DH000001 wrong, account 0900000003" });
    // incident B arrives with a CONFLICTING student account
    h.extractor.push(report(["another order"], { identifiers: { studentAccount: "0900000004" } }));
    const out = await h.engine.step({ chatId: CHAT, message: "also 0900000004 has a problem" });
    expect(out.outcome).toBe("parked");
    expect(out.messages[0].buttons).toBeTruthy();
    // B was NOT merged: the draft still carries A's account
    const latest = h.drafts.getLatestByChatId(CHAT)!;
    expect(latest.record?.values.studentAccount).toBe("0900000003");
  });

  test("same number shortened/with area code is NOT a conflict (TECH-928 digit-subset)", async () => {
    const h = makeHarness();
    h.extractor.push(report(["issue"], { values: { van_de: "issue" }, identifiers: { studentAccount: "84900000003" } }));
    await h.engine.step({ chatId: CHAT, message: "account 84900000003" });
    // "900000003" is a digit-subset of "84900000003" — same number, not a conflict
    h.extractor.push({ userIntent: "provide_info", symptoms: [], identifiers: { studentAccount: "900000003" } });
    const out = await h.engine.step({ chatId: CHAT, message: "it's 900000003" });
    expect(out.outcome).not.toBe("parked");
  });

  test("full report while another draft is mid-collection parks (E2E 28/09)", async () => {
    const h = makeHarness();
    // draft A still collecting (incomplete)
    h.extractor.push({ userIntent: "report_issue", symptoms: ["homework missing"], title: "homework" });
    await h.engine.step({ chatId: CHAT, message: "homework is missing" });
    // a COMPLETE new report arrives
    h.extractor.push(report(["CRM cannot call out"], { values: { van_de: "CRM broken" } }));
    const out = await h.engine.step({ chatId: CHAT, message: "CRM cannot call out at all" });
    expect(out.outcome).toBe("parked");
  });

  test("pressing New incident starts a fresh draft from the held message (TECH-928)", async () => {
    const h = makeHarness();
    h.extractor.push(report(["order A"], { values: { van_de: "order A" }, identifiers: { studentAccount: "0900000003" } }));
    await h.engine.step({ chatId: CHAT, message: "order A, 0900000003" });
    h.extractor.push(report(["order B"], { values: { van_de: "order B" }, identifiers: { studentAccount: "0900000004" } }));
    await h.engine.step({ chatId: CHAT, message: "order B, 0900000004" });
    // The park replay re-extracts the held payload:
    h.extractor.push(report(["order B"], { values: { van_de: "order B" }, identifiers: { studentAccount: "0900000004" } }));
    const out = await h.engine.step({ chatId: CHAT, message: "New incident" });
    expect(out.outcome).toBe("summary");
    const latest = h.drafts.getLatestByChatId(CHAT)!;
    expect(latest.record?.values.studentAccount).toBe("0900000004");
  });
});

describe("IntakeEngine.step — existing-ticket writes (ADR-0008)", () => {
  function commandPort(script: TicketCommand[]): TicketCommandInterpreterPort {
    let i = 0;
    return {
      async interpret(_input: TicketCommandInput) {
        return script[i++] ?? { action: "new" };
      },
    };
  }

  function actionPort(sink: TicketAction[]): TicketActionExecutorPort {
    return {
      async execute(action: TicketAction): Promise<TicketActionResult> {
        sink.push(action);
        return { ok: true, summary: "done" };
      },
    };
  }

  async function createOne(h: Harness): Promise<void> {
    h.extractor.push(report(["login broken"], { values: { van_de: "login broken" } }));
    await h.engine.step({ chatId: CHAT, message: "login broken" });
    h.extractor.push({ userIntent: "confirm" });
    h.clock.advance(MIN_CONFIRM_DELAY_MS + 1);
    await h.engine.step({ chatId: CHAT, message: "yes" });
  }

  test("append to own ticket shows a preview + button, writes nothing yet (ADR-0008, TECH-795)", async () => {
    const executed: TicketAction[] = [];
    const h = makeHarness({
      commands: commandPort([{ action: "append", identifier: "TECH-1", content: "order is DH000002" }]),
      actions: actionPort(executed),
    });
    await createOne(h);
    const out = await h.engine.step({ chatId: CHAT, message: "TECH-1 the order is DH000002" });
    expect(out.outcome).toBe("action_preview");
    expect(out.messages[0].buttons).toBeTruthy();
    expect(executed).toHaveLength(0); // NOT written until the button is pressed
  });

  test("append executes only on an exact button match (ADR-0008, TECH-975/1013)", async () => {
    const executed: TicketAction[] = [];
    const h = makeHarness({
      commands: commandPort([{ action: "append", identifier: "TECH-1", content: "order is DH000002" }]),
      actions: actionPort(executed),
    });
    await createOne(h);
    await h.engine.step({ chatId: CHAT, message: "TECH-1 the order is DH000002" });
    // a non-matching reply must NOT execute
    const noop = await h.engine.step({ chatId: CHAT, message: "actually never mind for now" });
    expect(executed).toHaveLength(0);
    expect(noop.outcome).toBe("action_preview");
    // the exact confirm label DOES execute
    const label = h.deps.copy.text("button.confirm_append", { identifier: "TECH-1" });
    const done = await h.engine.step({ chatId: CHAT, message: label });
    expect(done.outcome).toBe("action_done");
    expect(executed).toHaveLength(1);
    expect(executed[0].kind).toBe("append");
  });

  test("cancel button clears the pending action, writes nothing", async () => {
    const executed: TicketAction[] = [];
    const h = makeHarness({
      commands: commandPort([{ action: "edit", identifier: "TECH-1", instruction: "fix the phone number" }]),
      actions: actionPort(executed),
    });
    await createOne(h);
    await h.engine.step({ chatId: CHAT, message: "edit TECH-1 phone is wrong" });
    const out = await h.engine.step({ chatId: CHAT, message: h.deps.copy.text("button.cancel_action") });
    expect(out.outcome).toBe("action_canceled");
    expect(executed).toHaveLength(0);
    expect(h.drafts.getLatestByChatId(CHAT)!.pendingTicketAction).toBeUndefined();
  });

  test("own-ticket-only edits; someone else's ticket gets status only (ADR-0008 §6)", async () => {
    const executed: TicketAction[] = [];
    const notOwner: OwnershipPort = { isOwnTicket: () => false };
    const h = makeHarness({
      commands: commandPort([{ action: "edit", identifier: "TECH-9", instruction: "change title" }]),
      actions: actionPort(executed),
      ownership: notOwner,
    });
    // bind an unrelated ticket so TECH-9 resolves as a candidate but not owned
    h.bindings.saveBinding({ issueId: 2009, chatId: "telegram:999", identifier: "TECH-9" });
    const out = await h.engine.step({ chatId: CHAT, message: "edit TECH-9 change its title" });
    expect(out.outcome).toBe("not_owner");
    expect(executed).toHaveLength(0);
  });

  test("follow-up never overwrites a created ticket's identifiers (E2E 28/09, TECH-956)", async () => {
    const executed: TicketAction[] = [];
    const h = makeHarness({
      commands: commandPort([{ action: "append", identifier: "TECH-1", content: "extra detail" }]),
      actions: actionPort(executed),
    });
    // create with student account 1000002 captured
    h.extractor.push(report(["issue"], { values: { van_de: "issue", studentAccount: "1000002" } }));
    await h.engine.step({ chatId: CHAT, message: "issue, account 1000002" });
    h.extractor.push({ userIntent: "confirm" });
    h.clock.advance(MIN_CONFIRM_DELAY_MS + 1);
    await h.engine.step({ chatId: CHAT, message: "yes" });
    const createdDraft = h.drafts.getByDocId("doc-1")!;
    // a follow-up carrying a DIFFERENT account routes to append (a comment), and
    // the created ticket's own captured identifier is untouched.
    await h.engine.step({ chatId: CHAT, message: "TECH-1 also note 0900000004" });
    expect(createdDraft.record?.values.studentAccount ?? "1000002").toBe("1000002");
    // nothing overwrote the created revision's identifier
    const stored = h.drafts.getLatestByChatId(CHAT)!;
    expect(stored.pendingTicketAction?.kind).toBe("append"); // goes to a comment, not the id
  });
});

describe("IntakeEngine.step — tech review (one round)", () => {
  test("tech review asks once, any answer proceeds to summary", async () => {
    const reviewer: TechReviewerPort = {
      async review() {
        return { missing: ["order code"], question: "Which order code? Reply 'none' and I'll file it." };
      },
    };
    const h = makeHarness({ techReviewer: reviewer });
    h.extractor.push(report(["login broken"], { values: { van_de: "login broken" } }));
    const asked = await h.engine.step({ chatId: CHAT, message: "login broken" });
    expect(asked.outcome).toBe("asked");
    expect(asked.messages[0].text).toContain("order code");
    // answering (even "none") proceeds to the summary
    h.extractor.push({ userIntent: "provide_info", symptoms: [] });
    const out = await h.engine.step({ chatId: CHAT, message: "none" });
    expect(out.outcome).toBe("summary");
  });

  test("tech reviewer failure never blocks ticket creation", async () => {
    const reviewer: TechReviewerPort = {
      async review() {
        throw new Error("llm down");
      },
    };
    const h = makeHarness({ techReviewer: reviewer });
    h.extractor.push(report(["login broken"], { values: { van_de: "login broken" } }));
    const out = await h.engine.step({ chatId: CHAT, message: "login broken" });
    expect(out.outcome).toBe("summary");
  });
});

describe("IntakeEngine.step — expired draft", () => {
  test("an expired draft closes and a later message starts fresh", async () => {
    const h = makeHarness({ draftTtlMs: 1_000 });
    h.extractor.push({ userIntent: "report_issue", symptoms: ["x"], title: "x" });
    await h.engine.step({ chatId: CHAT, message: "something" });
    h.clock.advance(5_000); // past the 1s TTL
    h.extractor.push({ userIntent: "report_issue", symptoms: [], title: null });
    const out = await h.engine.step({ chatId: CHAT, message: "new matter" });
    expect(out.outcome).toBe("asked"); // fresh draft, asks the opening question
    // the old draft was closed
    const docs = h.drafts.getByDocId("doc-1");
    expect(docs?.status).toBe("expired");
  });
});

describe("IntakeEngine.step — /new flag parks the current draft", () => {
  test("forceNew parks the open draft and opens a new one", async () => {
    const h = makeHarness();
    h.extractor.push({ userIntent: "report_issue", symptoms: ["first"], title: "first" });
    await h.engine.step({ chatId: CHAT, message: "first problem" });
    h.extractor.push(report(["second"], { values: { van_de: "second" } }));
    const out = await h.engine.step({ chatId: CHAT, message: "second problem", forceNew: true } as StepInput);
    expect(out.outcome).toBe("summary");
    const latest = h.drafts.getLatestByChatId(CHAT)!;
    expect(latest.parkedDocId).toBe("doc-1");
  });
});
