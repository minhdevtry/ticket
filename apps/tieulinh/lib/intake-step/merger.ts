import type { IntakeDocument, FieldValue, FieldSource } from "../intake-document/types";
import type { ExtractedFields } from "./extractor-schema";
import { IDENTIFIER_FIELD_KEYS } from "../identifier-grounding";
import { isInternalCallbackToken } from "@vuihoc/bot-core/core";
import { isInvalidTitle } from "./multi-incident";

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
    if (!prev) setField("rawText", rawMessage);
    else if (!prev.includes(message))
      setField("rawText", cap(`${prev}\n${rawMessage}`, MAX_RAW_TEXT_TOTAL_CHARS));
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
