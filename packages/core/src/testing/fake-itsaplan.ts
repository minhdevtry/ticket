/**
 * Itsaplan giả cho test: một HTTP server thật (Bun.serve, cổng ngẫu nhiên) nói đúng
 * giao thức agent-runs và đủ phần tracker (project, issue, comment) cho
 * `ItsaplanClient`. Dùng để test bot đầu-cuối mà không đụng dịch vụ thật.
 *
 * Mô phỏng các ngữ nghĩa quan trọng của server thật: lease + số lần thử, 404 khi run
 * không phải của agent/đã kết thúc/sai `attempt`, 409 khi claim với agent có invocation
 * URL, 401 khi sai key, trace theo `offset` idempotent, run cùng issue đi tuần tự.
 * Xem `docs/reference/agent-runs.md`.
 */

export interface FakeColumn {
  id: number;
  name: string;
  stateType: "backlog" | "unstarted" | "started" | "completed" | "canceled";
  position: number;
}

export interface FakeIssue {
  id: number;
  projectId: number;
  sequenceNumber: number;
  identifier: string;
  title: string;
  description: string;
  priority: string | null;
  columnId: number;
  assigneeUserId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Lúc issue vào cột hiện tại (như `statusSince` của server); test đặt tay khi cần. */
  statusSince?: string | null;
}

export interface FakeComment {
  id: number;
  issueId: number;
  body: string;
  replyToId: number | null;
  actorName: string;
  actorUserId: string;
  createdAt: string;
}

export interface FakeRun {
  id: number;
  trigger: string;
  prompt: string;
  systemPrompt: string;
  issueId: number | null;
  issueIdentifier: string | null;
  status: "pending" | "success" | "failed";
  attempts: number;
  /** ms epoch: run được claim khi `leaseUntil <= now`. */
  leaseUntil: number;
  executing: boolean;
  output: string | null;
  error: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  events: unknown[];
  nextOffset: number;
  sessionId: string | null;
}

/** Webhook đăng ký trên dự án của fake. */
export interface FakeWebhook {
  id: number;
  projectId: number;
  url: string;
  secret: string;
  events: string[];
  isActive: boolean;
  createdAt: string;
}

export interface FakeRequest {
  method: string;
  path: string;
  body: unknown;
  apiKey: string | null;
}

export interface FakeItsaplanOptions {
  /** Key của agent. Mặc định `agent-key-test`. */
  agentKey?: string;
  projectKey?: string;
  /** Slug team chứa dự án. Mặc định `tech`; dự án nằm trong team này. */
  teamSlug?: string;
  /**
   * Cho phép khoá trần (`/projects/TECH`). Mặc định false: giống nhiều team có khoá trùng,
   * khoá trần là mơ hồ nên fake trả 404 và test bắt được bot quên dùng ref đủ `team.KEY`.
   */
  allowBareKeys?: boolean;
  /** Thời gian lease sau mỗi claim/heartbeat (ms). Mặc định 300 000 như server thật. */
  leaseMs?: number;
  /** Số lần thử tối đa trước khi server tự đánh failed. Mặc định 3. */
  maxAttempts?: number;
  /** Mô phỏng agent có invocation URL: `/claim` trả 409. */
  invocationUrl?: boolean;
  /** Username của agent trong khung prompt mention. Mặc định `testbot`. */
  agentUsername?: string;
  /**
   * Key agent có quyền quản lý webhook không. Mặc định false như server thật (key agent thường
   * không có quyền này): `/webhooks` trả 403 cho key agent.
   */
  agentCanManageWebhooks?: boolean;
  /** Key thứ hai có quyền webhook (mô phỏng `ITSAPLAN_WEBHOOK_KEY`). Không đặt thì không có. */
  webhookKey?: string;
  /**
   * Cách POST tạo webhook xử lý trường `secret` do client gửi: `ignore` (mặc định: server tự cấp,
   * bỏ qua trường lạ), `accept` (dùng secret của client) hoặc `reject` (400 vì trường lạ).
   */
  webhookSecretMode?: "ignore" | "accept" | "reject";
}

export interface FaultRule {
  match: RegExp;
  status: number;
  /** Số lần áp dụng (mặc định 1). */
  times: number;
  headers?: Record<string, string>;
}

