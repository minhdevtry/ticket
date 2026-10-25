/**
 * Proxy itsaplan của Tiểu Linh 2: khoá thật nằm ở đây, Colab chỉ gọi cổng loopback.
 *
 * Chính sách (mặc định là CHẶN):
 *  - ĐỌC (GET/HEAD): chỉ `/projects/<project thử>/**` (cũng nhận dạng có team, vd `tech.TECH2`) và
 *    `/issues/{id}/**` khi ticket đã kiểm tra thuộc project thử. Mọi đường khác: 403.
 *  - GHI: chỉ các route sau, mỗi route có danh sách khoá body cho phép, và mọi tham chiếu
 *    (columnId, labelIds, typeId, assigneeUserId, fieldId, targetIssueId) phải thuộc project thử:
 *      POST  /projects/<thử>/issues        tạo ticket
 *      PATCH /issues/{id}                  sửa ticket (không đổi projectId/parent)
 *      POST  /issues/{id}/comments         {body}
 *      POST  /issues/{id}/fields, PUT /issues/{id}/fields/{fieldId}
 *      POST  /issues/{id}/links            {targetIssueId, kind} (đích cũng phải thuộc project thử)
 *    Ghi bỏ query string, bắt buộc content-type JSON, body được serialize lại từ bản đã kiểm tra.
 *  - AGENT-RUNS (chỉ khi `agentRuns: true`, dành cho `apps/tieulinh` chạy bằng khoá agent):
 *      POST /agent-runs/claim              không body; nhớ id run nhận về
 *      POST /agent-runs/{id}/heartbeat     {attempt?}
 *      POST /agent-runs/{id}/result        {attempt?, status, output?, error?, usage?}
 *      POST /agent-runs/{id}/events        {attempt, offset, events[], sessionId?}
 *    `{id}` chỉ được dùng nếu run đó vừa nhận qua chính proxy này và thuộc project thử; id lạ trả
 *    404 (client coi là "lost/stale", không coi là lỗi chết như 403).
 *  - DELETE, webhook, đính kèm, team/project, mọi route khác: chặn.
 */
import {
  type FetchLike,
  type Log,
  RateLimiter,
  deny,
  hostOk,
  isJson,
  json,
  passHeaders,
  pick,
  readBody,
  safePath,
  withAuth,
} from "./proxy-common.ts";

export interface ItsaplanOpts {
  upstream: string;
  apiKey: string;
  /** Project thử duy nhất được ghi vào. */
  projectKey: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  log?: Log;
  ratePerMin?: number;
  writesPerMin?: number;
  /** Cho phép đúng bốn route `/agent-runs/*` (mặc định TẮT: chỉ bật cho bot hậu cần). */
  agentRuns?: boolean;
  /** Trần lệnh agent-runs mỗi phút (heartbeat, events, claim). Mặc định 1200. */
  agentRunsPerMin?: number;
}

export interface ProjectRefs {
  id: number;
  key: string;
  ref: string | null;
  columnIds: Set<number>;
  labelIds: Set<number>;
  typeIds: Set<number>;
  assigneeIds: Set<string>;
  fieldIds: Set<number>;
  loadedAt: number;
}

const OK_TTL = 10 * 60_000;
const NO_TTL = 30_000;
const REFS_TTL = 5 * 60_000;
const OWNED_MAX = 5000;
const MAX_WRITE_BODY = 1024 * 1024;
const RUN_TTL = 6 * 60 * 60_000;
const RUNS_MAX = 2000;
const RUN_STATUS = new Set(["success", "failed"]);
/** Loại sự kiện AG-UI mà itsaplan nhận ở `/events`. */
const AGUI_TYPES = new Set([
  "RUN_STARTED",
  "RUN_FINISHED",
  "RUN_ERROR",
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_END",
  "TOOL_CALL_START",
  "TOOL_CALL_ARGS",
  "TOOL_CALL_END",
  "TOOL_CALL_RESULT",
]);
const PRIORITIES = new Set(["urgent", "high", "medium", "low"]);
const LINK_KINDS = new Set(["relates", "duplicates", "blocks"]);

