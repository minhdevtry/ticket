/**
 * Tiểu Linh's copy catalog — an EXAMPLE, not library source.
 *
 * The library engine carries zero Vietnamese string literals; every user-facing
 * line comes from an injected `CopyCatalog`. These are Tiểu Linh's defaults,
 * lifted from intake `mcp/shared/tools/create-issue.ts` and
 * `lib/intake-step/pipeline.ts`. A bot imports this (or writes its own) and
 * passes it to the write engine.
 */
import type { CopyKey } from "../../src/intake/ports";

export const tieuLinhCopy: Record<CopyKey, string> = {
  "confirm.too_soon":
    "Anh/chị xem lại bản tóm tắt phía trên, đúng thì bấm nút xác nhận giúp em nhé ạ.",
  "confirm.in_progress": "Dạ em đang tạo ticket cho anh/chị, anh/chị chờ em một chút nhé ạ.",
  "confirm.resend":
    "Dạ em xin lỗi, em bị mất phần thông tin vừa tóm tắt nên chưa gửi đi được ạ. " +
    "Anh/chị nhắn lại giúp em nội dung chính một lần nữa nhé, em ghi lại ngay.",
  "ticket.created": "Dạ em đã tạo ticket {identifier} cho anh/chị rồi ạ: {url}",
  "ticket.already_created":
    "Dạ sự cố này em đã tạo ticket {identifier} rồi ạ — anh/chị không cần tạo lại nhé.",
  "ticket.create_failed":
    "Dạ hệ thống ghi ticket đang trục trặc nên em chưa tạo được ạ. Thông tin anh/chị " +
    "đã được giữ nguyên — anh/chị bấm xác nhận lại sau ít phút giúp em nhé.",

  // ── ticket 09: conversation engine ──────────────────────────────────────────
  "ask.opening": "Dạ anh/chị mô tả giúp em vấn đề đang gặp với ạ.",
  "summary.confirm_hint":
    "Anh/chị xem lại giúp em, đúng thì bấm nút xác nhận để em tạo ticket nhé ạ.",
  "button.confirm_create": "✅ Đúng rồi, tạo ticket",
  "button.confirm_append": "✅ Bổ sung vào {identifier}",
  "button.confirm_edit": "✅ Sửa {identifier}",
  "button.confirm_move": "✅ Chuyển sang {identifier}",
  "button.new_incident": "Sự cố mới",
  "button.continue_draft": "Bổ sung sự cố đang chờ",
  "button.resume_parked": "Tiếp tục sự cố đang chờ",
  "button.cancel_action": "Huỷ",
  "park.identifier_conflict":
    "Dạ em thấy mã này khác với sự cố đang ghi dở ạ. Đây là sự cố MỚI hay anh/chị " +
    "muốn bổ sung vào sự cố đang chờ ạ?",
  "park.full_report":
    "Dạ anh/chị đang có một sự cố ghi dở. Tin này là sự cố MỚI hay bổ sung vào sự cố " +
    "đang chờ ạ?",
  "park.unclear":
    'Dạ anh/chị bấm giúp em nút "Sự cố mới" hay "Bổ sung sự cố đang chờ" phía trên nhé ạ, em chưa rõ ý ạ.',
  "park.canceled":
    "Dạ em bỏ tin vừa rồi ạ. Sự cố «{title}» vẫn đang chờ, anh/chị nhắn tiếp khi cần nhé.",
  "park.reminder": " Còn sự cố «{title}» anh/chị báo trước đó đang chờ xác nhận ạ.",
  "action.preview_append":
    "Dạ em sẽ ghi thêm vào {identifier} nội dung sau ạ:\n{content}\nĐúng thì anh/chị bấm nút giúp em nhé.",
  "action.preview_edit":
    "Dạ em sẽ sửa {identifier} theo đề nghị: {changes}\nĐúng thì anh/chị bấm nút giúp em nhé.",
  "action.preview_move":
    "Dạ em sẽ chuyển {from} sang {identifier} và huỷ bản trùng ạ. Đúng thì anh/chị bấm nút giúp em nhé.",
  "action.done_append": "Dạ em đã bổ sung vào {identifier} rồi ạ.",
  "action.done_edit": "Dạ em đã sửa {identifier} rồi ạ.",
  "action.done_move": "Dạ em đã chuyển {from} sang {identifier} rồi ạ.",
  "action.canceled": "Dạ em đã huỷ thao tác đó ạ, chưa ghi gì vào ticket cả.",
  "lookup.status": "Dạ tình trạng {identifier} hiện tại: {status}",
  "lookup.not_owner":
    "Dạ {identifier} không phải ticket của anh/chị nên em chỉ xem được trạng thái thôi ạ.",
  "draft.expired_new":
    "Dạ sự cố cũ để lâu quá nên em khép lại rồi ạ. Mình bắt đầu sự cố mới nhé, anh/chị mô tả giúp em.",
  "draft.canceled": "Dạ vâng ạ. Khi nào anh/chị cần báo sự cố thì cứ nhắn em nhé ạ.",
  "draft.awaiting_confirmation":
    "Dạ em đang chờ anh/chị bấm nút xác nhận ở tin tóm tắt phía trên ạ.",
  "ask.missing_info": "Anh/chị bổ sung giúp em thông tin còn thiếu nhé ạ.",
  // ── PR 7: hỏi bổ sung theo luật (RFC 0002 §1.5 A1-A5) ─────────────────────
  "ask.system":
    'Dạ lỗi này xảy ra trên hệ thống nào ạ? Anh/chị chọn giúp em nhé (không rõ thì nhắn "không biết").',
  "ask.priority_reason":
    'Dạ anh/chị cho em biết lý do cần xử lý gấp (vd phụ huynh đang khiếu nại, học sinh sắp vào học…) để em đặt mức {level} nhé ạ. Không có lý do cụ thể thì nhắn "không có".',
  "ask.unrecognized_dept":
    'Bộ phận "{dept}" của anh/chị không có trong danh mục của em. Anh/chị chọn giúp em một trong các bộ phận sau nhé ạ.',
  "clarify.greeting": "Dạ em chào anh/chị! Anh/chị đang gặp sự cố gì, mô tả giúp em nhé ạ.",
  "ask.describe_incident":
    "Dạ em đã nhận {item} rồi ạ. Anh/chị mô tả giúp em sự cố đang gặp (lỗi gì, ở màn hình/chức năng nào) nhé.",
  "ask.describe_incident_item": "ảnh anh/chị gửi",
  "field.unknown_value": "Chưa xác định",
  "summary.priority_line": "- Mức ưu tiên: {priority}",
  "ticket.fallback_title": "Sự cố kỹ thuật",
  "priority.level.low": "Thấp",
  "priority.level.medium": "Trung bình",
  "priority.level.high": "Cao",
  "priority.level.urgent": "Khẩn cấp",
  // ── PR 9: tách báo cáo nhiều sự cố (RFC 0002 §1.5 B7) ─────────────────────
  "split.question":
    "Dạ em thấy tin nhắn có {count} học sinh/sự cố khác nhau ({summary}) — em tách {count} ticket nhé?",
  "split.question_no_names":
    "Dạ em thấy tin nhắn có {count} học sinh/sự cố khác nhau ({count} sự cố) — em tách {count} ticket nhé?",
  "split.unclear_prefix": "Dạ em chưa rõ ý anh/chị ạ — nội dung báo cáo em vẫn giữ nguyên. ",
  "split.next_ticket_notice": "Bây giờ em tiếp tục tạo ticket cho sự cố tiếp theo nhé ạ!",
  "split.next_ticket_notice_student":
    "Bây giờ em tiếp tục tạo ticket cho sự cố tiếp theo (học sinh {studentName}) nhé ạ!",
  "button.split_n": "Tách {count} ticket",
  "button.merge_one": "Gộp 1 ticket",
  "media.ambiguous_notice": "*(Ảnh đính kèm chung cho các sự cố trong cùng lượt báo)*",
};
