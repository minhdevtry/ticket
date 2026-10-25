#!/usr/bin/env bun
/**
 * RECONCILE: dọn dẹp "ghost" Ticket nodes trong Memgraph Knowledge Graph —
 * những node chỉ có property `identifier` (do `MERGE (t:Ticket {identifier: ...})`
 * từ lệnh RELATES_TO thất bại trước đây, hoặc từ `relatedTickets` reference
 * đến ticket chưa từng được backfill), không có title/status/rootCause nên vô
 * giá trị cho mọi truy vấn trừ thành "dead-end row".
 *
 * Mỗi ghost được phân loại lại từ Itsaplan theo columnId hiện tại:
 *
 *  - columnId IN Done/Resolved (cột "completed"): ticket thật, ĐÃ đóng —
 *    reify bằng `upsertTicketNode` với title/status từ Itsaplan (KHÔNG gọi
 *    LLM extraction, vì rootCause/resolution cho ticket này sẽ trống — đây
 *    chỉ là "tồn tại thật", không phải tri thức thật). Edges RELATES_TO cũ
 *    vẫn trỏ đến identifier nên khi MERGE khớp identifier, các edge có sẵn
 *    được giữ nguyên (OPTIONAL MATCH trong upsertTicketNode sẽ nối lại với
 *    ticket thật sau khi node có title).
 *
 *  - columnId IN Canceled/Backlog/Todo/In_Progress: ticket chưa bao giờ
 *    đóng — DETACH DELETE ghost để loại khỏi graph (kéo theo cả edges
 *    RELATES_TO trỏ vào nó).
 *
 *  - Ticket không tìm thấy trên Itsaplan (404, identifier rỗng, v.v.):
 *    cũng DETACH DELETE — không có nguồn để reify.
 *
 *  - columnId unknown: bỏ qua, KHÔNG mutate. In ra dòng cảnh báo để xử lý tay.
 *
 * Tính idempotent: chạy lại nhiều lần không phá dữ liệu đã đúng.
 *
 * Dùng: bun run apps/tieulinh-legacy/scripts/reconcile-kg-ghosts.ts [--project TECH] [--apply]
 *   - Mặc định: DRY RUN, chỉ in decision table rồi thoát.
 *   - --apply: mới thật sự mutate Memgraph.
 *   - --project <KEY>: chọn project Itsaplan (mặc định ITSAPLAN_PROJECT_KEY
 *     từ env hoặc "TECH").
 */
import { createItsaplanClient } from "../lib/itsaplan/client-factory";
import * as fs from "node:fs";
import * as path from "node:path";
import { MemgraphClient } from "../lib/kg/memgraph-client";
import { getLogger } from "@vuihoc/bot-core/core";
import { classifyColumn } from "@vuihoc/bot-core/itsaplan";

