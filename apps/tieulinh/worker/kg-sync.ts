import type { ItsaplanClient } from "../lib/itsaplan/client";
import { MemgraphClient } from "../lib/kg/memgraph-client";
import { complete, extractJson, type LlmConfig } from "./llm";
import { getLogger } from "../lib/logger";
import type { TicketGraphNode, CauseTaxonEntry } from "../lib/kg/types";
import { redactIncidentPII } from "../lib/onyx/pii-redactor";
import causeTaxonomyData from "../lib/kg/cause-taxonomy.json";
import { normalizeSystemName } from "../lib/kg/system-taxonomy";
import { createHash } from "node:crypto";
import { identifierInProject, projectOfIdentifier } from "./project-lock";
import { humanKnowledgeOf } from "../lib/kg/human-signals";
import { symptomsOfDescription } from "../lib/kg/similar-finder";
import { isBotAuthoredComment, similarContextOf } from "../lib/kg/similar-context";
import { parseIncidentMeta } from "../lib/kg/incident-meta";
import type { ProjectColumnStates } from "../lib/itsaplan/ticket-state";
import { stripCommentHtml } from "../lib/formatting";

export { parseIncidentMeta } from "../lib/kg/incident-meta";

export const CAUSE_TAXONOMY = causeTaxonomyData as CauseTaxonEntry[];
const CAUSE_TAXONOMY_IDS = new Set(CAUSE_TAXONOMY.map((t) => t.id));
export const OTHER_NEW_PATTERN = "OTHER_NEW_PATTERN";
export const INSUFFICIENT_INFO = "INSUFFICIENT_INFO";
// 2 nhóm này mô tả TRẠNG THÁI thiếu dữ kiện, không phải một CƠ CHẾ lỗi kỹ
// thuật cụ thể — 2 ticket cùng "không biết nguyên nhân" không có nghĩa là
// cùng 1 sự cố. Không được dùng làm tín hiệu đối sánh độ tương tự.
const NON_MATCHABLE_TAXONS = new Set([OTHER_NEW_PATTERN, INSUFFICIENT_INFO]);

export interface KnowledgeSynthesisResult {
  rootCause: string;
  resolution: string;
  // Nhóm nguyên nhân canonical (id trong cause-taxonomy.json) — undefined khi
  // chạy ở chế độ không LLM (regex fallback không đủ khả năng phân loại).
  causeTaxon?: string;
}

// Giá trị fallback khi không bóc tách được gì — không phải tri thức thật,
// nên phải nhận diện được để loại khỏi Knowledge Graph (xem parseIncidentMeta
// và syncDoneTicketToKnowledgeGraph).
export const UNKNOWN_ROOT_CAUSE = "Chưa ghi nhận rõ nguyên nhân";
export const UNKNOWN_RESOLUTION = "Đã xử lý và đóng ticket";

// parseIncidentMeta chuyển sang lib/kg/incident-meta.ts (27/09) — dùng lại
// được từ lib/kg/similar-context.ts. Re-export ở đầu file để không phải sửa
// import ở nơi khác (worker/kg-sync.test.ts).

/**
 * Tách một đoạn văn thành mảng các câu (tách theo dấu chấm câu hoặc xuống dòng).
 */
function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Tìm cặp ngoặc nhọn ngoài cùng của JSON trong chuỗi (không non-greedy).
 * Hỗ trợ nested 1 cấp.
 */
function extractJsonObject(raw: string): string | null {
  const first = raw.indexOf("{");
  if (first === -1) return null;
  let depth = 0;
  for (let i = first; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) return raw.slice(first, i + 1);
    }
  }
  return null;
}

/**
 * Trích xuất Root Cause và Resolution từ chuỗi comment Kỹ thuật viên (tiếng Việt).
 */
