#!/usr/bin/env bun
/**
 * Nạp bù các ticket TECH đã Done/Resolved (sequenceNumber >= 316, tức sinh ra sau khi
 * chuyển từ Huly sang Itsaplan — không có ticket nào thấp hơn 316 tồn tại trên Itsaplan)
 * vào ĐÚNG cc_pair 30 (FileConnector-TechDoneTickets-v2) mà search_knowledge đang tra,
 * thay vì docset cách ly "intake-test-done" mà worker vẫn lỡ ghi vào bấy lâu.
 *
 * Chạy: bun run --env-file=.env backfill-onyx.ts            (nạp thật)
 *       bun run --env-file=.env backfill-onyx.ts --chay-kho  (chỉ liệt kê, không nạp)
 */
import { ItsaplanClient } from "../lib/itsaplan/client";
import { OnyxConnectorManager } from "../lib/onyx/connector-manager";
import { OnyxIngestService } from "../worker/ingest.service";
import { parseApiStyle } from "../worker/llm";

const ITSAPLAN_BASE_URL = process.env.ITSAPLAN_BASE_URL!;
const ITSAPLAN_API_KEY = process.env.ITSAPLAN_AGENT_KEY || process.env.ITSAPLAN_API_KEY!;
const PROJECT_KEY = process.env.ITSAPLAN_PROJECT_KEY || "TECH";
const CUTOFF_SEQ = 316; // ticket Itsaplan-native đầu tiên; không có gì thấp hơn tồn tại

const chayKho = process.argv.includes("--chay-kho");
const soloArg = process.argv.find((a) => a.startsWith("--solo="));
const soloSeq = soloArg ? Number(soloArg.slice("--solo=".length)) : undefined;
const force = process.argv.includes("--force");
const skipCheck = process.argv.includes("--skip-check") || Boolean(soloSeq);

