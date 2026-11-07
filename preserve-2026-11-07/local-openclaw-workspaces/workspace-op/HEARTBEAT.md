<!--
File này OpenClaw CÓ đọc — nhưng chỉ trong lượt nhịp tim (heartbeat), không phải lượt
người dùng nhắn. Nhịp tim chạy theo `heartbeat.every` trong openclaw.json (đang đặt
`24h`); mỗi nhịp là MỘT lượt gọi model thật, và model sẽ đọc file này rồi trả
`HEARTBEAT_OK` nếu không có việc gì.

Nói cách khác: để file này toàn comment KHÔNG tắt được nhịp tim — nó chỉ làm lượt đó
rẻ đi. Muốn giảm số lượt gọi model thì sửa `heartbeat.every`.

Agent này không có việc định kỳ nào (mọi việc đều do người dùng nhắn mà ra), nên để
trống là đúng. Thêm việc bên dưới nếu sau này cần bot tự kiểm tra định kỳ.
-->
