# Báo cáo PR 4 / issue #18 — draft v2 và chuẩn hoá đầu vào

Repo: `minhdevtry/ticket`. Công việc: PR 4 của `docs/rfc/0002-receptionist.md` (mục 5),
theo đặc tả `orchestration/specs/issue-18-pr-4-draft-v2.md`.

Worktree: `feat-pr-4-draft-v2`. Nền: `git merge origin/feat/core-legacy-bindings` (f79c0e9) theo
chỉ dẫn của coordinator — có sẵn PR 1 (sổ đối chiếu) và PR 2 (bản ghi vàng). Không có conflict.

## 1. Đã làm gì

### 1.1 Draft v2 (RFC 0002 mục 2.1)

- `IntakeDraft` có **phiên bản**: `version` (hiện hành `DRAFT_VERSION = 2`), `newDraft` ghi kèm.
- Thêm các trường hội thoại mà bản cũ thiếu: `lastAskedFields`, `requestedPriority`,
  `techReviewDone`, `techQuestion`, `unrecognizedDept`, `pendingSplit` (kèm `extraText`,
  `clarifyCount`), `pendingSplitQueue`, `mediaAmbiguous`, `pendingNewIncident`, `backgroundWork`
  (dấu việc nền). Kiểu mới: `SplitBlock`, `PendingSplit`, `PendingNewIncident`.
- `migrateDraft` (file mới `packages/core/src/intake/draft/version.ts`): **migrate lúc đọc** —
  `SqliteDraftRepository.safeParse` gọi nó nên tờ khai cũ (không có `version`) đọc lên là bản 2,
  không phải viết lại kho. Tờ khai có phiên bản mới hơn thì giữ nguyên (không hạ cấp). Hàm
  idempotent.

### 1.2 Chuẩn hoá đầu vào (tiền xử lý tất định, không LLM)

File mới `packages/core/src/intake/engine/normalize.ts`:

- `isMeaninglessInput(text, mediaPaths)`: tin rỗng hoặc chỉ là token nội bộ của nút (`noop`) mà
  không kèm ảnh → bỏ qua hoàn toàn. Engine trả lời **theo trạng thái tờ khai** (A11, TECH-1148):
  đã tạo → `already_created`; đang tạo → `in_progress`; chờ xác nhận → `too_soon` kèm nút xác
  nhận; đang gom → `asked`; đã huỷ → `canceled`; chưa có mô tả → `clarify`. Không tạo tờ khai mới.
- `isDeclineAnswer(text)`: "không biết", "em không rõ ạ", "chưa có" (A13). Khi từ chối: trường vừa
  hỏi vào `explicitlyMissing` (bot thôi hỏi), câu trả lời **không** vào mô tả, tiêu đề **không**
  đổi.
- Câu trả lời cho câu hỏi dữ kiện kỹ thuật (`TECH_INFO_FIELD`) **luôn** vào mô tả, kể cả khi chỉ
  là một mã (`appendRawText` của legacy).
- Trần `rawText` theo legacy: `MAX_RAW_TEXT_CHARS = 4000` (một tin) và
  `MAX_RAW_TEXT_TOTAL_CHARS = 8000` (cả cuộc), thay `MAX_DESCRIPTION_CHARS = 6000`.
- Đường ghi ticket từ chối tạo khi tiêu đề/mô tả rỗng hoặc chỉ là token nội bộ (`create-ticket.ts`).

### 1.3 `ExtractInput.context` và nút cho câu hỏi

- `ExtractContext` mới trong `packages/core/src/intake/ports.ts`: `draftTitle`, `draftDescription`
  (cắt 1.500 ký tự), `techQuestion`, `lastAskedFields`, `createdTicket` (mô tả cắt 4.000 ký tự).
  Engine điền vào mọi lượt gọi bộ trích xuất.
- `StepOutput.messages` đã mang `{ text, buttons }`; câu hỏi cho trường enum giờ đi kèm nút chọn
  lấy từ catalog (`fieldButtons`), và xác nhận tới quá sớm thì gửi lại nút xác nhận (A7).

### 1.4 Kết quả mới và bảng ánh xạ `action` (mục 2.3)

- `StepOutcome` thêm `clarify`, `split_question`, `closed_refusal`, `canceled`.
- File mới `packages/core/src/intake/engine/action-map.ts`: `LEGACY_INTAKE_ACTIONS`,
  `ACTION_OUTCOMES`, `outcomesForLegacyAction`, `legacyActionForOutcome`,
  `LEGACY_ACTION_BY_OUTCOME` — bảng 14 dòng của RFC mục 2.3.
