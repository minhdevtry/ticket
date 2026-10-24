/**
 * The qualification gate: given a catalog and what has been captured so far,
 * decide whether there is enough to proceed and what to ask next.
 *
 * Pure. No I/O, no clock, no mutation of the input record.
 */
import { getVariant, getVocabulary, retryBudget } from "./catalog";
import { REQUIRED_IF_RULE } from "./types";
import type { FieldCatalog, FieldSpec, FieldVerdict, GateResult, IntakeRecord } from "./types";
import { validateValue } from "./validate";

function hasValidValue(record: IntakeRecord, fieldName: string, invalidSet: Set<string>): boolean {
  return (record.values[fieldName] ?? "").trim().length > 0 && !invalidSet.has(fieldName);
}

/**
 * Bỏ dấu và hạ chữ thường, để so khớp văn xuôi không phụ thuộc cách gõ.
 * "Không gấp", "khong gap", "KHÔNG GẤP" ra cùng một chuỗi.
 */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/**
 * Evaluates a `requiredIf` rule. Three forms, all `"<field> <op> <vocabulary>"`:
 *
 * - `in` — giá trị khớp NGUYÊN VĂN một mục trong danh sách. Dành cho trường enum.
 * - `matches` — giá trị có chứa một trong các mục (bỏ dấu, không phân biệt hoa
 *   thường). Dành cho trường text người dùng tự gõ.
 * - `not matches` — có giá trị, nhưng không chứa mục nào. Trường còn TRỐNG thì
 *   luật trả `false`: chưa hỏi xong câu trước thì chưa được đòi câu sau.
 *
 * Rules are validated when the catalog is built, so a parse failure here is a bug.
 */
export function isConditionMet(
  catalog: FieldCatalog,
  rule: string,
  values: Record<string, string>,
): boolean {
  const match = REQUIRED_IF_RULE.exec(rule.trim());
  if (!match) throw new Error(`Cannot parse requiredIf rule: "${rule}"`);
  const [, fieldName, operator, vocabularyKey] = match;
  const vocabulary = catalog.enums[vocabularyKey];
  if (!vocabulary) throw new Error(`requiredIf references missing vocabulary: "${vocabularyKey}"`);

  const value = (values[fieldName] ?? "").trim();
  if (operator === "in") return vocabulary.includes(value);

  if (value.length === 0) return false;
  const folded = fold(value);
  const contains = vocabulary.some((entry) => folded.includes(fold(entry)));
  return operator === "matches" ? contains : !contains;
}

function isFieldRequired(
  catalog: FieldCatalog,
  field: FieldSpec,
  values: Record<string, string>,
): boolean {
  if (field.required) return true;
  if (field.requiredIf) return isConditionMet(catalog, field.requiredIf, values);
  return false;
}

