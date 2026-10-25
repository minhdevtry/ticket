/**
 * Tiểu Linh's domain vocabulary: the shape of a technical incident.
 *
 * This lived in the shared core, which meant every bot carried a description of
 * classrooms, student accounts and app versions whether or not it had any.
 */
/** Ảnh đã tải lên tracker. Khai tại chỗ để `apps/tieulinh-legacy/` không phụ thuộc gì bên ngoài. */
export interface UploadedAttachmentResult {
  id: string;
  url: string;
  filename: string;
}

export interface IncidentDetails {
  title: string;
  system?: string;
  product: string;
  category?: string;
  environment?: string;
  customerId?: string;
  studentAccount?: string;
  roomCode?: string;
  reportingDept?: string;
  deviceType?: string;
  deviceOs?: string;
  appVersion?: string;
  browser?: string;
  transactionId?: string;
  assignmentId?: string;
  priority: "urgent" | "high" | "medium" | "low";
  suggestedPriority?: "urgent" | "high" | "medium" | "low";
  /** Lý do người báo nêu khi xin mức ưu tiên cao (được chấp nhận). */
  priorityReason?: string;
  errorCategory?: string;
  diagnosis?: string;
  symptoms?: string;
  /**
   * Lời kể NGUYÊN VĂN hiển thị ở mục "### Mô tả" (TECH-1084).
   *
   * Chỉ là tin người báo VỪA gửi, không phải cả cuộc hội thoại. Vì vậy KHÔNG
   * dùng nó để đối chiếu định danh hay làm văn bản tra cứu — xem `reporterText`.
   */
  rawText?: string;
  /**
   * Toàn bộ lời kể người báo trong cuộc hội thoại — nguồn đối chiếu cho
   * `groundIdentifierFields` (không xoá SĐT/mã HS chỉ vì tin cuối không nhắc lại,
   * xem TECH-1084) và nền cho `symptoms` khi tra ticket tương tự.
   *
   * Ở đường `intake_step`, merger.ts gộp mọi lượt nên `rawText` đã là lời kể
   * đầy đủ — hai trường trùng nhau là đúng. Ở đường `create_issue`, model đưa
   * `description` (tóm lược cả hội thoại) vào đây.
   */
  reporterText?: string;
  imageUrls?: string[];
  /** Cờ đánh dấu ảnh đính kèm chung cho nhiều sự cố (khi không rõ ảnh thuộc về học sinh nào, W29-SPLIT). */
  mediaAmbiguous?: boolean;
  internalNote?: string;
}

export interface SimilarIssue {
  id?: number;
  identifier: string;
  title: string;
  source?: "onyx" | "itsaplan";
  reason?: string;
}

export interface ReporterInfo {
  name?: string;
  telegramId?: number | string;
  username?: string;
}
