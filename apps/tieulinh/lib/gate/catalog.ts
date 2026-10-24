/**
 * Normalizes an authored lookup table into a `FieldCatalog`.
 *
 * The authored JSON stays in the language the business writes it in
 * (`bat_buoc`, `duoc_hoi`, `hoi_lai`, …). Translation happens once, here, so
 * every consumer downstream reads one typed shape.
 *
 * The raw table is passed in as data rather than read from disk. That keeps the
 * gate pure, makes it trivially testable, and lets apps `import` their JSON so
 * it survives `bun build --compile`.
 */
import { MAX_CALLBACK_DATA_BYTES, REQUIRED_IF_RULE } from "./types";
import type { FieldCatalog, FieldSpec, VariantKey, VariantSpec } from "./types";

/** Shape of the authored JSON. Deliberately loose — validation happens on normalize. */
export interface RawFieldTable {
  /** Bật soi giá trị (enum / regex / semantic). Mặc định tắt — xem `FieldCatalog.enforceValueRules`. */
  _soi_gia_tri?: boolean;
  _toi_da_hoi_lai?: number;
  _toi_da_truong_moi_luot?: number;
  _nhan_tu_sinh?: Record<string, string>;
  chung?: Record<string, RawField>;
  nhanh?: Record<string, RawVariant>;
  cam_in_trong_recap?: { truong?: string[] };
  [key: string]: unknown;
}

export interface RawField {
  bat_buoc?: boolean;
  bat_buoc_neu?: string;
  nen_hoi?: boolean;
  kieu?: string;
  duoc_hoi?: boolean;
  nhan?: string;
  hoi?: string;
  hoi_lai?: string[];
  het_luot?: string;
  suy_duoc_tu_boi_canh?: boolean;
  nhieu_gia_tri?: boolean;
  dinh_dang?: string;
  mau?: string;
  pattern?: string;
  ngu_nghia?: { chan?: string[]; mau_nhan_dien?: string; mo_ta?: string; blacklist?: string[]; whitelist_pattern?: string; whitelistPattern?: string };
  semantic?: { chan?: string[]; mau_nhan_dien?: string; mo_ta?: string; blacklist?: string[]; whitelist_pattern?: string; whitelistPattern?: string };
  [key: string]: unknown;
}

export interface RawVariant {
  ten?: string;
  truong?: Record<string, RawField>;
  recap?: string[];
  truong_mo_dau?: string;
  mot_trong?: { truong?: string[] };
  nhom_ngan_sach_hoi?: Array<{ dem: string[]; het?: string[]; toi_da: number }>;
  [key: string]: unknown;
}

export interface RawEnumTable {
  trang_thai?: Record<string, { du?: string; thieu?: string }>;
  loai_dau_ra?: Record<string, string>;
  [key: string]: unknown;
}

export interface CatalogInput {
  fields: RawFieldTable;
  enums?: RawEnumTable;
  icons?: Record<string, unknown>;
  /** Enum value -> alternative spellings that should normalize to it. */
  synonyms?: Record<string, unknown>;
}

const DEFAULT_MAX_RETRIES = 2;

function normalizeField(name: string, raw: RawField): FieldSpec {
  const pattern = (raw.dinh_dang ?? raw.mau ?? raw.pattern) as string | undefined;
  const rawSemantic = (raw.ngu_nghia ?? raw.semantic) as any;
  const semantic = rawSemantic
    ? {
        blacklist: rawSemantic.chan ?? rawSemantic.blacklist,
        whitelistPattern:
          rawSemantic.mau_nhan_dien ??
          rawSemantic.whitelist_pattern ??
          rawSemantic.whitelistPattern,
        description: rawSemantic.mo_ta ?? rawSemantic.description,
      }
    : undefined;

  return {
    name,
    required: raw.bat_buoc === true,
    requiredIf: raw.bat_buoc_neu,
    type: raw.kieu ?? "text",
    canAsk: raw.duoc_hoi !== false,
    askOptional: raw.nen_hoi === true,
    label: raw.nhan,
    prompt: raw.hoi,
    followUpPrompts: Array.isArray(raw.hoi_lai) ? raw.hoi_lai : undefined,
    exhaustedDefault: raw.het_luot,
    isMultiValue: raw.nhieu_gia_tri === true,
    inferFromContext: raw.suy_duoc_tu_boi_canh === true,
    pattern,
    semantic,
  };
}

