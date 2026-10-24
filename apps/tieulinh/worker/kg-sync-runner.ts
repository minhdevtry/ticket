/**
 * Điều phối việc nạp ticket Done vào Knowledge Graph (Memgraph).
 *
 * Ba việc mà lời gọi thẳng `syncDoneTicketToKnowledgeGraph` không lo:
 * 1. **Cổng bật/tắt.** KG chỉ chạy cho dự án được mời rõ ràng
 *    (KG_SYNC_PROJECTS). Có MEMGRAPH_URI trong apps/tieulinh/.env thôi là chưa đủ —
 *    Iris (PO) đọc chung file đó và đã từng nạp KG ngoài ý muốn.
 * 2. **Chống chạy trùng.** Một ticket Done được báo 2–3 lần gần như cùng lúc
 *    (confirmDone/tự đóng + webhook state_changed). Lượt đang chạy thì lượt sau
 *    chờ chung kết quả; sổ `kg_sync_ledger` chặn LLM bóc lại nội dung cũ.
 * 3. **Thử lại bền vững.** Hỏng (Memgraph/LLM/Itsaplan) thì vào `kg_sync_queue`
 *    với backoff mũ, sống qua restart; quá số lần thì bỏ cuộc kèm log lỗi.
 */
import type { KgSyncRepository } from "../lib/storage/kg-sync-repository";
import { getLogger } from "../lib/logger";
import { identifierInProject, normalizeProjectKey } from "./project-lock";

export interface KgSyncGate {
  enabled: boolean;
  reason: string;
  projectKey: string | null;
  projects: string[];
}

/**
 * KG bật khi và chỉ khi: có MEMGRAPH_URI, có ITSAPLAN_PROJECT_KEY, và dự án đó
 * nằm trong KG_SYNC_PROJECTS (phẩy ngăn cách, mặc định rỗng = tắt).
 */
export function resolveKgSyncGate(env: Record<string, string | undefined>): KgSyncGate {
  const projectKey = normalizeProjectKey(env.ITSAPLAN_PROJECT_KEY);
  const projects = String(env.KG_SYNC_PROJECTS ?? "")
    .split(",")
    .map((p) => normalizeProjectKey(p))
    .filter((p): p is string => !!p);
  const base = { projectKey, projects };

  if (!env.MEMGRAPH_URI) return { ...base, enabled: false, reason: "chưa cấu hình MEMGRAPH_URI" };
  if (!projectKey) return { ...base, enabled: false, reason: "chưa cấu hình ITSAPLAN_PROJECT_KEY" };
  if (projects.length === 0) {
    return { ...base, enabled: false, reason: "KG_SYNC_PROJECTS rỗng (mặc định tắt)" };
  }
  if (!projects.includes(projectKey)) {
    return {
      ...base,
      enabled: false,
      reason: `dự án ${projectKey} không nằm trong KG_SYNC_PROJECTS=${projects.join(",")}`,
    };
  }
  return { ...base, enabled: true, reason: `dự án ${projectKey} nằm trong KG_SYNC_PROJECTS` };
}

/** Dự án không bao giờ được nạp Onyx dù cấu hình thế nào (ADR-0002: Iris không dùng Onyx). */
const ONYX_FORBIDDEN_PROJECTS = new Set(["PO"]);

/**
 * Onyx bật khi có ONYX_BASE_URL, có ITSAPLAN_PROJECT_KEY, và dự án nằm trong
 * ONYX_SYNC_PROJECTS (mặc định "TECH"). Iris đọc chung apps/tieulinh/.env có
 * ONYX_BASE_URL — không có cổng này thì worker PO nạp ticket PO vào Onyx.
 */
export function resolveOnyxSyncGate(env: Record<string, string | undefined>): KgSyncGate {
  const projectKey = normalizeProjectKey(env.ITSAPLAN_PROJECT_KEY);
  const projects = String(env.ONYX_SYNC_PROJECTS ?? "TECH")
    .split(",")
    .map((p) => normalizeProjectKey(p))
    .filter((p): p is string => !!p);
  const base = { projectKey, projects };
  if (!env.ONYX_BASE_URL) return { ...base, enabled: false, reason: "chưa cấu hình ONYX_BASE_URL" };
  if (!projectKey) return { ...base, enabled: false, reason: "chưa cấu hình ITSAPLAN_PROJECT_KEY" };
  if (ONYX_FORBIDDEN_PROJECTS.has(projectKey)) {
    return { ...base, enabled: false, reason: `dự án ${projectKey} không bao giờ nạp Onyx (ADR-0002)` };
  }
  if (!projects.includes(projectKey)) {
    return { ...base, enabled: false, reason: `dự án ${projectKey} không nằm trong ONYX_SYNC_PROJECTS=${projects.join(",")}` };
  }
  return { ...base, enabled: true, reason: `dự án ${projectKey} nằm trong ONYX_SYNC_PROJECTS` };
}

export type KgSyncFn = (
  issueId: number,
  identifier: string,
) => Promise<{ success: boolean; skipped?: boolean; reason?: string; error?: string }>;

