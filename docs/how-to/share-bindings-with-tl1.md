# Dùng chung binding với Tiểu Linh 1

Việc cần làm: lễ tân TL2 tạo ticket thật trong lúc hậu cần vẫn là Tiểu Linh 1 (TL1, đang chạy production), nên hai bên phải dùng chung "ticket này của chat nào". Thiết kế và lý do: [RFC 0002 mục 6.2](/rfc/0002-receptionist). Trang này là cách làm, kèm giới hạn đã biết.

## Hai dạng bảng

TL1 và core cùng có bảng `ticket_bindings` và `message_routes` nhưng không giống nhau:

| | Dạng core (`intakeApplySchema`) | Dạng legacy (file của TL1) |
|---|---|---|
| `ticket_bindings.channel_type` | không có (`notifyApplySchema` thêm cột có DEFAULT) | `NOT NULL`, không DEFAULT |
| `ticket_bindings.message_id` | không có | `NOT NULL`, không DEFAULT |
| `ticket_bindings.reporter_user_id` | có (nullable) | không có |
| `message_routes` | `chat_id`, `kind` | như nhau |

Ghi bằng câu `INSERT` của core vào file legacy thì vi phạm `NOT NULL`; TL1 đọc file dạng core thì thiếu cột. Vì vậy `SqliteChannelBindingStore` ghi được cả hai dạng:

- **Dạng legacy**: ghi `channel_type = 'telegram'` và `message_id = '0'` (hằng `LEGACY_MESSAGE_ID_PLACEHOLDER`), đúng như `bindIssueToChat` của TL1, và cùng câu `ON CONFLICT` (ghi lại thì cập nhật, `title` và `reporter_username` cũ được giữ khi lần sau bỏ trống). TL1 đọc được binding do core ghi và ngược lại; `SqliteNotifyBindingReader` và `SqliteMessageRouteStore` đọc/ghi file legacy mà không cần cấu hình.
- **Dạng core**: như trước, không đổi.

## Cách nhận dạng

Store **dò cột** của `ticket_bindings` (`PRAGMA table_info`): có `message_id` thì là legacy. Tuỳ chọn `schema` cho phép khẳng định `"core"` hoặc `"legacy"`; khẳng định lệch với bảng thật thì `BindingSchemaError` ngay ở constructor, không ghi gì.

Vì sao dò chứ không chỉ dùng cờ: file legacy do tiến trình khác (TL1) sở hữu, nên đường dẫn trong cấu hình có thể trỏ nhầm hoặc file có thể đổi dạng sau lưng ta; một cờ sai sẽ chỉ lộ ra thành lỗi `NOT NULL` giữa production. Vì sao vẫn có cờ: nơi mà sai là nghiêm trọng (app trỏ vào file legacy) khẳng định `"legacy"` để cấu hình sai bị chặn to thay vì âm thầm ghi dạng core.

## Core không bao giờ đổi schema file legacy

- `intakeApplySchema` và `notifyApplySchema` **từ chối** file legacy (ném `BindingSchemaError`): chúng ALTER bảng binding và sẽ trộn tờ khai TL2 vào `intake_documents` của TL1. File được coi là legacy khi `ticket_bindings` có `message_id`, hoặc có bảng đặc trưng của TL1 (`intake_sessions`, `chat_flags`, `pending_ticket_updates`, `kg_sync_queue`).
- File legacy chỉ mở bằng `openLegacyBindingDb(path)`: tạo bảng còn thiếu (đúng DDL của TL1, nên TL1 mở file sau đó vẫn chạy y nguyên), không ALTER, không thêm index, không đặt PRAGMA, không chmod file đã có. File mới tạo có quyền 0600.
- `message_routes` của file TL1 cũ chưa qua migration của TL1 (thiếu `chat_id` hoặc `kind`) bị từ chối. Core không tự migrate; chạy TL1 một lần cho nó migrate.
- `ticket_states` (vòng đời) có `project_key` `NOT NULL` ở TL1 mà core không điền, nên không đặt trong file legacy.

