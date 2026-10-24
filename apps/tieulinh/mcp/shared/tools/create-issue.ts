import { z } from "zod";
import { stripChannelEnvelope, isInternalCallbackToken } from "@vuihoc/bot-core/core";
import { ItsaplanClient } from "../../../lib/itsaplan/client";
import {
  issueWebUrl,
  resolveBacklogColumn,
  resolveLabel,
  resolveLabelsForIssue,
  resolveProject,
} from "../../../lib/itsaplan/project";
import {
  uploadAttachments,
  spliceAttachmentsIntoDescription,
  type UploadedAttachment,
} from "../../../lib/itsaplan/attachments";
import { findRecentInboundMedia } from "../../../lib/media";
import {
  getSharedBindingRepo,
  type TicketBindingRepository,
} from "../../../lib/storage/binding-repository";
import {
  getSharedDraftSessionRepo,
  type DraftSessionRepository,
} from "../../../lib/storage/session-repository";
import {
  getSharedIntakeDocRepo,
  parseSqliteTimestamp,
  INTAKE_DRAFT_TTL_MS,
  type IntakeDocumentRepository,
} from "../../../lib/intake-document/repository";
import { CLOSED_STATUSES, type IntakeDocument } from "../../../lib/intake-document/types";
import { getLogger } from "@vuihoc/bot-core/core";
import { buildAdviceComment } from "../../tieulinh/domain/ticket-formatter";
import { markBotComment } from "@vuihoc/bot-core/core";
import { defineTool, type AnyMcpTool } from "@vuihoc/bot-core/core";
import type { TrackerConfig } from "./issues";

import {
  savePendingButtons,
  clearPendingButtons,
  getConfirmationButtons,
} from "../../../lib/telegram/buttons";

export type Priority = "urgent" | "high" | "medium" | "low";

export interface BuiltIssue {
  title: string;
  description: string;
  priority: Priority;
  /** Câu trả lời người dùng thấy. `{identifier}` và `{url}` được thay sau khi tạo. */
  confirmation: string;
  /** Bản tóm tắt tuỳ biến cho bước xin xác nhận (userConfirmed = false). */
  confirmationMessage?: string;
  errorCategory?: string;
  product?: string;
  system?: string;
  mediaPaths?: string[];
  rawText?: string;
  /** Suy luận kỹ thuật của bot — ghi ra COMMENT riêng, KHÔNG nằm trong mô tả (TECH-1084). */
  diagnosis?: string;
}

export interface IssueDomain<TShape extends z.ZodRawShape> {
  description: string;
  inputShape: TShape;
  build(input: z.infer<z.ZodObject<TShape>>): BuiltIssue;
}

/**
 * Ghi một bản ghi mới lên tracker.
 *
 * Hỗ trợ 2 bước an toàn:
 * 1. userConfirmed = false: Trả về bản tóm tắt và câu hỏi xác nhận, chưa ghi lên Itsaplan.
 * 2. userConfirmed = true: Tạo issue trên Itsaplan và lưu binding vào SQLite để worker báo ngược Telegram.
 */
/**
 * Chat ID đi qua nhiều lớp nên không phải lúc nào cũng cùng một dạng chuỗi:
 * model có khi gửi `"telegram:123"`, khi lại gửi `"123"`. Bản nháp lưu theo
 * dạng nào thì tra theo dạng đó, nên phải thử cả ba.
 */
function draftKeys(targetChatId: string | number): string[] {
  const raw = String(targetChatId);
  const numeric = raw.replace(/[^0-9]/g, "");
  return numeric && numeric !== raw ? [raw, numeric, `telegram:${numeric}`] : [raw];
}

function resolveDraft(repo: DraftSessionRepository, targetChatId: string | number) {
  for (const key of draftKeys(targetChatId)) {
    const draft = repo.getDraft(key);
    if (draft) return draft;
  }
  return null;
}

function deleteDraft(repo: DraftSessionRepository, targetChatId: string | number) {
  for (const key of draftKeys(targetChatId)) repo.clearDraft(key);
}

// ─── Phần dùng chung giữa create_issue và intake_step ─────────────────────
// Hai đường tạo ticket phải làm CÙNG một bộ việc sau khi tạo (binding để worker
// báo ngược, ảnh đính kèm, dọn bản nháp và nút chờ) và cùng một khoá chống bấm
// đúp. Trước đây intake_step tự làm lại một nửa: ticket ra không có binding,
// không có ảnh, nút xác nhận không bao giờ hiện trên Telegram.

