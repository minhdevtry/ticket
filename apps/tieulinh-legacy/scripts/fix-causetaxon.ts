#!/usr/bin/env bun
/**
 * FIX-CAUSETAXON: đóng ~30% lỗi phân loại đã confirm trong audit 2026-09-23
 * (docs/KG_FIELD_QUALITY_ASSESSMENT.md — verdict fix-now, user đã duyệt).
 *
 * 5 step, mỗi step idempotent, default DRY RUN, --apply mới mutate:
 *   1. boundary   — DATA_SYNC_MISMATCH + từ khoá chuyển phí/... → UPSALE_TRANSFER_BUG
 *                   (expect 5: TECH-415/469/504/510/680; TECH-544 KHÔNG bị đụng)
 *   2. ghosts     — xoá 2 node taxon rỗng: DATA_DUPLICATE_ACCOUNT, PAYMENT_GATEWAY_TIMEOUT
 *   3. insufficient — 11 ticket "CRM không gọi được" INSUFFICIENT_INFO → SIP_TELEPHONY_FAILURE
 *                   (TECH-347/513/517/525/526/527/528/532/534/535/536 — verify: TECH-347
 *                   rootCause nói lỗi cache, giữ case để reading quyết: nếu RC ghi rõ
 *                   "không liên quan tổng đài" thì giữ nguyên + note)
 *   4. unclassified — 6 ticket thiếu CLASSIFIED_AS (reify từ reconcile-ghosts) → classify
 *                   theo keyword title chắc chắn; không chắc → review-list
 *   5. report     — inventory trước/sau
 *
 * Dùng: bun run apps/tieulinh-legacy/scripts/fix-causetaxon.ts [--apply]
 */
import * as fs from "node:fs";
import type { Record as Neo4jRecord } from "neo4j-driver";
import { MemgraphClient } from "../lib/kg/memgraph-client";

const APPLY = process.argv.includes("--apply");

const memgraph = new MemgraphClient();

const BOUNDARY_KEYWORDS = /chuyển phí|chuyển nhượng|chuyển đổi|upsale|tách gói|sau khi chuyển/i;
// TECH-347: rootCause ghi rõ "lỗi cache trình duyệt... không liên quan tổng đài"
// → KHÔNG ép SIP; giữ INSUFFICIENT_INFO (đúng nghĩa: không đủ info để chốt cơ chế).
const SIP_CLUSTER = [
  "TECH-513",
  "TECH-517",
  "TECH-525",
  "TECH-526",
  "TECH-527",
  "TECH-528",
  "TECH-532",
  "TECH-534",
  "TECH-535",
  "TECH-536",
];
// 6 ticket reify từ reconcile (chỉ có title từ Itsaplan, chưa có RootCause).
// Gán theo keyword title — chắc chắn thì gán, không chắc thì review.
const UNCLASSIFIED_ASSIGN: Record<string, { taxon: string; reason: string }> = {
  "TECH-801": {
    taxon: "RENDER_UI_DISPLAY_BUG",
    reason: "CRM không hiển thị kết quả test — lỗi hiển thị",
  },
  "TECH-760": {
    taxon: "UPSALE_TRANSFER_BUG",
    reason: "chuyển phí sai số buổi — đúng định nghĩa UPSALE",
  },
  "TECH-790": {
    taxon: "DATA_SYNC_MISMATCH",
    reason: "CARE hiển thị sai số buổi — lệch dữ liệu nền",
  },
  "TECH-791": {
    taxon: "DATA_SYNC_MISMATCH",
    reason: "hồ sơ 0/110 thay vì 78/110 — lệch dữ liệu nền",
  },
  "TECH-761": {
    taxon: "CONFIG_PERMISSION_ACCOUNT",
    reason: "ngân hàng câu hỏi yêu cầu đăng ký — thiếu quyền/config truy cập",
  },
  "TECH-746": {
    taxon: "RENDER_UI_DISPLAY_BUG",
    reason: "chuyển cuốn chiếu không hiển thị trên CARE — lỗi hiển thị",
  },
};
const GHOST_TAXA = ["DATA_DUPLICATE_ACCOUNT", "PAYMENT_GATEWAY_TIMEOUT"];

interface Row {
  id: string;
  taxon: string | null;
  title: string | null;
  rc: string | null;
}

async function readTaxa(): Promise<Row[]> {
  const session = (memgraph as any).driver.session();
  try {
    const res = await session.run(
      `MATCH (t:Ticket)
       OPTIONAL MATCH (t)-[:CLASSIFIED_AS]->(ct:CauseTaxon)
       OPTIONAL MATCH (t)-[:CAUSED_BY]->(rc:RootCause)
       RETURN t.identifier AS id, ct.id AS taxon, t.title AS title, rc.text AS rc`,
    );
    return res.records.map((r: Neo4jRecord) => ({
      id: r.get("id"),
      taxon: r.get("taxon") ?? null,
      title: r.get("title") ?? null,
      rc: r.get("rc") ?? null,
    }));
  } finally {
    await session.close();
  }
}

