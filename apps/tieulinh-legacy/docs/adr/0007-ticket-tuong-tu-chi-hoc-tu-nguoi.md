# Ticket tương tự chỉ học từ tín hiệu của người, không học từ gợi ý của bot

Chốt 26/09/2026 sau sự cố TECH-920: bot ghi 34 mã vào Related Tickets, chỉ khoảng 14 mã đúng. Đo trên toàn TECH, thuật toán cũ trả trung vị 73 mã cho mỗi ticket, đúng 6%.

Knowledge Graph chỉ dựng cụm "cùng nguyên nhân" từ ba tín hiệu do người tạo:

1. câu Nguyên nhân / Cách khắc phục trong **comment ghim** (người điều phối TECH ghim trên ticket),
2. liên kết hoặc mã trong trường Related Tickets **do người thêm**,
3. liên kết **do người gỡ**. Đây là tín hiệu cấm, hai ticket đã bị người gỡ liên kết thì không bao giờ vào chung cụm.

Liên kết và trường Related Tickets do bot ghi (Tiểu Linh, `admin`, Onyx) không bao giờ thành tri thức. Trước đây KG nạp lại chính gợi ý của bot, nên mỗi lần gợi ý sai lại được củng cố cho lần sau.

Khi tiếp nhận sự cố mới, bot chỉ ghi ticket tương tự lên Itsaplan khi đủ tự tin là sự cố thuộc một cụm. Lúc đó bot ghi đủ các ticket trong cụm. Không đủ tự tin thì không ghi gì. Kết quả Onyx không bao giờ được ghi vào ticket.

## Considered Options

- Giữ mở rộng cụm theo `RELATES_TO` và theo nhóm nguyên nhân LLM: bị loại. Không có trần, và nguồn cạnh là gợi ý của bot.
- Rerank bằng LLM: người dùng chốt 25/09 là chưa làm.
- Ánh xạ "Dòng N (sheet T0x/2026)" trong comment ghim sang mã TECH: bị loại. File Excel không có cột mã TECH, các dòng đó là sự cố cũ trước khi có Itsaplan. Gộp cụm theo dòng sheet chung chỉ thêm được 4 ticket.

## Consequences

- Phần "nguyên nhân gốc" mà ADR-0004 để đợt sau nay đã đủ điều kiện: truy vấn dùng nó, nhiễu gây hại, và comment ghim là nguồn chuẩn.
- Ticket hoàn tất chưa có comment ghim chỉ đóng góp chữ mô tả để tìm kiếm, không có cụm. Việc gán cụm cho các ticket này làm sau.
- Chốt ticket tương tự lúc người ghim nguyên nhân (đúng 97%), lúc tạo ticket chỉ là gợi ý ban đầu; ticket IT Support xử lý như mọi ticket TECH (chốt 27/09).
- Luật "ghi sớm rộng hơn, tự bỏ khi chốt" (26/09): lúc tạo ticket nới ngưỡng để người xử lý có gợi ý sớm rộng hơn (75/143, đúng 86%, chấp nhận 2/28 ghi nhầm); lúc người chốt nguyên nhân (comment ghim), bot tự gỡ các liên kết bot gắn sang ticket không cùng nguyên nhân (< 0.6) để tự làm sạch, bỏ vùng xám. Liên kết do người gắn không bao giờ bị gỡ.
- **Chốt 27/09 — thay thuật toán lúc tiếp nhận** (số 86% ở trên đo bằng leave-one-out
  trên chính kho đang có, dùng cả câu Nguyên nhân của chính ticket đang hỏi —
  lạc quan hơn thực tế; benchmark mù time-split cho thấy chỉ 33% đúng, 3/20 trả
  lời). Bỏ hẳn bỏ phiếu theo ngưỡng BM25 (`SimilarityIndex.find()` — minShare,
  rankDecay, top0MinShare/top0MinLead, minLead) lúc tiếp nhận VÀ lúc dọn ticket
  chưa ghim (nhánh "suggested" của `related-curator.ts`). Thay bằng: Onyx (RAG,
  ứng viên ngữ nghĩa) + BM25 (giữ lại `SimilarityIndex.search()`, chỉ còn 1 kênh
  ứng viên lexical thuần) sinh ứng viên → LLM xác minh TỪNG cặp (1 ứng viên/lời
  gọi, không gộp — gộp nhiều ứng viên vào 1 prompt cho kết quả tệ hẳn) → chốt
  chặn xác định bằng "thông báo lỗi nguyên văn" (quote-gate.ts) thắng cả LLM;
  không có gì đối chiếu thì cần LLM báo `confidence: "high"` VÀ cụm ứng viên đã
  có ≥ 2 thành viên (dạng lỗi từng lặp lại, không tin một phán đoán đơn lẻ) →
  giãn cụm KG như cũ. Ứng viên được chấp nhận rơi vào ≥ 2 cụm khác nhau: không
  ghi gì, hỏi lại 1 câu phân biệt ngắn cho người xử lý thay vì đoán liều. Đo
  trên benchmark mù bằng code thật (`bun scripts/eval-similar-bench.ts dev`,
  xem spec): 9/18 trả lời, đúng 89%, đủ 89%, 1/34 ghi nhầm — bằng hoặc tốt hơn
  mốc nghiên cứu gốc (researcher A: 8/18, 77%, 88%, 0/34). Trên test (điều
  phối viên chấm bằng gold ẩn, chạy đúng 1 lần): 10/20 trả lời, đúng 66%, đủ
  70%, 1/47 ghi nhầm — tốt nhất trong 3 phương án so sánh (thuật toán bỏ phiếu
  BM25 cũ 33%, researcher A 52%, hệ thống này 66%). `description`/`humanNotes`/
  `system`/`product` (lib/kg/similar-context.ts::similarContextOf, ghi vào node
  Ticket KG thật qua worker/kg-sync.ts + memgraph-client.ts) là schema SẢN
  XUẤT, KHÔNG phải riêng benchmark — ticket đã có trên KG cần
  `backfill-kg.ts --rebuild` một lần sau deploy (xem hướng dẫn triển khai). Xem
  chi tiết tại `docs/superpowers/specs/2026-09-26-ticket-tuong-tu-design.md`
  mục "Kiến trúc mới".