const chatLocks = new Map<string, Promise<void>>();

/** Khoá theo chat, gộp "telegram:123" và "123" về một. */
export function chatLockKey(chatId: string | number): string {
  const raw = String(chatId).trim();
  const m = /^(?:telegram:|tg:)?(-?\d+)$/i.exec(raw);
  return m ? m[1] : raw;
}

/**
 * Chạy `fn` tuần tự theo từng chat trong tiến trình này. Hai cú bấm xác nhận
 * đến gần như cùng lúc thì cú sau chờ cú trước xong, rồi thấy ticket đã tạo.
 * (Khác tiến trình thì chặn bằng `IntakeDocumentRepository.tryInsertRevision`.)
 */
export async function withChatLock<T>(chatId: string | number, fn: () => Promise<T>): Promise<T> {
  const key = chatLockKey(chatId);
  const prev = chatLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => (release = resolve));
  const chained = prev.then(() => current);
  chatLocks.set(key, chained);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (chatLocks.get(key) === chained) chatLocks.delete(key);
  }
}

/** Tải ảnh/video lên ticket vừa tạo và chèn vào mô tả. Lỗi từng file không chặn các file khác. */
export async function attachMediaToIssue(
  client: ItsaplanClient,
  baseUrl: string,
  issueId: number,
  description: string,
  mediaPaths: string[],
): Promise<UploadedAttachment[]> {
  if (mediaPaths.length === 0) return [];
  const uploaded = await uploadAttachments(client, issueId, baseUrl, mediaPaths);
  if (uploaded.length > 0) {
    const desc = spliceAttachmentsIntoDescription(description, uploaded);
    await client.updateIssue(issueId, { description: desc }).catch(() => {});
  }
  return uploaded;
}

/** Gắn ticket với chat để worker báo ngược Telegram khi IT phản hồi. */
export function bindIssueToChat(
  bindingRepo: TicketBindingRepository,
  issue: { id: number; identifier: string; title?: string },
  chatId: string | number,
  reporterUsername?: string,
): void {
  bindingRepo.saveBinding({
    issueId: issue.id,
    channelType: "telegram",
    chatId: String(chatId),
    messageId: "0",
    identifier: issue.identifier,
    title: issue.title,
    reporterUsername,
  });
}

/** Đã sang bước ghi thật: xoá nút chờ và bản nháp create_issue của chat. */
export function clearConfirmationState(
  chatId: string | number,
  draftRepo?: DraftSessionRepository,
  clearButtons: (chatId: string | number) => void = clearPendingButtons,
): void {
  clearButtons(chatId);
  if (draftRepo) {
    try {
      deleteDraft(draftRepo, chatId);
    } catch {
      // Không để lỗi xoá bản nháp làm hỏng việc tạo ticket
    }
  }
}

/** Trong khoảng này sau khi intake_step tạo ticket, create_issue(userConfirmed) coi là bấm lại cho cùng sự cố. */
export const INTAKE_DUPLICATE_WINDOW_MS = 30 * 60_000;

/**
 * Ticket intake_step đã tạo cho CHÍNH sự cố đang được xác nhận qua create_issue.
 *
 * Chỉ tính khi tài liệu mới nhất của chat đã `created` trong cửa sổ chống trùng,
 * và bản nháp create_issue (nếu có) không mới hơn lúc tạo — bản nháp mới hơn
 * nghĩa là người dùng đang báo một việc khác.
 */
export function findIntakeCreatedTicket(
  docRepo: IntakeDocumentRepository,
  chatId: string | number,
  draftSavedAt?: string,
  now: number = Date.now(),
): IntakeDocument | null {
  const doc = docRepo.getLatestByChatId(String(chatId));
  if (!doc || doc.status !== "created" || !doc.issueId || !doc.issueIdentifier) return null;
  const createdAt = Date.parse(doc.issueCreatedAt ?? doc.updatedAt);
  if (Number.isNaN(createdAt) || now - createdAt > INTAKE_DUPLICATE_WINDOW_MS) return null;
  const draftTs = parseSqliteTimestamp(draftSavedAt);
  if (draftTs !== null && draftTs > createdAt) return null;
  return doc;
}

