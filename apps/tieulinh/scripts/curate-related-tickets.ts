#!/usr/bin/env bun
/**
 * Chốt ticket tương tự hàng loạt cho các ticket đã có nguyên nhân người viết (ADR-0007).
 *
 * Cách dùng:
 *   bun scripts/curate-related-tickets.ts [--project TECH] [--issue TECH-920] [--limit N] [--mode pinned|suggested] [--apply]
 *
 * Mặc định là CHẠY THỬ (dry-run), chỉ tính toán và in kết quả, không ghi gì lên Itsaplan.
 * CẢNH BÁO: --apply ghi lên Itsaplan thật (cả ticket cũ) — chỉ chạy khi người dùng đồng ý sau khi xem bản chạy thử.
 */
import { createItsaplanClient } from "../lib/itsaplan/client-factory";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ItsaplanIssue } from "@vuihoc/bot-core/itsaplan";
import { MemgraphClient } from "../lib/kg/memgraph-client";
import { LlmSimilarTickets } from "../lib/kg/similar-ticket-source";
import { OnyxRestSearchClient } from "../lib/onyx/rest-search";
import { classifyColumn } from "@vuihoc/bot-core/itsaplan";
import {
  RelatedTicketsCurator,
  type CuratorResult,
  type CuratorStatus,
} from "../worker/related-curator";
import { isLlmConfigured, llmConfigFromEnv } from "../worker/llm";

const args = process.argv.slice(2);
const getArg = (name: string, fallback?: string): string | undefined => {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const hasFlag = (name: string): boolean => args.includes(name);

const apply = hasFlag("--apply");
// --mode pinned|suggested: chạy từng đợt (pinned không cần LLM, nhanh; suggested cần LLM, chậm).
const onlyModeArg = getArg("--mode");
const onlyMode = onlyModeArg === "pinned" || onlyModeArg === "suggested" ? onlyModeArg : undefined;
const issueArg = getArg("--issue");
const limitArg = getArg("--limit");
const limit = limitArg ? Number(limitArg) : 0;

let projectKey = (getArg("--project", process.env.ITSAPLAN_PROJECT_KEY) ?? "TECH").toUpperCase();
if (issueArg && !getArg("--project")) {
  const match = issueArg.match(/^([A-Za-z0-9_]+)-(\d+)$/);
  if (match) {
    projectKey = match[1].toUpperCase();
  }
}

const baseUrl = process.env.ITSAPLAN_BASE_URL;
const apiKey = process.env.ITSAPLAN_API_KEY;
if (!baseUrl || !apiKey) {
  console.error("Thiếu ITSAPLAN_BASE_URL / ITSAPLAN_API_KEY");
  process.exit(1);
}

// Itsaplan trả 500 khi gọi dồn — thử lại tối đa 3 lần giãn cách (xem dump-project-history.ts)
async function retry<T>(f: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await f();
    } catch (err) {
      if (attempt >= 3) throw err;
      await Bun.sleep(400 * (attempt + 1));
    }
  }
}

const itsaplan = createItsaplanClient(baseUrl, apiKey);
const memgraph = new MemgraphClient();

// Mode "suggested" (ticket chưa ghim) chỉ gợi ý được khi có cấu hình Onyx + LLM;
// thiếu thì curator vẫn chạy, suggested chỉ dọn theo mã/link người đã gắn.
const llm = llmConfigFromEnv();
const similarSource =
  process.env.ONYX_BASE_URL && process.env.ONYX_API_KEY && isLlmConfigured(llm)
    ? new LlmSimilarTickets({
        memgraph,
        onyx: new OnyxRestSearchClient(
          { baseUrl: process.env.ONYX_BASE_URL, apiKey: process.env.ONYX_API_KEY },
          itsaplan,
        ),
        llm,
        projectKey,
      })
    : undefined;

const curator = new RelatedTicketsCurator({
  itsaplan,
  corpus: memgraph,
  similarSource,
  projectKey,
  dryRun: !apply,
  onlyMode,
  delayMs: 0,
});

async function runCuratorWithRetry(issueId: number): Promise<CuratorResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await curator.run(issueId);
      if (res.status === "error" && attempt < 3) {
        await Bun.sleep(400 * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt >= 3) throw err;
      await Bun.sleep(400 * (attempt + 1));
    }
  }
}