const DEFAULT_COLUMNS: FakeColumn[] = [
  { id: 1, name: "Backlog", stateType: "backlog", position: 0 },
  { id: 2, name: "Cần phân loại", stateType: "unstarted", position: 1 },
  { id: 3, name: "Đang xử lý", stateType: "started", position: 2 },
  { id: 4, name: "Resolved", stateType: "completed", position: 3 },
  { id: 5, name: "Done", stateType: "completed", position: 4 },
];

/** Dựng khung prompt của một run mention theo cấu trúc server thật. */
export function frameMentionPrompt(input: {
  identifier: string;
  title: string;
  issueId: number;
  commentId: number;
  comment: string;
  threadContext?: string;
}): string {
  const lines = [
    `You were mentioned in a comment on issue ${input.identifier} "${input.title}" of your project.`,
    "Work out what the comment is asking for and do it with your tools, then reply by",
    `adding one comment to the issue with the add_comment tool (issueId ${input.issueId}, replyToId ${input.commentId}) with the`,
    "result or answer. Keep it short.",
    "Do not mention yourself.",
  ];
  if (input.threadContext) {
    lines.push(
      "",
      "The comment is a reply. The comments above it in the thread, oldest first:",
      "",
      input.threadContext,
    );
  }
  lines.push("", "The comment that mentioned you:", "", input.comment);
  return lines.join("\n");
}

export class FakeItsaplan {
  readonly agentKey: string;
  readonly projectKey: string;
  readonly teamSlug: string;
  /** Ref đủ `<team>.<KEY>` của dự án. */
  get ref(): string {
    return `${this.teamSlug}.${this.projectKey}`;
  }
  readonly runs: FakeRun[] = [];
  readonly issues: FakeIssue[] = [];
  readonly comments: FakeComment[] = [];
  readonly columns: FakeColumn[] = DEFAULT_COLUMNS.map((c) => ({ ...c }));
  readonly requests: FakeRequest[] = [];
  readonly webhooks: FakeWebhook[] = [];
  readonly faults: FaultRule[] = [];
  /** Số lần mỗi key `<METHOD> <path>` được gọi. */
  readonly hits = new Map<string, number>();

  private readonly allowBareKeys: boolean;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly invocationUrl: boolean;
  private readonly agentUsername: string;
  private readonly agentCanManageWebhooks: boolean;
  private readonly webhookKey: string | null;
  private readonly webhookSecretMode: "ignore" | "accept" | "reject";
  private nextWebhookId = 1;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private nextRunId = 1;
  private nextIssueSeq = 1;
  private nextIssueId = 100;
  private nextCommentId = 1000;

  constructor(options: FakeItsaplanOptions = {}) {
    this.agentKey = options.agentKey ?? "agent-key-test";
    this.projectKey = options.projectKey ?? "TECH";
    this.teamSlug = options.teamSlug ?? "tech";
    this.allowBareKeys = options.allowBareKeys ?? false;
    this.leaseMs = options.leaseMs ?? 300_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.invocationUrl = options.invocationUrl ?? false;
    this.agentUsername = options.agentUsername ?? "testbot";
    this.agentCanManageWebhooks = options.agentCanManageWebhooks ?? false;
    this.webhookKey = options.webhookKey ?? null;
    this.webhookSecretMode = options.webhookSecretMode ?? "ignore";
  }

