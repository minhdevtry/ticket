/**
 * Pack MCP lễ tân — bọc engine tiếp nhận, tra cứu tờ khai và công cụ định danh
 * thành MCP server chạy được trên stdio hoặc HTTP (RFC 0002 PR 15).
 *
 * Nguyên tắc:
 * 1. Tool tất định: `intake_step`, `get_intake_doc`, `get_similar_tickets`, tool định danh.
 * 2. Không trả nút/callbackData thô cho LLM (bug MiniMax 24/09).
 * 3. agentInstruction lấy từ `CopyCatalog`, core không hardcode tiếng Việt.
 * 4. Chạy stdio/HTTP không mạng thật.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, type AnyMcpTool, createIntakeMcpServer, type EnvShape } from "../core";
import { identityTools, type IdentityToolsConfig } from "../identity/tools";
import { IntakeEngine } from "../intake/engine/engine";
import { legacyActionForOutcome } from "../intake/engine/action-map";
import type { DraftRepository } from "../intake/draft/repository";
import type { IntakeDraft } from "../intake/draft/types";
import type { IntakeRecord } from "../intake/gate/types";
import type { ChannelMessage } from "../intake/engine/types";
import type {
  Clock,
  CopyCatalog,
  ChannelBindingStore,
  MediaResolver,
  TrackerPort,
  TechReviewerPort,
  TechReviewPolicy,
  LearnedItemsPort,
  OwnershipPort,
  TicketActionExecutorPort,
  TicketCommandInterpreterPort,
  PostCreateHookPort,
} from "../intake/ports";
import { systemClock } from "../intake/ports";
import type { ConfirmOptions } from "../intake/confirm/protocol";
import type { BotDefinition, ReceptionistDefinition, TrackerRef } from "./define";

/** Các action bot đang chờ người dùng trả lời hoặc bấm nút. */
const WAITS_FOR_USER: Record<string, true> = {
  ask_missing_field: true,
  clarify_intent: true,
  confirm_summary: true,
  awaiting_user_confirmation: true,
  ask_new_or_continue: true,
  ask_split_or_merge: true,
  confirm_ticket_action: true,
};

export interface ReceptionistMcpDeps {
  tracker?: TrackerPort;
  projectKey?: string;
  drafts: DraftRepository;
  bindings?: ChannelBindingStore;
  clock?: Clock;
  media?: MediaResolver;
  confirm?: ConfirmOptions;
  variant?: string | ((draft: IntakeDraft, record: IntakeRecord) => string);
  systemField?: string;
  departmentField?: string;
  techReviewer?: TechReviewerPort;
  techReviewPolicy?: TechReviewPolicy;
  learned?: LearnedItemsPort;
  ownership?: OwnershipPort;
  actions?: TicketActionExecutorPort;
  commands?: TicketCommandInterpreterPort;
  postCreate?: PostCreateHookPort;
  botName?: string;
  ignoredActors?: string[];
  copy?: CopyCatalog;
  identity?: IdentityToolsConfig | AnyMcpTool[];
  name?: string;
  version?: string;
  engine?: IntakeEngine;
}

export type ReceptionistServerDefinition<E extends EnvShape = EnvShape> =
  | BotDefinition<E>
  | Readonly<BotDefinition<E>>
  | (ReceptionistDefinition & {
      id?: string;
      tracker?: TrackerRef;
      persona?: CopyCatalog;
    });

function formatDoc(draft: IntakeDraft) {
  const fields: Record<string, { value: unknown }> = {};
  if (draft.record?.values) {
    for (const [k, v] of Object.entries(draft.record.values)) {
      fields[k] = { value: v };
    }
  }
  const customFields =
    "fields" in draft && typeof draft.fields === "object" && draft.fields !== null
      ? (draft.fields as Record<string, { value: unknown }>)
      : fields;
  return {
    ...draft,
    fields: customFields,
  };
}

/**
 * Dựng MCP server lễ tân từ khai báo `defineBot({ receptionist })` và dependencies.
 */
