# Knowledge Graph — Cause Taxonomy: thiết kế, giới hạn đã biết, ngưỡng scale

Tài liệu này ghi lại quyết định kiến trúc cho tầng phân loại nguyên nhân (`CauseTaxon`)
trong Memgraph Knowledge Graph ([apps/tieulinh-legacy/lib/kg/cause-taxonomy.json](../lib/kg/cause-taxonomy.json)),
lý do vì sao chọn cách làm này thay vì các phương án khác, và — quan trọng nhất — **ngưỡng cụ
thể để biết khi nào phải đổi kiến trúc**, thay vì tự thuyết phục bản thân "chưa cần đâu" mỗi khi
gặp lại vấn đề cũ ở quy mô lớn hơn.

## 1. Kiến trúc 2 tầng

- **`RootCause` (node, free text)**: mô tả kỹ thuật cụ thể của TỪNG ticket (tên học sinh, mã đơn,
  bảng dữ liệu...). KHÔNG dedup theo text — dedup sẽ phá mất chi tiết mà kỹ thuật viên cần đọc lại.
- **`CauseTaxon` (node, ~24 giá trị cố định)**: nhãn canonical theo CƠ CHẾ lỗi, dùng để gom cụm
  ticket khác chữ/khác hệ thống nhưng cùng bản chất kỹ thuật. Đây là tầng chịu trách nhiệm
  "tương tự nhau" — không phải RootCause.

Mẫu này giống Jira (Summary + Component) hay ServiceNow (Short Description + Category) — tách
chi tiết cụ thể khỏi nhãn phân loại, thay vì cố dedup entity tự do bằng embedding/exact-match.

## 2. Đã validate (không chỉ tin số liệu classifier báo ra)

Cách validate: đọc trực tiếp toàn bộ ticket trong 1-2 cụm lớn nhất, không dùng thống kê gián tiếp.

- Vòng 1: đọc 43 ticket trong `DATA_SYNC_MISMATCH` → phát hiện đây là 1 "họ" lỏng gồm nhiều bug
  khác nhau, và 16 ticket cùng 1 kịch bản nghiệp vụ (SPLIT_KHTN) bị rải vào 5 taxon khác nhau do
  ranh giới định nghĩa mờ giữa `DATA_SYNC_MISMATCH` và `UPSALE_TRANSFER_BUG`.
- Sửa: viết rõ tiêu chí phân biệt (lỗi ở tầng hạ tầng nền/tự động vs lỗi do 1 thao tác nghiệp vụ cụ
  thể gây ra) → chạy lại → `DATA_SYNC_MISMATCH` giảm 43→15, cụm SPLIT_KHTN dồn 6/16→10/16.
- Vòng 2: đọc tay 6 ticket còn "lạc" — phát hiện 3/6 vẫn sai (chung bệnh với 10 ticket kia nhưng lạc
  sang `DATA_MIGRATION_TRANSFER_FEE`/`DATA_DELETE_ARCHIVE_BUG` do 2 nhóm này overlap với
  `UPSALE_TRANSFER_BUG`), 3/6 đúng thật (lỗi cấu hình sản phẩm ban đầu, khác bản chất).
- Sửa: gộp `DATA_MIGRATION_TRANSFER_FEE` vào `UPSALE_TRANSFER_BUG`, viết rõ ranh giới với
  `DATA_DELETE_ARCHIVE_BUG` → chạy lại → cụm SPLIT_KHTN đạt 13/16 đúng + 3/16 khác thật, xác nhận
  bằng đọc tay, không chỉ tin classifier.

**Bài học rút ra**: sau khi sửa 1 lần, đừng tin số liệu mới ngay — validate lại đúng cách đã tìm ra
lỗi lần trước. Ở quy mô hiện tại (327 ticket), đọc tay 1 cụm lớn tốn ~5-10 phút và đáng tin hơn hẳn
việc suy diễn từ % hay thống kê phân bố.

## 3. Cố tình KHÔNG làm (ở quy mô hiện tại)

| Kỹ thuật | Vì sao chưa cần |
|---|---|
| Embedding + clustering (HDBSCAN/UMAP) để tự sinh taxonomy | 327 RootCause đọc tay được trong vài chục phút; taxonomy do người review giữ được khả năng giải thích, embedding cluster thì không ai đọc lại/audit được lý do gộp |
| Cohen's kappa / inter-annotator agreement chính thức | Cần tổ chức dual-labeling — chi phí cao hơn hẳn việc đọc trực tiếp 1 cụm khi nghi ngờ, ở quy mô 1 dự án nội bộ |
| Active novelty detection bằng khoảng cách tới centroid embedding | Chưa có pipeline embedding trong hệ thống; `OTHER_NEW_PATTERN` hiện tại theo dõi bằng % (xem mục 4) đã đủ tín hiệu ở quy mô này |

Đây là quyết định có cân nhắc, không phải bỏ qua vì ngại làm — dưới đây là điều kiện cụ thể để đảo
ngược quyết định này.

## 4. Ngưỡng bắt buộc xem lại kiến trúc (Scaling Triggers)

Khi **BẤT KỲ** điều kiện nào dưới đây xảy ra, phải dừng lại đánh giá — không tự quyết định "chưa
cần đâu":

| Tín hiệu | Ngưỡng | Hành động bắt buộc |
|---|---|---|
| Tỷ lệ `OTHER_NEW_PATTERN` (đã có cảnh báo tự động trong [reclassify-kg-taxonomy.ts](../scripts/reclassify-kg-taxonomy.ts)) | > 10% tổng ticket đã phân loại trong 1 lần backfill/reclassify | Đọc toàn bộ ticket rơi vào `OTHER_NEW_PATTERN`, cân nhắc thêm taxon mới |
| Tổng số ticket trong Knowledge Graph | > 1.500 ticket | Không còn đọc tay nổi 1 cụm lớn trong vài chục phút — bắt đầu thử embedding + UMAP đối chiếu với taxonomy hiện tại (xem có khớp ~24-30 cụm không) |
| Số taxon | > 35 nhóm | Taxonomy đang phình vì thêm nhóm hẹp thay vì gộp đúng cơ chế — cần 1 vòng review gộp giống 2 vòng đã làm ở tài liệu này |
| Thời gian đọc tay để validate 1 cụm nghi ngờ | > 2 giờ/lần | Chi phí đọc tay đã vượt chi phí dựng embedding pipeline 1 lần — chuyển sang embedding + LLM-judge để sàng lọc trước khi đọc tay |
| Có > 2 team/dự án khác dùng chung taxonomy này | Bất kỳ lúc nào | Cần bộ máy đo inter-annotator agreement (Cohen's kappa) vì lúc này "người review" không còn là 1 người duy nhất hiểu hết ngữ cảnh |

## 5. Lịch sử thay đổi taxonomy

| Ngày | Thay đổi | Lý do |
|---|---|---|
| 2026-09-22 | Khởi tạo 28 nhóm từ LLM, gộp còn 25 | 3 nhóm quá hẹp (đặc thù 1 ticket), không gom cụm được |
| 2026-09-22 | Gộp `DATA_MIGRATION_TRANSFER_FEE` vào `UPSALE_TRANSFER_BUG`, sửa ranh giới `DATA_SYNC_MISMATCH`/`DATA_DELETE_ARCHIVE_BUG` | Phát hiện qua đọc tay: 16 ticket cùng kịch bản SPLIT_KHTN bị rải 5 nhóm do định nghĩa overlap — còn 24 nhóm |
