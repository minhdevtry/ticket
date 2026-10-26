# Báo cáo issue #38 — test `closeAfter qua createBot` trôi trên CI

Worktree: `ticket/fix-flaky-closeafter-test` (nhánh của issue #38)
File sửa: `packages/core/src/bot/create-durable.test.ts` (chỉ file test, không đụng code runtime).

## 1. Khẳng định nào đỏ

Ca đỏ: `closeAfter qua createBot > Resolved → bot hẹn → qua restart → 48h sau chuyển Done; không comment trùng`
(`packages/core/src/bot/create-durable.test.ts`, dòng 372 ở bản gốc):

```
expect(second.store?.listTimers({ state: "done" })).toHaveLength(1);
error: expect(received).toHaveLength(expected)
Expected length: 1
Received length: 0
```

Lần chạy đỏ mất ~380–800 ms — khớp với "không phải hết hạn ở `until(..., 4000)`".

## 2. Nguyên nhân thật (khác giả thuyết trong spec)

Giả thuyết của spec ("`sleep(120)` cố định + khẳng định ngay sau `start()`") **không phải** nguyên nhân
của khẳng định đỏ này:

- Các khẳng định ngay sau `start()` (`listTimers({state:"pending"})` dài 1, `health().components.scheduler.pendingTimers === 1`)
  đọc thẳng kho SQLite, không phụ thuộc bộ chạy lịch đã "nạp" gì → luôn ổn định.
- `sleep(120)` chỉ là một chờ theo thời gian thực, nhưng nó KHÔNG làm đỏ ca này.

Nguyên nhân thật là **đua lệnh (race) giữa hành động và sổ sách của bộ chạy lịch**:

1. Hành động `closeAfter` chạy theo thứ tự: đọc lại issue → **comment** → **chuyển cột sang Done** (`moveTo`).
2. `until(() => fake.issues[0].columnId === 5)` trả về **ngay khi cột đã đổi** — tức là khi `moveTo` đã xong.
3. Nhưng bộ chạy lịch chỉ ghi trạng thái cuối của hẹn vào kho (`finishTimer(..., "done", ...)`) **sau khi**
   promise của hành động trả về (`BotScheduler.runTimer`).
4. Nên lệnh `listTimers({ state: "done" })` ngay sau `until(...)` có thể chạy **trước** lúc bộ chạy lịch kịp
   ghi trạng thái → đọc được 0 hẹn `done`. Máy bận (CI) làm khe thời gian này nở ra.

Ngoài ra `expect(...comments...).toHaveLength(1)` ("không comment trùng") cũng được đo **quá sớm**:
nếu bot có ghi comment trùng thì lúc đó nó còn chưa kịp xảy ra → khẳng định này vốn đã yếu.

## 3. Cách tái hiện

```bash
cd packages/core
# tải: 24–40 tiến trình test chạy song song
for i in $(seq 1 40); do bun test src/bot/create-durable.test.ts & done; wait
# lọc riêng ca đỏ (tải nhẹ hơn, vẫn đủ để đỏ):
bun test src/bot/create-durable.test.ts -t "48h sau chuyển Done"
```

Kịch bản dùng để đo (cùng một cách cho trước/sau):

| Cách đo | Bản gốc | Bản sửa |
| --- | --- | --- |
| Chạy **cả file**, 24 tiến trình song song (lần 1) | **9/24 đỏ** | — |
| Chạy **cả file**, 24 tiến trình song song (lần 2) | **3/24 đỏ** | — |
| Chạy **cả file**, 32 tiến trình song song | — | **0/32 đỏ** |
| Chỉ ca `48h sau chuyển Done`, 40 tiến trình song song | **11/40 đỏ** | **0/40 đỏ** |

Tỉ lệ đỏ phụ thuộc mức tải của máy (CI đông tiến trình hơn máy dev) → đúng đặc tính "trôi".

## 4. Sửa gì

Trong `packages/core/src/bot/create-durable.test.ts`:

1. **Chờ điều kiện thay vì chờ thời gian thực.**
   - `await sleep(120)` (bước 47h) → `await until(() => lastTickAt(second) >= clock.t)`:
     chờ một **vòng tick của bộ chạy lịch đã nhìn thấy giờ mới**, tức là đã thực sự xét hạn ở mốc 47h
     rồi mới kết luận "chưa đóng" (mạnh hơn hẳn việc đợi 120 ms).
   - `await sleep(150)` (ca anh em "mở lại trước hạn thì không đóng") → cùng kiểu chờ trên.
2. **Chờ hẹn chạy XONG, không chỉ chờ cột đã đổi.**
   `await until(() => fake.issues[0].columnId === 5 && timersSettled(second))`, trong đó `timersSettled`
   = không còn hẹn nào ở trạng thái `pending`/`firing` (tức `done`/`cancelled`/`failed`).
   Nhờ vậy các khẳng định "trạng thái hẹn = done" và "chỉ MỘT comment" đo sau khi hành động đã kết thúc
   → hết đua lệnh, và khẳng định "không comment trùng" trở nên có nghĩa thật.
3. **Ba helper nhỏ** ở đầu file: `lastTickAt(bot)`, `countTimers(bot, state)`, `timersSettled(bot)`
   (không `any`, không khóa non-null).
4. **Thêm khẳng định "hẹn đúng 48h"**: `expect(...dueAt).toBe(clock.t + 48 * HOUR)` (trước đó chỉ suy ra
   từ mốc 47h/49h).

Cả 4 ý mà ca test bảo vệ vẫn được khẳng định:

| Ý | Khẳng định |
| --- | --- |
| Hẹn 48h | `dueAt === clock.t + 48 * HOUR` (mới) + cột vẫn `Resolved` ở mốc 47h |
| Qua restart vẫn còn hẹn | `second.store.listTimers({state:"pending"})` dài 1, `health().components.scheduler.pendingTimers === 1` |
| Tới hạn thì chuyển Done | `fake.issues[0].columnId === 5` ở mốc 49h |
| Chỉ comment MỘT lần | `comments.filter(c => c.body.includes("Tự đóng."))` dài 1 (đo sau khi hẹn chạy xong) |

Không sửa code runtime, không đụng `apps/tieulinh-legacy/**`, không đụng `biome.lint-baseline.json`.

## 5. Ngoài phạm vi — một ca khác cũng trôi (KHÔNG sửa ở ticket này)

Ca `kho bền của createBot > ledger bền: kết quả đã tính mà chưa báo được thì lượt sau báo lại, KHÔNG chạy lại handler`
cũng đỏ khi chạy song song: **timeout 5000 ms của bun** (ca dùng `until(..., 8000)`).

Đã tái hiện trên **bản GỐC** (chưa sửa gì): `bun test src/bot/create-durable.test.ts -t "ledger"` × 24 tiến trình
→ **1/24 đỏ** ("this test timed out after 5000ms"; lỗi "Không có run 1" là hệ quả của vòng `until` còn sót
lại sau khi ca đã bị bun hạ giờ). Nguyên nhân khác hẳn (giới hạn timeout mặc định của bun so với thời gian
chờ trong ca), thuộc ca khác của issue #38 → **để chủ quyết riêng**, không sửa ở đây.

## 6. Kiểm chứng

- `bun test packages/core/src/bot/create-durable.test.ts` → 22 pass / 0 fail.
- Ca `48h sau chuyển Done`: 40 lần song song → **0 đỏ** (trước: 11/40 đỏ).
- Cả file: 32 tiến trình song song → **0 đỏ** (trước: 9/24 và 3/24 đỏ).
- `bun run lint` → EXIT=0 · `bun run test:scripts` → EXIT=0 · `bun run scan` → EXIT=0 ·
  `bun run docs:check` → EXIT=0 (không đổi docs).
- `bun run check` (tsc mọi workspace) → EXIT=0.

### `bun run verify` → EXIT=1, NHƯNG là lỗi có sẵn, không do bản sửa này

Chạy `bun run verify` trên **bản GỐC** (đã `git checkout` file test) và trên **bản SỬA**, cùng máy:

| Lần chạy | Kết quả | Ca đỏ |
| --- | --- | --- |
| verify trên bản GỐC | EXIT=1 | `packages/core` `llm/client.test.ts` "backoff không vừa trong hạn tổng" (đo thời gian) + `apps/tieulinh` "mọi file test legacy nằm trong đúng một nơi" |
| verify trên bản SỬA | EXIT=1 | `packages/core` "hiệu năng quét mốc lỡ" ×3 (đo `< 50 ms`), `llm` ×2, `src/bot/llm.test.ts` (timeout 5000 ms) + `apps/tieulinh` "mọi file test legacy nằm trong đúng một nơi" |

Cả hai lần đều đỏ ở **cùng một chỗ cố định**:
`apps/tieulinh/receptionist-gap-register.test.ts` → "mọi file test legacy nằm trong đúng một nơi:
dòng theo test, dòng theo file, hoặc sổ hậu cần" — file `scripts/golden/record.test.ts` của
`apps/tieulinh-legacy` (thêm ở commit gần nhất) chưa được khai trong sổ. Chạy riêng:
`bun test receptionist-gap-register.test.ts` trong `apps/tieulinh` → đỏ **y hệt** trên bản gốc
(lỗi tất định, không phụ thuộc tải). Cách sửa: thêm một dòng cho file đó trong `FILE_ROWS`
(cuối file) của `apps/tieulinh/receptionist-gap-register.test.ts` — **ngoài phạm vi ticket này**, để chủ quyết.

Các ca đỏ còn lại trong `packages/core` là ca đo thời gian (perf `< 50 ms`, timeout 5000 ms của bun):
chạy `bun run --cwd packages/core test` một mình cũng đỏ `llm/client.test.ts` "backoff không vừa trong
hạn tổng" — **cùng ca đỏ trong verify trên bản gốc**, tức không do bản sửa này.

Kết luận: bản sửa này **không làm đỏ thêm** bất kỳ ca nào; `verify` chưa xanh vì worktree này vốn đã có
lỗi tất định ở `apps/tieulinh` và vài ca đo-thời-gian ở `packages/core` (ngoài issue #38).
