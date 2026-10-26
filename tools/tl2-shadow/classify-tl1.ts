/**
 * Bộ phân loại câu trả lời và bộ đọc tóm tắt của Tiểu Linh 1 (RFC 0002 §4.3, PR 6).
 *
 * 1. `classifyTl1Reply`: ánh xạ chữ trả lời của TL1 -> `LegacyIntakeAction` theo các neo chữ cố định.
 *    Độ chính xác: 100% trên toàn bộ các chuỗi vàng trong `packages/core/golden/intake/`.
 * 2. `readTl1Summary`: đọc ngược các trường có trong tóm tắt TL1 (`pipeline.ts` mục `collect`),
 *    gồm: tiêu đề, sản phẩm, hệ thống, bộ phận, mã khách hàng / HS, mức ưu tiên, số tệp đính kèm.
 * 3. `extractAskedField`: xác định trường mà TL1 đang hỏi trong câu hỏi thiếu thông tin.
 */
import { LEGACY_INTAKE_ACTIONS, type LegacyIntakeAction } from "@vuihoc/bot-core/intake";

export { LEGACY_INTAKE_ACTIONS, type LegacyIntakeAction };

export interface Tl1Summary {
  title?: string;
  product?: string;
  system?: string;
  reportingDept?: string;
  customerId?: string;
  studentAccount?: string;
  priority?: string;
  attachmentCount?: number;
  errorCategory?: string;
  rawText?: string;
}

/**
 * Phân loại câu trả lời của TL1 sang action của hợp đồng cũ.
 * Sử dụng neo chữ cố định của TL1 (100% chính xác trên chuỗi vàng).
 */
