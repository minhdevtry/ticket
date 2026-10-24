import { z } from "zod";
import { createItsaplanClient } from "../../../lib/itsaplan/client-factory";
import { findIssueByIdentifier, resolveProject } from "@vuihoc/bot-core/itsaplan";
import { uploadAttachments } from "../../../lib/itsaplan/upload";
import {
  spliceAttachmentsIntoDescription,
  formatAttachmentMarkdown,
} from "../../../lib/itsaplan/upload";
import { findRecentInboundMedia } from "../../../lib/media";
import { resolveFriendlyStatusName } from "@vuihoc/bot-core/itsaplan";
import { describeState } from "../../../lib/itsaplan/state-messages";
import { isOwnTicket } from "../../../lib/itsaplan/ownership";
import { getSharedBindingRepo } from "../../../lib/storage/binding-repository";
import { appendTicketUpdateDescription } from "../../../lib/formatting.local";
import { markBotComment, stripCommentHtml } from "@vuihoc/bot-core/core";
import {
  clearPendingButtons,
  getLastActiveChatId,
  savePendingButtons,
} from "../../../lib/telegram/buttons";
import { alertAdmin } from "../../../lib/telegram/alert";
import { defineTool, type AnyMcpTool } from "@vuihoc/bot-core/core";

export interface TrackerConfig {
  baseUrl: string;
  apiKey: string;
  projectKey: string;
  webUrl?: string;
}

/**
 * Từ vựng của bot đang gọi. Trước đây chỗ này hard-code theo Tiểu Linh, nên
 * IRIS — vốn dùng chung hai tool này — đi bảo người dùng nhập mã "TECH-42"
 * trong khi bản ghi của IRIS mang tiền tố "PO", và xưng "đội Kỹ thuật" cho
 * việc thuộc team Sản phẩm. Mặc định giữ nguyên lời Tiểu Linh để bot đó không
 * đổi chữ nào.
 */
export interface IssueVocabulary {
  /** Danh từ gọi bản ghi: "ticket" với Tiểu Linh, "yêu cầu" với IRIS. */
  noun: string;
  /** Đội xử lý, nhắc tới khi bản ghi đã xong và chờ người báo xác nhận. */
  handlerTeam: string;
  /** Tên hiển thị khi tracker không trả về tên tác giả bình luận. */
  commentAuthorFallback: string;
}

export const DEFAULT_ISSUE_VOCABULARY: IssueVocabulary = {
  noun: "ticket",
  handlerTeam: "Kỹ thuật",
  commentAuthorFallback: "Kỹ thuật viên",
};

/** Chỉ IRIS bật: tra cứu / bổ sung chỉ trên yêu cầu CỦA CHÍNH người đang chat, ai gửi cũng được tôn trọng như nhau. */
export interface OwnTicketsOnlyOptions {
  ownTicketsOnly?: boolean;
}

export interface UpdateIssueOptions extends OwnTicketsOnlyOptions {
  /** Bổ sung phải qua bản xem trước + nút bấm (ADR-0008 / IRIS 01/10). */
  requireConfirmation?: boolean;
}

/** Bao nhiêu trao đổi gần nhất đọc lại cho người dùng. */
const MAX_COMMENTS = 3;

