#!/usr/bin/env bun
/**
 * RELABEL: Chuẩn hoá nhãn "Hệ thống" trong Memgraph về danh mục 9 giá trị
 * (lib/kg/system-taxonomy.json).
 *
 * Bối cảnh (audit 2026-09-23): 62% ticket đối chiếu được có System sai — LLM
 * extract sinh 15 nhãn trong khi ground truth (Excel tech lead) chỉ có 7. Rule
 * nghiệp vụ tech lead: OMS chỉ setup sản phẩm/CTKM; tạo đơn, chuyển phí,
 * upsale, chuyển đổi sản phẩm → CRM (user đã chốt: OMS xoá hẳn, TECH-446 → CRM).
 *
 * Dùng: bun run apps/tieulinh-legacy/scripts/relabel-kg-systems.ts [--apply]
 *   - Mặc định DRY RUN: chỉ in quyết định + review-list, không mutate.
 *   - --apply: thực thi. Idempotent — chạy lại không đổi gì.
 *   - Backup: data/backfill-kg-TECH.json giữ nguyên; script tự export snapshot
 *     IN_SYSTEM ra data/system-relabel-backup-<ts>.json trước khi mutate.
 *
 * Thuật toán:
 *   1. Đọc toàn bộ (Ticket)-[:IN_SYSTEM]->(System) từ graph.
 *   2. Ticket có nhãn ≠ canonical → normalizeSystemName:
 *      - alias/keyword chắc chắn → re-label (MERGE node chuẩn, chuyển cạnh,
 *        xoá cạnh cũ, DETACH DELETE node cũ nếu trống cạnh).
 *      - needsReview (nhãn trộn App/Web+DUO, fallback, bucket VH_Tự học vs DUO
 *        chưa chốt với tech lead) → gán tạm giá trị normalize NHƯNG đưa vào
 *        review-list in cuối để người duyệt tay.
 *   3. Ticket KHÔNG có System (6 con): gán theo keyword trên title, không chắc
 *      thì vào review-list.
 *   4. Báo cáo trước/sau: đếm nhãn.
 */

import { createItsaplanClient } from "../lib/itsaplan/client-factory";
import fs from "node:fs";
import type { Record as Neo4jRecord } from "neo4j-driver";
import { MemgraphClient } from "../lib/kg/memgraph-client";
import {
  normalizeSystemName,
  CANONICAL_SYSTEMS,
  type CanonicalSystem,
} from "../lib/kg/system-taxonomy";
import systemTaxonomy from "../lib/kg/system-taxonomy.json";

