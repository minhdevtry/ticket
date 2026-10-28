# Kiểm thử và Kịch bản Bot (Testing & Scenarios)

Tài liệu này hướng dẫn các nhà phát triển bot xây dựng chiến lược kiểm thử đa tầng cho bot tiếp nhận sự cố trên nền tảng `@vuihoc/bot-core`, từ kiểm thử đơn vị tất định đến kiểm thử toàn trình thực tế (Live E2E) và đối soát bộ dữ liệu chuẩn vàng.

---

## 1. Kiến trúc Đa tầng Kiểm thử

Một bot chất lượng cao dựng trên `@vuihoc/bot-core` tuân thủ tháp kiểm thử 5 tầng:

```
        ▲
       / \         Tầng 5: Đối soát Bộ Kiểm chuẩn Vàng (Golden Dataset - 50 ca biên)
      /   \        Tầng 4: Kiểm thử Webhook 2 chiều (Itsaplan ➔ Telegram với HMAC)
     /     \       Tầng 3: Kiểm thử Toàn trình Live E2E (Telegram Driver + Tracker thật)
    /       \      Tầng 2: Kiểm thử Kịch bản Thông minh (Smart Identity + Chống bấm đúp)
   /─────────\     Tầng 1: Kiểm thử Đơn vị Động cơ Tất định (Deterministic Unit Test)
```

1. **Tầng 1 (Tất định)**: Không gọi mạng, không gọi LLM, kiểm tra logic nghiệp vụ và máy trạng thái trong mili-giây.
2. **Tầng 2 (Kịch bản thông minh)**: Đảm bảo bot cư xử như một Agent có trí nhớ (Contextual Memory), không biến thành chatbot ngớ ngẩn hỏi lặp.
3. **Tầng 3 (Live E2E)**: Chạy đối thoại thật qua Telegram Client với tài khoản người dùng và tracker dự án thử nghiệm (ví dụ: `TECH2`).
4. **Tầng 4 (Webhook 2 chiều)**: Đảm bảo vòng lặp khép kín: khi ticket giải quyết, bot báo ngược về Telegram kèm nút xác nhận.
5. **Tầng 5 (Golden Dataset)**: Chạy đối soát ngoại tuyến trên 50 ca biên khó nhất từ lịch sử thực tế để đo độ thông minh.

---

## 2. Tầng 1: Kiểm thử Đơn vị Động cơ Tất định

Mọi quyết định phân nhánh nghiệp vụ của bot phải tất định và được kiểm chứng bằng unit test chạy trong vài mili-giây với `@vuihoc/bot-core/testing`:

```ts check
import { describe, expect, it } from "bun:test";
import { FakeItsaplan } from "@vuihoc/bot-core/testing";
import { ItsaplanClient } from "@vuihoc/bot-core/itsaplan";

describe("Động cơ tạo ticket", () => {
  it("tạo đúng 1 ticket khi người dùng xác nhận", async () => {
    const fake = new FakeItsaplan({ projectKey: "TECH2" });
    fake.start();

    const client = new ItsaplanClient(fake.baseUrl, fake.agentKey);
    const issue = await client.createIssue("TECH2", {
      title: "Lỗi không vào được bài học",
      description: "Mô tả sự cố thực tế",
      priority: "high",
      columnId: 1,
    });

    expect(issue.id).toBeGreaterThan(0);
    expect(issue.identifier).toContain("TECH2");

    fake.stop();
  });
});
```

---

## 3. Tầng 2: Kiểm thử Kịch bản Thông minh (Smart Scenarios)

### 3.1. Quy tắc Nhớ Danh tính Thông minh (Smart Identity Memory)
Một Agent thông minh không bao giờ hỏi lại những gì đã biết:
- Nếu người báo đã được lưu trong `IdentityRepository` với phòng ban (ví dụ: `Vận hành`), bot **tuyệt đối không hỏi lại** câu *"Anh/chị thuộc phòng ban nào?"*.
- Bot tự động gán `department: "Vận hành"` và chuyển ngay sang câu hỏi kỹ thuật chuyên sâu (ảnh chụp, thiết bị, mã lỗi).
- **Ngoại lệ tự khai**: Chỉ khi người báo tự khai trong tin nhắn (ví dụ: *"Báo hộ bên Sale"*), bot mới ghi đè theo lời tự khai đó.

```ts no-check
// Minh hoạ kiểm thử Smart Identity Memory
it("tự động nhận diện phòng ban đã lưu, không hỏi lại người dùng", async () => {
  identityRepo.saveUser({
    telegramUserId: "123456789",
    fullName: "Nguyễn Văn A",
    department: "Vận hành",
  });

  const packet = await engine.step({
    chatId: "123456789",
    message: "Học sinh không mở được video bài giảng",
  });

  // Bot không hỏi phòng ban mà hỏi thiết bị hoặc hệ thống
  expect(packet.missingFields).not.toContain("reporting_dept");
  expect(packet.document.fields.reporting_dept?.value).toBe("Vận hành");
});
```

