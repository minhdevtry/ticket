/**
 * Lọc theo agentId — một plugin OpenClaw chỉ hành động cho đúng agent của nó.
 *
 * VÌ SAO: hook của OpenClaw là TOÀN CỤC (`cm-support/index.mjs` §"PHẠM VI AGENT",
 * `i4b-identity-transport.md`): một plugin đăng ký `before_agent_run` thì MỌI
 * agent của gateway chạy qua nó. Không lọc ⇒ lượt của bot khác cũng bị ký
 * `_identity` hoặc bị chèn context nhầm.
 *
 * Nguồn hai hàm tách agent id khỏi sessionKey:
 *   • `cm-support/index.mjs` `thuocPhamVi` — ưu tiên `ctx.agentId`, KHÔNG đoán từ
 *     sessionKey (session key Telegram của CM là `telegram:<acct>:direct:<id>`,
 *     không mang agent id).
 *   • `iris-tuong-tac/index.mjs` `layAccountId` — session key CLI dạng
 *     `agent:<agent>:telegram:<account>:…` CÓ mang agent id ở đoạn 2.
 * Ticket 07 yêu cầu riêng một helper "parse `agent:<id>:` from sessionKey", nên
 * cả hai đường đều được phủ: ưu tiên `ctx.agentId`, chỉ parse sessionKey khi nó
 * đúng khuôn `agent:<id>:`.
 */

/** Agent id mặc định khi `CM_SUPPORT_AGENT_IDS`/danh sách rỗng — phải khai rõ bởi bot. */
export interface AgentGateConfig {
  /** Danh sách agent id được phép. Rỗng ⇒ TỪ CHỐI mọi lượt (fail-closed). */
  readonly allowedAgentIds: readonly string[];
}

/**
 * Tách agent id khỏi sessionKey khuôn `agent:<id>:...`. Khuôn khác ⇒ null (KHÔNG
 * đoán): session key Telegram trực tiếp không mang agent id, đoán bừa thì khớp
 * sai. Nguồn: khuôn `agent:<agent>:telegram:...` ở `iris-tuong-tac`.
 */
export function parseAgentIdFromSessionKey(sessionKey: unknown): string | null {
  if (typeof sessionKey !== "string") return null;
  const m = sessionKey.match(/^agent:([^:]+):/);
  return m && m[1] ? m[1] : null;
}

/**
 * Agent id của lượt: ưu tiên `ctx.agentId` (OpenClaw đặt sẵn cho hook), rồi mới
 * parse sessionKey. Giống `thuocPhamVi`: đường vào khác nhau phải cho cùng kết luận.
 */
export function resolveAgentId(
  ctx: { agentId?: unknown; sessionKey?: unknown } = {},
): string | null {
  const direct = typeof ctx.agentId === "string" ? ctx.agentId.trim() : "";
  if (direct) return direct;
  return parseAgentIdFromSessionKey(ctx.sessionKey);
}

/**
 * Lượt này có thuộc phạm vi plugin không?
 *
 * Fail-closed như CM: danh sách rỗng ⇒ false (cấu hình sai KHÔNG mở đường cho
 * agent khác); không xác định được agent id ⇒ false (bỏ sót một lượt còn hơn
 * hành động nhầm trên lượt của bot khác).
 */
export function isAgentInScope(
  ctx: { agentId?: unknown; sessionKey?: unknown },
  config: AgentGateConfig,
): boolean {
  if (config.allowedAgentIds.length === 0) return false;
  const agentId = resolveAgentId(ctx);
  if (!agentId) return false;
  return config.allowedAgentIds.includes(agentId);
}

/**
 * Đọc danh sách agent cho phép từ một chuỗi phân tách bằng dấu phẩy (ví dụ biến
 * môi trường `CM_SUPPORT_AGENT_IDS`). Rỗng/undefined ⇒ `fallback` (mặc định rỗng
 * = fail-closed). Nguồn: `agentIdChoPhep` ở `cm-support`.
 */
export function parseAllowedAgentIds(
  raw: string | undefined | null,
  fallback: readonly string[] = [],
): string[] {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return [...fallback];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
