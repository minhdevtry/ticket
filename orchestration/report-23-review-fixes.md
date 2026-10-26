# Báo cáo xử lý 3 điểm review LOW — PR 9 (issue #23)

Worktree: `minhdevtry-feat-pr-9-split`
Nhánh: `minhdevtry/feat-pr-9-split`
PR: https://github.com/minhdevtry/ticket/pull/55
Commit gốc: `5dc4b11`
Đặc tả thực hiện: `orchestration/specs/issue-23-pr-9-review-fixes.md`

---

## 1. Đã làm gì (theo từng mục của đặc tả)

### Điểm 1: Bỏ chữ tiếng Việt hardcode trong core (`engine.ts`)
- **Tại `finishCreate` (`engine.ts:661`)**: Bỏ chuỗi `" (học sinh ${nextBlock.studentName})"` khỏi engine. Core truyền dữ liệu thô `{ identifier, studentName }` và chọn gọi `split.next_ticket_notice_student` nếu có tên học sinh hoặc `split.next_ticket_notice` nếu không có tên.
- **Tại `splitQuestionOutput` (`engine.ts:929`)**: Bỏ chuỗi `"sự cố"` và logic nối chuỗi fallback cứng khỏi core. Core bóc tách danh sách tên/mã thô (`studentName || customerId`). Nếu có tên/mã (`names.length > 0`), gọi `split.question` với `{ count, summary: names.join(", ") }`; nếu không có tên/mã (`names.length === 0`), gọi `split.question_no_names` với `{ count }`.
- **Cập nhật `CopyKey` và catalog**:
  - `packages/core/src/intake/ports.ts`: Thêm `split.question_no_names` và `split.next_ticket_notice_student`.
  - `packages/core/examples/tieulinh/copy.ts`: Bổ sung 2 khoá mới và chuẩn hoá `split.next_ticket_notice`, đảm bảo kết quả render với tiếng Việt giữ nguyên 100% từng byte so với trước:
    - `split.question`: `"Dạ em thấy tin nhắn có {count} học sinh/sự cố khác nhau ({summary}) — em tách {count} ticket nhé?"`
    - `split.question_no_names`: `"Dạ em thấy tin nhắn có {count} học sinh/sự cố khác nhau ({count} sự cố) — em tách {count} ticket nhé?"`
    - `split.next_ticket_notice`: `"Bây giờ em tiếp tục tạo ticket cho sự cố tiếp theo nhé ạ!"`
    - `split.next_ticket_notice_student`: `"Bây giờ em tiếp tục tạo ticket cho sự cố tiếp theo (học sinh {studentName}) nhé ạ!"`
  - `packages/core/src/intake/engine/test-copy.fixture.ts`: Khai báo bản tiếng Anh thuần túy, sạch hoàn toàn từ tiếng Việt bị lẫn trước đây:
    - `split.question`: `"There are {count} incidents ({summary}) — split into {count} tickets?"`
    - `split.question_no_names`: `"There are {count} incidents — split into {count} tickets?"`
    - `split.next_ticket_notice`: `"Now creating ticket for the next incident:"`
    - `split.next_ticket_notice_student`: `"Now creating ticket for the next incident (student {studentName}):"`
- Thêm test khẳng định chuỗi render giữ nguyên từng byte và kiểm tra luồng pipeline chọn đúng khoá khi khối tiếp theo không có tên học sinh.

### Điểm 2: Tách regex đọc phản hồi tách/gộp ra module thuần
- Tạo module thuần `packages/core/src/intake/split/replies.ts` định nghĩa hàm `classifySplitReply(reply: string): "split" | "merge" | "unknown"`.
- Chuyển toàn bộ các biểu thức chính quy (`negated`, `saysStopSplit`, `saysSplit`, `agreesToSplit`, `agreesToMerge`) từ `resolvePendingSplit` trong `engine.ts` sang `replies.ts`.
- `engine.ts` chỉ cần gọi `const decision = classifySplitReply(message)` và phân nhánh theo `"split"` / `"merge"`.
- Xuất khẩu `classifySplitReply` qua `packages/core/src/intake/split/index.ts`.
- Viết test đơn vị riêng trong `packages/core/src/intake/split/replies.test.ts` bao phủ 100% các biến thể phản hồi: đồng ý tách (`"tách"`, `"Tách 2 ticket"`, `"ok"`, `"ừ"`...), đồng ý gộp / huỷ tách (`"không tách"`, `"gộp 1 ticket"`, `"thôi"`, `"khỏi"`...), phủ định (`"đừng tách"`, `"chưa tách"`...), và phản hồi không rõ (`"sao cũng được em"`, tin lỗi khác, rỗng...).

### Điểm 3: Bỏ type assertion `as string[]` trong `split.ts`
- Tại `packages/core/src/intake/split/split.ts:86-87`, thay thế `filter(Boolean) as string[]` bằng custom type guard:
  ```ts
  const customers = new Set(
    validBlocks.map((b) => b.customerId).filter((id): id is string => Boolean(id)),
  );
  const students = new Set(
    validBlocks.map((b) => b.studentAccount).filter((acc): acc is string => Boolean(acc)),
  );
  ```
- Không còn bất kỳ type assertion `as string[]` nào trong module split.

---

## 2. File thay đổi

