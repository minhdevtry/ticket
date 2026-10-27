# Runbook canary và hoàn nguyên lễ tân

Quy trình vận hành shadow, thử nghiệm canary theo danh sách chat và hoàn nguyên khẩn cấp cho Tiểu Linh 2 (nửa lễ tân). Quyết định kiến trúc và bối cảnh: [RFC 0002 mục 6](/rfc/0002-receptionist), [Chạy bóng Tiểu Linh 2](/how-to/shadow-tl2) và [Dùng chung binding với Tiểu Linh 1](/how-to/share-bindings-with-tl1).

## 1. Nguyên tắc an toàn

| Nguyên tắc | Chi tiết |
|---|---|
| **TL1 là nguồn sự thật production** | Tiểu Linh 1 (`apps/tieulinh-legacy`) phục vụ 100% người dùng thật cho đến khi chủ duyệt chuyển đổi. Code TL1 được đóng băng hoàn toàn. |
| **Không gửi tin ra ngoài ngoài danh sách** | TL2 chạy shadow trên Colab/dev qua gateway OpenClaw và proxy an toàn. Tuyệt đối không gửi tin nhắn Telegram tới người dùng thật trừ khi chat ID nằm trong danh sách canary được duyệt (`CANARY_CHATS`). |
| **Không chia sẻ file tờ khai** | File tờ khai của TL2 (`intake_documents`) hoàn toàn độc lập với TL1 (`IntakeDraft` v2 khác hình dạng với `IntakeDocument` legacy). |
| **Dùng chung binding tương thích** | Giai đoạn canary ghi ticket thật vào dự án `TECH`, binding phải ghi vào file SQLite của TL1 bằng `SqliteChannelBindingStore` (chế độ legacy) để hậu cần TL1 tiếp tục gửi thông báo tiến độ. |
| **Hoàn nguyên dưới 1 phút** | Mọi bước hạ cờ và dừng dịch vụ phải thực hiện được trong vòng dưới 60 giây mà không cần deploy lại code. |

## 2. Cấu hình Canary theo Chat ID (`CANARY_CHATS`)

Canary cho phép bật tương tác hai chiều cho một số nhóm thử nghiệm nội bộ (kỹ thuật, QA), trong khi toàn bộ các chat còn lại chỉ chạy chế độ shadow một chiều (ghi log cặp `pairs.jsonl` để so sánh).

### Khai báo biến môi trường

Tại gateway OpenClaw hoặc cấu hình plugin `shadow-forwarder`:

```bash
# Danh sách chat ID được phép tương tác 2 chiều với TL2 (phân tách bằng dấu phẩy)
# Chat ID nội bộ đã phê duyệt (dùng chat giả tổng hợp làm ví dụ):
CANARY_CHATS="-1000000000001,-1000000000002"

# Bật/tắt canary toàn cục (1: bật định tuyến canary; 0: chỉ shadow thuần)
CANARY_ENABLED=1
```

### Cơ chế định tuyến

```
Tin Telegram từ người dùng
        │
        ▼
[Gateway OpenClaw / Plugin shadow-forwarder]
        │
        ├── Chat ID thuộc CANARY_CHATS && CANARY_ENABLED == 1?
        │       │
        │       ├── ĐÚNG ──► Bật tương tác 2 chiều: chuyển lời vào TL2 lễ tân
        │       │            TL2 trả lời, hiển thị nút, tạo ticket vào TECH
        │       │            Ghi binding tương thích (TL1 hậu cần theo dõi)
        │       │
        │       └── SAI  ──► Shadow thuần 1 chiều:
        │                    Chỉ gửi bản sao tin tới relay (máy dev)
        │                    Ghép cặp so sánh trong pairs.jsonl
        │                    TL2 KHÔNG gửi tin Telegram ra chat
```

### Cấu hình plugin trên OpenClaw Gateway

Trong `openclaw.json` trên máy chủ gateway:

```json
{
  "plugins": {
    "entries": {
      "shadow-forwarder": {
        "enabled": true,
        "config": {
          "relayUrl": "http://10.0.0.2:3106/ingest",
          "canaryChats": ["-1000000000001", "-1000000000002"],
          "canaryEnabled": true
        }
      }
    }
  }
}
```

## 3. Kịch bản hoàn nguyên khẩn cấp (< 1 phút)

### Tình huống kích hoạt hoàn nguyên (Trigger conditions)

Kích hoạt hoàn nguyên ngay lập tức khi gặp một trong các điều kiện sau:

1. **Sai lệch mức S0 (vi phạm an toàn)**:
   - TL2 tự ý tạo ticket khi người dùng chưa bấm nút xác nhận.
   - TL2 ghi đè hoặc làm mất định danh người báo (`customerId`, số điện thoại).
   - TL2 huỷ hoặc đóng ticket của người khác mà không có xác nhận chính chủ.
2. **Lỗi hệ thống hoặc mô hình LLM**:
   - Model LLM trả lỗi HTTP 500, 429 hoặc timeout liên tiếp (> 3 lần).
   - Độ trễ một lượt p90 vượt quá 60 giây.
   - Gateway OpenClaw sập liên tục hoặc `/healthz` không trả về `ok`.
3. **Phản hồi từ người dùng hoặc trực ca**:
   - Người báo trong nhóm canary khiếu nại bot phản hồi sai logic hoặc lặp vô tận.
   - Trực ca kỹ thuật phát hiện ticket tạo ra sai sót nghiêm trọng.

### Các bước hoàn nguyên tức thì (< 60s)

#### Bước 1: Hạ cờ Canary tức thì (< 15 giây)

Trên gateway production, tắt ngay cờ canary hoặc gỡ danh sách chat:

