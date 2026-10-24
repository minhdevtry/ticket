#!/usr/bin/env bun
/**
 * MCP server của Tiểu Linh — tiếp nhận sự cố kỹ thuật, ghi vào Itsaplan.
 *
 * Itsaplan-only ngay từ thiết kế: không có đường nào dẫn tới Huly.
 */
import {
  assessPriority,
  checkIdentity,
  createIssue,
  getIssue,
  redactPii,
  registerIdentity,
  runOnStdio,
  searchKnowledge,
  validateFields,
  createIntakeMcpServer,
  queryKnowledgeGraph,
  type IdentityConfig,
  type KnowledgeConfig,
  type ValidationRules,
  type TrackerConfig,
  type FieldRequirementsTable,
  type ProductMappingConfig,
  type UrgencyRules,
} from "../shared/index";
import { ticketDomain } from "./domain";
import urgencyRules from "./domain/urgency-rules.json";
import validationRules from "./domain/validation-rules.json";
import fieldRequirements from "./domain/required_fields.json";
import techInfoGuide from "./domain/tech-info-needs.md" with { type: "text" };
import productMapping from "./domain/product_mapping.json";
import { intakeStep } from "./tools/intake-step";
import { inspectTools } from "./tools/inspect-tools";
import { getSharedIntakeDocRepo } from "../../lib/intake-document/repository";
import { FieldExtractor } from "../../lib/intake-step/extractor";
import { OnyxRestSearchClient } from "../../lib/onyx/rest-search";
import { ItsaplanClient } from "../../lib/itsaplan/client";
import { MemgraphClient } from "../../lib/kg/memgraph-client";
import { LlmSimilarTickets } from "../../lib/kg/similar-ticket-source";
import type { JudgeMode } from "../../lib/kg/similar-judge";
import { getSharedBindingRepo } from "../../lib/storage/binding-repository";
import { getSharedDraftSessionRepo } from "../../lib/storage/session-repository";
import { isLlmConfigured, llmConfigFromEnv } from "../../worker/llm";
import { ChecklistTechReviewer } from "../../lib/intake-step/checklist-review";
import { createAskLearnedLookup } from "../../lib/ask-learning/lookup";
import { LlmTechReviewer } from "../../lib/intake-step/tech-review";
import { LlmTicketCommandInterpreter } from "../../lib/intake-step/ticket-reply-router";

const tracker: TrackerConfig = {
  baseUrl: process.env.ITSAPLAN_BASE_URL ?? "",
  apiKey: process.env.ITSAPLAN_AGENT_KEY || process.env.ITSAPLAN_API_KEY || "",
  projectKey: process.env.ITSAPLAN_PROJECT_KEY ?? "TECH",
  webUrl: process.env.ITSAPLAN_WEB_URL,
};

const knowledge: KnowledgeConfig = {
  baseUrl: process.env.ONYX_BASE_URL ?? "",
  apiKey: process.env.ONYX_API_KEY ?? "",
  personaId: Number(process.env.ONYX_PERSONA_ID ?? 6),
  mcpUrl: process.env.ONYX_MCP_URL,
};

