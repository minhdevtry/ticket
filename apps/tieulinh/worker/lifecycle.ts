import type { Database } from "bun:sqlite";
import type { ItsaplanClient } from "../lib/itsaplan/client";
import { issueWebUrl, resolveProjectTeamRef } from "../lib/itsaplan/project";
import type { Notifier } from "./notifier";
import { getLogger } from "../lib/logger";
import { normalizeProjectKey } from "./project-lock";

/**
 * Theo dõi SLA tiếp nhận: cảnh báo trực ca khi ticket quá hạn mà chưa ai nhận.
 *
 * Trước 24/09/2026 service này còn tự đóng ticket sau 24 giờ ở Resolved và
 * chuyển ticket sang Done khi người báo bấm nút. Cả hai đã bỏ: chỉ người xử lý
 * đóng ticket (ADR-0006) — vòng đời đã xử lý → hoàn tất nằm ở ticket-closure.ts.
 */
export interface SlaTrackerRecord {
  issue_id: number;
  identifier: string;
  priority: string;
  project_key: string;
  created_at: number;
  sla_hours: number;
  alerted_at?: number;
  status: "open" | "in_progress" | "done" | "breached";
}

export interface TicketLifecycleOptions {
  botAdapters?: Map<string, Notifier>;
  slaThresholds?: Record<string, number>;
  itsaplanWebUrl?: string;
  /**
   * Mã dự án worker phụ trách. Hai worker dùng chung `data/intake.db`, nên mỗi
   * lượt quét chỉ được đụng bản ghi của dự án mình. Không khai → quét tất
   * (chỉ dùng cho test / môi trường một dự án).
   */
  projectKey?: string;
}

const DEFAULT_SLA_THRESHOLDS: Record<string, number> = {
  urgent: 1,
  high: 2,
  medium: 4,
  low: 24,
};

export class TicketLifecycleService {
  private timer: Timer | null = null;
  private readonly db: Database;
  private readonly client: ItsaplanClient;
  private readonly botAdapters: Map<string, Notifier>;
  private readonly slaThresholds: Record<string, number>;
  private readonly itsaplanWebUrl: string;
  private readonly projectKey: string | null;
  /** Lượt quét trước chưa xong thì lượt sau bỏ qua — tránh cảnh báo 2 lần. */
  private sweeping = false;

  constructor(db: Database, client: ItsaplanClient, options: TicketLifecycleOptions = {}) {
    this.db = db;
    this.client = client;
    this.botAdapters = options.botAdapters || new Map();
    this.slaThresholds = { ...DEFAULT_SLA_THRESHOLDS, ...(options.slaThresholds || {}) };
    this.itsaplanWebUrl = (options.itsaplanWebUrl || process.env.ITSAPLAN_WEB_URL || "https://itsaplan.example.com").replace(/\/+$/, "");
    this.projectKey = normalizeProjectKey(options.projectKey);
  }

  registerBot(adapter: Notifier): void {
    this.botAdapters.set(adapter.channelType, adapter);
  }

  /**
   * Registers a newly created ticket for SLA monitoring.
   */
  recordSlaTarget(params: {
    issueId: number;
    identifier: string;
    priority: string;
    projectKey: string;
    createdAt?: number;
  }): void {
    const createdAt = params.createdAt ?? Date.now();
    const priorityKey = params.priority.toLowerCase();
    const slaHours = this.slaThresholds[priorityKey] ?? this.slaThresholds.medium ?? 4;

    this.db.query(`
      INSERT INTO sla_trackers (
        issue_id, identifier, priority, project_key, created_at, sla_hours, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'open')
      ON CONFLICT(issue_id) DO UPDATE SET
        priority = excluded.priority,
        sla_hours = excluded.sla_hours
    `).run(
      params.issueId,
      params.identifier,
      params.priority,
      params.projectKey,
      createdAt,
      slaHours,
    );

    getLogger().info(
      `[TicketLifecycleService] Đăng ký theo dõi SLA cho #${params.issueId} (${params.identifier}): Priority=${params.priority}, SLA=${slaHours}h`,
    );
  }

  markSlaProgress(issueId: number, status: "in_progress" | "done"): void {
    this.db.query(`
      UPDATE sla_trackers SET status = ? WHERE issue_id = ?
    `).run(status, issueId);
  }