export function createReceptionistMcpServer<E extends EnvShape = EnvShape>(
  definition: ReceptionistServerDefinition<E>,
  deps: ReceptionistMcpDeps,
): McpServer {
  const rec =
    "receptionist" in definition && definition.receptionist
      ? definition.receptionist
      : (definition as ReceptionistDefinition);

  if (!rec?.catalog || !rec?.priorityRules || !rec?.extractor) {
    throw new Error(
      "createReceptionistMcpServer: khai báo receptionist thiếu catalog, priorityRules hoặc extractor",
    );
  }

  const persona: CopyCatalog | undefined =
    ("persona" in definition && definition.persona ? definition.persona : undefined) ?? deps.copy;

  if (!persona) {
    throw new Error("createReceptionistMcpServer: persona hoặc deps.copy là bắt buộc");
  }

  const defaultBindings: ChannelBindingStore = {
    saveBinding: () => {},
    getLatestBinding: () => null,
  };

  const projectKey =
    deps.projectKey ??
    ("tracker" in definition && definition.tracker ? definition.tracker.project : undefined);

  const tracker = deps.tracker;
  if (!deps.engine && !tracker) {
    throw new Error("createReceptionistMcpServer: deps.tracker hoặc deps.engine là bắt buộc");
  }

  const engine =
    deps.engine ??
    new IntakeEngine({
      tracker: tracker as TrackerPort,
      drafts: deps.drafts,
      variant: deps.variant ?? Object.keys(rec.catalog.variants)[0] ?? "default",
      bindings: deps.bindings ?? defaultBindings,
      copy: persona,
      clock: deps.clock ?? systemClock,
      media: deps.media,
      confirm: deps.confirm,
      identifierPrefix: projectKey,
      extractor: rec.extractor,
      catalog: rec.catalog,
      systemField: deps.systemField,
      departmentField: deps.departmentField,
      urgencyRules: rec.priorityRules,
      techReviewer: deps.techReviewer,
      techReviewPolicy: deps.techReviewPolicy,
      learned: deps.learned,
      ownership: deps.ownership,
      actions: deps.actions,
      commands: deps.commands,
      postCreate: deps.postCreate,
      botName: deps.botName,
      ignoredActors: deps.ignoredActors,
    });

  const stepTool = defineTool({
    name: "intake_step",
    description:
      "Đường CHÍNH tiếp nhận sự cố kỹ thuật, tất định từng lượt hội thoại. " +
      "BẮT BUỘC gọi mỗi khi người dùng nhắn về sự cố: báo lỗi, trả lời câu hỏi, bấm nút, xác nhận, huỷ, gửi ảnh. " +
      "Tool tự trích xuất, lưu tờ khai IntakeDraft, hỏi trường còn thiếu, xin xác nhận, " +
      "TỰ TẠO ticket khi người dùng xác nhận và tự ghi phần bổ sung vào ticket đã tạo. " +
      "Gửi nguyên văn `voiceText` cho người dùng. KHÔNG gọi create_issue sau khi tool này đã tạo ticket. " +
      "`message` phải là đúng tin người dùng vừa gửi — TUYỆT ĐỐI không tự gửi lời xác nhận thay người dùng; " +
      "sau action confirm_summary thì kết thúc lượt, chờ người dùng bấm nút.",
    inputSchema: {
      message: z
        .string()
        .optional()
        .describe("Nội dung tin nhắn văn bản người dùng vừa gửi (có thể rỗng nếu chỉ gửi ảnh)"),
      mediaPaths: z
        .array(z.string())
        .optional()
        .describe("Đường dẫn ảnh/video người dùng gửi trong tin này — tool tự đính kèm vào ticket"),
      chatId: z.string().describe("ID của phòng chat / Telegram chat_id"),
      reporterName: z.string().optional().describe("Tên người báo nếu có"),
      reporterUsername: z.string().optional().describe("Telegram username của người báo"),
      reporterNameCode: z.string().optional().describe("Mã nhân sự (VD: CS_user_a)"),
      excludeIdentifier: z.string().optional().describe("Mã ticket loại trừ khi tìm kiếm tương tự"),
      forceNew: z.boolean().optional().describe("Cờ ép mở sự cố mới, gác tờ khai đang dở nếu có"),
    },
    handler: async ({
      message,
      mediaPaths,
      chatId,
      reporterName,
      reporterUsername,
      reporterNameCode,
      forceNew,
    }) => {
      const stepOutput = await engine.step({
        chatId,
        message: message ?? "",
        mediaPaths,
        reporter: {
          name: reporterName,
          username: reporterUsername,
          nameCode: reporterNameCode,
        },
        forceNew,
      });

      const action = legacyActionForOutcome(stepOutput.outcome) ?? stepOutput.outcome;
      const waitsForUser = Boolean(WAITS_FOR_USER[action]);

      let agentInstruction: string;
      try {
        agentInstruction = persona.text(
          waitsForUser ? "agent_instruction.wait_for_user" : "agent_instruction.forward",
        );
      } catch {
        agentInstruction = waitsForUser
          ? "Gửi nguyên văn voiceText rồi KẾT THÚC LƯỢT. Chờ người dùng tự trả lời hoặc bấm nút — không tự chọn đáp án, không gọi lại intake_step trong lượt này."
          : "Gửi nguyên văn voiceText cho người dùng.";
      }

      const voiceText = stepOutput.messages.map((m: ChannelMessage) => m.text).join("\n\n");
      const buttonsShown = stepOutput.messages.some((m: ChannelMessage) =>
        Boolean(m.buttons?.length),
      );
      const latestDraft =
        (stepOutput.docId ? deps.drafts.getByDocId(stepOutput.docId) : null) ??
        deps.drafts.getLatestByChatId(chatId);
      const status =
        latestDraft?.status ?? (action === "ticket_created" ? "created" : "collecting");

      const similarTickets =
        latestDraft && "similarTickets" in latestDraft && Array.isArray(latestDraft.similarTickets)
          ? latestDraft.similarTickets
          : undefined;

      // KHÔNG trả nút (callbackData) thô cho model (bug MiniMax 24/09).
      return {
        success: stepOutput.outcome !== "failed",
        action,
        status,
        voiceText,
        displayMarkdown: voiceText,
        missingFields: stepOutput.missingFields,
        buttonsShown,
        agentInstruction,
        issue: stepOutput.issue ?? stepOutput.createdIssue,
        similarTickets,
        docId: latestDraft?.docId ?? stepOutput.docId,
        revision: latestDraft?.revision,
      };
    },
  });

  const getIntakeDoc = defineTool({
    name: "get_intake_doc",
    description:
      "Tra cứu chi tiết tờ khai IntakeDraft và toàn bộ lịch sử revision của phiên tiếp nhận sự cố. " +
      "Hỗ trợ kiểm tra provenance từng trường thông tin để phục vụ phân tích hoặc dựng Knowledge Graph.",
    inputSchema: {
      chatId: z.string().optional().describe("ID phòng chat Telegram"),
      docId: z.string().optional().describe("Mã định danh tờ khai nếu có"),
      includeHistory: z
        .boolean()
        .default(false)
        .describe("Lấy toàn bộ lịch sử revision (mặc định false)"),
    },
    handler: ({ chatId, docId, includeHistory }) => {
      let doc: IntakeDraft | null = null;
      if (docId) {
        doc = deps.drafts.getByDocId(docId);
      } else if (chatId) {
        doc = deps.drafts.getLatestByChatId(chatId);
      }

      if (!doc) {
        return { found: false, message: "Không tìm thấy IntakeDocument tương ứng" };
      }

      const history = includeHistory && doc.docId ? deps.drafts.getRevisions(doc.docId) : undefined;

      return {
        found: true,
        document: formatDoc(doc),
        history: history ? history.map(formatDoc) : undefined,
      };
    },
  });

  const getSimilarTickets = defineTool({
    name: "get_similar_tickets",
    description:
      "Lấy danh sách các ticket tương tự đã được tìm kiếm và thẩm định sự tồn tại trên Itsaplan cho phiên chat hiện tại.",
    inputSchema: {
      chatId: z.string().describe("ID phòng chat Telegram"),
    },
    handler: ({ chatId }) => {
      const doc = deps.drafts.getLatestByChatId(chatId);
      if (!doc) {
        return { found: false, similarTickets: [] };
      }

      const similarTickets =
        "similarTickets" in doc && Array.isArray(doc.similarTickets) ? doc.similarTickets : [];

      return {
        found: true,
        docId: doc.docId,
        revision: doc.revision,
        similarTickets,
      };
    },
  });

  let idTools: AnyMcpTool[] = [];
  if (deps.identity) {
    if (Array.isArray(deps.identity)) {
      idTools = deps.identity;
    } else {
      deps.identity.drafts ??= deps.drafts;
      idTools = identityTools(deps.identity);
    }
  }

  const tools: AnyMcpTool[] = [stepTool, getIntakeDoc, getSimilarTickets, ...idTools];

  const serverName =
    deps.name ??
    ("id" in definition && definition.id ? `${definition.id}-receptionist` : "receptionist");
  const serverVersion = deps.version ?? "1.0.0";

  return createIntakeMcpServer({
    name: serverName,
    version: serverVersion,
    tools,
  });
}
