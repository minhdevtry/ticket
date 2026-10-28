/**
 * Kiểu dữ liệu cho mẫu phê duyệt người dùng trực tiếp trong nhóm Telegram.
 */

export interface PendingRegistration {
  userId: string;
  nameCode: string;
  fullName: string;
  subject?: string;
  level?: string;
  team?: string;
  username?: string;
  registeredAt?: Date;
}

export interface ApprovalTarget {
  chatId: string | number;
  threadId?: number;
}

export interface ApprovalActionPayload {
  action: "approve" | "reject";
  targetUserId: string;
  targetNameCode: string;
  approverTag: string;
  actionTime: Date;
}