export function extractRootCauseAndResolutionFromText(raw: string): KnowledgeSynthesisResult {
  let rootCause = "";
  let resolution = "";

  // 1. Pattern JSON cứng — tìm cặp ngoặc nhọn ngoài cùng (có thể nested)
  try {
    const jsonStr = extractJsonObject(raw);
    if (jsonStr) {
      const obj = JSON.parse(jsonStr);
      if (obj.root_cause || obj.rootCause) rootCause = String(obj.root_cause || obj.rootCause);
      if (obj.resolution) resolution = String(obj.resolution);
    }
  } catch {}

  // 2. Pattern theo từng câu
  const sentences = splitSentences(raw);

  for (const sent of sentences) {
    // Pattern ghép trên cùng câu: "Nguyên nhân: X - Cách khắc phục: Y"
    if (!rootCause && !resolution) {
      const m = sent.match(
        /(?:nguyên\s*nhân|root\s*cause)\s*[:\-–]?\s*(.+?)\s*[-–]\s*(?:cách\s*khắc\s*phục|giải\s*pháp)\s*[:\-–]?\s*(.+)/i,
      );
      if (m && m[1] && m[2]) {
        rootCause = m[1].trim();
        resolution = m[2].trim();
        break;
      }
    }

    if (!rootCause && /(nguyên\s*nhân|root\s*cause|cause|do\s*vì)/i.test(sent)) {
      // Capture bao gồm luôn từ khoá ở đầu để giữ nguyên ngữ nghĩa
      const m = sent.match(
        /((?:nguyên\s*nhân|root\s*cause|cause|do\s*vì)\s*[:\-–]?\s*[^.!?\n]+?)(?:[.!?]|$)/i,
      );
      if (m && m[1]) rootCause = m[1].trim();
    }

    if (
      !resolution &&
      /(giải\s*pháp|đã\s*xử\s*lý|đã\s*reset|đã\s*khắc\s*phục|hướng\s*dẫn|fix|resolution|remediation)/i.test(
        sent,
      )
    ) {
      // Capture bao gồm luôn từ khoá ở đầu
      const m = sent.match(
        /((?:giải\s*pháp|đã\s*xử\s*lý|đã\s*reset|đã\s*khắc\s*phục|hướng\s*dẫn|fix|resolution|remediation)\s*[:\-–]?\s*[^.!?\n]+?)(?:[.!?]|$)/i,
      );
      if (m && m[1]) resolution = m[1].trim();
    }

    if (rootCause && resolution) break;
  }

  // Làm sạch markdown boilerplate: bỏ **đậm**, chữ ký đầu dòng, và cắt phần
  // "Cách khắc phục:..." lẫn vào chuỗi root cause (thuộc resolution chứ không RC).
  const stripMarkdown = (s: string) =>
    s.replace(/\*\*/g, "").replace(/^[*\-•#]+\s*/gm, "").replace(/\s+/g, " ").trim();
  const cutTrailingResolution = (s: string) => {
    const cut = s.replace(/\s*(?:cách\s*khắc\s*phục|giải\s*pháp|hướng\s*dẫn)\s*[:\-–].*$/i, "").trim();
    // Chỉ nhận kết quả cắt nếu không làm chuỗi rỗng (tránh cắt cả từ khoá đầu dòng)
    return cut.length >= Math.min(5, s.length) ? cut : s.trim();
  };

  rootCause = cutTrailingResolution(stripMarkdown(rootCause));
  resolution = cutTrailingResolution(stripMarkdown(resolution));

  // 3. Fallback cuối cùng
  if (!rootCause && !resolution && raw.trim()) {
    resolution = raw.replace(/\s+/g, " ").trim().slice(0, 500);
  }
  if (!rootCause) rootCause = UNKNOWN_ROOT_CAUSE;
  if (!resolution) resolution = UNKNOWN_RESOLUTION;

  return {
    rootCause: redactIncidentPII(rootCause).trim(),
    resolution: redactIncidentPII(resolution).trim(),
  };
}

export async function synthesizeTicketKnowledge(
  title: string,
  description: string,
  comments: string[],
  llmConfig?: LlmConfig,
): Promise<KnowledgeSynthesisResult> {
  const fullText = [description, ...comments].filter(Boolean).join("\n---\n");

  // Không có LLM config (chế độ nhẹ / test) => quay về regex là chấp nhận
  // được, vì đây là lựa chọn có chủ đích chứ không phải LLM thất bại.
  if (!llmConfig?.baseUrl || !llmConfig?.apiKey) {
    return extractRootCauseAndResolutionFromText(fullText);
  }

  // Khi ĐÃ cấu hình LLM, tuyệt đối không được âm thầm rơi xuống regex khi
  // LLM lỗi/rỗng/sai schema — regex thô sẽ tạo ra tri thức giả (đã gây ra
  // 126+140 ticket fallback rác trong Knowledge Graph trước đây). Thà để
  // ticket này fail rõ ràng (và được backfill retry ở lần chạy sau) còn hơn.
  const taxonomyList = CAUSE_TAXONOMY.map((t) => `- ${t.id}: ${t.label} — ${t.definition}`).join("\n");
  const systemPrompt = `Bạn là chuyên gia RCA. Đọc mô tả và nhật ký, trích xuất nguyên nhân cốt lõi và giải pháp cụ thể,
đồng thời PHÂN LOẠI nguyên nhân vào ĐÚNG MỘT nhóm canonical dưới đây (chọn theo CƠ CHẾ lỗi kỹ thuật, không phải theo
hệ thống/sản phẩm bề mặt). Nếu không khớp nhóm nào, dùng "OTHER_NEW_PATTERN".

Danh sách nhóm hợp lệ:
${taxonomyList}

Trả về ĐÚNG cấu trúc JSON (không kèm markdown):
{
  "root_cause": "Nguyên nhân kỹ thuật cốt lõi",
  "resolution": "Giải pháp cụ thể đã dùng",
  "cause_taxon": "MỘT trong các id ở trên"
}`;
  const userPrompt = `Tiêu đề: ${title}\nMô tả:\n${description}\n\nNhật ký:\n${comments.join("\n---\n") || "(Không có)"}`;

  const text = await complete(llmConfig, systemPrompt, userPrompt);
  const parsed = extractJson<Record<string, string>>(text);
  if (!parsed || !parsed.root_cause || !parsed.resolution) {
    throw new Error(
      `[KgSync] LLM trả về không đúng schema root_cause/resolution, từ chối fallback regex. Raw: ${
        text ? text.slice(0, 200) : "(rỗng)"
      }`,
    );
  }

  // cause_taxon sai/lạ (model bịa id ngoài danh sách) không đủ nghiêm trọng để
  // huỷ cả kết quả rootCause/resolution đã trích xuất đúng — quy về
  // OTHER_NEW_PATTERN, một nhóm hợp lệ có ý nghĩa rõ ràng ("không khớp nhóm
  // nào"), không phải một giá trị bịa ra.
  const rawTaxon = String(parsed.cause_taxon || "").trim().toUpperCase();
  const causeTaxon = CAUSE_TAXONOMY_IDS.has(rawTaxon) ? rawTaxon : OTHER_NEW_PATTERN;
  if (rawTaxon && rawTaxon !== causeTaxon) {
    getLogger().warn(`[KgSync] cause_taxon lạ "${rawTaxon}" không có trong taxonomy, quy về ${OTHER_NEW_PATTERN}`);
  }

  return {
    rootCause: redactIncidentPII(parsed.root_cause).trim(),
    resolution: redactIncidentPII(parsed.resolution).trim(),
    causeTaxon,
  };
}

/**
 * Phân loại NHANH một sự cố MỚI (chưa có rootCause/resolution, đang ở bước
 * intake) vào 1 nhóm canonical trong cause-taxonomy.json, dựa trên triệu
 * chứng ban đầu — để tra cứu ticket tương tự trong Knowledge Graph theo cùng
 * cơ chế lỗi thay vì chỉ theo từ khoá literal.
 *
 * KHÁC BẢN CHẤT với synthesizeTicketKnowledge: đây là tín hiệu bổ trợ
 * best-effort nằm trên đường xử lý real-time của người dùng (Telegram) — lỗi
 * hay chậm ở đây TUYỆT ĐỐI không được chặn luồng tiếp nhận ticket. Vì vậy:
 * timeout ngắn, mọi lỗi đều nuốt và trả về undefined thay vì throw.
 */
export async function classifySymptomTaxon(
  title: string,
  symptoms: string,
  llmConfig?: LlmConfig,
  timeoutMs = 8000,
): Promise<string | undefined> {
  if (!llmConfig?.baseUrl || !llmConfig?.apiKey) return undefined;
  const text = `${title || ""} ${symptoms || ""}`.trim();
  if (text.length < 5) return undefined;

  const taxonomyList = CAUSE_TAXONOMY.map((t) => `- ${t.id}: ${t.label} — ${t.definition}`).join("\n");
  const systemPrompt = `Bạn phân loại triệu chứng sự cố kỹ thuật MỚI (chưa rõ nguyên nhân) vào ĐÚNG MỘT nhóm
canonical dưới đây — theo cơ chế lỗi có khả năng xảy ra nhất, không phải hệ thống/sản phẩm bề mặt. Đây chỉ
là dự đoán sơ bộ để tìm sự cố tương tự, không phải kết luận cuối cùng. Nếu không đủ thông tin để đoán, dùng
"OTHER_NEW_PATTERN".

Danh sách nhóm hợp lệ:
${taxonomyList}

Trả về ĐÚNG JSON (không kèm text khác): {"cause_taxon": "ID_NHOM"}`;
  const userPrompt = `Tiêu đề: ${title || "(không có)"}\nTriệu chứng: ${symptoms || "(không có)"}`;

  try {
    const withTimeout = new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error(`classifySymptomTaxon timeout sau ${timeoutMs}ms`)), timeoutMs);
    });
    const llmText = await Promise.race([complete(llmConfig, systemPrompt, userPrompt), withTimeout]);
    const parsed = extractJson<{ cause_taxon?: string }>(llmText);
    const raw = String(parsed?.cause_taxon || "").trim().toUpperCase();
    // OTHER_NEW_PATTERN/INSUFFICIENT_INFO nghĩa là "không đoán được" — không
    // dùng làm điểm đối sánh, vì gom các sự cố "chưa rõ nguyên nhân" lại với
    // nhau không có ý nghĩa tương tự thật sự (khác với lúc lưu vào Graph ở
    // Done-sync, nơi đây là dữ kiện lịch sử đáng ghi nhận).
    return raw && !NON_MATCHABLE_TAXONS.has(raw) && CAUSE_TAXONOMY_IDS.has(raw) ? raw : undefined;
  } catch (err: any) {
    getLogger().warn(`[KgSync] classifySymptomTaxon thất bại (best-effort, bỏ qua): ${err.message}`);
    return undefined;
  }
}

