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
};