/**
 * Collects the closed vocabularies from the enum table. Any top-level array is
 * treated as a vocabulary; the structured `trang_thai` / `loai_dau_ra` keys are
 * consumed separately by variant normalization.
 */
function collectEnums(enums: RawEnumTable | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(enums ?? {})) {
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      out[key] = value as string[];
    }
  }
  return out;
}

export function createCatalog(input: CatalogInput): FieldCatalog {
  const { fields: rawFields, enums: rawEnums } = input;
  const sharedFields = rawFields.chung ?? {};
  const rawVariants = rawFields.nhanh ?? {};

  if (Object.keys(rawVariants).length === 0) {
    throw new Error("Field catalog declares no variants under `nhanh`");
  }

  const variants: Record<VariantKey, VariantSpec> = {};

  for (const [key, rawVariant] of Object.entries(rawVariants)) {
    const merged = { ...sharedFields, ...(rawVariant.truong ?? {}) };
    const specFields: Record<string, FieldSpec> = {};
    for (const [fieldName, rawField] of Object.entries(merged)) {
      specFields[fieldName] = normalizeField(fieldName, rawField);
    }

    const statusPair = rawEnums?.trang_thai?.[key];
    variants[key] = {
      key,
      name: rawVariant.ten ?? `Nhánh ${key}`,
      fields: specFields,
      openingField: rawVariant.truong_mo_dau,
      recapFields: Array.isArray(rawVariant.recap) ? rawVariant.recap : [],
      oneOf: rawVariant.mot_trong?.truong,
      budgetGroups: rawVariant.nhom_ngan_sach_hoi?.map((g) => ({
        countFields: g.dem,
        exhaustFields: g.het ?? g.dem,
        max: g.toi_da,
      })),
      status: {
        complete: statusPair?.du ?? "Qualified",
        incomplete: statusPair?.thieu ?? "Need Clarification",
      },
      outputType: rawEnums?.loai_dau_ra?.[key],
    };
  }

  const buttonLabels = pickStringValues(
    (rawEnums as Record<string, unknown> | undefined)?._nhan_nut as Record<string, unknown> | undefined,
  );

  // Authored files carry `_comment` keys alongside the data; keep only the lists.
  const synonyms: Record<string, string[]> = Object.fromEntries(
    Object.entries(input.synonyms ?? {}).filter((entry): entry is [string, string[]] =>
      Array.isArray(entry[1]),
    ),
  );
  // Người bấm nút gửi về NHÃN NÚT, không phải giá trị chuẩn. Đăng ký nhãn thành
  // synonym ngay tại đây thay vì bắt người soạn chép tay sang `synonyms.json` —
  // chép tay là chỗ hai file lệch nhau rồi hỏng âm thầm.
  for (const [canonical, label] of Object.entries(buttonLabels)) {
    const existing = synonyms[canonical] ?? [];
    if (!existing.includes(label)) synonyms[canonical] = [...existing, label];
  }

  const catalog: FieldCatalog = {
    maxRetries: rawFields._toi_da_hoi_lai ?? DEFAULT_MAX_RETRIES,
    maxQuestionsPerTurn: rawFields._toi_da_truong_moi_luot ?? 1,
    variants,
    enums: collectEnums(rawEnums),
    autoLabels: rawFields._nhan_tu_sinh ?? {},
    recapBlocklist: rawFields.cam_in_trong_recap?.truong ?? [],
    icons: pickStringValues(input.icons),
    // Catalog soạn tay mặc định giữ hành vi cũ: có giá trị là đủ. Muốn soi giá
    // trị thì khai `_soi_gia_tri: true` trong bảng trường.
    enforceValueRules: rawFields._soi_gia_tri === true,
    buttonLabels,
    // Authored files carry `_comment` keys alongside the data; keep only the lists.
    synonyms,
  };

  assertCatalogIntegrity(catalog);
  return catalog;
}