/** Một phiên MCP dùng chung cho mọi lượt tra trong suốt lần chạy — khởi tạo một lần, đỡ 2 round-trip/ticket. */
async function openMcpSession(): Promise<string> {
  const res = await fetch(`${process.env.ONYX_BASE_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${process.env.ONYX_API_KEY}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "backfill-onyx", version: "0.1" } },
    }),
  });
  const sessionId = res.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("Onyx MCP init không trả mcp-session-id");
  await fetch(`${process.env.ONYX_BASE_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.ONYX_API_KEY}`,
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return sessionId;
}

async function mcpSearchIndexedDocuments(sessionId: string, query: string): Promise<Array<{ title: string; content: string }>> {
  const res = await fetch(`${process.env.ONYX_BASE_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${process.env.ONYX_API_KEY}`,
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "search_indexed_documents",
        arguments: { query, document_set_names: ["tech-done-tickets"], skip_query_expansion: true },
      },
    }),
  });
  const raw = await res.text();
  const match = raw.match(/data: (\{.*\})/);
  if (!match) return [];
  const outer = JSON.parse(match[1]);
  const inner = JSON.parse(outer.result.content[0].text as string);
  return inner.results ?? [];
}

/**
 * Nhiều ticket đã được nạp thủ công vào tech-done-tickets từ trước (đợt 27/08, có LLM thật
 * tổng hợp tử tế, khuôn gốc bot-core/src/onyx/document.ts) — cc_pair 30 báo num_docs_indexed
 * hiện > 0. Ingestion API là upsert, ghi đè im lặng, nên PHẢI kiểm tra tồn tại trước khi nạp
 * lại, kẻo phá mất bản tốt đã có. Không có API liệt kê document theo cc_pair, nên tra bằng
 * chính mã ticket (rất đặc trưng, gần như định danh duy nhất) — dùng search_indexed_documents
 * (nội dung đầy đủ) chứ không phải /api/admin/search (chỉ trả blurb cắt cụt).
 *
 * "richOriginal" phân biệt bản gốc 27/08 với bản do CHÍNH pipeline này nạp trước đó (đợt chưa
 * có LLM thật, chỉ fallback rỗng): khuôn gốc luôn có mục "TỪ KHOÁ:" (buildDocumentBody ở
 * bot-core), còn buildOnyxDocumentBody ở đây thì không — nên thiếu "TỪ KHOÁ:" nghĩa là bản
 * đang có chính là bản fallback của mình, an toàn để nạp đè bằng bản LLM thật vừa có.
 */
async function checkExisting(
  sessionId: string,
  identifier: string,
): Promise<{ exists: boolean; richOriginal: boolean }> {
  let results: Array<{ title: string; content: string }>;
  try {
    results = await mcpSearchIndexedDocuments(sessionId, identifier);
  } catch {
    // Tra lỗi thì coi như CÓ THỂ đã tồn tại và là bản gốc — bỏ sót một ticket còn sửa được
    // sau, ghi đè mất một tài liệu tốt thì không lấy lại được.
    return { exists: true, richOriginal: true };
  }
  const hit = results.find((r) => r.title.startsWith(`${identifier}:`));
  if (!hit) return { exists: false, richOriginal: false };
  return { exists: true, richOriginal: hit.content.includes("TỪ KHOÁ") };
}

async function main() {
  const client = new ItsaplanClient(ITSAPLAN_BASE_URL, ITSAPLAN_API_KEY);

  // Cột "completed" (Done/Resolved) — đọc động, không hardcode id phòng khi đổi board.
  const project = await client.getProject(PROJECT_KEY);
  const completedColumnIds = (project.columns ?? [])
    .filter((c) => c.stateType === "completed")
    .map((c) => c.id);
  console.log(`Cột completed: ${completedColumnIds.join(", ")}`);

  // ItsaplanClient không có wrapper cho GET /projects/:key/issues?columnId=..., gọi thẳng.
  const seen = new Map<number, { id: number; identifier: string }>();
  for (const columnId of completedColumnIds) {
    const url = `${ITSAPLAN_BASE_URL}/projects/${PROJECT_KEY}/issues?columnId=${columnId}&limit=500&includeArchived=true`;
    const res = await fetch(url, {
      headers: { "x-api-key": ITSAPLAN_API_KEY, Authorization: `Bearer ${ITSAPLAN_API_KEY}` },
    });
    if (!res.ok) throw new Error(`List issues (columnId=${columnId}) failed: HTTP ${res.status}`);
    const rows = (await res.json()) as Array<{ id: number; sequenceNumber: number; identifier: string }>;
    for (const r of rows) {
      if (r.sequenceNumber >= CUTOFF_SEQ) {
        seen.set(r.sequenceNumber, { id: r.id, identifier: r.identifier });
      }
    }
  }

  let targets = [...seen.entries()].sort((a, b) => a[0] - b[0]);
  console.log(`Tổng ${targets.length} ticket Done/Resolved từ TECH-${CUTOFF_SEQ} trở đi.`);

  if (soloSeq) {
    targets = targets.filter(([seq]) => seq === soloSeq);
    console.log(`--solo=${soloSeq}: chỉ chạy ${targets.length} ticket.`);
  }

  if (chayKho) {
    console.log(targets.map(([seq, t]) => t.identifier).join(", "));
    return;
  }

  const onyxConfig = {
    onyxBaseUrl: process.env.ONYX_BASE_URL!,
    onyxApiKey: process.env.ONYX_API_KEY!,
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "",
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    openaiApi: parseApiStyle(process.env.OPENAI_API_STYLE),
    itsaplanWebUrl: process.env.ITSAPLAN_WEB_URL ?? "",
    itsaplanProjectKey: PROJECT_KEY,
    docIdPrefix: process.env.ONYX_DOC_PREFIX ?? "ticket_",
  };
  const connectorManager = new OnyxConnectorManager(onyxConfig.onyxBaseUrl, onyxConfig.onyxApiKey, {
    ccPairId: Number(process.env.ONYX_CC_PAIR_ID),
    documentSetName: process.env.ONYX_DOCUMENT_SET,
    connectorName: process.env.ONYX_CONNECTOR_NAME,
  });
  const ingest = new OnyxIngestService(client, connectorManager, onyxConfig);
  const mcpSession = skipCheck ? "" : await openMcpSession();

  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  let alreadyThere = 0;
  for (const [seq, t] of targets) {
    process.stdout.write(`TECH-${seq} (#${t.id}) ... `);
    if (!skipCheck) {
      const { exists, richOriginal } = await checkExisting(mcpSession, t.identifier);
      if (exists && richOriginal && !force) {
        alreadyThere++;
        console.log(`đã có bản gốc tốt trong tech-done-tickets, giữ nguyên (bỏ qua)`);
        continue;
      }
      if (exists && !richOriginal) {
        console.log(`đã có bản fallback của chính pipeline này, nạp đè bằng bản LLM thật ...`);
      }
    }
    try {
      const result = await ingest.ingestDoneTicket(t.id);
      if (result.success && result.status === "indexed") {
        indexed++;
        console.log(`indexed (${result.docId})`);
      } else if (result.status === "skipped") {
        skipped++;
        console.log(`skipped: ${result.reason}`);
      } else {
        failed++;
        console.log(`FAILED: ${result.error}`);
      }
    } catch (err: any) {
      failed++;
      console.log(`FAILED (exception): ${err.message}`);
    }
  }

  console.log(
    `\n=== Xong: ${indexed} indexed, ${skipped} skipped, ${failed} failed, ${alreadyThere} đã có sẵn (giữ nguyên) / ${targets.length} tổng ===`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
