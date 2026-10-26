# Task spec: PR 6 của RFC 0002 — replay lễ tân từng lượt và chỉ số sẵn sàng (issue #20)

## Context

Repo: `minhdevtry/ticket`. Đây là PR 6 của chuỗi lễ tân (`docs/rfc/0002-receptionist.md` mục 5).
PR 1-5 đã merge: sổ đối chiếu (PR 1), bản ghi vàng (PR 2), kho binding (PR 3), draft v2 +
chuẩn hoá đầu vào (PR 4), bộ trích xuất + heuristic tiếng Việt (PR 5).

**Đọc trước khi sửa** (bắt buộc):

- `orchestration/WORKER-CONTRACT.md` — hợp đồng chung cho mọi worker: kiểm base, ranh giới
  sửa, cấm, chất lượng code, test, bằng chứng, báo cáo, cách gửi `worker_done`.
- `AGENTS.md` và `CODING_STANDARDS.md`.
- `packages/core/GLOSSARY.md` — thuật ngữ.
- `docs/rfc/0002-receptionist.md` mục 4 (tương thích bóng), mục 4.3 (ba tầng), mục 4.4
  (phân lớp lệch S0/S1/S2), mục 4.5 (chỉ số M0-M4), mục 5 (hàng PR 6).
- `docs/adr/0005-tl2-shadow.md` — bóng chạy thế nào; ADR này KHÔNG được vi phạm.

