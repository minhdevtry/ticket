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
    "Anh/chị vui lòng kiểm tra kỹ thông tin trước khi xác nhận để em tạo ticket nhé ạ.",
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
  "action.preview_edit": "Dạ anh/chị xác nhận giúp em sửa {identifier} như sau nhé?\n{changes}",
  "action.preview_move":
    "Dạ anh/chị xác nhận giúp em: chuyển toàn bộ nội dung {from} sang {identifier} và huỷ {from} (ticket trùng) nhé?",
  "action.done_append":
    "Em đã cập nhật bổ sung thông tin này vào ticket {identifier} cho anh/chị rồi nhé ạ!",
  "action.done_edit": "Dạ em đã sửa {identifier} rồi ạ.",
  "action.edit_done": "Dạ em đã sửa {identifier} rồi ạ.",
  "action.done_move": "Dạ em đã chuyển nội dung {from} sang {identifier} và huỷ {from} rồi ạ.",
  "action.move_done": "Dạ em đã chuyển nội dung {from} sang {identifier} và huỷ {from} rồi ạ.",
  "action.canceled": "Dạ vâng, em không ghi gì vào {identifier} ạ.",
  "action.edit_conflict_rejected":
    "Dạ {identifier} vừa được cập nhật sau khi em lập bản sửa, anh/chị gửi lại đề nghị sửa giúp em nhé.",
  "action.edit_unclear_prompt":
    'Dạ em chưa hiểu cần sửa gì trong {identifier} ạ. Anh/chị ghi rõ giúp em, vd "sửa {identifier} SĐT thành 09xxxxxxxx" nhé.',
  "action.clarify_empty_append":
    "Dạ anh/chị gửi ảnh chụp màn hình hoặc nội dung cần bổ sung vào {identifier} giúp em nhé ạ.",
  "action.not_owner_refusal":
    'Dạ {identifier} không phải ticket anh/chị báo nên em không ghi vào được ạ. Anh/chị cần xem tình trạng thì nhắn "{identifier} tới đâu rồi" nhé.',
  "lookup.status": "Dạ {identifier} «{title}» đang ở trạng thái: {status} ạ.{techComment}",
  "lookup.not_owner":
    "Dạ {identifier} không phải ticket của anh/chị nên em chỉ xem được trạng thái thôi ạ.",
  "lookup.other_ticket_status": "Dạ {identifier} đang ở trạng thái: {status} ạ.",
  "lookup.tech_comment": '\nTrao đổi gần nhất của kỹ thuật: "{comment}"',
  "lookup.clarify_identifier":
    "Dạ anh/chị nhắn giúp em mã ticket cần kiểm tra (ví dụ TECH-123) nhé ạ.",
  "comment.edit_trace": "✏️ Đã sửa theo đề nghị của **{who}**:\n{lines}",
  "comment.move_target_note":
    "🔀 **{who}** xác nhận {from} là bổ sung cho ticket này — nội dung chuyển sang:\n{body}\n\n{images}",
  "comment.move_source_note":
    "ℹ️ Ticket này trùng {target}: **{who}** xác nhận đây là bổ sung cho {target}, nội dung đã chuyển sang {target}. {botName} huỷ bản trùng (ADR-0008).",
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
  // ── PR 9: tách báo cáo nhiều sự cố (RFC 0002 §1.2 B7) ─────────────────────
  "split.question":
    "Dạ em thấy tin nhắn có {count} học sinh/sự cố khác nhau ({summary}) — em tách {count} ticket nhé?",
  "split.question_no_names":
    "Dạ em thấy tin nhắn có {count} học sinh/sự cố khác nhau ({count} sự cố) — em tách {count} ticket nhé?",
  "split.unnamed_item": "sự cố",
  "split.unclear_prefix": "Dạ em chưa rõ ý anh/chị ạ — nội dung báo cáo em vẫn giữ nguyên. ",
  "split.next_ticket_notice": "Bây giờ em tiếp tục tạo ticket cho sự cố tiếp theo nhé ạ!",
  "split.next_ticket_notice_student":
    "Bây giờ em tiếp tục tạo ticket cho sự cố tiếp theo (học sinh {studentName}) nhé ạ!",
  "button.split_n": "Tách {count} ticket",
  "button.merge_one": "Gộp 1 ticket",
  "media.attachments_heading": "### 📸 Ảnh đính kèm",
  "media.ambiguous_notice": "*(Ảnh đính kèm chung cho các sự cố trong cùng lượt báo)*",
  // ── PR 10: tin sau khi tạo ticket (RFC 0002 §1.5 C1-C4, G2, B8) ─────────────
  "ticket.closed_refusal":
    "Dạ ticket {identifier} hiện đã đóng ở trạng thái {statusLabel} trên hệ thống rồi nên không thể ghi bổ sung được nữa ạ. Nếu cần hỗ trợ sự cố mới, anh/chị vui lòng tạo ticket mới giúp em nhé ạ.",
  "ticket.chitchat_after_create":
    "Dạ không có gì ạ! Ticket {identifier} đang được đội Kỹ thuật tiếp nhận, có cập nhật em sẽ báo anh/chị ngay nhé.",
  "ticket.cancel_hint_after_create":
    'Dạ nếu anh/chị muốn hủy hoặc đóng ticket {identifier}, anh/chị nhắn rõ giúp em "hủy {identifier}" (kèm lý do nếu có) để em xác nhận chuyển trạng thái nhé ạ.',
  "ticket.already_created_hint":
    "Dạ ticket {identifier} em đã tạo rồi ạ, anh/chị không cần xác nhận lại nhé.",
  "action.suggest_append_lead": "Dạ tin này là bổ sung cho {identifier}",
  "action.suggest_conflict_lead": "Dạ tin này có thông tin (SĐT/mã) khác với {identifier}",
  "action.suggest_unclear_prompt":
    "Dạ anh/chị bấm giúp em một nút phía trên để em ghi đúng chỗ nhé ạ.",
  "action.suggest_unclear_prompt_with_media":
    "Dạ anh/chị bấm giúp em một nút phía trên để em ghi đúng chỗ (đã nhận kèm {count} ảnh/tệp) nhé ạ.",
  "clarify.new_incident_prompt": "Dạ vâng, anh/chị mô tả sự cố mới giúp em nhé ạ.",
  "action.suggest_append_preview":
    '{lead}{title} phải không ạ? Em sẽ ghi vào {identifier}:{quoted}{files}{alternatives}\n\nAnh/chị bấm nút xác nhận để em ghi, hoặc "{newIncidentLabel}" nếu là việc khác nhé.',
  "action.suggest_append_media_note": "\n(kèm {count} ảnh/tệp)",
  "action.suggest_append_other_tickets":
    "\n\nAnh/chị còn ticket đang mở khác, nếu tin này thuộc ticket đó thì bấm đúng mã:\n{list}",
  "action.priority_uplift":
    "⏫ Nâng mức ưu tiên {from} → {to} theo đề nghị của người báo. Lý do: {reason}",
  "status.closed_done": "Hoàn tất (Done)",
  "status.closed_canceled": "Đã hủy (Canceled)",
  "comment.supplement_default_content": "Bổ sung thông tin",
  "reporter.default_name": "Người báo",
  "bot.default_name": "Tiểu Linh",
  "edit.title_label": "Tiêu đề",
  "edit.description_label": "Mô tả",
  "edit.not_present": "(chưa có)",
  "status.unknown": "chưa rõ",
  "notify.on_call_supplement":
    "📢 **[{botName}]** Người báo vừa bổ sung thông tin vào ticket **{identifier}**:\n> {summary}",
  // ── PR 12: huỷ và đóng ticket theo yêu cầu người báo (RFC 0002 §1.4 D8, ADR-0006) ──
  "button.confirm_cancel": "✅ Hủy {identifier}",
  "button.confirm_close": "✅ Đóng {identifier}",
  "button.keep_ticket": "Giữ lại",
  "action.preview_cancel_ticket":
    'Dạ anh/chị xác nhận giúp em hủy ticket {identifier}{title} (chuyển sang Đã hủy) với nội dung dưới đây nhé? Nếu muốn giữ ticket thì bấm "{keepLabel}" ạ.{quoted}{files}',
  "action.preview_close_ticket":
    'Dạ anh/chị xác nhận giúp em đóng ticket {identifier}{title} (chuyển sang Hoàn tất) với nội dung dưới đây nhé? Nếu muốn giữ ticket thì bấm "{keepLabel}" ạ.{quoted}{files}',
  "action.cancel_close_done":
    "Dạ em đã {actionLabel} ticket {identifier} và ghi chú lý do trên hệ thống rồi ạ.{draftNote}",
  "action.keep_ticket_done": "Dạ vâng, em giữ nguyên {identifier}, không đổi trạng thái ticket ạ.",
  "action.cannot_read_status":
    "Dạ em chưa đọc được {identifier} để kiểm tra trạng thái, anh/chị thử lại sau ít phút nhé.",
  "action.label_close": "đóng (Hoàn tất)",
  "action.label_cancel": "hủy (Đã hủy)",
  "action.draft_kept_note": " Sự cố «{title}» anh/chị đang báo dở em vẫn giữ nguyên nhé.",
  "ticket.cancel_close_closed_refusal":
    "Dạ ticket {identifier} hiện đã đóng ở trạng thái {statusLabel} trên hệ thống rồi nên em không chuyển lại nữa ạ.",
  "comment.cancel_or_close_trace":
    "{icon} **{who}** yêu cầu {action} ticket → chuyển **{state}**.\nLý do: {reason}",
  "action.word_close": "đóng",
  "action.word_cancel": "hủy",
  "action.icon_done": "✅",
  "action.icon_canceled": "🛑",
  "action.state_done": "Done",
  "action.state_canceled": "Canceled",
  "action.column_not_found":
    "Dạ em chưa tìm thấy cột {stateLabel} trong dự án để chuyển {identifier} ạ.",
  "button.none": "Không có",
  "checklist.header": "Dạ để kỹ thuật xử lý nhanh, anh/chị gửi giúp em những thông tin sau ạ:",
  "checklist.closing": 'Cái nào không có thì anh/chị nhắn "không có", em tạo ticket luôn ạ.',
  "checklist.ask.SCREENSHOT": "Ảnh chụp màn hình lỗi (thấy rõ màn hình/thông báo đang hiện)",
  "checklist.ask.ERROR_TEXT":
    "Nội dung thông báo lỗi hiện trên màn hình (chép nguyên văn nếu được)",
  "checklist.ask.STEPS": "Anh/chị bấm/thao tác những bước nào, ở màn hình nào thì ra lỗi",
  "checklist.ask.EXPECTED_VS_ACTUAL":
    "Đang hiện gì và đúng ra phải hiện gì (ví dụ hạn đang hiện / hạn đúng mong muốn)",
  "checklist.ask.TIME": "Thời điểm xảy ra lỗi (ngày/giờ, mới bị hay bị từ lâu)",
  "checklist.ask.DEVICE_APP": "Thiết bị và phiên bản app/trình duyệt đang dùng",
  "checklist.ask.STUDENT_ID": "Mã/tài khoản học sinh (UID/CID/SID) hoặc SĐT",
  "checklist.ask.CARE_STUDENT_LINK":
    "Link chi tiết học sinh trên se-care (dạng https://se-care.example.com/student-care/student-detail/…)",
  "checklist.ask.CRM_CONTACT_LINK": "Link chi tiết contact trên se-crm (không cần gửi SĐT)",
  "checklist.ask.LMS_UID_LINK":
    "UID học sinh hoặc link LMS (dạng https://se-lms.example.com/module/ctvcskh/user/update?id=…)",
  "checklist.ask.ORDER_CODE": "Mã đơn hàng (DHxxxxxx)",
  "checklist.ask.COURSE_CLASS_SCOPE":
    "Học sinh nào, khoá học/lớp/buổi học nào bị ảnh hưởng (nhiều học sinh thì ghi rõ từng em)",
  "checklist.ask.OTHER_LINK": "Link trang/bài/đề đang bị lỗi",
  "checklist.ask.EXTENT": "Một người bị hay nhiều người/tất cả đều bị",
  "skill.message.greeting":
    "Dạ em Tiểu Linh nghe ạ anh/chị ơi! Bên mình đang gặp sự cố gì thì gửi em thông tin hoặc ảnh chụp màn hình để em hỗ trợ xử lý ngay nhé ạ.",
  "skill.message.help":
    '**Em là Tiểu Linh — Hỗ trợ kỹ thuật VUIHOC.**\n\nEm giúp anh/chị gửi sự cố trực tiếp tới đội Kỹ thuật:\n- **Báo sự cố:** Gửi mô tả lỗi kèm ảnh chụp màn hình nếu có.\n- **Tra cứu tiến độ:** Nhắn *"tiến độ sao rồi em"* hoặc kèm mã ticket.\n- **Giục xử lý khẩn cấp:** Nhắn *"gấp lắm em ơi"* để ưu tiên xử lý ngay cho lớp học.\n- **Bổ sung thông tin:** Gửi thêm số điện thoại, tài khoản hoặc ảnh lỗi để em cập nhật vào ticket đang xử lý.\n\n*Gõ /reset nếu muốn hủy phiên trao đổi dở để bắt đầu lại.*',
  "skill.message.after_reset":
    "Đã làm mới phiên làm việc! Anh/chị gửi mô tả sự cố kèm ảnh (nếu có) để em hỗ trợ nhé ạ.",
};