  /** Bật server, trả URL gốc. */
  start(): string {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => this.handle(req),
    });
    return this.baseUrl;
  }

  get baseUrl(): string {
    if (!this.server) throw new Error("FakeItsaplan chưa start()");
    return `http://127.0.0.1:${this.server.port}`;
  }

  async stop(): Promise<void> {
    await this.server?.stop(true);
    this.server = null;
  }

  /** Chèn lỗi: `times` request đầu khớp `match` (theo `METHOD /path`) trả `status`. */
  fail(match: RegExp, status: number, times = 1, headers?: Record<string, string>): void {
    this.faults.push({ match, status, times, headers });
  }

  /**
   * Thêm issue. `projectId` khác 1 mô phỏng issue của dự án khác (mặc định dự án của fake có
   * id 1); `identifier` ghi đè mã (vd issue đã chuyển sang `OTHER-1`).
   */
  addIssue(input: {
    title: string;
    description?: string;
    columnId?: number;
    projectId?: number;
    identifier?: string;
  }): FakeIssue {
    const seq = this.nextIssueSeq++;
    const now = new Date().toISOString();
    const issue: FakeIssue = {
      id: this.nextIssueId++,
      projectId: input.projectId ?? 1,
      sequenceNumber: seq,
      identifier: input.identifier ?? `${this.projectKey}-${seq}`,
      title: input.title,
      description: input.description ?? "",
      priority: null,
      columnId: input.columnId ?? 1,
      assigneeUserId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.issues.push(issue);
    return issue;
  }

  addComment(issueId: number, body: string, replyToId: number | null = null): FakeComment {
    const comment: FakeComment = {
      id: this.nextCommentId++,
      issueId,
      body,
      replyToId,
      actorName: "Người dùng thử",
      actorUserId: "user-1",
      createdAt: new Date().toISOString(),
    };
    this.comments.push(comment);
    return comment;
  }

  /** Xếp một run vào hàng đợi, giống khi itsaplan tạo run. */
  enqueueRun(input: {
    trigger: string;
    prompt: string;
    issueId?: number | null;
    systemPrompt?: string;
  }): FakeRun {
    const issue = input.issueId == null ? null : this.issues.find((i) => i.id === input.issueId);
    const run: FakeRun = {
      id: this.nextRunId++,
      trigger: input.trigger,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt ?? "## Run mode\nYou are running autonomously.\n",
      issueId: issue?.id ?? null,
      issueIdentifier: issue?.identifier ?? null,
      status: "pending",
      attempts: 0,
      leaseUntil: 0,
      executing: false,
      output: null,
      error: null,
      usage: null,
      events: [],
      nextOffset: 0,
      sessionId: null,
    };
    this.runs.push(run);
    return run;
  }

  /** Người dùng comment `@agent` trên issue: lưu comment và xếp run `mention`. */
  mention(issueId: number, text: string): FakeRun {
    const issue = this.issues.find((i) => i.id === issueId);
    if (!issue) throw new Error(`Không có issue ${issueId}`);
    const body = `@${this.agentUsername} ${text}`;
    const comment = this.addComment(issueId, body);
    return this.enqueueRun({
      trigger: "mention",
      issueId,
      prompt: frameMentionPrompt({
        identifier: issue.identifier,
        title: issue.title,
        issueId,
        commentId: comment.id,
        comment: body,
      }),
    });
  }

  run(id: number): FakeRun {
    const run = this.runs.find((r) => r.id === id);
    if (!run) throw new Error(`Không có run ${id}`);
    return run;
  }

  /** Số request khớp `METHOD /path` (chuỗi hoặc regex). */
  count(match: string | RegExp): number {
    return this.requests.filter((r) => {
      const key = `${r.method} ${r.path}`;
      return typeof match === "string" ? key === match : match.test(key);
    }).length;
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private json(body: unknown, status = 200): Response {
    return Response.json(body, { status });
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const key = `${req.method} ${path}`;
    let body: unknown;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const text = await req.text();
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
    }
    const apiKey = req.headers.get("x-api-key");
    this.requests.push({ method: req.method, path, body, apiKey });
    this.hits.set(key, (this.hits.get(key) ?? 0) + 1);

    const isWebhookKey = this.webhookKey !== null && apiKey === this.webhookKey;
    if (apiKey !== this.agentKey && !isWebhookKey) return this.json({ error: "Unauthorized" }, 401);
    const canWebhook = isWebhookKey || this.agentCanManageWebhooks;

    const fault = this.faults.find((f) => f.times > 0 && f.match.test(key));
    if (fault) {
      fault.times--;
      return new Response(JSON.stringify({ error: "injected" }), {
        status: fault.status,
        headers: fault.headers,
      });
    }

    const b = (body ?? {}) as Record<string, any>;
    let m: RegExpMatchArray | null = null;
    const is = (re: RegExp): boolean => {
      m = key.match(re);
      return m !== null;
    };

    if (key === "POST /agent-runs/claim") return this.claim();
    if (is(/^POST \/agent-runs\/(\d+)\/heartbeat$/)) {
      return this.heartbeat(Number(m![1]), b.attempt);
    }
    if (is(/^POST \/agent-runs\/(\d+)\/result$/)) return this.result(Number(m![1]), b);
    if (is(/^POST \/agent-runs\/(\d+)\/events$/)) return this.events(Number(m![1]), b);

    // ── webhook (cần quyền riêng) ──
    if (
      is(/^(?:GET|POST) \/projects\/([^/]+)\/webhooks$/) ||
      is(/^(?:PATCH|DELETE) \/webhooks\/(\d+)$/)
    ) {
      if (!canWebhook) return this.json({ error: "Forbidden: webhook permission required" }, 403);
      if (key.startsWith("GET ")) {
        if (!this.resolves(m![1])) return this.json({ error: "Project not found" }, 404);
        return this.json(this.webhooks);
      }
      if (key.startsWith("POST ")) {
        if (!this.resolves(m![1])) return this.json({ error: "Project not found" }, 404);
        if (this.webhookSecretMode === "reject" && "secret" in b) {
          return this.json({ error: "Unknown field: secret" }, 400);
        }
        const hook: FakeWebhook = {
          id: this.nextWebhookId++,
          projectId: 1,
          url: String(b.url ?? ""),
          secret:
            this.webhookSecretMode === "accept" && typeof b.secret === "string"
              ? b.secret
              : `whsec_fake${this.nextWebhookId}`,
          events: Array.isArray(b.events) ? b.events.map(String) : [],
          isActive: b.isActive !== false,
          createdAt: new Date().toISOString(),
        };
        this.webhooks.push(hook);
        return this.json(hook, 201);
      }
      const hook = this.webhooks.find((w) => w.id === Number(m![1]));
      if (!hook) return this.json({ error: "Not found" }, 404);
      if (key.startsWith("DELETE ")) {
        this.webhooks.splice(this.webhooks.indexOf(hook), 1);
        return new Response(null, { status: 204 });
      }
      Object.assign(hook, b);
      return this.json(hook);
    }

    // ── tracker tối thiểu ──
    if (is(/^GET \/projects\/([^/]+)$/)) {
      if (!this.resolves(m![1])) return this.json({ error: "Project not found" }, 404);
      return this.json({
        id: 1,
        key: this.projectKey,
        teamSlug: this.teamSlug,
        teamRef: this.teamSlug,
        ref: this.ref,
        name: "Dự án thử",
        columns: this.columns,
        assignees: [],
      });
    }
    if (is(/^GET \/projects\/([^/]+)\/issues$/)) {
      if (!this.resolves(m![1])) return this.json({ error: "Project not found" }, 404);
      return this.json(this.issues);
    }
    if (is(/^GET \/projects\/([^/]+)\/issues\/(\d+)$/)) {
      if (!this.resolves(m![1])) return this.json({ error: "Project not found" }, 404);
      const issue = this.issues.find((i) => i.identifier === `${this.projectKey}-${m![2]}`);
      return issue ? this.json(issue) : this.json({ error: "Not found" }, 404);
    }
    if (is(/^GET \/issues\/(\d+)$/)) {
      const issue = this.issues.find((i) => i.id === Number(m![1]));
      return issue ? this.json(issue) : this.json({ error: "Not found" }, 404);
    }
    if (is(/^PATCH \/issues\/(\d+)$/)) {
      const issue = this.issues.find((i) => i.id === Number(m![1]));
      if (!issue) return this.json({ error: "Not found" }, 404);
      Object.assign(issue, b, { updatedAt: new Date().toISOString() });
      return this.json(issue);
    }
    if (is(/^POST \/issues\/(\d+)\/comments$/)) {
      const issueId = Number(m![1]);
      if (!this.issues.some((i) => i.id === issueId)) return this.json({ error: "Not found" }, 404);
      const comment = this.addComment(issueId, String(b.body ?? ""), b.replyToId ?? null);
      comment.actorName = this.agentUsername;
      comment.actorUserId = "agent-user";
      return this.json({ id: comment.id, body: comment.body });
    }
    if (is(/^GET \/issues\/(\d+)\/timeline\/items$/)) {
      return this.json(
        this.comments
          .filter((c) => c.issueId === Number(m![1]))
          .map((c) => ({ kind: "comment", ...c })),
      );
    }
    return this.json({ error: `Fake: chưa hỗ trợ ${key}` }, 404);
  }

  /** Ref hoặc khoá trần này có chỉ vào dự án của fake không (theo luật của server thật). */
  private resolves(ref: string): boolean {
    const dot = ref.indexOf(".");
    if (dot < 0) return this.allowBareKeys && ref === this.projectKey;
    return ref.slice(0, dot) === this.teamSlug && ref.slice(dot + 1) === this.projectKey;
  }

  private claim(): Response {
    if (this.invocationUrl) {
      return this.json({ error: "This agent receives its work at its invocation URL" }, 409);
    }
    const now = Date.now();
    // Run hết lượt thử mà lease đã hết hạn thì server đánh failed.
    for (const r of this.runs) {
      if (r.status === "pending" && r.attempts >= this.maxAttempts && r.leaseUntil <= now) {
        r.status = "failed";
        r.executing = false;
        r.error = "Runner did not report a result";
      }
    }
    const busyIssues = new Set(
      this.runs
        .filter((r) => r.status === "pending" && r.attempts > 0 && r.leaseUntil > now)
        .map((r) => r.issueId)
        .filter((id) => id != null),
    );
    const next = this.runs.find(
      (r) =>
        r.status === "pending" &&
        r.leaseUntil <= now &&
        (r.issueId == null || !busyIssues.has(r.issueId)),
    );
    if (!next) return this.json({ run: null });
    next.attempts++;
    next.leaseUntil = now + this.leaseMs;
    next.executing = true;
    return this.json({
      run: {
        id: next.id,
        trigger: next.trigger,
        prompt: next.prompt,
        systemPrompt: next.systemPrompt,
        attempts: next.attempts,
        traceEvents: true,
        issueId: next.issueId,
        issueIdentifier: next.issueIdentifier,
      },
    });
  }

  private active(runId: number, attempt?: number): FakeRun | null {
    const run = this.runs.find((r) => r.id === runId);
    if (!run || run.status !== "pending" || run.attempts === 0) return null;
    if (attempt != null && run.attempts !== attempt) return null;
    return run;
  }

  private heartbeat(runId: number, attempt?: number): Response {
    const run = this.active(runId, attempt);
    if (!run) return this.json({ error: "Run not found" }, 404);
    run.leaseUntil = Date.now() + this.leaseMs;
    run.executing = true;
    return new Response(null, { status: 204 });
  }

  private result(runId: number, b: Record<string, any>): Response {
    const run = this.active(runId, b.attempt);
    if (!run) return this.json({ error: "Run not found" }, 404);
    run.status = b.status === "success" ? "success" : "failed";
    run.executing = false;
    run.output = typeof b.output === "string" ? b.output.slice(0, 10_000) : null;
    run.error = run.status === "failed" ? String(b.error ?? "Run failed").slice(0, 500) : null;
    run.usage = b.usage ?? null;
    return new Response(null, { status: 204 });
  }

  private events(runId: number, b: Record<string, any>): Response {
    const run = this.runs.find((r) => r.id === runId);
    if (
      !run ||
      run.status !== "pending" ||
      run.attempts !== b.attempt ||
      !run.executing ||
      run.leaseUntil <= Date.now()
    ) {
      return this.json({ error: "Active run attempt not found" }, 404);
    }
    const events = Array.isArray(b.events) ? b.events : [];
    if (events.length === 0 || events.length > 200) {
      return this.json({ error: "Invalid events" }, 422);
    }
    const offset = Number(b.offset);
    if (offset < run.nextOffset && offset + events.length <= run.nextOffset) {
      return this.json({ nextOffset: run.nextOffset, truncated: false });
    }
    if (offset !== run.nextOffset) return this.json({ error: "Unexpected trace offset" }, 409);
    if (run.sessionId && b.sessionId && run.sessionId !== b.sessionId) {
      return this.json({ error: "Session is already bound to this attempt" }, 409);
    }
    run.sessionId ??= b.sessionId ?? null;
    run.events.push(...events);
    run.nextOffset = offset + events.length;
    return this.json({ nextOffset: run.nextOffset, truncated: false });
  }
}

/** Dựng và bật một `FakeItsaplan` trong một dòng. */
export function startFakeItsaplan(options?: FakeItsaplanOptions): FakeItsaplan {
  const fake = new FakeItsaplan(options);
  fake.start();
  return fake;
}
