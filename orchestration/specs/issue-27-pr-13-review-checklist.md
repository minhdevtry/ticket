# Đặc tả: PR 13 của RFC 0002 — soát thông tin (danh sách, LLM, tự học) (issue #27)

## Context

Repo: `minhdevtry/ticket`. Đây là PR 13 của chuỗi di trú lễ tân (`docs/rfc/0002-receptionist.md` mục 5), issue #27.

PR 1-12 đã merge vào `main` (PR 12 = huỷ/đóng ticket theo yêu cầu người báo, D8 — PR #60).

Mục tiêu của PR 13 là port **F1-F4** — cơ chế **soát thông tin** trước khi tạo ticket:

- **F1 — Soát bằng LLM** ("con mắt kỹ thuật viên"): tối đa 3 dữ kiện, hỏi **MỘT lượt**, trả lời gì (kể cả "không có") cũng đi tiếp, lỗi hoặc quá 15 giây coi như đủ. Dùng hướng dẫn `tech-info-needs.md` (209 dòng).
- **F2 — Soát bằng danh sách cố định**: 10 mục, hỏi hết trong một tin, bỏ qua sự cố không thuộc TECH (như chấm công, lương).
- **F3 — Tự học (W25)**: mục người báo hay phải bổ sung theo hệ thống; học từ bình luận kỹ thuật viên; sắp theo tỉ lệ; kho riêng (`ASK_LEARN_DB`); script nạp dữ liệu từ ngoài.
- **F4 — Công tắc soát**: `TECH_INFO_REVIEW` (`off` / `checklist` / `llm`).

**Bất biến cốt lõi:**
- **Soát chỉ một lượt** — hỏi xong thì đi tiếp, không hỏi lại.
- **Lỗi không chặn tạo ticket** — soát lỗi/hết giờ = coi như đủ dữ kiện.
- **Không tự học từ người dùng** — kho `learned` do **script ngoài** sinh (F3 yêu cầu cổng `learned(system)`).

**Tài liệu đọc trước (bắt buộc):**
- `orchestration/WORKER-CONTRACT.md`, `AGENTS.md`, `CODING_STANDARDS.md`.
- `packages/core/GLOSSARY.md`.
- `docs/rfc/0002-receptionist.md` mục 1.4 (dòng F1-F4), mục 2.1-2.4, mục 5 (hàng PR 13).
- `packages/core/src/intake/ports.ts` — `TechReviewerPort` **đã có sẵn** từ PR 4.

---

## Nguồn legacy (bản tham chiếu đóng băng — CHỈ ĐỌC)

| Hàm / module | Vị trí | Vai trò |
|---|---|---|
| `buildChecklist`, `ChecklistTechReviewer`, `CHECKLIST_CLOSING` | `apps/tieulinh-legacy/lib/intake-step/checklist-review.ts` (263 dòng) | F2 — soát bằng danh sách cố định |
| `LlmTechReviewer`, `TechReviewer` | `apps/tieulinh-legacy/lib/intake-step/tech-review.ts` (98 dòng) | F1 — soát bằng LLM |
| `lib/ask-learning/` (`items`, `classify`, `source`, `candidate`, `ingest`, `lookup`, `learned`, `store`) | `apps/tieulinh-legacy/lib/ask-learning/` (~1500 dòng, 8 file + 8 file test) | F3 — tự học |
| Công tắc `TECH_INFO_REVIEW` | `apps/tieulinh-legacy/mcp/tieulinh/index.ts` | F4 — chính sách |

---

## Target

1. **`packages/core/src/intake/` — cổng soát:**
   - `TechReviewerPort` **đã có** (`ports.ts:419`) — dùng lại, không tạo bản mới.
   - Thêm cổng `LearnedItemsPort` (F3): trả danh sách mục đã học + tỉ lệ, **đọc-only**; dữ liệu do script ngoài ghi.
   - Thêm cổng cấu hình chính sách soát (F4): `off` | `checklist` | `llm` — khai báo ở `IntakeEngineDeps`, **không** đọc biến môi trường trong core.
   - `engine.ts`: nối nhánh soát vào luồng trước khi chốt tiêu đề / xác nhận — **một lần mỗi tờ khai** (dùng `draft.techReviewDone` đã có sẵn ở `ports.ts:391`).
   - `engine.ts`: câu hỏi soát phải có nút **"Không có"** để người báo bỏ qua; mọi câu trả lời (kể cả "không có") thì đi tiếp.
   - `engine.ts`: `safeReview` đã bọc lỗi (`engine.ts:3167`) — dùng lại, không viết lại.

2. **`packages/core/src/intake/review/` (module mới, hoặc chỗ đã có sẵn — grep trước):**
   - Port `buildChecklist` + `ChecklistTechReviewer` (F2) — hàm thuần, dữ liệu danh sách mục đi kèm.
   - Port `LlmTechReviewer` (F1) — dùng `packages/core/src/llm/` đã có (`client.ts`, `extract.ts`, `agent.ts`), không viết lại client LLM.
   - Port phần **đọc** của `lib/ask-learning/` (F3): `items`, `lookup`, `learned`, `classify` — **không** port phần ghi/ingest/script nạp (data do script ngoài sinh).

3. **Kiểm thử và sổ đối chiếu:**
   - Port test legacy (giữ nguyên tên ca):
     - `apps/tieulinh-legacy/lib/intake-step/checklist-review.test.ts` — **21 ca**
     - `apps/tieulinh-legacy/lib/intake-step/tech-review.test.ts` — **3 ca**
     - `apps/tieulinh-legacy/lib/ask-learning/lookup.test.ts`, `learned.test.ts` — các ca thuần
     - flow nhóm soát — **6 ca** (tìm bằng `grep -rln "checklist\|techReview\|tech-info" apps/tieulinh-legacy --include=*.test.ts`)
   - Cập nhật `apps/tieulinh/receptionist-gap-register.test.ts`: chỉ chuyển dòng F1-F4 sang `ported` khi port thật.
   - Cập nhật `docs/rfc/0002-receptionist.md`: dòng F1-F4 sang trạng thái đúng + cột "PR".
   - `packages/core/CHANGELOG.md`: ghi thay đổi.

---

## Ranh giới

- **Chỉ sửa trong `packages/core/`, `apps/tieulinh/` (sổ đối chiếu) và `docs/`.**
- **`apps/tieulinh-legacy/**` chỉ đọc** — không sửa, không import code legacy vào app mới.
- Không đụng `.github/workflows/**`, `scripts/**`, `biome.lint-baseline.json`, `bun.lock`.
- Không tự tạo/sửa/đóng issue. Không commit, không push (coordinator làm).

## Cần chủ quyết (ghi vào báo cáo, không tự quyết)

- **Hướng dẫn `tech-info-needs.md` (209 dòng) đưa vào core thế nào?** Đây là *hướng dẫn cho LLM*, tức là
  **diễn đạt** — theo nguyên tắc repo ("logic tất định ở tool và engine; prompt chỉ lo diễn đạt") thì nó
  **không** nên nằm trong core. Có hai cách: (a) truyền vào qua `TechReviewerPort` từ app; (b) đặt ở
  `packages/core/examples/tieulinh/` như dữ liệu mẫu. Cần chủ chọn.
- **`TECH_INFO_REVIEW` đọc từ đâu?** Legacy đọc cấu hình ở `mcp/tieulinh/index.ts`. Core không đọc biến
  môi trường — nên khai báo qua `IntakeEngineDeps`, và app lo việc đọc env. Cần chủ xác nhận.
- **Kho `ASK_LEARN_DB`:** legacy dùng SQLite riêng. Core có cần cổng đọc cho kho này, hay để app sở hữu
  hoàn toàn và core chỉ nhận danh sách mục đã học qua cổng?