- `@vuihoc/bot-core/testing` dùng bảng chính thức thay cho bảng tạm `LEGACY_ACTION_OF_OUTCOME`
  (đã bỏ); `legacyActionOfOutcome` là bọc mảnh để kết quả chỉ có ở core (`chitchat`,
  `needs_resend`) giữ nguyên tên.
- Engine huỷ tờ khai giờ trả `canceled` kèm câu chữ (trước: `chitchat` không kèm tin).

### 1.5 Sổ đối chiếu (sổ của PR 1)

`apps/tieulinh/receptionist-gap-register.test.ts` (coordinator mở rộng Ownership cho đúng file này):

- 6 dòng `noop-guard.test.ts`: `deferred` → `ported`, trỏ `intake/engine/noop-guard.test.ts`.
- 6 dòng `intake-document/repository.test.ts`: → `ported`, trỏ `intake/draft/version.test.ts`.
- 6 flow của `pipeline.flow.test.ts` ("ok" chưa tóm tắt, "không biết", "không vào được lớp", xác
  nhận hai lần, phong bì, tin dài): → `ported`, trỏ `intake/engine/legacy-flows.test.ts`.
- Ba dòng `deferred` còn ghi "Chờ port ở PR 4" nhưng không thuộc hàng port của PR 4 → chuyển sang
  PR thật sự làm (PR 7, PR 14, PR 15).
- Thêm dòng theo file cho `scripts/golden/record.test.ts` (file mới của PR 2 chưa có trong sổ —
  sổ đỏ từ lúc merge nền).
- `packages/core/docs/parity/ENGINE.md`: cập nhật dòng số liệu `gap-register` và bảng "số test
  deferred theo PR" (PR 4 còn 0).

## 2. File nào đổi

Thêm:

- `packages/core/src/intake/draft/version.ts`, `packages/core/src/intake/draft/version.test.ts`
- `packages/core/src/intake/engine/normalize.ts`, `normalize.test.ts`
- `packages/core/src/intake/engine/action-map.ts`, `action-map.test.ts`
- `packages/core/src/intake/engine/legacy-flows.test.ts`
- `packages/core/src/intake/engine/noop-guard.test.ts`
- `packages/core/src/intake/engine/context.test.ts`
- `packages/core/src/intake/engine/engine-harness.fixture.ts` (bộ khung test dùng chung cho các
  file test của engine; `engine.test.ts` cũ dùng lại, 23 ca vẫn nguyên tên và vẫn xanh)
- `packages/core/src/intake/engine/enum-catalog.fixture.ts`
- `docs/reference/intake-engine.md`

Sửa:

- `packages/core/src/intake/draft/types.ts` (trường v2), `draft/repository.ts` (migrate lúc đọc),
  `draft/index.ts` (export)
- `packages/core/src/intake/engine/engine.ts` (chuẩn hoá, ngữ cảnh, nút, kết quả mới, trần)
- `packages/core/src/intake/engine/types.ts` (outcome mới), `engine/test-copy.fixture.ts`
- `packages/core/src/intake/engine/golden-intake.allowlist.ts` (dòng đã khớp thì xoá, lý do cập nhật)
- `packages/core/src/intake/engine/engine.test.ts` (dùng bộ khung dùng chung; thay câu trả lời
  "none" bằng "không có" vì "none" là token nội bộ của nút, xem A11)
- `packages/core/src/intake/ports.ts` (`ExtractContext`, `ExtractInput.context`, 3 `CopyKey` mới)
- `packages/core/src/intake/create/create-ticket.ts` (hàng rào tiêu đề/mô tả rỗng hoặc "noop")
- `packages/core/src/testing/golden.ts` (dùng bảng ánh xạ chính thức)
- `packages/core/examples/tieulinh/copy.ts` (chữ cho 3 `CopyKey` mới)
- `packages/core/CHANGELOG.md`, `packages/core/docs/parity/ENGINE.md`
- `docs/reference/testing.md`, `docs/reference/intake-engine.md` (mới), `docs/.vitepress/config.ts`
  (thêm trang vào sidebar)
- `apps/tieulinh/receptionist-gap-register.test.ts` (sổ đối chiếu)

Không sửa: `apps/tieulinh-legacy/**`, `.github/**`, `scripts/scan-public.ts`, `package.json` gốc,
`bun.lock`.

## 3. Lệnh đã chạy và kết quả thật

