# Đặc tả: PR 8 của RFC 0002 — gác tờ khai khi có sự cố mới (issue #22)

## Context

Repo: `minhdevtry/ticket`. Đây là PR 8 của chuỗi lễ tân (`docs/rfc/0002-receptionist.md` mục 5),
issue #22. PR 1-7 đã merge (sổ đối chiểu, bản ghi vàng, kho binding, draft v2 + chuẩn hoá đầu
vào, bộ trích xuất + heuristic tiếng Việt, replay bóng + chỉ số M0-M4, hỏi bổ sung theo luật).

**Đọc trước khi sửa** (bắt buộc):

- `orchestration/WORKER-CONTRACT.md` — hợp đồng chung cho mọi worker: kiểm base, ranh giới
  sửa, cấm, chất lượng code, test, bằng chứng, báo cáo, cách gửi `worker_done`.
- `AGENTS.md` và `CODING_STANDARDS.md`.
- `packages/core/GLOSSARY.md` — thuật ngữ.
- `docs/rfc/0002-receptionist.md` mục 1.5 (dòng **B5**, **B6**, **A12**), mục 2.1 (ranh giới máy
  trạng thái, ba cổng LLM và đường lùi tất định), mục 5 (hàng PR 8).
- `docs/adr/0008-ticket-existing-write.md` (bất biến khi ghi vào ticket đã có).

**Quyết định của chủ liên quan**: `/telegram-webhook` và `ChannelSpec` giữ nguyên như hôm nay
(đã ghi ở issue #20). Không mở rộng phạm vi sang kênh.

## Target

- `packages/core/src/intake/engine/` — luật gác tờ khai: nhận diện định danh **có nhãn cùng
  lớp**, hỏi lại khi người báo không rõ, "thôi huỷ" bỏ tin vừa gác, nút "Tiếp tục sự cố đang
  chờ", nhắc khi tạo hay huỷ, lệnh `/new`.
- `packages/core/src/intake/identifiers/` hoặc `engine/identifiers.ts` — bảng "có nhãn, cùng lớp".
- `packages/core/src/intake/draft/` — trạng thái gác nếu cần.
- Test tương ứng; `packages/core/CHANGELOG.md`; `packages/core/docs/parity/ENGINE.md`; sổ đối
  chiểu `apps/tieulinh/receptionist-gap-register.test.ts`; `docs/`.

## Change

Theo các mã ở RFC 0002 mục 1.5:

- **B5 — Định danh xung đột với tờ khai đang mở**: chỉ tính định danh **có nhãn** (Code, Mã KH,
  Mã HS, UID/SID/CID, mã CRM 7-10 số trọn dòng) và **chỉ khi cùng lớp**; tên người, SĐT, tài
  khoản, URL, mã phiếu **không bao giờ** là định danh; hỏi "Sự cố mới" hay "Bổ sung sự cố đang
  chờ".
  - Core đã có `engine.ts` `detectPark` và `intake/engine/identifiers.ts` (so khớp chữ số của
    trường có sẵn). Cần làm phần **"có nhãn, cùng lớp"** của vòng 2: chỉ những định danh có
    **nhãn** mới được tính là xung đột, và hai định danh chỉ xung đột khi **cùng lớp**.
  - Trả lời **không rõ** thì hỏi lại (không đoán). Tin "thôi huỷ" bỏ tin vừa gác.
- **B6 — Tờ khai đang hỏi dở mà tin mới là lời báo trọn vẹn thì cũng hỏi**: không áp dụng khi
  đang trả lời câu hỏi dữ kiện hay mô tả.
  - Core đã có `engine.ts` `detectPark` với nhánh full-report. Cần bổ sung **ngoại lệ** "đang
    trả lời câu hỏi": nếu tin mới là câu trả lời cho một câu hỏi trường dữ kiện đang chờ thì
    **không** gác.
- **A12 — `/new`**: ép sự cố mới, gác tờ khai đang dở; nút "Tiếp tục sự cố đang chờ" đưa tờ
  khai gác trở lại.
  - Core đã có `engine.ts` `forceNew` và `parkedDocId`; còn thiếu **nút nhắc và resume**.

## Tiêu chí chấp nhận

1. **Golden khớp** cho các kịch bản liên quan (bản ghi vàng PR 2 ở `packages/core/golden/intake/`).
2. **Ba test "không mất dữ liệu bên nào"** xanh.
3. Port được các ca của legacy theo hàng PR 8:
   - flow: nhóm **TECH-928** (8 ca), tờ khai bị gác (3 ca), "tờ khai dở + lời báo trọn vẹn",
     "customerId không bị reground".
   - `identifier-grounding.test.ts` (11 ca).
4. Không mất dữ liệu: khi gác rồi bỏ, hay chuyển sang sự cố mới, hay nối tiếp — **không**
   mất chữ người báo. Đây là tiêu chí cứng, kiểm bằng test.
5. `bun run verify` EXIT=0, `bun run docs:check` EXIT=0.
6. `packages/core/CHANGELOG.md` có mục cho PR 8; sổ đối chiểu và `ENGINE.md` khớp.
7. Cập nhật bảng khoảng trống ở `docs/rfc/0002-receptionist.md` mục 1.5 cho dòng B5, B6, A12
   (chỉ sửa bảng, không sửa phần thiết kế).

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
trạng thái), `orchestration/report-22.md`.

Không được sửa: `apps/tieulinh-legacy/**`, `.github/workflows/**`, `scripts/**`,
`biome.lint-baseline.json`, `package.json` gốc, `bun.lock`, `apps/tieulinh/**` (trừ file sổ
đối chiểu nêu trên).

## Báo cáo

Ghi `orchestration/report-22.md`: đã làm gì, file nào đổi, lệnh đã chạy và kết quả thật, test
nào thêm/port, còn dở gì (và phần đó thuộc PR nào).

Khi xong gửi **đúng một lần**:

```bash
orca orchestration send --to dispatch:<DISPATCH_ID> --type worker_done \
  --subject "PR 8 / issue #22 xong" \
  --body "<3 câu: đã làm gì, kết quả lệnh, còn dở gì>" \
  --outcome succeeded --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> \
  --files-modified "<danh sách file>" --report-path orchestration/report-22.md --json
```
