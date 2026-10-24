/**
 * Value validation: checks captured field values against catalog rules
 * (enum vocabularies, regex patterns, and semantic constraints).
 *
 * Pure. No I/O, no clock, no side effects.
 */
import { getVocabulary } from "./catalog";
import { fold, normalizeValue } from "./normalize";
import type { FieldCatalog, FieldSpec, FieldVerdict } from "./types";

export function validateValue(
  catalog: FieldCatalog,
  field: FieldSpec | string,
  raw: unknown,
  variantKey?: string,
): FieldVerdict {
  const rawStr = raw === null || raw === undefined ? "" : String(raw);
  const fieldName = typeof field === "string" ? field : field.name;

  let fieldSpec: FieldSpec | undefined;
  if (typeof field === "object") {
    fieldSpec = field;
  } else {
    if (variantKey && catalog.variants[variantKey]?.fields[field]) {
      fieldSpec = catalog.variants[variantKey].fields[field];
    } else {
      for (const variant of Object.values(catalog.variants)) {
        if (variant.fields[field]) {
          fieldSpec = variant.fields[field];
          break;
        }
      }
    }
  }

  if (!fieldSpec) {
    return { field: fieldName, value: rawStr, valid: true, reason: "Không có luật cho trường này" };
  }

  const hasRule =
    fieldSpec.type.startsWith("enum:") ||
    Boolean(fieldSpec.pattern) ||
    Boolean(fieldSpec.semantic);

  if (!hasRule) {
    return { field: fieldName, value: rawStr, valid: true, reason: "Không có luật cho trường này" };
  }

  const trimmed = rawStr.trim();
  if (!trimmed) {
    return { field: fieldName, value: rawStr, valid: false, reason: "Để trống" };
  }

  // 1. Enum
  if (fieldSpec.type.startsWith("enum:")) {
    const allowed = getVocabulary(catalog, fieldSpec) ?? [];
    const hit = normalizeValue(catalog, fieldSpec, trimmed);
    return hit !== null
      ? { field: fieldName, value: rawStr, valid: true, normalized: hit }
      : {
          field: fieldName,
          value: rawStr,
          valid: false,
          reason: "Không nằm trong danh sách cho phép",
          allowedValues: allowed,
        };
  }

  // 2. Regex
  if (fieldSpec.pattern) {
    return new RegExp(fieldSpec.pattern).test(trimmed)
      ? { field: fieldName, value: rawStr, valid: true, normalized: trimmed }
      : {
          field: fieldName,
          value: rawStr,
          valid: false,
          reason: "Sai định dạng",
          expectedPattern: fieldSpec.pattern,
        };
  }

  // 3. Semantic
  if (fieldSpec.semantic) {
    if ((fieldSpec.semantic.blacklist ?? []).some((bad) => fold(bad) === fold(trimmed))) {
      return { field: fieldName, value: rawStr, valid: false, reason: "Giá trị rác, không mang thông tin" };
    }
    if (
      fieldSpec.semantic.whitelistPattern &&
      !new RegExp(fieldSpec.semantic.whitelistPattern, "i").test(trimmed)
    ) {
      return {
        field: fieldName,
        value: rawStr,
        valid: false,
        reason: "Không nhận ra giá trị này",
        expectedPattern: fieldSpec.semantic.whitelistPattern,
      };
    }
    return { field: fieldName, value: rawStr, valid: true, normalized: trimmed };
  }

  return { field: fieldName, value: rawStr, valid: true, normalized: trimmed };
}
