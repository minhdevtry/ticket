import type { IntakeDocument, FieldValue, FieldSource } from "../intake-document/types";
import type { ExtractedFields } from "./extractor-schema";
import { IDENTIFIER_FIELD_KEYS } from "../identifier-grounding";
import { isInternalCallbackToken } from "@vuihoc/bot-core/core";
import { isInvalidTitle } from "./multi-incident";
import { isBotButtonLabel, normalizeLine } from "./button-labels";

/** Một triệu chứng dài hơn chừng này bị cắt — tin dán log không được thổi phồng mô tả ticket. */
export const MAX_SYMPTOM_CHARS = 1500;
/** Số triệu chứng tối đa giữ lại trên một tài liệu. */
export const MAX_SYMPTOMS = 30;
/** Một tin nhắn trong rawText giữ tối đa chừng này ký tự. */
export const MAX_RAW_TEXT_CHARS = 4000;
/** Tổng rawText (mọi lời kể nguyên văn của người báo) giữ tối đa chừng này ký tự. */
export const MAX_RAW_TEXT_TOTAL_CHARS = 8000;

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Độ dài tối thiểu để so "gần giống" — dòng ngắn thì dễ trùng nhầm. */
const NEAR_DUPLICATE_MIN_CHARS = 25;
/** Số ký tự được phép lệch để coi là "gần lặp" (agent gõ lại lệch 1–2 ký tự). */
const NEAR_DUPLICATE_MAX_EDITS = 2;

/** Mọi số / email trong dòng — dòng mới mang số mới thì KHÔNG phải bản lặp. */
const IDENTIFIER_TOKEN = /\d+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g;

function identifierTokens(line: string): Set<string> {
  return new Set(line.match(IDENTIFIER_TOKEN) ?? []);
}

/**
 * Hai dòng cách nhau không quá {@link NEAR_DUPLICATE_MAX_EDITS} ký tự? (Levenshtein
 * có dải hẹp: chỉ xét các ô trong khoảng `k` — O(n·k), không O(n²)).
 */
function withinFewEdits(a: string, b: string): boolean {
  const k = NEAR_DUPLICATE_MAX_EDITS;
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > k) return false;
  const inf = k + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(inf);
    if (i <= k) cur[0] = i;
    const lo = Math.max(1, i - k);
    const hi = Math.min(b.length, i + k);
    for (let j = lo; j <= hi; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    let best = inf;
    for (let j = lo; j <= hi; j++) best = Math.min(best, cur[j]);
    if (best > k) return false;
    prev = cur;
  }
  return prev[b.length] <= k;
}

/**
 * Phần MỚI của một tin so với lời kể đã có — bỏ dòng lặp lại và dòng là lời của
 * bot, để mục "### Mô tả" không hiện nội dung hai lần.
 *
 * Vì sao cần: lượt xác nhận, agent (OpenClaw) đôi khi truyền lại chính tin
 * người báo vừa gửi — có khi y nguyên, có khi lệch một dấu cách, có khi gõ lại
 * lệch một chữ, có khi kèm nhãn nút ("Sự cố mới") hoặc token nội bộ ("noop").
 * So sánh "tin có nằm trong lời kể không" bằng `includes` trên CẢ tin nên hụt:
 * lệch một dấu cách là thêm nguyên tin, và tên nút/token nội bộ lọt thẳng vào
 * mô tả (TECH-1141, TECH-1167, TECH-1201, TECH-1307).
 *
 * So sánh theo DÒNG và chuẩn hoá (bỏ dấu markdown, gộp khoảng trắng, không
 * phân biệt hoa thường): dòng đã có thì bỏ, dòng mới thì giữ. Lời người báo
 * nhắc lại đúng một câu cũ vì thế chỉ hiện một lần trong mô tả.
 *
 * Dòng "gần lặp" (lệch ≤ 2 ký tự, ví dụ agent gõ lại lệch một chữ) cũng bị
 * bỏ — nhưng CHỈ khi dòng mới không mang số/email mới: "lớp 5" và "lớp 6" là
 * hai sự cố khác nhau, không được gộp.
 */