type Check = (v: unknown, refs: ProjectRefs) => boolean;

const isStr =
  (max: number): Check =>
  (v) =>
    typeof v === "string" && v.length <= max;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const nullable =
  (c: Check): Check =>
  (v, r) =>
    v === null || c(v, r);
const idIn =
  (pick: (r: ProjectRefs) => Set<number>): Check =>
  (v, r) =>
    isInt(v) && pick(r).has(v);
const idList =
  (pickSet: (r: ProjectRefs) => Set<number>): Check =>
  (v, r) =>
    Array.isArray(v) && v.length <= 50 && v.every((x) => isInt(x) && pickSet(r).has(x));

/** Khoá được phép khi tạo/sửa ticket, kèm kiểm tra giá trị. */
const ISSUE_KEYS: Record<string, Check> = {
  title: (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 500,
  description: isStr(100_000),
  columnId: idIn((r) => r.columnIds),
  priority: (v) => typeof v === "string" && PRIORITIES.has(v),
  labelIds: idList((r) => r.labelIds),
  typeId: nullable(idIn((r) => r.typeIds)),
  assigneeUserId: nullable((v, r) => typeof v === "string" && r.assigneeIds.has(v)),
  dueDate: nullable((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && v.length <= 40),
};

const FIELD_VALUE: Check = (v) =>
  v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";

const FIELD_KEYS: Record<string, Check> = {
  value: FIELD_VALUE,
  valueEnd: nullable(isStr(100)),
  optionIds: (v) => Array.isArray(v) && v.length <= 50 && v.every(isInt),
};

function checkKeys(body: unknown, spec: Record<string, Check>, refs: ProjectRefs): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body phải là object JSON";
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    const check = spec[k];
    if (!check) return `khoá body không được phép: ${k}`;
    if (!check(v, refs)) return `giá trị không hợp lệ hoặc ngoài project thử: ${k}`;
  }
  return null;
}

type Route =
  | { kind: "create"; project: string }
  | { kind: "patch"; id: number }
  | { kind: "comment"; id: number }
  | { kind: "fieldPost"; id: number }
  | { kind: "fieldPut"; id: number; fieldId: number }
  | { kind: "link"; id: number };

/** Route GHI duy nhất được phép; null nếu không khớp. */
export function matchWrite(method: string, seg: string[]): Route | null {
  const num = (s: string | undefined) => (s && /^\d{1,12}$/.test(s) ? Number(s) : null);
  if (seg[0] === "projects" && seg.length === 3 && seg[2] === "issues" && method === "POST") {
    return { kind: "create", project: seg[1] as string };
  }
  if (seg[0] !== "issues") return null;
  const id = num(seg[1]);
  if (id === null) return null;
  if (seg.length === 2 && method === "PATCH") return { kind: "patch", id };
  if (seg.length === 3 && seg[2] === "comments" && method === "POST")
    return { kind: "comment", id };
  if (seg.length === 3 && seg[2] === "fields" && method === "POST")
    return { kind: "fieldPost", id };
  if (seg.length === 3 && seg[2] === "links" && method === "POST") return { kind: "link", id };
  if (seg.length === 4 && seg[2] === "fields" && method === "PUT") {
    const fieldId = num(seg[3]);
    return fieldId === null ? null : { kind: "fieldPut", id, fieldId };
  }
  return null;
}

type AgentRoute = { kind: "claim" } | { kind: "heartbeat" | "result" | "events"; runId: number };

