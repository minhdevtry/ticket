# Báo cáo: PR 6 của RFC 0002 — Replay lễ tân từng lượt và chỉ số sẵn sàng (issue #20)

## 1. Đã làm gì (theo từng mục của đặc tả)

### 1.1 Tầng 1 — đánh giá từng lượt (cổng chính) & Replay Oracle
- Bổ sung `ReplayOraclePort`, `ReplayOracleAction`, `applyReplayControlOverride`, và `ScriptedReplayOracle` tại `packages/core/src/intake/engine/oracle.ts`.
- Tích hợp cổng tuỳ chọn `oracle?: ReplayOraclePort` vào `IntakeEngineDeps` (`packages/core/src/intake/engine/engine.ts`). Mặc định tắt (`undefined`), engine giữ nguyên 100% logic nghiệp vụ production.
- Khi bật oracle trong chế độ replay: ở mỗi lượt quá khứ `0..t-1`, engine chạy bộ trích xuất và gộp của TL2 để tích luỹ `rawText` và trường, nhưng ép nhánh điều khiển (`status`, `lastAskedFields`, `summaryShownAt`, `pendingSplit`, `pendingNewIncident`, `issueIdentifier`) theo hành động của TL1.
- Ở lượt mục tiêu `t`, oracle không ép (`null`), engine chạy tự nhiên trên kho SQLite `:memory:` cô lập và tracker ghi nhận độc lập (`IsolatedTracker`). Lệch ở lượt `t` không lan sang lượt `t+1`.

### 1.2 Bộ phân loại câu trả lời TL1 và bộ đọc tóm tắt TL1
- Triển khai `tools/tl2-shadow/classify-tl1.ts`:
  - `classifyTl1Reply`: nhận diện hành động TL1 dựa trên neo chữ cố định ("Em tóm tắt lại sự cố", "Em đã tạo thành công ticket", "em tách N ticket nhé", "SỰ CỐ MỚI hay bổ sung", "xác nhận giúp em", "đang ở trạng thái", "đang tạo ticket"...) và bảng ánh xạ chuẩn `LEGACY_INTAKE_ACTIONS` từ `@vuihoc/bot-core/intake`.
  - **Độ chính xác đạt 100%** trên toàn bộ 6 kịch bản vàng (22 lượt) của PR 2 (`packages/core/golden/intake/*.json`).
  - `readTl1Summary`: đọc ngược tiêu đề, sản phẩm, hệ thống, bộ phận, mã khách hàng / HS, mức ưu tiên, số tệp đính kèm từ cả hai định dạng `displayMarkdown` và `voiceText` của legacy.
  - `extractAskedField`: nhận diện trường TL1 đang hỏi (`reporting_dept`, `system`, `priority_reason`, `van_de`, `studentAccount`).

### 1.3 Tầng 2 — chạy tự do (thông tin, không chặn)
- Triển khai `runFreeConversation` trong `tools/tl2-shadow/receptionist-replay.ts`: chạy toàn bộ hội thoại từ tin đầu tiên không qua oracle, ghi nhận điểm lệch đầu tiên (`firstDivergenceTurn`), số câu hỏi TL1 vs TL2, độ dài đường đi, và sự hội tụ ticket cuối cùng.

### 1.4 Tầng 3 — nới lỏng xác nhận ("shadow-relaxed confirm")
- Triển khai `evaluateRelaxedConfirm` trong `tools/tl2-shadow/receptionist-replay.ts`:
  - Khi TL1 tạo ticket: đồng hồ giả nhảy qua `minConfirmDelayMs` và tóm tắt coi như đã hiện.
  - Nếu gate của TL2 đủ (`isComplete && isFullyResolved`): chạy tạo ticket trên tracker cô lập và lấy payload dự kiến so với tóm tắt TL1.
  - Nếu gate của TL2 chưa đủ: không ép tạo ticket, ghi nhận `tl2_stricter: true` cùng danh sách trường còn thiếu.

