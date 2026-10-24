# ADR-0003: SQLite cục bộ là bộ nhớ phụ, Itsaplan mới là nguồn sự thật

Ngày: 2026-10-16
Trạng thái: accepted

## Bối cảnh

Chủ dự án chốt (16/10/2026): thông tin quan trọng đã nằm ở Itsaplan. SQLite trong
`@vuihoc/bot-core` chỉ là bộ nhớ cục bộ cho tiện — nhớ user Telegram để lần sau khỏi
hỏi lại, giữ bản nháp đang dở, chống trùng. Mất file SQLite thì coi như chưa có, thu
thập lại là xong, không phải sự cố dữ liệu.

Nguyên tắc này quyết định cách thư viện dùng SQLite: không coi nó là kho bền, không
làm migration phức tạp để cứu dữ liệu cũ, không chặn khởi động khi file hỏng.

## Quyết định

1. **Itsaplan là nguồn sự thật.** Mọi dữ kiện phải sống sót qua một lần mất máy —
   nội dung ticket, mã định danh người báo, trạng thái xử lý — được ghi lên Itsaplan,
   không chỉ ở SQLite. Code không bao giờ đọc SQLite làm căn cứ cho một điều mà Itsaplan
   mới là nơi chốt.
2. **SQLite là cache có thể dựng lại.** Mọi bảng phải chịu được việc bị xoá: thiếu thì
   thu thập lại từ người dùng hoặc từ Itsaplan ở lần tương tác sau, không hỏng luồng.
   `CREATE TABLE IF NOT EXISTS` + `applySchema` tiêm qua `core` lazy-db là đủ; không cần
   framework migration.
3. **Hỏng file không được làm chết bot.** Mở DB lỗi thì log và chạy tiếp ở chế độ "chưa
   biết gì về user này" (hỏi lại), không ném lỗi ra gateway.
4. **Phân mức dữ liệu** (xem bảng): phần lớn là *vứt được*; riêng danh tính là *nên sao
   lưu* vì dựng lại tốn công của người dùng và lịch sử relink là chỗ dựa của bản vá chống
   chiếm tài khoản — nhưng kể cả mất, vẫn thu thập lại được, chỉ phiền hơn.

## Các bảng SQLite hiện có

| Bảng | Tầng | Giữ gì | Mất thì sao |
|---|---|---|---|
| `intake_documents` | intake/draft | bản nháp hội thoại đang dở | Vứt được. Người dùng gõ lại từ đầu; ticket đã tạo đã ở Itsaplan |
| `ticket_bindings` | intake/draft | gắn chat ↔ ticket để báo ngược | Vứt được. Mất thì tin báo ngược không về đúng chat cho tới khi người dùng nhắn lại; bản thân ticket không mất |
| `message_routes` | intake/notify | reply nào thuộc ticket nào | Vứt được. Dựng lại khi có tin mới |
| `webhook_dedupe` | itsaplan/webhook | khoá sự kiện đã xử lý | Vứt được. Mất cùng lắm gửi lại một thông báo trùng |
| `user_identities` | identity | mã định danh + trạng thái duyệt + lịch sử relink | **Nên sao lưu.** Thu thập lại được (user đăng ký lại) nhưng tốn công; lịch sử relink là chỗ dựa của bản vá chống chiếm tài khoản |
| `approved_prefixes` | identity | tiền tố được tự duyệt | Nên sao lưu cùng `user_identities` |

## Hệ quả

- Bot chỉ cần một file `.db` cục bộ, không cần máy chủ CSDL. Backup là tuỳ chọn, chỉ nên
  làm với hai bảng identity.
- Khi thêm bảng mới vào thư viện, mặc định xếp vào nhóm *vứt được*. Nếu một bảng không
  chịu được việc mất (phải là nguồn sự thật), đó là tín hiệu dữ liệu đó nên nằm ở Itsaplan,
  không phải SQLite — xem lại thiết kế trước khi thêm.
- Không viết migration kiểu nâng cấp cột để cứu dữ liệu cũ. Nếu schema đổi không tương
  thích, chấp nhận coi như cache rỗng.

## Việc theo sau

Hiện mở DB lỗi mới được xử lý ở mức `openLazyDb` của `core`. Cần soát để chắc mọi điểm
đọc identity đều có đường "chưa biết → hỏi lại" khi bảng trống hoặc hỏng, đúng điểm 3.