| STT | File | Thay đổi |
|---|---|---|
| 1 | `packages/core/src/intake/split/replies.ts` | **Mới**: module hàm thuần `classifySplitReply` |
| 2 | `packages/core/src/intake/split/replies.test.ts` | **Mới**: 4 ca test đơn vị cho `classifySplitReply` |
| 3 | `packages/core/src/intake/split/index.ts` | Re-export `* from "./replies"` |
| 4 | `packages/core/src/intake/split/split.ts` | Dùng type guard `id is string` thay `as string[]` |
| 5 | `packages/core/src/intake/ports.ts` | Bổ sung `CopyKey`: `split.question_no_names`, `split.next_ticket_notice_student` |
| 6 | `packages/core/examples/tieulinh/copy.ts` | Bổ sung và định dạng template tiếng Việt cho các khoá split copy mới |
| 7 | `packages/core/src/intake/engine/test-copy.fixture.ts` | Định dạng template tiếng Anh chuẩn cho các khoá split copy mới |
| 8 | `packages/core/src/intake/engine/engine.ts` | Gọi `classifySplitReply`, truyền raw params cho notice/question |
| 9 | `packages/core/src/intake/engine/pr9-split.test.ts` | Thêm 2 test khẳng định byte-for-byte chuỗi cũ và kiểm thử luồng không tên |
| 10 | `packages/core/CHANGELOG.md` | Ghi nhận module `classifySplitReply` và các `CopyKey` mới |

Không chạm các file ngoài Ownership: không sửa `apps/tieulinh-legacy/**`, `.github/**`, `scripts/**`, `biome.lint-baseline.json`, `package.json`, hay `bun.lock`. Không commit, không push.

---

## 3. Lệnh đã chạy và kết quả thật

| STT | Lệnh | Kết quả thật | Trạng thái |
|---|---|---|---|
| 1 | `bun run lint` | 20 diagnostics (chỉ là warnings định dạng/unused trong legacy cũ), `EXIT=0` | PASS |
| 2 | `bun run lint:baseline` | `ok style/noNonNullAssertion: 418 lỗi (cho phép tối đa 418)`<br>`ok suspicious/noExplicitAny: 780 lỗi (cho phép tối đa 780)`<br>`Số lỗi của các rule đang tắt không tăng.`, `EXIT=0` | PASS |
| 3 | `bun test packages/core/src/intake/split` | `9 pass, 0 fail, 76 expect() calls (32.00ms)`, `EXIT=0` | PASS |
| 4 | `bun test packages/core/src/intake/engine/pr9-split.test.ts` | `9 pass, 0 fail, 104 expect() calls (134.00ms)`, `EXIT=0` | PASS |
| 5 | `bun test packages/core/src/intake/engine/split-adversarial.test.ts` | `10 pass, 0 fail, 92 expect() calls (174.00ms)`, `EXIT=0` | PASS |
| 6 | `bun test packages/core/src/intake/engine/engine.test.ts` | `23 pass, 0 fail, 57 expect() calls (139.00ms)`, `EXIT=0` | PASS |
| 7 | `bun test apps/tieulinh/receptionist-gap-register.test.ts` | `9 pass, 0 fail, 1241 expect() calls (25.00ms)`, `EXIT=0` | PASS |

Bằng chứng bổ sung:
- `grep -n "học sinh\|sự cố" packages/core/src/intake/engine/engine.ts packages/core/src/intake/split/*.ts`: Toàn bộ các dòng khớp trong `engine.ts` và `split.ts` chỉ còn là comment/JSDoc và regex bắt đầu vào (`EXAMPLE_LIST_MARKER`), tuyệt đối không còn chữ hardcode trong logic sinh câu chữ ra ngoài.
- Test `khẳng định chuỗi copy split.question* và split.next_ticket_notice* giữ nguyên từng byte tiếng Việt cũ` trong `pr9-split.test.ts` khẳng định 4/4 chuỗi copy tiếng Việt khớp byte-for-byte với hành vi trước đó.

---

## 4. Test nào thêm, test nào port

- **Test thêm mới**:
  1. `packages/core/src/intake/split/replies.test.ts`:
     - `nhận diện đúng các biến thể đồng ý tách (split)`
     - `nhận diện đúng các biến thể đồng ý gộp / từ chối tách (merge)`
     - `xử lý phủ định: 'không tách', 'đừng tách' tuyệt đối không nhận thành split`
     - `trả về 'unknown' với câu trả lời không rõ ý hoặc chuyển chủ đề`
  2. `packages/core/src/intake/engine/pr9-split.test.ts`:
     - `khẳng định chuỗi copy split.question* và split.next_ticket_notice* giữ nguyên từng byte tiếng Việt cũ`
     - `pipeline: thông báo tiếp theo chọn đúng khoá khi khối kế tiếp không có studentName`
- **Test port**:
  - Giữ nguyên toàn bộ 22/22 ca test đã port ở PR 9, 100% tiếp tục xanh mà không phải điều chỉnh kỳ vọng.

---

## 5. Còn dở gì, và phần đó thuộc PR nào

- Toàn bộ 3 điểm LOW theo yêu cầu review cho PR 9 (issue #23) đã hoàn tất 100%, không còn tồn đọng.
- PR 9 sẵn sàng merge vào `main`.