/**
 * Những khoá không mang nội dung ticket — danh tính người báo và cờ xác nhận.
 * Dùng để phân biệt "model gọi tạo ticket kèm đủ dữ liệu" với "người dùng vừa
 * bấm nút xác nhận", vì cú bấm chỉ mang đúng chừng này.
 */
const CONTROL_KEYS = new Set([
  "userConfirmed",
  "reporterChatId",
  "telegramUserId",
  "reporterName",
  "reporterUsername",
  "reporterNameCode",
]);

/**
 * Giá trị "có tên trường nhưng không mang nội dung".
 *
 * Chuỗi trắng và mảng rỗng tính là trống: ở lượt xác nhận model hay gửi lại
 * đúng bộ khoá của bước tóm tắt nhưng để rỗng hết.
 */
function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Cú bấm nút xác nhận trần: không kèm một mẩu nội dung ticket nào. */
function isBareConfirmation(input: Record<string, unknown>): boolean {
  return Object.entries(input).every(([key, value]) => CONTROL_KEYS.has(key) || isBlank(value));
}

/**
 * Gộp bản nháp với tham số của lượt xác nhận. **Bản nháp thắng.**
 *
 * Ở lượt bấm nút, model không thuật lại nội dung ticket — nó chỉ xác nhận. Nội
 * dung đã chốt ở bước tóm tắt và nằm trong bản nháp; muốn sửa thì luồng bắt
 * phải tóm tắt lại (`userConfirmed: false`), và cú đó ghi đè bản nháp. Nên ở
 * đây bản nháp là nguồn đúng, `input` chỉ lấp chỗ bản nháp còn trống.
 *
 * Đo được ở PO-79 (16/09/2026): bước tóm tắt gửi đủ tiêu đề, vấn đề, phòng ban,
 * nhãn `Feature request`, mức ưu tiên `high`; bước xác nhận model gọi lại đúng
 * bộ khoá đó nhưng rỗng hết — trừ `urgency: "medium"` nó tự điền lại. Gộp nông
 * (`{...draft, ...input}`) cho cả chuỗi rỗng lẫn cái `"medium"` đó đè lên bản
 * nháp: ticket ra Itsaplan trắng trơn, tiêu đề rơi về "Order tính năng chưa có
 * tiêu đề", priority tụt từ `high` xuống `medium`.
 *
 * Cùng họ với lỗi `mediaPaths` ở TECH-637 — lần đó mới vá riêng cho ảnh.
 *
 * Ngoại lệ là `CONTROL_KEYS`: danh tính người báo và cờ xác nhận luôn lấy của
 * lượt hiện tại. Bản nháp được lưu lúc `userConfirmed: false`, tin nó thì cú
 * xác nhận tự huỷ chính mình.
 */
/**
 * Trích lời người báo cho bản xem trước, an toàn với Markdown của Telegram.
 *
 * Lời người gõ tay có thể chứa `*`, `_`, `` ` ``, `[`… — gửi thẳng ra sẽ làm
 * bản xem trước méo mó hoặc vỡ định dạng, và người báo xác nhận nhầm nội dung
 * khác với thứ được ghi. Vì vậy bọc `>` mỗi dòng (giống "### Mô tả" trên
 * ticket) và escape ký tự Markdown.
 */
