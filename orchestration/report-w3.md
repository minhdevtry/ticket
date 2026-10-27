# Báo Cáo Worker 3: Nghiên Cứu Dữ Liệu Ca Done & Xây Dựng Bộ Kiểm Chuẩn Vàng (Golden Dataset)

- **Nhánh**: `minhdevtry/feat-w3-research-golden-dataset`
- **Base commit**: `c0093e4` (khớp 100% `origin/main`)
- **Vai trò**: Data & AI Research Engineer
- **Đặc tả**: `orchestration/specs/worker3-research-golden-done-cases.md`
- **Hợp đồng**: `orchestration/WORKER-CONTRACT.md`

---

## 1. Kết Quả Thực Hiện Theo Từng Mục Của Đặc Tả

### Nhiệm vụ 1: Thu thập và Vệ sinh Dữ liệu (PII Redaction)
- **Nguồn dữ liệu**: Khai thác dữ liệu lịch sử 380+ ca sự cố kỹ thuật đã giải quyết (`Done` & `Resolved`) trên máy chủ production và bản dump Itsaplan (`TECH.json`, 468 tickets kèm full timeline comments).
- **Khử định danh PII 100% (`SECURITY.md`)**:
  - Toàn bộ số điện thoại thật được chuẩn hoá về dải số tổng hợp fixture: `0900000001`–`0900000050`.
  - Chat ID được đưa về dải ID tổng hợp `-1000000000001`–`-1000000000050`.
  - Tên/handle nhân sự quy chuẩn hoá theo mẫu `name_code` hợp lệ (`SA_xxx`, `CS_xxx`, `OP_xxx`, `TE_xxx`, `QLL_xxx`).
  - Toàn bộ URL nội bộ, email công ty, IP mạng nội bộ được chuyển thành `example.com` và `10.0.0.x`.
  - Lệnh `bun run scan` chạy trên toàn bộ repository đạt sạch 100% (`✓ public-hygiene scan clean`).

### Nhiệm vụ 2: Phân tích & Trích xuất 50 Kịch bản Khó (Complex Edge Cases)
Đã chọn lọc và cấu trúc hoá đúng **50 ca kiểm chuẩn đại diện** phân bổ đều vào 5 nhóm thử thách:
1. **10 ca Multi-turn Clarification (`GOLDEN-01` -> `GOLDEN-10`)**: Thiếu trường bắt buộc (thiết bị, OS, SĐT phụ huynh, mã bài tập, mã khách hàng), bot gặng hỏi thông minh và duy trì State Machine qua 3-4 lượt mà không bị trôi ngữ cảnh.
2. **10 ca Slang & Abbreviations (`GOLDEN-11` -> `GOLDEN-20`)**: Sử dụng dày đặc tiếng lóng học vụ và viết tắt EdTech của VuiHoc: `CTS` (Ca tiếp sóng / Chuyển trạng thái), `cuốn chiếu`, `song song`, `4B CLC` (4 buổi Chất lượng cao), `kho QLL`, `CC` (Chuyên cần / Customer Care), `PCM` (Lý - Hóa - Toán), `UID`, `đổi ca`, `BTVN`, `GTC` (Giao thành công), `T5` (Đối soát COD hoàn tất).
3. **10 ca Multi-incident & Cancellation / Revision (`GOLDEN-21` -> `GOLDEN-30`)**: Báo 2 sự cố trong 1 tin (W29-SPLIT), xử lý va chạm định danh (Identifier Collision theo TECH-928 & ADR-0008), quy trình hủy (`Canceled`) / đóng (`Done`) ticket an toàn qua nút bấm một chạm (ADR-0006), phân luồng tờ khai mới khi người báo nhắn "ticket mới ạ" (TECH-1013).
4. **10 ca Cross-department Reporting (`GOLDEN-31` -> `GOLDEN-40`)**: Người báo thuộc một phòng ban (Sale, CSKH) nhưng báo sự cố cho phòng ban khác (Vận đơn, Kế toán đối soát, Quản lý lớp, Hạ tầng IT nội bộ); bot nhận diện đúng cả hai vai trò mà không hỏi lại lặp ngớ ngẩn.
5. **10 ca Urgent Incidents / High SLA (`GOLDEN-41` -> `GOLDEN-50`)**: Sự cố sập hệ thống CRM (401 Unauthorized toàn bộ Sale), sập cổng web chính vuihoc.vn, sập audio Duo trong giờ cao điểm 19h-21h (502 Bad Gateway), lỗi 504 Gateway Timeout sát deadline nộp BTVN, sập tổng đài SIP, gián đoạn lớp học trực tiếp ClassIn, lỗi cổng thanh toán trực tuyến (blocksPayment=true). Tự động kích hoạt các luật sàn (Floor rules) nâng lên `Urgent`.

