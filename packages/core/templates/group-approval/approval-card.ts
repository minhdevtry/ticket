import type { PendingRegistration } from "./types";

export function formatTimeVi(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  const dd = pad(d.getDate());
  const mo = pad(d.getMonth() + 1);
  const yyyy = d.getFullYear();
  return `${hh}:${mm}:${ss} ${dd}/${mo}/${yyyy}`;
}

export function buildCodeLine(reg: PendingRegistration): string {
  const nameUnder = String(reg.fullName ?? "")
    .trim()
    .replace(/\s+/g, "_");
  const subj = String(reg.subject ?? "")
    .trim()
    .replace(/\s+/g, "_");
  const lev = String(reg.level ?? "")
    .trim()
    .replace(/\s+/g, "_");
  const parts = [reg.nameCode, nameUnder];
  if (subj) parts.push(subj);
  if (lev) parts.push(lev);
  return parts.join("_");
}

/**
 * Định dạng thẻ phê duyệt gửi vào nhóm Telegram (hoặc forum topic).
 */
export function buildApprovalCardText(reg: PendingRegistration): string {
  const codeLine = buildCodeLine(reg);
  const timeStr = formatTimeVi(reg.registeredAt ?? new Date());
  const teleStr = reg.username ? `@${reg.username.replace(/^@/, "")}` : `ID: ${reg.userId}`;

  const lines = [`📋 ${codeLine}`, "", `• Mã GV: ${reg.nameCode}`, `• Tên GV: ${reg.fullName}`];
  if (reg.subject || reg.level) {
    const parts = [];
    if (reg.subject) parts.push(`Môn: ${reg.subject}`);
    if (reg.level) parts.push(`Cấp học: ${reg.level}`);
    lines.push(`• ${parts.join(" | ")}`);
  }
  lines.push(`• Telegram: ${teleStr}`);
  lines.push(`• Thời gian: ${timeStr}`);

  return lines.join("\n");
}

/**
 * Bàn phím nút bấm inline đi kèm thẻ duyệt.
 */
export function buildApprovalKeyboard(userId: string, nameCode: string) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Duyệt Giáo Viên", callback_data: `cm_approve:${userId}:${nameCode}` },
        { text: "❌ Từ Chối", callback_data: `cm_reject:${userId}:${nameCode}` },
      ],
    ],
  };
}

/**
 * Định dạng tin nhắn sau khi đã được phê duyệt trong nhóm.
 * Tin nhắn được sửa đè (editMessageText) và gỡ bỏ toàn bộ nút bấm.
 */
export function formatApprovedGroupText(codeLine: string, approverTag: string): string {
  return `✅ Đã duyệt: ${codeLine}\nNgười duyệt: ${approverTag}`;
}

/**
 * Định dạng tin nhắn sau khi bị từ chối trong nhóm.
 */
export function formatRejectedGroupText(codeLine: string, rejecterTag: string): string {
  return `❌ Đã từ chối: ${codeLine}\nNgười từ chối: ${rejecterTag}`;
}