/** Tra một bản ghi theo mã hiển thị hoặc theo ticket gần nhất của người dùng. */
export function getIssue(
  config: TrackerConfig,
  dbPath?: string,
  vocabulary: IssueVocabulary = DEFAULT_ISSUE_VOCABULARY,
  options: OwnTicketsOnlyOptions = {},
): AnyMcpTool {
  const client = createItsaplanClient(config.baseUrl, config.apiKey);
  const sampleId = `${config.projectKey}-42`;
  return defineTool({
    name: "get_issue",
    description:
      "Tra tiến độ, người phụ trách và toàn bộ trao đổi của một bản ghi theo mã " +
      `(ví dụ "${sampleId}") hoặc tra ${vocabulary.noun} gần nhất nếu người dùng không nhớ mã. ` +
      "Dùng khi người dùng hỏi tiến độ hoặc nhắc tới một mã.",
    inputSchema: {
      identifier: z
        .string()
        .optional()
        .describe(
          `Mã hiển thị, ví dụ "${sampleId}". Nếu để trống sẽ tự lấy ${vocabulary.noun} gần nhất qua chatId.`,
        ),
      chatId: z
        .string()
        .optional()
        .describe("Chat ID Telegram của người dùng để tra ticket gần nhất nếu thiếu mã"),
    },
    handler: async ({ identifier, chatId }) => {
      const targetChatId = chatId ?? getLastActiveChatId();
      if (targetChatId) {
        clearPendingButtons(targetChatId);
      }

      let target = identifier?.trim().toUpperCase();
      if (!target && chatId && dbPath) {
        try {
          const binding = getSharedBindingRepo(dbPath).getLatestBinding(
            chatId,
            undefined,
            config.projectKey,
          );
          if (binding?.identifier) {
            target = binding.identifier.trim().toUpperCase();
          }
        } catch {
          // Bỏ qua lỗi db
        }
      }

      if (!target) {
        return {
          found: false,
          reason: "missing_identifier",
          message: `Dạ anh/chị cho em xin mã ${vocabulary.noun} (ví dụ ${sampleId}) để em kiểm tra tiến độ giúp mình nhé ạ!`,
        };
      }

      const issue = await findIssueByIdentifier(client, target, config.projectKey);
      if (!issue) return { found: false, identifier: target };

      if (options.ownTicketsOnly) {
        let repo: ReturnType<typeof getSharedBindingRepo> | undefined;
        try {
          repo = dbPath ? getSharedBindingRepo(dbPath) : undefined;
        } catch {
          repo = undefined;
        }
        let description: string | undefined = issue.description;
        if (!description)
          description = (await client.getIssue(issue.id).catch(() => null))?.description;
        if (!isOwnTicket(repo, issue.identifier || target, description, chatId)) {
          // Không kể gì về yêu cầu người khác, kể cả tiêu đề (PO 01/10).
          return {
            found: false,
            reason: "not_yours",
            identifier: target,
            message: `Dạ em chỉ tra được ${vocabulary.noun} anh/chị đã gửi thôi ạ. Anh/chị cho em mã ${vocabulary.noun} của mình (ví dụ ${sampleId}) nhé!`,
          };
        }
      }

      let statusName = "Chờ xử lý";
      let stateCategory = "unstarted";

      try {
        const project = await resolveProject(client, config.projectKey);
        const column = project.columns.find((c) => c.id === issue.columnId);
        if (column) {
          stateCategory = column.stateType || (column as any).category || "unstarted";
          statusName =
            describeState(config.projectKey, column.name) ??
            resolveFriendlyStatusName(column.name, stateCategory);
        }
      } catch {
        // Fallback giữ nguyên mặc định
      }

      const isResolved =
        stateCategory === "resolved" ||
        statusName.includes("chờ duyệt") ||
        statusName.toLowerCase().includes("resolved");

      const resolvedNote = isResolved
        ? `\n• Lưu ý: ${vocabulary.handlerTeam} đã xử lý xong. Anh/chị kiểm tra lại và ấn xác nhận giúp em nhé ạ.`
        : "";

      const formatIct = (dateStr?: string) => {
        if (!dateStr) return "";
        try {
          return new Date(dateStr).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
        } catch {
          return dateStr;
        }
      };

      // Không có API list-comment riêng: comment nằm trong timeline lẫn với
      // các sự kiện khác. Timeline hỏng thì vẫn trả trạng thái, vì đó mới là
      // thứ người dùng hỏi.
      const timeline = await client.getIssueTimeline(issue.id).catch(() => []);
      const comments = timeline
        .filter((item: any) => item?.kind === "comment" && item?.body)
        .slice(-MAX_COMMENTS)
        .map((item: any) => ({
          author: item.author?.name ?? item.author ?? vocabulary.commentAuthorFallback,
          body: stripCommentHtml(item.body),
          createdAt: formatIct(item.createdAt),
        }));

      const lastUpdated = formatIct(issue.updatedAt || issue.createdAt);

      return {
        found: true,
        identifier: issue.identifier || target,
        issue: {
          ...issue,
          statusName,
          statusCategory: stateCategory,
          isResolved,
          createdIct: formatIct(issue.createdAt),
          updatedIct: lastUpdated,
        },
        status: {
          name: statusName,
          category: stateCategory,
          isResolved,
        },
        comments,
        humanSummary:
          `${vocabulary.noun} **${issue.identifier || target}**: ${issue.title}\n` +
          `• Trạng thái: **${statusName}**\n` +
          `• Mức ưu tiên: ${(issue.priority || "medium").toUpperCase()}\n` +
          `• Cập nhật lần cuối: ${lastUpdated}${resolvedNote}`,
      };
    },
  });
}

