#!/usr/bin/env bun
/**
 * TẦNG 3 — Đẩy dữ liệu Knowledge Graph (rootCause/resolution/causeTaxon đã
 * chuẩn hoá) vào Onyx làm document ingest, để hybrid search của Onyx "nhìn
 * thấy" nhãn nguyên nhân canonical thay vì chỉ text ticket thô.
 *
 * KHÔNG ghi vào "tech-done-tickets" (document set "đã kiểm duyệt") hay
 * "intake-test-done" (nơi worker ghi ticket thô) — tạo document set MỚI, tách
 * biệt hoàn toàn ("kg-cause-taxonomy"), để không đụng ranh giới đã có và dễ
 * xoá/làm lại nếu thử nghiệm không đạt.
 *
 * Dùng: bun run apps/tieulinh/scripts/push-kg-to-onyx.ts [--limit N] [--dry-run]
 */
import { createItsaplanClient } from "../lib/itsaplan/client-factory";
import { MemgraphClient } from "../lib/kg/memgraph-client";
import { OnyxConnectorManager } from "../lib/onyx/connector-manager";
import { redactIncidentPII } from "@vuihoc/bot-core/core";
import { issueWebUrl, resolveProjectTeamRef } from "@vuihoc/bot-core/itsaplan";

const args = process.argv.slice(2);
const getArg = (name: string, fallback?: string) => {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const hasFlag = (name: string) => args.includes(name);
const limit = Number(getArg("--limit", "0")) || 0;
const dryRun = hasFlag("--dry-run");

const onyxBaseUrl = process.env.ONYX_BASE_URL ?? "";
const onyxApiKey = process.env.ONYX_API_KEY ?? "";
const itsaplanWebUrl = process.env.ITSAPLAN_WEB_URL ?? "";
const itsaplanProjectKey = process.env.ITSAPLAN_PROJECT_KEY ?? "TECH";
const itsaplanBaseUrl = process.env.ITSAPLAN_BASE_URL ?? "";
const itsaplanApiKey = process.env.ITSAPLAN_API_KEY ?? "";

if (!onyxBaseUrl || !onyxApiKey) {
  console.error("Thiếu ONYX_BASE_URL / ONYX_API_KEY");
  process.exit(1);
}

const memgraph = new MemgraphClient();
let tickets = await memgraph.listResolvedTicketsForExport();
console.log(`Tổng ticket có RootCause+Resolution trong KG: ${tickets.length}`);
if (limit > 0) tickets = tickets.slice(0, limit);

if (dryRun) {
  for (const t of tickets.slice(0, 10)) {
    console.log(
      `  [dry] ${t.identifier} — ${t.causeTaxonId ?? "(chưa phân loại)"} — ${t.rootCause.slice(0, 60)}`,
    );
  }
  console.log(`... và ${Math.max(0, tickets.length - 10)} ticket nữa`);
  await memgraph.close();
  process.exit(0);
}

const connectorManager = new OnyxConnectorManager(onyxBaseUrl, onyxApiKey, {
  connectorName: "FileConnector-KG-CauseTaxonomy",
  documentSetName: "kg-cause-taxonomy",
});

console.log("Đang đảm bảo connector/document-set 'kg-cause-taxonomy' tồn tại...");
const conn = await connectorManager.ensureTestConnector();
console.log(`OK — cc_pair_id=${conn.ccPairId}, document_set=${conn.documentSetName}`);

const formatDoc = (
  t: Awaited<ReturnType<typeof memgraph.listResolvedTicketsForExport>>[number],
) => {
  const closedDate = t.resolvedAt ? t.resolvedAt.slice(0, 10) : "";
  const headerParts = [t.identifier];
  if (t.system) headerParts.push(t.system);
  if (t.errorCategory) headerParts.push(t.errorCategory);
  const header = headerParts.join(" · ") + (closedDate ? ` · đóng ${closedDate}` : "");

  const lines = [header, ""];
  lines.push("TRIỆU CHỨNG SỰ CỐ", redactIncidentPII(t.title), "");
  if (t.causeTaxonId && t.causeTaxonLabel) {
    // Đây là giá trị mới thật sự thêm vào Onyx — nhãn canonical mà chỉ KG mới có,
    // giúp hybrid search khớp được các ticket "cùng bệnh khác chữ".
    lines.push(`NHÓM NGUYÊN NHÂN CANONICAL`, `${t.causeTaxonLabel} (${t.causeTaxonId})`, "");
  }
  lines.push("NGUYÊN NHÂN GỐC RỄ", redactIncidentPII(t.rootCause), "");
  lines.push("GIẢI PHÁP XỬ LÝ (CÁCH KHẮC PHỤC)", redactIncidentPII(t.resolution));
  return lines.join("\n");
};

let success = 0;
let failed = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const itsaplanTeamRef =
  itsaplanBaseUrl && itsaplanApiKey
    ? await resolveProjectTeamRef(
        createItsaplanClient(itsaplanBaseUrl, itsaplanApiKey),
        itsaplanProjectKey,
      )
    : undefined;

for (const [i, t] of tickets.entries()) {
  const docId = `kg_${t.identifier.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`;
  const link =
    issueWebUrl(itsaplanWebUrl, itsaplanProjectKey, t.identifier, undefined, itsaplanTeamRef) ?? "";
  const textDocument = formatDoc(t);

  const payload = {
    cc_pair_id: conn.ccPairId,
    document: {
      id: docId,
      sections: [{ type: "text", text: textDocument, link }],
      source: "file",
      semantic_identifier: `[${t.identifier}] ${redactIncidentPII(t.title)}`,
      title: `[${t.identifier}] ${redactIncidentPII(t.title)}`,
      metadata: {
        ticket_id: t.identifier,
        cause_taxon: t.causeTaxonId || "",
        system: t.system || "",
        product: t.product || "",
      },
    },
  };

  try {
    const res = await fetch(`${onyxBaseUrl}/api/onyx-api/ingestion`, {
      method: "POST",
      headers: { Authorization: `Bearer ${onyxApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      success++;
      console.log(`[${i + 1}/${tickets.length}] ✅ ${t.identifier} -> ${docId}`);
    } else {
      failed++;
      console.log(
        `[${i + 1}/${tickets.length}] ⚠️  ${t.identifier}: HTTP ${res.status} ${await res.text()}`,
      );
    }
  } catch (err: any) {
    failed++;
    console.log(`[${i + 1}/${tickets.length}] ❌ ${t.identifier}: ${err.message}`);
  }
  await sleep(100);
}

await memgraph.close();

console.log("\n========================================");
console.log("KẾT QUẢ PUSH KG -> ONYX");
console.log(`  Thành công: ${success}`);
console.log(`  Thất bại:   ${failed}`);
console.log(`  Document set: ${conn.documentSetName} (cc_pair_id=${conn.ccPairId})`);
console.log("========================================");