## Tờ khai TL2 ở file riêng

`intake_documents` có ở cả hai bên với cùng tên bảng và cột, nhưng `state_json` khác hình dạng (`IntakeDraft` của TL2, `IntakeDocument` của TL1). **Đừng bao giờ** cho `INTAKE_DB_PATH` của TL2 trỏ vào file của TL1. Bố trí đúng: tờ khai TL2 ở một file dạng core, binding ở file legacy, hai `Database` riêng.

Mẫu sau chạy trong CI: tờ khai ở một file, binding ở file legacy (ở đây bằng SQLite trong RAM), và kiểm hai thứ TL1 cần đọc.

```ts run
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import {
  SqliteChannelBindingStore,
  intakeApplySchema,
  legacyBindingApplySchema,
} from "@vuihoc/bot-core/intake";

// Tờ khai của TL2: file riêng, dạng core.
const drafts = new Database(":memory:");
intakeApplySchema(drafts);

// Binding dùng chung với TL1: dạng legacy. (Thật thì dùng openLegacyBindingDb(path) trên file của TL1.)
const bindingDb = new Database(":memory:");
legacyBindingApplySchema(bindingDb);

const store = new SqliteChannelBindingStore(bindingDb, { schema: "legacy" });
store.saveBinding({ issueId: 42, chatId: "-1000000000001", identifier: "TECH-7", title: "Không vào được lớp" });

const row = bindingDb
  .query("SELECT channel_type, message_id, chat_id FROM ticket_bindings WHERE issue_id = 42")
  .get();
assert.deepEqual(row, { channel_type: "telegram", message_id: "0", chat_id: "-1000000000001" });
assert.equal(store.getLatestBinding("-1000000000001")?.identifier, "TECH-7");
assert.equal(store.supportsReporterUserId, false);
```

## Giới hạn của dạng legacy

- **Không có `reporter_user_id`** (và core không được thêm cột): `reporterUserId` khi lưu bị bỏ, `getLatestBindingByUserId` luôn trả `null`, `rebindReporterUserId` trả 0 (`supportsReporterUserId` là `false`). Tra theo chat vẫn chạy.
- **`chatId` ghi nguyên văn như người gọi đưa vào**, giống TL1 (`String(chatId)`). Đọc thì chấp nhận cả `-100…`, `telegram:-100…`. Lễ tân TL2 phải đưa chat id đúng dạng mà TL1 đang lưu cho chat đó, nếu không worker TL1 tra `chat_id = ?` sẽ không thấy.
- Chỉ kênh `telegram` (hằng `LEGACY_CHANNEL_TYPE`).
- Ghi vào file legacy khi TL1 cũng ghi: SQLite khoá ghi theo file, `openLegacyBindingDb` đặt `busy_timeout` 5 giây. Không nên giữ transaction dài.

## Trỏ hậu cần TL2 (`apps/tieulinh`) vào file legacy

Mặc định hậu cần TL2 giữ binding trong `<BOT_DATA_DIR>/tieulinh-app.sqlite` và **không đổi**. Đặt `TIEULINH_BINDING_DB=/đường/dẫn/tuyệt/đối/file-của-TL1.sqlite` thì riêng `ticket_bindings` và `message_routes` đọc/ghi ở file đó (mở bằng `openLegacyBindingDb`, ép `schema: "legacy"`); trạng thái vòng đời, `app_kv` và còn lại ở kho của app. File không đúng dạng legacy thì app dừng khi khởi động. Chưa bật canary nào thì để trống biến này. Xem [Cấu hình và biến môi trường](/reference/config-env).

## Hoàn nguyên

Bỏ `TIEULINH_BINDING_DB` rồi khởi động lại app: nó quay về kho riêng. Không có gì trong file của TL1 bị đổi bởi core (ngoài các dòng binding và route do chính lễ tân ghi), nên không có bước dọn schema.
