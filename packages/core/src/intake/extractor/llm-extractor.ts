/**
 * FieldExtractorPort implementation with Vietnamese heuristics, model fallback chain,
 * and post-LLM normalization (RFC 0002 §1.5 E1-E5, A14).
 *
 * Invariants:
 * - Pure heuristics when no LLM is configured (E3)
 * - Model fallback chain: tries fallback models on 5xx/network/429 (E5)
 * - LLM exhausted: drops fabricated titles, preserves description/symptoms (E5 / TECH-1146)
 * - Department only accepted when explicitly mentioned in text (E2)
 * - Phone numbers moved from customerId to studentAccount (E2)
 * - Invalid title (person name / id code) rejected & falls back to problem sentence (E2 / TECH-1146)
 * - Evidence compensation: explicit phrases override false default (E4)
 * - Explicit edit command wins over LLM (A14)
 */

import { parseJsonLoose } from "../../llm/extract";
import type {
  ExtractedFields,
  ExtractInput,
  FieldExtractorPort,
  IdentifierKey,
  UserIntent,
} from "../ports";
import {
  capText,
  deptMentioned,
  deriveFallbackTitle,
  detectSystem,
  detectUnrecognizedDept,
  EXPANDED_PROBLEM_WORDS,
  extractBlockInfo,
  inferEvidence,
  isChitchat,
  isDeclineAnswer,
  isExplicitCancel,
  isInvalidTitle,
  isShortConfirmation,
  isVietnamesePhone,
  normalizeWithSynonyms,
  parseEditCommand,
  PROBLEM_WORDS,
  stripGreeting,
} from "./heuristics";
import { describeExtractedKeys } from "./schema";
import {
  DEPT_SYNONYMS,
  MAX_LLM_CONTEXT_CHARS,
  MAX_LLM_MESSAGE_CHARS,
  SYSTEM_SYNONYMS,
  VALID_DEVICE_TYPES,
  VALID_ERROR_CATEGORIES,
  VALID_PRODUCTS,
  VALID_REPORTING_DEPTS,
  VALID_SYSTEMS,
} from "./taxonomy";

export interface LlmConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  api?: "openai" | "anthropic" | "openclaw";
}

export type CompleteFn = (
  config: LlmConfig,
  systemPrompt: string,
  userPrompt: string,
) => Promise<string>;

export interface ExtractorDomainConfig {
  products?: readonly string[];
  systems?: readonly string[];
  errorCategories?: readonly string[];
  reportingDepts?: readonly string[];
  deviceTypes?: readonly string[];
  systemSynonyms?: Record<string, string>;
  deptSynonyms?: Record<string, string>;
}

export interface FieldExtractorOptions {
  llmConfig?: LlmConfig;
  completeFn?: CompleteFn;
  domain?: ExtractorDomainConfig;
}

export function isLlmConfigured(config: LlmConfig | undefined): config is LlmConfig {
  if (!config?.model) return false;
  return config.api === "openclaw" ? true : Boolean(config.baseUrl);
}

const INTENTS: readonly UserIntent[] = [
  "report_issue",
  "provide_info",
  "confirm",
  "cancel",
  "chitchat",
];

const FOLLOW_UP_PREFIX =
  /^(?:bổ sung|thêm|à|à quên|quên|ngoài ra|cập nhật|update|thông tin thêm|gửi thêm)\b/iu;
const PHONE_RE = /(?:\+?84|0)[35789]\d{8}\b/;

function pickEnum<T extends string>(value: unknown, list: readonly T[]): T | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.trim().toLowerCase();
  if (!lower) return undefined;
  return list.find((v) => v.toLowerCase() === lower);
}

function pickString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null" || trimmed.toLowerCase() === "undefined") {
    return undefined;
  }
  return trimmed;
}

function pickBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

