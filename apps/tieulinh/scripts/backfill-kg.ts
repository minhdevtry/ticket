#!/usr/bin/env bun
/**
 * BACKFILL: Nạp toàn bộ ticket TECH đã hoàn tất (Done) vào Memgraph Knowledge Graph.
 *
 * Quét mọi ticket của project TECH (mặc định), lọc theo cột hoàn tất (không gồm Resolved —
 * tri thức chỉ nạp khi người xử lý đã đóng, ADR-0006),
 * chạy syncDoneTicketToKnowledgeGraph cho từng ticket — có rate-limit, retry,
 * và checkpoint lưu file để chạy lại mà không phải làm lại từ đầu.
 *
 * Dùng: bun run apps/tieulinh/scripts/backfill-kg.ts [--project TECH] [--limit N] [--dry-run] [--rebuild]
 *
 * --rebuild: sao lưu rồi XOÁ toàn bộ node Ticket của dự án trong KG, nạp lại từ đầu.
 * Dùng khi đổi cách nạp (26/09, ADR-0007: KG cũ còn cạnh do bot tạo). Bản sao
 * lưu ở data/kg-<dự án>-backup-<giờ>.json.
 */
import * as fs from "node:fs";
import { ItsaplanClient } from "../lib/itsaplan/client";
import { MemgraphClient } from "../lib/kg/memgraph-client";
import { syncDoneTicketToKnowledgeGraph } from "../worker/kg-sync";
import { classifyColumn } from "../lib/itsaplan/ticket-state";
import { getLogger } from "@vuihoc/bot-core/core";
import { llmConfigFromEnv } from "../worker/llm";

