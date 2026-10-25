#!/usr/bin/env bun
/**
 * Đo kiến trúc MỚI "ticket tương tự" (KG + Onyx + BM25 + LLM xác minh từng cặp
 * — lib/kg/similar-ticket-source.ts::LlmSimilarTickets) trên benchmark MÙ dựng
 * bởi researcher A: $SIMILAR_RESEARCH_DIR/ (kb.json = 198 ticket TECH
 * cũ, questions-dev.json/questions-test.json = câu hỏi mới hơn, chỉ title +
 * reporterText). KHÔNG cần Memgraph: dựng corpus + causeCluster trong bộ nhớ
 * từ kb.json bằng ĐÚNG hàm thật của repo (buildCauseClusters, humanKnowledgeOf,
 * symptomsOfDescription) — cùng cách production tính, chỉ khác nguồn dữ liệu.
 *
 * Chạy thật (KHÔNG dùng Memgraph, Itsaplan, Telegram — chỉ đọc Onyx /api/search
 * và gọi LLM qua OPENAI_BASE_URL trong apps/tieulinh-legacy/.env):
 *
 *   bun scripts/eval-similar-bench.ts dev     # -> $SIMILAR_RESEARCH_DIR/prod/pred-dev.json
 *   bun scripts/eval-similar-bench.ts test    # -> $SIMILAR_RESEARCH_DIR/prod/pred-test.json
 *
 * Chấm dev:  bun $SIMILAR_RESEARCH_DIR/score.ts $SIMILAR_RESEARCH_DIR/prod/pred-dev.json
 * Test: KHÔNG có gold ở máy này — điều phối viên tự chấm bằng gold ẩn, đừng đọc.
 *
 * Cache lời gọi Onyx + LLM (KHÔNG cache lỗi) tại apps/tieulinh-legacy/data/similar-bench-*-cache.json
 * (gitignored) — chạy lại từ cache thì gần như tức thời, 0 lời gọi thật mới.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { humanKnowledgeOf } from "../lib/kg/human-signals";
import { buildCauseClusters, type CauseClusterInput } from "../lib/kg/cause-clusters";
import { symptomsOfDescription, type CorpusTicket } from "../lib/kg/similar-finder";
import { similarContextOf } from "../lib/kg/similar-context";
import { LlmSimilarTickets } from "../lib/kg/similar-ticket-source";
import type { SimilarTicketItem } from "../lib/intake-document/types";
import { extractRootCauseAndResolution, type OnyxRestSearchClient } from "../lib/onyx/rest-search";

const RESEARCH_DIR = process.env.SIMILAR_RESEARCH_DIR ?? "./research-similar";
const OUT_DIR = `${RESEARCH_DIR}/prod`;
const DATA_DIR = `${import.meta.dir}/../data`;
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });

const which = (process.argv[2] ?? "dev").trim().toLowerCase();
if (which !== "dev" && which !== "test") {
  console.error(`Dùng: bun scripts/eval-similar-bench.ts <dev|test> [mechanism|applicability]`);
  process.exit(1);
}
// judgeMode (xem lib/kg/similar-judge.ts::JudgeMode) — cờ để so A ("mechanism", mặc định
// cũ) với B ("applicability", đo 29/09 sau khi phát hiện A gần như không gợi ý gì từ 27/09).
const judgeModeArg = (process.argv[3] ?? process.env.SIMILAR_JUDGE_MODE ?? "mechanism").trim();
if (judgeModeArg !== "mechanism" && judgeModeArg !== "applicability") {
  console.error(`judgeMode phải là "mechanism" hoặc "applicability", nhận "${judgeModeArg}"`);
  process.exit(1);
}
const judgeMode = judgeModeArg as "mechanism" | "applicability";

// ─── 1) Dựng corpus + causeCluster từ kb.json, y hệt cách production tính
//        (buildCauseClusters/humanKnowledgeOf) nhưng không cần Memgraph. ───
interface KbTicket {
  issue: {
    identifier: string;
    title: string;
    description?: string;
    createdAt?: string;
    statusSince?: string;
    updatedAt?: string;
  };
  timeline: any[];
}
const kb = JSON.parse(readFileSync(`${RESEARCH_DIR}/kb.json`, "utf8")) as { tickets: KbTicket[] };
const validIds = new Set(kb.tickets.map((t) => t.issue.identifier.toUpperCase()));

const humanByTicket = new Map<string, ReturnType<typeof humanKnowledgeOf>>();
for (const t of kb.tickets) {
  humanByTicket.set(
    t.issue.identifier.toUpperCase(),
    humanKnowledgeOf(t.timeline, t.issue.identifier),
  );
}

// negatives 2 chiều (đúng như memgraph-client.ts::loadSimilarityCorpus dùng MATCH không hướng):
// một ticket bị gỡ liên kết ở PHÍA NÀO cũng phải xuất hiện trong negatives của CẢ HAI.
const negatives2Way = new Map<string, Set<string>>();
for (const id of validIds) negatives2Way.set(id, new Set());
for (const [id, h] of humanByTicket) {
  for (const n of h.negatives) {
    const other = n.toUpperCase();
    negatives2Way.get(id)?.add(other);
    if (validIds.has(other)) negatives2Way.get(other)?.add(id);
  }
}

const clusterInput: CauseClusterInput[] = kb.tickets.map((t) => {
  const id = t.issue.identifier.toUpperCase();
  const h = humanByTicket.get(id)!;
  return { id, humanCause: h.cause, positives: h.positives, negatives: h.negatives };
});
const clusterOf = buildCauseClusters(clusterInput);

// Ngữ cảnh giàu cho BM25 + prompt LLM (title×2 + mô tả gốc + ghi chú xử lý
// của NGƯỜI): lib/kg/similar-context.ts::similarContextOf — ĐÚNG hàm production
// dùng (worker/kg-sync.ts) khi ghi ticket Done vào KG thật. Benchmark phải gọi
// CHUNG một helper với production, không thì số đo không phản ánh cái production
// thực sự chạy (chốt 27/09, sau khi phát hiện lệch: production thiếu các trường
// này khiến LLM hiếm khi đủ căn cứ báo "high").
const corpus: CorpusTicket[] = kb.tickets.map((t) => {
  const id = t.issue.identifier.toUpperCase();
  const h = humanByTicket.get(id)!;
  const negs = [...(negatives2Way.get(id) ?? [])];
  const ctx = similarContextOf(t.issue, t.timeline);
  return {
    identifier: id,
    title: t.issue.title ?? "",
    symptomsText: symptomsOfDescription(t.issue.description),
    description: ctx.description,
    humanNotes: ctx.humanNotes,
    system: ctx.system,
    product: ctx.product,
    causeCluster: clusterOf.get(id),
    humanCause: h.cause,
    humanFix: h.fix,
    resolvedAt: t.issue.statusSince ?? t.issue.updatedAt ?? t.issue.createdAt,
    negatives: negs.length ? negs : undefined,
  };
});
console.log(
  `Kho: ${corpus.length} ticket, ${new Set(corpus.map((c) => c.causeCluster)).size} cụm.`,
);

// ─── 2) Onyx /api/search thô (giống researcher A) — CHỈ ĐỌC, lọc lại theo kho
//        (Onyx đã index cả ticket MỚI hơn kb.json, xem README.md). ───
function need(name: string): string {
  const v = process.env[name];
  if (!v)
    throw new Error(`Thiếu biến môi trường ${name} (đọc .env qua bun --env-file, hoặc export tay)`);
  return v;
}
const ONYX_BASE_URL = need("ONYX_BASE_URL");
const ONYX_API_KEY = need("ONYX_API_KEY");
const OPENAI_BASE_URL = need("OPENAI_BASE_URL");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const OPENAI_MODEL = need("OPENAI_MODEL");

interface OnyxHit {
  identifier: string;
  rootCause?: string;
  resolution?: string;
}
const ONYX_CACHE_PATH = `${DATA_DIR}/similar-bench-onyx-cache.json`;
const onyxCacheRaw: Record<string, Array<string | OnyxHit>> = existsSync(ONYX_CACHE_PATH)
  ? JSON.parse(readFileSync(ONYX_CACHE_PATH, "utf8"))
  : {};
// Tương thích cache cũ (chỉ mảng mã, chưa có rootCause/resolution).
const onyxCache: Record<string, OnyxHit[]> = Object.fromEntries(
  Object.entries(onyxCacheRaw).map(([k, v]) => [
    k,
    v.map((x) => (typeof x === "string" ? { identifier: x } : x)),
  ]),
);
function saveOnyxCache() {
  writeFileSync(ONYX_CACHE_PATH, JSON.stringify(onyxCache, null, 1));
}
let onyxCalls = 0;
async function rawOnyxSearch(query: string): Promise<OnyxHit[]> {
  const key = query.trim();
  if (key in onyxCache) return onyxCache[key];
  onyxCalls++;
  const res = await fetch(`${ONYX_BASE_URL}/api/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ONYX_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok)
    throw new Error(`Onyx /api/search lỗi HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { results?: Array<{ title?: string; content?: string }> };
  const byId = new Map<string, OnyxHit>();
  for (const r of data.results ?? []) {
    const id = r.title?.match(/TECH-\d+/)?.[0];
    if (!id || byId.has(id)) continue;
    // Onyx đã ingest sẵn tóm tắt NGUYÊN NHÂN/CÁCH KHẮC PHỤC trong nội dung tài
    // liệu (kg-cause-taxonomy/tech-done-tickets, xem lib/onyx/rest-search.ts) —
    // trích ra làm ngữ cảnh bổ sung cho LLM xác minh, y hệt production.
    byId.set(id, {
      identifier: id,
      ...extractRootCauseAndResolution(`${r.title ?? ""}\n${r.content ?? ""}`),
    });
  }
  const hits = [...byId.values()];
  onyxCache[key] = hits; // KHÔNG cache khi lỗi (đã throw ở trên trước khi tới đây)
  saveOnyxCache();
  return hits;
}
const onyx: Pick<OnyxRestSearchClient, "searchSimilar"> = {
  searchSimilar: async (query: string): Promise<SimilarTicketItem[]> => {
    const hits = await rawOnyxSearch(query);
    return hits.map((h) => ({
      identifier: h.identifier.toUpperCase(),
      title: h.identifier,
      rootCause: h.rootCause,
      resolution: h.resolution,
      verifiedOnTracker: true,
    }));
  },
};

// ─── 3) LLM: proxy cục bộ CHỈ để cache — gọi ĐÚNG complete()/verifyCandidate()
//        thật của production (worker/llm.ts, lib/kg/similar-judge.ts) không đổi
//        gì, chỉ chặn network để không tốn lời gọi thật khi chạy lại. Không
//        cache lỗi (chỉ ghi cache khi upstream trả 2xx). ───
const LLM_CACHE_PATH = `${DATA_DIR}/similar-bench-llm-cache.json`;
const llmCache: Record<string, string> = existsSync(LLM_CACHE_PATH)
  ? JSON.parse(readFileSync(LLM_CACHE_PATH, "utf8"))
  : {};
function saveLlmCache() {
  writeFileSync(LLM_CACHE_PATH, JSON.stringify(llmCache, null, 1));
}
let llmCalls = 0;
const llmProxy = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const bodyText = await req.text();
    const key = createHash("sha256").update(bodyText).digest("hex");
    if (key in llmCache)
      return new Response(llmCache[key], { headers: { "Content-Type": "application/json" } });
    llmCalls++;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
      try {
        const upstream = await fetch(`${OPENAI_BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(OPENAI_API_KEY ? { Authorization: `Bearer ${OPENAI_API_KEY}` } : {}),
          },
          body: bodyText,
        });
        const text = await upstream.text();
        if (upstream.ok) {
          llmCache[key] = text;
          saveLlmCache();
          return new Response(text, { headers: { "Content-Type": "application/json" } });
        }
        lastErr = new Error(`LLM upstream ${upstream.status}: ${text.slice(0, 200)}`);
      } catch (err) {
        lastErr = err;
      }
    }
    return new Response(JSON.stringify({ error: String(lastErr) }), { status: 502 });
  },
});
const llm = { baseUrl: `http://127.0.0.1:${llmProxy.port}`, apiKey: "", model: OPENAI_MODEL };

// ─── 4) Chạy pipeline thật (LlmSimilarTickets) trên từng câu hỏi ───
const memgraph = { loadSimilarityCorpus: async () => corpus };
const src = new LlmSimilarTickets({
  memgraph,
  onyx,
  llm,
  projectKey: "TECH",
  maxCandidates: Number(process.env.SIMILAR_MAX_CANDIDATES ?? 14),
  llmConcurrency: Number(process.env.SIMILAR_LLM_CONCURRENCY ?? 5),
  // Timeout tổng nới hơn mặc định production (60s): đo offline không có người
  // dùng chờ, ưu tiên đúng số liệu hơn là mô phỏng UX thời gian thực.
  timeoutMs: Number(process.env.SIMILAR_TIMEOUT_MS ?? 180_000),
  judgeMode,
});

interface Question {
  identifier: string;
  createdAt: string;
  title: string;
  reporterText: string;
}
const questions = JSON.parse(
  readFileSync(`${RESEARCH_DIR}/questions-${which}.json`, "utf8"),
) as Question[];

async function main() {
  const preds: Record<string, string[]> = {};
  for (const q of questions) {
    const text = `${q.title}\n${q.reporterText}`;
    let members: string[] = [];
    try {
      const match = await src.find(text);
      members = (match?.members ?? [])
        .map((m) => m.identifier)
        .filter((id) => id.toUpperCase() !== q.identifier.toUpperCase());
    } catch (err: any) {
      console.warn(`${q.identifier}: lỗi — ${err?.message ?? err}`);
    }
    preds[q.identifier] = members;
    console.log(`${q.identifier}: -> [${members.join(", ")}]`);
  }
  const outPath =
    judgeMode === "mechanism"
      ? `${OUT_DIR}/pred-${which}.json`
      : `${OUT_DIR}/pred-${which}-${judgeMode}.json`;
  writeFileSync(outPath, JSON.stringify(preds, null, 1));
  console.log(`\nĐã ghi ${outPath}. Số câu hỏi: ${questions.length}.`);
  console.log(
    `Lời gọi Onyx thật (không tính cache hit): ${onyxCalls}. Lời gọi LLM thật: ${llmCalls}.`,
  );
  llmProxy.stop(true);
}

main().catch((err) => {
  console.error(err);
  llmProxy.stop(true);
  process.exit(1);
});