export function quoteForPreview(text: string, maxChars = 600): string {
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
  return clipped
    .replace(/([\\`*_{}[\]()#+|>-])/g, "\\$1")
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
}

function mergeOverDraft(
  draft: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...draft };
  for (const [key, value] of Object.entries(input)) {
    if (CONTROL_KEYS.has(key)) {
      merged[key] = value;
    } else if (isBlank(draft[key]) && !isBlank(value)) {
      merged[key] = value;
    }
  }
  return merged;
}

export function createIssue<TShape extends z.ZodRawShape>(
  config: TrackerConfig,
  domain: IssueDomain<TShape>,
  dbPath?: string,
  confirmButtonLabel: string = "✅ Đúng rồi, xác nhận",
): AnyMcpTool {
  const client = new ItsaplanClient(config.baseUrl, config.apiKey);

  const inputSchema = {
    ...domain.inputShape,
    labels: z
      .array(z.string())
      .optional()
      .describe(
        "Nhãn thuộc danh sách có sẵn trên hệ thống (ví dụ: Feature request, Product Insight, Opportunity Brief). TUYỆT ĐỐI KHÔNG tự nghĩ ra nhãn mới.",
      ),
    userConfirmed: z
      .boolean()
      .default(false)
      .describe(
        "Người dùng đã xác nhận đồng ý tạo ticket chưa? " +
          "false khi đang tóm tắt để người dùng kiểm tra lại, " +
          "true chỉ khi người dùng đã duyệt/đồng ý tạo ticket.",
      ),
  };

  return defineTool({
    name: "create_issue",
    description: domain.description,
    inputSchema,
    handler: async (rawInput: any) => {
      // Phong bì kênh OpenClaw (chat_id, username, lịch sử hội thoại) không bao giờ vào ticket (TECH-924).
      const input: any = Object.fromEntries(
        Object.entries(rawInput ?? {}).map(([k, v]) => [
          k,
          typeof v === "string" ? stripChannelEnvelope(v) : v,
        ]),
      );
      const lockChatId = input.reporterChatId ?? input.telegramUserId;
      // Bước ghi thật đi qua cùng khoá chat với intake_step — chống bấm đúp và
      // chống hai đường cùng tạo ticket cho một sự cố.
      return input.userConfirmed && lockChatId
        ? withChatLock(lockChatId, () => handle(input))
        : handle(input);
    },
  });

  async function handle(input: any) {
    let effectiveInput = input;
    const targetChatId = input.reporterChatId ?? input.telegramUserId;

    // Khi người dùng bấm xác nhận (userConfirmed = true), nếu agent truyền thiếu tham số
    // (hoặc chỉ truyền userConfirmed = true và chatId), tự động khôi phục từ bản nháp SQLite đã lưu ở bước userConfirmed = false.
    if (input.userConfirmed && targetChatId && dbPath) {
      let draftState: Record<string, unknown> | null = null;
      let draftSavedAt: string | undefined;
      try {
        const draft = resolveDraft(getSharedDraftSessionRepo(dbPath), targetChatId);
        if (draft?.state && typeof draft.state === "object")
          draftState = draft.state as Record<string, unknown>;
        draftSavedAt = draft?.updatedAt;
      } catch (err) {
        getLogger().warn("create_issue: không đọc được bản nháp", {
          chatId: String(targetChatId),
          err: String(err),
        });
      }

      // intake_step (đường chính) đã tạo ticket cho sự cố này rồi → trả lại
      // đúng ticket đó thay vì tạo bản thứ hai.
      let intakeTicket: IntakeDocument | null = null;
      try {
        intakeTicket = findIntakeCreatedTicket(
          getSharedIntakeDocRepo(dbPath),
          targetChatId,
          draftSavedAt,
        );
      } catch (err) {
        getLogger().warn("create_issue: không đọc được IntakeDocument", {
          chatId: String(targetChatId),
          err: String(err),
        });
      }
      if (intakeTicket?.issueId && intakeTicket.issueIdentifier) {
        clearConfirmationState(targetChatId, getSharedDraftSessionRepo(dbPath));
        return {
          created: false,
          alreadyCreated: true,
          issue: {
            id: intakeTicket.issueId,
            identifier: intakeTicket.issueIdentifier,
            title: intakeTicket.fields.title?.value ?? "",
            url: intakeTicket.issueUrl,
          },
          message: `Dạ sự cố này em đã tạo ticket **${intakeTicket.issueIdentifier}** rồi ạ — anh/chị không cần tạo lại nhé.`,
        };
      }

      if (draftState) {
        effectiveInput = mergeOverDraft(draftState, input);
        // Đo được ở TECH-637: model gọi lại `create_issue` ở lượt xác nhận
        // kèm `mediaPaths` nhưng không nhớ đủ mọi đường dẫn ảnh đã gom ở
        // Bước 1 — ghi đè nông (`...input` đè lên `...draftState`) làm rớt
        // các ảnh mà bản nháp đã có. Gộp thay vì đè.
        const draftMedia = Array.isArray(draftState.mediaPaths)
          ? (draftState.mediaPaths as string[])
          : [];
        const inputMedia = Array.isArray(input.mediaPaths) ? (input.mediaPaths as string[]) : [];
        if (draftMedia.length > 0 || inputMedia.length > 0) {
          effectiveInput.mediaPaths = Array.from(new Set([...draftMedia, ...inputMedia]));
        }
      } else if (isBareConfirmation(input)) {
        // Bản nháp đã bị xoá ở lượt xác nhận trước, mà cú gọi này không mang
        // theo nội dung nào — tức là nút xác nhận bị bấm lại lần nữa. Dựng
        // ticket từ input rỗng thì ra một ticket trắng, nên trả lại đúng cái
        // vừa tạo. Telegram vẫn gửi callback cho nút cũ kể cả sau khi khoá,
        // và bản thân cú khoá nút cũng có lúc hỏng.
        const existing = getSharedBindingRepo(dbPath).getLatestBinding(
          String(targetChatId),
          undefined,
          config.projectKey,
        );
        if (existing) {
          clearPendingButtons(targetChatId);
          return {
            created: false,
            alreadyCreated: true,
            issue: { id: existing.issueId, identifier: existing.identifier, title: existing.title },
            message: `Dạ yêu cầu này em đã gửi Product team rồi ạ — mã **${existing.identifier}**. Anh/chị không cần bấm lại nhé.`,
          };
        }
      }
    }

    // Lưới cuối: không bản nháp, không nội dung, mà cũng không tra ra bản
    // ghi cũ nào. Dựng tiếp thì ra một ticket trắng gửi lên tracker — thà
    // xin lại thông tin còn hơn để team nhận một bản ghi rỗng. Đặt NGOÀI
    // nhánh có chatId: PO-88 (24/09) model gọi xác nhận trần không kèm chatId
    // và lọt qua lưới khi nó còn nằm trong nhánh đó.
    if (input.userConfirmed && isBareConfirmation(effectiveInput)) {
      return {
        created: false,
        needsConfirmation: true,
        message:
          "Dạ em xin lỗi, em bị mất phần thông tin vừa tóm tắt nên chưa gửi đi được ạ. " +
          "Anh/chị nhắn lại giúp em nội dung chính một lần nữa nhé, em ghi lại ngay.",
      };
    }
    const built = domain.build(effectiveInput);

    // TECH-1148: Chặn tạo ticket có tiêu đề hoặc mô tả rỗng hoặc chỉ là token nội bộ (noop)
    const candidateTitle = (built.title || effectiveInput.title || "").trim();
    const candidateContent = String(
      effectiveInput.rawText || effectiveInput.description || "",
    ).trim();
    const isInvalidTitle = !candidateTitle || isInternalCallbackToken(candidateTitle);
    const isInvalidContent = !candidateContent || isInternalCallbackToken(candidateContent);
    if (isInvalidTitle || isInvalidContent) {
      return {
        created: false,
        needsConfirmation: true,
        message:
          "Dạ em chưa nhận được nội dung mô tả sự cố cụ thể nên chưa tạo ticket được ạ. " +
          "Anh/chị nhắn lại giúp em nội dung sự cố nhé, em ghi lại ngay.",
      };
    }
    // Bước xác nhận: nếu chưa có xác nhận từ người dùng, trả về tóm tắt và đính nút bấm Telegram
    if (!input.userConfirmed) {
      if (targetChatId) {
        savePendingButtons(targetChatId, getConfirmationButtons(confirmButtonLabel));
        if (dbPath) {
          try {
            getSharedDraftSessionRepo(dbPath).saveDraft(String(targetChatId), input);
          } catch {
            // Không để lỗi lưu bản nháp làm hỏng bước xác nhận
          }
        }
      }

      const details: string[] = [];
      details.push(`- Tiêu đề: ${built.title}`);
      if (built.product) details.push(`- Sản phẩm: ${built.product}`);
      if (built.system) details.push(`- Hệ thống: ${built.system}`);
      const isPhone = (val?: string) =>
        Boolean(val && /^(?:\+84|0)[35789]\d{8}$/.test(val.replace(/[\s.-]+/g, "")));
      const phoneOrAcc =
        effectiveInput.studentId ??
        (isPhone(effectiveInput.customerId) ? effectiveInput.customerId : undefined);
      const validCustId =
        effectiveInput.customerId &&
        !isPhone(effectiveInput.customerId) &&
        effectiveInput.customerId !== effectiveInput.studentId
          ? effectiveInput.customerId
          : undefined;

      if (validCustId) details.push(`- Mã khách hàng: ${validCustId}`);
      if (phoneOrAcc) details.push(`- Tài khoản HS / SĐT: ${phoneOrAcc}`);
      if (effectiveInput.reportingDept) details.push(`- Bộ phận: ${effectiveInput.reportingDept}`);
      if (built.errorCategory) details.push(`- Phân loại lỗi: ${built.errorCategory}`);
      details.push(`- Mức ưu tiên: ${built.priority.toUpperCase()}`);

      // Nội dung sẽ ghi vào mục "### Mô tả" trên ticket. ADR-0008: người báo
      // phải thấy đúng thứ sẽ được ghi trước khi bấm xác nhận. Trước đây mô
      // tả không có trong bản xem trước, nên người báo xác nhận mà không thấy
      // lời của mình — TECH-1084 càng làm nặng vì mô tả giờ phải là NGUYÊN VĂN.
      const previewText = String(effectiveInput.rawText || effectiveInput.description || "").trim();
      // Khi model không đưa `rawText`, mô tả là bản nó viết lại — nói rõ để
      // người báo biết mình đang xác nhận lời tóm tắt chứ không phải lời mình.
      const isParaphrase = !effectiveInput.rawText;

      return {
        created: false,
        needsConfirmation: true,
        draft: {
          title: built.title,
          product: built.product,
          system: built.system,
          errorCategory: built.errorCategory,
          priority: built.priority,
        },
        message:
          built.confirmationMessage ??
          `**Em tóm tắt lại sự cố của anh/chị nhé ạ:**\n\n` +
            details.join("\n") +
            (previewText
              ? `\n\n**Nội dung sẽ ghi vào ticket:**\n${quoteForPreview(previewText)}\n` +
                (isParaphrase
                  ? `_Em tự tóm lại phần này. Nếu anh/chị muốn giữ đúng lời mình nói, anh/chị nhắn lại giúp em nhé ạ._`
                  : "")
              : "") +
            `\n\nAnh/chị vui lòng kiểm tra kỹ thông tin trước khi xác nhận. Nếu thông tin không chính xác, Tiểu Linh sẽ không thể phân loại đúng và đội Kỹ thuật sẽ gặp khó khăn trong việc xử lý.`,
      };
    }

    // Khi người dùng đã xác nhận, xóa nút chờ và bản nháp — đã sang bước ghi thật
    if (targetChatId) {
      let draftRepo: DraftSessionRepository | undefined;
      try {
        draftRepo = dbPath ? getSharedDraftSessionRepo(dbPath) : undefined;
      } catch {}
      clearConfirmationState(targetChatId, draftRepo);
    }

    const project = await resolveProject(client, config.projectKey);
    const column = await resolveBacklogColumn(client, project);

    // Phân loại lỗi -> Gán nhãn labelIds trên Itsaplan theo chuẩn Huly
    const category = built.errorCategory || effectiveInput.errorCategory;
    const additionalLabels = Array.isArray(effectiveInput.labels) ? effectiveInput.labels : [];
    const labelIds = await resolveLabelsForIssue(client, project.key, category, additionalLabels);

    // Tự động gán Issue Type mặc định (ví dụ Task)
    const rawProject = project.raw;
    const defaultType =
      rawProject.issueTypes?.find((t) => t.isDefault) ?? rawProject.issueTypes?.[0];
    const typeId = defaultType?.id ?? undefined;

    const issue = await client.createIssue(project.key, {
      title: built.title,
      description: built.description,
      columnId: column.id,
      priority: built.priority,
      typeId,
      labelIds: labelIds.length > 0 ? labelIds : undefined,
    });

    // Không ghi Related Tickets / link từ mã do model tự đưa (ADR-0007): ticket
    // tương tự chỉ đến từ cụm nguyên nhân người xác định trong KG, qua intake_step.

    // Tải lên ảnh/video đính kèm nếu có mediaPaths hoặc nếu tin nhắn có đề cập đến ảnh/video
    let mediaList: string[] = Array.isArray(effectiveInput.mediaPaths)
      ? effectiveInput.mediaPaths
      : Array.isArray(built.mediaPaths)
        ? built.mediaPaths
        : [];

    // Fallback: nếu mediaList rỗng nhưng mô tả hoặc tiêu đề nhắc tới ảnh / video / chụp màn hình
    if (mediaList.length === 0) {
      // Cần `rawText` nữa: sau khi tách nó ra (TECH-1084), lời người báo nhắc
      // "gửi ảnh giúp em" nằm ở tin nguyên văn, không còn trong `description`
      // mà model viết tóm — bỏ nó thì ảnh không được đính kèm.
      const textToCheck = [effectiveInput.title, effectiveInput.rawText, effectiveInput.description]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (
        textToCheck.includes("ảnh") ||
        textToCheck.includes("video") ||
        textToCheck.includes("chụp màn hình") ||
        textToCheck.includes("screenshot") ||
        textToCheck.includes("hình ảnh") ||
        textToCheck.includes("đính kèm")
      ) {
        const recent = findRecentInboundMedia(10, 3);
        if (recent.length > 0) {
          mediaList = recent;
          getLogger().info(
            `[create_issue] Đã tự động tìm thấy ${recent.length} file đính kèm gần đây trong inbound`,
          );
        }
      }
    }

    await attachMediaToIssue(client, config.baseUrl, issue.id, built.description, mediaList);

    // Suy luận kỹ thuật của bot nằm ở comment riêng, không lẫn vào mô tả
    // (TECH-1084). Phải đánh dấu `markBotComment` — nếu không, bot sẽ bị tính là
    // người thật: kg-sync/human-signals học gợi ý của bot thành "tri thức"
    // (human-signals.ts:1), và duplicate-merger có thể tự huỷ ticket vì bản
    // thân nó nhắc mã ticket đồng nghiệp. Best-effort: hỏng comment không được
    // làm hỏng cả ticket.
    const advice = buildAdviceComment(built.diagnosis, null);
    if (advice) {
      await client.addComment(issue.id, markBotComment(advice)).catch((err: any) => {
        getLogger().warn(
          `[create_issue] Không ghi được comment gợi ý cho ${issue.identifier}: ${err?.message ?? err}`,
        );
      });
    }

    const url = issueWebUrl(
      config.webUrl,
      project.key,
      issue.identifier,
      issue.sequenceNumber,
      project.raw,
    );

    // Lưu binding vào SQLite để worker báo ngược Telegram khi IT phản hồi
    if (targetChatId && dbPath) {
      try {
        bindIssueToChat(
          getSharedBindingRepo(dbPath),
          issue,
          targetChatId,
          effectiveInput.reporterUsername ?? effectiveInput.reporterNameCode,
        );

        // Đóng IntakeDocument đang MỞ của chat (nếu có) — tin nhắn sau thuộc về
        // ticket này hoặc một việc mới. Tài liệu đã đóng (huỷ, hết hạn, đã tạo
        // ticket khác) thì để yên: đánh dấu nó "created" là gán nhầm ticket.
        const intakeDocRepo = getSharedIntakeDocRepo(dbPath);
        const activeDoc = intakeDocRepo.getLatestByChatId(String(targetChatId));
        const nowIso = new Date().toISOString();
        const fresh =
          activeDoc && Date.now() - Date.parse(activeDoc.updatedAt) <= INTAKE_DRAFT_TTL_MS;
        if (activeDoc && fresh && !CLOSED_STATUSES.has(activeDoc.status)) {
          intakeDocRepo.saveRevision({
            ...activeDoc,
            revision: activeDoc.revision + 1,
            status: "created",
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            issueUrl: url,
            issueCreatedAt: nowIso,
            updatedAt: nowIso,
          });
        }
      } catch {
        // Không để lỗi ghi binding làm hỏng kết quả tạo ticket
      }
    }

    return {
      created: true,
      issue: { id: issue.id, identifier: issue.identifier, title: issue.title, url },
      message: built.confirmation
        .replaceAll("{identifier}", issue.identifier)
        .replaceAll("{url}", url ?? ""),
    };
  }
}

/** Danh tính người báo, do host cấp chứ không phải model tự nghĩ ra. */
export const reporterShape = {
  reporterName: z.string().describe("Tên người báo, do khung chat cung cấp"),
  reporterUsername: z.string().optional().describe("Username trên kênh chat, nếu có"),
  reporterNameCode: z.string().optional().describe("Name code nội bộ đã được duyệt, nếu có"),
  reporterChatId: z
    .string()
    .optional()
    .describe("Chat ID Telegram của người báo, do host cung cấp"),
  telegramUserId: z
    .string()
    .optional()
    .describe("User ID Telegram của người báo, do host cung cấp"),
};