const args = process.argv.slice(2);
const getArg = (name: string, fallback?: string) => {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const hasFlag = (name: string) => args.includes(name);

const projectKey = getArg("--project", process.env.ITSAPLAN_PROJECT_KEY) ?? "TECH";
const limit = Number(getArg("--limit", "0")) || 0;
const dryRun = hasFlag("--dry-run");
const rebuild = hasFlag("--rebuild");
const concurrency = Math.max(1, Number(getArg("--concurrency", "1")) || 1);
const checkpointFile = `data/backfill-kg-${projectKey}.json`;

const baseUrl = process.env.ITSAPLAN_BASE_URL;
const apiKey = process.env.ITSAPLAN_API_KEY;
if (!baseUrl || !apiKey) {
  console.error("Thiếu ITSAPLAN_BASE_URL / ITSAPLAN_API_KEY");
  process.exit(1);
}

const completedColumnIds = new Set<number>();
const itsaplan = new ItsaplanClient(baseUrl, apiKey);

// Xác định cột "hoàn thành" từ cấu hình project
const project = await itsaplan.getProject(projectKey);
for (const col of project.columns || []) {
  if (classifyColumn(col) === "done") completedColumnIds.add(col.id);
}
console.log(`Cột hoàn thành của ${projectKey}: ${[...completedColumnIds].join(", ")}`);

// Lấy danh sách issues
const issues = (await itsaplan.listProjectIssues(projectKey, { limit: 1000 }))
  .filter((i) => completedColumnIds.has(i.columnId))
  .sort((a, b) => (a.sequenceNumber ?? 0) - (b.sequenceNumber ?? 0));

console.log(`Tìm thấy ${issues.length} ticket hoàn tất trong ${projectKey}`);

// Checkpoint: bỏ qua ticket đã nạp thành công ở lần chạy trước
let done: string[] = [];
if (rebuild && !dryRun && fs.existsSync(checkpointFile)) fs.unlinkSync(checkpointFile);
if (fs.existsSync(checkpointFile)) {
  done = JSON.parse(fs.readFileSync(checkpointFile, "utf-8"));
  console.log(`Checkpoint: ${done.length} ticket đã nạp từ trước, bỏ qua.`);
}
const doneSet = new Set(done);

let targets = issues.filter((i) => !doneSet.has(i.identifier));
if (limit > 0) targets = targets.slice(0, limit);
console.log(`Cần nạp: ${targets.length} ticket${dryRun ? " (DRY RUN)" : ""}`);

if (dryRun) {
  for (const t of targets.slice(0, 20)) {
    console.log(`  [dry] ${t.identifier}: ${t.title}`);
  }
  if (targets.length > 20) console.log(`  ... và ${targets.length - 20} ticket nữa`);
  process.exit(0);
}

const memgraph = new MemgraphClient();
await memgraph.ensureConstraints();

if (rebuild) {
  const session = (memgraph as any).driver.session();
  try {
    const prefix = `${projectKey.toUpperCase()}-`;
    const res = await session.run(
      `MATCH (t:Ticket) WHERE t.identifier STARTS WITH $prefix
       OPTIONAL MATCH (t)-[r]->(x)
       RETURN properties(t) AS node, collect({type: type(r), to: coalesce(x.identifier, x.id, x.name, x.text)}) AS edges`,
      { prefix },
    );
    const backup = `data/kg-${projectKey}-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    fs.writeFileSync(backup, JSON.stringify(res.records.map((r: any) => r.toObject())));
    console.log(`Đã sao lưu ${res.records.length} ticket → ${backup}`);
    await session.run(`MATCH (t:Ticket) WHERE t.identifier STARTS WITH $prefix DETACH DELETE t`, {
      prefix,
    });
    // Memgraph 2.14 chưa có pattern trong WHERE — đếm bằng OPTIONAL MATCH.
    await session.run(
      `MATCH (rc:RootCause) OPTIONAL MATCH (x)-[:CAUSED_BY]->(rc) WITH rc, count(x) AS n WHERE n = 0 DETACH DELETE rc`,
    );
    await session.run(
      `MATCH (r:Resolution) OPTIONAL MATCH (x)-[:RESOLVED_BY]->(r) WITH r, count(x) AS n WHERE n = 0 DETACH DELETE r`,
    );
    console.log(`Đã xoá ticket ${prefix}* khỏi KG, nạp lại từ đầu.`);
  } finally {
    await session.close();
  }
}

const llmConfig = llmConfigFromEnv();

let success = 0;
let failed = 0;
const errors: Array<{ identifier: string; error: string }> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function backfillOne(i: number, t: (typeof targets)[number]) {
  try {
    // Cụm nguyên nhân tính một lần ở cuối, không phải sau từng ticket.
    const result = await syncDoneTicketToKnowledgeGraph(itsaplan, memgraph, t.id, llmConfig, {
      projectKey,
      recomputeClusters: false,
    });
    if (result.success) {
      success++;
      done.push(t.identifier);
      // Lưu checkpoint ngay sau mỗi ticket — nếu tiến trình bị dừng/kill
      // giữa chừng (Ctrl+C, mất kết nối...), chạy lại phải tiếp tục đúng từ
      // ticket kế tiếp, không được xử lý lại ticket đã xong.
      fs.writeFileSync(checkpointFile, JSON.stringify(done, null, 0));
      const rc = result.node?.rootCause?.slice(0, 60) ?? "";
      console.log(`[${i + 1}/${targets.length}] ✅ ${t.identifier}: ${rc}`);
    } else {
      failed++;
      errors.push({ identifier: t.identifier, error: result.error ?? "unknown" });
      console.log(`[${i + 1}/${targets.length}] ⚠️  ${t.identifier}: ${result.error}`);
    }
  } catch (err: any) {
    failed++;
    errors.push({ identifier: t.identifier, error: err.message });
    console.log(`[${i + 1}/${targets.length}] ❌ ${t.identifier}: ${err.message}`);
  }
  // Rate limit: nghỉ 200ms giữa các ticket để không dập server
  await sleep(200);
}

// --concurrency N: N luồng song song (mỗi ticket một lượt LLM — tuần tự thì ~1 giờ cho TECH).
let cursor = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (cursor < targets.length) {
      const i = cursor++;
      await backfillOne(i, targets[i]);
    }
  }),
);

fs.writeFileSync(checkpointFile, JSON.stringify(done, null, 0));

const clusters = await memgraph.recomputeCauseClusters();
console.log(`Cụm nguyên nhân: ${clusters.clusters} cụm trên ${clusters.tickets} ticket.`);
const stats = await memgraph.getGraphStats();
await memgraph.close();

console.log("\n========================================");
console.log(`KẾT QUẢ BACKFILL ${projectKey}`);
console.log(`  Thành công: ${success}`);
console.log(`  Thất bại:   ${failed}`);
console.log(`  Đồ thị:     ${stats.nodes} nodes, ${stats.edges} edges`);
console.log("========================================");
if (errors.length > 0) {
  console.log("\nLỗi đầu tiên:");
  for (const e of errors.slice(0, 10)) {
    console.log(`  ${e.identifier}: ${e.error}`);
  }
}