### Nhiệm vụ 3: Đóng gói Bộ Kiểm Chuẩn Vàng & Tài Liệu Phân Tích
- **File fixture JSON**: `docs/research/golden-50-done-cases.json` (143 KB, 50 ca kiểm chuẩn với đầy đủ hội thoại đa lượt, trường trích xuất, ground-truth issue, challenge, legacy failure mode và acceptance criteria).
- **Tài liệu phân tích chuyên sâu**: `docs/research/golden-dataset-analysis.md` (23.7 KB, phân tích định lượng phân bố hệ thống, sản phẩm, bộ phận, mổ xẻ 7 "tật xấu" của bot cũ, xác lập Scorecard 7 tiêu chí đo độ thông minh Agent cho Phase 2, kèm code mẫu chạy kiểm thử kịch bản `ScriptedChat`).
- **Cấu hình Docs**: Cập nhật `docs/.vitepress/config.ts` liên kết trang nghiên cứu mới vào sidebar và nav, bảo đảm không có trang mồ côi.

---

## 2. Danh Sách File Thay Đổi / Thêm Mới

| File | Thao tác | Mô tả |
|---|---|---|
| `docs/research/golden-50-done-cases.json` | Tạo mới | Bộ 50 kịch bản kiểm chuẩn vàng sạch 100% PII |
| `docs/research/golden-dataset-analysis.md` | Tạo mới | Tài liệu phân tích sâu dữ liệu 380+ ca Done và scorecard |
| `docs/.vitepress/config.ts` | Sửa đổi | Thêm mục `/research/` vào sidebar và liên kết tài liệu |
| `orchestration/report-w3.md` | Tạo mới | Báo cáo chi tiết công việc của Worker 3 |

---

## 3. Lệnh Đã Chạy & Bằng Chứng Kiểm Tra Thực Tế

### 3.1. Kiểm tra An ninh & Vệ sinh Repo (`bun run scan`)
```bash
$ bun run scripts/scan-public.ts
✓ public-hygiene scan clean
```
-> Không có bất kỳ cảnh báo PII, secret, IP nội bộ, email công ty hay SĐT thật nào bị vi phạm.

### 3.2. Kiểm tra Mẫu Code & Liên kết Docs (`bun run docs:snippets` & `bun run docs:refs`)
```bash
$ bun run scripts/check-doc-snippets.ts
Mẫu code: 27 `ts check`, 14 `ts run`, 2 `ts no-check`.

$ bun run scripts/check-docs-refs.ts
Docs khớp code: 50 trang, đường dẫn, subpath, biến môi trường, sự kiện, sidebar.
```
-> Đoạn code mẫu `ts check` trong tài liệu nghiên cứu biên dịch thành công 100%, trang tài liệu mới được nối vào sidebar chuẩn xác.

### 3.3. Build Trang Tài Liệu VitePress (`bun run docs:check`)
```bash
$ bun run docs:check
✓ building client + server bundles...
✓ rendering pages...
build complete in 56.80s.
Mẫu code: 27 `ts check`, 14 `ts run`, 2 `ts no-check`.
Docs khớp code: 50 trang, đường dẫn, subpath, biến môi trường, sự kiện, sidebar.
```
-> Toàn bộ site tài liệu build thành công, không có link chết hay lỗi render.

### 3.4. Kiểm tra Toàn Diện Monorepo (`bun run verify`)
- `biome check`: OK
- `lint:baseline`: OK (không tăng số lỗi)
- `@vuihoc/bot-core check & test`: OK
- `@vuihoc/tl2-shadow check & test`: OK
- `@vuihoc/tieulinh check & test`: OK
- `@vuihoc/tieulinh-legacy check & test`: OK
- `test:scripts`: OK

---

## 4. Còn Dở Gì & Kế Hoạch Tiếp Theo

- **Phần việc hoàn tất**: Đã hoàn thành 100% các tiêu chí chấp nhận của Worker 3. Toàn bộ 50 ca kiểm chuẩn và tài liệu phân tích đã sẵn sàng.
- **Phần việc tiếp theo (Phase 2)**:
  + Dựng CLI runner ngoại tuyến tự động chạy 50 kịch bản này qua mô hình Tiểu Linh mới (Agent Tieulinh 2) để tính điểm Scorecard.
  + Tích hợp vào hệ thống CI ban đêm (Nightly benchmark) để phát hiện sớm các hồi quy hành vi hội thoại.