| Lệnh | Kết quả |
|---|---|
| `bun run --cwd packages/core test` | **1186 pass / 0 fail** (92 file) |
| `bun test packages/core/src/intake/engine/engine.test.ts` | **23 pass / 0 fail** — 23 ca cũ của engine vẫn xanh, không xoá, không nới lỏng |
| `bun test packages/core/src/intake/draft/version.test.ts` | 11 pass (6 ca port từ `intake-document/repository.test.ts` + 5 ca draft v2) |
| `bun test packages/core/src/intake/engine/noop-guard.test.ts` | 6 pass (port từ `noop-guard.test.ts`) |
| `bun test packages/core/src/intake/engine/action-map.test.ts` | 17 pass (14 dòng bảng ánh xạ + 3 ca tính toàn vẹn) |
| `bun test packages/core/src/intake/engine/context.test.ts` | 7 pass (`ExtractInput.context` + nút cho câu hỏi) |
| `bun test packages/core/src/intake/engine/normalize.test.ts` | 10 pass (tin vô nghĩa, từ chối, appendRawText, trần `rawText`) |
| `bun test packages/core/src/intake/engine/legacy-flows.test.ts` | 6 pass (6 flow legacy của hàng PR 4) |
| `bun test packages/core/src/intake/engine/golden-intake.test.ts` | 9 pass — bản ghi vàng của PR 2 vẫn xanh; dòng allowlist đã khớp thì xoá |
| `bun test apps/tieulinh/receptionist-gap-register.test.ts` | 8 pass — sổ đối chiếu khớp, số liệu ENGINE.md khớp |
| `bun run verify` | **EXIT=0** (lint + check + test mọi workspace + test:scripts + scan + docs:snippets + docs:refs) |
| `bun run docs:check` | **EXIT=0** (build site + TypeDoc + mẫu code + đối chiếu; 43 trang docs) |

Tổng test mới của PR 4: **57** (11 + 6 + 17 + 7 + 10 + 6).

## 4. Test nào thêm (theo tiêu chí chấp nhận)

| Yêu cầu | Test |
|---|---|
| Migrate draft cũ | `draft/version.test.ts`: "đọc tờ khai cũ không có `version` thì nâng lên bản 2 (khác legacy: legacy đọc bảng `intake_sessions`)", "migrate giữ nguyên trường v2 đã có", "migrate là idempotent và không hạ cấp bản mới hơn", "migrate trả null cho dữ liệu không phải tờ khai", "tờ khai mới ghi phiên bản hiện hành" |
| Bảng ánh xạ `action` | `engine/action-map.test.ts`: **mỗi dòng bảng RFC mục 2.3 một test case** (14 ca) + 3 ca tính toàn vẹn (mọi action có hàng, chiều ngược, kết quả chỉ có ở core) |
| Chuẩn hoá đầu vào | `engine/normalize.test.ts`: tin vô nghĩa (3), từ chối (2), `appendRawText` (1), trần `rawText` (1), tin vô nghĩa khi chờ xác nhận (1), huỷ (2) |
| `ExtractInput.context` | `engine/context.test.ts`: 4 ca (tiêu đề/mô tả, trường vừa hỏi, câu hỏi kỹ thuật, ticket vừa tạo, cắt 1.500 ký tự) |
| Nút cho câu hỏi trong `StepOutput` | `engine/context.test.ts`: "câu hỏi cho trường enum đi kèm nút lựa chọn", "trường tự do thì câu hỏi không kèm nút" |
| Port `noop-guard.test.ts` (6) | `engine/noop-guard.test.ts` — 6 ca, giữ số thứ tự và ý của legacy |
| Port `intake-document/repository.test.ts` (6) | `draft/version.test.ts` — 6 ca đầu, giữ tên test của legacy |
| Port 6 flow của hàng PR 4 | `engine/legacy-flows.test.ts` — 6 ca, **giữ nguyên tên test của legacy** để sổ đối chiếu trỏ tới được |

> Sửa sau review (mục 7): hai ca của `repository.test.ts` và một ca của `noop-guard.test.ts`
> **không phải port** (hành vi khác legacy) nên sổ đối chiếu đã đổi sang `deferred`; xem mục 7.

## 5. Điều đáng chú ý

