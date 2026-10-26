# Đặc tả: PR 14 của RFC 0002 — dữ liệu domain, chữ và định dạng ticket của lễ tân (issue #28)

## Context

Repo: `minhdevtry/ticket`. Đây là PR 14 của chuỗi di trú lễ tân (`docs/rfc/0002-receptionist.md` mục 5), issue #28.

PR 1-13 đã merge vào `main`. PR 13 (soát thông tin F1-F4) vừa merge.

Mục tiêu của PR 14 là **đưa dữ liệu domain và chữ của app về đúng chỗ** — đây là PR mà
RFC và các quyết định mục 8 đã nêu: app `apps/tieulinh` phải sở hữu catalog, luật ưu tiên,
vựng, chữ (`copy.ts`), mẫu tóm tắt, định dạng mô tả và comment gợi ý. **Core không được giữ
dữ liệu miền của app.**

Đây cũng là PR gỡ các ghi chú "PR 14 sẽ thay" đã để lại ở các PR trước:

- `packages/core/src/intake/extractor/heuristics.ts` — bản PARITY tạm, có tên hệ thống của app.
- `packages/core/src/intake/review/system-taxonomy.ts` — tên hệ thống/URL của app (se-care, se-crm, se-lms).
- `packages/core/src/intake/review/items.ts` — nhãn đối chiếu tiếng Việt.
- `packages/core/src/intake/review/classify.ts` — nhận diện chuyên viên theo tên app.
- `packages/core/examples/tieulinh/` — bản mẫu chứa dữ liệu app.

