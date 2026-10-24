export interface TicketGraphNode {
  identifier: string; // VD: TECH-776 hoặc TECHTEST-1
  title: string;
  status: string;     // Open, In_Progress, Resolved, Done
  priority: string;   // urgent, high, medium, low
  createdAt: string;
  resolvedAt?: string;
  // Các thuộc tính bóc tách
  product?: string;
  system?: string;
  errorCategory?: string;
  reportingDept?: string;
  studentAccount?: string;
  customerId?: string;
  deviceType?: string;
  deviceOs?: string;
  appVersion?: string;
  assignmentId?: string;
  roomCode?: string;
  // Nguyên nhân & giải pháp rút ra khi Done
  rootCause?: string;
  resolution?: string;
  symptoms?: string[];
  /** Lời người báo (mục "Mô tả") — kho tìm kiếm ticket tương tự. */
  symptomsText?: string;
  /** Câu Nguyên nhân / Cách khắc phục trong comment ghim của người (ADR-0007). */
  humanCause?: string;
  humanFix?: string;
  /**
   * Ngữ cảnh giàu cho LLM xác minh ticket tương tự (lib/kg/similar-judge.ts) —
   * mô tả gốc đã bỏ phần bot sinh ("Chẩn đoán & Gợi ý"...) + toàn bộ ghi chú
   * xử lý của NGƯỜI (không chỉ câu Nguyên nhân/Cách khắc phục cô đọng). Dựng
   * bằng lib/kg/similar-context.ts::similarContextOf — chốt 27/09 sau khi phát
   * hiện thiếu 2 trường này khiến LLM hiếm khi đủ căn cứ báo confidence "high".
   */
  description?: string;
  humanNotes?: string;
  /** Ticket nhãn IT Support — chỉ để thống kê; vẫn gợi ý như mọi ticket TECH (27/09). */
  itSupport?: boolean;
  /** Ticket NGƯỜI coi là cùng nguyên nhân (link/mã người gắn). Gợi ý bot ghi không bao giờ vào đây. */
  relatedTickets?: string[];
  /** Các vé mà người đã gỡ liên kết khỏi vé này (âm mẫu từ hành động sửa của
   * con người — bài học tech lead: 158/158 link_remove là người gỡ).
   * Tạo cạnh REJECTED_RELATION trong graph để không bao giờ gợi ý lại. */
  negativeTickets?: string[];
  // Nhóm nguyên nhân canonical (xem cause-taxonomy.json) — dùng để gom cụm
  // ticket cùng bản chất lỗi dù rootCause diễn đạt khác chữ.
  causeTaxon?: string;
}

export interface CauseTaxonEntry {
  id: string;
  label: string;
  definition: string;
}

export interface GraphQueryResult {
  identifier: string;
  title: string;
  system?: string;
  product?: string;
  errorCategory?: string;
  causeTaxon?: string;
  rootCause?: string;
  resolution?: string;
  status: string;
  score?: number;
  distance?: number;
  relation?: string;
}
