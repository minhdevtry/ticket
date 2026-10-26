# Cách làm

Mỗi trang là một việc cụ thể, làm theo từng bước. Trạng thái ghi thẳng ở đây để bạn khỏi mất công mở trang rồi mới biết nó chưa xong.

| Việc | Trạng thái |
|---|---|
| [Viết catalog tiếp nhận](/how-to/write-catalog) | Đã viết, mẫu code được CI chạy |
| [Thêm kênh chat](/how-to/add-channel) | Đã viết, mẫu code được CI typecheck |
| [Dựng worker báo ngược](/how-to/notify-worker) | Đã viết, có mẫu chạy được không cần mạng |
| [Dùng chung binding với Tiểu Linh 1](/how-to/share-bindings-with-tl1) | Đã viết, mẫu code được CI chạy |
| [Chạy shadow](/how-to/run-shadow) | Một phần: công cụ parity đã có; chế độ shadow chung cho bot **đang viết** |
| [Chạy bóng Tiểu Linh 2](/how-to/shadow-tl2) | Có: relay, proxy giữ secret và gateway Colab chạy song song với Tiểu Linh 1 |
| [Deploy và đẩy secret qua SSH](/how-to/deploy) | Một phần: đẩy secret và cập nhật code đã viết; unit systemd và rollback **đang viết** |
| [Gọi LLM trong handler hậu cần](/how-to/call-llm) | Đã viết, mẫu code được CI chạy với LLM giả |
| [Lịch chạy và hẹn giờ](/how-to/schedule-and-timers) | Đã viết, mẫu code được CI chạy |
| [Kiểm hội thoại bằng kịch bản và bản ghi vàng](/how-to/golden-scripts) | Đã viết, mẫu code được CI chạy với engine thật |
| [Chuyển project vào team](/how-to/move-project-to-team) | Một phần: phía code đã viết; quy trình trên itsaplan **đang viết** |
| [Chuyển bot sang bot-core](/how-to/adopt-core) | Đã viết |
| [Chuyển Tiểu Linh sang bot-core](/how-to/migrate-tieulinh) | Bản ghi lại việc đã làm |
| [Chạy Tiểu Linh 2 (hậu cần) với TECH2](/how-to/run-tieulinh-hau-can) | Đã viết: env, thư mục dữ liệu, chế độ nhật ký, cách kiểm tra |
| [Merge PR](/how-to/merge-pr) | Đã viết: chờ CI, kiểm tra trạng thái, merge, cập nhật issue |

Vai hậu cần: lịch cron và hẹn giờ có trang riêng ở trên; handler theo trigger, luật và test với `FakeItsaplan` chưa có trang Cách làm riêng. Bắt đầu từ [Dựng bot đầu tiên](/guide/first-bot), rồi xem [Bot kit](/explanation/bot-kit) và [giao thức agent-runs](/reference/agent-runs).

Các trang này dùng mẫu code có cờ `ts check` hoặc `ts run`, tức được CI kiểm với code thật. Nếu một mẫu không chạy được với bản bạn đang có, đó là lỗi của docs: mở issue.
