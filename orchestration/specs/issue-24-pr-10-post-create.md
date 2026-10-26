# Đặc tả: PR 10 của RFC 0002 — tin sau khi tạo ticket (issue #24)

## Context

Repo: `minhdevtry/ticket`. Đây là PR 10 của chuỗi di trú lễ tân (`docs/rfc/0002-receptionist.md` mục 5), issue #24.
PR 1-9 đã hoàn thành và merge vào `main` (mới nhất là PR 9: tách báo cáo nhiều sự cố, PR #55).

Mục tiêu của PR 10 là xây dựng toàn bộ cơ chế xử lý **tin nhắn sau khi tạo ticket** (hậu tạo ticket), gồm các yêu cầu nghiệp vụ:
- **C1**: Tờ khai đã tạo là tờ khai ĐÓNG; phân loại ý định người báo trong ngữ cảnh ticket đã tạo (chitchat/cảm ơn, huỷ, bổ sung, báo sự cố mới).
- **C2**: Không bao giờ tự ghi vào ticket đã tạo, kể cả khi "chắc" là bổ sung — luôn qua bản xem trước và nút xác nhận; nhận diện rõ ràng "ticket mới ạ" / "phụ huynh khác" để mở sự cố mới (ADR-0008, TECH-1013).
- **C3**: Tin mang định danh khác ticket vừa tạo thì hỏi chứ không ghi đè; ticket đã đóng (`Done` / `Canceled`) thì từ chối lịch sự và hướng dẫn tạo ticket mới (W29-NOTIFY).
- **C4**: Thực thi ghi bổ sung bằng bình luận (comment, không ghi đè mô tả nguyên văn), bảo toàn định danh đã tạo, tải media, phân giải `@mention` kỹ thuật viên theo 3 bước chuẩn, gửi cảnh báo trực ca nếu cấu hình.
- **G2**: Nâng mức ưu tiên (`requestedPriority`) kèm lý do chính đáng trên ticket đã tạo và ghi chú vào comment (Quy tắc 29/09).
- **B8**: Nhiều ticket đang mở cùng chat — mỗi ticket có một nút xác nhận riêng, ticket vừa tạo là gợi ý đầu (TECH-989, TECH-1001).

**Bất biến an toàn cốt lõi**:
- **ADR-0008**: Không có bất kỳ đường ghi nào vào ticket đã có (bổ sung comment, sửa, nâng mức, huỷ) mà không qua bản xem trước và cú bấm nút khớp nhãn chính xác từ người báo.
- **ADR-0006**: Bot không bao giờ tự đóng ticket.
- **ADR-0010**: Mô tả ticket là nguyên văn lời người báo; bổ sung chỉ thêm comment, không dựng lại mô tả.

**Tài liệu đọc trước (bắt buộc)**:
- `orchestration/WORKER-CONTRACT.md` — hợp đồng chung cho mọi worker Orca.
- `AGENTS.md` và `CODING_STANDARDS.md`.
- `packages/core/GLOSSARY.md` — thuật ngữ chuẩn (`draft`, `binding`, `tracker`, `catalog`, `CopyCatalog`, `port`).
- `docs/rfc/0002-receptionist.md` mục 1.3 (dòng C1-C4), mục 1.5 (dòng G2), mục 1.2 (dòng B8), mục 2.1-2.4, mục 5 (hàng PR 10).
- `apps/tieulinh-legacy/docs/adr/0008-mot-luong-chat-ghi-vao-ticket-phai-xac-nhan.md`.
- `apps/tieulinh-legacy/docs/adr/0006-chi-nguoi-xu-ly-dong-ticket.md`.

---

## Target

Các thành phần và module trong `packages/core` cần triển khai:

1. **`packages/core/src/intake/engine/engine.ts`**:
   - Phân luồng khi tờ khai ở trạng thái `draft.status === "created"`.
   - Cổng trích xuất: truyền đầy đủ ngữ cảnh `createdTicket: { identifier, title, description }` trong `ExtractInput.context`.
   - Phân loại ý định: `chitchat` (cảm ơn), `cancel` (hướng dẫn cú pháp), `confirm` (idempotent thông báo đã tạo), `report_issue` (mở tờ khai mới).
   - Kiểm tra định danh xung đột (`identifiersConflict`) so với định danh của ticket đã tạo.
   - Kiểm tra trạng thái đóng (`Done` / `Canceled`) qua cổng đọc trạng thái ticket: từ chối bổ sung bằng outcome `closed_refusal` (legacy action `post_create_update`), nhưng tin báo sự cố mới (`report_issue`) vẫn mở tờ khai mới.
   - Nhận diện tuyên bố sự cố mới (`saysNewIncident`): mở tờ khai mới nếu có nội dung, hoặc trả về `clarify` nếu câu quá ngắn.
   - Đề xuất bổ sung (`pendingTicketAction` kind `suggest`): hỗ trợ ticket chính (`primary`) và các ticket đang mở khác (`alternatives`, B8), nút `Sự cố mới`.
   - Xử lý trạng thái chờ nút `suggest`: gộp ảnh gửi thêm, gộp chữ gõ tay khi chọn sự cố mới (`withTypedDetail`), hủy bản xem trước khi nhắn việc khác.
2. **`packages/core/src/intake/draft/types.ts`**:
   - Mở rộng `pendingTicketAction` trong `IntakeDraft` để lưu đầy đủ:
     - `kind: "append" | "edit" | "move" | "suggest"`
     - `identifier: string`
     - `issueId?: number`
     - `content?: string`
     - `message?: string`
     - `mediaPaths?: string[]`
     - `lead?: string`
     - `alternatives?: Array<{ identifier: string; issueId: number; title?: string }>`
     - `confirmLabel: string`
     - `askedAt?: string`
3. **`packages/core/src/intake/create/binding-store.ts`**:
   - Bổ sung phương thức `listBindingsForChat(chatId: string, limit?: number, identifierPrefix?: string)` để tra cứu lịch sử binding của chat phục vụ tìm các ticket đang mở khác (B8).
4. **`packages/core/src/intake/ports.ts` & `packages/core/src/intake/adapter.ts`**:
   - Bổ sung khả năng kiểm tra trạng thái đóng của ticket (`isIssueClosed` hoặc `getIssueState`) trên `TrackerPort` hoặc `TicketStateReaderPort`.
   - Bổ sung các `CopyKey` cho thông báo hậu tạo ticket và các nút tương tác.
5. **`packages/core/src/intake/notify/` hoặc `packages/core/src/intake/supplement/`**:
   - Port các hàm thuần từ legacy `apps/tieulinh-legacy/lib/itsaplan/supplement-notifier.ts`:
     - `isIssueClosed`
     - `closedTicketRefusalMessage`
     - `resolveSupplementMentionTarget`
     - `formatSupplementComment`
     - `notifyOnCallSupplement`
6. **Kiểm thử và sổ đối chiếu**:
   - Port đủ **37 ca test legacy** (12 flow + 6 notify-supplement + 19 pure supplement-notifier).
   - Cập nhật `apps/tieulinh/receptionist-gap-register.test.ts`: chuyển 37 dòng từ `deferred` sang `ported`.
   - Ghi nhận `packages/core/CHANGELOG.md` và `packages/core/docs/parity/ENGINE.md`.
   - Cập nhật bảng mục 1.5 trong `docs/rfc/0002-receptionist.md` cho các dòng C1-C4, G2, B8.

---

## Change chi tiết

### 1. C1 — Tờ khai đã tạo là tờ khai ĐÓNG & Phân loại ý định theo ngữ cảnh `createdTicket`

- **Nguyên tắc**: Tờ khai đã tạo ticket (`draft.status === "created"` và có `issueId`) là một tài liệu đã hoàn tất vòng đời tiếp nhận ban đầu. Mọi tin nhắn sau đó trong chat KHÔNG BAO GIỜ được tự ý ghi đè mô tả hay các trường định danh đã lưu trong ticket.
- **Truyền ngữ cảnh cho extractor**:
  - Khi gọi extractor ở lượt sau tạo, phải truyền `context.createdTicket = { identifier: draft.issueIdentifier, title: draft.ticket.title }`.
  - Bộ trích xuất (hoặc heuristic sau LLM) dùng cờ `createdTicket`:
    - Nếu tin nhắn KHÔNG chứa từ chỉ lỗi/sự cố mới (chỉ là tên con, mã học sinh, mã đơn, ảnh, SĐT bổ sung...) → coi là `provide_info` (thông tin bổ sung cho ticket đã tạo).
    - Chỉ khi có từ chỉ lỗi rõ ràng (`PROBLEM_WORDS`) hoặc nói rõ báo lỗi mới ("báo thêm lỗi khác", "sự cố mới", "ticket khác") → mới coi là `report_issue`.
- **Hành vi theo ý định người báo**:
  - **Chitchat / Cảm ơn** (`userIntent === "chitchat"` hoặc `isChitchat(text)`):
    - Câu trả lời lịch sự qua `CopyCatalog`: `Dạ không có gì ạ! Ticket {identifier} đang được đội Kỹ thuật tiếp nhận, có cập nhật em sẽ báo anh/chị ngay nhé.` (key `ticket.chitchat_after_create`).
    - Kết quả: outcome `already_created`, đính kèm `{ issue }`. Không đụng tới ticket, không tạo tờ khai mới.
  - **Huỷ chung chung** (`userIntent === "cancel"` hoặc `isExplicitCancel(text)` nhưng không có mã theo lệnh D8):
    - Bot không tự ý huỷ/đóng ticket (ADR-0006). Trả lời hướng dẫn cú pháp rõ ràng: `Dạ nếu anh/chị muốn hủy hoặc đóng ticket {identifier}, anh/chị nhắn rõ giúp em "hủy {identifier}" (kèm lý do nếu có) để em xác nhận chuyển trạng thái nhé ạ.` (key `ticket.cancel_hint_after_create`).
    - Kết quả: outcome `already_created`, đính kèm `{ issue }`.
  - **Bấm lại nút xác nhận cũ** (`userIntent === "confirm"` hoặc `isShortConfirmation(text)`):
    - Trả lời: `Dạ ticket {identifier} em đã tạo rồi ạ, anh/chị không cần xác nhận lại nhé.` (key `ticket.already_created_hint`).
    - Kết quả: outcome `already_created`, đính kèm `{ issue }` (tính chất idempotent create).
  - **Báo sự cố mới** (`userIntent === "report_issue"`):
    - Đóng tờ khai cũ, mở tờ khai mới (`freshDoc`), chuyển sang bước thu thập `collect` cho sự cố mới ngay trong lượt này.

### 2. C2 — Không bao giờ tự ghi vào ticket đã tạo; Nhận diện "ticket mới ạ" & Trạng thái chờ gợi ý (ADR-0008, TECH-1013)

- **Nguyên tắc ADR-0008**: Kể cả khi bot "chắc chắn 100%" tin nhắn là bổ sung (người báo gửi ảnh chụp màn hình, gửi thêm SĐT, hoặc extractor khẳng định `provide_info`), bot TUYỆT ĐỐI KHÔNG tự động gọi ghi vào Itsaplan.
- **Hỏi xác nhận bằng bản xem trước + nút**:
  - Gặp tin bổ sung hoặc tin có ảnh: tạo bản xem trước `pendingTicketAction` với `kind: "suggest"`.
  - Trích đoạn hiển thị:
    - Trích nội dung bổ sung (cắt tối đa 500 ký tự hiển thị, escape markdown quote: `> ...`).
    - Báo số lượng tệp đính kèm: `(kèm N ảnh/tệp)`.
  - Câu chữ dẫn dắt (CopyCatalog):
    - Tin bổ sung thông thường: `Dạ tin này là bổ sung cho {identifier} phải không ạ? Em sẽ ghi vào {identifier}:\n\n> {quoted}\n{files}\n\nAnh/chị bấm nút xác nhận để em ghi, hoặc "Sự cố mới" nếu là việc khác nhé.`
  - Hàng nút bấm:
    - Nút 1: `✅ Bổ sung vào {identifier}`
    - (Các nút của ticket đang mở khác nếu có — xem mục B8)
    - Nút cuối: `Sự cố mới` (`button.new_incident`, nhãn `"Sự cố mới"`).
  - Outcome: `action_preview` (legacy action: `confirm_ticket_action`).
- **Nhận diện tuyên bố sự cố mới ("ticket mới ạ", "phụ huynh khác")**:
  - Hàm `saysNewIncident(text)` nhận diện: `"ticket mới ạ"`, `"phụ huynh khác"`, `"học sinh khác"`, `"báo lỗi khác"`, `"sự cố khác"`.
  - Xử lý khi gặp tuyên bố:
    - Nếu câu gõ trần quá ngắn (sau khi bóc cụm tuyên bố bằng `stripNewIncidentDeclaration(text)` còn `< 12` ký tự) và không kèm ảnh:
      - Mở tờ khai mới, trả về outcome `clarify` (legacy action `clarify_intent`): `Dạ vâng, anh/chị mô tả sự cố mới giúp em nhé ạ.`
    - Nếu câu có nội dung chi tiết (`>= 12` ký tự) hoặc có kèm ảnh:
      - Mở tờ khai mới, gọi `collect` ngay để tiếp nhận sự cố mới.
- **Xử lý khi đang chờ người báo chọn ở bản xem trước `suggest`**:
  - Nếu người báo bấm `Sự cố mới` hoặc gõ câu mang ý `saysNewIncident`:
    - Xoá `pendingTicketAction`.
    - Mở tờ khai mới, nối nội dung đã gác ở `pending` với nội dung gõ thêm: `withTypedDetail(pending.message, text)`.
    - Bảo toàn toàn bộ ảnh đính kèm: `Array.from(new Set([...pending.mediaPaths, ...mediaPaths]))`.
    - Gọi `collect` cho tờ khai mới để không rơi rớt chữ và ảnh.
  - Nếu người báo gửi thêm ảnh trong lúc đang chờ:
    - Gộp ảnh mới vào `pendingTicketAction.mediaPaths`.
    - Lưu lại revision, hỏi lại kèm số lượng ảnh đã nhận: `Dạ anh/chị bấm giúp em một nút phía trên để em ghi đúng chỗ (đã nhận kèm N ảnh/tệp) nhé ạ.`
  - Nếu người báo gõ tin nhắn việc khác mà không bấm nút:
    - Nhắc lại yêu cầu bấm nút để ghi đúng chỗ: `Dạ anh/chị bấm giúp em một nút phía trên để em ghi đúng chỗ nhé ạ.` (vẫn giữ nguyên `pendingTicketAction` để chống trôi ảnh/dữ liệu).

### 3. C3 — Định danh xung đột & Từ chối bổ sung vào ticket đã đóng (W29-NOTIFY)

- **Định danh xung đột với ticket đã tạo**:
  - Dùng `identifiersConflict(existingValue, incomingValue)` (đã có ở `packages/core/src/intake/engine/identifiers.ts`):
    - So sánh các trường định danh (`phone`, `studentAccount`, `customerId`, `orderId`) giữa ticket đã tạo và tin nhắn mới.
    - Hai định danh chỉ xung đột khi cả hai cùng có chữ số và không phải tập con của nhau (vd `0900000003` khác `0900000004`).
  - Nếu phát hiện xung đột định danh và tin không phải `report_issue`:
    - Đổi câu dẫn dắt sang cảnh báo: `Dạ tin này có thông tin (SĐT/mã) khác với {identifier} phải không ạ? Em sẽ ghi vào {identifier}:\n\n> {quoted}\n\nAnh/chị bấm nút xác nhận để em ghi, hoặc "Sự cố mới" nếu là việc khác nhé.`
    - Tuyệt đối không tự ý ghi bổ sung vào ticket cũ khi mã khác nhau.
- **Từ chối bổ sung vào ticket đã đóng (`Done` / `Canceled`) — W29-NOTIFY**:
  - **Bối cảnh**: Yêu cầu từ Tech Lead VuiHoc: *"ticket đã đóng thì thôi không cho làm gì vào nữa, bên báo lỗi phải tự chủ động tạo ticket mới"*.
  - **Cổng đọc trạng thái ticket**:
    - Khi nhận tin muốn bổ sung (hoặc trước khi ghi bổ sung), engine gọi cổng đọc trạng thái ticket để kiểm tra trạng thái hiện tại trên Itsaplan.
    - Dùng `classifyColumn(column)` hoặc `isIssueClosed(issue, columns)`:
      - Cột `Done` (`stateType === "completed"` và tên không phải Resolved) → `done`.
      - Cột `Canceled` (`stateType === "canceled"`) → `canceled`.
      - Cột `Resolved` ("Đã xử lý") → vẫn tính là **mở** để người báo nghiệm thu và phản hồi.
      - Cột `In Progress` / `Backlog` → tính là **mở**.
  - **Xử lý khi ticket đã đóng**:
    - Nếu tin mới là báo sự cố mới (`report_issue`): **Vẫn mở tờ khai mới bình thường**, không chặn!
    - Nếu tin mới là bổ sung (kể cả lệnh gõ tay chỉ định mã `bổ sung TECH-X`):
      - **Từ chối lịch sự, KHÔNG ghi comment, KHÔNG cập nhật ticket**.
      - Câu từ chối chuẩn (`closedTicketRefusalMessage`):
        `Dạ ticket {identifier} hiện đã đóng ở trạng thái {statusLabel} trên hệ thống rồi nên không thể ghi bổ sung được nữa ạ. Nếu cần hỗ trợ sự cố mới, anh/chị vui lòng tạo ticket mới giúp em nhé ạ.`
        (với `{statusLabel}` là `"Hoàn tất (Done)"` hoặc `"Đã hủy (Canceled)"`).
      - Kết quả: outcome `closed_refusal` (legacy action: `post_create_update`), đính kèm `{ issue }`.

### 4. C4 — Ghi bổ sung vào ticket qua comment (Mention Resolver, Comment Formatting, On-call Alert)

Khi người báo bấm đúng nút xác nhận `✅ Bổ sung vào {identifier}` (hoặc nút của ticket thay thế):

1. **Comment, KHÔNG ghi đè mô tả (ADR-0010)**:
   - Mô tả ticket ban đầu giữ nguyên văn. Bổ sung chỉ ghi qua `addComment`.
   - Giới hạn độ dài nội dung bổ sung: cắt trần `MAX_FOLLOW_UP_CHARS = 4_000` ký tự.
2. **Bảo toàn định danh ticket đã tạo**:
   - Nếu tin bổ sung có chứa định danh mới, định danh này chỉ nằm trong comment. Không ghi đè các trường định danh (`phone`, `studentAccount`, `customerId`) của tờ khai/ticket đã tạo.
3. **Tải tệp đính kèm (Media)**:
   - Tải các file ảnh/media lên ticket qua `TrackerPort.attach` (hoặc `uploadAttachments`).
   - Nối định dạng markdown của các ảnh đã tải vào nội dung comment.
4. **Thuật toán phân giải người nhận @mention (`resolveSupplementMentionTarget`)**:
   - **Mục đích**: Báo trực tiếp vào Inbox của kỹ thuật viên phụ trách trên Itsaplan.
   - **Quy trình 3 bước**:
     - *Bước 1 (Ưu tiên Assignee)*: Nếu ticket có `assigneeUserId`, tra danh sách thành viên dự án (`project.assignees`). Nếu tìm thấy và có `username` hợp lệ → chọn mention `@username` (loại bỏ `@` thừa nếu có, `source: "assignee"`).
     - *Bước 2 (Kỹ thuật viên gần nhất)*: Nếu chưa gán assignee, tra timeline bình luận của ticket từ mới nhất đến cũ nhất:
       - Bỏ qua bình luận của bot (`isBotComment`), bình luận agent (`actorKind === "agent"`), diễn viên hệ thống (`isSystemActor`), bot names (`tiểu linh`, `iris`, `admin`...).
       - Bỏ qua bình luận của chính người báo (`reporterNames`).
       - Tìm bình luận đầu tiên của kỹ thuật viên thật: khớp `actorUserId` hoặc `actorUsername` hoặc `actorName` với thành viên dự án → chọn mention `@username` (`source: "last_commenter"`).
       - Fallback: nếu `actorUsername` hợp lệ dạng chữ số nhưng chưa có trong danh sách assignees dự án → vẫn mention `actorUsername`.
       - Nếu gặp bình luận của kỹ thuật viên nhưng không rõ username → dừng lại, trả về `null` (để không mention nhầm người cũ hơn).
     - *Bước 3 (Không có ai)*: Nếu ticket chưa gán và timeline chỉ có bot/hệ thống/người báo → trả về `null` (không cc ai).
5. **Định dạng comment bổ sung (`formatSupplementComment`)**:
   - Khi có mention:
     `➕ **[Cập nhật bổ sung từ người dùng]** (cc @{username}):\n{bodyText}`
   - Khi không có mention:
     `➕ **[Cập nhật bổ sung từ người dùng]:**\n{bodyText}`
   - Đánh dấu comment của bot (`markBotComment`, chèn `<!-- intake-bot -->`) để hệ thống nhận diện, tránh bot tự đọc lại comment của chính mình.
6. **Cảnh báo kênh trực ca (`notifyOnCallSupplement`)**:
   - Nếu môi trường bật `NOTIFY_ON_CALL_SUPPLEMENT=1` và có cấu hình `notifier.broadcastAlert`:
     - Gửi tin nhắn ngắn tới kênh trực ca Telegram:
       `📢 **[Tiểu Linh]** Người báo vừa bổ sung thông tin vào ticket **{identifier}**:\n> {shortSummary}` (cắt trần 300 ký tự).
     - Lỗi khi broadcastAlert phải được bắt và ghi log cảnh báo, không làm sập luồng ghi bổ sung.
7. **Phản hồi người báo**:
   - Lưu revision tờ khai, cập nhật `updatedAt`.
   - Thông báo kết quả: `Em đã cập nhật bổ sung thông tin này vào ticket {identifier} cho anh/chị rồi nhé ạ!` (kèm trích đoạn hiển thị markdown).
   - Outcome: `action_done` (legacy action: `post_create_update`).

### 5. G2 — Xin gấp sau khi đã tạo ticket có lý do (Quy tắc 29/09)

- **Bối cảnh**: Người báo sau khi đã tạo ticket thường nhắn thêm: *"chị cần gấp để phụ huynh vào học"*, *"em xử lý gấp giúp anh"*.
- **Điều kiện nâng mức ưu tiên**:
  - Tin bổ sung được bộ trích xuất nhận diện có `requestedPriority` (`"high"` hoặc `"urgent"`) VÀ có `requestedPriorityReason` (lý do cụ thể, ví dụ: "học sinh đang trong giờ học", "phụ huynh giục gấp").
  - Mức xin phải cao hơn mức hiện tại của ticket theo thứ tự: `Urgent (4) > High (3) > Medium (2) > Low (1)`.
- **Hành động**:
  - Cập nhật trường `priority` trên tracker: gọi `updateIssue(issueId, { priority: requestedPriority })`.
  - Cập nhật trường `priority` trong tờ khai.
  - Chèn thêm một dòng thông báo nâng mức vào nội dung comment bổ sung gửi chuyên viên:
    `⏫ Nâng mức ưu tiên {currentLabel} → {newLabel} theo đề nghị của người báo. Lý do: {reason}`.
- **Nếu xin gấp KHÔNG có lý do** (hoặc trả lời "không có" lý do):
  - Giữ nguyên mức ưu tiên hiện tại, không nâng mức trên ticket.

### 6. B8 — Nhiều ticket đang mở cùng chat: Mỗi ticket có một nút riêng (TECH-989, TECH-1001)

- **Bối cảnh**: Người báo chỉ có một cửa sổ chat với bot nhưng có thể phụ trách nhiều học sinh hoặc gặp nhiều sự cố cùng lúc (27% người báo có ≥ 2 ticket mở). Khi người báo gửi tin sau khi tạo, tin đó có thể bổ sung cho ticket vừa tạo, hoặc bổ sung cho một ticket cũ hơn đang mở.
- **Cơ chế tìm ticket đang mở (`otherOpenTickets`)**:
  - Tra cứu các binding của chat qua `ChannelBindingStore.listBindingsForChat(chatId, 8)`.
  - Loại trừ ticket vừa tạo (`exceptIdentifier`).
  - Kiểm tra trạng thái từng ticket qua tracker: nếu `stateType === "completed"` hoặc `stateType === "canceled"` thì bỏ qua.
  - Lấy tối đa **3 ticket đang mở khác**, sắp xếp mới nhất trước (`alternatives`).
- **Chọn ticket chính (`primary`)**:
  - Mặc định: ticket vừa tạo là `primary`.
  - Nếu có `TicketCommandInterpreterPort` và có `others`: thông dịch tin nhắn của người báo. Nếu người báo nói rõ mã hoặc nội dung chỉ ra một ticket cũ (ví dụ "đây là của 989 mà"), chọn ticket đó làm `primary`.
- **Hiển thị bản xem trước và hàng nút**:
  - Nếu có `alternatives`: liệt kê danh sách ticket khác trong câu thoại:
    `Anh/chị còn ticket đang mở khác, nếu tin này thuộc ticket đó thì bấm đúng mã:\n- {alt1.identifier} «{alt1.title}»\n- {alt2.identifier} «{alt2.title}»`
  - Hàng nút gồm:
    - Nút 1: `✅ Bổ sung vào {primary.identifier}`
    - Nút 2..N: `✅ Bổ sung vào {alt.identifier}` (mỗi ticket đang mở khác một nút)
    - Nút cuối: `Sự cố mới` (`button.new_incident`)
- **Khi người báo bấm nút**:
  - Bấm nút của ticket nào → thực thi ghi bổ sung chính xác vào `issueId` và `identifier` của ticket đó!
  - Bấm `Sự cố mới` → mở tờ khai mới với nội dung tin nhắn.

### 7. Bảng ánh xạ kết quả `StepOutcome` ↔ Legacy `action` & Hợp đồng copy

Bảng ánh xạ chính thức tại `packages/core/src/intake/engine/action-map.ts`:

| `StepOutcome` của core | `action` của legacy | Ý nghĩa trong PR 10 |
|---|---|---|
| `already_created` | `already_created` | Cảm ơn / chitchat / confirm lại / hướng dẫn huỷ sau tạo |
| `action_preview` | `confirm_ticket_action` | Bản xem trước đề xuất bổ sung kèm nút xác nhận |
| `action_done` | `post_create_update` | Đã thực thi ghi comment bổ sung vào ticket thành công |
| `closed_refusal` | `post_create_update` | Từ chối bổ sung vào ticket đã ở Done/Canceled |
| `clarify` | `clarify_intent` | Người báo nhắn "ticket mới ạ" ngắn gọn, xin mô tả sự cố |
| `action_canceled` | `canceled` | Người báo huỷ bản xem trước ghi vào ticket |

Các `CopyKey` mới cần bổ sung vào `packages/core/src/intake/ports.ts` (CopyKey union) và `test-copy.fixture.ts`:
- `ticket.closed_refusal`: Câu từ chối khi ticket đã đóng.
- `ticket.chitchat_after_create`: Lời đáp khi người báo cảm ơn sau khi tạo ticket.
- `ticket.cancel_hint_after_create`: Lời hướng dẫn cú pháp huỷ sau khi tạo ticket.
- `ticket.already_created_hint`: Lời báo ticket đã được tạo, không cần confirm lại.
- `action.suggest_append_lead`: Lời dẫn đề xuất bổ sung thông thường (`Dạ tin này là bổ sung cho {identifier}`).
- `action.suggest_conflict_lead`: Lời dẫn đề xuất khi phát hiện định danh xung đột (`Dạ tin này có thông tin (SĐT/mã) khác với {identifier}`).
- `action.suggest_unclear_prompt`: Lời nhắc bấm nút khi người báo gõ tin nhắn việc khác.
- `action.suggest_unclear_prompt_with_media`: Lời nhắc bấm nút khi có gửi thêm ảnh.
- `button.confirm_append`: Nhãn nút xác nhận bổ sung (`✅ Bổ sung vào {identifier}`).
- `button.new_incident`: Nhãn nút mở sự cố mới (`Sự cố mới`).

---

## Phân định Legacy vs RFC 0002

| Tiêu chí | Bản tham chiếu Legacy (`apps/tieulinh-legacy`) | Thiết kế Core (`packages/core`) theo RFC 0002 | Lý do chọn |
|---|---|---|---|
| **Chuỗi giao diện** | Hardcode tiếng Việt trực tiếp trong `pipeline.ts` và `supplement-notifier.ts`. | 100% chuỗi đi qua `CopyCatalog` tra theo `CopyKey`. | **Chọn Core**: Thư viện dùng chung cho nhiều bot (Tiểu Linh, CM, IRIS), không hardcode tiếng Việt trong logic. |
| **Cổng Tracker & Mention** | Phụ thuộc trực tiếp vào `ItsaplanClient` cụ thể và các phương thức API Itsaplan. | Tách qua các hàm thuần domain (`resolveSupplementMentionTarget`, `formatSupplementComment`, `isIssueClosed`) và cổng trừu tượng (`TrackerPort`). | **Chọn Core**: Đảm bảo tính kiểm thử độc lập (testable), test không gọi mạng và mock được bằng fakes. |
| **Kiểm tra trạng thái đóng** | Gọi `itsaplan.getIssue()` và `itsaplan.listProjectColumns()`. | Đưa vào cổng tracker (ví dụ `TrackerPort.isClosed` hoặc `TrackerPort.getIssueState`). | **Chọn Core**: Đóng gói chi tiết tracker vào adapter, engine chỉ nhận trạng thái chuẩn (`open`, `resolved`, `done`, `canceled`). |
| **Hàng nút nhiều ticket (B8)** | Tạo động mảng callback data trực tiếp từ nhãn nút. | Trả mảng `buttons` trong `ChannelMessage` với `text` và `callbackData` khớp chính xác `confirmLabel`. | **Chọn Core**: Giữ nguyên tính nhất quán với cơ chế nút của engine core. |

---

## Non-goals (Không thuộc phạm vi PR 10)

Để đảm bảo ranh giới rõ ràng giữa các PR trong chuỗi RFC 0002:

1. **Lệnh nhắm vào ticket đã có (D1-D7, D9)**: Các cú pháp lệnh chủ động như `bổ sung TECH-X ...`, `sửa TECH-X ...`, tra cứu `lookupTicket` bằng mã hoặc tự do, chuyển ticket nhầm `move_created` thuộc **PR 11**.
2. **Huỷ và đóng ticket theo yêu cầu người báo (D8, ADR-0006 bản 10/10)**: Kiểm tra phân quyền chủ ticket `ownTicket`, đếm số comment chuyên viên `MIN_SPECIALIST_COMMENTS_FOR_DONE = 3` để quyết định chuyển `Canceled` hay `Done` thuộc **PR 12**.
3. **Soát thông tin kỹ thuật (F1-F4)**: `checklistReview`, `llmReview`, tự học `learned` thuộc **PR 13**.
4. **Định dạng ticket chi tiết và media nâng cao (J1)**: Thuộc **PR 14**.
5. **Kênh Telegram / OpenClaw adapter**: Giao thức kênh, webhook telegram giữ nguyên; không mở rộng phạm vi sang kênh.

---

## Constraints / Forbidden (Ràng buộc và điều cấm)

- Tuân thủ nghiêm ngặt `orchestration/WORKER-CONTRACT.md`.
- `apps/tieulinh-legacy/**` là bản tham chiếu **đóng băng**: chỉ đọc, tuyệt đối không sửa, không import code legacy vào `packages/core` hay app mới.
- Không dùng `any`, không dùng toán tử non-null (`!`) trong code mới viết.
- Không sửa `.github/workflows/**`, `scripts/**`, `biome.lint-baseline.json`, `package.json` gốc, `bun.lock`.
- **Core không hardcode tên sản phẩm, tên công ty hay tên hệ thống của một app**. Dữ liệu miền đi qua catalog và tham số.
- **Bất biến an toàn**:
  - Không ghi vào ticket đã có nếu chưa có một cú bấm khớp nhãn nút chính xác (ADR-0008).
  - Không tự động xác nhận thay người báo.
  - Không tự ý đóng hay huỷ ticket nếu người báo chưa xác nhận (ADR-0006).
  - Không ghi đè các trường định danh của ticket đã tạo.
  - Một lượt, một khoá chat (`withChatLock`).

---

## Ownership (Phần được phép sửa)

Worker thực hiện PR 10 được phép sửa và tạo các file sau:

- `packages/core/src/intake/**`:
  - `packages/core/src/intake/engine/engine.ts`
  - `packages/core/src/intake/engine/types.ts`
  - `packages/core/src/intake/engine/text.ts`
  - `packages/core/src/intake/draft/types.ts`
  - `packages/core/src/intake/create/binding-store.ts`
  - `packages/core/src/intake/create/binding-store.test.ts`
  - `packages/core/src/intake/ports.ts`
  - `packages/core/src/intake/adapter.ts`
  - `packages/core/src/intake/notify/**` (hoặc `packages/core/src/intake/supplement/**`)
  - `packages/core/src/intake/engine/test-copy.fixture.ts`
  - `packages/core/src/intake/engine/engine-harness.fixture.ts`
  - `packages/core/src/intake/engine/pr10-post-create.test.ts` (test suite mới port các ca flow & notify)
  - `packages/core/src/intake/notify/supplement-notifier.test.ts` (test suite mới port các ca thuần)
- `packages/core/CHANGELOG.md`
- `packages/core/docs/parity/ENGINE.md`
- `apps/tieulinh/receptionist-gap-register.test.ts` (chuyển 37 dòng PR 10 từ `deferred` sang `ported`)
- `docs/rfc/0002-receptionist.md` (chỉ sửa bảng khoảng trống mục 1.5 các dòng C1-C4, G2, B8)
- `docs/reference/intake-engine.md` (cập nhật tài liệu tham chiếu nếu cần)
- `orchestration/report-24.md` (báo cáo của worker triển khai)

---

## Danh sách test legacy phải port

PR 10 có đúng **37 ca test legacy** đã được định danh và theo dõi trong sổ đối chiếu (`apps/tieulinh/receptionist-gap-register.test.ts` và `ENGINE.md`):

### 1. `apps/tieulinh-legacy/lib/intake-step/pipeline.flow.test.ts` (12 ca flow)

1. `ticket đã tạo, xin khẩn cấp kèm lý do → nâng mức trên ticket + comment lý do` (G2, C4)
2. `'cảm ơn em' sau khi tạo không đụng tới ticket` (C1)
3. `thông tin bổ sung sau khi tạo → comment, KHÔNG ghi đè mô tả` (C1, C4)
4. `tin có ảnh, không xung đột định danh → hỏi, chưa ghi gì` (C2, ADR-0008)
5. `chỉ gửi ảnh → cũng hỏi, không ghi` (C2, ADR-0008)
6. `hỏi rồi người báo GÕ "ticket mới ạ" → sự cố mới từ tin đang chờ, ticket cũ không bị đụng` (C2)
7. `vừa tạo xong, người báo chỉ nhắn "ticket mới ạ" → mở tài liệu mới xin mô tả, không ghi gì` (C2)
8. `hiểu ý chọn ticket cũ, mỗi ticket đang mở có nút riêng; bấm nút ticket cũ mới ghi vào ticket cũ` (B8)
9. `không rõ ticket nào → gợi ý ticket vừa tạo, nhưng ticket cũ vẫn có nút để chọn đúng` (B8)
10. `sự cố mới sau khi tạo → tài liệu mới, không ghi vào ticket cũ` (C1, C2)
11. `ticket đã tạo + tin có mã khác → hỏi sự cố mới hay bổ sung, không tự ghi bổ sung` (C3)
12. `ticket đã tạo + tin có mã khác + chọn "Bổ sung" → ghi bổ sung vào ticket đó` (C3)

### 2. `apps/tieulinh-legacy/lib/intake-step/pipeline.notify-supplement.test.ts` (6 ca luồng notify)

13. `khi ticket đang xử lý có assignee (u-techlead-a) → comment bổ sung mention @techlead_a`
14. `khi ticket không có assignee nhưng timeline có trao đổi của KTV (TechUser_B) → mention @techuser_b`
15. `khi ticket không có assignee và timeline chỉ có bot/hệ thống → none (không cc ai)`
16. `ticket đã ở Done (cột 4) → từ chối bổ sung, không addComment, hướng dẫn tạo ticket mới`
17. `ticket đã ở Canceled (cột 5) → từ chối bổ sung, không addComment, hướng dẫn tạo ticket mới`
18. `người dùng gõ lệnh bổ sung chỉ định ticket đã đóng (bổ sung TECHTEST-104) → từ chối ngay lập tức`

### 3. `apps/tieulinh-legacy/lib/itsaplan/supplement-notifier.test.ts` (19 ca hàm thuần)

- **`isIssueClosed` (5 ca)**:
  19. `cột In Progress / Backlog → false (đang mở)`
  20. `cột Resolved ('Đã xử lý') → false (vẫn mở để người báo nghiệm thu)`
  21. `cột Done / Hoàn tất → true (đã đóng)`
  22. `cột Canceled / Đã hủy → true (đã đóng)`
  23. `không có danh sách cột: dựa vào stateType của issue`
- **`closedTicketRefusalMessage` (1 ca)**:
  24. `chứa mã ticket, 'đã đóng', và hướng dẫn 'tạo ticket mới'`
- **`resolveSupplementMentionTarget` (6 ca)**:
  25. `in-progress có assignee → mention assignee`
  26. `assignee có tiền tố @ → tự động gỡ @ khỏi username`
  27. `no assignee → mention last technician commenter từ timeline`
  28. `no assignee + timeline có technician với actorUsername hợp lệ nhưng chưa trong assignees → dùng actorUsername`
  29. `no assignee + không có bình luận kỹ thuật viên nào (chỉ có bot) → none (null)`
  30. `no assignee + timeline rỗng → none (null)`
- **`formatSupplementComment` (5 ca)**:
  31. `định dạng user_update kèm mention`
  32. `định dạng user_update khi mention đã có tiền tố @ vẫn chuẩn hoá thành đúng (cc @username)`
  33. `định dạng user_update không kèm mention (none)`
  34. `định dạng who_supplement kèm mention`
  35. `định dạng who_supplement không kèm mention`
- **`notifyOnCallSupplement` (2 ca)**:
  36. `khi NOTIFY_ON_CALL_SUPPLEMENT=1: gọi broadcastAlert tới kênh trực ca`
  37. `khi NOTIFY_ON_CALL_SUPPLEMENT không bật: không gửi cảnh báo`

---

## Observable Acceptance Criteria (Tiêu chí chấp nhận)

1. **Bộ test core**:
   - `bun run --cwd packages/core test` chạy xanh 100%, không có test nào bị skip hay fail.
   - Các file test mới (`pr10-post-create.test.ts`, `supplement-notifier.test.ts`) kiểm chứng đầy đủ 37 ca test trên.
2. **Sổ đối chiếu và Parity**:
   - Chạy `bun test apps/tieulinh/receptionist-gap-register.test.ts` đạt kết quả xanh:
     - Số dòng `ported` tăng từ **109** lên **146** (+37).
     - Số dòng `deferred` giảm từ **269** xuống **232** (-37).
   - `packages/core/docs/parity/ENGINE.md` cập nhật hàng PR 10: `| 10 | 0 | Đã port ở PR 10 (tin sau khi tạo ticket) |`.
3. **Chất lượng toàn diện**:
   - `bun run verify` EXIT=0 (lint, check, test, scan, docs kiểm tra đều sạch).
   - `bun run docs:check` EXIT=0.
4. **Nhật ký thay đổi**:
   - `packages/core/CHANGELOG.md` ghi rõ mục cho PR 10: thêm cơ chế xử lý tin sau tạo, từ chối ticket đóng, mention resolver, nâng mức G2, nút theo từng ticket đang mở B8.

---

## Rủi ro kỹ thuật & Giải pháp

1. **Rủi ro rớt media khi người báo gửi ảnh dồn dập trong lúc chờ nút**:
   - *Giải pháp*: `pendingTicketAction` phải lưu mảng `mediaPaths: string[]`. Khi nhận tin ảnh mới trong lúc đang chờ, gộp mảng `mediaPaths` bằng `Set` và cập nhật lại bản nháp, đảm bảo khi bấm "Bổ sung" hay "Sự cố mới" đều giữ trọn vẹn toàn bộ ảnh.
2. **Rủi ro vòng lặp bot tự đọc comment của chính mình khi bổ sung**:
   - *Giải pháp*: Mọi comment bổ sung qua `formatSupplementComment` bắt buộc được bọc qua `markBotComment` (chứa `<!-- intake-bot -->`), đồng thời `resolveSupplementMentionTarget` luôn bỏ qua các comment có dấu bot comment hoặc `actorKind === "agent"`.
3. **Rủi ro lệch trạng thái cột giữa các dự án (TECH vs OP/CM)**:
   - *Giải pháp*: Tái sử dụng `classifyColumn` và `ProjectColumnStates` từ `@vuihoc/bot-core/itsaplan` để phân loại theo tên cột chuẩn hoá (nhận diện "Resolved" / "Đã xử lý" là mở, "Done" / "Hoàn tất" là đóng), tránh nhầm lẫn giữa Resolved và Done.
