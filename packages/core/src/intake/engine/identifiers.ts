/**
 * Identifier grounding (ticket 09) — pure helpers for the identifier-conflict
 * park (TECH-928). Carried verbatim-in-behaviour from intake
 * `lib/identifier-grounding.ts`, kept channel/tracker free.
 *
 * The engine never fabricates an identifier and never silently merges two
 * incidents whose identifiers disagree: a message carrying a conflicting
 * phone/student/order id parks and asks "new incident or append?" rather than
 * overwriting the draft (TECH-928: incident B merged into A's draft, B lost).
 */
import type { IdentifierKey } from "../ports";

/** Collapse to the digit run so spacing/dots/dashes don't matter. */
export function normalizeDigits(value: string): string {
  return value.replace(/\D+/g, "");
}

/**
 * Two values of the SAME identifier kind conflict when both carry digits and
 * neither digit-run contains the other — a shortened phone or an added area
 * code is still the same number; genuinely different digits mean a different
 * incident/person (TECH-928).
 */
export function identifiersConflict(existingValue: string, incomingValue: string): boolean {
  const a = normalizeDigits(existingValue);
  const b = normalizeDigits(incomingValue);
  if (!a || !b || a === b) return false;
  return !a.includes(b) && !b.includes(a);
}

/**
 * Does any identifier field the incoming turn carries conflict with the same
 * field already captured in the draft? Returns the first conflicting key, or
 * null. This is the TECH-928 gate.
 */
export function findIdentifierConflict(
  existing: Partial<Record<IdentifierKey, string>>,
  incoming: Partial<Record<IdentifierKey, string>>,
): IdentifierKey | null {
  for (const key of Object.keys(incoming) as IdentifierKey[]) {
    const was = existing[key];
    const now = incoming[key];
    if (was && now && identifiersConflict(was, now)) return key;
  }
  return null;
}