/** Sổ ghi "đã nạp ticket X với nội dung Y lúc Z" — xem KgSyncRepository. */
export interface KgSyncLedger {
  get(identifier: string): { fingerprint: string; syncedAt: number } | null;
  record(identifier: string, fingerprint: string, syncedAt: number): void;
}

export interface KgSyncOptions {
  /** Dự án worker. Ticket dự án khác → bỏ qua (webhook không lọc dự án). */
  projectKey?: string;
  /** Có sổ thì ticket đã nạp với đúng nội dung này, trong cửa sổ, sẽ không bị LLM bóc lại. */
  ledger?: KgSyncLedger;
  /** Mặc định 7 ngày. Quá cửa sổ thì nạp lại dù nội dung không đổi (taxonomy/prompt có thể đã đổi). */
  dedupeWindowMs?: number;
  now?: () => number;
  /** Tra trạng thái thật của ticket theo cột dự án — ticket bị Canceled/archived
   * SAU khi từng Done phải được ghi đúng trạng thái, không nằm lại KG như tri
   * thức sống (đã gây nhiễu: ticket huỷ vẫn được gợi ý). Thiếu thì mặc định Done. */
  columnStates?: Pick<ProjectColumnStates, "stateOf">;
  /** Mặc định true. Backfill tắt đi và tính lại cụm một lần ở cuối. */
  recomputeClusters?: boolean;
}