async function backup(rows: Row[], path: string): Promise<void> {
  fs.writeFileSync(
    path,
    JSON.stringify(
      rows.filter((r) => r.taxon),
      null,
      1,
    ),
    "utf-8",
  );
  console.log(`💾 Backup: ${path} (${rows.filter((r) => r.taxon).length} cạnh CLASSIFIED_AS)`);
}

async function setTaxon(id: string, taxon: string): Promise<void> {
  await memgraph.setCauseTaxon(id, taxon);
}

async function deleteTaxonNode(taxon: string): Promise<void> {
  const session = (memgraph as any).driver.session();
  try {
    await session.run(`MATCH (ct:CauseTaxon {id: $t}) DETACH DELETE ct`, { t: taxon });
  } finally {
    await session.close();
  }
}

async function distribution(): Promise<Array<[string, number]>> {
  const session = (memgraph as any).driver.session();
  try {
    const res = await session.run(
      `MATCH (ct:CauseTaxon)
       OPTIONAL MATCH (t:Ticket)-[:CLASSIFIED_AS]->(ct)
       WITH ct, count(t) AS n RETURN ct.id AS taxon, n ORDER BY n DESC`,
    );
    return res.records.map((r: Neo4jRecord) => [r.get("taxon"), r.get("n").toNumber()]);
  } finally {
    await session.close();
  }
}

async function main(): Promise<void> {
  console.log(`=== FIX CAUSETAXON — ${APPLY ? "APPLY" : "DRY RUN"} ===\n`);
  const before = await distribution();
  console.log("TRƯỚC:", before.map(([t, n]) => `${t}=${n}`).join(", "), "\n");

  const rows = await readTaxa();
  await backup(
    rows,
    `data/taxon-relabel-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`,
  );

  let changed = 0;
  const review: string[] = [];

  // Step 1 — boundary rule
  console.log("--- Step 1: boundary DATA_SYNC → UPSALE");
  for (const r of rows) {
    if (r.taxon !== "DATA_SYNC_MISMATCH") continue;
    const hay = `${r.title ?? ""} ${r.rc ?? ""}`;
    if (BOUNDARY_KEYWORDS.test(hay)) {
      console.log(
        `  ${APPLY ? "🔧" : "[dry]"} ${r.id}: DATA_SYNC_MISMATCH → UPSALE_TRANSFER_BUG (match: "${hay.match(BOUNDARY_KEYWORDS)?.[0]}")`,
      );
      if (APPLY) await setTaxon(r.id, "UPSALE_TRANSFER_BUG");
      changed++;
    }
  }

  // Step 2 — ghost taxa
  console.log("--- Step 2: ghost taxa");
  for (const g of GHOST_TAXA) {
    const hasEdges = before.find(([t, n]) => t === g && n > 0);
    if (!hasEdges) {
      console.log(`  ${APPLY ? "🗑️ " : "[dry]"} xoá node rỗng ${g}`);
      if (APPLY) await deleteTaxonNode(g);
    } else {
      console.log(`  ⚠️ ${g} có cạnh (${hasEdges[1]}) — KHÔNG xoá, vào review`);
      review.push(`ghost ${g} có ${hasEdges[1]} cạnh`);
    }
  }

  // Step 3 — INSUFFICIENT cluster → SIP
  console.log("--- Step 3: INSUFFICIENT_INFO CRM-không-gọi-được → SIP_TELEPHONY_FAILURE");
  for (const r of rows) {
    if (r.taxon !== "INSUFFICIENT_INFO") continue;
    if (SIP_CLUSTER.includes(r.id)) {
      console.log(
        `  ${APPLY ? "🔧" : "[dry]"} ${r.id}: → SIP_TELEPHONY_FAILURE (cụm CRM không gọi)`,
      );
      if (APPLY) await setTaxon(r.id, "SIP_TELEPHONY_FAILURE");
      changed++;
    } else if (r.id === "TECH-347") {
      console.log(
        `  ⏭️  TECH-347 giữ INSUFFICIENT_INFO — rootCause ghi rõ lỗi cache, không liên quan tổng đài (verify)`,
      );
    }
  }

  // Step 4 — unclassified 6 ticket (chỉ khi chưa có taxon ở thời điểm chạy)
  console.log("--- Step 4: classify ticket thiếu CLASSIFIED_AS");
  for (const r of rows) {
    if (r.taxon !== null) continue;
    const assign = UNCLASSIFIED_ASSIGN[r.id];
    if (assign) {
      console.log(`  ${APPLY ? "🔧" : "[dry]"} ${r.id}: → ${assign.taxon} (${assign.reason})`);
      if (APPLY) await setTaxon(r.id, assign.taxon);
      changed++;
    } else {
      console.log(`  ❓ ${r.id}: không có rule chắc chắn — review`);
      review.push(`${r.id} thiếu taxon, không có rule`);
    }
  }

  const after = await distribution();
  console.log("\nSAU:", after.map(([t, n]) => `${t}=${n}`).join(", "));
  console.log(`\nTổng thay đổi: ${changed}${APPLY ? "" : " (dry run — chưa mutate)"}`);
  if (review.length) {
    console.log("REVIEW-LIST:");
    for (const r of review) console.log(`  - ${r}`);
  }
  if (!APPLY)
    console.log(`\nChạy thật: bun run apps/tieulinh-legacy/scripts/fix-causetaxon.ts --apply`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