export function newLinesOnly(message: string, existing: string): string {
  const existingLines = existing
    .split("\n")
    .map(normalizeLine)
    .filter((line) => line !== "");
  const seen = new Set(existingLines);
  // Số/email đã có trong lời kể: dòng mới mang số mới thì không phải bản lặp.
  const knownIdentifiers = new Set<string>();
  for (const line of existingLines)
    for (const id of identifierTokens(line)) knownIdentifiers.add(id);

  const kept: string[] = [];
  const keptLines: string[] = [];
  for (const rawLine of message.split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      kept.push("");
      continue;
    }
    // Lời của bot (nhãn nút, token nội bộ) không phải lời kể của người báo.
    if (isBotButtonLabel(line) || isInternalCallbackToken(line)) continue;
    const normalized = normalizeLine(line);
    if (seen.has(normalized)) continue;
    if (normalized.length >= NEAR_DUPLICATE_MIN_CHARS) {
      const newIdentifiers = [...identifierTokens(normalized)].filter(
        (id) => !knownIdentifiers.has(id),
      );
      if (newIdentifiers.length === 0) {
        const twin = [...keptLines, ...existingLines].find(
          (other) => other.length >= NEAR_DUPLICATE_MIN_CHARS && withinFewEdits(other, normalized),
        );
        if (twin !== undefined) continue;
      }
    }
    seen.add(normalized);
    kept.push(line);
    keptLines.push(normalized);
    for (const id of identifierTokens(normalized)) knownIdentifiers.add(id);
  }
  return kept.join("\n").trim();
}

export interface MergeOptions {
  /**
   * Chỉ gộp trường cấu trúc (phòng ban, SĐT, thiết bị…), bỏ tiêu đề/triệu chứng.
   * Dùng cho tin xác nhận, huỷ, cảm ơn, "không biết" — những câu đó không phải mô tả lỗi.
   */
  structuredOnly?: boolean;
  /** Ghi tin này vào rawText dù không trích được triệu chứng (câu trả lời cho câu hỏi dữ kiện). */
  appendRawText?: boolean;
}

const SCOPE_RANK: Record<string, number> = { none: 0, single_user: 1, group: 2, entire_system: 3 };
const EVIDENCE_FLAGS = [
  "blocksPayment",
  "reconciliationMismatch",
  "blocksLearning",
  "dataLoss",
  "hasWorkaround",
  "singleDeviceOnly",
] as const;