```bash
# Cách 1: Đặt biến môi trường hạ cờ tức thì
export CANARY_ENABLED=0

# Cách 2: Cập nhật openclaw.json
# Đổi "canaryEnabled": false hoặc "canaryChats": []
```

Khi cờ tắt, plugin `shadow-forwarder` ngay lập tức ngừng chuyển tiếp hai chiều; mọi tin nhắn chỉ còn được xử lý độc quyền bởi Tiểu Linh 1.

#### Bước 2: Dừng an toàn dịch vụ TL2 trên Colab (< 30 giây)

Sử dụng script `deploy/colab/cup-tieulinh.sh` với tuỳ chọn role:

```bash
# Dừng riêng vai lễ tân (OpenClaw gateway & MCP server)
deploy/colab/cup-tieulinh.sh -H colab2 --role receptionist stop

# Hoặc dừng toàn bộ cả hậu cần và lễ tân
deploy/colab/cup-tieulinh.sh -H colab2 --role all stop
```

Lệnh gửi tín hiệu `SIGTERM` tới tiến trình, đợi tối đa 20 giây rồi gửi `SIGKILL` và dọn dẹp file PID.

#### Bước 3: Kiểm tra xác nhận sau hoàn nguyên (< 15 giây)

1. Kiểm tra trạng thái tiến trình trên Colab:
   ```bash
   deploy/colab/cup-tieulinh.sh -H colab2 --role receptionist status
   # Kỳ vọng: openclaw (receptionist): dừng
   ```
2. Gửi tin nhắn thử nghiệm từ tài khoản test vào chat canary:
   - Xác nhận Tiểu Linh 1 trả lời bình thường.
   - Xác nhận không có tin nhắn kép hay phản hồi lạ từ Tiểu Linh 2.
3. Kiểm tra binding và ticket:
   - Các ticket đã tạo trong phiên canary vẫn an toàn trên itsaplan.
   - File binding SQLite của TL1 không bị khoá hay lỗi truy vấn.

## 4. Xử lý sự cố thường gặp (Troubleshooting)

### Colab bị thu hồi hoặc rớt SSH tunnel

- **Hiện tượng**: Relay trên máy dev không chuyển tiếp được request tới Colab; log relay báo lỗi kết nối tới cổng 18796 (gateway) hoặc cổng 18998/18999 (proxy).
- **Khắc phục nhanh (< 30s)**:
  1. Khởi động lại tunnel SSH trên máy dev:
     ```bash
     deploy/dev/tl2-shadow.sh restart tunnel
     ```
  2. Nếu VM Colab bị Google thu hồi phiên:
     - Mở lại máy Colab: `cup -H colab2` (hoặc bật notebook Colab).
     - Triển khai lại cả hai role bằng lệnh idempotent:
       ```bash
       deploy/colab/cup-tieulinh.sh -H colab2 --role all
       ```
     - Chạy lại kiểm tra trạng thái:
       ```bash
       deploy/colab/cup-tieulinh.sh -H colab2 --role all status
       ```

### Quota LLM hoặc rate-limit (429 / 503)

- **Hiện tượng**: Proxy MiniMax trên máy dev (`tools/tl2-shadow/proxy.ts`, cổng 18999) ghi log mã lỗi 429 (Too Many Requests) hoặc 503 từ nhà cung cấp LLM.
- **Khắc phục**:
  - Không cần sửa mã nguồn app.
  - Cập nhật model fallback trong cấu hình `minimax.env` hoặc khởi động lại với tham số `--model`:
    ```bash
    deploy/colab/cup-tieulinh.sh -H colab2 --role receptionist --model MiniMax-M3.1-Flash
    ```
  - Proxy trên dev kiểm tra allowlist model hợp lệ và tự động chuyển hướng request.

### Lệch dữ liệu binding giữa TL1 và TL2

- **Hiện tượng**: Ticket được tạo thành công bởi TL2 trên dự án `TECH`, nhưng khi kỹ thuật viên kéo ticket sang Resolved hoặc comment thì bot không thông báo lại cho người báo trong chat Telegram.
- **Nguyên nhân**:
  - Đường dẫn binding DB chưa trỏ đúng vào file SQLite của TL1.
  - Cột `channel_type` hoặc `message_id` bị thiếu do ghi sai chế độ schema.
- **Khắc phục**:
  - Kiểm tra kết nối binding bằng `SqliteChannelBindingStore` (chế độ `"legacy"`).
  - Đảm bảo `channel_type = 'telegram'` và `message_id` có giá trị giữ chỗ (mặc định `'0'`).
  - Tuyệt đối không trỏ `INTAKE_DB_PATH` của TL2 vào file của TL1 để tránh xung đột bảng `intake_documents`.

## 5. Danh mục kiểm tra sẵn sàng (Readiness Checklist)

Trước khi kích hoạt bất kỳ chat canary nào trên production, người vận hành phải xác nhận đủ các tiêu chí:

- [ ] Toàn bộ 17 PR di trú RFC 0002 đã được merge vào `main`.
- [ ] Bộ chạy bóng đạt chỉ số sẵn sàng: M0 = 0 (không có lỗi S0), M1 >= 95% trong 7 ngày liên tiếp.
- [ ] File binding tương thích đã được diễn tập đọc/ghi hai chiều thành công (`bun run --cwd packages/core test`).
- [ ] Kịch bản hoàn nguyên khẩn cấp đã được diễn tập thực tế trên máy dev và Colab (< 60s).
- [ ] Đã thông báo trước cho nhóm người dùng trong danh sách canary về việc thử nghiệm bot mới.
- [ ] Có sự chấp thuận rõ ràng của chủ hệ thống trước khi bật cờ.