export interface KgSyncRunnerOptions {
  sync: KgSyncFn;
  repo: KgSyncRepository;
  projectKey: string;
  /** Tổng số lần thử (kể cả lần đầu) trước khi bỏ cuộc. Mặc định 6. */
  maxAttempts?: number;
  /** Chờ trước lần thử lại đầu tiên; nhân đôi mỗi lần. Mặc định 1 phút. */
  baseDelayMs?: number;
  /** Trần backoff. Mặc định 6 giờ. */
  maxDelayMs?: number;
  now?: () => number;
  /** Tên sink trong log ("KG", "Onyx"). Mặc định "KG". */
  label?: string;
}

/**
 * Chạy một sink tri thức (KG hoặc Onyx) cho ticket hoàn tất: chống chạy trùng,
 * thử lại bền theo backoff. Tên lịch sử "KgSync" — dùng chung cho mọi sink.
 */
export class KgSyncRunner {
  private readonly sync: KgSyncFn;
  private readonly repo: KgSyncRepository;
  private readonly projectKey: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly now: () => number;
  private readonly label: string;
  /** issueId → lượt sync đang chạy; lượt trùng chờ chung promise này. */
  private readonly inFlight = new Map<number, Promise<void>>();
  private processing = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: KgSyncRunnerOptions) {
    this.sync = options.sync;
    this.repo = options.repo;
    this.projectKey = normalizeProjectKey(options.projectKey) ?? options.projectKey;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 6);
    this.baseDelayMs = options.baseDelayMs ?? 60_000;
    this.maxDelayMs = options.maxDelayMs ?? 6 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
    this.label = options.label ?? "KG";
  }

  /** Handler cho onIssueDone. Không bao giờ ném — lỗi đi vào hàng đợi. */
  handle(issueId: number, identifier: string): Promise<void> {
    if (!identifierInProject(identifier, this.projectKey)) {
      getLogger().info(`[KgSyncRunner:${this.label}] Bỏ qua ${identifier}: không thuộc dự án ${this.projectKey}.`);
      return Promise.resolve();
    }
    const running = this.inFlight.get(issueId);
    if (running) {
      getLogger().info(`[KgSyncRunner:${this.label}] ${identifier} đang được nạp, lượt trùng chờ chung kết quả.`);
      return running;
    }
    const task = this.attempt(issueId, identifier).finally(() => this.inFlight.delete(issueId));
    this.inFlight.set(issueId, task);
    return task;
  }

  private backoffMs(attempts: number): number {
    return Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.max(0, attempts - 1));
  }

  private async attempt(issueId: number, identifier: string): Promise<void> {
    let error = "sync trả success=false";
    try {
      const result = await this.sync(issueId, identifier);
      if (result.success) {
        this.repo.dequeue(identifier);
        getLogger().info(
          result.skipped
            ? `[KgSyncRunner:${this.label}] ${identifier}: bỏ qua (${result.reason ?? "không cần nạp"}).`
            : `[KgSyncRunner:${this.label}] Đã nạp ${identifier}.`,
        );
        return;
      }
      error = result.error || "sync trả success=false";
    } catch (err: any) {
      error = err?.message || String(err);
    }

    const now = this.now();
    const prevAttempts = this.repo.getQueued(identifier)?.attempts ?? 0;
    const attempts = prevAttempts + 1;
    if (attempts >= this.maxAttempts) {
      this.repo.dequeue(identifier);
      getLogger().error(
        `[KgSyncRunner:${this.label}] BỎ CUỘC nạp ${identifier} sau ${attempts} lần: ${error}. ${this.label === "KG" ? "Cần nạp tay (scripts/backfill-kg.ts)." : "Cần nạp tay."}`,
      );
      return;
    }
    const delay = this.backoffMs(attempts);
    this.repo.enqueueFailure({
      identifier,
      issueId,
      projectKey: this.projectKey,
      error,
      nextAttemptAt: now + delay,
      now,
    });
    getLogger().warn(
      `[KgSyncRunner:${this.label}] Nạp ${identifier} hỏng (lần ${attempts}/${this.maxAttempts}): ${error}. Thử lại sau ${Math.round(delay / 1000)}s.`,
    );
  }

  /** Xử lý các mục đã tới hạn. Lượt trước chưa xong thì bỏ qua. */
  async processDue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const due = this.repo.listDue(this.projectKey, this.now());
      for (const row of due) {
        await this.handle(row.issue_id, row.identifier);
      }
    } catch (err: any) {
      getLogger().error(`[KgSyncRunner:${this.label}] Lỗi xử lý hàng đợi: ${err.message}`);
    } finally {
      this.processing = false;
    }
  }

  /** Chạy hàng đợi ngay khi khởi động (mục tồn từ lần trước) rồi theo chu kỳ. */
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    void this.processDue();
    this.timer = setInterval(() => void this.processDue(), intervalMs);
    if (typeof (this.timer as any).unref === "function") (this.timer as any).unref();
  }

  /** Dừng timer và chờ các lượt đang chạy xong (để đóng Memgraph an toàn). */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await Promise.allSettled([...this.inFlight.values()]);
  }
}
