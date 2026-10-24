import type {
  ValidProduct,
  ValidSystem,
  ValidErrorCategory,
  ValidReportingDept,
  ValidDeviceType,
} from "../../mcp/tieulinh/domain/taxonomy";

export type FieldSource =
  | "user_message"
  | "system_inferred"
  | "identity_lookup"
  | "exhausted_default"
  | "default";

export interface FieldValue<T> {
  value: T;
  source: FieldSource;
  turn: number;
  rawText?: string;
  confidence?: number;
  /** Người dùng tự đặt ("sửa tiêu đề thành …") — không để LLM tóm tắt lại đè lên. */
  explicit?: boolean;
  updatedAt: string;
}

export type PriorityLevel = "urgent" | "high" | "medium" | "low";

export interface PriorityEvidence {
  scope?: "single_user" | "group" | "entire_system";
  blocksPayment?: boolean;
  reconciliationMismatch?: boolean;
  blocksLearning?: boolean;
  dataLoss?: boolean;
  hasWorkaround?: boolean;
  singleDeviceOnly?: boolean;
}

export interface SimilarTicketItem {
  identifier: string;
  title: string;
  system?: string;
  rootCause?: string;
  resolution?: string;
  link?: string;
  score?: number;
  verifiedOnTracker: boolean;
  /**
   * `kg`: cùng cụm nguyên nhân người xác định — được ghi vào ticket.
   * `onyx`: chỉ tìm theo chữ — xem trong phiên, không bao giờ ghi (ADR-0007).
   */
  source?: "kg" | "onyx";
}

export type IntakeDocumentStatus =
  | "collecting"
  | "ready_for_confirmation"
  | "confirmed"
  | "created"
  | "updated"
  | "canceled"
  | "expired";

/** Tài liệu đã đóng: không nhận thêm trường, tin nhắn sau thuộc về việc khác. */
export const CLOSED_STATUSES: ReadonlySet<IntakeDocumentStatus> = new Set(["created", "updated", "canceled", "expired"]);

export interface IntakeFields {
  title?: FieldValue<string>;
  rawText?: FieldValue<string>;
  symptoms?: FieldValue<string[]>;
  product?: FieldValue<ValidProduct>;
  system?: FieldValue<ValidSystem>;
  errorCategory?: FieldValue<ValidErrorCategory>;
  reportingDept?: FieldValue<ValidReportingDept>;
  priority?: FieldValue<PriorityLevel>;
  customerId?: FieldValue<string>;
  studentAccount?: FieldValue<string>;
  roomCode?: FieldValue<string>;
  deviceType?: FieldValue<ValidDeviceType>;
  deviceOs?: FieldValue<string>;
  appVersion?: FieldValue<string>;
  browser?: FieldValue<string>;
  transactionId?: FieldValue<string>;
  assignmentId?: FieldValue<string>;
  mediaPaths?: FieldValue<string[]>;
}

