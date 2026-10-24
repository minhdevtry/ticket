import { z } from "zod";
import { openLazyDb } from "../../../lib/storage/lazy-db";
import { memoByKey } from "../../../lib/storage/memo";
import { getSharedBindingRepo } from "../../../lib/storage/binding-repository";
import { getSharedDraftSessionRepo } from "../../../lib/storage/session-repository";
import { IdentityRepository } from "../../../lib/storage/identity-repository";
import { IdentityService } from "../../../lib/storage/identity.service";
import {
  setLastActiveChatId,
  savePendingButtons,
  getBranchButtons,
} from "../../../lib/telegram/buttons";
import { defineTool, type AnyMcpTool } from "../tool";

/**
 * Ticket cũ quá thì không còn là "đang trao đổi" nữa — trả về vẫn dễ khiến
 * model ghi nhầm việc mới vào đó khi phiên chat vừa bị reset (idle timeout,
 * `/new`). Quá mốc này thì coi như không có, để model hỏi lại mã.
 */
const RECENT_TICKET_WINDOW_MS = 30 * 60 * 1000;

function isRecentSqliteTimestamp(value: string | undefined): boolean {
  if (!value) return false;
  const isoLike = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(isoLike).getTime();
  if (Number.isNaN(parsed)) return false;
  return Date.now() - parsed <= RECENT_TICKET_WINDOW_MS;
}

export interface IdentityConfig {
  /** File SQLite giữ danh tính. Server tự mở, tự tạo thư mục nếu chưa có. */
  dbPath: string;
  /** Tiền tố mã của bot (`PO`, `TECH`) — `latestTicket` chỉ lấy ticket của dự án này. */
  projectKey?: string;
  adminIds?: string[];
  requireApproval?: boolean;
  approvedInvite?: string;
  initialButtons?: () => import("../../../lib/telegram/buttons").TelegramButton[][];
}

/**
 * Mở lười và dùng chung.
 *
 * Trước đây mỗi tool gọi hàm này lúc đăng ký, nên bốn tool định danh mở bốn
 * connection ngay khi khởi động — và server chết ngay nếu thư mục chứa file
 * chưa tồn tại, tức là ở mọi lần triển khai mới.
 */
const service = memoByKey<IdentityConfig, IdentityService>(
  (config) => config.dbPath,
  (config) =>
    new IdentityService(new IdentityRepository(openLazyDb(config.dbPath)), {
      adminIds: config.adminIds,
      requireApproval: config.requireApproval,
      approvedInvite: config.approvedInvite,
    }),
);

/** Ai đang nhắn, đã được duyệt chưa, và ticket gần nhất đã tạo là gì. */
export function checkIdentity(config: IdentityConfig): AnyMcpTool {
  return defineTool({
    name: "check_identity",
    description:
      "Kiểm tra người đang nhắn đã được duyệt name code chưa, đồng thời lấy ticket gần nhất trong 30 phút đổ lại " +
      "(nếu có) và bản nháp ticket đang gom dở nếu phiên trước bị ngắt giữa chừng. " +
      "Gọi trước khi ghi bản ghi mới hoặc khi người dùng hỏi tiến độ/giục gấp mà không nêu mã ticket. " +
      "`latestTicket` chỉ là gợi ý — LUÔN hỏi lại người dùng để xác nhận trước khi dùng nó để bổ sung hay giục gấp, " +
      "TUYỆT ĐỐI không tự ý ghi vào đó.",
    inputSchema: {
      telegramUserId: z.string().describe("Id người dùng trên kênh chat, do host cung cấp"),
      chatId: z
        .string()
        .optional()
        .describe("Chat ID Telegram của cuộc hội thoại, nếu khác telegramUserId"),
    },
    handler: ({ telegramUserId, chatId }) => {
      const targetChatId = chatId ?? telegramUserId;
      setLastActiveChatId(targetChatId);
      const approval = service(config).checkUserApproval(telegramUserId);

      let latestTicket: {
        identifier: string;
        title?: string;
        issueId: number;
        updatedAt?: string;
        needsConfirmation: true;
      } | null = null;
      try {
        const repo = getSharedBindingRepo(config.dbPath);
        const binding = repo.getLatestBinding(
          targetChatId,
          approval.identity?.username ?? approval.identity?.nameCode,
          config.projectKey,
        );
        if (binding && isRecentSqliteTimestamp(binding.updatedAt)) {
          latestTicket = {
            identifier: binding.identifier,
            title: binding.title,
            issueId: binding.issueId,
            updatedAt: binding.updatedAt,
            needsConfirmation: true,
          };
        }
      } catch {
        // Không để lỗi đọc binding làm hỏng kiểm tra danh tính
      }

      let pendingDraft: { state: Record<string, unknown>; updatedAt?: string } | null = null;
      try {
        const draft = getSharedDraftSessionRepo(config.dbPath).getDraft(targetChatId);
        if (draft && isRecentSqliteTimestamp(draft.updatedAt)) {
          pendingDraft = { state: draft.state, updatedAt: draft.updatedAt };
        }
      } catch {
        // Không để lỗi đọc bản nháp làm hỏng kiểm tra danh tính
      }

      if (config.initialButtons && approval.isApproved && targetChatId && !pendingDraft) {
        savePendingButtons(targetChatId, config.initialButtons());
      }

      return {
        ...approval,
        latestTicket,
        pendingDraft,
      };
    },
  });
}