**Quyết định của chủ cho PR này** (đã ghi ở issue #20):

1. **Không đụng `apps/tieulinh-legacy`.** Bóng suy `action` của TL1 từ CHỮ trả lời, và độ
   chính xác của bộ phân loại phải đo bằng **bản ghi vàng** (PR 2), không phải bằng cách mở
   legacy để đọc `action` thật.
2. **`/telegram-webhook` và `ChannelSpec` giữ nguyên như hôm nay.**

## Target

- `tools/tl2-shadow/` — worker, relay, cặp bóng, so sánh, chỉ số.
- `packages/core/src/intake/engine/` — phần replay: engine phải chạy được từng lượt với trạng
  thái bị ép (xem "Change" mục 1).
- `packages/core/src/testing/` — bộ ghi nhớ đệm trích xuất để chạy lại offline cho ra kết quả
  giống hệt.
- Test tương ứng; `packages/core/CHANGELOG.md`; `docs/` nếu đổi hành vi công khai.

## Change

### 1. Tầng 1 — đánh giá từng lượt (cổng chính)

Với mỗi lượt `t` của một chat:

1. Dựng trạng thái TL2 tại lượt `t-1` bằng cách chạy lại các tin người dùng trước đó qua
   **cùng** bộ trích xuất và bộ gộp của TL2, nhưng **ép nhánh điều khiển** theo cái TL1 đã
   làm: nếu TL1 hỏi trường A thì đặt `lastAskedFields = [A]`; nếu TL1 hiện tóm tắt thì đặt
   `ready_for_confirmation` và `summaryShownAt`; nếu TL1 hỏi tách/gộp, hay "sự cố mới hay bổ
   sung", thì đặt đúng trạng thái chờ đó; nếu TL1 tạo ticket thì đóng tờ khai.
2. Chạy `step(tin_t)` thật của TL2 trên kho **cô lập** (cổng tracker là bộ ghi nhận trong bộ
   nhớ, không ghi ra ngoài) và so **đầu ra lượt `t`** với TL1.
3. Lệch ở lượt `t` không lan sang lượt `t+1`.

Phần "ép nhánh điều khiển" cần một **oracle** tuỳ chọn cho engine: nhận hành động điều khiển
bắt buộc của lượt quá khứ và trả về nó. RFC 4.3 ghi "Tên và chữ ký chưa chốt" — bạn chọn, nhưng
ràng buộc:

- **Mặc định tắt**; không có oracle thì engine chạy y hệt hiện tại (không đổi hành vi
  production, không đổi API công khai của engine ngoài oracle).
- Không được để oracle làm thay đổi logic engine: nó chỉ GHI ĐÈ trạng thái điều khiển, các
  luật nghiệp vụ vẫn do engine quyết định.
- Có test riêng cho oracle: bật thì ép đúng nhánh, tắt thì không ảnh hưởng gì.

### 2. Bộ phân loại câu trả lời TL1 (reply -> action) và bộ đọc tóm tắt TL1

- Bộ phân loại: neo chữ cố định của TL1 ("Em tóm tắt lại sự cố", "Em đã tạo thành công ticket",
  "em tách N ticket nhé", "SỰ CỐ MỚI hay bổ sung", "xác nhận giúp em", "đang ở trạng thái",
  "đang tạo ticket"...) -> `action` của hợp đồng cũ. Dùng bảng ánh xạ của PR 5
  (`@vuihoc/bot-core/intake`) làm nguồn chuẩn, đừng viết lại bảng.
- Bộ đọc tóm tắt: mẫu tóm tắt của TL1 cố định (`pipeline.ts` mục `collect`), đọc ngược được
  tiêu đề, sản phẩm, hệ thống, bộ phận, mã, mức ưu tiên, số tệp.
- **Độ chính xác của bộ phân loại phải đúng 100% trên mọi chuỗi vàng** của PR 2
  (`packages/core/golden/intake/*.json`, 6 kịch bản). Đây là tiêu chí chấp nhận, không phải
  "khoảng 100%": một ca sai là không đạt.

### 3. Tầng 2 — chạy tự do (thông tin, không chặn)

TL2 chạy cả cuộc trò chuyện của riêng nó từ tin đầu. Ghi: điểm lệch đầu tiên, hội tụ về
cùng nội dung ticket cuối không, số câu hỏi và độ dài đường đi so với TL1. Dùng để đánh giá
trải nghiệm, không dùng làm cổng.

### 4. Tầng 3 — nới lỏng xác nhận ("shadow-relaxed confirm")

Khi bản ghi TL1 cho thấy người dùng đã xác nhận và TL1 đã tạo ticket:

- Đồng hồ giả nhảy tới sau `minConfirmDelayMs`, và tóm tắt được coi như đã hiện (không bắt
  TL2 phải tự hiện đúng lúc đó).
- Nếu cổng gate của TL2 **đủ** thì chạy tạo ticket trên bộ ghi nhận (hoặc dự án TECH2 qua
  proxy) và lấy **payload dự kiến**, so với tóm tắt TL1.
- Nếu cổng gate của TL2 **chưa đủ** thì **không ép**: ghi `tl2_stricter` kèm danh sách trường
  còn thiếu. Đây là phát hiện (TL2 hỏi thêm so với TL1), không phải xác nhận thất bại.
- **Không bao giờ nới ba chốt an toàn**: không tự xác nhận khi chưa có tin xác nhận của người
  báo, không ghi vào ticket đã có khi không có bấm nút khớp, không đè định danh.

### 5. Cặp `v: 2` và chỉ số

- Cặp bóng nâng lên `v: 2`, giữ `v: 1` đọc được (không phá file cặp cũ).
- Bảng mẫu (RFC 4.4):

  ```json
  { "v": 2, "eid": "…", "chatId": "…", "text": "…",
    "tl1": { "reply": "…", "action": "ask_missing_field", "summary": { "system": "…", "priority": "…" } },
    "tl2": { "target": "receptionist", "outcome": "asked", "reply": "…",
             "buttons": ["…"], "fields": { "system": "…" }, "latencyMs": 0, "error": null },
    "diff": { "class": "S1", "code": "asked_other_field", "tl1Field": "reporting_dept", "tl2Field": "system" } }
  ```

- `compare.ts --metrics`: tính **M0-M4** (RFC 4.5) và phân lớp lệch S0/S1/S2:

  | Chỉ số | Định nghĩa | Mức tham khảo |
  |---|---|---|
  | M0, an toàn | Số lệch lớp S0 | **bằng 0** trong cả cửa sổ |
  | M1, khớp hành động | Tỉ lệ lượt TL2 cho cùng lớp `action` với TL1 | từ 95% tổng, không lớp nào dưới 90% |
  | M2, nội dung ticket | Ở lúc xác nhận: khớp chính xác hệ thống, sản phẩm, bộ phận, mức ưu tiên, định danh, số tệp; `rawText` chứa đủ | trường tất định từ 97%; `rawText` đủ 100% |
  | M3, độ thẩm vấn | Jaccard tập trường được hỏi; tỉ lệ TL2 hỏi điều TL1 không hỏi | từ 90% và không quá 5% |
  | M4, quyết định rẽ | Khớp park/tách/gộp | từ 95% |

  S0 = không an toàn (ghi vào ticket đã có khi TL1 chỉ hỏi; tạo ticket khi người dùng chưa xác
  nhận; mất chữ người báo khỏi `rawText`; lộ phong bì kênh hoặc token `noop` vào ticket; đè
  định danh; huỷ/đóng ticket không phải của người báo). S1 = hành vi (hỏi trường khác, quyết
  định khác, giá trị khác). S2 = bề mặt (câu chữ, thứ tự câu hỏi).

  **M0 bằng 0 là điều kiện chặn**: một lần S0 là lý do để chủ cân nhắc dừng. Công cụ phải
  **trả về mã thoát khác 0** khi M0 > 0, để CI chặn được.

### 6. Bộ nhớ đệm trích xuất để chạy lại offline

Cùng một đầu vào phải cho cùng kết quả, chạy lại bao nhiêu lần cũng vậy — kể cả khi
 không có mạng và không có LLM. Vậy nên phần trích xuất có LLM phải được ghi đệm (kho đệm
cục bộ, 0700), và lần chạy sau đọc từ kho đệm.

**Không đụng secret**: bóng không được ghi token, khoá hay nội dung nhạy cảm vào cặp hay log.
`ADR-0005` giữ nguyên.

## Tiêu chí chấp nhận

1. **Bộ phân loại đúng 100% chuỗi vàng** của PR 2 (6 kịch bản trong
   `packages/core/golden/intake/`). Một ca sai là không đạt.
2. **Replay trên cặp tổng hợp ra đúng M0-M4** theo định nghĩa ở mục 5, và M0 bằng 0.
3. **Chạy lại hai lần cho cùng kết quả** (nhờ bộ nhớ đệm), kể cả khi không có mạng.
4. `bun run verify` EXIT=0, `bun run docs:check` EXIT=0.
5. `packages/core/CHANGELOG.md` có mục cho PR 6 (có oracle của engine và API của bóng).
6. Không đụng secret; ADR-0005 giữ nguyên.
7. Test mới: kịch bản tổng hợp lấy từ hai sự cố **TECH-928** (nhiều sự cố trong một tin;
   báo lỗi SĐT bị giữ trong mô tả) và **TECH-1013** (tin sau khi tạo ticket).

## Ràng buộc

- Bám `orchestration/WORKER-CONTRACT.md`.
- `apps/tieulinh-legacy/**` chỉ đọc.
- Không dùng `any`, không dùng khoá non-null trong code mới; không nới
  `biome.lint-baseline.json`.
- Mọi câu chữ gửi người dùng lấy từ `CopyCatalog`, không hardcode trong logic.
- Không để oracle hay chế độ replay thay đổi hành vi engine khi đã tắt.
- Mọi file cặp bóng, kho đệm và log: thư mục 0700, file 0600 (xem `JsonlFile` ở
  `tools/tl2-shadow/queue.ts`).

## Ownership

Được sửa: `tools/tl2-shadow/**`, `packages/core/src/intake/**`, `packages/core/src/testing/**`,
`packages/core/CHANGELOG.md`, `packages/core/docs/**`, `docs/**`,
`orchestration/report-20.md`.

Không được sửa: `apps/tieulinh-legacy/**`, `.github/workflows/**`, `scripts/**`,
`biome.lint-baseline.json`, `package.json` gốc, `bun.lock`.

## Báo cáo

Ghi `orchestration/report-20.md`: đã làm gì, file nào đổi, lệnh đã chạy và kết quả thật (kèm
số M0-M4 đo được), test nào thêm, còn dở gì.

Khi xong gửi **đúng một lần**:

```bash
orca orchestration send --to dispatch:<DISPATCH_ID> --type worker_done \
  --subject "PR 6 / issue #20 xong" \
  --body "<3 câu: đã làm gì, số M0-M4 và kết quả lệnh, còn dở gì>" \
  --outcome succeeded --task-id <TASK_ID> --dispatch-id <DISPATCH_ID> \
  --files-modified "<danh sách file>" --report-path orchestration/report-20.md --json
```
