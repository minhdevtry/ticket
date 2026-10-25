import { z } from "zod";
import {
  composeQuestion,
  createRecord,
  evaluateGate,
  getVariant,
  fieldButtons,
  normalizeValue,
  type FieldCatalog,
} from "@vuihoc/bot-core/intake";
import { openLazyDb } from "../../../lib/storage/lazy-db";
import { memoByPath } from "@vuihoc/bot-core/core";
import { IdentityRepository } from "../../../lib/storage/identity-repository";
import {
  savePendingButtons,
  clearPendingButtons,
  toTelegramButtons,
  getBranchButtons,
  getLastActiveChatId,
  setLastActiveChatId,
} from "../../../lib/telegram/buttons";
import { getLogger } from "@vuihoc/bot-core/core";
import { defineTool, type AnyMcpTool } from "@vuihoc/bot-core/core";

const identityRepo = memoByPath((dbPath) => new IdentityRepository(openLazyDb(dbPath)));

/**
 * Trường "người này thuộc phòng ban nào" — hỏi một lần rồi nhớ.
 *
 * Không khai thì tool giữ nguyên hành vi cũ (hỏi lại mỗi phiên). Khai thì
 * `check_required_fields` đọc phòng ban đã lưu vào `captured` trước khi chấm
 * điểm, và ghi lại khi thu được giá trị mới.
 */
export interface DepartmentMemory {
  /** File SQLite giữ danh tính — cùng file `check_identity` đang dùng. */
  dbPath: string;
  /** Tên trường trong catalog giữ phòng ban (IRIS: `phong_ban`). */
  field: string;
}

/** Phòng ban đã lưu của người này, hoặc null. Lỗi đọc DB không được làm hỏng lượt hỏi. */
function recallDepartment(memory: DepartmentMemory, userId: string | null): string | null {
  if (!userId) return null;
  try {
    return identityRepo(memory.dbPath).getUserIdentity(userId)?.department ?? null;
  } catch (err) {
    getLogger().warn(`Không đọc được phòng ban đã nhớ (${userId}): ${err}`);
    return null;
  }
}

/**
 * Hỏi gì tiếp theo, và đã đủ chưa.
 *
 * Đây là lý do cả bộ này là tool chứ không phải luật trong prompt: ngân sách
 * hỏi lại, nhóm `một trong`, giá trị mặc định khi hết lượt — hai model khác
 * nhau bắt buộc phải cho ra cùng kết quả, nếu không bot sẽ hỏi mãi một câu.
 */