const APPLY = process.argv.includes("--apply");
const BACKUP_PATH = `data/system-relabel-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;

// ---------- helpers ----------

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const p of [".env", "../../.env"]) {
    try {
      const txt = fs.readFileSync(new URL(p, import.meta.url), "utf-8");
      for (const line of txt.split("\n")) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !(m[1] in out)) out[m[1]] = m[2].trim();
      }
      break; // .env đầu tiên tìm thấy là đủ
    } catch {
      /* tiếp tục */
    }
  }
  return out;
}

const env = loadEnv();

// ---------- main ----------

const memgraph = new MemgraphClient();
const itsaplan = createItsaplanClient(env.ITSAPLAN_BASE_URL!, env.ITSAPLAN_API_KEY!);

interface Row {
  identifier: string;
  title: string | null;
  system: string | null;
}

async function readAllTickets(): Promise<Row[]> {
  const session = (memgraph as any).driver.session();
  try {
    const res = await session.run(
      `MATCH (t:Ticket)
       OPTIONAL MATCH (t)-[:IN_SYSTEM]->(s:System)
       RETURN t.identifier AS identifier, t.title AS title, s.name AS system`,
    );
    return res.records.map((r: Neo4jRecord) => ({
      identifier: r.get("identifier"),
      title: r.get("title") ?? null,
      system: r.get("system") ?? null,
    }));
  } finally {
    await session.close();
  }
}

async function backup(rows: Row[]): Promise<void> {
  fs.writeFileSync(BACKUP_PATH, JSON.stringify(rows, null, 1), "utf-8");
  console.log(`💾 Backup (read-only snapshot): ${BACKUP_PATH} (${rows.length} ticket)`);
}

async function relabel(identifier: string, newSystem: CanonicalSystem): Promise<void> {
  const session = (memgraph as any).driver.session();
  try {
    // MERGE node chuẩn → chuyển cạnh → xoá cạnh cũ → dọn node cũ nếu trống
    await session.run(
      `MATCH (t:Ticket {identifier: $id})
       OPTIONAL MATCH (t)-[old:IN_SYSTEM]->(sOld:System)
       DELETE old
       WITH t
       MERGE (sNew:System {name: $sys})
       MERGE (t)-[:IN_SYSTEM]->(sNew)
       WITH sNew
       OPTIONAL MATCH (sNew)<-[r:IN_SYSTEM]-()
       WITH sNew, count(r) AS degree
       WHERE degree = 0
       DETACH DELETE sNew`,
      { id: identifier, sys: newSystem },
    );
  } finally {
    await session.close();
  }
}

async function relabelSafe(identifier: string, newSystem: CanonicalSystem): Promise<void> {
  // Bản an toàn hơn: xoá cạnh cũ TRỪ cạnh tới node chuẩn, rồi dọn node mồ côi
  const session = (memgraph as any).driver.session();
  try {
    await session.run(
      `MATCH (t:Ticket {identifier: $id})
       OPTIONAL MATCH (t)-[old:IN_SYSTEM]->(sOld:System)
       WHERE sOld.name <> $sys
       DELETE old
       WITH DISTINCT t
       MERGE (sNew:System {name: $sys})
       MERGE (t)-[:IN_SYSTEM]->(sNew)`,
      { id: identifier, sys: newSystem },
    );
    // Dọn node không còn ticket nào trỏ tới (trừ node chuẩn có thể vừa MERGE lại)
    // Memgraph không hỗ trợ NOT ()-[]->() — dùng OPTIONAL MATCH + WHERE IS NULL
    await session.run(
      `MATCH (s:System)
       WHERE NOT s.name IN $canonical
       OPTIONAL MATCH (t:Ticket)-[:IN_SYSTEM]->(s)
       WITH s, count(t) AS degree
       WHERE degree = 0
       DETACH DELETE s`,
      { canonical: [...CANONICAL_SYSTEMS] },
    );
  } finally {
    await session.close();
  }
}

async function countBySystem(): Promise<Record<string, number>> {
  const session = (memgraph as any).driver.session();
  try {
    const res = await session.run(
      `MATCH (t:Ticket)
       OPTIONAL MATCH (t)-[:IN_SYSTEM]->(s:System)
       RETURN coalesce(s.name, "<KHÔNG CÓ>") AS system, count(t) AS n
       ORDER BY n DESC`,
    );
    const out: Record<string, number> = {};
    for (const r of res.records) out[r.get("system")] = r.get("n").toNumber();
    return out;
  } finally {
    await session.close();
  }
}

async function main(): Promise<void> {
  console.log(
    `=== RELABEL System — ${APPLY ? "APPLY (mutate thật)" : "DRY RUN (không mutate)"} ===`,
  );
  console.log(`Danh mục chuẩn: ${CANONICAL_SYSTEMS.join(", ")}\n`);

  const before = await countBySystem();
  console.log("TRƯỚC:");
  for (const [s, n] of Object.entries(before)) console.log(`  ${String(n).padStart(4)}  ${s}`);
  console.log();

  const rows = await readAllTickets();
  await backup(rows);

  const reviewList: Array<{
    identifier: string;
    title: string;
    from: string;
    to: string;
    reason: string;
  }> = [];
  let relabeled = 0;
  let kept = 0;

  for (const row of rows) {
    const cur = row.system ?? "";
    if (cur && (CANONICAL_SYSTEMS as readonly string[]).includes(cur)) {
      kept++;
      continue; // đã chuẩn
    }

    let target: CanonicalSystem | undefined;
    let via = "";
    const reason = "";

    if (cur) {
      const MIXED =
        cur === "Vuihoc (App/Web_Vuihoc + ERP_DUO)" ||
        cur === "Web_Vuihoc" ||
        cur === "App/Web_Vuihoc";
      if (MIXED && row.title) {
        // Nhãn trộn không nói gì về hệ thống thật — phân bằng keyword trên
        // title (Duo/ERP-DUO/Bitu → DUO; còn lại → VH_Tự học). Vẫn vào
        // review-list vì ranh giới VH_Tự học vs DUO chưa chốt với tech lead.
        const n = normalizeSystemName(row.title);
        target = n?.via !== "fallback" ? n!.value : "VH_Tự học";
        via = "keyword(title)-trong-nhãn-trộn";
        reviewList.push({
          identifier: row.identifier,
          title: row.title ?? "",
          from: cur,
          to: target,
          reason: `nhãn trộn → đo theo title — CHỜ CHỐT ranh giới VH_Tự học vs DUO`,
        });
      } else {
        const n = normalizeSystemName(cur);
        if (!n) continue;
        target = n.value;
        via = n.via;
        if (n.needsReview) {
          reviewList.push({
            identifier: row.identifier,
            title: row.title ?? "",
            from: cur,
            to: n.value,
            reason: `nhãn cũ "${cur}" → alias/keyword (${via}) — bucket chưa chốt`,
          });
        }
      }
    } else {
      // Không có System — thử keyword trên title
      const n = normalizeSystemName(row.title ?? "");
      if (n && n.via !== "fallback") {
        target = n.value;
        via = `keyword(title)`;
        if (n.needsReview) {
          reviewList.push({
            identifier: row.identifier,
            title: row.title ?? "",
            from: "<trống>",
            to: n.value,
            reason: "thiếu System, gán theo keyword title — bucket chưa chốt",
          });
        }
      } else {
        reviewList.push({
          identifier: row.identifier,
          title: row.title ?? "",
          from: "<trống>",
          to: "<không đoán được>",
          reason: "thiếu System, title không có keyword nhận diện — CẦN NGƯỜI GÁN",
        });
        continue;
      }
    }

    if (!target) continue;
    console.log(
      `  ${APPLY ? "🔧" : "[dry]"} ${row.identifier}: ${cur || "<trống>"} → ${target} (${via})`,
    );
    if (APPLY) await relabelSafe(row.identifier, target);
    relabeled++;
  }

  console.log(`\n=== KẾT QUẢ ${APPLY ? "SAU KHI APPLY" : "(dry run — chưa mutate)"} ===`);
  console.log(`  Giữ nguyên (đã chuẩn): ${kept}`);
  console.log(`  Re-label: ${relabeled}`);
  console.log(`  Review-list: ${reviewList.length}`);

  if (reviewList.length) {
    console.log("\n=== REVIEW LIST (cần người duyệt tay — không gán bừa) ===");
    for (const r of reviewList) {
      console.log(`  ${r.identifier}  "${r.title.slice(0, 60)}"  ${r.from} → ${r.to}`);
      console.log(`     lý do: ${r.reason}`);
    }
  }

  const after = await countBySystem();
  console.log("\nSAU:");
  for (const [s, n] of Object.entries(after)) console.log(`  ${String(n).padStart(4)}  ${s}`);

  if (!APPLY) {
    console.log(
      `\nĐể thực thi thật: bun run apps/tieulinh-legacy/scripts/relabel-kg-systems.ts --apply`,
    );
    console.log(`(Backup đã ghi sẵn tại ${BACKUP_PATH} — dùng nó để rollback nếu cần.)`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("relabel-kg-systems thất bại:", e);
  process.exit(1);
});
