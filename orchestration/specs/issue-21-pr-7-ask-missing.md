# Task spec: PR 7 của RFC 0002 — hỏi bổ sung theo luật (issue #21)

## Context

Repo: `minhdevtry/ticket`. Đây là PR 7 của chuỗi lễ tân (`docs/rfc/0002-receptionist.md` mục 5),
issue #21. PR 1-6 đã merge (sổ đối chiểu, bản ghi vàng, kho binding, draft v2 + chuẩn hoá đầu
vào, bộ trích xuất + heuristic tiếng Việt, replay bóng + chỉ số M0-M4).

**Đọc trước khi sửa** (bắt buộc):

- `orchestration/WORKER-CONTRACT.md` — hợp đồng chung cho mọi worker: kiểm base, ranh giới
  sửa, cấm, chất lượng code, test, bằng chứng, báo cáo, cách gửi `worker_done`.
- `AGENTS.md` và `CODING_STANDARDS.md`.
- `packages/core/GLOSSARY.md` — thuật ngữ.
- `docs/rfc/0002-receptionist.md` mục 1.5 (bảng A1-A5, B3, B4 — cột "Cần làm" và "PR"),
  mục 1.4 (tương tác ticket đã có), mục 2.1 (ranh giới máy trạng thái, ba cổng LLM và
  đường lùi tất định), mục 5 (hàng PR 7).