### 3.2. Kịch bản Huỷ bỏ Sự cố (D8) & Lệnh Làm Mới (`/new`)
- Khi người dùng gửi `/new` hoặc `/reset`: Bot làm mới ngữ cảnh phiên, phản hồi `New session started`.
- Khi người dùng nhắn huỷ (*"Thôi huỷ đi em, anh vào lại được rồi"*): Tờ khai chuyển trạng thái `canceled`, dọn draft, không tạo ticket rác lên hệ thống.

### 3.3. Cơ chế Khóa Nút Chống Bấm Đúp (`iris-tuong-tac`)
Trong môi trường chat, người dùng có xu hướng bấm nút inline nhiều lần. Plugin `iris-tuong-tac` bắt callback query, đổi nhãn nút kèm dấu tick `✓` (ví dụ: `LMS_Vuihoc ✓`) và đổi `callback_data` thành `noop` để triệt tiêu hoàn toàn bão sự kiện lặp.

---

## 4. Tầng 3: Kiểm thử Toàn trình Thực tế (Live E2E)

Khi kiểm thử toàn trình, sử dụng một Telegram Client độc lập (qua MTProto/Telethon) để đóng vai người dùng thật:

```
[Người dùng Thật] ──Telegram──> [@bot_tiep_nhan] ──OpenClaw──> [IntakeEngine] ──API──> [Itsaplan Server]
```

### 5 Kịch bản Bắt buộc Kiểm chứng:
1. **Happy Path (A–Z)**: Báo lỗi ➔ Bot hỏi trường kỹ thuật thực sự thiếu ➔ Người dùng bấm nút ➔ Bot tóm tắt kèm nút xác nhận ➔ Bấm xác nhận ➔ Sinh ticket thật trên dự án test (ví dụ: `TECH2`).
2. **Huỷ bỏ (Cancel)**: Huỷ tờ khai giữa chừng an toàn.
3. **Lệnh `/new`**: Reset phiên làm việc.
4. **Khóa nút bấm**: Nút inline khóa ngay sau khi bấm lần đầu.
5. **Chiều ngược Webhook**: Nhận webhook giải quyết từ tracker và bắn tin Telegram.

Ví dụ kiểm tra ticket thật sinh ra trên Itsaplan API:
```ts check
import { expect, test } from "bun:test";
import { ItsaplanClient } from "@vuihoc/bot-core/itsaplan";

test("xác thực ticket sinh ra chuẩn ADR-0010", async () => {
  // Thay thế URL và key bằng biến môi trường kiểm thử
  const client = new ItsaplanClient("http://127.0.0.1:3100", "test_api_key");
  const issue = await client.getIssueByNumber("TECH2", 1);

  expect(issue.identifier).toBe("TECH2-1");
  // Mô tả lưu nguyên văn lời người báo, không bị LLM tóm tắt bóp méo
  expect(issue.description).toContain("## Thông tin sự cố");
  expect(issue.description).toContain("<!-- vuihoc-meta:");
});
```

---

## 5. Tầng 4: Kiểm thử Webhook 2 Chiều (Itsaplan ➔ Telegram)

Khi đội ngũ kỹ thuật chuyển trạng thái ticket sang `Resolved` hoặc `Done`, webhook gửi sự kiện về dịch vụ hậu cần của bot.

Dịch vụ hậu cần (`apps/tieulinh` hoặc `createBot`) xác minh chữ ký HMAC SHA-256 (`X-Itsaplan-Signature`), tra cứu chat ID tương ứng từ database liên kết, và bắn tin thông báo về Telegram kèm nút `👍 Đã ổn` (chuẩn ADR-0006 bản 10/10).

```ts no-check
// Bắn thử webhook giả lập có chữ ký HMAC hợp lệ
const payload = JSON.stringify({
  event: "issue.state_changed",
  data: {
    id: 1495,
    identifier: "TECH2-9",
    state: { name: "Resolved", type: "completed" },
  },
});

const signature = crypto.createHmac("sha256", webhookSecret).update(payload).digest("hex");

await fetch("http://127.0.0.1:3120/webhook", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Itsaplan-Signature": signature,
  },
  body: payload,
});
```

---

## 6. Tầng 5: Đối Soát với Bộ Kiểm Chuẩn Vàng (Golden Dataset)

Để nâng cấp năng lực ngôn ngữ và độ thông minh của bot mà không làm thay đổi các hành vi cốt lõi ngoài tầm kiểm soát, bot được chạy đối soát ngoại tuyến trên bộ kiểm chuẩn 50 ca biên thực tế:

