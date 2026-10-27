# Đặc tả: Issue #68 — Kịch bản kiểm thử E2E thật cho Tiểu Linh 2 trên TECH2 kết hợp Telegram MCP

## Context

Repo: `minhdevtry/ticket`. Đây là Issue #68, ticket thứ 3 — mắt xích nghiệm thu toàn trình (End-to-End) của chuỗi triển khai Tiểu Linh 2 cục bộ trên máy dev.
- **Tiền đề**:
  - Issue #66: Project `TECH2` đã được khởi tạo và đồng bộ cấu hình trên server Itsaplan nội bộ.
  - Issue #67: Bộ launcher cục bộ `deploy/dev/tl2-local.sh` (`bun run dev:tieulinh2`) đã sẵn sàng bật/tắt Lễ tân và Hậu cần trên máy dev.
- **Mục tiêu**: Xây dựng kịch bản kiểm thử E2E chạy thật 100% (không dùng mock in-memory giả lập) kết nối trực tiếp với Itsaplan `tech/TECH2` và tương tác qua bot Telegram thật `@test_ticket123_bot`.
- **Nguyên tắc chỉ đạo từ Người dùng**:
  1. **Test thật, không mock**: Chạy trực tiếp trên server Itsaplan nội bộ với dự án `TECH2`, thoải mái tạo ticket thật để kiểm tra toàn bộ luồng dữ liệu 2 chiều.
  2. **Tự động hoá tương tác qua Telegram MCP**: Tận dụng phiên người dùng `TE_MINHDN3` (đã cấu hình Telethon trong `~/Downloads/test/telegram-mcp/`) để tự động đóng vai người dùng gửi tin, nhận phản hồi và bấm nút tương tác với bot `@test_ticket123_bot`.
  3. **Tuyệt đối không commit Token lên Git**: Token bot Telegram chỉ nạp qua biến môi trường hoặc file cấu hình ngoài repo `~/.config/ticket/telegram.env`; `bun run scan` phải sạch hoàn toàn.