/** Nội dung bổ sung đã soạn — lưu lại giữa bước xem trước và bước xác nhận. */
interface UpdatePayload {
  note: string;
  studentAccount?: string;
  device?: string;
  appVersion?: string;
  roomId?: string;
  mediaPaths: string[];
  priority?: "low" | "medium" | "high" | "urgent";
}

/**
 * Bổ sung thông tin vào một bản ghi đã có.
 *
 * `requireConfirmation` (IRIS, PO 01/10): gọi lần đầu chỉ soạn bản xem trước + nút bấm, KHÔNG ghi;
 * gọi lại với `userConfirmed: true` mới ghi đúng bản đã xem (lấy từ DB, không tin tham số agent truyền lại).
 */
export function updateIssue(
  config: TrackerConfig,
  dbPath?: string,
  vocabulary: IssueVocabulary = DEFAULT_ISSUE_VOCABULARY,
  options: UpdateIssueOptions = {},
): AnyMcpTool {
  const client = createItsaplanClient(config.baseUrl, config.apiKey);
  const sampleId = `${config.projectKey}-42`;
  const repo = () => (dbPath ? getSharedBindingRepo(dbPath) : undefined);

  /** Ghi thật vào Itsaplan (mô tả + comment). */
  async function write(issue: any, target: string, p: UpdatePayload) {
    const uploadedAttachments =
      p.mediaPaths.length > 0
        ? await uploadAttachments(client, issue.id, config.baseUrl, p.mediaPaths)
        : [];

    // Lấy description mới nhất và bổ sung log
    let desc = issue.description || "";
    try {
      const fresh = await client.getIssue(issue.id);
      if (fresh?.description) desc = fresh.description;
    } catch {}

    let updatedDesc = appendTicketUpdateDescription(desc, {
      additionalNotes: p.note,
      studentAccount: p.studentAccount,
      device: p.device,
      appVersion: p.appVersion,
      roomId: p.roomId,
    });
    updatedDesc = spliceAttachmentsIntoDescription(updatedDesc, uploadedAttachments);

    // Ghi thẳng ra đây thay vì `.catch(() => {})`: bot trước đây luôn báo
    // "đã cập nhật" dù `updateIssue`/`addComment` hỏng — người dùng tin
    // thông tin đã vào ticket trong khi Itsaplan không có gì mới (đo được ở
    // TECH-548: sale hỏi lại mã KH, Tiểu Linh không để lại vết nào).
    let descriptionSaved = true;
    try {
      await client.updateIssue(issue.id, {
        description: updatedDesc,
        ...(p.priority ? { priority: p.priority } : {}),
      });
    } catch (err: any) {
      descriptionSaved = false;
      alertAdmin(
        "update-issue-mo-ta-hong",
        `update_issue: ghi mô tả hỏng cho ${issue.identifier || target}: ${err?.message ?? err}`,
      );
    }

    let commentBody = p.note;
    if (uploadedAttachments.length > 0)
      commentBody += "\n\n" + uploadedAttachments.map(formatAttachmentMarkdown).join("\n\n");
    let commentSaved = true;
    try {
      await client.addComment(issue.id, markBotComment(commentBody));
    } catch (err: any) {
      commentSaved = false;
      alertAdmin(
        "update-issue-comment-hong",
        `update_issue: ghi comment hỏng cho ${issue.identifier || target}: ${err?.message ?? err}`,
      );
    }

    if (!descriptionSaved && !commentSaved) {
      return {
        updated: false,
        reason: "write_failed",
        identifier: issue.identifier || target,
        message: `Dạ em vừa thử cập nhật ${vocabulary.noun} **${issue.identifier || target}** nhưng hệ thống báo lỗi, thông tin chưa vào được ạ. Anh/chị đợi em thử lại hoặc báo trực tiếp trên ticket giúp em nhé.`,
      };
    }
    return {
      updated: true,
      identifier: issue.identifier || target,
      descriptionSaved,
      commentSaved,
      message: `Dạ em đã cập nhật bổ sung thông tin vào ${vocabulary.noun} **${issue.identifier || target}** rồi nhé ạ.`,
    };
  }

  return defineTool({
    name: "update_issue",
    description:
      "Bổ sung / đính chính thông tin vào MỘT BẢN GHI CỦA CHÍNH NGƯỜI DÙNG. TUYỆT ĐỐI KHÔNG dùng khi " +
      "người dùng trình bày một sự cố/yêu cầu hoàn toàn mới — việc mới thì LUÔN LUÔN tạo bản ghi mới. " +
      "Bắt buộc truyền `identifier` — nếu chưa chắc là mã nào, hỏi lại người dùng chứ không tự đoán. " +
      (options.requireConfirmation
        ? "KHÔNG ghi ngay: gọi lần đầu (userConfirmed=false) chỉ trả bản xem trước + nút xác nhận; gửi nguyên văn `message` cho người dùng. " +
          "Khi người dùng bấm nút xác nhận mới gọi lại với userConfirmed=true và chatId. Người dùng bấm Huỷ thì gọi với cancel=true."
        : ""),
    inputSchema: {
      // Bắt buộc mã khi ghi thẳng; khi cần xác nhận thì bước "bấm nút" không truyền lại mã/nội dung (lấy từ bản đã xem).
      identifier: (options.requireConfirmation ? z.string().optional() : z.string()).describe(
        `Mã hiển thị, ví dụ "${sampleId}". Chưa chắc chắn thì phải hỏi lại người dùng trước, không được để trống rồi đoán.`,
      ),
      note: (options.requireConfirmation ? z.string().optional() : z.string()).describe(
        "Nội dung người dùng bổ sung / đính chính, nguyên văn",
      ),
      studentAccount: z
        .string()
        .optional()
        .describe("Tài khoản học sinh hoặc SĐT phụ huynh mới bổ sung"),
      device: z.string().optional().describe("Thiết bị sử dụng bổ sung"),
      appVersion: z.string().optional().describe("Phiên bản app bổ sung"),
      roomId: z.string().optional().describe("Mã phòng học / lớp bổ sung"),
      mediaPaths: z
        .array(z.string())
        .optional()
        .describe("Danh sách đường dẫn file ảnh bổ sung cần đính kèm"),
      priority: z
        .enum(["low", "medium", "high", "urgent"])
        .optional()
        .describe("Mức ưu tiên mới, chỉ đặt khi người dùng yêu cầu rõ"),
      chatId: z
        .string()
        .optional()
        .describe("Chat ID Telegram của người dùng (bắt buộc khi cần xác nhận)"),
      userConfirmed: z
        .boolean()
        .optional()
        .describe("true khi người dùng đã bấm nút xác nhận bản xem trước"),
      cancel: z.boolean().optional().describe("true khi người dùng bấm Huỷ bản xem trước"),
    },
    handler: async (input) => {
      const { identifier, note, studentAccount, device, appVersion, roomId, mediaPaths, priority } =
        input;
      const chatId = input.chatId ?? getLastActiveChatId() ?? undefined;
      const confirming = options.requireConfirmation === true;

      // ── Bước xác nhận (IRIS) ────────────────────────────────────────────
      if (confirming && input.cancel) {
        if (chatId) {
          repo()?.clearPendingUpdate(chatId);
          clearPendingButtons(chatId);
        }
        return {
          updated: false,
          cancelled: true,
          message: "Dạ vâng, em không ghi gì thêm vào yêu cầu ạ.",
        };
      }

      if (confirming && input.userConfirmed) {
        const pending = chatId ? repo()?.getPendingUpdate<UpdatePayload>(chatId) : null;
        if (!chatId || !pending) {
          return {
            updated: false,
            reason: "no_pending",
            message:
              "Dạ em chưa có nội dung nào đang chờ xác nhận ạ. Anh/chị gửi lại phần cần bổ sung giúp em nhé.",
          };
        }
        const issue = await findIssueByIdentifier(client, pending.identifier, config.projectKey);
        if (!issue) return { updated: false, reason: "not_found", identifier: pending.identifier };
        repo()?.clearPendingUpdate(chatId);
        clearPendingButtons(chatId);
        return write(issue, pending.identifier, pending.payload);
      }

      // ── Soạn bản bổ sung ────────────────────────────────────────────────
      if (!identifier?.trim() || !note?.trim()) {
        return {
          updated: false,
          reason: "missing_input",
          message: `Dạ anh/chị cho em xin mã ${vocabulary.noun} (ví dụ ${sampleId}) và nội dung cần bổ sung nhé ạ.`,
        };
      }
      const target = identifier.trim().toUpperCase();
      const issue = await findIssueByIdentifier(client, target, config.projectKey);
      if (!issue) return { updated: false, reason: "not_found", identifier: target };

      if (options.ownTicketsOnly) {
        let description: string | undefined = issue.description;
        if (!description)
          description = (await client.getIssue(issue.id).catch(() => null))?.description;
        if (!isOwnTicket(repo(), issue.identifier || target, description, chatId)) {
          return {
            updated: false,
            reason: "not_yours",
            identifier: target,
            message: `Dạ ${vocabulary.noun} này không phải của anh/chị nên em không bổ sung vào được ạ.`,
          };
        }
      }

      // Ảnh người dùng nhắc tới mà agent quên truyền đường dẫn
      let mediaList: string[] = Array.isArray(mediaPaths) ? mediaPaths : [];
      if (mediaList.length === 0) {
        const textToCheck = `${note || ""}`.toLowerCase();
        if (
          ["ảnh", "video", "chụp màn hình", "screenshot", "hình ảnh", "đính kèm"].some((w) =>
            textToCheck.includes(w),
          )
        ) {
          const recent = findRecentInboundMedia(10, 3);
          if (recent.length > 0) mediaList = recent;
        }
      }
      const payload: UpdatePayload = {
        note,
        studentAccount,
        device,
        appVersion,
        roomId,
        mediaPaths: mediaList,
        priority,
      };

      if (confirming) {
        if (!chatId || !repo()) {
          return {
            updated: false,
            reason: "missing_chat",
            message:
              "Dạ em chưa xác định được cuộc trò chuyện để xin xác nhận, anh/chị nhắn lại giúp em nhé ạ.",
          };
        }
        const id = issue.identifier || target;
        repo()!.savePendingUpdate(chatId, id, payload);
        const label = `✅ Bổ sung vào ${id}`;
        savePendingButtons(chatId, [
          [{ text: label, callback_data: label }],
          [{ text: "Huỷ", callback_data: "Huỷ" }],
        ]);
        const quoted = `\n\n> ${(note.length > 500 ? `${note.slice(0, 500)}…` : note).replace(/\n/g, "\n> ")}`;
        const files = mediaList.length > 0 ? `\n(kèm ${mediaList.length} ảnh/tệp)` : "";
        return {
          updated: false,
          needsConfirmation: true,
          identifier: id,
          message: `Dạ anh/chị xác nhận giúp em: bổ sung vào ${vocabulary.noun} ${id}${issue.title ? ` «${issue.title}»` : ""} nội dung sau nhé?${quoted}${files}`,
        };
      }

      return write(issue, target, payload);
    },
  });
}
