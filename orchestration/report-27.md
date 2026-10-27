# Báo cáo PR 13 của RFC 0002 — Soát thông tin (danh sách, LLM, tự học) (issue #27)

## 1. Đã làm gì (theo từng mục của đặc tả và chỉ đạo sớm của coordinator)

### Target 1: `packages/core/src/intake/` — Cổng soát & Engine
- **`TechReviewerPort`**: Dùng lại interface đã có tại `ports.ts`, bổ sung các trường ngữ cảnh tuỳ chọn `system?: string` và `product?: string` vào `TechReviewInput`.
- **`LearnedItemsPort` (F3)**: Khai báo cổng đọc danh sách mục học được và tỉ lệ `learned(system: string)` (và alias `getLearnedItems`). Core chỉ sở hữu interface read-only này; hoàn toàn KHÔNG có kho SQLite, schema hay upsert/ingest trong core.
- **`TechReviewPolicy` (F4)**: Khai báo chính sách soát `"off" | "checklist" | "llm"` tại `ports.ts` và đưa vào `IntakeEngineDeps.techReviewPolicy`. Core hoàn toàn không đọc biến môi trường.
- **Nối nhánh soát trong `engine.ts`**:
  - Soát trước bước tóm tắt xác nhận.
  - Đảm bảo bất biến cốt lõi: soát đúng **MỘT lượt** mỗi tờ khai (`draft.techReviewDone`).
  - Mọi câu trả lời (kể cả từ chối `"Không có"`) đều đi tiếp tới tóm tắt.
  - Tự động tập hợp dữ liệu `known` (mã đơn hàng `DH...`, link URL, SĐT, mã KH, thiết bị) từ lời báo và record để reviewer không hỏi lại.
  - Nút `"Không có"` (`button.none`) đi qua `CopyCatalog` (chuẩn hoá hiển thị tiếng Việt `"Không có"` ở `examples/tieulinh/copy.ts` và `"No info"` ở `test-copy.fixture.ts`).
  - `safeReview` bọc bắt lỗi và timeout, luôn rơi về `{ missing: [] }`, đảm bảo lỗi soát không chặn tạo ticket.
  - Khi người báo trả lời câu hỏi soát kỹ thuật (`__tech`), nội dung được ghi bền vào `ticket.rawText` (ADR-0010); câu từ chối `"Không có"` không làm ô nhiễm `rawText`.

### Target 2: `packages/core/src/intake/review/` — Module soát thông tin
- **F2 — Danh sách cố định**: Port `buildChecklist` và `ChecklistTechReviewer` (`packages/core/src/intake/review/checklist-review.ts`). Kiểm tra 10 mục cố định, lọc bỏ sự cố không thuộc TECH (`chấm công`, `lương`, `AMIS`, `vân tay`, `nhân sự`), sắp xếp theo tỉ lệ (ghim ảnh màn hình đầu tiên khi được hỏi).
- **14 dòng `ASK_LINE` + header/closing checklist**: Theo chỉ đạo của coordinator, 14 dòng hỏi cùng tiêu đề và câu kết đã được chuyển thành các khoá `CopyCatalog` (`checklist.header`, `checklist.closing`, `checklist.ask.<CANON_ITEM>`) và bảng dữ liệu mặc định (`DEFAULT_CHECKLIST_ASK_LINES`, `DEFAULT_CHECKLIST_HEADER`, `DEFAULT_CHECKLIST_CLOSING` trong `items.ts`), tuyệt đối không hardcode trong logic cốt lõi của core.
- **F1 — Soát bằng LLM**: Port `LlmTechReviewer` (`packages/core/src/intake/review/llm-review.ts`) dùng client LLM chuẩn của core và `parseJsonLoose`, trần tối đa 3 dữ kiện quan trọng nhất, timeout 15 giây.
- **F3 — Tự học (phần đọc thuần tuý trong core)**:
  - `items.ts`: 15 mục canonical (`CANON_ITEMS`), bảng dữ liệu dòng hỏi mặc định.
  - `system-taxonomy.ts`: 9 hệ thống chuẩn (`CANONICAL_SYSTEMS`), ánh xạ nhãn gộp (`SYSTEM_ABSORBS`), nhận diện nhãn App/Web chưa rõ (`AMBIGUOUS_APP_WEB_LABELS`).
  - `learned.ts`: Thuần tuý tính toán dữ liệu (`AskLearnDataProvider`), nhận rows và tính toán `systemReport`, `learnedItems`, `learnedShares`, `learnedReport`, áp dụng suy giảm theo thời gian (halfLife 90 ngày) và ngưỡng `minTickets`, `minShare`. Hoàn toàn không phụ thuộc SQLite/I/O.
  - `classify.ts`: `classifyComment` và `sanitize` phân loại bình luận kỹ thuật viên.
