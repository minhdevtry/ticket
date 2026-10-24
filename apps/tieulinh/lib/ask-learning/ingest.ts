/**
 * Ingest: quét ticket, phân loại các bình luận ứng viên CHƯA có trong kho, ghi kết quả.
 * Chỉ đọc nguồn (ticket + bình luận); không ghi gì lên Itsaplan. Chạy song song theo
 * pool (mặc định 8; dev trên gateway dùng 48).
 */
import type { LlmConfig } from "../../worker/llm";
import { classifyComment, buildReport, type ClassifyComment } from "./classify";
import { isCandidateComment } from "./candidate";
import type { AskLearnStore } from "./store";
import type { SourceTicket } from "./source";

export interface IngestOptions {
  store: AskLearnStore;
  tickets: SourceTicket[];
  llm: LlmConfig;
  concurrency?: number;
  dryRun?: boolean;
  completeFn?: Parameters<typeof classifyComment>[2];
  timeoutMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface IngestSummary {
  scannedTickets: number;
  candidates: number;
  alreadyClassified: number;
  toClassify: number;
  classified: number;
  needsInfo: number;
  errors: number;
  dryRun: boolean;
}

interface Job {
  issueKey: string;
  system: string;
  commentId: string;
  createdAt: string;
  report: string;
  prev: ClassifyComment[];
  comment: ClassifyComment;
}

const PROGRESS_EVERY = 50;

export async function ingest(opts: IngestOptions): Promise<IngestSummary> {
  const { store, tickets, llm } = opts;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const dryRun = opts.dryRun ?? false;

  const jobs: Job[] = [];
  let candidates = 0;
  let alreadyClassified = 0;

  for (const t of tickets) {
    // Lưu nhãn thô; chuẩn hoá sang hệ thống intake lúc truy vấn (learned.ts intakeSystemsOf).
    const system = t.systemRaw.trim();
    if (!dryRun) {
      store.upsertTicket({ issueKey: t.issueKey, system, createdAt: Date.parse(t.createdAt) || 0, lastScannedAt: now() });
      store.updateCommentsSystem(t.issueKey, system);
    }
    // Thứ tự thời gian (ổn định theo vị trí) để lấy 2 bình luận trước đó làm ngữ cảnh.
    const ordered = t.comments
      .map((c, i) => ({ c, i }))
      .sort((a, b) => (a.c.createdAt < b.c.createdAt ? -1 : a.c.createdAt > b.c.createdAt ? 1 : a.i - b.i))
      .map((x) => x.c);
    const report = buildReport(t.title, t.description);
    ordered.forEach((c, pos) => {
      if (!isCandidateComment(c.body, c.actor)) return;
      candidates++;
      if (store.hasComment(c.commentId)) {
        alreadyClassified++;
        return;
      }
      jobs.push({
        issueKey: t.issueKey,
        system,
        commentId: c.commentId,
        createdAt: c.createdAt,
        report,
        prev: ordered.slice(Math.max(0, pos - 2), pos).map((p) => ({ actor: p.actor, createdAt: p.createdAt, text: p.body })),
        comment: { actor: c.actor, createdAt: c.createdAt, text: c.body },
      });
    });
  }

  const summary: IngestSummary = {
    scannedTickets: tickets.length,
    candidates,
    alreadyClassified,
    toClassify: jobs.length,
    classified: 0,
    needsInfo: 0,
    errors: 0,
    dryRun,
  };
  if (dryRun) return summary;

  let done = 0;
  const runJob = async (job: Job): Promise<void> => {
    try {
      const res = await classifyComment(
        llm,
        { report: job.report, prev: job.prev, comment: job.comment },
        opts.completeFn,
        opts.timeoutMs,
      );
      store.upsertComment({
        commentId: job.commentId,
        issueKey: job.issueKey,
        system: job.system,
        createdAt: Date.parse(job.createdAt) || 0,
        needsInfo: res.needsInfo,
        kind: res.kind,
        items: res.items,
        alreadyInReport: res.alreadyInReport,
        model: res.model,
        classifiedAt: now(),
      });
      summary.classified++;
      if (res.needsInfo) summary.needsInfo++;
    } catch (err) {
      // Không ghi gì: lần ingest sau sẽ thử lại bình luận này.
      summary.errors++;
      log(`[ask-learn] lỗi ${job.issueKey}: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`);
    }
    done++;
    if (done % PROGRESS_EVERY === 0 || done === jobs.length) {
      log(`[ask-learn] phân loại ${done}/${jobs.length} (cần bổ sung: ${summary.needsInfo}, lỗi: ${summary.errors})`);
    }
  };

  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await runJob(job);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return summary;
}