try {
  let issues: ItsaplanIssue[] = [];

  if (issueArg) {
    let targetProject = projectKey;
    let targetSeq: number;
    const match = issueArg.match(/^([A-Za-z0-9_]+)-(\d+)$/);
    if (match) {
      targetProject = match[1].toUpperCase();
      targetSeq = Number(match[2]);
    } else if (/^\d+$/.test(issueArg)) {
      targetSeq = Number(issueArg);
    } else {
      console.error(`Mã ticket không hợp lệ: ${issueArg}`);
      process.exit(1);
    }
    const issue = await retry(() => itsaplan.getIssueByNumber(targetProject, targetSeq));
    issues = [issue];
  } else {
    const columns = await retry(() => itsaplan.listProjectColumns(projectKey));
    const canceledColumnIds = new Set(
      columns.filter((col) => classifyColumn(col) === "canceled").map((col) => col.id),
    );
    const rawIssues = await retry(() => itsaplan.listProjectIssues(projectKey, { limit: 1000 }));
    issues = rawIssues
      .filter((i) => !canceledColumnIds.has(i.columnId) && !i.archivedAt)
      .sort((a, b) => (a.sequenceNumber ?? 0) - (b.sequenceNumber ?? 0));
  }

  if (limit > 0) {
    issues = issues.slice(0, limit);
  }

  console.log(
    `Bắt đầu xử lý ${issues.length} ticket (${projectKey})${!apply ? " [CHẠY THỬ]" : " [GHI THẬT]"}`,
  );

  const statusCounts: Record<CuratorStatus, number> = {
    applied: 0,
    dry_run: 0,
    unchanged: 0,
    no_human_cause: 0,
    other_project: 0,
    error: 0,
  };
  let totalAddLinks = 0;
  let totalRemoveLinks = 0;
  let totalFieldChanges = 0;
  let totalPropagate = 0;

  interface ModeStats {
    applied: number;
    dry_run: number;
    unchanged: number;
    no_human_cause: number;
    other_project: number;
    error: number;
    addLinks: number;
    removeLinks: number;
    fieldChanges: number;
    propagate: number;
  }

  const newModeStats = (): ModeStats => ({
    applied: 0,
    dry_run: 0,
    unchanged: 0,
    no_human_cause: 0,
    other_project: 0,
    error: 0,
    addLinks: 0,
    removeLinks: 0,
    fieldChanges: 0,
    propagate: 0,
  });

  const modeStats: Record<"pinned" | "suggested" | "other", ModeStats> = {
    pinned: newModeStats(),
    suggested: newModeStats(),
    other: newModeStats(),
  };

  const KEY_REGEX = /\b[A-Z][A-Z0-9_]*-\d+\b/g;
  const focusResults = new Map<string, string>();

  const reports: Array<{
    identifier: string;
    status: CuratorStatus;
    mode?: "pinned" | "suggested";
    plan: CuratorResult["plan"] | null;
    propagate: string[];
    error?: string;
  }> = [];

  for (let i = 0; i < issues.length; i++) {
    if (i > 0) {
      await Bun.sleep(100);
    }
    const issue = issues[i];
    const res = await runCuratorWithRetry(issue.id);

    statusCounts[res.status] = (statusCounts[res.status] ?? 0) + 1;
    const mKey: "pinned" | "suggested" | "other" =
      res.mode === "pinned" ? "pinned" : res.mode === "suggested" ? "suggested" : "other";
    modeStats[mKey][res.status] = (modeStats[mKey][res.status] ?? 0) + 1;

    const rawBefore = res.fieldBefore ?? "";
    const keysBefore = String(rawBefore).toUpperCase().match(KEY_REGEX) ?? [];

    let addLinks = 0;
    let removeLinks = 0;
    let keysAfterCount = keysBefore.length;

    if (res.plan) {
      addLinks = res.plan.addLinks?.length ?? 0;
      removeLinks = res.plan.removeLinks?.length ?? 0;
      totalAddLinks += addLinks;
      totalRemoveLinks += removeLinks;
      modeStats[mKey].addLinks += addLinks;
      modeStats[mKey].removeLinks += removeLinks;
      if (res.plan.fieldValue !== null && res.plan.fieldValue !== undefined) {
        totalFieldChanges++;
        modeStats[mKey].fieldChanges++;
        keysAfterCount = (String(res.plan.fieldValue).toUpperCase().match(KEY_REGEX) ?? []).length;
      }
    }
    const propCount = res.propagate?.length ?? 0;
    if (propCount) {
      totalPropagate += propCount;
      modeStats[mKey].propagate += propCount;
    }

    const id = (res.identifier ?? issue.identifier).toUpperCase();
    if (id === "TECH-920") {
      const line = `[TECH-920] clusterId: ${res.plan?.clusterId ?? "none"} | desired: ${res.plan?.desired?.length ?? 0} ticket | lan ticket cũ: ${res.propagate?.length ?? 0}`;
      focusResults.set("TECH-920", line);
      console.log(`>>> ${line}`);
    } else if (id === "TECH-925" || /^TECH-(92[7-9]|93[0-4])$/i.test(id)) {
      const modeStr = res.mode ?? "none";
      const line = `[${id}] mode: ${modeStr} | trường: ${keysBefore.length} mã → ${keysAfterCount} mã | +link: ${addLinks} | -link: ${removeLinks}`;
      focusResults.set(id, line);
      console.log(`>>> ${line}`);
    }

    reports.push({
      identifier: id,
      status: res.status,
      mode: res.mode,
      plan: res.plan ?? null,
      propagate: res.propagate ?? [],
      ...(res.error ? { error: res.error } : {}),
    });
  }

  const focusSeqs = [920, 925, 927, 928, 929, 930, 931, 932, 933, 934];
  if (!issueArg && projectKey === "TECH") {
    for (const seq of focusSeqs) {
      const id = `TECH-${seq}`;
      if (!focusResults.has(id)) {
        try {
          const iss = await retry(() => itsaplan.getIssueByNumber("TECH", seq));
          const r = await runCuratorWithRetry(iss.id);
          if (seq === 920) {
            const line = `[TECH-920] clusterId: ${r.plan?.clusterId ?? "none"} | desired: ${r.plan?.desired?.length ?? 0} ticket | lan ticket cũ: ${r.propagate?.length ?? 0}`;
            focusResults.set(id, line);
          } else {
            const rawBefore = r.fieldBefore ?? "";
            const kBefore = String(rawBefore).toUpperCase().match(KEY_REGEX) ?? [];
            const kAfter =
              r.plan?.fieldValue !== null && r.plan?.fieldValue !== undefined
                ? (String(r.plan.fieldValue).toUpperCase().match(KEY_REGEX) ?? []).length
                : kBefore.length;
            const remLinks = r.plan?.removeLinks?.length ?? 0;
            const adLinks = r.plan?.addLinks?.length ?? 0;
            const modeStr = r.mode ?? "none";
            const line = `[${id}] mode: ${modeStr} | trường: ${kBefore.length} mã → ${kAfter} mã | +link: ${adLinks} | -link: ${remLinks}`;
            focusResults.set(id, line);
          }
        } catch {
          // ignore
        }
      }
    }
  }

  console.log("\n=== TỔNG KẾT ===");
  console.log(
    `[Toàn bộ] Trạng thái: applied=${statusCounts.applied}, dry_run=${statusCounts.dry_run}, ` +
      `unchanged=${statusCounts.unchanged}, no_human_cause=${statusCounts.no_human_cause}, ` +
      `error=${statusCounts.error}`,
  );
  console.log(
    `[Toàn bộ] Tổng +link: ${totalAddLinks} | Tổng gỡ link: ${totalRemoveLinks} | Tổng trường đổi: ${totalFieldChanges} | Tổng thêm vào ticket cũ: ${totalPropagate}`,
  );

  console.log("\n--- Tách theo Mode ---");
  console.log(
    `[Pinned] Trạng thái: applied=${modeStats.pinned.applied}, dry_run=${modeStats.pinned.dry_run}, unchanged=${modeStats.pinned.unchanged} | ` +
      `+link: ${modeStats.pinned.addLinks}, gỡ link: ${modeStats.pinned.removeLinks}, trường đổi: ${modeStats.pinned.fieldChanges}, thêm vào ticket cũ: ${modeStats.pinned.propagate}`,
  );
  console.log(
    `[Suggested] Trạng thái: applied=${modeStats.suggested.applied}, dry_run=${modeStats.suggested.dry_run}, unchanged=${modeStats.suggested.unchanged} | ` +
      `+link: ${modeStats.suggested.addLinks}, gỡ link: ${modeStats.suggested.removeLinks}, trường đổi: ${modeStats.suggested.fieldChanges}, thêm vào ticket cũ: ${modeStats.suggested.propagate}`,
  );
  if (modeStats.other.other_project || modeStats.other.error || modeStats.other.no_human_cause) {
    console.log(
      `[Khác] other_project=${modeStats.other.other_project}, error=${modeStats.other.error}, no_human_cause=${modeStats.other.no_human_cause}`,
    );
  }

  if (focusResults.size > 0) {
    console.log("\n=== KẾT QUẢ RIÊNG (TECH-920, TECH-925, TECH-927..934) ===");
    for (const seq of focusSeqs) {
      const line = focusResults.get(`TECH-${seq}`);
      if (line) console.log(line);
    }
  }

  const reportDir = path.resolve(import.meta.dir, "../data");
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }
  const isoTime = new Date().toISOString().replace(/[:.]/g, "");
  const reportPath = path.join(reportDir, `curate-related-${projectKey}-${isoTime}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(reports, null, 2), "utf-8");
  console.log(`Đã ghi báo cáo: ${reportPath}`);
} finally {
  curator.stop();
  await memgraph.close();
}
