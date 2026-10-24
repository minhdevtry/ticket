/**
 * Optional MCP tool factory (ticket A1): exposes the identity lifecycle
 * (check / register / approve / reject / relink) as MCP tools on core's
 * scaffold via `defineTool`. Imports ONLY `../core`.
 *
 * This MIRRORS intake's `mcp/shared/tools/identity.ts`, with one deliberate
 * difference: intake's service baked Vietnamese copy into every result, so its
 * tool returned the service result verbatim. Here the service is copy-free, so
 * the tool takes an INJECTED copy renderer and renders a `message` from the
 * structured result the service returns. A bot passes its own renderer (see
 * examples/tieulinh/identity-copy.ts); the library ships none.
 */
import { z } from "zod";
import { defineTool, type AnyMcpTool } from "../core";
import type { IdentityService, IdentityCheckResult, RegistrationResult, ApprovalMutationResult } from "./service";
import { relinkIdentity, type RelinkResult, type RelinkOptions } from "./relink";
import type { IdentityRepository } from "./repository";

/**
 * Renders user-facing copy from the structured results of each lifecycle step.
 * Every method returns the Vietnamese (or any-language) line the bot shows.
 */
export interface IdentityCopyRenderer {
  check(result: IdentityCheckResult): string;
  register(result: RegistrationResult): string;
  approve(result: ApprovalMutationResult): string;
  reject(result: ApprovalMutationResult): string;
  relink(result: RelinkResult): string;
  /** Shown when a non-admin calls approve/reject. */
  notAdmin(): string;
}

export interface IdentityToolsConfig {
  service: IdentityService;
  repo: IdentityRepository;
  copy: IdentityCopyRenderer;
  /** Guard + protected ids for relink; wired by the bot. */
  relink: RelinkOptions;
}

/** Check whether the current user is approved. */
export function checkIdentityTool(config: IdentityToolsConfig): AnyMcpTool {
  return defineTool({
    name: "check_identity",
    description:
      "Kiểm tra người đang nhắn đã được duyệt name code chưa. Gọi trước khi ghi bản ghi mới.",
    inputSchema: {
      userId: z.string().describe("Id người dùng trên kênh chat, do host cung cấp"),
    },
    handler: ({ userId }) => {
      const result = config.service.checkUserApproval(userId);
      return { ...result, message: config.copy.check(result) };
    },
  });
}

/** Register a new name code (may auto-approve by prefix / admin / open mode). */
export function registerIdentityTool(config: IdentityToolsConfig): AnyMcpTool {
  return defineTool({
    name: "register_identity",
    description: 'Đăng ký name code cho người dùng chưa có, dạng "CS_example".',
    inputSchema: {
      userId: z.string().describe("Id người dùng trên kênh chat, do host cung cấp"),
      nameCode: z.string().describe('Name code người dùng khai, dạng "CS_example"'),
      fullName: z.string().optional().describe("Tên hiển thị"),
      username: z.string().optional().describe("Username trên kênh chat"),
      pendingReport: z.string().optional().describe("Nội dung họ đang định báo, giữ lại để xử lý sau khi duyệt"),
    },
    handler: (input) => {
      const result = config.service.registerIdentity(input);
      return { ...result, message: config.copy.register(result) };
    },
  });
}

/** Admin-only: approve a pending name code. */
export function approveUserTool(config: IdentityToolsConfig): AnyMcpTool {
  return defineTool({
    name: "approve_user",
    description: "Duyệt name code đang chờ. Chỉ quản trị viên gọi được.",
    inputSchema: {
      userId: z.string().describe("Id người được duyệt"),
      approvedBy: z.string().describe("Id quản trị viên thực hiện, do host cung cấp"),
    },
    handler: ({ userId, approvedBy }) => {
      if (!config.service.isAdmin(approvedBy)) {
        return { success: false, reason: "not_admin", message: config.copy.notAdmin() };
      }
      const result = config.service.approveUser(userId, approvedBy);
      return { ...result, message: config.copy.approve(result) };
    },
  });
}

/** Admin-only: reject a pending name code. */
export function rejectUserTool(config: IdentityToolsConfig): AnyMcpTool {
  return defineTool({
    name: "reject_user",
    description: "Từ chối name code đang chờ. Chỉ quản trị viên gọi được.",
    inputSchema: {
      userId: z.string().describe("Id người bị từ chối"),
      rejectedBy: z.string().describe("Id quản trị viên thực hiện, do host cung cấp"),
    },
    handler: ({ userId, rejectedBy }) => {
      if (!config.service.isAdmin(rejectedBy)) {
        return { success: false, reason: "not_admin", message: config.copy.notAdmin() };
      }
      const result = config.service.rejectUser(userId);
      return { ...result, message: config.copy.reject(result) };
    },
  });
}

/**
 * Relink a name_code to a new account. The approver is checked against the
 * injected `isAuthorizedApprover` predicate inside `relinkIdentity`, NOT trusted
 * as a free string — the host supplies the real authorizing identity.
 */
export function relinkIdentityTool(config: IdentityToolsConfig): AnyMcpTool {
  return defineTool({
    name: "relink_identity",
    description:
      "Đổi tài khoản cho một name code đã đăng ký, giữ nguyên lịch sử theo mã. " +
      "Chỉ Admin/Lead được duyệt; người duyệt do hệ thống cung cấp, không phải tham số model điền.",
    inputSchema: {
      nameCode: z.string().describe("Name code cần đổi tài khoản"),
      newUserId: z.string().describe("Id tài khoản mới (số)"),
      approver: z.string().describe("Người duyệt, do host cung cấp — được kiểm tra bằng predicate"),
    },
    handler: ({ nameCode, newUserId, approver }) => {
      const result = relinkIdentity(config.repo, { nameCode, newUserId, approver }, config.relink);
      return { ...result, message: config.copy.relink(result) };
    },
  });
}

/** All identity tools in one array, ready to pass to `createMcpServer`. */
export function identityTools(config: IdentityToolsConfig): AnyMcpTool[] {
  return [
    checkIdentityTool(config),
    registerIdentityTool(config),
    approveUserTool(config),
    rejectUserTool(config),
    relinkIdentityTool(config),
  ];
}
