#!/usr/bin/env bun
/**
 * RECLASSIFY: Gắn causeTaxon (nhóm nguyên nhân canonical) cho các ticket đã
 * có sẵn trong Knowledge Graph, dựa trên rootCause đã trích xuất từ trước.
 *
 * Không gọi lại Itsaplan/toàn bộ pipeline synthesizeTicketKnowledge — chỉ
 * phân loại text rootCause đã có sẵn trong Memgraph vào cause-taxonomy.json.
 * Dùng khi: (1) mới thêm/refresh taxonomy, (2) tickets đã backfill trước khi
 * có causeTaxon.
 *
 * Dùng: bun run apps/tieulinh/scripts/reclassify-kg-taxonomy.ts [--limit N] [--dry-run]
 */
import * as fs from "node:fs";
import { MemgraphClient } from "../lib/kg/memgraph-client";
import { complete, extractJson } from "../worker/llm";
import { CAUSE_TAXONOMY, OTHER_NEW_PATTERN } from "../worker/kg-sync";
import { getLogger } from "../lib/logger";

const args = process.argv.slice(2);
const getArg = (name: string, fallback?: string) => {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const hasFlag = (name: string) => args.includes(name);
const limit = Number(getArg("--limit", "0")) || 0;
const dryRun = hasFlag("--dry-run");
const BATCH_SIZE = 12;

const llmConfig = {
  baseUrl: process.env.OPENAI_BASE_URL ?? "",
  apiKey: process.env.OPENAI_API_KEY ?? "",
  model: process.env.OPENAI_MODEL ?? "mm3/MiniMax-M3",
};
if (!llmConfig.baseUrl || !llmConfig.apiKey) {
  console.error("Thiếu OPENAI_BASE_URL / OPENAI_API_KEY");
  process.exit(1);
}

const memgraph = new MemgraphClient();

// 1. Nạp/refresh catalog CauseTaxon (label + definition) trước
await memgraph.syncCauseTaxonomyCatalog(CAUSE_TAXONOMY);
console.log(`Đã sync catalog: ${CAUSE_TAXONOMY.length} nhóm nguyên nhân.`);

// 2. Lấy toàn bộ ticket đã có RootCause nhưng CHƯA phân loại (hoặc phân loại lại nếu --force sau này)
const session = (memgraph as any).driver.session();
const res = await session.run(`
  MATCH (t:Ticket)-[:CAUSED_BY]->(rc:RootCause)
  OPTIONAL MATCH (t)-[:CLASSIFIED_AS]->(ct:CauseTaxon)
  WHERE ct IS NULL
  RETURN t.identifier AS id, rc.text AS rootCause
  ORDER BY t.identifier
`);
await session.close();

let targets = res.records.map((r: any) => ({ id: r.get("id"), rootCause: r.get("rootCause") }));
if (limit > 0) targets = targets.slice(0, limit);
console.log(`Cần phân loại: ${targets.length} ticket${dryRun ? " (DRY RUN)" : ""}`);

if (dryRun) {
  for (const t of targets.slice(0, 20)) console.log(`  [dry] ${t.id}: ${t.rootCause.slice(0, 80)}`);
  process.exit(0);
}

const taxonomyList = CAUSE_TAXONOMY.map((t) => `- ${t.id}: ${t.label} — ${t.definition}`).join(
  "\n",
);
const systemPrompt = `Bạn phân loại Root Cause kỹ thuật vào ĐÚNG MỘT nhóm canonical dưới đây, theo CƠ CHẾ lỗi
(không phải theo hệ thống/sản phẩm bề mặt). Nếu không khớp nhóm nào, dùng "OTHER_NEW_PATTERN".

Danh sách nhóm hợp lệ:
${taxonomyList}

Bạn sẽ nhận một danh sách Root Cause đánh số. Trả về ĐÚNG JSON (không kèm text khác):
{"classifications": [{"index": 1, "cause_taxon": "ID_NHOM"}, ...]}
Bắt buộc trả đủ 1 dòng phân loại cho MỖI số thứ tự trong danh sách nhận được, không bỏ sót.`;

const CAUSE_TAXONOMY_IDS = new Set(CAUSE_TAXONOMY.map((t) => t.id));

let classified = 0;
let failed = 0;
let otherCount = 0;
const errors: Array<{ id: string; error: string }> = [];

for (let i = 0; i < targets.length; i += BATCH_SIZE) {
  const batch = targets.slice(i, i + BATCH_SIZE);
  const userPrompt = batch
    .map((t: any, idx: number) => `${idx + 1}. ${t.rootCause.slice(0, 400)}`)
    .join("\n");

  try {
    const text = await complete(llmConfig, systemPrompt, userPrompt);
    const parsed = extractJson<{ classifications: Array<{ index: number; cause_taxon: string }> }>(
      text,
    );
    if (!parsed?.classifications) {
      throw new Error(`LLM trả về không đúng schema classifications. Raw: ${text.slice(0, 200)}`);
    }
    const byIndex = new Map(parsed.classifications.map((c) => [c.index, c.cause_taxon]));

    for (let j = 0; j < batch.length; j++) {
      const t = batch[j];
      const raw = String(byIndex.get(j + 1) || "")
        .trim()
        .toUpperCase();
      const taxonId = CAUSE_TAXONOMY_IDS.has(raw) ? raw : OTHER_NEW_PATTERN;
      if (taxonId === OTHER_NEW_PATTERN) otherCount++;
      await memgraph.setCauseTaxon(t.id, taxonId);
      classified++;
      console.log(`[${classified}/${targets.length}] ✅ ${t.id} -> ${taxonId}`);
    }
  } catch (err: any) {
    failed += batch.length;
    for (const t of batch) errors.push({ id: t.id, error: err.message });
    console.log(`❌ Batch [${i + 1}-${i + batch.length}] lỗi: ${err.message}`);
  }
}

await memgraph.close();

const otherRatio = classified > 0 ? otherCount / classified : 0;

console.log("\n========================================");
console.log("KẾT QUẢ RECLASSIFY");
console.log(`  Thành công: ${classified}`);
console.log(`  Thất bại:   ${failed}`);
console.log(`  OTHER_NEW_PATTERN: ${otherCount}/${classified} (${(otherRatio * 100).toFixed(1)}%)`);
if (otherRatio > 0.1) {
  console.log(
    `  ⚠️  CẢNH BÁO: tỉ lệ OTHER_NEW_PATTERN > 10% — taxonomy đang "leak", có mẫu lỗi mới` +
      ` chưa cover. Cần đọc lại các ticket rơi vào OTHER_NEW_PATTERN và cân nhắc thêm nhóm mới.`,
  );
}
console.log("========================================");
if (errors.length > 0) {
  console.log("\nLỗi:");
  for (const e of errors.slice(0, 10)) console.log(`  ${e.id}: ${e.error}`);
}