**Tài liệu đọc trước (bắt buộc):**
- `orchestration/WORKER-CONTRACT.md`, `AGENTS.md`, `CODING_STANDARDS.md`.
- `packages/core/GLOSSARY.md` và `apps/tieulinh/GLOSSARY.md`.
- `docs/rfc/0002-receptionist.md` mục 1.4 (dòng J1, K6), mục 2.1-2.4, mục 3.3 (mâu thuẫn "bot
  không đóng ticket"), mục 5 (hàng PR 14).
- `docs/adr/` — ADR-0006 (chỉ người xử lý đóng ticket), ADR-0010 (mô tả ticket là nguyên văn).

---

## Nguồn legacy (bản tham chiếu đóng băng — CHỈ ĐỌC)

| Nguồn | Vị trí | Vai trò |
|---|---|---|
| `ticket-formatter.ts` (397 dòng) + test (439) | `apps/tieulinh-legacy/mcp/tieulinh/domain/` | Định dạng mô tả ticket, mẫu tóm tắt, comment gợi ý (K6) |
| `taxonomy.ts` (140) | cùng thư mục | Danh mục hệ thống/sản phẩm/phòng ban + tên bot (bản PARITY tạm trong core) |
| `validation-rules.json` (114), `required_fields.json` (67), `urgency-rules.json` (93), `product_mapping.json` (19), `tech_accounts.json` (21) | cùng thư mục | Luật xác thực, trường bắt buộc, luật ưu tiên |
| `types.ts` (72) | cùng thư mục | Kiểu domain |

Core hiện đã có:
- `packages/core/examples/tieulinh/` — bản mẫu catalog, luật ưu tiên, copy tiếng Việt.
- `packages/core/src/intake/gate/` — `createCatalog` + `evaluateGate`.
- `packages/core/src/intake/priority/` — `evaluatePriorityRules`.

---

## Target

1. **App `apps/tieulinh` sở hữu dữ liệu domain:**
   - `apps/tieulinh/domain/` (mới): `taxonomy.ts` (hệ thống, sản phẩm, phòng ban, tên bot),
     `catalog.ts` (catalog của app), `priority-rules.ts` (luật ưu tiên), `validation-rules.json`
     hoặc tương đương (luật xác thực, trường bắt buộc).
   - `apps/tieulinh/copy.ts` — **chữ đầy đủ** của app (hiện mới 100 dòng; phải đủ cho mọi
     `CopyKey` mà core dùng, và bổ sung những chuỗi app riêng).
   - `apps/tieulinh/ticket-formatter.ts` (mới) — định dạng mô tả ticket và comment gợi ý,
     port từ legacy, dùng `escapeItsaplanMarkdown` của core.

2. **`catalogFromValidationRules` vào core (nếu chưa có):**
   - Core có `createCatalog` nhận cấu trúc đã phân giải; legacy có `catalogFromValidationRules`
     đọc từ JSON. Nếu đưa hàm này vào core thì JSON của app vẫn do app sở hữu — core chỉ
     đọc **cấu trúc**, không chứa danh mục.
   - Quyết định: đưa vào core hay giữ ở app? Cần chủ quyết (mục "Cần chủ quyết").

3. **Gỡ dữ liệu miền khỏi core:**
   - `packages/core/src/intake/extractor/heuristics.ts` — bỏ danh mục app, thay bằng **tham số
     cấu hình** truyền vào (giữ nguyên hành vi parity khi được truyền danh sách tương đương).
   - `packages/core/src/intake/review/system-taxonomy.ts` — chuyển sang app.
   - `packages/core/src/intake/review/items.ts` — nhãn đối chiếu: giữ ở core hay chuyển app?
   - `packages/core/src/intake/review/classify.ts` — nhận diện chuyên viên: theo tên app hay theo
     danh sách tham số?
   - `packages/core/examples/tieulinh/` — giữ làm **mẫu tham chiếu** hay bỏ hẳn? Nếu bỏ thì
     phải có app thật dùng thay.

4. **Mâu thuẫn tài liệu (mục 3.3 của RFC):**
   - `docs/explanation/tieulinh-hau-can.md` và `apps/tieulinh/README.md` đang nói "hậu cân không
     tự đóng" — sửa thành "hậu cân không tự đóng; chỉ chuyển cột khi **chính người báo** yêu
     cầu và xác nhận (ADR-0006 bản 10/10); việc đó thuộc lễ tân".
   - Rà `apps/tieulinh/gap-register.test.ts` nếu có hàng ADR-0006.

5. **Kiểm thử và sổ đối chiếu:**
   - Port test legacy (giữ nguyên tên ca):
     - `ticket-formatter.test.ts` — **37 ca**
     - `create-issue-description.test.ts` — **7 ca**
     - `rawtext-regression.test.ts` — **5 ca**
     - `domain.test.ts` — **12 ca**
     - `validate.test.ts` — **7 ca**
     - `priority.test.ts` — **7 ca**
     - `completeness.test.ts` — **7 ca**
   - **Test chống trôi dữ liệu với legacy**: chạy cùng một đầu vào qua cả bản legacy và bản
     mới, so kết quả — cho tới khi xoá legacy.
   - Cập nhật `apps/tieulinh/receptionist-gap-register.test.ts` và bảng parity `ENGINE.md`.
   - `docs/rfc/0002-receptionist.md`: dòng J1, K6 và hàng PR 14.
   - `packages/core/CHANGELOG.md` nếu sửa core.

---

## Ranh giới

- **Chỉ sửa trong `packages/core/`, `apps/tieulinh/` và `docs/`.**
- **`apps/tieulinh-legacy/**` chỉ đọc** — không sửa, không import code legacy vào app mới.
- Không đụng `.github/workflows/**`, `scripts/**`, `biome.lint-baseline.json`, `bun.lock`.
- Không tự tạo/sửa/đóng issue. Không commit, không push (coordinator làm).

## Cần chủ quyết (ghi vào báo cáo, không tự quyết)

- **`catalogFromValidationRules` ở core hay ở app?** Core có `createCatalog` (cấu trúc đã phân
  giải); legacy có hàm đọc JSON. Nếu đưa vào core, core vẫn không chứa danh mục — chỉ đọc
  **cấu trúc**. Nhưng có thể để app tự dựng catalog và giữ core thuần.
- **`packages/core/examples/tieulinh/` giữ hay bỏ?** Nếu bỏ hẳn thì phải bảo đảm app thật dùng
  thay; nếu giữ thì phải ghi rõ nó là **mẫu tham chiếu**, không phải nơi sống của dữ liệu app.
- **`packages/core/src/intake/review/system-taxonomy.ts` và `items.ts`:** danh mục hệ thống và
  nhãn đối chiếu là dữ liệu app — chuyển hẳn sang `apps/tieulinh/` hay để core với tham số?
  PR 13 vừa dựng chúng trong core vì đặc tả yêu cầu "port phần đọc của `ask-learning/` vào
  core" — nhưng chính danh sách hệ thống là dữ liệu app.
- **Bản ghi vàng (golden) của chữ và tóm tắt:** ở đâu, và ai chạy so với legacy?
