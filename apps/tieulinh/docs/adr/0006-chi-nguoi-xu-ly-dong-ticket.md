# Quy tắc đóng và hủy ticket (Done / Canceled)

- **Khởi tạo:** 24/09/2026
- **Cập nhật:** 10/10/2026 (quyết định người dùng / chủ dự án sau điều tra ca `TECH-951` & `TECH-999`)

## 1. Nguyên tắc gốc (24/09/2026)

Khi ticket ở cột `Resolved` ("đã xử lý"), người báo nhận thông báo kèm nút "👍 Đã ổn" (`reporter_ok`), cú bấm nút đó chỉ ghi comment cho chuyên viên xử lý và không có lịch tự đóng sau 24 giờ. Tri thức ticket (Memgraph KG, Onyx) chỉ nạp khi ticket sang `Done`.

## 2. Cập nhật nghiệp vụ từ người dùng (10/10/2026) — Xử lý khi người báo nhắn yêu cầu Hủy / Đóng ticket theo mã

1. **Phân biệt quyền và ý định thực tế:**
   - Khi người báo nói *"đóng ticket"* khi chưa ai xử lý thì ý thực tế của họ là **HỦY**.
   - Chỉ **chuyên viên** (thành viên dự án `TECH` trên Itsaplan) mới làm phát sinh trạng thái hoàn tất (`Done`). Người báo (không thuộc `TECH`) tự họ không thể chuyển ticket chưa xử lý sang `Done`.
2. **Quy tắc xử lý yêu cầu của người báo đối với ticket CỦA CHÍNH HỌ (`ownTicket === true`):**
   - **(a) Người báo nói RÕ "hủy / huỷ / bỏ ticket / không cần nữa / …":**
     → Chuyển ticket sang **`Canceled`** (`columnId = 5`), bất kể ticket đang chưa xử lý (`Backlog`/`Todo`), đang xử lý dở (`In Progress`), hay đã xử lý (`Resolved`).
   - **(b) Người báo nói "đóng" (hoặc báo sự cố đã tự hết / học sinh đã dùng được mà không nói rõ hủy):**
     - Nếu **ĐÃ CÓ chuyên viên xử lý thật** (định nghĩa: ticket đang ở cột `Resolved` **HOẶC** có từ `MIN_SPECIALIST_COMMENTS_FOR_DONE = 3` bình luận của chuyên viên thuộc dự án `TECH` trở lên, không tính người báo và không tính bot/`@tieulinh`) → chuyển sang **`Done`** (`columnId = 4`).
     - Nếu **CHƯA có chuyên viên xử lý đủ** (chưa ở `Resolved` và chỉ có `0`, `1` hoặc `2` bình luận từ chuyên viên) → chuyển sang **`Canceled`** (`columnId = 5`).
   - **(c) Ticket đã ở `Done` hoặc `Canceled`:**
     → Không chuyển lại, không ghi comment thừa; bot trả lời lịch sự rằng ticket đã đóng.
   - **(d) Quyền sở hữu (`ownTicket`):**
     → Chỉ người báo là chủ ticket mới kích hoạt được; người khác không được hủy/đóng ticket của người khác.
3. **Xác nhận một chạm & dấu vết bình luận (kết hợp ADR-0008):**
   - Vì đổi trạng thái là hành động thật: luôn qua một bước xác nhận một-chạm với nhãn nút rõ ràng, không mơ hồ:
     - Chuyển `Canceled`: **`[✅ Hủy TECH-X]`** / **`[Giữ lại]`**
     - Chuyển `Done`: **`[✅ Đóng TECH-X]`** / **`[Giữ lại]`**
     - Tuyệt đối không dùng nhãn `"Huỷ"` cho nút từ chối thao tác để tránh nhầm với hủy ticket (`TECH-951`).
   - Sau khi người báo bấm xác nhận: bot gọi `updateIssue(issueId, { columnId })`, ghi bình luận giải thích tự động (`"Người báo yêu cầu hủy/đóng → chuyển Canceled/Done"`, kèm lý do người báo đã qua `escapeItsaplanMarkdown`), và nhắn lại người báo.
