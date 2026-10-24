# ADR-0005: Chạy bóng Tiểu Linh 2 trên Colab

- Trạng thái: chấp nhận
- Ngày: 2026-10-25

## Bối cảnh

Cần so Tiểu Linh 2 (bản dựng trên `@vuihoc/bot-core`) với Tiểu Linh 1 đang chạy thật, trên cùng tin nhắn thật, mà không ảnh hưởng người dùng, không để secret rời máy dev và không tốn tài nguyên máy server.

## Quyết định

- Server: plugin `shadow-forwarder` (`apps/tieulinh/openclaw-plugin/shadow-forwarder`) chỉ quan sát (`message_received`, `message_sent`, `after_tool_call`), bắn rồi quên tới relay; lỗi thì ghi spool giới hạn cỡ và thời gian. Không đăng ký hook chặn. Cấu hình sai thì plugin tự tắt, không "mở rộng phạm vi".
- Máy dev: `tools/tl2-shadow` gồm relay (hàng đợi JSONL 0600 ngoài repo, lưu 7 ngày), worker (gọi Tiểu Linh 2 theo thứ tự từng chat), proxy giữ secret, tunnel và `compare.ts`.
- Colab: gateway OpenClaw riêng, chỉ loopback, không có token Telegram, không có secret, cấm tool shell/file/web. Gọi MiniMax và itsaplan qua `ssh -R` tới proxy trên dev; dev gọi gateway qua `ssh -L`. Cả hai đi trên ControlMaster có sẵn.
- Relay mặc định chỉ nghe loopback. Muốn nhận từ server qua LAN phải bind vào một IP cụ thể, đặt token dùng chung (hai phía) và danh sách IP nguồn.
- Itsaplan thử: chỉ project `TECH2`. Proxy mặc định chặn: đọc chỉ trong project thử; ghi chỉ qua vài route có danh sách khoá body và kiểm tra mọi tham chiếu thuộc project thử; chặn DELETE, webhook, đính kèm, đổi project/team. Lúc khởi động proxy tự kiểm tra và từ chối chạy nếu khoá nhìn thấy project thật.
- Code lên Colab bằng `git archive` một git ref cố định, nên việc đang dở không bị gửi đi.

## Hệ quả

- Tiểu Linh 2 không bao giờ gửi tin cho người dùng thật: không có kênh Telegram.
- Chạy bóng không thêm độ trễ cho Tiểu Linh 1 (hook không được chờ, có cầu dao khi relay chết).
- Colab bị thu hồi sau khoảng 12 giờ: phải chạy lại `deploy/colab/cup-openclaw.sh`.
- Nội dung chat thật (kể cả tên, ID, username người gửi) rời server sang máy dev rồi sang Colab. Đây là rủi ro đã chấp nhận cho môi trường thử; xem trang [Chạy bóng Tiểu Linh 2](/how-to/shadow-tl2).
- Đường từ server tới relay hiện là HTTP trên LAN có token: chưa mã hoá. Bước sau có thể đổi sang `ssh -R` hoặc WireGuard.

## Phương án đã loại

- Đặt tools trong `apps/*`: đó là bot triển khai trên server; đây là công cụ chỉ chạy ở máy dev nên nằm ở `tools/`.
- Đưa key lên Colab: vi phạm ADR-0003.
- Hook `before_dispatch`: chặn luồng của Tiểu Linh 1.
