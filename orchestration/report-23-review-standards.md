# Báo cáo review độc lập trục chuẩn hoá code — PR 9 (issue #23)

Worktree: `minhdevtry-feat-pr-9-split`
Nhánh: `minhdevtry/feat-pr-9-split`
PR: https://github.com/minhdevtry/ticket/pull/55
Diff đối chiếu: `git diff origin/main...HEAD` (19 file, +1912/-61)

---

## 1. Verdict

**APPROVE WITH CHANGES**

Toàn bộ 6/6 mục tiêu kiểm thử đều đạt kết quả tuyệt đối (100% test pass, 0 lỗi lint, baseline không tăng). PR thực hiện trọn vẹn đặc tả B7 của RFC 0002, port đầy đủ 22/22 ca test từ legacy giữ nguyên tên và ý, có ca đối kháng thực chất, sổ đối chiếu và parity documentation khớp chuẩn từng con số. Không vi phạm các ranh giới cấm (không chạm `apps/tieulinh-legacy/**`, `.github/**`, `scripts/**`, `biome.lint-baseline.json`, `package.json`, `bun.lock`).

Các phát hiện dưới đây ở mức LOW, không chặn merge, nhưng nên được tiếp thu/dọn dẹp ở các PR tiếp theo (hoặc PR 14 khi chuẩn hoá toàn diện phần chữ và domain).

---

## 2. Findings

### HIGH
*(Không có)*

---

### MEDIUM
*(Không có)*

---

### LOW

#### 1. Hardcode cụm từ tiếng Việt miền học sinh/sự cố trong logic core trước khi gọi `CopyCatalog`
- **Vị trí**:
  - `packages/core/src/intake/engine/engine.ts:661-665`
  - `packages/core/src/intake/engine/engine.ts:929-935`
- **Hiện tượng**:
  - Tại dòng 661: `const student = nextBlock.studentName ? ` (học sinh ${nextBlock.studentName})` : "";` rồi truyền biến `student` vào `split.next_ticket_notice`. Vì chữ `" (học sinh ...)"` bị gán cứng từ trong engine, fixture test copy tiếng Anh (`packages/core/src/intake/engine/test-copy.fixture.ts`) buộc phải khai báo `"split.next_ticket_notice": "Now creating ticket for the next incident{student}:"`, dẫn đến kết quả render là `"Now creating ticket for the next incident (học sinh Lê Văn Anh C):"` (lẫn tiếng Việt vào thông báo tiếng Anh).
  - Tại dòng 929-930: `const names = blocks.map((b) => b.studentName || b.customerId || "sự cố").filter(Boolean);` và `namesSummary = names.length > 0 ? names.join(", ") : `${blocks.length} sự cố`;`. Chuỗi `"sự cố"` bị gán cứng trong engine thay vì do `CopyCatalog` định dạng.
- **Lý do**:
  Vi phạm nguyên tắc phân tách trách nhiệm ở `CODING_STANDARDS.md` (§2, §4, §8) và `packages/core/GLOSSARY.md`: *"Core không hardcode tên sản phẩm, tên công ty hay tên hệ thống của một app: dữ liệu miền đi qua tham số"* và *"Logic tất định ở engine, diễn đạt ở CopyCatalog"*.
- **Cách sửa**:
  - Truyền trực tiếp dữ liệu thô `{ identifier: result.issue.identifier, studentName: nextBlock.studentName }` vào `copy.text("split.next_ticket_notice", ...)` và để template của app quyết định cách diễn đạt (ví dụ app Tiểu Linh tự chèn `" (học sinh " + studentName + ")"` trong copy formatter).
  - Đối với `namesSummary`, nếu không có tên/mã, truyền `count` và cho phép template `split.question` tự chọn danh từ số nhiều (như `"incidents"` trong tiếng Anh hoặc `"học sinh/sự cố"` trong tiếng Việt).