/**
 * Fails fast on the mistakes that are otherwise only discovered mid-conversation:
 * a field pointing at a vocabulary that does not exist, or a conditional rule
 * referencing a missing enum.
 */
export function assertCatalogIntegrity(catalog: FieldCatalog): void {
  const problems: string[] = [];

  for (const variant of Object.values(catalog.variants)) {
    for (const field of Object.values(variant.fields)) {
      if (field.type.startsWith("enum:")) {
        const enumKey = field.type.slice("enum:".length);
        if (!catalog.enums[enumKey]) {
          problems.push(`${variant.key}.${field.name}: type "enum:${enumKey}" but no such vocabulary`);
        }
      }
      if (field.requiredIf) {
        const match = REQUIRED_IF_RULE.exec(field.requiredIf.trim());
        if (!match) {
          problems.push(`${variant.key}.${field.name}: cannot parse requiredIf "${field.requiredIf}"`);
        } else if (!catalog.enums[match[3]]) {
          problems.push(`${variant.key}.${field.name}: requiredIf references missing vocabulary "${match[3]}"`);
        }
      }
      if (field.pattern) {
        try {
          new RegExp(field.pattern);
        } catch (err: any) {
          problems.push(`${variant.key}.${field.name}: invalid regex pattern "${field.pattern}": ${err.message}`);
        }
      }
      if (field.semantic?.whitelistPattern) {
        try {
          new RegExp(field.semantic.whitelistPattern);
        } catch (err: any) {
          problems.push(`${variant.key}.${field.name}: invalid whitelist pattern "${field.semantic.whitelistPattern}": ${err.message}`);
        }
      }
    }
    for (const field of Object.values(variant.fields)) {
      if (!field.type.startsWith("enum:")) continue;
      for (const value of catalog.enums[field.type.slice("enum:".length)] ?? []) {
        const callbackData = catalog.buttonLabels[value] ?? value;
        const bytes = Buffer.byteLength(callbackData, "utf8");
        if (bytes > MAX_CALLBACK_DATA_BYTES) {
          problems.push(
            `${variant.key}.${field.name}: giá trị ${JSON.stringify(value)} thành callback_data dài ` +
              `${bytes} byte, quá trần ${MAX_CALLBACK_DATA_BYTES} — Telegram sẽ từ chối CẢ tin nhắn ` +
              `(400 BUTTON_DATA_INVALID). Khai nhãn ngắn cho nó trong \`_nhan_nut\`.`,
          );
        }
      }
    }
    for (const name of variant.recapFields) {
      if (!variant.fields[name] && !catalog.autoLabels[name]) {
        problems.push(`${variant.key}: recap lists "${name}" which is neither a field nor an auto label`);
      }
    }
    for (const name of variant.oneOf ?? []) {
      if (!variant.fields[name]) {
        problems.push(`${variant.key}: oneOf lists unknown field "${name}"`);
      }
    }
    for (const group of variant.budgetGroups ?? []) {
      for (const name of [...group.countFields, ...group.exhaustFields]) {
        if (!variant.fields[name]) {
          problems.push(`${variant.key}: budget group lists unknown field "${name}"`);
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Field catalog is inconsistent:\n  - ${problems.join("\n  - ")}`);
  }
}

function pickStringValues(source: Record<string, unknown> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export function getVariant(catalog: FieldCatalog, key: VariantKey): VariantSpec {
  const variant = catalog.variants[key];
  if (!variant) {
    const known = Object.keys(catalog.variants).join(", ");
    throw new Error(`Unknown variant "${key}". Catalog declares: ${known}`);
  }
  return variant;
}

export function getVocabulary(catalog: FieldCatalog, field: FieldSpec): string[] | null {
  if (!field.type.startsWith("enum:")) return null;
  return catalog.enums[field.type.slice("enum:".length)] ?? null;
}

export function retryBudget(catalog: FieldCatalog, field: FieldSpec): number {
  return 1 + (field.followUpPrompts?.length ?? 0);
}
