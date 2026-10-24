# ADR-0010 — Mô tả ticket là lời nguyên văn của người báo; suy luận của bot nằm ở comment riêng

Ngày: 02/10/2026 · Trạng thái: chấp nhận · Liên quan: ADR-0007 (ticket tương tự), ADR-0008 (mọi lần ghi phải xác nhận), CONTEXT.md ("Câu hỏi phân biệt")

## Bối cảnh

TECH-1084 (02/10/2026, chat 1000000005). Mô tả ticket ra văn xuôi do AI soạn thay vì lời kể của người báo:

> ### Mô tả
> Học sinh Nguyễn Văn Anh D (Mã học sinh: 900014, Code: 90000011) báo trên app… **Hệ thống xác định ban đầu là VH_Tự học, người báo đã xác nhận đúng hệ thống là Vui học Gia sư**. **Cần đối chiếu dữ liệu** bài tập về nhà trên hệ thống Gia sư.

Hai câu in đậm ở trên không phải lời người báo — đó là suy luận nội bộ của bot. Dưới đó còn mục "Chẩn đoán & Gợi ý" liệt kê nguyên nhân lịch sử (TECH-768, TECH-364, TECH-370) và "Bước xử lý đề xuất".

Điều tra cho thấy ticket này **không đi qua `intake_step`** mà đi qua `create_issue` (không có bản ghi `intake_documents` cho chat đó, nhưng có `ticket_bindings`). Ở đường `intake_step`, `rawText` là lời kẻ gốc từ Telegram (merger.ts). Ở đường `create_issue`, `rawText` nhận giá trị `input.description` — trường do chính LLM điền, không ràng buộc nguyên văn. Tên trường giống nhau, chất lượng dữ liệu khác nhau.

Điểm thứ hai là xung đột với quyết định đã chốt: CONTEXT.md và ADR-0007 cố ý đặt câu hỏi phân biệt trong mục "Chẩn đoán & Gợi ý" ngay trong mô tả, ghi rõ "không phải comment mới".

## Quyết định

1. **Mô tả ticket = lời nguyên văn của người báo.** Không tóm tắt, không nhận định, không phỏng đoán. `formatTicketDescription` dựng "### Mô tả" từ `incident.rawText`.
2. **Tách hai trường, mỗi trường một vai.** `rawText` = NGUYÊN VĂN, dùng cho mục "### Mô tả" (thứ người đọc thấy VÀ văn bản nguồn cho BM25 qua `symptomsOfDescription`). `reporterText` = `rawText` + `description`, dùng **nội bộ** cho `groundIdentifierFields` đối chiếu định danh — cần cả bản tóm tắt vì SĐT người báo có thể chỉ nằm trong đó. `reporterText` KHÔNG hiển thị: trộn nó vào mô tả là lại lộ nhận định của model ra (lỗi gốc).
3. **`rawText` phải là TOÀN BỘ lượt tròi chuyện**, không chỉ tin vừa gửi — mô tả zod và AGENTS.md nói rõ. Nhờ vậy "### Mô tả" vừa sạch (chỉ lời người) vừa đủ từ khoá tra cứu. Ở đường `intake_step`, merger.ts đã gộp sẵn mọi lượt nên vốn đã đầy đủ.
4. **KHÔNG nhân bản lời kẻ vào HTML comment ẩn.** Đã thử `<!-- vuihoc-search -->` ở footer rồi bỏ: `cleanIncidentDescription` xoá mọi comment, `applyEditOps` đếm số lần xuất hiện để quyết định sửa được không (bản sao thứ hai làm mọi lệnh `replace` bị từ chối), `appendTicketUpdateDescription` cắt theo `---` mà lời người gõ có thể chứa `---`, và regex `.*?` tới ` -->` vỡ nếu lời người chứa `-->`. Bản sao thứ hai của lời kẻ làm hỏng nhiều thao tác cắt chuỗi sẵn có hơn là nó tạo ra.
5. **Tách trường cho đường `create_issue`.** Thêm `rawText` vào `inputShape` (`tieulinh/domain.ts`) với mô tả ràng buộc rõ: chép lại y nguyên, **dùng cho mọi tin nhắn kể cả khi ngắn một câu**, không viết lại, suy luận thì để vào `diagnosis`. Khi có, nó thắng `description`.
6. **Mọi chỗ đọc lời người báo phải đọc `rawText`, không chỉ `description`.** Sau khi tách, từ khoá phân loại và số điện thoại nằm ở tin nguyên văn; nếu chỉ đọc `description` thì:
   - `heuristicText` (đoán hệ thống / `errorCategory`) → ticket rơi về "Khác", mất nhãn gán trên Itsaplan;
   - `extractAccounts` (moi SĐT khi model không điền `studentId`) → mất SĐT;
   - `textToCheck` trong `create_issue` (dò ảnh/video đính kèm) → ảnh người báo nhắn "gửi ảnh giúp em" không được đính kèm.