export function checkRequiredFields(catalog: FieldCatalog, memory?: DepartmentMemory): AnyMcpTool {
  return defineTool({
    name: "check_required_fields",
    description:
      "Kiểm tra đã thu thập đủ thông tin chưa và trả về câu hỏi tiếp theo. " +
      "Gọi mỗi lượt người dùng cung cấp thêm thông tin, trước khi ghi bản ghi.",
    inputSchema: {
      variant: z.string().optional().describe("Nhánh tiếp nhận đang theo ('1', '2', '3', '4')"),
      captured: z
        .record(z.string(), z.any())
        .default({})
        .describe("Các trường đã thu được, tên trường -> giá trị"),
      askedCount: z
        .record(z.string(), z.union([z.number(), z.string()]))
        .default({})
        .describe("Số lần đã hỏi từng trường (tên trường -> số lần hỏi, ví dụ: { boi_canh: 1 })"),
      cannotAnswer: z
        .array(z.string())
        .default([])
        .describe("Các trường người dùng đã nói rõ là không có thông tin"),
      reporterChatId: z
        .string()
        .optional()
        .describe("Chat ID Telegram của người dùng (để đính nút bấm trên Telegram)"),
      telegramUserId: z.string().optional().describe("Telegram User ID nếu khác Chat ID"),
    },
    handler: (input) => {
      const targetChatId = input.reporterChatId ?? input.telegramUserId ?? getLastActiveChatId();
      if (input.reporterChatId || input.telegramUserId) {
        setLastActiveChatId(targetChatId);
      }

      if (!input.variant) {
        if (targetChatId) {
          savePendingButtons(targetChatId, getBranchButtons());
        }
        return {
          isComplete: false,
          isFullyResolved: false,
          status: "Need Clarification",
          nextQuestion: "Anh/chị chọn nhánh bên dưới hoặc cứ nhắn thẳng nội dung cho em nhé:",
          fieldsToAsk: ["variant"],
          missingRequired: ["variant"],
          exhaustedFields: [],
          openQuestions: [],
          effectiveValues: {},
        };
      }

      const variant = catalog.variants[input.variant]
        ? input.variant
        : Object.keys(catalog.variants)[0];
      const stringifiedCaptured: Record<string, string> = {};
      if (input.captured && typeof input.captured === "object") {
        for (const [k, v] of Object.entries(input.captured)) {
          if (v !== undefined && v !== null) {
            stringifiedCaptured[k] = typeof v === "string" ? v : String(v);
          }
        }
      }
      const rememberedFor = input.telegramUserId ?? input.reporterChatId ?? targetChatId;
      if (memory && !(stringifiedCaptured[memory.field] ?? "").trim()) {
        const remembered = recallDepartment(memory, rememberedFor);
        if (remembered) stringifiedCaptured[memory.field] = remembered;
      }

      const record = createRecord(variant, stringifiedCaptured);
      const parsedAskedCount: Record<string, number> = {};
      if (input.askedCount && typeof input.askedCount === "object") {
        for (const [k, v] of Object.entries(input.askedCount)) {
          const num = Number(v);
          if (!Number.isNaN(num)) {
            parsedAskedCount[k] = num;
          }
        }
      }
      record.questionCount = parsedAskedCount;
      record.explicitlyMissing = input.cannotAnswer;

      const gate = evaluateGate(catalog, record);

      // Hỏi một lần rồi nhớ: ghi phòng ban lại ngay khi thu được, để phiên sau
      // không hỏi lại thứ mình đã biết.
      if (memory && rememberedFor) {
        const variantSpec = getVariant(catalog, record.variant);
        const spec = variantSpec?.fields?.[memory.field];
        const raw = (record.values[memory.field] ?? "").trim();
        const canonical = spec && raw ? normalizeValue(catalog, spec, raw) : null;
        if (canonical) {
          try {
            identityRepo(memory.dbPath).updateDepartment(rememberedFor, canonical);
          } catch (err) {
            // Không làm hỏng lượt hỏi, nhưng phải để lại dấu vết: hỏng ở đây
            // thì phiên sau lại hỏi phòng ban, và đó là lỗi người dùng thấy.
            getLogger().warn(`Không lưu được phòng ban (${rememberedFor}): ${err}`);
          }
        }
      }

      // Tự động đính nút bấm Telegram cho trường enum đang hỏi ở lượt này.
      // `hasButtons` quyết định luôn phần chữ: có nút thì thôi liệt kê lại lựa
      // chọn trong câu hỏi — người dùng báo đúng chỗ này (14/09/2026).
      let hasButtons = false;
      if (targetChatId) {
        if (!gate.isComplete && gate.fieldsToAsk.length > 0) {
          const firstField = gate.fieldsToAsk[0];
          const variantSpec = getVariant(catalog, record.variant);
          const fieldSpec = variantSpec?.fields?.[firstField];
          const rows = fieldSpec ? fieldButtons(catalog, fieldSpec) : null;
          if (rows) {
            savePendingButtons(targetChatId, toTelegramButtons(rows));
            hasButtons = true;
          } else {
            clearPendingButtons(targetChatId);
          }
        }
      }

      const nextQuestion = hasButtons
        ? composeQuestion(catalog, record, gate.fieldsToAsk, { withOptions: false })
        : gate.questionText;

      return {
        isComplete: gate.isComplete,
        isFullyResolved: gate.isFullyResolved,
        status: gate.status,
        nextQuestion,
        fieldsToAsk: gate.fieldsToAsk,
        missingRequired: gate.missingRequired,
        exhaustedFields: gate.exhaustedFields,
        openQuestions: gate.openQuestions,
        effectiveValues: gate.effectiveValues,
      };
    },
  });
}