export type KgSyncResult = {
  success: boolean;
  /** true khi cố ý không nạp (dự án khác / đã nạp đúng nội dung này). */
  skipped?: boolean;
  reason?: string;
  node?: TicketGraphNode;
  error?: string;
};

const DEFAULT_DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Dấu vân tay nội dung dùng để trích xuất tri thức. Chỉ gồm những gì đi vào
 * LLM/graph — comment của bot (xác nhận đóng, thông báo nạp) không làm đổi
 * dấu, nên ticket Done được gọi 2–3 lần liên tiếp chỉ bị bóc một lần.
 */
export function ticketContentFingerprint(issue: any, comments: string[], human?: unknown, similarContext?: unknown): string {
  const payload = JSON.stringify({
    human: human ?? null,
    title: issue.title ?? "",
    description: issue.description ?? "",
    priority: issue.priority ?? null,
    fields: (issue.fields ?? []).map((f: any) => [f.fieldId, f.value ?? null]),
    links: (issue.links ?? []).map((l: any) => String(l.issue?.identifier ?? "").toUpperCase()).sort(),
    comments,
    // description/humanNotes (lib/kg/similar-context.ts) là hàm THUẦN của
    // issue.description + timeline — về lý thuyết đã nằm trong payload trên
    // (description raw, comments), nhưng đưa thẳng giá trị đã tính vào đây để
    // không phụ thuộc ngầm vào việc bộ lọc comment ở trên khớp CHÍNH XÁC với
    // bộ lọc isSystemActor của similarContextOf — đổi cách trích ngữ cảnh
    // (không đổi issue/timeline) vẫn phải re-sync.
    similarContext: similarContext ?? null,
  });
  return createHash("sha256").update(payload).digest("hex");
}

