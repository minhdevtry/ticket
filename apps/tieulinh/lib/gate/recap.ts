/**
 * Builds the summary shown back to the user before anything is recorded.
 *
 * Recap is the only place captured values are read back, so it honours the
 * catalog's blocklist: internal fields never appear here.
 */
import { getVariant } from "./catalog";
import type { FieldCatalog, GateResult, IntakeRecord } from "./types";

export interface RecapOptions {
  /** Values the app derives rather than captures, e.g. the branch name. */
  derived?: Record<string, string>;
  /** Heading for the trailing list of unanswered questions. */
  openQuestionsHeading?: string;
}

export function buildRecap(
  catalog: FieldCatalog,
  record: IntakeRecord,
  gate: GateResult,
  options: RecapOptions = {},
): string {
  const variant = getVariant(catalog, record.variant);
  const blocked = new Set(catalog.recapBlocklist);
  const derived = options.derived ?? {};
  const lines: string[] = [];

  for (const fieldName of variant.recapFields) {
    if (blocked.has(fieldName)) continue;

    const value = derived[fieldName] ?? gate.effectiveValues[fieldName] ?? "";
    if (value.trim().length === 0) continue;

    const label = catalog.autoLabels[fieldName] ?? variant.fields[fieldName]?.label ?? fieldName;
    lines.push(`- ${label}: ${value}`);
  }

  if (gate.openQuestions.length > 0) {
    lines.push("");
    lines.push(options.openQuestionsHeading ?? "Còn thiếu, ghi lại để hỏi sau:");
    for (const question of gate.openQuestions) lines.push(`- ${question}`);
  }

  return lines.join("\n");
}
