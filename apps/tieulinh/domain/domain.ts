/**
 * Cách Tiểu Linh biến một lời kể thành ticket.
 *
 * Bố cục mô tả và câu xác nhận giữ nguyên như bản đang chạy thật.
 */
import { getLogger } from "@vuihoc/bot-core/core";
import { z } from "zod";
import { formatConfirmationMessage, formatTicketDescription } from "./ticket-formatter";
import type { IncidentDetails } from "./types";

const PHONE_OR_ACCOUNT = /(0\d{9,10}|\b\d{9,11}\b)/g;

/** Moi số điện thoại ra khỏi câu chữ — việc tất định, đúng chỗ cho regex. */
export function extractAccounts(description: string): string | undefined {
  const matches = description.match(PHONE_OR_ACCOUNT);
  return matches?.length ? [...new Set(matches)].join(", ") : undefined;
}

function clean(value?: string | null): string | undefined {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed || trimmed === "null" || trimmed === "undefined") return undefined;
  return (value ?? "").trim();
}

/**
 * Gợi ý trường mềm (soft fields) theo taxonomy để tăng tốc hỗ trợ mà không chặn tạo ticket.
 */
export function getRecommendedSoftFields(
  category: string | undefined,
  current: {
    roomCode?: string;
    studentAccount?: string;
    customerId?: string;
    device?: string;
  },
  hasSpecificSubject?: boolean,
): string[] {
  const missing: string[] = [];
  const cat = (category || "").toLowerCase();

  if (
    cat.includes("liveclass") ||
    cat.includes("tutor") ||
    cat.includes("gia sư") ||
    cat.includes("classin")
  ) {
    if (hasSpecificSubject && !current.studentAccount && !current.customerId && !current.roomCode) {
      missing.push("mã phòng học hoặc số điện thoại phụ huynh hoặc tài khoản học sinh");
    }
  } else if (cat.includes("crm") || cat.includes("lên đơn") || cat.includes("đơn hàng")) {
    if (hasSpecificSubject && !current.studentAccount && !current.customerId) {
      missing.push("mã khách hàng hoặc số điện thoại phụ huynh");
    }
  } else if (
    cat.includes("app") ||
    cat.includes("duo") ||
    cat.includes("pas") ||
    cat.includes("tự học")
  ) {
    if (!current.device) {
      missing.push("loại thiết bị (Điện thoại/Máy tính bảng/PC/Laptop)");
    }
  } else if (cat.includes("web") || cat.includes("lms")) {
    if (hasSpecificSubject && !current.studentAccount && !current.customerId) {
      missing.push("tài khoản người dùng gặp lỗi");
    }
  } else if (
    hasSpecificSubject &&
    !current.studentAccount &&
    !current.customerId &&
    !current.roomCode
  ) {
    missing.push("số điện thoại phụ huynh hoặc tài khoản học sinh");
  }

  return missing;
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

const inputShape = {
  ...reporterShape,
  title: z.string().describe("Tiêu đề ngắn gọn, chuẩn hoá (15-80 ký tự, không chứa prefix tag)"),
  description: z.string().describe("Mô tả chi tiết sự cố do người dùng cung cấp"),
  rawText: z
    .string()
    .optional()
    .describe(
      'NGUYÊN VĂN lời người báo — đây chính là mục "### Mô tả" trên ticket. ' +
        "Chép lại y nguyên MỌI lượt tròi chuyện của sự cố này (từ lượt đầu tiên), " +
        "mỗi lượt một dòng, giữ nguyên thứ tự và cả chữ viết tắt. KHÔNG viết lại, KHÔNG tóm tắt, " +
        'KHÔNG thêm nhận định của bạn ("Cần đối chiếu…", "Có thể do…", "Hệ thống xác định…"). ' +
        "Dùng cho MỌI sự cố, kể cả khi ngắn một câu — đó mới là lời người báo, còn `description` " +
        "của bạn chỉ là bản viết lại. Suy luận kỹ thuật thì để vào `diagnosis`.",
    ),
  hasSpecificSubject: z
    .boolean()
    .describe(
      "Sự cố có nhắm vào một người hoặc một lớp cụ thể không? " +
        'true khi là chuyện của một phụ huynh, học sinh, giáo viên hay buổi học nhất định ("mẹ bé Bo không vào được lớp") ' +
        "— khi đó cần SĐT, tài khoản hoặc mã phòng thì đội Kỹ thuật mới tra được. " +
        'false khi cả hệ thống hỏng, không gắn với riêng ai ("server trả 502 toàn hệ thống") — hỏi tài khoản lúc này là thừa.',
    ),
  product: z
    .string()
    .optional()
    .describe(
      "Sản phẩm chuẩn (Tự học, Duo, Pas, Tutor, Exam, VNESchool, K12 Viettel, Smart Media, Khác)",
    ),
  system: z
    .string()
    .optional()
    .describe(
      "Hệ thống chuẩn (Vuihoc (App/Web_Vuihoc + ERP_DUO), CRM_Vuihoc, LMS_Vuihoc, TUTOR_Vuihoc (ERP/APP/WEB_Gia sư), Thi thử ĐGNL, ClassIn, CARE_Vuihoc, Bitu Chat, OMS_Vuihoc, Bizfly_Vuihoc, K12 Viettel, VNESCHOOL, Khác (liên quan bên IT))",
    ),
  errorCategory: z
    .string()
    .optional()
    .describe(
      "Phân loại lỗi chuẩn (Lỗi hệ thống, Lỗi kỹ thuật, Lỗi dữ liệu, Lỗi bên thứ 3, Lỗi chưa xác định, Hỗ trợ, Khác, Lỗi cấu hình máy, Cải tiến sản phẩm, ND bị nhầm hoặc hiểu sai, Lỗi nhập liệu)",
    ),
  category: z
    .string()
    .optional()
    .describe("Phân loại hệ thống (tương thích ngược: LiveClass, CRM, LMS, Duo...)"),
  priority: z
    .enum(["low", "medium", "high", "urgent"])
    .optional()
    .describe("Độ ưu tiên (mặc định medium)"),
  roomId: z.string().optional().describe("Mã phòng học, ví dụ ROOM-5511"),
  studentId: z.string().optional().describe("Mã học sinh hoặc SĐT phụ huynh"),
  customerId: z.string().optional().describe("Mã khách hàng hoặc SĐT phụ huynh"),
  device: z
    .string()
    .optional()
    .describe("Thiết bị sử dụng (Điện thoại, Máy tính bảng, PC, Laptop, iPad...)"),
  deviceOs: z
    .string()
    .optional()
    .describe("Hệ điều hành (iOS, Android, iPadOS, Windows, macOS...)"),
  appVersion: z.string().optional().describe("Phiên bản app"),
  reportingDept: z
    .string()
    .optional()
    .describe(
      "Bộ phận của người báo (Vận hành, Vận đơn, CSKH, CSHV, Chuyên môn, Sale, Quản lý lớp)",
    ),
  symptoms: z.array(z.string()).optional().describe("Triệu chứng quan sát được"),
  mediaPaths: z
    .array(z.string())
    .optional()
    .describe("Danh sách đường dẫn ảnh chụp màn hình cần đính kèm ticket"),
  diagnosis: z
    .string()
    .optional()
    .describe(
      "Chẩn đoán nguyên nhân sơ bộ và gợi ý xử lý từ kiến thức kỹ thuật và runbook Onyx. " +
        "CHỈ nội dung kỹ thuật — TUYỆT ĐỐI KHÔNG nhét SĐT/mã khách hàng/mã học sinh vào đây, " +
        "dùng đúng `customerId`/`studentId` cho các thông tin đó.",
    ),
};

const VIETNAMESE_PHONE = /^(?:\+84|0)[35789]\d{8}$/;

export function isPhoneNumber(val?: string): boolean {
  if (!val) return false;
  const normalized = val.replace(/[\s.-]+/g, "");
  return VIETNAMESE_PHONE.test(normalized);
}

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

export const ticketDomain: IssueDomain<typeof inputShape> = {
  description:
    "Tạo ticket báo sự cố kỹ thuật mới. Gọi ngay khi người dùng mô tả một sự cố mới phát sinh, " +
    "KỂ CẢ khi thông tin còn thiếu — công cụ sẽ tự hỏi thêm ở cuối tin nhắn.",
  inputShape,
  build(input) {
    const roomId = clean(input.roomId);
    let customerId = clean(input.customerId);
    let studentId = clean(input.studentId);

    const heuristicText = [input.title, input.rawText, input.description]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    // Nếu customerId là định dạng SĐT Việt Nam, chuyển hẳn sang studentId (SĐT)
    if (customerId && isPhoneNumber(customerId)) {
      if (!studentId) studentId = customerId;
      customerId = undefined;
    }
    if (customerId && studentId && customerId === studentId) {
      customerId = undefined;
    }
    if (!studentId) {
      studentId = extractAccounts(input.rawText || "") || extractAccounts(input.description);
    }

    let system = clean(input.system);
    let product = clean(input.product);
    let errorCategory = clean(input.errorCategory);

    // Heuristics chuẩn hóa hệ thống & sản phẩm nếu model chưa điền đủ
    if (!system && input.category) {
      const catLower = input.category.toLowerCase();
      if (catLower.includes("crm")) system = "CRM_Vuihoc";
      else if (catLower.includes("lms")) system = "LMS_Vuihoc";
      else if (catLower.includes("liveclass") || catLower.includes("tutor"))
        system = "TUTOR_Vuihoc (ERP/APP/WEB_Gia sư)";
      else if (catLower.includes("duo")) system = "Vuihoc (App/Web_Vuihoc + ERP_DUO)";
      else system = input.category;
    }

    if (!system) {
      const text = heuristicText;
      if (text.includes("crm") || text.includes("lên đơn") || text.includes("hóa đơn"))
        system = "CRM_Vuihoc";
      else if (text.includes("lms")) system = "LMS_Vuihoc";
      else if (text.includes("liveclass") || text.includes("phòng học") || text.includes("gia sư"))
        system = "TUTOR_Vuihoc (ERP/APP/WEB_Gia sư)";
      else if (text.includes("duo") || text.includes("app"))
        system = "Vuihoc (App/Web_Vuihoc + ERP_DUO)";
      else system = "Khác (liên quan bên IT)";
    }

    if (!product) {
      if (system.includes("CRM") || system.includes("Khác")) product = "Khác";
      else if (system.includes("TUTOR") || system.includes("LiveClass")) product = "Tutor";
      else if (system.includes("LMS") || system.includes("App_THPT")) product = "Tự học";
      else product = "Tự học";
    }

    if (!errorCategory) {
      const text = heuristicText;
      if (
        text.includes("trùng") ||
        text.includes("dữ liệu") ||
        text.includes("data") ||
        text.includes("lên đơn") ||
        text.includes("tài khoản học")
      ) {
        errorCategory = "Lỗi dữ liệu";
      } else if (
        text.includes("502") ||
        text.includes("500") ||
        text.includes("504") ||
        text.includes("sập") ||
        text.includes("server") ||
        text.includes("quá tải") ||
        text.includes("hệ thống")
      ) {
        errorCategory = "Lỗi hệ thống";
      } else if (
        text.includes("loa") ||
        text.includes("mic") ||
        text.includes("âm thanh") ||
        text.includes("camera") ||
        text.includes("hình ảnh") ||
        text.includes("kỹ thuật")
      ) {
        errorCategory = "Lỗi kỹ thuật";
      } else {
        errorCategory = "Khác";
      }
    }

    let diagnosis = clean(input.diagnosis);
    if (diagnosis) {
      const leaked = extractAccounts(diagnosis);
      if (leaked) {
        if (!studentId) studentId = leaked;
        if (customerId && isPhoneNumber(customerId)) customerId = undefined;
        diagnosis = diagnosis
          .replace(
            /(?:Số điện thoại(?: liên hệ)?|SĐT|Điện thoại)\s*[:：]\s*(?:0\d{9,10}|\d{9,11})\.?/gi,
            "",
          )
          .replace(PHONE_OR_ACCOUNT, "")
          .replace(
            /(?:^|\n)[-*•]?\s*(?:Số điện thoại(?: liên hệ)?|SĐT|Điện thoại)\s*[:：]?\s*[.,]?\s*(?=\n|$)/gi,
            "",
          )
          .replace(/[ \t]{2,}/g, " ")
          .replace(/\s+([.,])/g, "$1")
          .replace(/\.\s*\.+/g, ".")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      }
    }
    const incident: IncidentDetails = {
      title: input.title,
      product,
      system,
      category: errorCategory,
      errorCategory,
      environment: "Production",
      priority: input.priority ?? "medium",
      roomCode: roomId,
      customerId,
      studentAccount: studentId,
      deviceType: clean(input.device),
      deviceOs: clean(input.deviceOs),
      appVersion: clean(input.appVersion),
      reportingDept: clean(input.reportingDept),
      symptoms: (input.symptoms ?? []).join(", "),
      rawText: input.rawText,
      reporterText: [input.rawText, input.description].filter(Boolean).join("\n"),
      imageUrls: [],
      diagnosis,
    };

    if (!input.rawText) {
      getLogger().warn(
        `[tieulinh] create_issue không có rawText nguyên văn — mô tả TECH sẽ là bản model viết lại (xem TECH-1084): "${input.description?.slice(0, 120) ?? ""}"`,
      );
    }

    const missing = getRecommendedSoftFields(
      system || input.category,
      { roomCode: roomId, studentAccount: studentId, customerId, device: clean(input.device) },
      input.hasSpecificSubject,
    );

    const displayName =
      input.reporterNameCode && input.reporterName
        ? `${input.reporterName} (${input.reporterNameCode})`
        : input.reporterName || input.reporterNameCode;

    return {
      title: incident.title,
      description: formatTicketDescription({
        incident,
        reporter: {
          name: displayName,
          username: input.reporterUsername,
          telegramId: input.telegramUserId || input.reporterChatId,
        },
      }),
      priority: incident.priority,
      errorCategory,
      product,
      system,
      mediaPaths: input.mediaPaths,
      diagnosis,
      confirmation: formatConfirmationMessage({
        issueIdentifier: "{identifier}",
        issueUrl: "{url}",
        incident,
        missingSoftFields: missing,
      }),
    };
  },
};