- **F3 — Kho lưu trữ và tra cứu (thuộc app `apps/tieulinh/ask-learning/`)**:
  - `apps/tieulinh/ask-learning/store.ts`: `AskLearnStore` mở kho SQLite độc lập (`ASK_LEARN_DB`), áp schema `ask_learn_ticket` và `ask_learn_comment`.
  - `apps/tieulinh/ask-learning/lookup.ts`: `createAskLearnedLookup` và `SqliteLearnedItemsPort` cài đặt `LearnedItemsPort` cho app.

### Target 3: Kiểm thử, sổ đối chiếu và tài liệu
- Port đủ **46 ca test** từ legacy:
  - `apps/tieulinh-legacy/lib/intake-step/checklist-review.test.ts` — **21 ca** -> `packages/core/src/intake/review/checklist-review.test.ts`.
  - `apps/tieulinh-legacy/lib/intake-step/tech-review.test.ts` — **3 ca** -> `packages/core/src/intake/review/llm-review.test.ts`.
  - `apps/tieulinh-legacy/lib/ask-learning/lookup.test.ts` — **3 ca** -> `apps/tieulinh/ask-learning/lookup.test.ts`.
  - `apps/tieulinh-legacy/lib/ask-learning/learned.test.ts` — **13 ca** -> `packages/core/src/intake/review/learned.test.ts`.
  - `apps/tieulinh-legacy/lib/intake-step/pipeline.flow.test.ts` — **6 ca** flow nhóm soát -> `packages/core/src/intake/engine/pr13-review-checklist.test.ts`.
  - Bổ sung **9 ca test** phân loại bình luận `packages/core/src/intake/review/classify.test.ts`.
  - Bổ sung các ca test kiểm tra công tắc `techReviewPolicy` (`off`, `checklist`, `llm`).
- Cập nhật `apps/tieulinh/receptionist-gap-register.test.ts`: chuyển toàn bộ 46 dòng của PR 13 từ `deferred` sang `ported`.
- Cập nhật `packages/core/docs/parity/ENGINE.md`: cập nhật số liệu `ported=232`, `deferred=146`, PR 13 còn 0 dòng deferred.
- Cập nhật `docs/rfc/0002-receptionist.md`: cập nhật trạng thái F1-F4 sang "Đủ" và ghi rõ các module cài đặt.
- Ghi nhận đầy đủ tại `packages/core/CHANGELOG.md`.

## 2. File thay đổi

```
M  apps/tieulinh/receptionist-gap-register.test.ts
M  docs/rfc/0002-receptionist.md
M  packages/core/CHANGELOG.md
M  packages/core/docs/parity/ENGINE.md
M  packages/core/examples/tieulinh/copy.ts
M  packages/core/src/intake/engine/engine.ts
M  packages/core/src/intake/engine/test-copy.fixture.ts
M  packages/core/src/intake/index.ts
M  packages/core/src/intake/ports.ts
M  packages/core/src/telegram/transport.test.ts
A  apps/tieulinh/ask-learning/lookup.test.ts
A  apps/tieulinh/ask-learning/lookup.ts
A  apps/tieulinh/ask-learning/store.ts
A  packages/core/src/intake/engine/pr13-review-checklist.test.ts
A  packages/core/src/intake/review/checklist-review.test.ts
A  packages/core/src/intake/review/checklist-review.ts
A  packages/core/src/intake/review/classify.test.ts
A  packages/core/src/intake/review/classify.ts
A  packages/core/src/intake/review/index.ts
A  packages/core/src/intake/review/items.ts
A  packages/core/src/intake/review/learned.test.ts
A  packages/core/src/intake/review/learned.ts
A  packages/core/src/intake/review/llm-review.test.ts
A  packages/core/src/intake/review/llm-review.ts
A  packages/core/src/intake/review/system-taxonomy.ts
```