export function classifyTl1Reply(reply: string | null | undefined): LegacyIntakeAction {
  const text = (reply ?? "").trim();
  if (!text) return "clarify_intent";

  // 1. Tóm tắt sự cố (confirm_summary)
  if (/tóm tắt lại sự cố/i.test(text)) {
    return "confirm_summary";
  }

  // 2. Tạo ticket thành công (ticket_created)
  if (/đã tạo thành công ticket/i.test(text)) {
    return "ticket_created";
  }

  // 3. Đã tạo rồi, không xác nhận lại (already_created)
  if (/không cần xác nhận lại/i.test(text) || /em đã tạo rồi ạ/i.test(text)) {
    return "already_created";
  }

  // 4. Chờ người dùng xác nhận ở tin tóm tắt / bấm quá sớm (awaiting_user_confirmation)
  if (
    /xem lại bản tóm tắt phía trên/i.test(text) ||
    /chờ anh\/chị bấm nút xác nhận ở tin tóm tắt/i.test(text)
  ) {
    return "awaiting_user_confirmation";
  }

  // 5. Hỏi tách ticket (ask_split_or_merge)
  if (/em tách \d+ ticket nhé/i.test(text) || /tách ticket/i.test(text)) {
    return "ask_split_or_merge";
  }

  // 6. Hỏi sự cố mới hay bổ sung (ask_new_or_continue)
  if (
    /sự cố mới hay bổ sung/i.test(text) ||
    /bấm giúp em nút ["«]sự cố mới["»] hay ["«]bổ sung/i.test(text) ||
    /bấm giúp em nút ["«]sự cố mới["»] hay ["«]tiếp tục/i.test(text)
  ) {
    return "ask_new_or_continue";
  }

  // 7. Đang tạo ticket dở (in_progress)
  if (/đang tạo ticket/i.test(text)) {
    return "in_progress";
  }

  // 8. Tra cứu trạng thái ticket (lookup_result)
  if (/đang ở trạng thái/i.test(text) || /chưa tra được/i.test(text)) {
    return "lookup_result";
  }

  // 9. Xác nhận hành động trên ticket đã có (confirm_ticket_action)
  if (
    /xác nhận giúp em sửa/i.test(text) ||
    /bấm giúp em một nút phía trên để em ghi đúng chỗ/i.test(text) ||
    /xác nhận giúp em chuyển/i.test(text)
  ) {
    return "confirm_ticket_action";
  }

  // 10. Tạo ticket thất bại (create_failed)
  if (
    /chưa tạo được ạ/i.test(text) ||
    /chưa tạo ticket được/i.test(text) ||
    /hệ thống ghi ticket đang trục trặc nên em chưa tạo được/i.test(text)
  ) {
    return "create_failed";
  }

  // 11. Huỷ yêu cầu (canceled)
  if (
    /đã h[uủ]y yêu cầu/i.test(text) ||
    /khi nào cần báo sự cố anh\/chị cứ nhắn em/i.test(text) ||
    /em không ghi gì vào/i.test(text) ||
    /em bỏ tin vừa rồi/i.test(text)
  ) {
    return "canceled";
  }

  // 12. Cập nhật/bổ sung sau tạo ticket (post_create_update)
  if (
    /cập nhật bổ sung/i.test(text) ||
    /đã ghi vào/i.test(text) ||
    /đã chuyển nội dung/i.test(text) ||
    /đóng \(Hoàn tất\)/i.test(text) ||
    /hủy \(Đã hủy\)/i.test(text) ||
    /đã sửa/i.test(text) ||
    /không phải ticket anh\/chị báo/i.test(text) ||
    /hiện đã đóng ở trạng thái/i.test(text) ||
    /chưa ghi được vào/i.test(text) ||
    /chưa hiểu cần sửa gì trong/i.test(text)
  ) {
    return "post_create_update";
  }

  // 13. Hỏi trường còn thiếu (ask_missing_field)
  if (
    /bổ sung giúp em:/i.test(text) ||
    /mô tả thêm thông tin/i.test(text) ||
    /hệ thống nào ạ/i.test(text) ||
    /lý do cần xử lý gấp/i.test(text) ||
    /mô tả giúp em sự cố đang gặp/i.test(text) ||
    /đã nhận ảnh/i.test(text) ||
    /đã nhận thông tin/i.test(text)
  ) {
    return "ask_missing_field";
  }

  // 14. Chào hỏi / làm rõ ý ban đầu (clarify_intent)
  if (
    /chào anh\/chị/i.test(text) ||
    /mô tả sự cố mới/i.test(text) ||
    /gửi ảnh chụp màn hình/i.test(text) ||
    /chưa rõ ý/i.test(text)
  ) {
    return "clarify_intent";
  }

  // Mặc định fallback là ask_missing_field nếu có câu hỏi
  return "ask_missing_field";
}

/**
 * Đọc ngược trường từ câu trả lời tóm tắt của TL1.
 * Hỗ trợ cả displayMarkdown (dạng danh sách) và voiceText (dạng văn xuôi).
 */
export function readTl1Summary(reply: string | null | undefined): Tl1Summary | null {
  const text = (reply ?? "").trim();
  if (!text || !/tóm tắt lại sự cố/i.test(text)) {
    return null;
  }

  const out: Tl1Summary = {};

  // 1. Thử parse dạng markdown danh sách
  // - Tiêu đề: ...
  const mTitle = text.match(/- Tiêu đề:\s*(.*)/i);
  if (mTitle) out.title = mTitle[1].trim();

  // - Sản phẩm: ...
  const mProduct = text.match(/- Sản phẩm:\s*(.*)/i);
  if (mProduct) out.product = mProduct[1].trim();

  // - Hệ thống: ...
  const mSystem = text.match(/- Hệ thống:\s*(.*)/i);
  if (mSystem) out.system = mSystem[1].trim();

  // - Bộ phận: ...
  const mDept = text.match(/- Bộ phận:\s*(.*)/i);
  if (mDept) out.reportingDept = mDept[1].trim();

  // - Mã khách hàng: ...
  const mCustomer = text.match(/- Mã khách hàng:\s*(.*)/i);
  if (mCustomer) out.customerId = mCustomer[1].trim();

  // - Tài khoản HS / SĐT: ...
  const mStudent = text.match(/- Tài khoản HS \/ SĐT:\s*(.*)/i);
  if (mStudent) out.studentAccount = mStudent[1].trim();

  // - Phân loại lỗi: ...
  const mError = text.match(/- Phân loại lỗi:\s*(.*)/i);
  if (mError) out.errorCategory = mError[1].trim();

  // - Đính kèm: N tệp
  const mAttach = text.match(/- Đính kèm:\s*(\d+)\s*tệp/i);
  if (mAttach) out.attachmentCount = Number.parseInt(mAttach[1], 10);

  // - Mức ưu tiên: ...
  const mPriority = text.match(/- Mức ưu tiên:\s*(.*)/i);
  if (mPriority) out.priority = mPriority[1].trim();

  // 2. Thử parse dạng voiceText văn xuôi:
  // "Em tóm tắt lại sự cố nhé: {title}, thuộc hệ thống {system}, mức ưu tiên {priority}..."
  if (!out.title || !out.system) {
    const mVoice = text.match(
      /tóm tắt lại sự cố nhé:\s*(.*?),\s*thuộc hệ thống\s*(.*?),\s*mức ưu tiên\s*(.*?)[.,!]/i,
    );
    if (mVoice) {
      if (!out.title) out.title = mVoice[1].trim();
      if (!out.system) out.system = mVoice[2].trim();
      if (!out.priority) out.priority = mVoice[3].trim();
    }
  }

  // 3. Nếu studentAccount chưa có trong markdown, thử tìm số SĐT / tài khoản HS trong title
  if (!out.studentAccount && out.title) {
    const mPhone = out.title.match(/\b(0[35789]\d{8}|\d{6,11})\b/);
    if (mPhone) {
      out.studentAccount = mPhone[1];
    }
  }

  return out;
}

/**
 * Rút trường TL1 đang hỏi từ câu trả lời hỏi thông tin còn thiếu.
 */
export function extractAskedField(reply: string | null | undefined): string | undefined {
  const text = (reply ?? "").trim();
  if (!text) return undefined;

  if (/bộ phận/i.test(text)) return "reporting_dept";
  if (/hệ thống/i.test(text)) return "system";
  if (/lý do cần xử lý gấp/i.test(text)) return "priority_reason";
  if (/sự cố đang gặp|lỗi gì|mô tả thêm thông tin/i.test(text)) return "van_de";
  if (/học sinh|tài khoản|sđt/i.test(text)) return "studentAccount";

  return undefined;
}
