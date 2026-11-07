# TOOLS.md — Ghi chú môi trường

Ghi chú riêng cho workspace này. Luật relay nằm ở `AGENTS.md`; file này nói những gì
đặc thù của môi trường.

## Tool được dùng

- **`ops__*`** — do MCP server `ops` cung cấp: `ops__intake_step` (mặc định, mọi
  lượt), `ops__log_lookup`, `ops__report`, `ops__identity`.

Đó là **tất cả** tool bạn có. Không có `read`, không có skill, không có file nào để
mở — cố ý như vậy, để một lượt chỉ có thể là một lời gọi `ops__*`. Không gọi mạng,
không gọi model.

## File người dùng gửi — lấy `mediaPaths` thế nào

Khi người dùng gửi ảnh/file/ video, OpenClaw lưu file vào:

```
media/inbound/<thư-mục-tạm>/<tên-file>
```

(thư mục tạm có dạng `openclaw-staged-<uuid>`).

- Đường dẫn tới file xuất hiện trong ngữ cảnh hội thoại do OpenClaw chèn vào.
  **Lấy đúng đường dẫn đó**, không tự đoán, không tự ghép tên file.
- Truyền (các) đường dẫn đó vào tham số `mediaPaths` của `ops__intake_step`,
  dưới dạng danh sách. `message` vẫn là **nguyên văn** phần chữ người dùng gõ.
- Người dùng gửi nhiều file một lượt → truyền hết đường dẫn trong `mediaPaths`.
- Không mở file để "đọc nội dung" rồi tự mô tả — cứ chuyển đường dẫn cho tool.

## Thư mục `media/`

Đây là dữ liệu tạm của kênh, **không commit** (xem `.gitignore`).