// Tên nhãn theo dự án — để nhận ticket IT Support (id nhãn khác nhau giữa các dự án).
const labelNameCache = new Map<string, { at: number; names: Map<number, string> }>();
async function labelNames(client: ItsaplanClient, projectKey: string): Promise<Map<number, string>> {
  const hit = labelNameCache.get(projectKey);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.names;
  const project = await client.getProject(projectKey);
  const names = new Map((project.labels ?? []).map((l) => [l.id, l.name]));
  labelNameCache.set(projectKey, { at: Date.now(), names });
  return names;
}

export async function syncDoneTicketToKnowledgeGraph(
  client: ItsaplanClient,
  memgraph: MemgraphClient,
  issueId: number,
  llmConfig?: LlmConfig,
  options: KgSyncOptions = {},
): Promise<KgSyncResult> {
  try {
    const issue = await client.getIssue(issueId);
    if (!issue || !issue.identifier) {
      return { success: false, error: `Issue #${issueId} không tồn tại` };
    }
    if (!identifierInProject(issue.identifier, options.projectKey)) {
      getLogger().info(`[KgSync] Bỏ qua ${issue.identifier}: không thuộc dự án ${options.projectKey}.`);
      return { success: true, skipped: true, reason: `không thuộc dự án ${options.projectKey}` };
    }

    const timeline = await client.getIssueTimeline(issueId).catch(() => []);
    // Chỉ lấy comment của người thật: loại comment của bot (Tiểu Linh / Onyx)
    // và mọi nội dung boilerplate tự sinh — nếu không tri thức bị nhiễu chữ ký
    // bot. Dùng CHUNG isBotAuthoredComment với similarContextOf (bên dưới) —
    // một bot có khi bình luận dưới tên không khớp isSystemActor (vd "Iris")
    // nhưng vẫn mang dấu marker, tách riêng 2 định nghĩa sẽ lệch nhau.
    const comments = timeline
      .filter((item: any) => item.kind === "comment" && !isBotAuthoredComment(item))
      .map((item: { body?: string | null }) => stripCommentHtml(item.body).trim())
      .filter(Boolean);

    // Tín hiệu người (ADR-0007): comment ghim + link/trường người gắn, gỡ. Ghim
    // một comment không đổi nội dung comment → phải vào dấu vân tay, nếu không
    // sổ chống nạp lại sẽ bỏ qua đúng lần tech lead vừa ghim nguyên nhân.
    const human = humanKnowledgeOf(timeline, issue.identifier);
    // Ngữ cảnh giàu cho ticket tương tự (lib/kg/similar-context.ts) — MỘT
    // nguồn duy nhất, benchmark (scripts/eval-similar-bench.ts) gọi cùng hàm
    // này trên kb.json để đo đúng cái production chạy (27/09).
    const similarContext = similarContextOf(issue, timeline);

    const now = options.now ?? Date.now;
    const fingerprint = ticketContentFingerprint(issue, comments, human, similarContext);
    const previous = options.ledger?.get(issue.identifier);
    const windowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    if (previous && previous.fingerprint === fingerprint && now() - previous.syncedAt < windowMs) {
      getLogger().info(`[KgSync] Bỏ qua ${issue.identifier}: đã nạp đúng nội dung này, không gọi LLM lại.`);
      return { success: true, skipped: true, reason: "đã nạp, nội dung không đổi" };
    }

    const meta = parseIncidentMeta(issue.description);
    // Mô tả đã làm sạch (bỏ khối bot sinh) dùng cho CẢ trích xuất Nguyên nhân/
    // Cách khắc phục (synthesizeTicketKnowledge) LẪN node.description của KG.
    const cleanDescription = similarContext.description;

    // Comment ghim của người là nguồn chuẩn: lấy nguyên văn, LLM chỉ còn để gắn
    // nhóm nguyên nhân (best-effort — LLM lỗi không chặn tri thức người đã viết).
    // Không có comment ghim thì như cũ: LLM bắt buộc, lỗi thì để lần sau thử lại.
    let rootCause: string;
    let resolution: string;
    let causeTaxon: string | undefined;
    if (human.cause) {
      rootCause = redactIncidentPII(human.cause).trim();
      let llmResolution: string | undefined;
      try {
        const k = await synthesizeTicketKnowledge(issue.title, cleanDescription, comments, llmConfig);
        causeTaxon = k.causeTaxon;
        llmResolution = k.resolution;
      } catch (err: any) {
        getLogger().warn(`[KgSync] ${issue.identifier}: có comment ghim, bỏ qua lỗi LLM phân loại nhóm nguyên nhân: ${err.message}`);
      }
      resolution = human.fix ? redactIncidentPII(human.fix).trim() : (llmResolution ?? UNKNOWN_RESOLUTION);
    } else {
      ({ rootCause, resolution, causeTaxon } = await synthesizeTicketKnowledge(
        issue.title,
        cleanDescription,
        comments,
        llmConfig,
      ));
    }

    // Cạnh RELATES_TO / REJECTED_RELATION CHỈ từ tín hiệu người (ADR-0007). Link
    // và trường Related Tickets do bot ghi không bao giờ thành tri thức — học lại
    // chúng là tự củng cố gợi ý sai (1.382/1.621 link trên TECH là bot gắn).
    // Chỉ giữ mã cùng dự án: mã test (TEST-KG-*) hay dự án khác không vào KG.
    const selfId = issue.identifier.toUpperCase();
    const selfProject = projectOfIdentifier(issue.identifier);
    const sameProject = (id: string) => id !== selfId && projectOfIdentifier(id) === selfProject;
    const uniqueRelatedTickets = human.positives.filter(sameProject);
    const uniqueNegativeTickets = human.negatives.filter(sameProject);

    // Giá trị fallback ("Chưa ghi nhận rõ nguyên nhân" / "Đã xử lý và đóng
    // ticket") không phải tri thức thật rút ra từ ticket — nếu nạp vào Graph
    // sẽ tạo ra các node RootCause/Resolution giả dùng chung bởi hàng trăm
    // ticket không liên quan, làm hỏng mọi gợi ý dựa trên RootCause. Loại
    // hẳn khỏi Knowledge Graph thay vì cố ép LLM bóc lại (sẽ chỉ tạo
    // hallucination vì kỹ thuật viên thực sự không ghi gì).
    const graphRootCause = rootCause === UNKNOWN_ROOT_CAUSE ? undefined : rootCause;
    const graphResolution = resolution === UNKNOWN_RESOLUTION ? undefined : resolution;

    // Chuẩn hoá System về danh mục đóng 9 giá trị (system-taxonomy.json) —
    // tuyến phòng thủ 1: meta.system đến từ mô tả ticket (người nhập tay),
    // có thể là bất kỳ nhãn nào; không normalize thì graph lại phình nhãn rác.
    const normalizedSystem = normalizeSystemName(meta.system);
    if (normalizedSystem?.needsReview) {
      getLogger().warn(
        `[KgSync] ${issue.identifier}: system "${meta.system}" → "${normalizedSystem.value}" (${normalizedSystem.via}) — CẦN REVIEW (bucket chưa chốt/fallback)`,
      );
    }

    // resolvedAt = mốc ticket THỰC SỰ vào cột hoàn tất, KHÔNG dùng updatedAt.
    //
    // updatedAt bị đạp lại mỗi lần vé bị chỉnh sửa về sau — kể cả khi việc
    // chỉnh đó là tech lead GỠ link bot gợi ý sai (158 lượt link_remove).
    // Đo trên 128 node live (25/09): 45% node có updatedAt lệch mốc Done thật
    // ≥ 1 ngày, 11% lệch ≥ 7 ngày, đỉnh 27,6 ngày — time-decay half-life 14
    // ngày vì thế thổi điểm cũ lên tới 3,9x, đúng những vé bị người sửa nhiều
    // nhất lại được coi là "tươi" nhất. Công bằng ngược.
    //
    // statusSince là mốc vào cột hiện tại do Itsaplan trả sẵn; timeline có sự
    // kiện `action:"status"` làm phương án dự phòng khi API list thiếu field;
    // updatedAt chỉ còn là chốt cuối cho dữ liệu cũ.
    const statusTransitions = timeline
      .filter((item: any) => item?.action === "status" && typeof item.createdAt === "string")
      .map((item: any) => item.createdAt as string)
      .sort();
    const lastStatusTransition = statusTransitions[statusTransitions.length - 1];
    const resolvedAt = issue.statusSince || lastStatusTransition || issue.updatedAt;

    // Status thật từ cột dự án — không hardcode Done (bài học tech lead: 158/158
    // lượt link_remove toàn là người gỡ những gợi ý sai; ticket bị Canceled/archived
    // sau khi từng Done cũng phải ghi đúng trạng thái, không "đóng băng" là Done
    // — chính loại nhiễu này khiến queryRelatedTickets cũ trả ra ticket đã huỷ.
    // Thiếu columnStates (đường gọi không qua worker) thì giữ mặc định Done
    // cho không phá dữ liệu đang có.
    const ticketStatus: string = await (async () => {
      if (!options.columnStates || typeof issue.columnId !== "number") return "Done";
      if (!options.projectKey) return "Done";
      const hit = await options.columnStates.stateOf(options.projectKey, issue.columnId).catch(() => null);
      if (!hit) return "Done";
      const cap = hit.state.charAt(0).toUpperCase() + hit.state.slice(1);
      return cap;
    })();

    const node: TicketGraphNode = {
      identifier: issue.identifier,
      title: issue.title,
      status: ticketStatus,
      priority: issue.priority || meta.priority || "Medium",
      createdAt: issue.createdAt,
      resolvedAt,
      product: meta.product,
      system: normalizedSystem?.value ?? meta.system,
      errorCategory: meta.category,
      reportingDept: meta.reportingDept,
      studentAccount: meta.studentAccount,
      customerId: meta.customerId,
      deviceType: meta.deviceType,
      deviceOs: meta.deviceOs,
      appVersion: meta.appVersion,
      assignmentId: meta.assignmentId,
      roomCode: meta.roomCode,
      rootCause: graphRootCause,
      resolution: graphResolution,
      // Không có rootCause thật (fallback bị loại) thì cũng không có gì để
      // phân loại — causeTaxon phải đi kèm rootCause, không đứng một mình.
      causeTaxon: graphRootCause ? causeTaxon : undefined,
      relatedTickets: uniqueRelatedTickets,
      negativeTickets: uniqueNegativeTickets,
      symptomsText: symptomsOfDescription(issue.description),
      humanCause: human.cause,
      humanFix: human.fix,
      description: similarContext.description || undefined,
      humanNotes: similarContext.humanNotes || undefined,
      itSupport: await (async () => {
        if (!issue.labelIds?.length || !selfProject || typeof client.getProject !== "function") return false;
        const names = await labelNames(client, selfProject).catch(() => new Map<number, string>());
        return issue.labelIds.some((id) => /it\s*support/i.test(names.get(id) ?? ""));
      })(),
    };

    await memgraph.upsertTicketNode(node);
    // Cụm nguyên nhân là thuộc tính toàn KG — một link người gắn có thể gộp hai cụm.
    if (options.recomputeClusters !== false) {
      await memgraph.recomputeCauseClusters().catch((err: any) => {
        getLogger().warn(`[KgSync] Tính lại cụm nguyên nhân lỗi (lần nạp sau sẽ tính lại): ${err?.message ?? err}`);
      });
    }
    // Chỉ ghi sổ sau khi Memgraph nhận — lỗi ở đâu thì lần sau còn thử lại.
    options.ledger?.record(issue.identifier, fingerprint, now());

    getLogger().info(`[KgSync] Đã nạp thành công ticket ${issue.identifier} vào Memgraph Knowledge Graph.`);
    return { success: true, node };
  } catch (err: any) {
    getLogger().error(`[KgSync] Lỗi syncDoneTicketToKnowledgeGraph: ${err.message}`);
    return { success: false, error: err.message };
  }
}