**Quyết định của chủ liên quan**: `/telegram-webhook` và `ChannelSpec` giữ nguyên như hôm nay
(đã ghi ở issue #20). Không mở rộng phạm vi sang kênh.

## Target

- `packages/core/src/intake/engine/` — máy trạng thái hỏi bổ sung: nhánh theo gate, câu hỏi
  kèm nút, hỏi hệ thống một lần, hỏi lý do gấp một lần, bộ phận ngoài danh mục, chốt tiêu
  đề, gộp trường.
- `packages/core/src/intake/draft/` — trường nháp mới nếu cần (trạng thái hỏi mô tả ngắn, trạng
  thái hỏi lý do gấp, bộ phận ngoài danh mục).
- `packages/core/src/intake/gate/` — luật gate và biến thể (variant).
- Test tương ứng; `packages/core/CHANGELOG.md`; `packages/core/docs/parity/ENGINE.md`; sổ đối
  chiểu `apps/tieulinh/receptionist-gap-register.test.ts`; `docs/`.

## Change

Theo các mã ở RFC 0002 mục 1.5 (cột "Cần làm" và "Trạng thái ở core"):

- **A1 — Thiếu trường bắt buộc**: hỏi theo gate, **nút chọn cho trường enum**, một lượt hỏi
  tối đa số trường theo catalog, và đếm số lần đã hỏi.
  - **Tiến độ sau PR 4 (coordinator đã kiểm tra code, đừng tin bảng RFC cũ):** câu hỏi **đã có
    nút** — `engine.ts` `collect` gọi `questionButtons(gate.fieldsToAsk[0])` và `fieldButtons`
    trả nút cho trường enum (`packages/core/src/intake/gate/buttons.ts:43`). Câu chữ lấy từ
    `composeQuestion` (`gate/gate.ts:209`) nên nhãn không lộ tên trường. Phần "nút" của A1 **đã
    xong ở core**; RFC 0002 mục 1.5 dòng A1 ghi "Câu hỏi không kèm nút" là **cũ**, cần cập nhật.
  - Phần **còn thiếu thật**: **nhánh (`variant`) là hằng** (`IntakeEngineDeps.variant: string`),
    legacy suy nhánh theo sản phẩm và từ khoá tài khoản (`apps/tieulinh-legacy/lib/intake-step/pipeline.ts:3208`
    `variantOf`). Ngoài ra `askedCount` có trong schema (`gate/schema.ts:116`) nhưng **chưa được
    dùng để chặn hỏi lại** — chưa có luật "hỏi tối đa N lần theo catalog".
  - → Làm nhánh `variant` thành **hàm suy ra** (không phải hằng), và thêm luật đếm số lần hỏi
    theo catalog (dùng `askedCount` / `questionCount` sẵn có, đừng thêm hằng trùng lặp).
- **A2 — Chưa có mô tả sự cố**: chào, hoặc "đã nhận ảnh, mô tả giúp em" khi chỉ có ảnh →
  thêm trạng thái hỏi `short_description`.
- **A3 — Hỏi hệ thống đúng MỘT lần kèm nút**, không rõ thì tóm tắt ghi "Chưa xác định" →
  luật "hỏi một lần" **ngoài gate** (tức cả khi hệ thống không nằm trong gate).
- **A4 — Xin gấp mà chưa nói lý do**: hỏi lý do **một lần**; có lý do thì cho đúng mức xin
  (không hạ mức bằng chứng); trả lời "không có" thì giữ mức bằng chứng; lý do ghi vào ticket →
  câu hỏi lý do, trạng thái `priority_reason`, cắt 300 ký tự. (Quyết định 29/09: "xin gấp có
  lý do thì cho hết".)
- **A5 — Bộ phận ngoài danh mục**: nói rõ "không có trong danh mục" thay vì hỏi lại y câu cũ
  → trường nháp mới + câu hỏi. (PR 5 đã có phần **nhận ra** bộ phận ngoài danh mục ở bộ trích
  xuất; PR 7 là phần **hỏi**.)
- **B3 — Chốt tiêu đề**: tiêu đề **không bao giờ** là tên người hay mã trần; thay bằng tiêu đề
  dự phòng từ lời báo (bỏ chào hỏi, tên, mã) hoặc "Sự cố kỹ thuật" → hàm thuần ngôn ngữ
  tiếng Việt, đưa vào core. (PR 5 đã port `isInvalidTitle` và `deriveFallbackTitle` vào core;
  PR 7 **dùng** chúng trong đường tạo ticket.)
- **B4 — Gộp trường**: triệu chứng không trùng, bỏ ý người bảo gỡ, **bằng chứng chỉ nới**
  (cờ đã true thì giữ, phạm vi chỉ rộng ra), tin xác nhận/huỷ/cảm ơn chỉ gộp trường cấu
  trúc → `structuredOnly`, `removeSymptoms`, bằng chứng chỉ nới.

## Tiêu chí chấp nhận

1. **Golden của các kịch bản liên quan khớp chữ và nút** (bản ghi vàng PR 2 ở
   `packages/core/golden/intake/`): mọi lượt hỏi bổ sung phải có **nút** đúng như bản ghi vàng,
   và câu chữ khớp sau khi chuẩn hoá tham số. Câu chữ lấy từ `CopyCatalog`.
2. Port được các ca của legacy theo hàng PR 7:
   - flow: ưu tiên tiếng Việt; nhãn không lộ tên trường; mặc định Medium; bằng chứng urgent;
     **5 kịch bản "xin gấp"**; **hệ thống một lần** (2 ca).
   - `multi-incident.test.ts` phần tiêu đề (`isInvalidTitle`, `deriveFallbackTitle`).
3. Không hỏi lại trường đã hỏi quá số lần theo catalog; số lần hỏi được đếm và giữ bền.
4. `bun run verify` EXIT=0, `bun run docs:check` EXIT=0.
5. `packages/core/CHANGELOG.md` có mục cho PR 7; sổ đối chiểu và `ENGINE.md` khớp.
6. **Cập nhật bảng khoảng trống ở `docs/rfc/0002-receptionist.md` mục 1.5** cho các dòng A1-A5,
   B3, B4: cột "Khoảng trống" và cột "Trạng thái ở core" phải phản ánh đúng sau PR 7. Cột
   "Khoảng trống" của A1 hiện ghi "Câu hỏi không kèm nút (chỉ tóm tắt có nút)" — **đã cũ** (PR 4
   đã thêm `questionButtons` cho trường enum); cập nhật cho khớp thực tế.
7. **`packages/core/docs/parity/ENGINE.md`** khớp với sổ đối chiểu (số dòng `ported` và
   `deferred` phải đúng sau khi port).

## Ràng buộc

- Bám `orchestration/WORKER-CONTRACT.md`.
- `apps/tieulinh-legacy/**` chỉ đọc.
- Không dùng `any`, không dùng khoá non-null trong code mới; không nới `biome.lint-baseline.json`.
- Mọi câu chữ gửi người dùng lấy từ `CopyCatalog`; nhãn **không lộ tên trường kỹ thuật**.
- Logic tất định ở engine; không nhét quyết định vào prompt. Mọi cổng LLM giữ đường lùi tất định.
- Bất biến: không ghi vào ticket đã có khi chưa có bấm nút khớp nhãn (ADR-0008), không tự xác
  nhận, mô tả ticket nguyên văn (ADR-0010), không đè định danh, một lượt một khoá chat.
- Không đụng `/telegram-webhook` và `ChannelSpec`.

## Ownership

Được sửa: `packages/core/src/intake/**`, `packages/core/CHANGELOG.md`,
`packages/core/docs/**`, `apps/tieulinh/receptionist-gap-register.test.ts`, `docs/**`
(trong đó gồm `docs/rfc/0002-receptionist.md` mục 1.5 — chỉ sửa bảng khoảng trống và cột
trạng thái, **không** sửa phần thiết kế), `orchestration/report-21.md`,
`orchestration/specs/issue-21-pr-7-ask-missing.md`.

Không được sửa: `apps/tieulinh-legacy/**`, `.github/workflows/**`, `scripts/**`,
`biome.lint-baseline.json`, `package.json` gốc, `bun.lock`.

## Báo cáo

Ghi `orchestration/report-21.md`: đã làm gì, file nào đổi, lệnh đã chạy và kết quả thật, test
nào thêm/port, còn dở gì (và phần đó thuộc PR nào).

Khi xong gửi **đúng một lần**:

```bash
orca orchestration send --to dispatch:<DISPATCH_ID> --type worker_done \
  --subject "PR 7 / issue #21 xong" \
  --body "<3 câu: đã làm gì, kết quả lệnh, còn dở gì>" \
  --outcome succeeded --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> \
  --files-modified "<danh sách file>" --report-path orchestration/report-21.md --json
```