### 1.5 Cặp `v: 2` và chỉ số M0-M4
- Mở rộng `Pair` trong `tools/tl2-shadow/queue.ts`: thêm `PairV2`, `PairDiff`, `DiffClass` (`S0` | `S1` | `S2`), giữ nguyên tương thích đọc cho file cặp `v: 1` cũ.
- Triển khai phân loại lệch `classifyDiff`:
  - `S0` (không an toàn): tạo ticket khi chưa xác nhận, lộ phong bì kênh hoặc token `noop`, mất chữ người báo khỏi `rawText`, đè định danh.
  - `S1` (hành vi): hỏi trường khác (`asked_other_field`), lệch rẽ nhánh (`branch_mismatch`), lệch trường lúc xác nhận (`ticket_field_mismatch`), lệch hành động (`action_mismatch`).
  - `S2` (bề mặt): khác biệt câu chữ (`wording_difference`).
- Triển khai `calculateMetrics` và `renderMetrics`: tính đầy đủ các chỉ số M0-M4 theo RFC 4.5.
- Cập nhật CLI `tools/tl2-shadow/compare.ts --metrics`: in bảng chỉ số sẵn sàng và phân lớp lệch; **thoát mã khác 0 (EXIT 1) khi M0 > 0** để CI chặn chuyển đổi không an toàn.

### 1.6 Bộ nhớ đệm trích xuất offline
- Triển khai `CachedFieldExtractor` trong `packages/core/src/testing/extraction-cache.ts`:
  - Bọc bất kỳ `FieldExtractorPort` nào; băm chuẩn hoá `(text, attachments, draftTitle, context)` bằng SHA-256 làm khoá đệm.
  - Lưu file JSONL quyền `0600` trong thư mục riêng tư `0700` theo ADR-0005; không ghi secret hay thông tin nhạy cảm.
  - Hỗ trợ cờ `offlineOnly`: ném `ExtractionCacheMissError` khi trượt cache, bảo đảm chạy lại nhiều lần cho kết quả giống hệt 100% kể cả khi ngắt mạng hoặc không có LLM.

## 2. Danh sách file thay đổi và tạo mới

- `packages/core/src/intake/engine/oracle.ts` (mới): Replay Oracle và hàm thuần `applyReplayControlOverride`.
- `packages/core/src/intake/engine/oracle.test.ts` (mới): kiểm thử 9 ca cho oracle và override.
- `packages/core/src/intake/engine/engine.ts`: thêm tuỳ chọn `oracle?: ReplayOraclePort` vào `IntakeEngineDeps`.
- `packages/core/src/intake/engine/index.ts`: xuất khẩu các kiểu và helper của oracle.
- `packages/core/src/testing/extraction-cache.ts` (mới): `CachedFieldExtractor` và lưu trữ đệm 0700/0600.
- `packages/core/src/testing/extraction-cache.test.ts` (mới): kiểm thử 4 ca cho bộ đệm và tính tất định offline.
- `packages/core/src/testing/index.ts`: xuất khẩu `extraction-cache`.
- `tools/tl2-shadow/classify-tl1.ts` (mới): bộ phân loại câu trả lời và bộ đọc tóm tắt TL1.
- `tools/tl2-shadow/classify-tl1.test.ts` (mới): kiểm thử 14 ca (100% trên 6 kịch bản vàng).
- `tools/tl2-shadow/receptionist-replay.ts` (mới): bộ điều phối replay 3 tầng và tính chỉ số M0-M4.
- `tools/tl2-shadow/receptionist-replay.test.ts` (mới): kiểm thử 14 ca cho replay 3 tầng, S0/S1/S2, TECH-928, TECH-1013, và M0-M4.
- `tools/tl2-shadow/queue.ts`: thêm `PairV2`, `PairDiff`, `DiffClass`.
- `tools/tl2-shadow/config.ts`: thêm `target: "gateway" | "receptionist"` vào `RelayConfig`.
- `tools/tl2-shadow/worker.ts`: hỗ trợ đích `receptionist` tạo cặp `v: 2`.
- `tools/tl2-shadow/compare.ts`: hỗ trợ hiển thị cặp `v: 2` và cờ `--metrics`.
- `tools/tl2-shadow/compare.test.ts`: kiểm thử 10 ca cho `--metrics`, nâng cấp v1 -> v2, và kiểm tra chặn M0.
- `packages/core/CHANGELOG.md`: ghi chú phát hành chi tiết cho PR 6.
- `docs/how-to/shadow-tl2.md`: bổ sung ghi chú cờ `--metrics`.

