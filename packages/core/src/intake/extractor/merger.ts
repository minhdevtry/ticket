/**
 * Field merging across turns (RFC 0002 §1.5 E2, E4, A14).
 *
 * Implements merge invariants:
 * - Title locked when user explicitly sets it (A14)
 * - Summarized title updates only when new content arrives (TECH-941, TECH-943)
 * - Title never set to invalid title / person name (TECH-1146)
 * - Evidence flags never downgraded from true to false (E4)
 * - Scope never downgraded to lower rank
 * - Symptoms unioned, removals applied, length capped
 * - Verbatim rawText appended and capped
 */

import type { ExtractedFields } from "../ports";
import { IDENTIFIER_KEYS, type IdentifierKey } from "../ports";
import { isInvalidTitle } from "./heuristics";

export const MAX_SYMPTOM_CHARS = 1500;
export const MAX_SYMPTOMS = 30;
export const MAX_RAW_TEXT_CHARS = 4000;
export const MAX_RAW_TEXT_TOTAL_CHARS = 8000;

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export interface MergeOptions {
  /**
   * Only merge structured fields (dept, phone, device, etc.), ignore title/symptoms.
   * Used for confirmations, cancels, chitchat, decline answers.
   */
  structuredOnly?: boolean;
  /** Force append message to rawText even if no symptoms were extracted. */
  appendRawText?: boolean;
}

export interface FieldValue<T = unknown> {
  value: T;
  source: string;
  turn: number;
  rawText?: string;
  updatedAt: string;
  explicit?: boolean;
}

export interface IntakeDocument {
  docId: string;
  chatId: string;
  revision: number;
  status: string;
  currentTurn: number;
  fields: Record<string, FieldValue | undefined>;
  evidence: Record<string, unknown>;
  askedCount?: Record<string, number>;
  similarTickets?: unknown[];
  createdAt: string;
  updatedAt: string;
  unrecognizedDept?: string;
}

const SCOPE_RANK: Record<string, number> = {
  none: 0,
  single_user: 1,
  group: 2,
  entire_system: 3,
};

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
  const cappedMessage = cap(rawMessage, MAX_RAW_TEXT_CHARS);
  const now = new Date().toISOString();
  const nextFields: Record<string, FieldValue | undefined> = { ...doc.fields };
  const source = "user_message";

  const setField = <T>(key: string, val: T | null | undefined, explicit?: boolean) => {
    if (val !== undefined && val !== null && String(val).trim() !== "") {
      nextFields[key] = {
        value: val,
        source,
        turn,
        rawText: cappedMessage,
        updatedAt: now,
        ...(explicit ? { explicit: true } : {}),
      };
    }
  };

  const validSymptomsCount = extracted.symptoms?.length ?? 0;
  const hasNewContent = validSymptomsCount > 0;
  const titleLocked = nextFields.title?.explicit === true;

  if (
    !structuredOnly &&
    extracted.title &&
    (extracted.titleExplicit || !nextFields.title || (hasNewContent && !titleLocked))
  ) {
    const reportContext = `${nextFields.rawText?.value ? String(nextFields.rawText.value) : ""}\n${cappedMessage}`;
    if (!isInvalidTitle(extracted.title, reportContext)) {
      setField("title", cap(extracted.title.trim(), 120), extracted.titleExplicit);
    }
  }

  const givesIdentifier = IDENTIFIER_KEYS.some((k: IdentifierKey) => {
    const fromIdentifiers = extracted.identifiers?.[k];
    const fromDirect = (extracted as unknown as Record<string, unknown>)[k];
    const val = typeof fromIdentifiers === "string" ? fromIdentifiers : fromDirect;
    return typeof val === "string" && val.trim() !== "";
  });

  const carriesText =
    (!structuredOnly && (hasNewContent || givesIdentifier)) || options.appendRawText === true;
  const message = cappedMessage.trim();
  if (carriesText && message) {
    const prev = nextFields.rawText?.value ? String(nextFields.rawText.value) : "";
    if (!prev) {
      setField("rawText", cappedMessage);
    } else if (!prev.includes(message)) {
      setField("rawText", cap(`${prev}\n${cappedMessage}`, MAX_RAW_TEXT_TOTAL_CHARS));
    }
  }

  setField("product", extracted.product ?? extracted.values?.product);
  setField("system", extracted.system ?? extracted.values?.system);
  setField("errorCategory", extracted.errorCategory ?? extracted.values?.errorCategory);
  setField("reportingDept", extracted.reportingDept ?? extracted.values?.reportingDept);
  setField("customerId", extracted.customerId ?? extracted.identifiers?.customerId);
  setField("studentAccount", extracted.studentAccount ?? extracted.identifiers?.studentAccount);
  setField("roomCode", extracted.roomCode ?? extracted.identifiers?.roomCode);
  setField("deviceType", extracted.deviceType ?? extracted.values?.deviceType);
  setField("deviceOs", extracted.deviceOs ?? extracted.values?.deviceOs);
  setField("appVersion", extracted.appVersion ?? extracted.values?.appVersion);
  setField("browser", extracted.browser ?? extracted.values?.browser);
  setField("transactionId", extracted.transactionId ?? extracted.identifiers?.transactionId);
  setField("assignmentId", extracted.assignmentId ?? extracted.identifiers?.assignmentId);

  const removals = (extracted.removeSymptoms ?? [])
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);

  const prevSymptoms = Array.isArray(nextFields.symptoms?.value)
    ? (nextFields.symptoms.value as string[])
    : [];

  const keptPrev = prevSymptoms.filter((s) => !removals.some((r) => s.toLowerCase().includes(r)));

  const incomingSymptoms = structuredOnly
    ? []
    : (extracted.symptoms ?? [])
        .filter((s) => !removals.some((r) => s.toLowerCase().includes(r)))
        .map((s) => cap(s, MAX_SYMPTOM_CHARS));

  const mergedSymptoms: string[] = [];
  const seenSymptoms = new Set<string>();

  for (const s of [...keptPrev, ...incomingSymptoms]) {
    const normalized = s.trim().toLowerCase();
    if (!seenSymptoms.has(normalized)) {
      seenSymptoms.add(normalized);
      mergedSymptoms.push(s);
    }
    if (mergedSymptoms.length >= MAX_SYMPTOMS) break;
  }

  const symptomsChanged =
    mergedSymptoms.length !== prevSymptoms.length ||
    mergedSymptoms.some((s, i) => s !== prevSymptoms[i]);

  if (symptomsChanged) {
    if (mergedSymptoms.length > 0) {
      nextFields.symptoms = {
        value: mergedSymptoms,
        source,
        turn,
        rawText: cappedMessage,
        updatedAt: now,
      };
    } else {
      delete nextFields.symptoms;
    }
  }

  const nextEvidence: Record<string, unknown> = { ...doc.evidence };
  const incomingScope = extracted.scope ?? (extracted.evidence?.scope as string | undefined);
  if (incomingScope) {
    const currentScope = (nextEvidence.scope as string | undefined) ?? "none";
    if ((SCOPE_RANK[incomingScope] ?? 0) > (SCOPE_RANK[currentScope] ?? 0)) {
      nextEvidence.scope = incomingScope;
    }
  }

  for (const key of EVIDENCE_FLAGS) {
    const value = extracted[key] ?? extracted.evidence?.[key];
    if (typeof value === "boolean" && nextEvidence[key] !== true) {
      nextEvidence[key] = value;
    }
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