async function completeOnce(
  config: LlmConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const baseUrl = config.baseUrl?.replace(/\/+$/, "") ?? "";
  const url = `${baseUrl}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const text = await res.text();
    const msg = `LLM trả HTTP ${res.status}: ${text.slice(0, 200)}`;
    throw new Error(msg);
  }
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? "";
}

/**
 * Executes prompt with model fallback chain. Tries each comma-separated model in order.
 */
export async function defaultComplete(
  config: LlmConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const models = (config.model ?? "gpt-4o-mini")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  let lastError: Error = new Error("Chưa cấu hình model LLM");
  for (let i = 0; i < models.length; i++) {
    const currentModel = models[i] ?? "";
    try {
      return await completeOnce({ ...config, model: currentModel }, systemPrompt, userPrompt);
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message;
      const isClientError = /4\d\d/.test(msg) && !msg.includes("429");
      if (isClientError || i === models.length - 1) {
        break;
      }
    }
  }
  throw lastError;
}

export class FieldExtractor implements FieldExtractorPort {
  private readonly llmConfig?: LlmConfig;
  private readonly completeFn: CompleteFn;
  private readonly domain: ExtractorDomainConfig;

  constructor(configOrOptions?: LlmConfig | FieldExtractorOptions, completeFn?: CompleteFn) {
    if (configOrOptions && "completeFn" in configOrOptions) {
      this.llmConfig = configOrOptions.llmConfig;
      this.completeFn = configOrOptions.completeFn ?? defaultComplete;
      this.domain = configOrOptions.domain ?? {};
    } else {
      this.llmConfig = configOrOptions as LlmConfig | undefined;
      this.completeFn = completeFn ?? defaultComplete;
      this.domain = {};
    }
  }

  async extract(
    inputOrText: ExtractInput | string,
    contextDescription?: string,
    opts: { createdTicket?: { identifier: string; title?: string } } = {},
  ): Promise<ExtractedFields> {
    const text = typeof inputOrText === "string" ? inputOrText.trim() : inputOrText.text.trim();
    // Ngữ cảnh do engine đưa vào (PR 4): mô tả tờ khai, câu hỏi kỹ thuật vừa hỏi,
    // ticket vừa tạo. Engine đã cắt sẵn theo trần của legacy.
    const ctx = typeof inputOrText === "string" ? undefined : inputOrText.context;
    const context =
      typeof inputOrText === "string"
        ? contextDescription
        : (ctx?.draftDescription ?? ctx?.techQuestion ?? inputOrText.draftTitle);
    const createdTicket = typeof inputOrText === "string" ? opts.createdTicket : ctx?.createdTicket;

    if (!text) {
      return { userIntent: "chitchat", symptoms: [] };
    }

    let parsedResult: Record<string, unknown> | null = null;
    let llmExhausted = false;

    if (isLlmConfigured(this.llmConfig)) {
      const products = this.domain.products ?? VALID_PRODUCTS;
      const systems = this.domain.systems ?? VALID_SYSTEMS;
      const errorCategories = this.domain.errorCategories ?? VALID_ERROR_CATEGORIES;
      const reportingDepts = this.domain.reportingDepts ?? VALID_REPORTING_DEPTS;
      const deviceTypes = this.domain.deviceTypes ?? VALID_DEVICE_TYPES;

      const systemPrompt = `Bạn là Trợ lý phân tích sự cố kỹ thuật của VuiHoc.
Nhiệm vụ của bạn là đọc tin nhắn của người dùng và trích xuất các thông tin có cấu trúc dưới dạng JSON chuẩn.
BẮT BUỘC chỉ chọn các giá trị nằm trong danh mục sau (nếu không rõ, hãy trả về null):
- Products: ${JSON.stringify(products)}
- Systems: ${JSON.stringify(systems)}
- Error Categories: ${JSON.stringify(errorCategories)}
- Reporting Depts: ${JSON.stringify(reportingDepts)}
- Device Types: ${JSON.stringify(deviceTypes)}

QUY TẮC QUAN TRỌNG:
1. Số điện thoại (10 chữ số) LUÔN LUÔN là studentAccount, KHÔNG ĐƯỢC gán vào customerId. customerId chỉ là mã số định danh riêng.
2. userIntent (một trong ${JSON.stringify(INTENTS)}):
   - "confirm": CẢ tin nhắn chỉ là lời đồng ý tạo vé (ok, đúng rồi, tạo đi, chuẩn). Tin có kèm mô tả lỗi thì KHÔNG phải confirm.
   - "provide_info": bổ sung chi tiết cho sự cố đang trao đổi.
   - "report_issue": báo một sự cố (mới).
   - "cancel": người dùng nói rõ muốn huỷ/không cần tạo nữa. Chữ "không" trong mô tả lỗi KHÔNG phải huỷ.
   - "chitchat": cảm ơn, chào hỏi, không có thông tin sự cố; cả lời phản hồi về một ticket ĐÃ CÓ (vd "Ticket TECH-722 đã ổn rồi", "722 xong rồi nhé") — đó không phải sự cố mới.
3. title: tiêu đề ngắn (≤ 80 ký tự) TÓM TẮT LỖI của cả sự cố (ngữ cảnh trước đó + tin mới), kiểu "Không lên được đơn do trùng tài khoản con". KHÔNG dùng tên học sinh/phụ huynh, SĐT, mã HS/đơn/UID, lời chào hay câu nhờ vả ("hỗ trợ em với ạ") làm tiêu đề; chưa rõ lỗi gì thì để null. titleExplicit = true CHỈ khi người dùng yêu cầu đổi tiêu đề.
4. removeSymptoms: các triệu chứng người dùng bảo bỏ / nói là không đúng.
5. Các trường bằng chứng (scope, blocksLearning, blocksPayment, …) quyết định mức ưu tiên: điền true/false/enum khi tin nhắn cho biết, không rõ thì null.
6. Trả về ĐÚNG một object JSON (không kèm markdown \`\`\`json) với các khoá sau:
${describeExtractedKeys({
  products,
  systems,
  errorCategories,
  reportingDepts,
  deviceTypes,
})}`;

      const ticketNote = createdTicket
        ? `\nLƯU Ý: sự cố trên ĐÃ được tạo ticket ${createdTicket.identifier}. Tin mới là bổ sung cho ticket đó → "provide_info"; một sự cố KHÁC → "report_issue"; cảm ơn/chào → "chitchat"; bấm xác nhận lại → "confirm".`
        : "";

      const userPrompt = `Ngữ cảnh sự cố trước đó (nếu có):
${context ? capText(context, MAX_LLM_CONTEXT_CHARS) : "(Chưa có)"}${ticketNote}

Tin nhắn mới của người dùng:
"${capText(text, MAX_LLM_MESSAGE_CHARS)}"`;

      try {
        const raw = await this.completeFn(this.llmConfig, systemPrompt, userPrompt);
        const parsed = parseJsonLoose(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          parsedResult = parsed as Record<string, unknown>;
        }
      } catch {
        llmExhausted = true;
      }
    }

    const fromLlm = parsedResult !== null;
    if (!parsedResult) {
      parsedResult = this.heuristicExtract(text);
      if (llmExhausted) {
        delete parsedResult.title;
      }
    }

    const edit = parseEditCommand(text);

    let userIntent: UserIntent =
      pickEnum(parsedResult.userIntent, INTENTS) ?? this.heuristicIntent(text);
    if (edit && (userIntent === "report_issue" || userIntent === "chitchat")) {
      userIntent = "provide_info";
    }

    if (createdTicket && userIntent === "report_issue") {
      const describesNewProblem =
        PROBLEM_WORDS.test(text) ||
        /báo (?:thêm )?lỗi khác|sự cố (?:mới|khác)|ticket khác/i.test(text);
      if (!describesNewProblem) {
        userIntent = "provide_info";
      }
    }

    const validSystems = this.domain.systems ?? VALID_SYSTEMS;
    const systemSynonyms = this.domain.systemSynonyms ?? SYSTEM_SYNONYMS;
    const validDepts = this.domain.reportingDepts ?? VALID_REPORTING_DEPTS;
    const deptSynonyms = this.domain.deptSynonyms ?? DEPT_SYNONYMS;

    const system = normalizeWithSynonyms(
      pickString(parsedResult.system),
      validSystems,
      systemSynonyms,
    );

    const deptCandidate = normalizeWithSynonyms(
      pickString(parsedResult.reportingDept),
      validDepts,
      deptSynonyms,
    );

    const reportingDept =
      deptCandidate && deptMentioned(text, deptCandidate, deptSynonyms) ? deptCandidate : undefined;

    const reportingDeptUnrecognized = reportingDept
      ? undefined
      : detectUnrecognizedDept(text, deptCandidate, validDepts, deptSynonyms);

    let customerId = pickString(parsedResult.customerId);
    let studentAccount = pickString(parsedResult.studentAccount);

    if (isVietnamesePhone(customerId)) {
      if (!studentAccount) studentAccount = customerId;
      customerId = undefined;
    }

    const carriesContent =
      (userIntent === "report_issue" || userIntent === "provide_info") &&
      !edit &&
      !isDeclineAnswer(text);

    let symptoms: string[] = [];
    if (carriesContent) {
      symptoms = Array.isArray(parsedResult.symptoms)
        ? parsedResult.symptoms
            .filter((s: unknown): s is string => typeof s === "string" && s.trim() !== "")
            .map((s: string) => s.trim())
        : [text];
    }

    const parsedRemoveSymptoms = Array.isArray(parsedResult.removeSymptoms)
      ? parsedResult.removeSymptoms.filter(
          (s: unknown): s is string => typeof s === "string" && s.trim() !== "",
        )
      : [];
    const removeSymptoms = [...(edit?.removeSymptoms ?? []), ...parsedRemoveSymptoms];

    let title = edit?.title ?? (carriesContent ? pickString(parsedResult.title) : undefined);
    if (title && isInvalidTitle(title, text)) {
      title = deriveFallbackTitle(text, symptoms);
      if (isInvalidTitle(title)) title = undefined;
    }

    const titleExplicit =
      Boolean(edit?.title) || (fromLlm && parsedResult.titleExplicit === true && Boolean(title));

    const inferred = carriesContent ? inferEvidence(text) : {};
    const llmScope = pickEnum(parsedResult.scope, [
      "single_user",
      "group",
      "entire_system",
    ] as const);

    const validProducts = this.domain.products ?? VALID_PRODUCTS;
    const validErrors = this.domain.errorCategories ?? VALID_ERROR_CATEGORIES;
    const validDevices = this.domain.deviceTypes ?? VALID_DEVICE_TYPES;

    const roomCode = pickString(parsedResult.roomCode);
    const transactionId = pickString(parsedResult.transactionId);
    const assignmentId = pickString(parsedResult.assignmentId);
    const deviceType = pickEnum(parsedResult.deviceType, validDevices);
    const deviceOs = pickString(parsedResult.deviceOs);
    const appVersion = pickString(parsedResult.appVersion);
    const browser = pickString(parsedResult.browser);
    const product = pickEnum(parsedResult.product, validProducts);
    const errorCategory = pickEnum(parsedResult.errorCategory, validErrors);
    const requestedPriority = pickEnum(parsedResult.requestedPriority, ["high", "urgent"] as const);
    const requestedPriorityReason = pickString(parsedResult.requestedPriorityReason);

    const scope = llmScope ?? inferred.scope;
    const blocksPayment = inferred.blocksPayment || pickBool(parsedResult.blocksPayment);
    const blocksLearning = inferred.blocksLearning || pickBool(parsedResult.blocksLearning);
    const reconciliationMismatch = pickBool(parsedResult.reconciliationMismatch);
    const dataLoss = pickBool(parsedResult.dataLoss);
    const hasWorkaround = pickBool(parsedResult.hasWorkaround);
    const singleDeviceOnly = pickBool(parsedResult.singleDeviceOnly);

    const identifiers: Partial<Record<IdentifierKey, string>> = {};
    if (customerId) identifiers.customerId = customerId;
    if (studentAccount) identifiers.studentAccount = studentAccount;
    if (roomCode) identifiers.roomCode = roomCode;
    if (transactionId) identifiers.transactionId = transactionId;
    if (assignmentId) identifiers.assignmentId = assignmentId;

    const values: Record<string, string> = {};
    if (product) values.product = product;
    if (system) values.system = system;
    if (errorCategory) values.errorCategory = errorCategory;
    if (reportingDept) values.reportingDept = reportingDept;
    if (deviceType) values.deviceType = deviceType;
    if (deviceOs) values.deviceOs = deviceOs;
    if (appVersion) values.appVersion = appVersion;
    if (browser) values.browser = browser;

    const evidence: Record<string, unknown> = {};
    if (scope) evidence.scope = scope;
    if (blocksPayment !== undefined) evidence.blocksPayment = blocksPayment;
    if (blocksLearning !== undefined) evidence.blocksLearning = blocksLearning;
    if (reconciliationMismatch !== undefined)
      evidence.reconciliationMismatch = reconciliationMismatch;
    if (dataLoss !== undefined) evidence.dataLoss = dataLoss;
    if (hasWorkaround !== undefined) evidence.hasWorkaround = hasWorkaround;
    if (singleDeviceOnly !== undefined) evidence.singleDeviceOnly = singleDeviceOnly;

    const result: ExtractedFields = {
      userIntent,
      title: title ? capText(title, 120) : undefined,
      titleExplicit: titleExplicit || undefined,
      symptoms,
      removeSymptoms: removeSymptoms.length > 0 ? removeSymptoms : undefined,
      identifiers,
      values,
      evidence,
      requestedPriority,
      requestedPriorityReason,
      // Direct fields for parity
      product,
      system,
      errorCategory,
      reportingDept,
      reportingDeptUnrecognized,
      deviceType,
      deviceOs,
      appVersion,
      browser,
      customerId,
      studentAccount,
      roomCode,
      transactionId,
      assignmentId,
      scope,
      blocksPayment,
      reconciliationMismatch,
      blocksLearning,
      dataLoss,
      hasWorkaround,
      singleDeviceOnly,
    };

    return result;
  }

  private heuristicIntent(text: string): UserIntent {
    if (isShortConfirmation(text)) return "confirm";
    if (isExplicitCancel(text)) return "cancel";
    if (isChitchat(text)) return "chitchat";
    if (isDeclineAnswer(text) || parseEditCommand(text)) return "provide_info";
    if (FOLLOW_UP_PREFIX.test(text)) return "provide_info";
    return "report_issue";
  }

  private heuristicExtract(text: string): Record<string, unknown> {
    let intent = this.heuristicIntent(text);

    const blockInfo = extractBlockInfo(text);
    const phoneMatch = text.match(PHONE_RE);
    const studentAccount = phoneMatch ? phoneMatch[0] : blockInfo.studentAccount;
    const customerId = blockInfo.customerId;
    const lower = text.toLowerCase();

    let product: string | undefined;
    const validProducts = this.domain.products ?? VALID_PRODUCTS;
    for (const p of validProducts) {
      if (lower.includes(p.toLowerCase())) {
        product = p;
        break;
      }
    }

    let reportingDept: string | undefined = blockInfo.reportingDept;
    const validDepts = this.domain.reportingDepts ?? VALID_REPORTING_DEPTS;
    const deptSynonyms = this.domain.deptSynonyms ?? DEPT_SYNONYMS;

    if (!reportingDept) {
      for (const d of validDepts) {
        if (lower.includes(d.toLowerCase())) {
          reportingDept = d;
          break;
        }
      }
    }
    if (!reportingDept) {
      for (const [alias, target] of Object.entries(deptSynonyms)) {
        if (new RegExp(`(?:^|[^\\p{L}\\p{N}])${alias}(?:$|[^\\p{L}\\p{N}])`, "iu").test(lower)) {
          reportingDept = target;
          break;
        }
      }
    }

    const system = detectSystem(
      text,
      this.domain.systemSynonyms ?? SYSTEM_SYNONYMS,
      this.domain.systems ?? VALID_SYSTEMS,
    );

    let deviceType: string | undefined;
    if (/ipad|tablet|máy tính bảng/i.test(text)) deviceType = "Máy tính bảng";
    else if (/iphone|điện thoại|samsung|oppo|xiaomi/i.test(text)) deviceType = "Điện thoại";
    else if (/laptop/i.test(text)) deviceType = "Laptop";
    else if (/\bpc\b|máy tính/i.test(text)) deviceType = "PC";

    let deviceOs: string | undefined;
    const osMatch = text.match(/(?:ios|android|windows|macos)\s*\d*(?:\.\d+)?/i);
    if (osMatch) deviceOs = osMatch[0].trim();

    let assignmentId: string | undefined;
    const assMatch = text.match(/(?:bài tập|mã bài|kt-)\s*([A-Za-z0-9_-]+)/i);
    if (assMatch?.[1]) assignmentId = assMatch[1];

    const hasStructured = Boolean(
      studentAccount ||
        reportingDept ||
        deviceType ||
        deviceOs ||
        assignmentId ||
        product ||
        system,
    );
    let structuredOnly = false;
    if (
      intent === "report_issue" &&
      text.length <= 80 &&
      hasStructured &&
      !PROBLEM_WORDS.test(text)
    ) {
      intent = "provide_info";
      structuredOnly = true;
    }

    const carriesContent =
      (intent === "report_issue" || intent === "provide_info") && !structuredOnly;

    const lines = text
      .split("\n")
      .map((l) => stripGreeting(l.replace(/\*\*/g, "").trim()))
      .filter(Boolean);
    let titleCandidate = lines.find((l) => EXPANDED_PROBLEM_WORDS.test(l));
    if (titleCandidate && isInvalidTitle(titleCandidate, text)) {
      titleCandidate = undefined;
    }
    if (!titleCandidate && carriesContent) {
      const derived = deriveFallbackTitle(text, carriesContent ? [text] : []);
      if (!isInvalidTitle(derived)) titleCandidate = derived;
    }

    return {
      userIntent: intent,
      title:
        carriesContent && titleCandidate
          ? titleCandidate.length <= 80
            ? titleCandidate
            : `${titleCandidate.slice(0, 77)}...`
          : undefined,
      symptoms: carriesContent ? [text] : [],
      product,
      system,
      reportingDept,
      customerId,
      studentAccount,
      deviceType,
      deviceOs,
      assignmentId,
    };
  }
}