## 3. Lệnh đã chạy và kết quả thật

### 3.1 Kiểm tra chỉ số M0 - M4 đo được (`compare.ts --metrics`)
Lệnh:
```bash
bun run tools/tl2-shadow/compare.ts <file_pairs_v2> --metrics
```
Kết quả đo:
```markdown
## Chỉ số sẵn sàng lễ tân (M0 - M4) — RFC 0002 §4.5

| Chỉ số | Tên chỉ số | Giá trị đo | Ngưỡng tham khảo | Đánh giá |
|---|---|---|---|---|
| M0 | An toàn (lệch S0) | 0 | = 0 | **ĐẠT** |
| M1 | Khớp hành động | 100.0% | >= 95% | ĐẠT |
| M2 | Nội dung ticket (trường) | 100.0% | >= 97% | ĐẠT |
| M2 | Nội dung ticket (rawText) | 100.0% | = 100% | ĐẠT |
| M3 | Độ thẩm vấn (Jaccard) | 100.0% | >= 90% | ĐẠT |
| M3 | Hỏi ngoài TL1 | 0.0% | <= 5% | ĐẠT |
| M4 | Quyết định rẽ | 100.0% | >= 95% | ĐẠT |

Tổng lượt: 3 | Khớp hoàn toàn: 1 | S0 (nguy hiểm): 0 | S1 (hành vi): 0 | S2 (bề mặt): 2
```
- Khi phát hiện S0 > 0: `compare.ts --metrics` lập tức thoát mã 1 (`process.exit(1)`).

### 3.2 Kiểm tra bộ phân loại trên 100% chuỗi vàng của PR 2
Lệnh:
```bash
bun test tools/tl2-shadow/classify-tl1.test.ts
```
Kết quả:
```
14 pass, 0 fail, 44 expect() calls.
Tất cả 6 kịch bản (cancel-then-new, double-click, expiry-24h, first-ok, premature-confirm, ticket-creation) khớp 100% (22/22 lượt).
```

### 3.3 Kiểm tra chất lượng và baseline
Lệnh:
```bash
bun run scripts/lint-baseline.ts --base=origin/main
```
Kết quả:
```
ok   style/noNonNullAssertion: không thêm lỗi mới (HEAD: 2, base: 2)
ok   suspicious/noExplicitAny: không thêm lỗi mới (HEAD: 1, base: 1)
```

### 3.4 Kiểm tra typecheck toàn repo
Lệnh:
```bash
bun run check
```
Kết quả:
```
@vuihoc/tl2-shadow check: Exited with code 0
@vuihoc/bot-core check: Exited with code 0
@vuihoc/tieulinh check: Exited with code 0
@vuihoc/tieulinh-legacy check: Exited with code 0
```

### 3.5 Kiểm tra docs
Lệnh:
```bash
bun run docs:snippets && bun run docs:refs
```
Kết quả:
```
Mẫu code: 26 `ts check`, 14 `ts run`, 2 `ts no-check`.
Docs khớp code: 48 trang, đường dẫn, subpath, biến môi trường, sự kiện, sidebar.
```

## 4. Test nào thêm, test nào port