**Tài liệu đọc trước (bắt buộc):**
- `orchestration/WORKER-CONTRACT.md`, `AGENTS.md`, `CODING_STANDARDS.md`.
- `deploy/dev/tl2-local.sh` (từ Issue #67).
- `scripts/sync-itsaplan-project.ts` (từ Issue #66).
- `~/Downloads/test/telegram-mcp/_send_to_bot.py` và `_read_bot_chat.py`.
---

## Problem Statement

Sau khi hạ tầng Lễ tân và Hậu cần đã được đóng gói và có script launcher cục bộ:
- Cần một bộ kịch bản kiểm thử trọn gói từ A đến Z (End-to-End) trên môi trường thật: từ lúc người dùng mở Telegram gửi tin báo lỗi, bot hỏi trường thiếu, người dùng bấm nút, ticket được tạo trên Itsaplan `TECH2`, cho tới khi kỹ thuật viên đổi trạng thái ticket và bot bắn tin báo ngược về Telegram.
- Nếu chỉ kiểm thử bằng mock trong bộ nhớ thì không thể chứng minh được tính toàn vẹn của kết nối mạng, định dạng webhook, phân giải token, hay hành vi hiển thị nút bấm thật trên ứng dụng Telegram.

---

## Solution

Xây dựng bộ công cụ kiểm thử E2E thật: `scripts/test-e2e-live.ts` (kèm npm script `"test:e2e:live": "bun run scripts/test-e2e-live.ts"`):
1. **Kiểm tra môi trường trước khi chạy (Pre-flight Checks)**:
   - Kiểm tra `ITSAPLAN_BASE_URL` và kết nối tới server Itsaplan nội bộ.
   - Xác nhận `ITSAPLAN_PROJECT_KEY=TECH2` (cấm tuyệt đối nếu trỏ vào `TECH` prod).
   - Kiểm tra trạng thái của các dịch vụ cục bộ (`./deploy/dev/tl2-local.sh status`). Nếu chưa bật thì tự động khởi động hoặc hướng dẫn bật.
   - Nạp `TELEGRAM_BOT_TOKEN` từ `~/.config/ticket/telegram.env` hoặc môi trường (bot `@test_ticket123_bot`).
2. **Kịch bản kiểm thử Toàn trình (End-to-End Flow)**:
   - **Bước 1: Gửi tin báo sự cố**: Gọi script Telethon (hoặc tích hợp qua Telegram MCP) sử dụng session `TE_MINHDN3` gửi tin nhắn báo lỗi kỹ thuật tới `@test_ticket123_bot`.
   - **Bước 2: Phản hồi & Hỏi bổ sung**: Đọc phản hồi của bot, xác minh bot nhận diện sự cố, hỏi trường thông tin còn thiếu và gửi kèm các nút bấm (inline keyboard buttons).
   - **Bước 3: Tương tác nút & Xác nhận**: Giả lập bấm nút chọn trường hoặc gửi tin bổ sung -> Nhận tin tóm tắt -> Bấm nút "Xác nhận tạo sự cố".
   - **Bước 4: Kiểm tra Ticket trên Itsaplan**: Sử dụng `ItsaplanClient` truy vấn `TECH2`, xác nhận ticket mới đã được tạo thành công với tiêu đề, mô tả và độ ưu tiên chính xác.
   - **Bước 5: Webhook tương tác 2 chiều**: Cập nhật trạng thái ticket trên `TECH2` (ví dụ chuyển sang cột `Resolved` hoặc thêm bình luận) -> Xác minh bot hậu cần nhận webhook và gửi tin thông báo cập nhật ngược về chat Telegram của `TE_MINHDN3`.
3. **Báo cáo kết quả trực quan**:
   - In toàn bộ biên bản hội thoại giữa `TE_MINHDN3` và `@test_ticket123_bot`.
   - In link ticket trên `TECH2` đã được tạo để người dùng có thể mở trình duyệt xem trực tiếp.
   - Xuất thông báo: *"Kịch bản kiểm thử E2E thật đã chạy thành công 100%, sẵn sàng để người dùng nghiệm thu trực tiếp"*.

---

## User Stories

1. **As a product owner**, I want to run `bun run test:e2e:live` and watch a real ticket get created in `tech/TECH2` on the actual server, so that I have zero doubt the integration works.
2. **As a tester**, I want the automated test to drive a real Telegram conversation using session `TE_MINHDN3`, so that I can see the real bot responses and inline buttons in my Telegram app.
3. **As a security engineer**, I want all Telegram and Itsaplan credentials loaded strictly from git-ignored local configuration files, so that public repo scanning always remains clean.

---

## Implementation Decisions

### 1. Phân định tệp tin
- `scripts/test-e2e-live.ts`: Kịch bản điều phối chạy kiểm thử E2E chính.
- `scripts/telegram-driver.py` (hoặc wrapper gọi `~/Downloads/test/telegram-mcp/`): Script phụ trợ điều khiển Telethon session `TE_MINHDN3` gửi và đọc tin nhắn.
- `package.json`: Bổ sung `"test:e2e:live": "bun run scripts/test-e2e-live.ts"`.

### 2. Quản lý bí mật & An toàn
- File cấu hình bí mật: `~/.config/ticket/telegram.env` chứa token bot Telegram. Script tự động đọc file này nếu biến môi trường chưa có.
- Tuyệt đối không in toàn bộ token hay session string ra log terminal.
- Bảo vệ `TECH` prod: Chặn cứng script nếu cấu hình trỏ vào `projectKey !== "TECH2"`.

---

## Testing Decisions

1. **Chạy thử nghiệm nội bộ**:
   - Chạy `bun run test:e2e:live --dry-run` để kiểm tra kết nối mạng và tính hợp lệ của token.
   - Chạy thật chu kỳ tạo 1 ticket kiểm thử trên `TECH2`.
2. **Kiểm định vệ sinh repo**:
   - `bun run scan` sạch 100% (không có token, không lộ session string, không IP nội bộ).
   - `bun run verify` pass hoàn toàn.

---

## Ranh giới & Điều cấm (Worker Constraints)

- **Chỉ sửa trong**: `scripts/`, `package.json`.
- **CẤM**:
  - Không sửa mã nguồn của `@vuihoc/bot-core` hay `apps/tieulinh`.
  - Không commit bất kỳ token, khoá bí mật hay session string nào vào git.
  - Không thao tác hay sửa đổi bất kỳ ticket nào trong project `TECH` production.
  - Không commit, không push.

---

## Tiêu chí chấp nhận (Acceptance Criteria)

- [ ] Script `scripts/test-e2e-live.ts` hoàn thiện, có khả năng kết nối Itsaplan `TECH2` và bot Telegram `@test_ticket123_bot`.
- [ ] Chạy thành công chu trình tạo ticket thật trên `TECH2` thông qua cuộc hội thoại giữa `TE_MINHDN3` và bot.
- [ ] Xác nhận luồng webhook 2 chiều: đổi trạng thái trên Itsaplan tạo ra thông báo Telegram tương ứng.
- [ ] In báo cáo chi tiết kèm ID ticket và nội dung đối thoại.
- [ ] `bun run scan` và `bun run verify` sạch hoàn toàn.