  /**
   * Scans open tickets for SLA breaches and alerts on-call channel.
   */
  async runSlaCheck(now: number = Date.now()): Promise<number> {
    const breached = this.db.query<SlaTrackerRecord, [number, string | null, string | null]>(`
      SELECT * FROM sla_trackers
      WHERE status = 'open' AND alerted_at IS NULL AND (? - created_at) >= (sla_hours * 3600000)
        AND (? IS NULL OR UPPER(project_key) = ?)
    `).all(now, this.projectKey, this.projectKey);

    if (breached.length === 0) return 0;

    let alertCount = 0;

    for (const record of breached) {
      try {
        // Query Itsaplan to see if ticket is already picked up
        let isStillPending = true;
        try {
          const issue = await this.client.getIssue(record.issue_id);
          if (issue) {
            if (issue.assigneeUserId) {
              isStillPending = false;
              this.markSlaProgress(record.issue_id, "in_progress");
            } else {
              const cols = await this.client.listProjectColumns(record.project_key).catch(() => []);
              const currentCol = cols.find((c) => c.id === issue.columnId);
              if (currentCol) {
                if (currentCol.stateType === "completed") {
                  isStillPending = false;
                  this.markSlaProgress(record.issue_id, "done");
                } else if (currentCol.stateType === "started") {
                  isStillPending = false;
                  this.markSlaProgress(record.issue_id, "in_progress");
                }
              }
            }
          }
        } catch {
          // If query fails, assume still pending based on DB state
        }

        if (!isStillPending) continue;

        const elapsedHours = ((now - record.created_at) / 3600000).toFixed(1);
        const teamRef = await resolveProjectTeamRef(this.client, record.project_key);
        const issueUrl = issueWebUrl(this.itsaplanWebUrl, record.project_key, record.identifier, undefined, teamRef) ?? "";
        const alertMsg =
          `🚨 **[CẢNH BÁO SLA QUÁ HẠN]**\n\n` +
          `• **Ticket:** [${record.identifier}](${issueUrl})\n` +
          `• **Mức ưu tiên:** \`${record.priority.toUpperCase()}\` (Cam kết SLA: ${record.sla_hours}h)\n` +
          `• **Thời gian đã chờ:** **${elapsedHours}h** mà chưa có kỹ thuật viên tiếp nhận!\n\n` +
          `Kính nhờ On-Call / Lead kiểm tra và tiếp nhận xử lý.`;

        for (const adapter of this.botAdapters.values()) {
          if (adapter.broadcastAlert) {
            await adapter.broadcastAlert(alertMsg).catch((err) => {
              getLogger().warn(`[TicketLifecycleService] Broadcast alert failed: ${err.message}`);
            });
          }
        }

        this.db.query(`
          UPDATE sla_trackers SET alerted_at = ?, status = 'breached' WHERE issue_id = ?
        `).run(now, record.issue_id);

        alertCount++;
      } catch (err: any) {
        getLogger().warn(
          `[TicketLifecycleService] Lỗi khi kiểm tra SLA ticket #${record.issue_id}: ${err.message}`,
        );
      }
    }

    return alertCount;
  }

  /**
   * Một lượt quét SLA. Lượt trước chưa xong thì bỏ qua và trả `false`:
   * setInterval không chờ hàm async, Itsaplan chậm là hai lượt chồng nhau.
   */
  async runSweep(now?: number): Promise<boolean> {
    if (this.sweeping) {
      getLogger().info(`[TicketLifecycleService] Lượt quét trước chưa xong, bỏ qua lượt này.`);
      return false;
    }
    this.sweeping = true;
    try {
      await this.runSlaCheck(now);
    } catch (err: any) {
      getLogger().error(`[TicketLifecycleService] Error in lifecycle check tick: ${err.message}`);
    } finally {
      this.sweeping = false;
    }
    return true;
  }

  /**
   * Starts the background checking loop.
   */
  start(intervalMs: number = 60_000): void {
    if (this.timer) return;
    getLogger().info(
      `[TicketLifecycleService] Khởi động timer quét vòng đời ticket (chu kỳ ${Math.round(intervalMs / 1000)}s)`,
    );

    this.timer = setInterval(() => void this.runSweep(), intervalMs);

    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  /**
   * Stops the background checking loop.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      getLogger().info(`[TicketLifecycleService] Đã dừng timer quét vòng đời ticket`);
    }
  }
}
