# Tham chiếu: engine lễ tân (`@vuihoc/bot-core/intake`)

Hợp đồng công khai của máy trạng thái tiếp nhận sự cố: một lượt hội thoại vào
(`step`), một kết quả ra (`StepOutput`). Chữ ký hàm, kiểu và tham số: xem
[API (TypeDoc)](/reference/api/) (subpath `intake`). Trang này nói những điều
chữ ký không nói được: kết quả nào ứng với `action` nào của hợp đồng cũ, tờ
khai giữ gì, và đầu vào được chuẩn hoá thế nào.

Thiết kế đầy đủ: [RFC 0002](/rfc/0002-receptionist) (mục 2.1 và 2.3).

## Cổng `step`

`IntakeEngine.step(input)` nhận `StepInput` (`chatId`, `message`, `mediaPaths`,
`reporter`, `forceNew`) và trả `StepOutput` (`outcome`, `messages`, `issue`).
Mỗi tin trong `messages` có `text` và, tuỳ lượt, `buttons` — **câu hỏi cũng mang
nút** (nút chọn giá trị của trường enum trong catalog, nút xác nhận, nút "sự cố
mới hay bổ sung"). Chữ gửi người báo lấy từ `CopyCatalog`; engine không có
chữ tiếng Việt nào trong code.

## `action` của hợp đồng cũ ↔ `StepOutcome`

Persona và skill OpenClaw phụ thuộc vào tên `action` của tool `intake_step`, nên
hợp đồng đó phải giữ nguyên ở mọi harness. Engine có bộ kết quả riêng; bảng
ánh xạ chính thức nằm ở `legacyActionForOutcome` (`@vuihoc/bot-core/intake`).

| `action` của hợp đồng cũ | `StepOutcome` của engine |
|---|---|
| `ask_missing_field` | `asked` |
| `clarify_intent` | `clarify` |
| `confirm_summary` | `summary` |
| `awaiting_user_confirmation` | `too_soon` |
| `ask_new_or_continue` | `parked` |
| `ask_split_or_merge` | `split_question` |
| `confirm_ticket_action` | `action_preview` |
| `ticket_created` | `created` |
| `post_create_update` | `action_done`, `not_owner`, `closed_refusal` |
| `lookup_result` | `lookup` |
| `already_created` | `already_created` |
| `canceled` | `action_canceled`, `canceled` |
| `create_failed` | `failed` |
| `in_progress` | `in_progress` |

`needs_resend` và `chitchat` là kết quả **chỉ có ở core** (hợp đồng cũ không
có), nên không ánh xạ được. Lưu ý: không có đường nào của engine trả `chitchat`
nữa (huỷ tờ khai đã trả `canceled`) — tên nó còn trong bảng để giữ nguyên hợp
đồng cũ.

## Tờ khai v2

Tờ khai (`IntakeDraft`) có **phiên bản** (`version`, hiện hành là 2). Bản cũ
đọc được: khi đọc từ kho, `migrateDraft` nâng tờ khai cũ lên hình dạng hiện
hành, nên không cần viết lại kho và không mất dữ liệu.

Bản 2 bổ sung các trường hội thoại mà bản cũ thiếu: `lastAskedFields` (trường
vừa hỏi), `requestedPriority` (mức xin kèm lý do), `techReviewDone` và
`techQuestion` (đã soát dữ kiện kỹ thuật chưa, hỏi gì), `unrecognizedDept`
(bộ phận ngoài danh mục), `pendingSplit` kèm `pendingSplitQueue` (tách báo cáo
nhiều sự cố) và `extraText`/`clarifyCount`, `mediaAmbiguous` (ảnh dùng chung),
`pendingNewIncident` (đang chờ chọn "sự cố mới hay bổ sung") và
`backgroundWork` (dấu của việc nền).

PR 4 mới chỉ **khai báo** các trường này: engine hiện chỉ ghi `lastAskedFields`,
`techReviewDone` và `techQuestion`. Đường ghi của `unrecognizedDept`,
`requestedPriority` đến ở PR 7 (hỏi bổ sung theo luật), của `pendingSplit`,
`pendingSplitQueue`, `mediaAmbiguous` đến ở PR 9 (tách báo cáo nhiều sự cố) —
theo kế hoạch di trú của RFC 0002.

## Chuẩn hoá đầu vào

Tiền xử lý chạy TRƯỚC khi gọi bộ trích xuất, tất định, không nhờ LLM:

| Việc | Luật |
|---|---|
| Tin vô nghĩa | Tin rỗng, hoặc chỉ là token nội bộ của nút (`noop`), mà không kèm ảnh thì bỏ qua: không tạo tờ khai, không tạo ticket, không đụng trạng thái đang có. Chỉ trả lời theo trạng thái tờ khai (đã tạo → `already_created`, đang tạo → `in_progress`, chờ xác nhận → `too_soon` kèm nút xác nhận, đang gom → `asked`, đã huỷ → `canceled`, chưa có → `clarify`) |
| Từ chối | "không biết", "em không rõ ạ", "chưa có" → trường vừa hỏi vào `explicitlyMissing` (bot thôi hỏi trường đó), và câu trả lời **không** vào mô tả ticket |
| Câu trả lời cho câu hỏi dữ kiện | Luôn vào mô tả, kể cả khi chỉ là một mã (ví dụ mã đơn hàng) |
| Trần mô tả | Một tin giữ tối đa 4.000 ký tự, cả cuộc tối đa 8.000 ký tự — đúng trần của bản cũ. Mô tả ticket là **nguyên văn** người báo (ADR-0010) |

## Ngữ cảnh cho bộ trích xuất

`ExtractInput.context` cho bộ trích xuất biết lượt này đang nói về cái gì:
`draftTitle`, `draftDescription` (cắt 1.500 ký tự), `techQuestion` (câu hỏi
dữ kiện kỹ thuật vừa hỏi), `lastAskedFields` (trường vừa hỏi) và
`createdTicket` (ticket vừa tạo trong chat, mô tả cắt 4.000 ký tự). Không có
ngữ cảnh thì bộ trích xuất dễ đọc câu trả lời cho câu hỏi vừa hỏi thành lời
báo sự cố mới.