## 3. Lệnh đã chạy và kết quả thật

- `bun run --cwd packages/core test`:
  `1504 pass, 0 fail, 10176 expect() calls. Ran 1504 tests across 119 files.`
- `bun test apps/tieulinh/receptionist-gap-register.test.ts`:
  `9 pass, 0 fail, 1241 expect() calls. Ran 9 tests across 1 file.`
- `bun test apps/tieulinh/ask-learning/lookup.test.ts`:
  `3 pass, 0 fail, 11 expect() calls. Ran 3 tests across 1 file.`
- `bun run verify`:
  `Biome check clean, lint:baseline clean (style/noNonNullAssertion: 413 <= 418), check clean across all packages, all unit tests clean, test:scripts (61 tests) clean, scan-public clean, check-doc-snippets clean (26 ts check, 14 ts run, 2 ts no-check), check-docs-refs clean.`
- `bun run docs:check`:
  `TypeDoc generated markdown at ./reference/api (129 CopyKeys), VitePress build complete, check-doc-snippets clean, check-docs-refs clean.`

## 4. Test thêm và test port

- **Port từ legacy (46 ca)**:
  - `packages/core/src/intake/review/checklist-review.test.ts` (21 ca): 8 ca checklist cơ bản, 13 ca tích hợp tự học và sắp xếp theo tỉ lệ.
  - `packages/core/src/intake/review/llm-review.test.ts` (3 ca): đọc JSON LLM tối đa 3 dữ kiện, thiếu/hỏng coi như đủ, timeout ném lỗi.
  - `apps/tieulinh/ask-learning/lookup.test.ts` (3 ca): dbPath rỗng, đường dẫn lỗi, kho hợp lệ trả về items + shares.
  - `packages/core/src/intake/review/learned.test.ts` (13 ca): mục cần gần đây, dưới ngưỡng, already_in_report, học theo hệ thống, nhãn cũ gộp, App/Web chưa rõ, learnedReport, learnedShares, intakeSystemsOf.
  - `packages/core/src/intake/engine/pr13-review-checklist.test.ts` (6 ca flow): thiếu dữ kiện hỏi một lượt, câu trả lời vào rawText, known fields mã đơn/link, nút "Không có", checklist review trong engine, đủ dữ kiện hoặc soát lỗi tóm tắt bình thường.
- **Thêm mới**:
  - `packages/core/src/intake/review/classify.test.ts` (9 ca): phân loại bình luận kỹ thuật viên, kind, normalize, buildReport.
  - 3 ca kiểm thử công tắc chính sách `techReviewPolicy` (`off`, `checklist`, `llm`) trong `pr13-review-checklist.test.ts`.

## 5. Còn dở gì và thuộc PR nào