/** Đăng ký name code mới, có thể tự duyệt nếu tiền tố đã nằm trong danh sách cho phép. */
export function registerIdentity(config: IdentityConfig): AnyMcpTool {
  return defineTool({
    name: "register_identity",
    description:
      "Đăng ký name code cho người dùng chưa có. Gọi khi người dùng cung cấp name code " +
      'theo dạng "CS_user_a".',
    inputSchema: {
      telegramUserId: z.string().describe("Id người dùng trên kênh chat, do host cung cấp"),
      nameCode: z.string().describe('Name code người dùng khai, dạng "CS_user_a"'),
      fullName: z.string().optional().describe("Tên hiển thị"),
      username: z.string().optional().describe("Username trên kênh chat"),
      pendingReport: z
        .string()
        .optional()
        .describe("Nội dung họ đang định báo, giữ lại để xử lý sau khi duyệt"),
    },
    handler: (input) => service(config).registerIdentity(input),
  });
}

/** Quản trị viên duyệt một name code đang chờ. */
export function approveUser(config: IdentityConfig): AnyMcpTool {
  return defineTool({
    name: "approve_user",
    description: "Duyệt name code đang chờ. Chỉ quản trị viên gọi được.",
    inputSchema: {
      telegramUserId: z.string().describe("Id người được duyệt"),
      approvedBy: z.string().describe("Id quản trị viên thực hiện, do host cung cấp"),
    },
    handler: ({ telegramUserId, approvedBy }) => {
      if (!service(config).isAdmin(approvedBy)) {
        return {
          success: false,
          message: "Chỉ Quản trị viên mới thao tác được ạ.",
          reason: "not_admin",
        };
      }
      return service(config).approveUser(telegramUserId, approvedBy);
    },
  });
}

/** Quản trị viên từ chối một name code đang chờ. */
export function rejectUser(config: IdentityConfig): AnyMcpTool {
  return defineTool({
    name: "reject_user",
    description: "Từ chối name code đang chờ. Chỉ quản trị viên gọi được.",
    inputSchema: {
      telegramUserId: z.string().describe("Id người bị từ chối"),
      rejectedBy: z.string().describe("Id quản trị viên thực hiện, do host cung cấp"),
    },
    handler: ({ telegramUserId, rejectedBy }) => {
      if (!service(config).isAdmin(rejectedBy)) {
        return {
          success: false,
          message: "Chỉ Quản trị viên mới thao tác được ạ.",
          reason: "not_admin",
        };
      }
      return service(config).rejectUser(telegramUserId);
    },
  });
}