export function mergeExtractedFields(
  doc: IntakeDocument,
  extracted: ExtractedFields,
  turn: number,
  rawMessage: string,
  options: MergeOptions = {},
): IntakeDocument {
  const structuredOnly = options.structuredOnly === true;
  rawMessage = cap(rawMessage, MAX_RAW_TEXT_CHARS);
  const now = new Date().toISOString();
  const nextFields = { ...doc.fields };
  const source: FieldSource = "user_message";

  const setField = <T>(key: keyof typeof nextFields, val: T | null | undefined) => {
    if (val !== undefined && val !== null && String(val).trim() !== "") {
      (nextFields as any)[key] = {
        value: val,
        source,
        turn,
        rawText: rawMessage,
        updatedAt: now,
      } as FieldValue<T>;
    }
  };

  // Tiêu đề là bản TÓM TẮT cả sự cố: lượt nào mang mô tả mới thì LLM tóm lại (có ngữ cảnh
  // cũ), để lời mở đầu kiểu "hỗ trợ em với ạ" hay dòng tên học sinh không thành tiêu đề vĩnh
  // viễn (28/09: TECH-941 "Vũ Thị Bảo G", TECH-943 "hỗ trợ em với ạ"). Tiêu đề người
  // dùng tự đặt ("sửa tiêu đề thành …") thì giữ, chỉ lệnh sửa tiêu đề mới đổi được.
  // TECH-1148: Bỏ qua symptoms chỉ là token nội bộ (như "noop")
  const validSymptomsCount =
    extracted.symptoms?.filter((s) => !isInternalCallbackToken(s)).length ?? 0;
  const hasNewContent = validSymptomsCount > 0;
  const titleLocked = nextFields.title?.explicit === true;
  if (
    !structuredOnly &&
    extracted.title &&
    !isInternalCallbackToken(extracted.title) &&
    (extracted.titleExplicit || !nextFields.title || (hasNewContent && !titleLocked))
  ) {
    // Chốt chặn: KHÔNG BAO GIỜ chấp nhận tên học sinh hoặc mã định danh làm tiêu đề (TECH-1146).
    // Vòng 2: chỉ từ chối tên người khi tên đó THẬT SỰ là một dòng tên trong báo cáo.
    const reportContext = `${nextFields.rawText?.value ?? ""}\n${rawMessage}`;
    if (!isInvalidTitle(extracted.title, reportContext)) {
      setField("title", cap(extracted.title.trim(), 120));
      if (extracted.titleExplicit) nextFields.title = { ...nextFields.title!, explicit: true };
    }
  }
  // rawText = NGUYÊN VĂN mọi tin mang nội dung của người báo — là phần "Mô tả" của ticket
  // và là nguồn đối chiếu định danh. 28/09: chỉ giữ tin ĐẦU nên TECH-972 mất câu trả lời
  // bổ sung (mã đơn, hạn đang hiện/hạn đúng) ở lượt sau.
  // Tin chỉ trả lời một định danh ("0900000005") cũng phải vào: bộ đối chiếu định danh
  // (ticket-formatter) chỉ tin chữ số có trong rawText, thiếu thì xoá nhầm trường thật.
  const givesIdentifier = IDENTIFIER_FIELD_KEYS.some((k) => {
    const v = (extracted as Record<string, unknown>)[k];
    return typeof v === "string" && v.trim() !== "";
  });
  const carriesText =
    (!structuredOnly && (hasNewContent || givesIdentifier)) || options.appendRawText === true;
  const message = rawMessage.trim();
  // TECH-1148: Không đưa tin nhắn chỉ là token nội bộ ("noop") vào rawText
  if (carriesText && message && !isInternalCallbackToken(message)) {
    const prev = nextFields.rawText?.value;
    // Chỉ ghi phần CHƯA có: lượt xác nhận hay bị agent truyền lại chính tin
    // người báo vừa gửi (lệch một dấu cách cũng là lặp) — gộp thêm thì mô tả
    // ticket hiện nội dung hai lần (TECH-1167, TECH-1201, TECH-1307).
    const fresh = newLinesOnly(rawMessage, prev ?? "");
    if (fresh) {
      setField("rawText", cap(prev ? `${prev}\n${fresh}` : fresh, MAX_RAW_TEXT_TOTAL_CHARS));
    }
  }

  setField("product", extracted.product);
  setField("system", extracted.system);
  setField("errorCategory", extracted.errorCategory);
  setField("reportingDept", extracted.reportingDept);
  setField("customerId", extracted.customerId);
  setField("studentAccount", extracted.studentAccount);
  setField("roomCode", extracted.roomCode);
  setField("deviceType", extracted.deviceType);
  setField("deviceOs", extracted.deviceOs);
  setField("appVersion", extracted.appVersion);
  setField("browser", extracted.browser);
  setField("transactionId", extracted.transactionId);
  setField("assignmentId", extracted.assignmentId);

  // Symptoms gộp không trùng lặp; bỏ những ý người dùng bảo gỡ
  const removals = (extracted.removeSymptoms ?? [])
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  const existingSymptoms = (nextFields.symptoms?.value || []).filter(
    (s) => !removals.some((r) => s.toLowerCase().includes(r)),
  );
  // TECH-1148: Loại bỏ symptoms chỉ là token nội bộ như "noop"
  const incomingSymptoms = structuredOnly
    ? []
    : (extracted.symptoms || [])
        .map((s) => cap(s.trim(), MAX_SYMPTOM_CHARS))
        .filter((s) => !isInternalCallbackToken(s));
  const mergedSymptoms = Array.from(
    new Set([...existingSymptoms, ...incomingSymptoms].filter(Boolean)),
  ).slice(-MAX_SYMPTOMS);
  const symptomsChanged =
    mergedSymptoms.length !== (nextFields.symptoms?.value?.length ?? 0) ||
    mergedSymptoms.some((s, i) => s !== nextFields.symptoms?.value?.[i]);
  if (symptomsChanged) {
    if (mergedSymptoms.length > 0) {
      nextFields.symptoms = {
        value: mergedSymptoms,
        source,
        turn,
        rawText: rawMessage,
        updatedAt: now,
      };
    } else {
      delete nextFields.symptoms;
    }
  }

  // Evidence cho Priority Matrix. Cờ đã true thì giữ, phạm vi chỉ nới rộng: model
  // hay điền false / single_user mặc định ở lượt bổ sung (vd tin chỉ có SĐT), nếu
  // cho ghi đè thì "cả lớp không vào học" tụt từ Urgent về Medium ở lượt sau.
  const nextEvidence = { ...doc.evidence };
  if (extracted.scope && SCOPE_RANK[extracted.scope] > SCOPE_RANK[nextEvidence.scope ?? "none"]) {
    nextEvidence.scope = extracted.scope;
  }
  for (const key of EVIDENCE_FLAGS) {
    const value = extracted[key];
    if (typeof value === "boolean" && nextEvidence[key] !== true) nextEvidence[key] = value;
  }

  return {
    ...doc,
    revision: doc.revision + 1,
    currentTurn: turn,
    fields: nextFields,
    evidence: nextEvidence,
    updatedAt: now,
  };
}