/** Route agent-runs duy nhất được phép (POST); null nếu không khớp. */
export function matchAgentRun(method: string, seg: string[]): AgentRoute | null {
  if (seg[0] !== "agent-runs" || method !== "POST") return null;
  if (seg.length === 2 && seg[1] === "claim") return { kind: "claim" };
  if (seg.length === 3 && /^\d{1,12}$/.test(seg[1] ?? "")) {
    const kind = seg[2];
    if (kind === "heartbeat" || kind === "result" || kind === "events") {
      return { kind, runId: Number(seg[1]) };
    }
  }
  return null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Kiểm body agent-runs; trả lý do từ chối hoặc null. */
export function checkAgentBody(
  kind: "heartbeat" | "result" | "events",
  body: unknown,
): string | null {
  if (body === undefined) return kind === "heartbeat" ? null : "thiếu body";
  if (!isObj(body)) return "body phải là object JSON";
  const allowed: Record<string, (v: unknown) => boolean> = {
    attempt: (v) => isInt(v) && v >= 0,
  };
  if (kind === "result") {
    Object.assign(allowed, {
      status: (v: unknown) => typeof v === "string" && RUN_STATUS.has(v),
      output: (v: unknown) => v === null || (typeof v === "string" && v.length <= 10_000),
      error: (v: unknown) => v === null || (typeof v === "string" && v.length <= 500),
      usage: (v: unknown) =>
        v === null ||
        (isObj(v) &&
          Object.keys(v).every((k) => k === "inputTokens" || k === "outputTokens") &&
          Object.values(v).every((x) => isInt(x) && x >= 0)),
    });
  } else if (kind === "events") {
    Object.assign(allowed, {
      offset: (v: unknown) => isInt(v) && v >= 0,
      sessionId: (v: unknown) => typeof v === "string" && v.length <= 100,
      events: (v: unknown) =>
        Array.isArray(v) &&
        v.length >= 1 &&
        v.length <= 200 &&
        v.every((e) => isObj(e) && typeof e.type === "string" && AGUI_TYPES.has(e.type)),
    });
  }
  for (const [k, v] of Object.entries(body)) {
    const check = allowed[k];
    if (!check) return `khoá body không được phép: ${k}`;
    if (!check(v)) return `giá trị không hợp lệ: ${k}`;
  }
  if (kind === "result" && !("status" in body)) return "thiếu status";
  if (kind === "events" && !("events" in body && "offset" in body && "attempt" in body))
    return "thiếu attempt/offset/events";
  return null;
}

export function createItsaplanProxy(o: ItsaplanOpts) {
  const doFetch = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const upstream = o.upstream.replace(/\/+$/, "");
  const owned = new Map<number, { ok: boolean; exp: number }>();
  const readLimit = new RateLimiter(o.ratePerMin ?? 600, now);
  const writeLimit = new RateLimiter(o.writesPerMin ?? 60, now);
  const agentLimit = new RateLimiter(o.agentRunsPerMin ?? 1200, now);
  /** Run đã nhận qua proxy này và thuộc project thử: id -> hạn. */
  const runs = new Map<number, number>();
  const rememberRun = (id: number) => {
    runs.delete(id);
    runs.set(id, now() + RUN_TTL);
    while (runs.size > RUNS_MAX) runs.delete(runs.keys().next().value as number);
  };
  const runKnown = (id: number) => {
    const exp = runs.get(id);
    if (exp === undefined) return false;
    if (exp <= now()) {
      runs.delete(id);
      return false;
    }
    return true;
  };
  let refs: ProjectRefs | null = null;

  const fetchUp = (path: string, init: RequestInit = {}) => {
    const headers = withAuth(new Headers(init.headers), o.apiKey);
    return doFetch(`${upstream}${path}`, { ...init, headers, redirect: "manual" });
  };

  function remember(id: number, ok: boolean) {
    owned.delete(id);
    owned.set(id, { ok, exp: now() + (ok ? OK_TTL : NO_TTL) });
    while (owned.size > OWNED_MAX) owned.delete(owned.keys().next().value as number);
  }

  /** Nạp tham chiếu hợp lệ của project thử. Ném lỗi nếu upstream không trả đúng project. */
  async function loadRefs(force = false): Promise<ProjectRefs> {
    if (refs && !force && now() - refs.loadedAt < REFS_TTL) return refs;
    const res = await fetchUp(`/projects/${encodeURIComponent(o.projectKey)}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw new Error(`không nạp được project thử (HTTP ${res.status})`);
    }
    const data: any = await res.json();
    const p = data?.project ?? data;
    if (p?.key !== o.projectKey || !isInt(p?.id))
      throw new Error("upstream trả project khác project thử");
    const ids = (list: unknown, f: (x: any) => unknown) =>
      new Set(
        (Array.isArray(list) ? list : []).map(f).filter((x) => x !== undefined && x !== null),
      );
    refs = {
      id: p.id,
      key: p.key,
      ref: typeof p.ref === "string" ? p.ref : null,
      columnIds: ids(data.columns, (c) => c.id) as Set<number>,
      labelIds: ids(data.labels, (c) => c.id) as Set<number>,
      typeIds: ids(data.issueTypes, (c) => c.id) as Set<number>,
      assigneeIds: ids(data.assignees, (c) => c.userId) as Set<string>,
      fieldIds: ids(data.customFields, (c) => c.id) as Set<number>,
      loadedAt: now(),
    };
    return refs;
  }

  /** Ticket thuộc project thử: mã `<KEY>-n` VÀ projectId trùng project thử. */
  async function belongs(id: number): Promise<boolean> {
    const hit = owned.get(id);
    if (hit && hit.exp > now()) return hit.ok;
    let ok = false;
    try {
      const r = await loadRefs();
      const res = await fetchUp(`/issues/${id}`, { headers: { accept: "application/json" } });
      if (res.ok) {
        const data: any = await res.json();
        const issue = data?.issue ?? data;
        ok =
          String(issue?.identifier ?? "").startsWith(`${o.projectKey}-`) &&
          issue?.projectId === r.id;
      } else res.body?.cancel().catch(() => {});
    } catch {}
    remember(id, ok);
    return ok;
  }

  const projectAllowed = async (seg: string | undefined): Promise<boolean> => {
    if (seg === o.projectKey) return true;
    try {
      const r = await loadRefs();
      return r.ref !== null && seg === r.ref;
    } catch {
      return false;
    }
  };

  /** Kiểm tra body với refs; nếu trượt thì nạp lại refs một lần rồi thử lại (cột/nhãn mới tạo). */
  async function validate(body: unknown, spec: Record<string, Check>): Promise<string | null> {
    const first = checkKeys(body, spec, await loadRefs());
    if (first === null || first.startsWith("khoá body") || first.startsWith("body phải"))
      return first;
    return checkKeys(body, spec, await loadRefs(true));
  }

  /** Chuyển tiếp một lệnh agent-runs đã khớp route (xem đầu file). */
  async function handleAgent(
    route: AgentRoute,
    req: Request,
    entry: Record<string, unknown>,
    finish: (res: Response, decision: string, reason?: string) => Response,
    refuse: (reason: string, status?: number) => Response,
  ): Promise<Response> {
    if (!agentLimit.take()) return refuse("vượt trần agent-runs", 429);
    if (route.kind !== "claim") {
      entry.runId = route.runId;
      if (!runKnown(route.runId)) {
        return finish(
          json(404, { error: "denied", reason: "run chưa nhận qua proxy" }),
          "deny",
          "run chưa nhận qua proxy",
        );
      }
    }
    let out: string | undefined;
    if (route.kind !== "claim") {
      const raw = await readBody(req, MAX_WRITE_BODY);
      if (!raw) return refuse("body quá lớn", 413);
      if (raw.byteLength > 0) {
        if (!isJson(req)) return refuse("cần content-type application/json", 415);
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(raw));
        } catch {
          return refuse("body không phải JSON", 400);
        }
        const problem = checkAgentBody(route.kind, body);
        if (problem) return refuse(problem);
        out = JSON.stringify(body);
      } else {
        const problem = checkAgentBody(route.kind, undefined);
        if (problem) return refuse(problem);
      }
    }
    const path = new URL(req.url).pathname;
    try {
      const res = await fetchUp(path, {
        method: "POST",
        headers: out === undefined ? {} : { "content-type": "application/json" },
        body: out,
      });
      if (route.kind !== "claim") {
        return finish(
          new Response(res.body, { status: res.status, headers: passHeaders(res.headers) }),
          "allow",
        );
      }
      const text = await res.text();
      let decision = "allow";
      let reason: string | undefined;
      try {
        const run = (JSON.parse(text) as any)?.run;
        if (res.ok && run && isInt(run.id)) {
          const ident = run.issueIdentifier;
          if (
            ident === null ||
            ident === undefined ||
            String(ident).startsWith(`${o.projectKey}-`)
          ) {
            rememberRun(run.id);
            entry.runId = run.id;
          } else {
            decision = "warn";
            entry.runId = run.id;
            reason = "run ngoài project thử, không nhớ id";
          }
        }
      } catch {}
      return finish(
        new Response(text, { status: res.status, headers: passHeaders(res.headers) }),
        decision,
        reason,
      );
    } catch (e) {
      return finish(json(502, { error: "upstream" }), "error", (e as Error)?.message);
    }
  }

  return async (req: Request): Promise<Response> => {
    const t0 = now();
    const url = new URL(req.url);
    const entry: Record<string, unknown> = {
      ts: t0,
      svc: "itsaplan",
      method: req.method,
      path: url.pathname,
    };
    const finish = (res: Response, decision: string, reason?: string) => {
      log({ ...entry, decision, reason, status: res.status, ms: now() - t0 });
      return res;
    };
    const refuse = (reason: string, status = 403) => finish(deny(reason, status), "deny", reason);

    if (!hostOk(req)) return refuse("Host không phải loopback");
    if (!safePath(url.pathname)) return refuse("đường dẫn không hợp lệ", 400);
    const seg = url.pathname.split("/").filter(Boolean);
    const method = req.method.toUpperCase();
    if (seg.some((s) => /^(webhooks?|attachments?|teams?|users)$/i.test(s))) {
      return refuse("tài nguyên bị chặn");
    }
    const agent = matchAgentRun(method, seg);
    if (agent) {
      if (!o.agentRuns) return refuse("agent-runs không được bật");
      return handleAgent(agent, req, entry, finish, refuse);
    }
    if (!readLimit.take()) return refuse("vượt trần tốc độ", 429);

    const forwardRaw = async (path: string, init: RequestInit = {}) => {
      try {
        const res = await fetchUp(path, init);
        return finish(
          new Response(res.body, { status: res.status, headers: passHeaders(res.headers) }),
          "allow",
        );
      } catch (e) {
        return finish(json(502, { error: "upstream" }), "error", (e as Error)?.message);
      }
    };

    // ---- Đọc
    if (method === "GET" || method === "HEAD") {
      if (seg[0] === "projects" && seg.length >= 2) {
        if (!(await projectAllowed(seg[1]))) return refuse("project ngoài phạm vi");
      } else if (seg[0] === "issues" && /^\d{1,12}$/.test(seg[1] ?? "")) {
        entry.issueId = Number(seg[1]);
        if (!(await belongs(Number(seg[1])))) return refuse("ticket không thuộc project thử");
      } else return refuse("đường đọc không được phép");
      return forwardRaw(`${url.pathname}${url.search}`, {
        method,
        headers: pick(req, ["accept"]),
      });
    }

    // ---- Ghi
    if (method === "DELETE") return refuse("DELETE bị chặn");
    const route = matchWrite(method, seg);
    if (!route) return refuse("route ghi không được phép");
    if (!isJson(req)) return refuse("cần content-type application/json", 415);
    if (!writeLimit.take()) return refuse("vượt trần ghi", 429);
    const raw = await readBody(req, MAX_WRITE_BODY);
    if (!raw) return refuse("body quá lớn", 413);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return refuse("body không phải JSON", 400);
    }

    let problem: string | null;
    try {
      if (route.kind === "create") {
        if (!(await projectAllowed(route.project)))
          return refuse("chỉ tạo ticket trong project thử");
        problem = await validate(body, ISSUE_KEYS);
      } else {
        entry.issueId = route.id;
        if (!(await belongs(route.id))) return refuse("ticket không thuộc project thử");
        if (route.kind === "patch") problem = await validate(body, ISSUE_KEYS);
        else if (route.kind === "comment")
          problem = await validate(body, {
            body: isStr(50_000),
            replyToId: (v) => isInt(v) && v > 0,
          });
        else if (route.kind === "fieldPut") {
          problem = (await loadRefs()).fieldIds.has(route.fieldId)
            ? await validate(body, FIELD_KEYS)
            : "fieldId ngoài project thử";
        } else if (route.kind === "fieldPost") {
          problem = await validate(body, {
            fieldId: idIn((r) => r.fieldIds),
            value: FIELD_VALUE,
          });
        } else {
          problem = await validate(body, {
            kind: (v) => typeof v === "string" && LINK_KINDS.has(v),
            targetIssueId: () => true,
          });
          const target = (body as Record<string, unknown>)?.targetIssueId;
          if (!problem && !(isInt(target) && (await belongs(target)))) {
            problem = "link tới ticket ngoài project thử";
          }
        }
      }
    } catch (e) {
      return finish(json(502, { error: "upstream" }), "error", (e as Error)?.message);
    }
    if (problem) return refuse(problem);

    const path = url.pathname; // bỏ query string
    const out = JSON.stringify(body);
    try {
      const res = await fetchUp(path, {
        method,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: out,
      });
      if (route.kind === "create") {
        const text = await res.text();
        try {
          const data: any = JSON.parse(text);
          const issue = data?.issue ?? data;
          if (res.ok && isInt(issue?.id)) remember(issue.id, true);
        } catch {}
        return finish(
          new Response(text, { status: res.status, headers: passHeaders(res.headers) }),
          "allow",
        );
      }
      return finish(
        new Response(res.body, { status: res.status, headers: passHeaders(res.headers) }),
        "allow",
      );
    } catch (e) {
      return finish(json(502, { error: "upstream" }), "error", (e as Error)?.message);
    }
  };
}

/**
 * Tự kiểm tra lúc khởi động. Từ chối chạy nếu:
 *  - chính proxy cho đọc project cấm (chính sách hỏng), hoặc
 *  - khoá itsaplan nhìn thấy project cấm (khoá quá quyền: proxy không thể bù).
 * Upstream trả 401/403/404 cho project cấm là đạt.
 */
export async function selfTest(opts: {
  handler: (req: Request) => Promise<Response>;
  upstream: string;
  apiKey: string;
  forbidden: string[];
  fetchImpl?: FetchLike;
}): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  for (const key of opts.forbidden) {
    const res = await opts.handler(new Request(`http://127.0.0.1/projects/${key}/issues`));
    if (res.status !== 403)
      throw new Error(`self-test: proxy cho đọc project cấm ${key} (HTTP ${res.status})`);
    const up = await doFetch(`${opts.upstream.replace(/\/+$/, "")}/projects/${key}/issues`, {
      headers: withAuth(new Headers({ accept: "application/json" }), opts.apiKey),
      redirect: "manual",
    });
    up.body?.cancel().catch(() => {});
    if (![401, 403, 404].includes(up.status)) {
      throw new Error(
        `self-test: khoá itsaplan đọc được project cấm ${key} (HTTP ${up.status}); dùng khoá chỉ có quyền project thử`,
      );
    }
  }
}