// Nạp .env từ apps/tieulinh-legacy/ vì Bun chỉ load từ CWD — chạy script trực tiếp từ
// root repo mà không `cd intake` thì MEMGRAPH_URI / ITSAPLAN_* sẽ trống.
const intakeEnvPath = path.join(import.meta.dir, "..", ".env");
if (fs.existsSync(intakeEnvPath)) {
  for (const line of fs.readFileSync(intakeEnvPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Bóc quote thường gặp trong .env
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

const args = process.argv.slice(2);
const getArg = (name: string, fallback?: string) => {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const hasFlag = (name: string) => args.includes(name);

const projectKey = getArg("--project", process.env.ITSAPLAN_PROJECT_KEY) ?? "TECH";
const apply = hasFlag("--apply");

const baseUrl = process.env.ITSAPLAN_BASE_URL;
const apiKey = process.env.ITSAPLAN_API_KEY;
if (!baseUrl || !apiKey) {
  console.error("Thiếu ITSAPLAN_BASE_URL / ITSAPLAN_API_KEY (cần nạp apps/tieulinh-legacy/.env).");
  process.exit(1);
}

const itsaplan = createItsaplanClient(baseUrl, apiKey);
const memgraph = new MemgraphClient();

// Cột trạng thái theo cấu hình project (không hard-code vì project khác có
// thể đảo id). Map `columnId -> { kind, name }` để cả người đọc decision
// table lẫn logic classify đều khớp nhau.
const project = await itsaplan.getProject(projectKey);
const columnsById = new Map<number, { name: string; stateType: string }>();
for (const c of project.columns ?? []) {
  columnsById.set(c.id, { name: c.name, stateType: c.stateType });
}

// Chỉ cột hoàn tất (Done). Resolved của TECH cũng mang stateType completed nhưng
// chưa đóng — tri thức chỉ vào KG khi người xử lý đã đóng (ADR-0006).
const isCompletedColumn = (id: number) => {
  const c = columnsById.get(id);
  return !!c && classifyColumn(c as Parameters<typeof classifyColumn>[0]) === "done";
};
const isCanceledColumn = (id: number) => {
  const t = columnsById.get(id)?.stateType;
  return t === "canceled" || t === "backlog" || t === "unstarted" || t === "started";
};

// 1. Tìm ghost nodes: chỉ có key `identifier`, không có property khác
const session = (memgraph as any).driver.session();
let ghostIds: string[] = [];
try {
  const res = await session.run(
    `MATCH (t:Ticket) WHERE keys(t) = ["identifier"] RETURN t.identifier AS id ORDER BY t.identifier`,
  );
  ghostIds = res.records.map((r: any) => r.get("id") as string);
} finally {
  await session.close();
}

console.log(
  `Tìm thấy ${ghostIds.length} ghost Ticket node trong Memgraph${apply ? "" : " (DRY RUN)"}`,
);
if (ghostIds.length === 0) {
  await memgraph.close();
  process.exit(0);
}

type Decision =
  | {
      kind: "reify";
      identifier: string;
      columnId: number;
      columnName: string;
      title: string;
      status: string;
    }
  | { kind: "delete"; identifier: string; columnId: number; columnName: string; reason: string }
  | { kind: "skip"; identifier: string; reason: string };

const decisions: Decision[] = [];
const errors: Array<{ identifier: string; error: string }> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 2. Tra Itsaplan cho từng ghost — fail-open: lỗi 1 con không chặn phần còn lại
for (const identifier of ghostIds) {
  const seqMatch = identifier.match(/(\d+)$/);
  const seq = seqMatch ? Number(seqMatch[1]) : NaN;
  if (!seq || Number.isNaN(seq)) {
    decisions.push({
      kind: "skip",
      identifier,
      reason: `identifier không có sequence number hợp lệ`,
    });
    continue;
  }
  try {
    const issue = await itsaplan.getIssueByNumber(projectKey, seq);
    const colId = issue.columnId;
    const colMeta = columnsById.get(colId);

    if (isCompletedColumn(colId)) {
      decisions.push({
        kind: "reify",
        identifier,
        columnId: colId,
        columnName: colMeta?.name ?? `column-${colId}`,
        title: issue.title,
        status: colMeta?.name ?? "Done", // Giữ tên cột thật ("Done" / "Resolved" / ...)
      });
    } else if (isCanceledColumn(colId)) {
      decisions.push({
        kind: "delete",
        identifier,
        columnId: colId,
        columnName: colMeta?.name ?? `column-${colId}`,
        reason: `cột ${colMeta?.name ?? colId} (${colMeta?.stateType ?? "?"}) — ticket chưa đóng`,
      });
    } else {
      decisions.push({
        kind: "skip",
        identifier,
        reason: `columnId=${colId} (${colMeta?.stateType ?? "unknown"}) không thuộc nhóm completed/canceled — cần xử lý tay`,
      });
    }
  } catch (err: any) {
    // 404 hoặc lỗi mạng: coi như "không tìm thấy" → DELETE
    const msg = String(err?.message ?? err);
    decisions.push({
      kind: "delete",
      identifier,
      columnId: -1,
      columnName: "(missing)",
      reason: `Itsaplan trả lỗi: ${msg.slice(0, 200)}`,
    });
    errors.push({ identifier, error: msg });
  }
  // Rate-limit nhẹ tránh dập Itsaplan
  await sleep(80);
}

// 3. In decision table
const reify = decisions.filter(
  (d): d is Extract<Decision, { kind: "reify" }> => d.kind === "reify",
);
const del = decisions.filter(
  (d): d is Extract<Decision, { kind: "delete" }> => d.kind === "delete",
);
const skip = decisions.filter((d): d is Extract<Decision, { kind: "skip" }> => d.kind === "skip");

console.log("\n========================================");
console.log(`DECISION TABLE (${projectKey})`);
console.log("========================================");
console.log(`REIFY  (Done/Resolved, cập nhật title+status): ${reify.length}`);
for (const d of reify) {
  console.log(
    `  ${d.identifier}  [col ${d.columnId} ${d.columnName}] -> "${d.title.slice(0, 60)}"`,
  );
}
console.log(`DELETE (Canceled/Backlog/... hoặc mất tích Itsaplan): ${del.length}`);
for (const d of del) {
  console.log(`  ${d.identifier}  [${d.columnName}] ${d.reason.slice(0, 120)}`);
}
console.log(`SKIP   (cần xử lý tay): ${skip.length}`);
for (const d of skip) {
  console.log(`  ${d.identifier}  ${d.reason.slice(0, 140)}`);
}
console.log("----------------------------------------");
console.log(
  `Tổng: ${decisions.length} ghost (reify=${reify.length}, delete=${del.length}, skip=${skip.length})`,
);

if (!apply) {
  console.log("\nDRY RUN — không mutate. Chạy với --apply để thật sự thực thi:");
  console.log(
    `  bun run apps/tieulinh-legacy/scripts/reconcile-kg-ghosts.ts --project ${projectKey} --apply`,
  );
  await memgraph.close();
  process.exit(0);
}

// 4. --apply: mutate theo decision
console.log("\nĐang thực thi --apply ...");

const session2 = (memgraph as any).driver.session();
let reified = 0;
let deleted = 0;
let failed = 0;
try {
  for (const d of decisions) {
    if (d.kind === "reify") {
      try {
        // Reify: set title+status để node không còn là "ghost".
        // Không gọi LLM extraction vì rootCause/resolution sẽ trống — đây
        // là ticket DONE nhưng graph chưa có tri thức, và cố ép LLM chỉ
        // tạo hallucination. Để trống các trường knowledge, các query
        // similarity sẽ tự loại do keywordScore = 0.
        await memgraph.upsertTicketNode({
          identifier: d.identifier,
          title: d.title,
          status: d.status,
          priority: "Medium",
          createdAt: new Date().toISOString(),
          // Không ghi rootCause/resolution/causeTaxon
          relatedTickets: [],
        });
        reified++;
        console.log(`  ✅ REIFY ${d.identifier} -> "${d.title.slice(0, 50)}"`);
      } catch (err: any) {
        failed++;
        console.log(`  ❌ REIFY ${d.identifier}: ${err.message}`);
      }
    } else if (d.kind === "delete") {
      try {
        await session2.run(`MATCH (g:Ticket {identifier: $id}) DETACH DELETE g`, {
          id: d.identifier,
        });
        deleted++;
        console.log(`  🗑️  DELETE ${d.identifier}`);
      } catch (err: any) {
        failed++;
        console.log(`  ❌ DELETE ${d.identifier}: ${err.message}`);
      }
    }
    // skip: không mutate
  }
} finally {
  await session2.close();
}

await memgraph.close();

console.log("\n========================================");
console.log("KẾT QUẢ RECONCILE");
console.log(`  Reify:  ${reified}`);
console.log(`  Delete: ${deleted}`);
console.log(`  Skip:   ${skip.length}`);
console.log(`  Failed: ${failed}`);
console.log("========================================");
if (errors.length > 0) {
  console.log("\nItsaplan errors (đã treat as delete):");
  for (const e of errors.slice(0, 10)) console.log(`  ${e.identifier}: ${e.error.slice(0, 120)}`);
}