export interface IntakeDocument {
  docId: string;
  chatId: string;
  revision: number;
  status: IntakeDocumentStatus;
  currentTurn: number;
  fields: IntakeFields;
  evidence: PriorityEvidence;
  askedCount: Record<string, number>;
  similarTickets: SimilarTicketItem[];
  diagnosis?: string;
  issueId?: number;
  issueIdentifier?: string;
  issueUrl?: string;
  /** Thời điểm tạo ticket (ISO) — dùng để chặn tạo trùng qua create_issue. */
  issueCreatedAt?: string;
  /** Lúc hiện tóm tắt xin xác nhận (ISO) — chặn xác nhận tới ngay trong cùng lượt model. */
  summaryShownAt?: string;
  /** Trường vừa hỏi ở lượt trước — để biết câu "không biết" là trả lời cho trường nào. */
  lastAskedFields?: string[];
  /** Trường người dùng nói rõ là không biết/không có — gate thôi hỏi. */
  explicitlyMissing?: string[];
  /**
   * Gợi ý từ Knowledge Graph (KG + Onyx + BM25 + LLM xác minh) — tra MỘT lần
   * mỗi tài liệu, chạy NỀN sau khi tạo ticket (không chặn câu trả lời cho
   * người dùng — xem lib/intake-step/pipeline.ts::runSimilarTicketsInBackground).
   */
  kgAdvice?: string;
  /** Đã chạy xong việc tra KG nền cho tài liệu này (best-effort, không dùng để gate lại lần chạy). */
  kgChecked?: boolean;
  /**
   * Bản xem trước chờ người báo xác nhận trước khi ghi vào ticket ĐÃ CÓ (ADR-0008:
   * không bao giờ lặng lẽ ghi). kind: append = "bổ sung TECH-X …"; suggest = gợi ý khi
   * kỹ thuật vừa hỏi (kèm nút "Sự cố mới"); edit = "sửa TECH-X …"; move = chuyển ticket
   * bot vừa tạo nhầm sang ticket khác và huỷ bản trùng.
   */
  pendingTicketAction?: {
    kind: "append" | "suggest" | "edit" | "move" | "cancel_ticket" | "close_ticket";
    identifier: string;
    issueId: number;
    content: string;
    /** Tin gốc — "Sự cố mới" ở gợi ý thì tin này vào tờ khai. */
    message: string;
    mediaPaths: string[];
    from?: { identifier: string; issueId: number };
    /** Gợi ý bổ sung mà người báo còn ticket đang mở khác: các ticket thay thế cũng có nút riêng. */
    alternatives?: { identifier: string; issueId: number; title?: string }[];
    edit?: {
      baseTitle: string;
      baseDescription: string;
      title: string;
      description: string;
      changes: { what: string; before: string; after: string }[];
    };
    askedAt: string;
  };
  /**
   * Người báo xin mức ưu tiên (29/09 user chốt: xin gấp CÓ LÝ DO thì cho hết). Lý do ghi
   * vào ticket để kỹ thuật thấy; chưa có lý do thì hỏi một lần.
   */
  requestedPriority?: { level: "high" | "urgent"; reason?: string };
  /** Đã soát tờ khai bằng con mắt kỹ thuật (lib/intake-step/tech-review.ts) — chỉ soát một lần. */
  techReviewDone?: boolean;
  /** Câu hỏi dữ kiện kỹ thuật vừa gửi người báo (nếu có) — tin kế tiếp là câu trả lời. */
  techQuestion?: string;
  /** Bộ phận người dùng tự nêu nhưng ngoài danh mục (vd "Kế toán") — hỏi lại đúng một lần kèm danh sách. */
  unrecognizedDept?: string;
  /** Đang tạo ticket (status "confirmed") từ lúc nào — quá lâu thì coi như kẹt. */
  confirmingSince?: string;
  /**
   * Tin nhắn đang PARK chờ người báo chọn "sự cố mới" hay "bổ sung" — định
   * danh (SĐT/mã học sinh/mã đơn...) của nó xung đột với định danh đã có
   * trong tờ khai đang mở, nên KHÔNG merge cho tới khi người báo chọn rõ.
   *
   * Đo được ở TECH-928 (26/09/2026, đo lại 28/09 — nguyên nhân thật): tờ khai
   * đang chờ xác nhận sự cố A (SĐT 0900000003) nhận thêm tin của sự cố B
   * (SĐT 0900000004) — pipeline gộp lặng lẽ, A mất SĐT thật, B mất trắng
   * luôn. Xem `lib/identifier-grounding.ts::identifiersConflict`.
   */
  pendingNewIncident?: {
    message: string;
    mediaPaths: string[];
    askedAt: string;
  };
  /**
   * Tin nhắn chứa nhiều sự cố/học sinh đang chờ người báo chọn "tách ticket" hay "gộp 1 ticket" (W29-SPLIT).
   */
  pendingSplit?: {
    blocks: Array<{
      text: string;
      studentName?: string;
      customerId?: string;
      studentAccount?: string;
      reportingDept?: string;
      title?: string;
      mediaPaths?: string[];
    }>;
    mediaPaths: string[];
    askedAt: string;
    /**
     * Chữ của những tin CHƯA RÕ Ý ở câu hỏi tách (Vòng 3, P1). Không bao giờ bị
     * đánh rơi: nếu sau đó người báo chọn TÁCH, phần này đi kèm ticket đầu tiên;
     * nếu chọn GỘP (hoặc vẫn không rõ ở lần hỏi lại), nó vào ticket duy nhất.
     */
    extraText?: string[];
    /** Số lần đã HỎI LẠI câu tách vì câu trả lời chưa rõ ý (tối đa 1 — Vòng 3, P1). */
    clarifyCount?: number;
  };
  /**
   * Các khối sự cố tiếp theo đang chờ tạo lần lượt sau khi sự cố hiện tại tạo xong (W29-SPLIT).
   */
  pendingSplitQueue?: Array<{
    text: string;
    studentName?: string;
    customerId?: string;
    studentAccount?: string;
    reportingDept?: string;
    title?: string;
    mediaPaths?: string[];
  }>;
  /** Cờ đánh dấu ảnh đính kèm chung cho nhiều sự cố (W29-SPLIT). */
  mediaAmbiguous?: boolean;
  /**
   * docId của tờ khai bị GÁC LẠI khi người báo chọn "Sự cố mới" ở
   * `resolvePendingNewIncident` — tài liệu này (sự cố mới) được lập ra thay
   * chỗ nó. Dùng để nhắc lại tờ khai bị gác một lần, khi sự cố mới này tạo
   * xong ticket hoặc bị huỷ (xem `pipeline.ts::appendParkedReminder`), tránh
   * để nó mồ côi — người báo tưởng đã xử lý nhưng thật ra chưa ai đụng tới.
   */
  parkedDocId?: string;
  reporter?: {
    name?: string;
    username?: string;
    nameCode?: string;
    chatId?: string;
    telegramId?: string;
  };
  createdAt: string;
  updatedAt: string;
}
