/**
 * Generic adapter converting legacy-style validation rules, required fields table,
 * and options into a unified FieldCatalog.
 *
 * Pure. No I/O, no disk reads, no app-specific data hardcoded.
 */
import { assertCatalogIntegrity } from "./catalog";
import type { FieldCatalog, FieldSpec, VariantKey, VariantSpec } from "./types";

export type ValidationRule =
  | { type: "regex"; pattern: string; description?: string }
  | { type: "enum"; values: string[]; description?: string }
  | {
      type: "semantic";
      blacklist?: string[];
      whitelist_pattern?: string;
      whitelistPattern?: string;
      description?: string;
    };

export type ValidationRules = Record<string, ValidationRule | string>;

export interface FieldRequirementsTable {
  [key: string]: {
    bat_buoc?: string[];
    nen_hoi?: string[];
  };
}

export interface CatalogFromValidationRulesOptions {
  labels?: Record<string, string>;
  promptBuilder?: (fieldName: string, label: string) => string;
  /** Display name for a variant (and its `+account` pair); defaults to the raw key. */
  variantName?: (variantKey: string, isAccountPair: boolean) => string;
  nonPromptFields?: Set<string> | string[];
  exhaustedDefaults?: Record<string, string>;
  synonyms?: Record<string, string[]>;
  pairedVariantField?: string;
  maxRetries?: number;
  maxQuestionsPerTurn?: number;
  enforceValueRules?: boolean;
}

export function catalogFromValidationRules(
  rules: ValidationRules,
  fieldRequirements?: FieldRequirementsTable,
  optionsOrMapping?: CatalogFromValidationRulesOptions | Record<string, unknown>,
): FieldCatalog {
  const options: CatalogFromValidationRulesOptions =
    optionsOrMapping &&
    ("labels" in optionsOrMapping ||
      "promptBuilder" in optionsOrMapping ||
      "variantName" in optionsOrMapping ||
      "nonPromptFields" in optionsOrMapping ||
      "exhaustedDefaults" in optionsOrMapping ||
      "synonyms" in optionsOrMapping ||
      "enforceValueRules" in optionsOrMapping ||
      "pairedVariantField" in optionsOrMapping ||
      "maxRetries" in optionsOrMapping ||
      "maxQuestionsPerTurn" in optionsOrMapping)
      ? (optionsOrMapping as CatalogFromValidationRulesOptions)
      : {};

  const labels = options.labels ?? {};
  const promptBuilder = options.promptBuilder;
  const nonPromptSet = new Set<string>(
    Array.isArray(options.nonPromptFields)
      ? options.nonPromptFields
      : options.nonPromptFields instanceof Set
        ? Array.from(options.nonPromptFields)
        : [],
  );
  const exhaustedDefaults = options.exhaustedDefaults ?? {};

  // 1. Collect enums
  const enums: Record<string, string[]> = {};
  for (const [name, rule] of Object.entries(rules)) {
    if (typeof rule === "object" && rule.type === "enum" && Array.isArray(rule.values)) {
      enums[name] = rule.values;
    }
  }

  // 2. Identify all known field names across rules, labels, and requirements
  const allFieldNames = new Set<string>([
    ...Object.keys(rules).filter((k) => !k.startsWith("_")),
    ...Object.keys(labels),
  ]);

  if (fieldRequirements) {
    for (const req of Object.values(fieldRequirements)) {
      for (const f of req.bat_buoc ?? []) allFieldNames.add(f);
      for (const f of req.nen_hoi ?? []) allFieldNames.add(f);
    }
  }

  // 3. Build fields helper
  const buildFieldsForVariant = (
    batBuocList: string[],
    nenHoiList: string[],
    extraRequiredList: string[] = [],
  ): Record<string, FieldSpec> => {
    const batBuocSet = new Set([...batBuocList, ...extraRequiredList]);
    const nenHoiSet = new Set(nenHoiList.filter((f) => !batBuocSet.has(f)));

    const orderedFieldNames: string[] = [];
    const seen = new Set<string>();
    for (const f of [...batBuocList, ...extraRequiredList, ...nenHoiList, ...allFieldNames]) {
      if (!seen.has(f)) {
        seen.add(f);
        orderedFieldNames.push(f);
      }
    }

    const fields: Record<string, FieldSpec> = {};
    for (const name of orderedFieldNames) {
      const rule = rules[name];
      const isEnum = typeof rule === "object" && rule.type === "enum";
      const isRegex = typeof rule === "object" && rule.type === "regex";
      const isSemantic = typeof rule === "object" && rule.type === "semantic";

      const canAsk = !nonPromptSet.has(name);
      const isRequired = batBuocSet.has(name);
      const isAskOptional = nenHoiSet.has(name);
      const label = labels[name] ?? name;
      const prompt = promptBuilder ? promptBuilder(name, label) : label;

      fields[name] = {
        name,
        required: isRequired,
        type: isEnum ? `enum:${name}` : "text",
        canAsk,
        askOptional: isAskOptional,
        label,
        prompt,
        followUpPrompts: canAsk ? [prompt] : undefined,
        exhaustedDefault: exhaustedDefaults[name],
        isMultiValue: false,
        inferFromContext: false,
        pattern: isRegex ? rule.pattern : undefined,
        semantic: isSemantic
          ? {
              blacklist: rule.blacklist,
              whitelistPattern: rule.whitelist_pattern ?? rule.whitelistPattern,
              description: rule.description,
            }
          : undefined,
      };
    }
    return fields;
  };

  // 4. Build variants
  const variantKeys = fieldRequirements ? Object.keys(fieldRequirements) : ["default"];
  if (!variantKeys.includes("default")) {
    variantKeys.push("default");
  }

  const variants: Record<VariantKey, VariantSpec> = {};
  const pairedField = options.pairedVariantField ?? "student_account";

  for (const vKey of variantKeys) {
    const req = fieldRequirements?.[vKey] ?? { bat_buoc: [], nen_hoi: [] };
    const batBuocList = req.bat_buoc ?? [];
    const nenHoiList = req.nen_hoi ?? [];

    variants[vKey] = {
      key: vKey,
      name: options.variantName ? options.variantName(vKey, false) : vKey,
      fields: buildFieldsForVariant(batBuocList, nenHoiList),
      recapFields: [],
      status: {
        complete: "Qualified",
        incomplete: "Need Clarification",
      },
    };

    if (pairedField) {
      const accountVariantKey = `${vKey}+account`;
      variants[accountVariantKey] = {
        key: accountVariantKey,
        name: options.variantName ? options.variantName(vKey, true) : `${vKey}+account`,
        fields: buildFieldsForVariant(batBuocList, nenHoiList, [pairedField]),
        recapFields: [],
        status: {
          complete: "Qualified",
          incomplete: "Need Clarification",
        },
      };
    }
  }

  const catalog: FieldCatalog = {
    maxRetries: options.maxRetries ?? 2,
    maxQuestionsPerTurn: options.maxQuestionsPerTurn ?? 1,
    variants,
    enums,
    autoLabels: {},
    recapBlocklist: [],
    icons: {},
    buttonLabels: {},
    synonyms: options.synonyms ?? {},
    enforceValueRules: options.enforceValueRules ?? true,
  };

  assertCatalogIntegrity(catalog);
  return catalog;
}