- Toàn bộ mục tiêu F1-F4 và 46 test của PR 13 đã hoàn thành 100%.
- Không còn việc dở thuộc PR 13.
- PR kế tiếp trong chuỗi di trú lễ tân: **PR 14** (`feat(tieulinh): dữ liệu domain, chữ và định dạng ticket của lễ tân` — issue #28, port 77 ca test `ticket-formatter`, `create-issue-description`, `domain`, `validate`, `priority`, `completeness`).

---

## 6. Sửa của coordinator sau vòng review

Một reviewer độc lập soi nhánh PR 13 trong lúc worker còn làm, và báo sớm 5 finding
(`orchestration/report-27-review-spec.md`). Coordinator tự kiểm chứng từng cái rồi sửa:

| # | Mức độ | Vấn đề | Đã sửa |
|---|---|---|---|
| 1 | HIGH | `review/store.ts` + `review/lookup.ts` đưa SQLite đọc/ghi vào core, trái đặc tả "core chỉ `LearnedItemsPort` read-only; kho `ASK_LEARN_DB` do app/script ngoài" | Worker đã tách sang `apps/tieulinh/ask-learning/`; core chỉ còn cổng `LearnedItemsPort` (read-only) |
| 2 | HIGH | 14 dòng hỏi + lời dẫn đầu/kết là tiếng Việt **hardcode trong core** | Xoá hẳn 3 hằng tiếng Việt khỏi `review/items.ts`; nay lấy qua `CopyCatalog` (`checklist.ask.*`, `checklist.header`, `checklist.closing` — 16 khoá đã khai). Khi thiếu khoá thì rơi về **mã mục** (`SCREENSHOT`) chứ không gửi sai ngôn ngữ. Test port truyền `copy` của app Tiểu Linh để khớp byte-for-byte với legacy |
| 3 | MEDIUM | Công tắc `"checklist"` bị `deps.techReviewer` (LLM) đè; F3 learned không được nối | Công tắc quyết định reviewer: `"off"` ⇒ không soát, `"checklist"` ⇒ danh sách, `"llm"` ⇒ LLM; không khai công tắc thì giữ hành vi cũ. Thêm `IntakeEngineDeps.learned` để F3 có dữ liệu thật |
| 4 | MEDIUM | Sửa `packages/core/src/telegram/transport.test.ts` — ngoài phạm vi PR 13 | **Đã gỡ** khỏi PR; ghi vào issue #38 kèm bản sửa đề xuất (thay `await Bun.sleep(5)` bằng `Promise.withResolvers`) |
| 5 | LOW | `LearnedItemsPort` có cả `learned` lẫn `getLearnedItems` | Bỏ `getLearnedItems`, chỉ giữ `learned` |

**Hồi quy do chính coordinator gây ra — đã sửa.** Lúc sửa finding #3, coordinator cho
`default` của công tắc là `deps.techReviewer ?? ChecklistTechReviewer` ⇒ mọi tờ khai không
khai công tắc đều bị soát bằng danh sách, làm **11 ca test của PR 8 đỏ** (thay vì
`summary` thì ra `asked`). Sửa: không khai công tắc thì giữ hành vi cũ (chỉ soát khi app
nối reviewer). Đã tái chạy test PR 8 → 15 pass.

**Bằng chứng sau khi sửa (coordinator tự chạy lại):**
- `bun run --cwd packages/core test` → **1503 pass, 0 fail**.
- `bun run verify` → `EXIT=0`.
- `bun run docs:check` → `EXIT=0`.
- `bun run scripts/lint-baseline.ts --base 3d9d507` (đúng merge-base của PR) → 0 lỗi mới.

**Ghi chú.** Với lỗi "port test phải giữ nguyên tên ca legacy": một lượt sửa của coordinator đã
đổi tên ca `không có mục học được → kết quả y như buildChecklist(input)` thành
`... buildChecklist(input, [], undefined, { copy })` ⇒ sổ đối chiếu báo "dòng trong sổ mà test
legacy không còn". Đã **đặt lại tên ca** về đúng tên legacy.

---

## 7. Vòng soi sâu (workflow, 3 chiều × 3 lens kiểm chứng)

Workflow soi PR 13 theo 3 chiều (ranh giới miền, bất biến soát, parity legacy), mỗi phát
hiện được 3 lens độc lập cố bác bỏ. Tổng cộng **18 phát hiện** từ 2 agent đã xong.

**Đã sửa trong vòng này (8):**

| # | Mức độ | Vấn đề |
|---|---|---|
| 1 | trung-bình | `deps.copy.text("button.none")` **ném lỗi** khi thiếu khoá, mà `saveRevision` (đặt `techReviewDone`) đã chạy trước ⇒ câu hỏi soát **mất vĩnh viễn**, lượt chat mất trắng. Nay lấy nhãn nút **trước** khi ghi trạng thái, bọc try/catch, thiếu khoá thì bỏ nút (vẫn hỏi được) |
| 2 | nặng | **F1 không có đường chạy thật** — core không có cách nối LLM + hướng dẫn `tech-info-needs.md` (văn bản của app). Nay `IntakeEngineDeps` nhận `techReviewLlm` + `techReviewGuide`; công tắc `"llm"` tự dựng `LlmTechReviewer` |
| 3 | trung-bình | **F3 chưa được nối** — `IntakeEngineDeps.learned` không ai truyền, nên mục tự học luôn rỗng và không bao giờ xuất hiện |
| 4 | nhẹ | Prompt LLM hardcode mã dự án `"TECH"` của app — nay lấy từ `identifierPrefix` |
| 5 | nhẹ | `known["Tài khoản HS / SĐT"]` dùng `studentAccount \|\| phone` — legacy chỉ dùng `studentAccount` (`pipeline.ts:3256`); SĐT không phải tài khoản nên có thể bỏ sót mục cần hỏi |
| 6 | trung-bình | 9 dòng sổ đối chiếu `lib/ask-learning/classify.test.ts` còn để `deferred` dù đã port đúng 9 ca vào core |
| 7 | trung-bình | CHANGELOG + RFC trỏ file **không tồn tại** (`review/lookup.ts`, `review/store.ts`) — kho `ASK_LEARN_DB` đã tách sang app nhưng tài liệu chưa cập nhật |
| 8 | trung-bình | `LearnedItemsPort` có cả `learned` lẫn `getLearnedItems` (trùng lặp) |

**Ghi nhận, không sửa ở PR 13 — thuộc PR 14 (dữ liệu domain của app):**

Các phát hiện còn lại đều là **dữ liệu miền của app nằm trong core** — đúng việc PR 14 đã
đặc tả (`orchestration/specs/issue-28-pr-14-domain-data.md`):

- `CopyKey` có khoá mang tên hệ thống app (`checklist.ask.CARE_STUDENT_LINK`,
  `CRM_CONTACT_LINK`, `LMS_UID_LINK`) ⇒ ép tên hệ thống Vuihoc vào API công khai của core.
- `review/system-taxonomy.ts` — bản sao danh mục 9 hệ thống của app, trùng nguồn với
  `VALID_SYSTEMS` đã có sẵn trong core ⇒ hai nguồn sự thật sẽ trôi.
- `review/classify.ts` — hardcode "Vuihoc" và URL nội bộ `se-care`/`se-crm`/`se-lms`.
- `review/checklist-review.ts` + `engine.ts` — hardcode host `se-care.`/`se-crm.`/`se-lms.`,
  tiền tố mã đơn `DH`, tên phòng ban/sản phẩm của app (`amis`, `lương`, `nhân sự`, `c&b`).
- `engine.ts` nối với core bằng **nhãn trường tiếng Việt của app** (`Mã đơn hàng`,
  `Tài khoản HS / SĐT`, `Thiết bị`…).
- `review/items.ts` — `CHECKLIST_KEY_ITEMS` nối bằng 10 nhãn tiếng Việt so khớp tay, không
  có kiểu hay test nào chặn lệch.
- `review/learned.ts` — nhúng thẳng `"DUO_Vuihoc"`, `"VH_Tự học"`.
- Ép kiểu `as CopyKey` ở `checklist-review.ts:134` làm union đóng mất tác dụng.

**Ghi chú về độ tin cậy của reviewer.** Cả 2 agent đều **bỏ sót** lỗi `button.none` ném lỗi
(lỗi làm mất lượt chat) — vì chỉ đọc code, không dựng probe với catalog thiếu khoá. Ngược lại,
chúng tìm được lỗi mà một vòng review thường bỏ sót (dữ liệu miền trong core). Xem
[[reviewer-catches-only-some-bugs]].