#### 2. Nhúng trực tiếp regex nhận diện phản hồi tiếng Việt trong private method của engine
- **Vị trí**: `packages/core/src/intake/engine/engine.ts:968-985`
- **Hiện tượng**:
  Các biểu thức chính quy xử lý phản hồi người dùng (`negated`, `saysStopSplit`, `saysSplit`, `agreesToSplit`, `agreesToMerge`) được khai báo trực tiếp inline bên trong phương thức `resolvePendingSplit` của `IntakeEngine`.
- **Lý do**:
  Làm phình kích thước `engine.ts` (hiện đã hơn 1.750 dòng). Các PR trước (như PR 8) đã thiết lập module `packages/core/src/intake/engine/text.ts` để gom các helper nhận diện văn bản thuần túy (`saysNewIncident`, `mentionedIdentifiers`, `foldButton`, `isDeclineAnswer`).
- **Cách sửa**:
  Tách các regex và hàm kiểm tra `isSplitAgreement(reply)`, `isMergeAgreement(reply)` ra `packages/core/src/intake/engine/text.ts` hoặc `packages/core/src/intake/split/split.ts` để `engine.ts` chỉ tập trung vào điều phối máy trạng thái.

#### 3. Type assertion `as string[]` trong `split.ts`
- **Vị trí**: `packages/core/src/intake/split/split.ts:86-87`
- **Hiện tượng**:
  ```ts
  const customers = new Set(validBlocks.map((b) => b.customerId).filter(Boolean) as string[]);
  const students = new Set(validBlocks.map((b) => b.studentAccount).filter(Boolean) as string[]);
  ```
- **Lý do**:
  Dùng `filter(Boolean) as string[]` là ép kiểu cưỡng bức do TypeScript chưa tự thu hẹp kiểu khi dùng `filter(Boolean)`. Mặc dù không phải `as any` hay `!`, việc dùng type assertion có thể che giấu thay đổi kiểu dữ liệu trong tương lai.
- **Cách sửa**:
  Dùng custom type guard `.filter((id): id is string => Boolean(id))` để đảm bảo an toàn kiểu tự nhiên mà không cần `as string[]`.

---

## 3. Bảng lệnh đã chạy và kết quả thật

| STT | Lệnh | Kết quả thật | Trạng thái |
|---|---|---|---|
| 1 | `bun run lint` | 20 diagnostics (chỉ là warnings định dạng/unused trong legacy cũ), `EXIT=0` | PASS |
| 2 | `bun run lint:baseline` | `ok style/noNonNullAssertion: 418 lỗi (tối đa 418)`<br>`ok suspicious/noExplicitAny: 780 lỗi (tối đa 780)`<br>`Số lỗi của các rule đang tắt không tăng.`, `EXIT=0` | PASS |
| 3 | `bun test packages/core/src/intake/split/split.test.ts` | `5 pass, 0 fail, 20 expect() calls (16.00ms)`, `EXIT=0` | PASS |
| 4 | `bun test packages/core/src/intake/engine/pr9-split.test.ts` | `7 pass, 0 fail, 95 expect() calls (137.00ms)`, `EXIT=0` | PASS |
| 5 | `bun test packages/core/src/intake/engine/split-adversarial.test.ts` | `10 pass, 0 fail, 92 expect() calls (224.00ms)`, `EXIT=0` | PASS |
| 6 | `bun test apps/tieulinh/receptionist-gap-register.test.ts` | `9 pass, 0 fail, 1241 expect() calls (28.00ms)`, `EXIT=0` | PASS |

---

## 4. Những vùng đã kiểm nhưng không thấy lỗi

1. **Ranh giới an toàn và quy định sửa đổi file**:
   - Kiểm tra `git diff origin/main...HEAD`: Không có file nào thuộc `apps/tieulinh-legacy/**`, `.github/**`, `scripts/**`, `biome.lint-baseline.json`, `package.json` gốc, hay `bun.lock` bị chỉnh sửa.
   - Toàn bộ thay đổi nằm đúng trong các vùng ownership được phân công của PR 9.
