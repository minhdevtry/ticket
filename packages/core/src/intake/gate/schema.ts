/**
 * Derives the agent-facing tool schema from the catalog.
 *
 * Previously each tool restated all eighteen fields by hand, twice, and adding a
 * field to the lookup table meant editing three places. The catalog is the one
 * source now; the schema is generated from it.
 */
import { z } from "zod";
import { getVocabulary } from "./catalog";
import type { FieldCatalog, FieldSpec } from "./types";

function describe(field: FieldSpec, vocabulary: string[] | null): string {
  const label = field.label ?? field.name;
  if (!vocabulary || vocabulary.length === 0) return label;
  const list = vocabulary.join(", ");
  return field.isMultiValue
    ? `${label} — chọn một hoặc nhiều: ${list}`
    : `${label} — chọn một: ${list}`;
}

/**
 * Every field the agent may fill, across all variants. Variants differ in which
 * fields they require, not in what the agent is allowed to report, so a single
 * flat schema keeps the tool call simple.
 */
export function collectFillableFields(catalog: FieldCatalog): Record<string, FieldSpec> {
  const out: Record<string, FieldSpec> = {};
  for (const variant of Object.values(catalog.variants)) {
    for (const [name, field] of Object.entries(variant.fields)) {
      if (!field.canAsk && !field.inferFromContext) continue;
      // Prefer the definition carrying a label, so the description is useful.
      if (!out[name] || (!out[name].label && field.label)) out[name] = field;
    }
  }
  return out;
}

export interface FieldSchemaOptions {
  /** Description for the variant selector. */
  variantDescription?: string;
}

/**
 * Builds the shape used by intake tools. Callers merge in their own keys
 * (`chatId`, `userConfirmed`, …) before handing it to `createTool`.
 */
export function buildFieldSchema(catalog: FieldCatalog, options: FieldSchemaOptions = {}) {
  const variantKeys = Object.keys(catalog.variants);
  const variantLabels = variantKeys.map((key) => `${key}=${catalog.variants[key].name}`).join(", ");

  const shape: Record<string, z.ZodTypeAny> = {
    variant: z
      .enum(variantKeys as [string, ...string[]])
      .default(variantKeys[0])
      .describe(options.variantDescription ?? `Nhánh tiếp nhận: ${variantLabels}`),
  };

  for (const [name, field] of Object.entries(collectFillableFields(catalog))) {
    shape[name] = z
      .string()
      .optional()
      .describe(describe(field, getVocabulary(catalog, field)));
  }

  // What the user just told us they cannot answer. This is an observation about
  // *this* turn, so the model reports it; the running total is accumulated by
  // the tool in working memory rather than echoed back each time.
  shape.cannotAnswer = z
    .array(z.string())
    .optional()
    .describe("Tên các trường người dùng vừa nói rõ là không có / không biết");

  return shape;
}

/** Pulls what the model reported out of a validated tool input. */
export function readRecordFromInput(
  catalog: FieldCatalog,
  input: Record<string, unknown>,
): {
  variant: string;
  rawValues: Record<string, unknown>;
  cannotAnswer: string[];
  askedCount?: Record<string, number>;
} {
  const variantKeys = Object.keys(catalog.variants);
  const variant =
    typeof input.variant === "string" && catalog.variants[input.variant]
      ? input.variant
      : variantKeys[0];

  const fillable = collectFillableFields(catalog);
  const rawValues: Record<string, unknown> = {};
  for (const name of Object.keys(fillable)) {
    if (input[name] !== undefined) rawValues[name] = input[name];
  }
  const askedCount =
    input.askedCount && typeof input.askedCount === "object"
      ? (input.askedCount as Record<string, number>)
      : undefined;

  return {
    variant,
    rawValues,
    cannotAnswer: (input.cannotAnswer as string[]) ?? [],
    ...(askedCount ? { askedCount } : {}),
  };
}

/**
 * Shape of the intake state carried between turns in working memory.
 *
 * This replaces `questionCount` and `explicitlyMissing` as tool inputs. The
 * model used to have to echo both back on every call; if it dropped
 * `questionCount`, the retry budget reset and the bot could ask the same
 * question forever. Persisting it beside the thread removes that failure mode
 * and shrinks what the model is responsible for to just "what did the user say".
 */
export function buildWorkingMemorySchema(catalog: FieldCatalog) {
  const variantKeys = Object.keys(catalog.variants);
  return z.object({
    variant: z
      .enum(variantKeys as [string, ...string[]])
      .optional()
      .describe("Nhánh tiếp nhận đang theo"),
    captured: z
      .record(z.string(), z.string())
      .optional()
      .describe("Các trường đã thu thập được, tên trường -> giá trị"),
    askedCount: z.record(z.string(), z.number()).optional().describe("Số lần đã hỏi từng trường"),
    cannotAnswer: z
      .array(z.string())
      .optional()
      .describe("Các trường người dùng đã nói rõ là không có thông tin"),
  });
}

export type IntakeStateRecord = z.infer<ReturnType<typeof buildWorkingMemorySchema>>;