const identity: IdentityConfig = {
  dbPath: process.env.INTAKE_DB_PATH ?? "data/tieulinh.db",
  projectKey: tracker.projectKey,
  adminIds: (process.env.ADMIN_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  requireApproval: false, // Ticket sự cố không cần duyệt
};

const itsaplanClient = new ItsaplanClient(tracker.baseUrl, tracker.apiKey);
const docRepo = getSharedIntakeDocRepo(identity.dbPath);
const searchClient = knowledge.apiKey
  ? new OnyxRestSearchClient(
      {
        baseUrl: knowledge.baseUrl,
        apiKey: knowledge.apiKey,
        // "intake-test-done" là nơi OnyxIngestService (worker) thực sự ghi vào —
        // trước đây bị thiếu ở đây nên toàn bộ ticket tự động nạp không bao giờ
        // được tìm lại (search chỉ đọc "ticket-history"/"tech-done-tickets").
        // "kg-cause-taxonomy" là dữ liệu KG (rootCause/resolution + nhãn
        // CauseTaxon canonical) đẩy từ Memgraph sang, xem apps/tieulinh/scripts/push-kg-to-onyx.ts.
        documentSets: ["ticket-history", "tech-done-tickets", "intake-test-done", "kg-cause-taxonomy"],
      },
      itsaplanClient,
    )
  : undefined;

const envLlm = llmConfigFromEnv();
const llmConfig = isLlmConfigured(envLlm) ? envLlm : undefined;

// KG là tuỳ chọn: chỉ bật khi có MEMGRAPH_URI. Pipeline tra ticket tương tự (KG
// = cụm nguyên nhân người xác định + Onyx ứng viên ngữ nghĩa + BM25 ứng viên
// lexical + LLM xác minh từng cặp — ADR-0007, kiến trúc mới 27/09) đúng MỘT
// lần mỗi tài liệu, chạy NỀN sau khi tạo ticket (không chặn câu trả lời — xem
// lib/intake-step/pipeline.ts::runSimilarTicketsInBackground). Kho chỉ gồm
// ticket của KG_SIMILAR_PROJECT (mặc định chính dự án này); máy dev test trên
// TECHTEST có thể trỏ KG_SIMILAR_PROJECT=TECH.
const similarTickets = process.env.MEMGRAPH_URI
  ? new LlmSimilarTickets({
      memgraph: new MemgraphClient(),
      onyx: searchClient,
      llm: llmConfig ?? { baseUrl: "", apiKey: "", model: "" },
      projectKey: process.env.KG_SIMILAR_PROJECT || tracker.projectKey,
      maxCandidates: Number(process.env.SIMILAR_MAX_CANDIDATES ?? 14),
      llmConcurrency: Number(process.env.SIMILAR_LLM_CONCURRENCY ?? 5),
      timeoutMs: Number(process.env.SIMILAR_TIMEOUT_MS ?? 60_000),
      judgeMode: (process.env.SIMILAR_JUDGE_MODE as JudgeMode | undefined) ?? "mechanism",
    })
  : undefined;

const intakeStepTool = intakeStep({
  repo: docRepo,
  extractor: new FieldExtractor(llmConfig),
  searchClient,
  similarTickets,
  itsaplan: itsaplanClient,
  itsaplanBaseUrl: tracker.baseUrl,
  webUrl: tracker.webUrl,
  projectKey: tracker.projectKey,
  // Dùng chung kho với create_issue: binding cho worker báo ngược, bản nháp để dọn khi tạo xong
  bindingRepo: getSharedBindingRepo(identity.dbPath),
  draftRepo: getSharedDraftSessionRepo(identity.dbPath),
  validationRules: validationRules as ValidationRules,
  fieldRequirements: fieldRequirements as FieldRequirementsTable,
  productMapping: productMapping as ProductMappingConfig,
  urgencyRules: urgencyRules as UrgencyRules,
  llmConfig,
  // Soát dữ kiện kỹ thuật cần (mã đơn, hạn đúng, link CARE, ảnh lỗi…) trước khi xin xác nhận.
  // TECH_INFO_REVIEW=off để tắt; =checklist: hỏi hết một lượt theo danh sách cố định (không LLM).
  // Lệnh nhắm vào ticket đã có (bổ sung/sửa/tra cứu/chuyển) — luôn xác nhận trước khi ghi (ADR-0008).
  ticketCommands: llmConfig ? new LlmTicketCommandInterpreter(llmConfig) : undefined,
  techReviewer:
    process.env.TECH_INFO_REVIEW === "checklist"
      // Tự học (W25): ASK_LEARN_DB trỏ tới kho do scripts/ask-learn.ts ingest; không có thì như cũ.
      ? new ChecklistTechReviewer(createAskLearnedLookup(process.env.ASK_LEARN_DB))
      : llmConfig && process.env.TECH_INFO_REVIEW !== "off"
        ? new LlmTechReviewer(llmConfig, techInfoGuide)
        : undefined,
});

await runOnStdio(
  createIntakeMcpServer({
    name: "intake-tieulinh",
    version: "0.1.0",
    tools: [
      intakeStepTool,
      ...inspectTools(docRepo),
      createIssue(tracker, ticketDomain, identity.dbPath, "✅ Đúng rồi, tạo ticket"),
      assessPriority(urgencyRules),
      getIssue(tracker, identity.dbPath),
      // Không có update_issue: ghi vào ticket đã có phải qua intake_step + người báo xác nhận
      // (ADR-0008 — agent từng tự ghi "em đang cập nhật thêm thông tin…" vào TECH-795).
      checkIdentity(identity),
      registerIdentity(identity),
      // Không có escalate_issue: nâng mức ưu tiên / giục gấp cũng là ghi vào ticket nên phải qua
      // intake_step (bản xem trước + nút xác nhận; có lý do thì nâng mức — ADR-0008).
      validateFields(
        validationRules as ValidationRules,
        fieldRequirements as FieldRequirementsTable,
        productMapping as ProductMappingConfig,
        identity.dbPath,
      ),
      searchKnowledge(knowledge),
      queryKnowledgeGraph(),
      redactPii,
    ],
  }),
);