* **File dữ liệu chuẩn**: [`docs/research/golden-50-done-cases.json`](/research/golden-50-done-cases.json)
* **Tài liệu phân tích chuyên sâu**: [Phân Tích Dữ Liệu Ca Done & Bộ Kiểm Chuẩn Vàng](/research/golden-dataset-analysis)

### Phân Bổ 50 Ca Biên:
* **10 ca Hỏi đáp nhiều lượt**: Người báo cung cấp thông tin ngắt quãng, thiếu thiết bị, tài khoản.
* **10 ca Tiếng lóng học vụ EdTech**: Xử lý các thuật ngữ `CTS`, `KHTN`, `cuốn chiếu`, `song song`, `lms`, `se-care`.
* **10 ca Báo nhiều sự cố gộp hoặc đổi ý giữa chừng**.
* **10 ca Báo hộ phòng ban khác**: Kiểm tra khả năng tách bạch giữa danh tính mặc định và lời tự khai.
* **10 ca Sự cố khẩn cấp (Urgent SLA)**: Phát hiện từ khóa báo động (`sập`, `toàn bộ lỗi 401`, `phòng học live ngắt kết nối`).

---

## 7. Quy Trình Chạy Kiểm Thử Trước Khi Mở PR

Trước khi tạo pull request cho bất kỳ bot nào, bắt buộc thực hiện kiểm tra 4 bước:

```bash
bun run lint                        # Kiểm tra cú pháp và định dạng mã nguồn
bun run scan                        # Bắt buộc sạch 100% PII, IP nội bộ, secret
bun run check                       # Typecheck toàn bộ workspace
bun run test                        # Chạy toàn bộ unit test
bun run docs:check                  # Kiểm tra TypeDoc và VitePress build
```

---

## 8. Cổng Kiểm Soát Triển Khai: Dự Án Test Chỉ Định (Designated Test Project Gate)

Triết lý kiểm thử hiện đại của `@vuihoc/bot-core` là **bỏ 80% mock nội bộ vô bổ và chạy thẳng vào hệ thống thật với LLM thật (không tốn tiền)**. Để bảo đảm kiểm soát rủi ro và giữ vững tính ổn định, hệ thống thiết lập một quy tắc bắt buộc: **Mọi tính năng trước khi deploy đều phải vượt qua Cổng Dự Án Test**.

### 8.1. Tại sao dùng Dự Án Test Cố Định thay vì Dự Án Tạm Xoá Ngay?
1. **Lưu giữ Hiện trường Nghiệm thu Trực quan**: Khi ticket được tạo trên dự án test (như `TECH2`, `CM_TEST`), lập trình viên và reviewer có thể mở trực tiếp giao diện Itsaplan để kiểm tra bằng mắt: định dạng bảng Markdown, ảnh đính kèm, các nhãn và bước chuyển cột Kanban. Nếu xoá ngay sau khi test chạy xong thì mất toàn bộ bằng chứng.
2. **Đường truyền Webhook 2 Chiều Ổn Định 24/7**: Tránh việc liên tục đăng ký và huỷ webhook subscription gây trễ mạng hoặc tồn đọng webhook rác trên server Itsaplan.
3. **Triệt Tiêu Ảo Giác Prompt (Prompt Drift)**: Gọi trực tiếp mô hình ngôn ngữ lớn (LLM) thật thay vì mock, đảm bảo bot hiểu đúng câu từ tiếng Việt thực tế của người dùng.

### 8.2. Bản Đồ Cặp Dự Án Chuẩn Trong Hệ Thống:

| Tên Bot | Dự Án Production (Thật) | Dự Án Test Chỉ Định (Cổng Kiểm Soát) | Mục Đích Của Dự Án Test |
| :--- | :---: | :---: | :--- |
| **Tiểu Linh (Kỹ thuật)** | `TECH` | `TECH2` | Chạy thử toàn trình các kịch bản tiếp nhận sự cố kỹ thuật |
| **Teacher Agent (CM Support)** | `CM` | `CM_TEST` (hoặc `CM2`) | Chạy thử kịch bản giáo viên báo nghỉ dạy, đổi ca, sự cố phòng học |
| **Bot Vận hành (Sales & QLL)** | `OPS` (hoặc `GS`) | `OPS_TEST` | Chạy thử kịch bản phân luồng tư vấn và chuyển đơn |

### 8.3. Điều Kiện Bắt Buộc Trước Khi Merge & Deploy:
Mọi Pull Request thêm tính năng hoặc sửa lỗi của bot phải đính kèm bằng chứng mã ticket thật sinh ra trên dự án test (ví dụ: `TECH2-6`, `TECH2-9`). **Cấm tuyệt đối merge và deploy khi chưa có bằng chứng chạy thật trên dự án test.**