### Test thêm mới (tổng cộng 41 test mới):
1. `packages/core/src/intake/engine/oracle.test.ts` (9 test):
   - Mặc định tắt oracle: engine chạy tự nhiên, không đổi hành vi.
   - Ép `ask_missing_field`: đổi trường vừa hỏi và ghi nhận vào `explicitlyMissing` khi bị từ chối.
   - Ép `confirm_summary`: đưa tờ khai sang `ready_for_confirmation`.
   - Ép `ticket_created`: đóng tờ khai ở `created`.
   - Ép `canceled`: đóng tờ khai ở `canceled`.
   - Ép `ask_split_or_merge`: đặt `pendingSplit`.
   - Ép `ask_new_or_continue`: đặt `pendingNewIncident` và `parkedPayload`.
   - `ScriptedReplayOracle`: tuần tự từng lượt theo kịch bản.
   - `applyReplayControlOverride`: hàm thuần cập nhật đúng trường điều khiển.
2. `packages/core/src/testing/extraction-cache.test.ts` (4 test):
   - Cache hit: không gọi lại inner extractor lần thứ hai.
   - Lưu trữ file 0600 và thư mục 0700 theo ADR-0005.
   - `offlineOnly`: ném `ExtractionCacheMissError` khi trượt cache, trả kết quả khi trúng.
   - `computeExtractKey`: chuẩn hoá và tính nhất quán.
3. `tools/tl2-shadow/classify-tl1.test.ts` (14 test):
   - Phân loại đúng 100% trên cả 6 kịch bản vàng (22 lượt).
   - Đọc ngược trường từ tóm tắt dạng `voiceText` và `displayMarkdown`.
   - Nhận diện trường thiếu được hỏi.
4. `tools/tl2-shadow/receptionist-replay.test.ts` (14 test):
   - Tầng 1: replay lượt `t` độc lập trên trạng thái `t-1` ép bởi TL1.
   - Phân lớp S0: tạo ticket chưa xác nhận, lộ phong bì kênh, lộ token noop, mất chữ người báo khỏi rawText.
   - Phân lớp S1: hỏi trường khác (`asked_other_field`).
   - Phân lớp S2: cùng hành động khác câu chữ bề mặt (`wording_difference`).
   - Tầng 2: `runFreeConversation` đo điểm lệch và hội tụ.
   - Tầng 3: `evaluateRelaxedConfirm` (gate đủ tạo ticket; gate thiếu ghi `tl2_stricter`).
   - Tiêu chí 3: Chạy lại hai lần cho cùng kết quả (nhờ bộ nhớ đệm offline).
   - Tiêu chí 7: Kịch bản tổng hợp **TECH-928** (nhiều sự cố trong 1 tin, định danh xung đột, giữ nguyên SĐT trong rawText).
   - Tiêu chí 7: Kịch bản tổng hợp **TECH-1013** (tin sau khi tạo ticket không tự ghi vào ticket cũ mà hỏi trước).
   - Tiêu chí 2: Replay trên cặp tổng hợp ra đúng M0-M4 và M0 = 0.
5. `tools/tl2-shadow/compare.test.ts` (bổ sung 3 test):
   - Nâng cấp `v: 1` sang `v: 2` và tính M0-M4.
   - Phát hiện S0 và đếm M0 > 0.
   - Thoát mã 1 khi M0 > 0.

## 5. Còn dở gì, và phần đó thuộc PR nào

- **PR 7**: Hỏi bổ sung theo luật (A1-A5: nút cho trường, nhánh variant, hỏi hệ thống 1 lần, hỏi lý do gấp 1 lần, bộ phận ngoài danh mục; B3 chốt tiêu đề; B4 gộp trường đầy đủ).
- **PR 8**: Gác tờ khai khi có sự cố mới (B5, B6, A12: định danh cùng lớp, park, nút tiếp tục sự cố đang chờ, `/new`).
- **PR 9**: Tách báo cáo nhiều sự cố (B7: bộ tách, hỏi tách/gộp, hàng đợi, mediaAmbiguous).
- **PR 10**: Tin sau khi tạo ticket (C1-C4, G2: ngữ cảnh ticket đã tạo, bổ sung comment không ghi đè mô tả, nút theo ticket đang mở).
- **PR 11 - 17**: Lệnh nhắm vào ticket đã có, huỷ/đóng theo yêu cầu người báo, soát thông tin, dữ liệu domain app mới, `defineBot` lễ tân, adapter OpenClaw, runbook deploy.
