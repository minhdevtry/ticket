/**
 * Snaps free-text answers onto the catalog's closed vocabularies.
 *
 * People type "bên CS", "cs", "chăm sóc khách hàng" for one enum value. The
 * mapping from those spellings to the canonical value is domain knowledge, so
 * it lives in the catalog's `synonyms` table rather than in this code.
 */
import { getVocabulary } from "./catalog";
import type { FieldCatalog, FieldSpec } from "./types";

/** Leading words people attach to an organizational unit that carry no meaning. */
const UNIT_PREFIX = /^(bên|đội|team|phòng|khối|nhóm)\s+/i;

/** Separators people use when naming several values at once. */
const MULTI_VALUE_SPLIT = /\s*[,;·/+]\s*|\s+(?:và|với|cùng)\s+/i;

export const fold = (s: string): string =>
  s.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");

function matchOne(catalog: FieldCatalog, allowed: string[], raw: string): string | null {
  const value = fold(raw);
  if (!value) return null;

  const exact = allowed.find((option) => fold(option) === value);
  if (exact) return exact;

  const stripped = fold(value.replace(UNIT_PREFIX, ""));
  const strippedMatch = allowed.find((option) => fold(option) === stripped);
  if (strippedMatch) return strippedMatch;

  const needle = stripped;
  for (const [canonical, spellings] of Object.entries(catalog.synonyms)) {
    if (!allowed.includes(canonical)) continue;
    if (spellings.some((spelling) => needle === fold(spelling))) return canonical;
  }
  // Fall back to substring matching on synonyms, which catches "app vuihoc mới"
  // style answers without letting a bare "app" swallow every option.
  for (const [canonical, spellings] of Object.entries(catalog.synonyms)) {
    if (!allowed.includes(canonical)) continue;
    if (spellings.some((spelling) => spelling.length >= 3 && needle.includes(fold(spelling)))) {
      return canonical;
    }
  }
  return null;
}

/**
 * Returns the canonical value, or `null` when the answer does not belong to the
 * vocabulary — in which case the caller should ask again rather than record noise.
 * Free-text fields pass through unchanged.
 */
export function normalizeValue(
  catalog: FieldCatalog,
  field: FieldSpec,
  rawValue: string,
): string | null {
  const allowed = getVocabulary(catalog, field);
  if (!allowed) return rawValue;

  const trimmed = rawValue.trim();
  const single = matchOne(catalog, allowed, trimmed);
  if (single) return single;

  if (field.isMultiValue) {
    const parts = trimmed
      .split(MULTI_VALUE_SPLIT)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 1) {
      const mapped = parts.map((part) => matchOne(catalog, allowed, part));
      if (mapped.every((v): v is string => v !== null)) {
        return [...new Set(mapped)].join(", ");
      }
    }
  }
  return null;
}

/**
 * Normalizes a bag of raw answers against a variant, dropping anything that
 * fails to map onto its vocabulary.
 */
export function normalizeValues(
  catalog: FieldCatalog,
  fields: Record<string, FieldSpec>,
  raw: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== "string" || !value.trim()) continue;
    const field = fields[name];
    if (!field) continue;
    const normalized = normalizeValue(catalog, field, value.trim());
    if (normalized) out[name] = normalized;
  }
  return out;
}