export function evaluateGate(catalog: FieldCatalog, record: IntakeRecord): GateResult {
  const variant = getVariant(catalog, record.variant);
  const fields = variant.fields;
  const questionCount = record.questionCount ?? {};
  const explicitlyMissing = new Set(record.explicitlyMissing ?? []);

  const effectiveValues: Record<string, string> = { ...record.values };
  const exhaustedFields: string[] = [];
  const openQuestions: string[] = [];

  const verdicts: FieldVerdict[] = [];
  const invalid: string[] = [];
  const invalidSet = new Set<string>();

  if (catalog.enforceValueRules) {
    for (const [name, val] of Object.entries(record.values)) {
      const verdict = validateValue(catalog, fields[name] ?? name, val, record.variant);
      verdicts.push(verdict);
      if (!verdict.valid) {
        invalid.push(name);
        invalidSet.add(name);
      } else if (verdict.normalized !== undefined) {
        effectiveValues[name] = verdict.normalized;
      }
    }
  }

  // A budget group lets several related fields share one combined retry allowance,
  // so the agent stops circling a topic instead of exhausting each field in turn.
  const spentGroups = new Set<string>();
  for (const group of variant.budgetGroups ?? []) {
    const spent = group.countFields.reduce((sum, name) => sum + (questionCount[name] ?? 0), 0);
    if (spent >= group.max) for (const name of group.exhaustFields) spentGroups.add(name);
  }

  /** Field is settled: nothing more will be learned about it this conversation. */
  const finalized = new Set<string>();
  /** Field has a usable value, either captured or defaulted. */
  const resolved = new Set<string>();

  for (const [name, field] of Object.entries(fields)) {
    if (hasValidValue(record, name, invalidSet)) {
      finalized.add(name);
      resolved.add(name);
      continue;
    }

    if (!field.canAsk) {
      finalized.add(name);
      // A system-filled required field counts as resolved; the caller supplies it.
      if (field.required) resolved.add(name);
      continue;
    }

    const budgetSpent = (questionCount[name] ?? 0) >= retryBudget(catalog, field);
    if (budgetSpent || explicitlyMissing.has(name) || spentGroups.has(name)) {
      // Settled either way: the gate stops asking, so the conversation can
      // finish. Resolved only if giving up left a usable value behind — a field
      // with no declared default is settled *and still empty*, which is what
      // `status` and the recap's open-question list are there to report.
      finalized.add(name);
      exhaustedFields.push(name);
      if (field.exhaustedDefault) {
        effectiveValues[name] = field.exhaustedDefault;
        resolved.add(name);
      }
    }
  }

  const oneOf = variant.oneOf;
  const missingRequired: string[] = [];
  const missingRecommended: string[] = [];

  // A oneOf field, once picked, is asked in its own declared position rather
  // than tacked onto the end — a field's place in the catalog is meant to say
  // when it comes up in conversation, and that shouldn't change just because
  // it happens to belong to an "at least one of these" group.
  let oneOfSatisfied = true;
  let oneOfPick: string | null = null;
  if (oneOf && oneOf.length > 0) {
    oneOfSatisfied = oneOf.some((name) => resolved.has(name));
    if (!oneOfSatisfied) {
      const stillAskable = oneOf.filter((name) => !finalized.has(name));
      if (stillAskable.length > 0) {
        oneOfPick = stillAskable[0];
      } else {
        const labels = oneOf.map((name) => fields[name]?.label ?? name);
        openQuestions.push(`Chưa có ${labels.join(", ")}`);
      }
    }
  }

  for (const [name, field] of Object.entries(fields)) {
    if (finalized.has(name)) continue;
    if (oneOf?.includes(name)) {
      if (name === oneOfPick) missingRequired.push(name);
      continue;
    }
    if (isFieldRequired(catalog, field, effectiveValues)) {
      missingRequired.push(name);
    } else if (field.askOptional && field.canAsk) {
      missingRecommended.push(name);
    }
  }

  const isComplete = missingRequired.length === 0;
  const isFullyResolved =
    isComplete &&
    oneOfSatisfied &&
    Object.entries(fields).every(
      ([name, field]) => !isFieldRequired(catalog, field, effectiveValues) || resolved.has(name),
    );

  const fieldsToAsk = missingRequired.slice(0, catalog.maxQuestionsPerTurn);

  return {
    isComplete,
    isFullyResolved,
    status: isFullyResolved ? variant.status.complete : variant.status.incomplete,
    missingRequired,
    missingRecommended,
    exhaustedFields,
    fieldsToAsk,
    questionText: composeQuestion(catalog, record, fieldsToAsk),
    openQuestions,
    effectiveValues,
    verdicts,
    invalid,
  };
}

/**
 * Renders the question for this turn, escalating to a follow-up phrasing when a
 * field has already been asked about.
 *
 * `withOptions` tắt phần liệt kê lựa chọn bằng chữ. Kênh nào đã vẽ được nút thì
 * gọi với `false`: in lại danh sách bên cạnh hàng nút là thừa, và người dùng đã
 * báo đúng chỗ này. Mặc định `true` để giữ nguyên hành vi cho kênh không có nút.
 */
export function composeQuestion(
  catalog: FieldCatalog,
  record: IntakeRecord,
  fieldsToAsk: string[],
  { withOptions = true }: { withOptions?: boolean } = {},
): string {
  if (fieldsToAsk.length === 0) return "";
  const variant = getVariant(catalog, record.variant);
  const questionCount = record.questionCount ?? {};

  return fieldsToAsk
    .map((name) => {
      const field = variant.fields[name];
      if (!field) return "";
      const asked = questionCount[name] ?? 0;
      const prompt =
        asked === 0
          ? (field.prompt ?? "")
          : (field.followUpPrompts?.[asked - 1] ?? field.prompt ?? "");
      if (!prompt) return "";
      return withOptions ? prompt + renderOptions(catalog, field) : prompt;
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

function renderOptions(catalog: FieldCatalog, field: FieldSpec): string {
  const vocabulary = getVocabulary(catalog, field);
  if (!vocabulary || vocabulary.length === 0) return "";
  return field.isMultiValue
    ? `\n(có thể chọn một hoặc nhiều: ${vocabulary.join(" · ")})`
    : `\n(chọn một: ${vocabulary.join(" · ")})`;
}
