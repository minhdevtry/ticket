# Tham chiếu: testing (`@vuihoc/bot-core/testing`)

Công cụ test cho bot dùng thư viện. Chỉ dùng trong test, không import từ code chạy thật. Chữ ký hàm, kiểu và tham số: xem [API (TypeDoc)](/reference/api/) (subpath `testing`). Trang này tả hành vi và định dạng mà chữ ký không nói được.

## Thành phần

| Thành phần | Việc |
|---|---|
| `FakeItsaplan` | Itsaplan giả trên HTTP thật, nói giao thức [agent-runs](/reference/agent-runs) và đủ phần tracker cho `ItsaplanClient`. |
| `FakeLlm` | LLM giả trên HTTP thật, nói cả hai kiểu API ([LLM](/reference/llm)). |
| `ManualClock` | Đồng hồ tay: thời gian chỉ đi khi test gọi `advance`. Khớp `Clock` của `intake`, nên truyền thẳng vào `IntakeEngine`. |
| `ScriptedChat` | Chạy kịch bản "tin vào, kỳ vọng ra" qua `engine.step` (bất kỳ đối tượng nào có `step`). Cách dùng: [Kiểm hội thoại bằng kịch bản và bản ghi vàng](/how-to/golden-scripts). |
| `parseFixture`, `serializeFixture`, `goldenScript` | Đọc, ghi và biến fixture bản ghi vàng thành kịch bản phát lại. |
| `compareGolden`, `applyAllowlist`, `formatGoldenReport` | So một lần chạy với bản ghi vàng, đối chiếu với danh sách lệch được phép, in báo cáo. |
| `normalizeVoiceText` | Chuẩn hoá mã ticket và link trong chữ gửi người báo trước khi so. |

## `ScriptedChat`

- Lượt chạy tuần tự. `run` trả `ScriptRun` (`turns`, `mismatches`, `ok`, `format()`, `assertOk()`) và **không** ném khi lệch kỳ vọng.
- `advanceMs` cần móc `clock` (có `advance(ms)`, thường là `ManualClock`); `extract` cần móc `extractor` (có `push(...)`, bộ trích xuất giả của test). Thiếu móc mà kịch bản dùng thì `run` ném lỗi, không lặng lẽ bỏ qua.
- Chữ của một lượt là các tin của `StepOutput` nối bằng xuống dòng. Nút là mọi hàng của mọi tin, hoặc `null`.
- Mã chat mặc định là `telegram:-1000000000001` (mã giả dành cho fixture).

## Định dạng fixture

Mỗi file `packages/core/golden/intake/<kịch-bản>.json` là một `GoldenFixture` (`format: 1`), thụt 2 dấu cách, có xuống dòng cuối.

| Trường | Ý nghĩa |
|---|---|
| `scenario`, `description` | Tên (trùng tên file) và mô tả |
| `source` | Test legacy mà kịch bản bắt nguồn (đường dẫn và tên test) |
| `startMs` | Mốc đồng hồ ban đầu (ms epoch) |
| `minConfirmDelayMs` | Độ trễ tối thiểu giữa tóm tắt và xác nhận mà bản ghi dùng |
| `turns[].advanceMs`, `message`, `mediaPaths?` | **Đầu vào**: đồng hồ đi thêm bao lâu, người báo gửi gì |
| `turns[].extract?` | Kết quả trích xuất ghim cho bộ trích xuất giả của engine mới |
| `turns[].action` | **Đầu ra**: `action` của `intake_step` legacy |
| `turns[].voiceText` | **Đầu ra**: chữ gửi người báo, mã ticket thành `{identifier}`, link thành `{url}` |
| `turns[].buttons` | **Đầu ra**: hàng nút (`text`, `callbackData`) hoặc `null` |

Đổi hình dạng thì tăng `GOLDEN_FORMAT` và sửa `parseFixture`.

## So sánh

`compareGolden` so ba trường của mỗi lượt và trả danh sách chỗ lệch (`scenario`, `turn` đếm từ 1, `field`, `expected`, `actual`):

| Trường | So |
|---|---|
| `action` | `StepOutcome` của engine đổi sang `action` legacy bằng bảng `LEGACY_ACTION_OF_OUTCOME` (bảng tạm theo RFC 0002 mục 2.3; hàm ánh xạ chính thức vào ở PR 4). Kết quả không có trong bảng (`chitchat`, `needs_resend`) giữ nguyên tên nên lệch hiện rõ |
| `voiceText` | Bằng nhau từng chữ sau `normalizeVoiceText` |
| `buttons` | Bằng nhau từng nút (`text` và `callbackData`), hoặc cùng là `null` |

## Allowlist

`GoldenAllow` là `{ scenario, turn, field, reason }`; `scenario` và `turn` có thể là `"*"`. `applyAllowlist` chia chỗ lệch thành `expected` (có dòng cho phép, kèm lý do), `unexpected` (không có dòng) và dòng `stale` (không còn khớp chỗ lệch nào). Dòng cụ thể đứng trước thắng dòng đứng sau.

Test của repo coi `unexpected` và `stale` đều là lỗi, nên allowlist chỉ co lại. Danh sách hiện tại: `packages/core/src/intake/engine/golden-intake.allowlist.ts`.

## Ghi bản ghi vàng

```bash
bun run --cwd apps/tieulinh-legacy golden:record [--check]
```

Chạy pipeline legacy với đồng hồ giả, itsaplan giả và bộ trích xuất không LLM; kết quả giống từng byte giữa các lần chạy. Chi tiết và cách thêm kịch bản: [Kiểm hội thoại bằng kịch bản và bản ghi vàng](/how-to/golden-scripts).