2. **Không `any`, không non-null assertion (`!`) trong code mới**:
   - Kiểm tra toàn bộ diff thêm mới bằng regex `(: *any\b|\bas any\b|!)`. Tất cả các dấu `!` trong code mới đều là toán tử phủ định logic (`!flag`, `!==`).
   - `bun run lint:baseline` xác nhận số lỗi của cả hai rule đều giữ nguyên mức sàn, không tăng một lỗi nào.
3. **Bảo tồn bất biến an toàn (ADR-0008, ADR-0010)**:
   - **Mô tả ticket nguyên văn (ADR-0010)**: `ticket.rawText` trên tờ khai không bao giờ bị chèn nhận định hay phỏng đoán của bot. Việc chèn `media.ambiguous_notice` vào `description` khi tạo ticket được thực hiện hoàn toàn độc lập thông qua `claim.mediaAmbiguous` theo đúng đặc tả RFC 0002 §1.5 B7 ("bật `mediaAmbiguous` để mô tả nói rõ").
   - **Xác nhận qua nút (ADR-0008)**: Các ticket trong hàng đợi tách đều yêu cầu người báo xác nhận từng ticket trước khi gọi `tracker.createIssue`.
4. **Nguyên tắc "Một hằng, một hàm, một kiểu: một chủ duy nhất"**:
   - `residualProse` đã được xuất khẩu từ `packages/core/src/intake/extractor/heuristics.ts` để `split.ts` tái sử dụng, không sao chép lại.
   - `EXAMPLE_LIST_MARKER` chỉ định nghĩa một lần trong `packages/core/src/intake/split/split.ts`.
   - `EXPANDED_PROBLEM_WORDS` được tái sử dụng từ `heuristics.ts`.
   - `SplitBlock`, `PendingSplit` dùng chung định nghĩa đã có từ PR 4 trong `packages/core/src/intake/draft/types.ts`.
5. **Tính độc lập và tính đối kháng của test suite**:
   - Không phụ thuộc vào thời gian thực: toàn bộ test suite dùng `clockRef.now` và đồng hồ giả lập, không sử dụng `setTimeout` hay `sleep`.
   - Test khẳng định trên đầu ra hệ thống (`res.action`, `res.voiceText`, `document.fields`, `it$.calls.createIssue`), không tự dựng chuỗi cục bộ rồi assert chính nó.
   - 22 ca test port từ legacy giữ đúng nguyên văn tên gọi và mục tiêu kiểm thử so với `multi-incident.test.ts` và `split-adversarial.test.ts` của legacy.
   - Bộ 10 ca đối kháng (`split-adversarial.test.ts`) bao phủ đầy đủ các tình huống hiểm hóc: dán lại tin, gửi thêm HS thứ 3 khi đang hỏi tách, tin noop/ảnh, câu trả lời phủ định, người báo im lặng quá hạn TTL (>24h), cụm mức độ ưu tiên/phòng ban không bao giờ làm tiêu đề.
6. **Tính nhất quán giữa sổ đối chiếu, tài liệu và CHANGELOG**:
   - `packages/core/docs/parity/ENGINE.md`: marker `total=450 core=61 ported=109 deferred=269 by-design=11` khớp chính xác với kết quả chạy `apps/tieulinh/receptionist-gap-register.test.ts`. Hàng PR 9 cập nhật về 0 dòng `deferred`.
   - `packages/core/CHANGELOG.md`: ghi chú đầy đủ, mạch lạc các thay đổi public, các helper mới, các CopyKey mới và danh mục 22 test ported.
   - `docs/rfc/0002-receptionist.md` mục 1.5 và `docs/reference/intake-engine.md`: cập nhật chính xác trạng thái hoàn thành của dòng B7.
