/**
 * Bộ khung kiểm thử cho engine hội thoại — dùng chung cho mọi file test của
 * `src/intake/engine`. Mọi thứ ở đây là BẠN GIẢ: đồng hồ, tracker, bộ trích
 * xuất có kịch bản. Test chỉ kiểm tra logic của engine qua cổng công khai
 * `step()`.
 */
import { Database } from "bun:sqlite";
import { intakeApplySchema, SqliteDraftRepository, type DraftRepository } from "../draft";
import { SqliteChannelBindingStore } from "../create";
import { makeCopyCatalog } from "../copy-catalog";
import type {
  Clock,
  CreateIssueInput,
  ExtractedFields,
  ExtractInput,
  FieldExtractorPort,
  TrackerIssue,
  Priority,
  TrackerPort,
} from "../ports";
import type { ProjectAssignee } from "../../itsaplan";
import { IntakeEngine, type IntakeEngineDeps } from "./engine";
import { TEST_COPY } from "./test-copy.fixture";
import { engineTestCatalog } from "./catalog.fixture";
import type { UrgencyRules } from "../priority";

export class FakeClock implements Clock {
  constructor(private t = 1_000_000) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

export class FakeTracker implements TrackerPort {
  created: CreateIssueInput[] = [];
  comments: Array<{ issueId: number; body: string }> = [];
  updates: Array<{
    issueId: number;
    patch: { priority?: Priority; title?: string; description?: string };
  }> = [];
  closedIssues: Set<number> = new Set();
  issueStates: Map<
    number,
    { stateType?: string; state?: "open" | "resolved" | "done" | "canceled" }
  > = new Map();
  assignees: ProjectAssignee[] = [];
  timelines: Map<number, unknown[]> = new Map();
  issues: Map<number, TrackerIssue> = new Map();
  private seq = 0;

  async createIssue(input: CreateIssueInput): Promise<TrackerIssue> {
    this.created.push(input);
    const n = ++this.seq;
    const issue: TrackerIssue = {
      id: 1000 + n,
      identifier: `TECH-${n}`,
      title: input.title,
      url: `https://t/${n}`,
      priority: input.priority,
    };
    this.issues.set(issue.id, issue);
    return issue;
  }
  async getIssue(id: number): Promise<TrackerIssue | null> {
    return this.issues.get(id) ?? { id, identifier: `TECH-${id - 1000}`, title: "x" };
  }
  async addComment(issueId: number, body: string): Promise<void> {
    this.comments.push({ issueId, body });
  }
  async attach(_i: number, _d: string, m: string[]): Promise<number> {
    return m.length;
  }
  async findByIdentifier(identifier: string): Promise<TrackerIssue | null> {
    for (const iss of this.issues.values()) {
      if (iss.identifier.toUpperCase() === identifier.toUpperCase()) return iss;
    }
    return null;
  }
  async updateIssue(
    issueId: number,
    patch: { priority?: Priority; title?: string; description?: string },
  ): Promise<void> {
    this.updates.push({ issueId, patch });
    const iss = this.issues.get(issueId);
    if (iss) {
      if (patch.priority) iss.priority = patch.priority;
      if (patch.title) iss.title = patch.title;
    }
  }
  async isIssueClosed(issueId: number): Promise<boolean> {
    if (this.closedIssues.has(issueId)) return true;
    const s = this.issueStates.get(issueId);
    return (
      s?.state === "done" ||
      s?.state === "canceled" ||
      s?.stateType === "completed" ||
      s?.stateType === "canceled"
    );
  }
  async getIssueState(issueId: number) {
    return (
      this.issueStates.get(issueId) ??
      (this.closedIssues.has(issueId)
        ? { state: "done" as const, stateType: "completed" }
        : { state: "open" as const, stateType: "started" })
    );
  }
  async getProjectAssignees() {
    return this.assignees;
  }
  async getIssueTimeline(issueId: number) {
    return this.timelines.get(issueId) ?? [];
  }
}

/** Bộ trích xuất có kịch bản: trả lần lượt các kết quả đã đẩy vào. */
export class ScriptedExtractor implements FieldExtractorPort {
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

export const URGENCY: UrgencyRules = {
  levels: ["Low", "Medium", "High", "Urgent"],
  floors: [{ when: { blocksPayment: true }, minLevel: "Urgent", reason: "payment blocked" }],
  ceilings: [],
};

export interface Harness {
  engine: IntakeEngine;
  clock: FakeClock;
  tracker: FakeTracker;
  extractor: ScriptedExtractor;
  drafts: DraftRepository;
  bindings: SqliteChannelBindingStore;
  deps: IntakeEngineDeps;
}

export function makeHarness(overrides: Partial<IntakeEngineDeps> = {}): Harness {
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

export const CHAT = "telegram:555";

export function report(symptoms: string[], extra: Partial<ExtractedFields> = {}): ExtractedFields {
  return { userIntent: "report_issue", symptoms, title: symptoms[0], ...extra };
}