7. **Suy luận của bot sang comment riêng.** Hàm mới `buildAdviceComment(diagnosis, runbookAdvice)` dựng comment "Gợi ý chuyên môn & nguyên nhân đã biết" từ `diagnosis` + `kgAdvice`, lọc câu rỗng ("không tìm thấy…"). Ghi bằng `itsaplan.addComment()` sau khi tạo ticket. **Bắt buộc bọc `markBotComment()`** — nếu không, kg-sync học gợi ý của bot thành `humanNotes` rồi đẩy vào KG (đúng thứ `human-signals.ts` cấm), và `duplicate-merger` có thể tự huỷ ticket vì bản thân nó nhắc mã ticket đồng nghiệp. Câu hỏi phân biệt nằm trong comment này.
8. **Cập nhật CONTEXT.md** — bỏ "không phải comment mới" ở mục "Câu hỏi phân biệt", thêm mục "Mô tả ticket vs. gợi ý của bot".
9. **Gỡ mục "Chẩn đoán & Gợi ý" khỏi `formatTicketDescription`**, cùng tham số `runbookAdvice` đã thành chết ở đó.

## Hệ quả

- Mô tả ticket sạch: đội kỹ thuật phân biệt được đâu là lời người, đâu là AI đoán.
- Mất "bản tóm tắt suy luận ngay trong mô tả" — bù lại bằng comment bot ngay dưới ticket, vẫn kèm nguyên nhân lịch sử và câu hỏi phân biệt.
- Việc tra KG chạy nền (`runSimilarTicketsInBackground`) **không còn viết lại mô tả** bằng `updateIssue`; chuyển sang `addComment`. Ít nguy cơ tranh chấp với bản mô tả mới hơn.
- **Đường `create_issue` vẫn phụ thuộc LLM** tuân thủ mô tả trường `rawText` — đây là hàng rào mềm, không phải bảo đảm tuyệt đối. Bảo đảm cứng là định tuyến mọi sự cố mới qua `intake_step` (ADR-0008), nơi `rawText` đến thẳng từ Telegram. Nếu `intake_step` hỏng, `create_issue` chỉ còn là dự phòng kém hơn, không phải đường chính.
- `cleanIncidentDescription` (similar-context.ts) và bộ lọc ở kg-sync **giữ nguyên** — kho KG còn nhiều ticket lịch sử mang mục "Chẩn đoán & Gợi ý", phải tiếp tục cắt bỏ khi đọc.

## Bài học

Hai đường tạo ticket cùng dùng tên trường `rawText` nhưng khác nguồn gốc dữ liệu, và điều đó không hiện ra trong kiểu dữ liệu. Trường không bắt buộc + schema mô tả lỏng = lỗi im lặng. Khi một tên trường mang ý nghĩa "nguyên văn", phải hỏi nó lấy từ đâu, không chỉ hỏi nó có được gán hay không.