- **23 ca test cũ của engine vẫn xanh**, nhưng một ca phải sửa câu trả lời: "tech review asks once,
  any answer proceeds to summary" dùng tin `"none"` làm câu trả lời. `"none"` là **token nội bộ**
  của nút (`INTERNAL_CALLBACK_TOKENS`), nên theo A11 (giống hệt legacy) nó bị bỏ qua. Ca đó đổi
  sang `"không có"` — câu trả lời thật của người báo; ý của ca test ("bất kỳ câu trả lời nào cũng
  đi tiếp") không đổi.
- Bản ghi vàng của PR 2 đã bắt được đúng hai chỗ PR 4 phải làm: `action` của lượt huỷ giờ khớp
  (`canceled`) nên dòng allowlist tương ứng bị **xoá** (allowlist chỉ được co lại), và lượt xác
  nhận quá sớm giờ gửi lại nút xác nhận (A7) nên lý do của dòng allowlist đó đổi theo.
- `apps/tieulinh/receptionist-gap-register.test.ts` **đỏ ngay sau khi merge nền**: PR 2 thêm
  `apps/tieulinh-legacy/scripts/golden/record.test.ts` mà sổ của PR 1 chưa biết. Đã thêm dòng
  theo file cho nó (file mới, không phải hành vi lễ tân).
- `MAX_DESCRIPTION_CHARS` (6.000) bị thay bằng `MAX_RAW_TEXT_CHARS` (4.000) và
  `MAX_RAW_TEXT_TOTAL_CHARS` (8.000) — đúng trần của legacy. Đây là **thay đổi hành vi công khai**,
  đã ghi ở `packages/core/CHANGELOG.md` và `docs/reference/intake-engine.md`.

## 6. Còn dở / việc sau

- Không còn việc nào trong phạm vi PR 4. Các PR sau của RFC 0002 vẫn mở: PR 5 (bộ trích xuất),
  PR 7 (hỏi bổ sung theo luật — nút theo trường thật, chốt tiêu đề), PR 8 (gác tờ khai), PR 9 (tách
  báo cáo), PR 10 (tin sau khi tạo ticket), PR 14 (chữ và dữ liệu domain).
- `split_question` và `closed_refusal` đã có trong `StepOutcome` và trong bảng ánh xạ, nhưng
  engine chưa phát ra: tách báo cáo là PR 9, từ chối ticket đã đóng là PR 10.
- Chưa commit, chưa push, chưa mở PR (theo giới hạn của đặc tả).

## 7. Sửa sau review

Báo cáo review: `/tmp/review-18/spec-report.md`, `/tmp/review-18/standards-report.md`. Đã sửa đủ
7 mục, không cắt bớt.

### 7.1 Bảy mục đã sửa

| # | Mục | Sửa gì, ở đâu |
|---|---|---|
| 1 | Sổ đối chiếu ghi `ported` cho hành vi chưa port | `apps/tieulinh/receptionist-gap-register.test.ts`: dòng "migrate bản nháp từ `intake_sessions` thành công" và "bỏ qua bản nháp legacy quá hạn khi migrate" đổi `ported` → **`deferred`**, `why` nói rõ khác biệt (legacy đọc bảng `intake_sessions` + chuẩn hoá nhãn 15→9; legacy trả `null` cho bản nháp quá hạn, core đọc được rồi mới đo tuổi) và nêu PR sẽ port (PR 3). Hai ca test ở core đổi tên + tách sang `describe` riêng ("hành vi của core — KHÁC legacy"), docblock `version.test.ts` sửa lại (4 ca port, không phải 6) |
| 2 | Test cũ của engine đã bị sửa dữ liệu vào | `engine.test.ts`: thêm comment giải thích (`"none"` là token nội bộ bị A11 bỏ, y hệt legacy → dùng `"không có"`), **tên ca test giữ nguyên**. `packages/core/CHANGELOG.md` (mục PR 4): ghi rõ 23 ca cũ giữ nguyên tên, trong đó một ca đổi dữ liệu đầu vào |
| 3 | Test cũ mang tên hằng đã xoá | `engine.test.ts`: "description cap: a huge paste is truncated to MAX_DESCRIPTION_CHARS" → **"rawText cap: a huge paste is truncated to MAX_RAW_TEXT_CHARS (4.000, trần của legacy)"**, assert đổi từ `<= 6001` sang `toBe(MAX_RAW_TEXT_CHARS)` (4.000; trần cả cuộc 8.000 đã có ở `normalize.test.ts`). Dòng sổ đối chiếu trỏ tới tên mới |
| 4 | Docblock cũ trong allowlist | `golden-intake.allowlist.ts`: "Hiện `action` khớp ở mọi lượt trừ một chỗ (huỷ)" → "`action` hiện khớp 100% các lượt" (PR 4 đã bỏ lệch `cancel-then-new` lượt 5) |
| 5 | Test port chưa mang mã sự cố gốc | `legacy-flows.test.ts` và `noop-guard.test.ts`: mỗi ca mở đầu bằng mã sự cố lấy từ test legacy tương ứng — TECH-924 (phong bì kênh), legacy "Bug 1" (xác nhận lần hai), "Bug 3" ("ok" chưa tóm tắt, "không vào được lớp"), "Bug 7" ("không biết"), "Bug 10" (tin rất dài), TECH-1148 (cả 6 ca `noop-guard`) |
| 6 | Ca port thứ 6 của `noop-guard` không port hành vi legacy | Dòng sổ của legacy "6. create_issue tool: …" đổi `ported` → **`deferred`**, `why` nêu tool MCP `create_issue` thuộc PR 15 (pack MCP) và PR 16 (adapter OpenClaw), và nói hàng rào tương đương đã có ở đường tạo ticket của core. Ca 6 của core đổi tên cho đúng ("tờ khai trống (tiêu đề và mô tả rỗng) cũng không tạo ticket") và có comment nói rõ **không phải port**; ca 5 của core đổi tên cho đúng ("…chỉ là token nội bộ (noop)"), dòng sổ của legacy ca 5 trỏ tới cả hai ca. `describe` của file ghi "5 ca port + 1 ca của core" |
| 7 | Ghi rõ phần hoãn | `packages/core/CHANGELOG.md` (mục PR 4): trường draft v2 `unrecognizedDept`, `requestedPriority`, `pendingSplit`, `pendingSplitQueue`, `mediaAmbiguous`, `pendingNewIncident`, `backgroundWork` mới chỉ **khai báo** (đường ghi thuộc PR 7 và PR 9; `pendingNewIncident` theo PR 8, `backgroundWork` theo PR 13); `StepOutcome.next` của RFC 2.3 thuộc PR 9; outcome `chitchat` không còn engine nào trả nên đã thành vô dùng. `docs/reference/intake-engine.md` ghi cùng điều (trường chỉ khai báo, `chitchat` không còn đường trả) |

Số liệu sổ đổi (`packages/core/docs/parity/ENGINE.md`): `ported` 18 → **15**, `deferred` 360 → **363**
(marker `total=450 core=61 ported=15 deferred=363 by-design=11`). Bảng "số test `deferred` theo PR":
PR 3: 7 → **9** (2 dòng `repository` của tài liệu), PR 15: 7 → **8** (1 dòng `noop-guard`), PR 4 vẫn 0
(mô tả cột PR 4 cập nhật: 5 dòng `noop-guard` + 4 dòng `repository` + 6 flow).

### 7.2 Lệnh đã chạy và kết quả thật

| Lệnh | Kết quả |
|---|---|
| `bun run --cwd packages/core test` | **1186 pass / 0 fail** (92 file, 8.679 expect, 51,01s) |
| `bun test apps/tieulinh/receptionist-gap-register.test.ts` | **8 pass / 0 fail** (1.229 expect) — sổ khớp, số liệu `ENGINE.md` khớp |
| `bun test packages/core/src/intake/draft/version.test.ts packages/core/src/intake/engine/engine.test.ts packages/core/src/intake/engine/noop-guard.test.ts packages/core/src/intake/engine/legacy-flows.test.ts` | **46 pass / 0 fail** (144 expect) |
| `bun run verify` | lần 1 **EXIT=1**, lần 2 **EXIT=0** (lint + check + test mọi workspace + test:scripts + scan + docs:snippets + docs:refs). Lần 1 đỏ ở `apps/tieulinh-legacy/mcp/shared/tools/validate-fields.parity.test.ts` — ca "SQLite persistence: đọc reporting_dept đã lưu…" **timeout 5.000 ms** (7.928 ms); file này **không nằm trong diff** và `apps/tieulinh-legacy/**` không được sửa, chạy riêng file đó **14 pass / 0 fail** (2,34s) → flake thời gian nền, không phải do PR này. Lần 2: legacy 938 pass / 27 skip / 0 fail, core 1.186 pass, `scan` sạch, docs:snippets 24 `ts check` / 14 `ts run` / 2 `ts no-check`, docs:refs 43 trang khớp |
| `bun run docs:check` | **EXIT=0** (gen-docs: 31 khoá copy, 16 ADR; TypeDoc sinh `reference/api`; VitePress build xong; snippets 24/14/2; refs 43 trang khớp) |

### 7.3 Còn dở

- Ba dòng sổ đối chiếu đã để `deferred` (2 dòng `repository` của tài liệu → PR 3; 1 dòng
  `create_issue` → PR 15/16). Đây là hành vi legacy **chưa port**, không phải việc dở của PR 4.
- Chưa commit, chưa push, chưa mở PR (theo giới hạn của đặc tả).
