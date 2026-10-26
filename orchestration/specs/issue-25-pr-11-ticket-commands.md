# Đặc tả: PR 11 của RFC 0002 — lệnh nhắm vào ticket đã có (issue #25)

## Context

Repo: `minhdevtry/ticket`. Đây là PR 11 của chuỗi di trú lễ tân (`docs/rfc/0002-receptionist.md` mục 5), issue #25.
PR 1-10 đã hoàn thành và merge vào `main` (mới nhất là PR 10: xử lý tin sau khi tạo ticket, PR #56, commit `2c24fd6`).

Mục tiêu của PR 11 là xây dựng toàn bộ cơ chế **tiếp nhận và thực thi lệnh nhắm vào ticket đã có** trong luồng chat một người (ADR-0008, quyết định 1-7), gồm các yêu cầu nghiệp vụ:
- **D1**: Tìm ứng viên liên quan: mã nêu trực tiếp trong tin (`TECH-795`, `TECH_795`, `ticket 795`, `#795`), số trần (`989`) chỉ tính khi khớp đúng một ticket của chính người báo, ticket vừa tạo ở chat (cửa sổ 24 giờ), ticket kỹ thuật vừa hỏi (route tin nhắn trong 72 giờ, bỏ qua khi người báo đang soạn dở tờ khai khác).
- **D2**: Đọc lệnh (`append`, `edit`, `lookup`, `move_created`, `cancel_or_close`, `new`, `unclear`) bằng LLM, có đường tất định không LLM; các từ "huỷ", "cảm ơn", "ok" độc lập không bao giờ là nội dung ghi vào ticket; bóc vỏ câu lệnh bổ sung/đính kèm (`stripSupplementCommandWrapper`, TECH-1218).
- **D3**: Tra cứu (`lookup`): ticket của mình thấy đầy đủ (tiêu đề, trạng thái, người xử lý, trao đổi kỹ thuật gần nhất); ticket người khác chỉ thấy trạng thái, che giấu tiêu đề và nội dung trao đổi (ADR-0008 §6).
- **D4**: Bản xem trước + nút xác nhận cho mọi thao tác ghi (`append`, `suggest`, `edit`, `move`); nút "Huỷ" (`button.cancel_action`); xử lý ma trận phản hồi khi đang chờ (bảo toàn ảnh đính kèm, câu lệnh trần chưa có nội dung thì hỏi nội dung qua `clarify`, nhắn việc khác thì bỏ bản xem trước).
- **D5**: Sửa ticket (`edit`): bộ lập kế hoạch sửa (`planEdit`), áp thao tác tất định (`applyEditOps`), xem trước thay đổi cũ → mới; khi bấm xác nhận phải kiểm lại nền (`optimistic concurrency check`: ticket đổi trong lúc chờ thì từ chối), sau đó mới sửa trên tracker và ghi comment dấu vết `✏️`.
- **D6**: Chuyển ticket bot vừa tạo nhầm sang ticket khác (`move_created`: "cái này bổ sung cho TECH-Y"): chép nội dung (`descriptionBody`), nối liên kết trùng `duplicates` trên tracker, huỷ bản nhầm (`Canceled`), đóng tờ khai.
- **D7**: Quyền sở hữu (`ownTicket`): căn cứ theo binding cùng chat (kể cả ticket bot cũ) hoặc mô tả chứa ID Telegram của người đó; từ chối mọi thao tác ghi nếu không phải chủ ticket; người khác (chat khác) không thể bấm hộ nút xác nhận.
- **D9**: Tra cứu tiến độ không nêu mã: ticket gần nhất của chính chat, chỉ tính trong cửa sổ 30 phút (`LOOKUP_WINDOW_MS = 30 * 60_000`).

**Bất biến an toàn cốt lõi**:
- **ADR-0008**: Không bao giờ tự ý ghi vào ticket đã có (bổ sung comment, sửa, nâng mức, chuyển/huỷ) nếu chưa có bản xem trước và cú bấm nút khớp nhãn chính xác từ chính người báo. Không ai bấm hộ được.
- **ADR-0006**: Bot không bao giờ tự đóng ticket. (Riêng `move_created` huỷ bản rác do chính bot tạo nhầm theo ADR-0008 §7 là ngoại lệ được phép vì không đóng việc thật của chuyên viên).
- **ADR-0010**: Mô tả ticket là nguyên văn lời người báo; bổ sung chỉ thêm comment, sửa qua kiểm nền và comment dấu vết.

**Tài liệu đọc trước (bắt buộc)**:
- `orchestration/WORKER-CONTRACT.md` — hợp đồng chung cho mọi worker Orca.
- `AGENTS.md` và `CODING_STANDARDS.md`.
- `packages/core/GLOSSARY.md` — thuật ngữ chuẩn (`draft`, `binding`, `tracker`, `CopyCatalog`, `port`).
- `docs/rfc/0002-receptionist.md` mục 1.4 (dòng D1-D7, D9), mục 2.1-2.4, mục 5 (hàng PR 11).
- `apps/tieulinh-legacy/docs/adr/0008-mot-luong-chat-ghi-vao-ticket-phai-xac-nhan.md`.
- `apps/tieulinh-legacy/docs/adr/0006-chi-nguoi-xu-ly-dong-ticket.md`.

---

## Target

Các thành phần và module trong `packages/core` cần triển khai:

1. **`packages/core/src/intake/engine/engine.ts`**:
   - Mở rộng `buildCandidates`:
     - Nhận diện mã ticket nêu trực tiếp (`mentionedIdentifiers`).
     - Nhận diện số trần (`/(?<!\d)(\d{3,5})(?!\d)/g`): chỉ coi là ứng viên nếu số đó khớp với `identifier` trong binding thuộc chat của chính người báo (`listBindingsForChat`).
     - Nhận diện ticket vừa tạo (`justCreated`): `draft?.status === "created"` trong cửa sổ 24 giờ (`JUST_CREATED_WINDOW_MS = 24 * 3_600_000`).
     - Nhận diện ticket kỹ thuật vừa hỏi (`recentlyRelayed`, `techQuestion`): tra cứu message route mới nhất của chat qua `MessageRouteStore` hoặc `ChannelBindingStore` trong 72 giờ (`TECH_QUESTION_WINDOW_MS = 72 * 3_600_000`); điều kiện: route mới hơn hoạt động gần nhất của draft, không có draft đang mở có mô tả (`!draftOpen`), và ticket còn mở (`ticketIsOpen`). Lấy comment kỹ thuật gần nhất bằng `lastTechComment`.
     - Giới hạn trần danh sách ứng viên tối đa 4 (`candidates.slice(0, 4)`).
   - Nâng cấp `routeExistingTicket`:
     - Lọc sớm tin vô nghĩa / không phải lệnh: nếu tin nhắn không nhắc mã ticket và là `isCancelLike`, `isChitchat`, hoặc `isDeclineAnswer` thì trả về `null` (để luồng tiếp nhận bình thường xử lý).
     - Tra cứu tiến độ không nêu mã (D9): nếu tin là câu hỏi tiến độ/tình trạng không nhắc mã ticket, kiểm tra ticket gần nhất của chat (`deps.bindings.getLatestBinding(chatId)`). Nếu trong vòng 30 phút (`LOOKUP_WINDOW_MS = 30 * 60_000`), tự động chuyển sang `lookup` cho ticket đó.
     - Đọc lệnh có LLM (`deps.commands.interpret`) và không có LLM (deterministic fallback):
       - Fallback không LLM: nếu có nhắc mã ticket ứng viên, dùng `stripSupplementCommandWrapper` để bóc vỏ lệnh; nếu là lệnh hủy/đóng thì trả về `cancel_or_close` (hướng dẫn cú pháp hoặc chuyển giao PR 12); nếu không thì là `append`.
     - Xử lý câu lệnh trần chưa có nội dung (TECH-1218): nếu là lệnh `append` nhưng `content` rỗng và không có media (ví dụ "update vào tick TECH-1218"): lưu `pendingTicketAction` với `content = ""`, trả về outcome `clarify` (legacy `clarify_intent`), đính kèm nút "Huỷ", yêu cầu người báo gửi nội dung hoặc ảnh.
     - Kiểm tra trạng thái đóng (`checkIssueClosed` / W29-NOTIFY): nếu ticket đích đã ở `Done` / `Canceled`, từ chối bổ sung bằng outcome `closed_refusal`.
     - Kiểm tra quyền sở hữu (D7):
       - Nếu không phải chủ ticket (`!this.isOwn(target, chatId)`):
         - Nếu là lệnh ghi (`append`, `edit`, `move`): từ chối thẳng bằng outcome `not_owner` (legacy `post_create_update`), không hiển thị preview, không cho ghi.
         - Nếu là lệnh tra cứu (`lookup`): chuyển tiếp sang `lookup` với quyền hạn hạn chế.
     - Điều phối tới các hành động: `lookup`, `previewAction`.
   - Nâng cấp `lookup`:
     - Gọi `deps.tracker` đọc trạng thái cột của ticket.
     - Nếu `ownTicket === true`: lấy `lastTechComment`, trả về outcome `lookup` kèm tiêu đề, tên cột trạng thái và trao đổi gần nhất của kỹ thuật viên.
     - Nếu `ownTicket === false`: trả về outcome `not_owner` hoặc `lookup` (legacy `lookup_result`) CHỈ chứa tên cột trạng thái, tuyệt đối không tiết lộ tiêu đề và trao đổi kỹ thuật.
   - Nâng cấp `previewAction`:
     - Hỗ trợ các kind: `append`, `edit`, `move`.
     - Tạo `pendingTicketAction` đầy đủ thông tin:
       - `edit`: lưu thêm `edit: { baseTitle, baseDescription, title, description, changes }`.
       - `move`: lưu thêm `from: { identifier, issueId }`.
     - Tạo hàng nút: Nút xác nhận (`✅ Bổ sung vào TECH-X` / `✅ Sửa TECH-X` / `✅ Chuyển sang TECH-X`) + Nút `Huỷ` (`button.cancel_action`).
     - Trả về outcome `action_preview`.
   - Nâng cấp `resolvePendingAction`:
     - Xử lý ma trận 8 trạng thái khi người báo phản hồi bản xem trước.
     - Khớp nhãn nút chính xác (`foldButton`).
     - Bảo toàn ảnh và tin nhắn khi đang chờ (TECH-1218).
     - Bỏ bản xem trước khi nhắn việc khác, bảo toàn payload nếu tin mới là lệnh bổ sung.
   - Nâng cấp `executeConfirmedTicketAction`:
     - Thực thi `edit`: kiểm tra xung đột nền (`optimistic concurrency check`), cập nhật ticket, ghi comment dấu vết `✏️`.
     - Thực thi `move`: chuyển nội dung, link `duplicates`, huỷ ticket nguồn, đóng tờ khai nguồn.
     - Thực thi `append`: ghi comment, tải media, mention kỹ thuật viên (đã có từ PR 10).
2. **`packages/core/src/intake/engine/text.ts`**:
   - Thêm `stripSupplementCommandWrapper(text: string): { isSupplementCommand: boolean; content: string }`: bóc các tiền tố lệnh bổ sung đa dạng trong tiếng Việt ("update vào tick TECH-1218", "bổ sung TECH-1218: ...", "đính ảnh vào TECH-1218"), tách riêng mã ticket và phần nội dung thực tế cần ghi.
3. **`packages/core/src/intake/engine/edit.ts` (module mới)**:
   - Định nghĩa kiểu: `EditOp` union (`title`, `field`, `replace`), `EditChange`, `EditAppliedResult`.
   - Hàm thuần `applyEditOps(title: string, description: string, ops: EditOp[])`:
     - Sửa tiêu đề `title`.
     - Sửa/thêm trường `field` ở mục "## Thông tin sự cố".
     - Thay thế chuỗi nguyên văn duy nhất `replace` trong mô tả.
     - Loại bỏ và ghi nhận các thao tác không hợp lệ vào `rejected`.
   - Hàm thuần `descriptionBody(description: string): { body: string; images: string[] }`: tách phần mô tả chính và danh sách URL ảnh markdown để phục vụ `move_created`.
   - Hàm `planEdit(llm, input, completeFn)`: gọi LLM với prompt chuẩn để sinh ra danh sách `EditOp` tối thiểu dựa trên tiêu đề, mô tả hiện tại và chỉ dẫn sửa của người báo.
4. **`packages/core/src/intake/ports.ts`**:
   - Mở rộng `ReplyCandidate`:
     - Thêm `techQuestion?: string` (câu hỏi kỹ thuật vừa hỏi).
     - Thêm `recentlyRelayed?: boolean` (bot vừa chuyển tin của kỹ thuật).
   - Mở rộng `TicketCommand`:
     - Hỗ trợ action `cancel_or_close?: { identifier: string; content: string; intent?: "cancel" | "close" }` (tương thích interface router; thực thi chuyển sang PR 12).
   - Mở rộng `OwnershipPort`:
     - Nhận diện sở hữu bằng binding chat VÀ bằng quy ước Telegram ID trong mô tả ticket.
     - Hàm cài đặt mặc định `createOwnershipPort(bindings, options)` hỗ trợ cả 2 cơ chế.
   - Mở rộng `MessageRouteStore` / `ChannelBindingStore`:
     - Hỗ trợ tra cứu message route theo chat và thời gian: `getLatestMessageRouteForChat(channelType, chatIds, sinceTimestamp)`.
   - Mở rộng `TrackerPort`:
     - Bổ sung `linkIssues(fromIssueId: number, toIssueId: number, linkType: "duplicates")`.
     - Bổ sung `getIssueTimeline(issueId: number)`.
   - Mở rộng `CopyKey` union trong `ports.ts` cho các thông báo và nút bấm của PR 11.
5. **Sổ đối chiếu và tài liệu**:
   - Cập nhật `apps/tieulinh/receptionist-gap-register.test.ts`: chuyển đủ **28 dòng legacy** của PR 11 sang `ported`.
   - Cập nhật `packages/core/docs/parity/ENGINE.md`: cập nhật bảng trạng thái parity cho PR 11.
   - Cập nhật `packages/core/CHANGELOG.md`.
   - Cập nhật `docs/rfc/0002-receptionist.md` (mục 1.4 các dòng D1-D7, D9 và mục 5 hàng PR 11).

---

## Change chi tiết

### 1. D1 — Tìm ứng viên: Mã nêu trong tin, Số trần, Ticket vừa tạo (24h), Ticket kỹ thuật vừa hỏi (72h)

- **Nguyên tắc**: Xác định chính xác tập hợp các ticket liên quan đến người báo để bộ đọc lệnh (hoặc luật tất định) phân giải ý định mà không đoán bừa sang ticket của người khác.
- **Bốn nguồn ứng viên (`ReplyCandidate`)**:
  1. *Mã nêu trực tiếp trong tin*:
     - Sử dụng `mentionedIdentifiers(text, projectKey)` (đã có ở `engine/text.ts`): nhận diện `TECH-795`, `TECH_795`, `TECH 795`, `ticket 795`, `tk 795`, `#795`.
  2. *Số trần (Bare numbers — TECH-1001, TECH-509)*:
     - Biểu thức: `/(?<!\d)(\d{3,5})(?!\d)/g` (ví dụ "đấy là 989 không phải 1001").
     - **Ràng buộc an toàn**: Số trần CHỈ được coi là ứng viên nếu số đó khớp với mã một ticket **CỦA CHÍNH NGƯỜI BÁO** (`ownBindings.some(b => b.identifier.toUpperCase() === id)`). Không bao giờ nhận số trần của ticket người khác để tránh nhầm số phòng, mã đơn hàng, SĐT.
  3. *Ticket vừa tạo trong chat (`justCreated`)*:
     - Điều kiện: Tờ khai hiện tại ở trạng thái `draft.status === "created"`, có `issueId` và `issueIdentifier`.
     - Cửa sổ thời gian: `JUST_CREATED_WINDOW_MS = 24 * 3_600_000` (24 giờ).
     - Mục đích: Làm ứng viên nguồn (`from`) khi người báo nói "cái này bổ sung cho TECH-Y" để chuyển sang Y. Đánh dấu `justCreated = true`, `ownTicket = true`.
  4. *Ticket kỹ thuật vừa hỏi qua message route (`recentlyRelayed` & `techQuestion`)*:
     - Tra cứu `MessageRouteStore` hoặc `ChannelBindingStore` tìm route gửi tin gần nhất tới chat:
       `getLatestMessageRouteForChat("telegram", chatIds, now - TECH_QUESTION_WINDOW_MS)`.
     - Cửa sổ thời gian: `TECH_QUESTION_WINDOW_MS = 72 * 3_600_000` (72 giờ).
     - **Điều kiện loại trừ**:
       - Bỏ qua nếu route cũ hơn hoạt động gần nhất của draft (`routeAt <= lastActivity`).
       - Bỏ qua nếu người báo đang soạn dở một tờ khai khác có mô tả (`draftOpen = Boolean(draft && !CLOSED_STATUSES.has(draft.status) && hasDescription(draft))`). Khi đang soạn dở, câu trả lời thuộc tờ khai dở, không bị kéo sang ticket cũ!
       - Bỏ qua nếu ticket đó đã đóng trên tracker (`ticketIsOpen === false`).
     - Lấy câu hỏi kỹ thuật vừa hỏi: `lastTechComment(route.issueId)`. Đánh dấu `recentlyRelayed = true`, `techQuestion = ...`.
- **Số lượng ứng viên tối đa**: Cắt trần danh sách `candidates.slice(0, 4)`. Nếu không có ứng viên nào (`candidates.length === 0`), `routeExistingTicket` trả về `null` để tiếp tục luồng tiếp nhận thông thường.

### 2. D2 — Đọc lệnh bằng LLM & Đường không LLM; Bóc vỏ câu lệnh bổ sung trần (TECH-1218)

- **Lọc trước lệnh (Pre-filter)**:
  - Nếu tin nhắn KHÔNG nhắc mã ticket, và rơi vào các trường hợp sau:
    - Lời cảm ơn / chitchat: `isChitchat(text)`
    - Từ chối trả lời: `isDeclineAnswer(text)` ("không biết", "chưa có")
    - Huỷ chung chung: `isExplicitCancel(text)`
    - Nút điều hướng: "Sự cố mới", "Tiếp tục soạn"
    → Trả về `null` ngay lập tức để luồng hội thoại chính xử lý, không coi là nội dung ghi vào ticket cũ.
- **Hai đường đọc lệnh**:
  - *Đường có LLM (`deps.commands.interpret`)*:
    - Truyền vào `TicketCommandInput`: `message`, `attachments`, `candidates`, `draftTitle`.
    - LLM trả về một trong các action: `append`, `edit`, `lookup`, `move_created`, `cancel_or_close`, `new`, `unclear`.
    - Chuẩn hoá an toàn: `action === "new"` → trả `null` để mở/tiếp tục tờ khai; `action === "unclear"` → xử lý theo ma trận tín hiệu mạnh (mã ticket chính mình nhắc ưu tiên hơn ticket vừa chuyển tiếp).
  - *Đường KHÔNG LLM (Deterministic fallback khi `deps.commands` không cấu hình hoặc LLM lỗi/timeout)*:
    - Nhận diện ứng viên có nhắc mã trong câu: ưu tiên ticket của mình (`mentioned && ownTicket`), fallback ticket bất kỳ được nhắc (`mentioned`).
    - Nếu câu chứa ý định huỷ/đóng rõ ràng (`classifyCancelOrCloseIntent(text)`): trả về `cancel_or_close`.
    - Nếu không: coi là `append`, bóc tách nội dung qua `stripSupplementCommandWrapper(message)`.
- **Bóc vỏ câu lệnh bổ sung / đính kèm (`stripSupplementCommandWrapper`, TECH-1218)**:
  - Hàm thuần: `stripSupplementCommandWrapper(text: string): { isSupplementCommand: boolean; content: string }`.
  - Nhận diện các tiền tố phổ biến:
    - "update vào tick TECH-1218", "bổ sung TECH-1218: ...", "cập nhật vào ticket TECH-1218", "gửi thêm ảnh vào TECH-1218", "đính kèm vào TECH-1218".
    - Mẫu mã ticket đứng trước: "TECH-1218 bổ sung ...", "ticket TECH-1218 update ...".
  - **Xử lý câu lệnh trần (không có nội dung chữ và không có ảnh)**:
    - Nếu người báo chỉ gõ câu lệnh trần ("update vào tick TECH-1218") mà chưa gửi nội dung (ảnh đã gửi ở tin trước hoặc chuẩn bị gửi ở tin sau):
    - `content` trả về `""`.
    - Engine KHÔNG ghi nhầm chính câu lệnh ("update vào tick TECH-1218") thành comment!
    - Tạo `pendingTicketAction` với `kind: "append"`, `content: ""`.
    - Trả về outcome `clarify` (legacy `clarify_intent`), đính kèm nút "Huỷ" (`button.cancel_action`), hướng dẫn người báo gửi ảnh chụp màn hình hoặc nội dung cần bổ sung.

### 3. D3 — Tra cứu ticket: Phân quyền hiển thị (Ticket của mình vs Ticket người khác)

- **Nguyên tắc bảo mật thông tin (ADR-0008 §6)**:
  - Người báo có thể tra cứu tình trạng của bất kỳ ticket nào có mã hợp lệ, nhưng quyền hạn đọc thông tin phụ thuộc vào quyền sở hữu (`ownTicket`).
- **Xử lý theo quyền sở hữu**:
  - *Ticket của chính người báo (`ownTicket === true`)*:
    - Gọi tracker đọc trạng thái cột (`column.name`).
    - Tra cứu bình luận gần nhất của kỹ thuật viên thật trên timeline (`lastTechComment(issueId)`, loại bỏ bot và hệ thống).
    - Phản hồi: outcome `lookup` (legacy `lookup_result`), hiển thị:
      `Dạ {identifier} «{title}» đang ở trạng thái: {status} ạ.\nTrao đổi gần nhất của kỹ thuật: "{lastTechComment}"` (cắt trần 300 ký tự, bỏ mention/markdown thừa).
  - *Ticket của người khác (`ownTicket === false`)*:
    - Gọi tracker đọc trạng thái cột.
    - **CHỈ hiển thị trạng thái, TUYỆT ĐỐI KHÔNG hiển thị tiêu đề và KHÔNG hiển thị trao đổi kỹ thuật**:
      `Dạ {identifier} đang ở trạng thái: {status} ạ.` (outcome: `not_owner` hoặc `lookup` chế độ ẩn danh).

### 4. D4 — Bản xem trước + Nút xác nhận & Ma trận xử lý khi đang chờ (ADR-0008)

- **Nguyên tắc ADR-0008**: Mọi lần ghi vào ticket đã có (`append`, `suggest`, `edit`, `move`) PHẢI qua bản xem trước và cú bấm nút xác nhận khớp nhãn chính xác từ người báo. Không bấm thì không ghi.
- **Các loại bản xem trước (`previewAction`)**:
  - `append`: Trích đoạn nội dung (`> {quoted}` cắt trần 500 ký tự), báo số lượng tệp đính kèm (`(kèm N ảnh/tệp)`). Nút: `[✅ Bổ sung vào {identifier}]`, `[Huỷ]`.
  - `suggest`: Câu dẫn dắt gợi ý (`Dạ đây là thông tin trả lời cho {identifier}...`). Nút: `[✅ Bổ sung vào {identifier}]`, (các alternatives nếu có), `[Sự cố mới]`.
  - `edit`: Liệt kê các thay đổi dự kiến (`- {what}: {before} → {after}`). Nút: `[✅ Sửa {identifier}]`, `[Huỷ]`.
  - `move`: Thông báo chuyển nội dung và huỷ bản trùng. Nút: `[✅ Chuyển sang {identifier}]`, `[Huỷ]`.
- **Ma trận 8 trạng thái khi người báo phản hồi bản xem trước (`resolvePendingAction`)**:
  1. *Bấm đúng nút xác nhận của ticket chính* (`foldButton(text) === foldButton(pending.confirmLabel)`):
     - Gọi `executeConfirmedTicketAction` để thực thi ghi vào tracker.
  2. *Bấm nút của ticket thay thế (`alternatives` — B8)*:
     - Gọi `executeConfirmedTicketAction` cho ticket thay thế tương ứng.
  3. *Bấm nút "Sự cố mới" hoặc gõ câu mang ý `saysNewIncident` (khi pending là `suggest`)*:
     - Xoá `pendingTicketAction`. Mở tờ khai mới (hoặc dùng tờ khai đang dở).
     - Nối nội dung đã gác ở pending bằng `withTypedDetail(pending.message, text)`.
     - Gộp toàn bộ ảnh đính kèm: `Array.from(new Set([...pending.mediaPaths, ...mediaPaths]))`.
     - Gọi `collect` tiếp nhận sự cố mới ngay.
  4. *Bấm nút "Huỷ" (`button.cancel_action`) hoặc gõ câu từ bỏ (`isCancelLike`)*:
     - Xoá `pendingTicketAction`, không ghi bất kỳ điều gì vào ticket.
     - Trả lời xác nhận huỷ qua outcome `action_canceled` (legacy `canceled`): `Dạ vâng, em không ghi gì vào {identifier} ạ.`
  5. *Đang ở `append` mà lượt trước là câu lệnh trần (chưa có nội dung/ảnh) HOẶC gửi thêm ảnh đính kèm*:
     - Gộp nội dung gõ thêm và gộp ảnh mới vào `pendingTicketAction`.
     - Cập nhật bản xem trước với số lượng ảnh mới, tiếp tục chờ xác nhận.
  6. *Đang ở `suggest` mà gửi thêm ảnh đính kèm*:
     - Gộp ảnh mới vào `pendingTicketAction.mediaPaths`.
     - Nhắc lại yêu cầu bấm nút kèm số lượng ảnh đã nhận (`action.suggest_unclear_prompt_with_media`), giữ nguyên pending.
  7. *Đang ở `suggest` mà gõ tin nhắn việc khác (không kèm ảnh, không bấm nút)*:
     - Nhắc lại yêu cầu bấm nút để ghi đúng chỗ (`action.suggest_unclear_prompt`), giữ nguyên pending để chống mất dữ liệu/ảnh.
  8. *Đang ở `append` / `edit` / `move` mà nhắn việc khác hoàn toàn*:
     - Bỏ bản xem trước (xoá pending, không ghi).
     - **Bảo toàn payload**: Nếu bản xem trước vừa bỏ đang giữ ảnh hoặc nội dung, và tin nhắn mới là một lệnh bổ sung có nhắc mã ticket (vd người báo gửi ảnh trước rồi mới gõ "update vào tick TECH-1218"): bảo toàn danh sách ảnh và nội dung này sang lượt xử lý tiếp theo (`this.step(...)`).

### 5. D5 — Sửa ticket: Bộ lập thao tác, Áp thử tất định & Kiểm nền chống xung đột (Optimistic Concurrency Check)

- **Quy trình 3 giai đoạn**:
  1. *Lập kế hoạch sửa (`planEdit`)*:
     - Gọi cổng `EditPlannerPort` (hoặc prompt LLM) với `title`, `description` hiện tại và `instruction` của người báo.
     - Sinh danh sách thao tác `EditOp[]` tối thiểu:
       - `{ type: "title", value: "<tiêu đề mới>" }`
       - `{ type: "field", label: "<nhãn trường>", value: "<giá trị mới>" }` (ở mục "## Thông tin sự cố")
       - `{ type: "replace", old: "<đoạn cũ>", new: "<đoạn mới>" }` (thay đoạn nguyên văn duy nhất trong mô tả)
  2. *Áp thử tất định (`applyEditOps`)*:
     - Thực thi áp các `EditOp` trên `title` và `description` hiện tại.
     - Ghi nhận danh sách thay đổi `changes: EditChange[]` (`what`, `before`, `after`) và danh sách bị từ chối `rejected: EditOp[]`.
     - Nếu `changes.length === 0`: không hiểu cần sửa gì, trả về hướng dẫn ví dụ `sửa TECH-X SĐT thành 09xxxxxxxx`.
     - Lưu thông tin nền vào `pendingTicketAction.edit`:
       - `baseTitle`: tiêu đề tại thời điểm lập bản sửa.
       - `baseDescription`: mô tả tại thời điểm lập bản sửa.
       - `title`: tiêu đề mới sau khi sửa.
       - `description`: mô tả mới sau khi sửa.
       - `changes`: danh sách thay đổi.
     - Hiển thị bản xem trước cho người báo kèm nút `[✅ Sửa {identifier}]` và `[Huỷ]`.
  3. *Kiểm nền khi xác nhận (Optimistic Concurrency Check)*:
     - Khi người báo bấm xác nhận `[✅ Sửa {identifier}]`:
     - Engine đọc lại trạng thái mới nhất từ tracker: `current = tracker.getIssue(issueId)`.
     - **So sánh với bản nền**:
       `if (current.description !== pending.edit.baseDescription || current.title !== pending.edit.baseTitle)`
     - Nếu phát hiện ticket đã bị chuyên viên hoặc người khác cập nhật trong lúc chờ bấm nút:
       - **Từ chối sửa, không ghi đè**: `Dạ {id} vừa được cập nhật sau khi em lập bản sửa, anh/chị gửi lại đề nghị sửa giúp em nhé.`
       - Outcome: `action_done` (legacy `post_create_update`), không cập nhật tracker.
     - Nếu nền không đổi:
       - Gọi tracker cập nhật: `tracker.updateIssue(issueId, { title, description })`.
       - Ghi comment dấu vết giữ lịch sử thay đổi:
         `✏️ Đã sửa theo đề nghị của **${who}**:\n${lines}` (gắn `markBotComment`).
       - Thông báo người báo: `Dạ em đã sửa {id} rồi ạ.` (outcome: `action_done`).

### 6. D6 — Chuyển ticket vừa tạo nhầm sang ticket khác (`move_created`)

- **Bối cảnh (ADR-0008 §7)**: Người báo ngay sau khi bot vừa tạo ticket `from` (ví dụ `TECH-975`), nhắn: "cái này bổ sung cho TECH-795" hoặc "nhầm rồi, cái vừa rồi là của TECH-795".
- **Bản xem trước**:
  - Dẫn dắt: `Dạ anh/chị xác nhận giúp em: chuyển toàn bộ nội dung ${from} sang ${target} và huỷ ${from} (ticket trùng) nhé?`
  - Hàng nút: `[✅ Chuyển sang ${target}]`, `[Huỷ]`.
- **Thực thi khi bấm xác nhận**:
  1. Đọc ticket nguồn `from`: trích xuất phần mô tả và danh sách ảnh bằng hàm thuần `descriptionBody(src.description)`.
  2. Ghi comment sang ticket đích `target`:
     `🔀 **${who}** xác nhận ${from} là bổ sung cho ticket này — nội dung chuyển sang:\n${body}\n\n${images}` (gắn `markBotComment`).
  3. Tạo liên kết trùng giữa hai ticket trên tracker: `tracker.linkIssues(from.issueId, target.issueId, "duplicates")`.
  4. Ghi comment ghi chú trên ticket nguồn `from`:
     `ℹ️ Ticket này trùng ${target}: **${who}** xác nhận đây là bổ sung cho ${target}, nội dung đã chuyển sang ${target}. Tiểu Linh huỷ bản trùng (ADR-0008).` (gắn `markBotComment`).
  5. Chuyển ticket nguồn `from` sang cột `Canceled`: tìm cột có `stateType === "canceled"` trên dự án, gọi `tracker.updateIssue(from.issueId, { columnId })`.
     *(Lưu ý: Đây là huỷ bản rác do bot tạo nhầm theo ADR-0008 §7, được phép huỷ; không vi phạm ADR-0006 vì không phải đóng việc thật của chuyên viên).*
  6. Nếu tờ khai hiện tại trong chat mang mã `from`: cập nhật tờ khai `status = "canceled"` để ngăn các tin nhắn sau tiếp tục trôi vào bản trùng này.
  7. Phản hồi người báo: `Dạ em đã chuyển nội dung ${from} sang ${target} và huỷ ${from} rồi ạ.` (outcome: `action_done`).

### 7. D7 — Quyền sở hữu (Ownership): Binding cùng chat & Quy ước mô tả Telegram ID

- **Nguyên tắc**: Bổ sung, sửa, chuyển ticket CHỈ dành cho ticket CỦA MÌNH (`ownTicket === true`).
- **Hai cơ chế xác thực quyền sở hữu (`OwnershipPort`)**:
  1. *Căn cứ Binding*: Chat ID hiện tại có bản ghi trong bảng `ticket_bindings` của SQLite nối với mã ticket đó (áp dụng cho mọi ticket tạo qua bot mới hoặc bot cũ có lưu binding). Tra cứu qua `bindings.listBindingsForChat(chatId)`.
  2. *Căn cứ Quy ước mô tả (Ticket bot cũ)*: Mô tả ticket (`description`) chứa Telegram ID của người báo theo mẫu số nguyên ≥ 5 chữ số: `new RegExp("(?<!\\d)" + bareChatId + "(?!\\d)").test(description)`. Giúp nhận diện chính xác chủ ticket đối với các ticket cũ chưa kịp lưu vào SQLite binding.
- **Xử lý vi phạm quyền sở hữu**:
  - Gặp lệnh ghi (`append`, `edit`, `move`): **Từ chối thẳng, không tạo bản xem trước, không ghi**:
    `Dạ {identifier} không phải ticket anh/chị báo nên em không ghi vào được ạ. Anh/chị cần xem tình trạng thì nhắn "{identifier} tới đâu rồi" nhé.` (outcome: `not_owner`, legacy `post_create_update`).
  - Gặp lệnh tra cứu (`lookup`): Cho phép tra cứu nhưng chỉ hiển thị trạng thái cột, giấu kín tiêu đề và trao đổi kỹ thuật.
- **Bảo mật liên phiên (Cross-chat Security)**:
  - Một bản xem trước `pendingTicketAction` được lưu trong tờ khai gắn chặt với `chatId`. Người dùng ở chat khác tuyệt đối không thể bấm hộ nút xác nhận hay can thiệp vào ticket của người khác.

### 8. D9 — Tra cứu tiến độ không nêu mã: Cửa sổ 30 phút cho ticket gần nhất của chat

- **Bối cảnh**: Người báo nhắn các câu hỏi tiến độ tự nhiên mà không nhắc mã ticket: "tình trạng thế nào rồi em", "tiến độ tới đâu rồi", "ticket của chị xong chưa", "check giúp chị với".
- **Quy tắc giải quyết**:
  - Tra cứu ticket gần nhất của chat: `deps.bindings.getLatestBinding(chatId)`.
  - Kiểm tra thời gian: Cửa sổ hiệu lực là **30 phút** (`LOOKUP_WINDOW_MS = 30 * 60_000`) tính từ thời điểm cập nhật/tạo gần nhất của binding.
  - Nếu nằm trong 30 phút: tự động coi là lệnh tra cứu (`lookup`) cho ticket đó và phản hồi đầy đủ tiến độ.
  - Nếu quá 30 phút hoặc chat chưa từng có ticket nào: trả về câu hỏi làm rõ (`clarify`), xin người báo cung cấp mã ticket cụ thể cần tra cứu.

### 9. Bảng ánh xạ kết quả `StepOutcome` ↔ Legacy `action` & Hợp đồng CopyKey

Bảng ánh xạ chính thức tại `packages/core/src/intake/engine/action-map.ts`:

| `StepOutcome` của core | `action` của legacy | Ý nghĩa trong PR 11 |
|---|---|---|
| `action_preview` | `confirm_ticket_action` | Bản xem trước kèm nút xác nhận cho append / edit / move |
| `action_done` | `post_create_update` | Đã thực thi sửa hoặc chuyển ticket thành công |
| `not_owner` | `post_create_update` | Từ chối ghi vì không phải chủ ticket |
| `lookup` | `lookup_result` | Kết quả tra cứu ticket (đầy đủ cho chủ, ẩn danh cho người khác) |
| `action_canceled` | `canceled` | Người báo bấm Huỷ hoặc từ bỏ thao tác |
| `closed_refusal` | `post_create_update` | Từ chối ghi bổ sung vào ticket đã đóng (Done/Canceled) |
| `clarify` | `clarify_intent` | Câu lệnh trần chưa có nội dung/ảnh, hỏi xin bổ sung chi tiết |

Các `CopyKey` mới cần khai báo trong `packages/core/src/intake/ports.ts` và triển khai trong `test-copy.fixture.ts`:
- `lookup.tech_comment`: Định dạng dòng trích trao đổi gần nhất của kỹ thuật (`\nTrao đổi gần nhất của kỹ thuật: "{comment}"`).
- `lookup.other_ticket_status`: Câu trả lời tra cứu ticket của người khác (`Dạ {identifier} đang ở trạng thái: {status} ạ.`).
- `action.preview_edit`: Lời dẫn bản xem trước khi sửa ticket (`Dạ anh/chị xác nhận giúp em sửa {identifier} như sau nhé?\n{changes}`).
- `action.preview_move`: Lời dẫn bản xem trước khi chuyển ticket nhầm (`Dạ anh/chị xác nhận giúp em: chuyển toàn bộ nội dung {from} sang {identifier} và huỷ {from} (ticket trùng) nhé?`).
- `action.edit_conflict_rejected`: Câu từ chối sửa khi phát hiện xung đột nền (`Dạ {identifier} vừa được cập nhật sau khi em lập bản sửa, anh/chị gửi lại đề nghị sửa giúp em nhé.`).
- `action.edit_unclear_prompt`: Câu hướng dẫn khi không hiểu đề nghị sửa (`Dạ em chưa hiểu cần sửa gì trong {identifier} ạ. Anh/chị ghi rõ giúp em, vd "sửa {identifier} SĐT thành 09xxxxxxxx" nhé.`).
- `action.clarify_empty_append`: Câu hỏi nội dung khi nhận câu lệnh trần (`Dạ anh/chị gửi ảnh chụp màn hình hoặc nội dung cần bổ sung vào {identifier} giúp em nhé ạ.`).
- `action.move_done`: Câu báo chuyển ticket thành công (`Dạ em đã chuyển nội dung {from} sang {identifier} và huỷ {from} rồi ạ.`).
- `action.edit_done`: Câu báo sửa ticket thành công (`Dạ em đã sửa {identifier} rồi ạ.`).
- `button.confirm_edit`: Nhãn nút xác nhận sửa (`✅ Sửa {identifier}`).
- `button.confirm_move`: Nhãn nút xác nhận chuyển (`✅ Chuyển sang {identifier}`).
- `button.cancel_action`: Nhãn nút huỷ bản xem trước (`Huỷ`).

---

## Phân định Legacy vs RFC 0002

| Tiêu chí | Bản tham chiếu Legacy (`apps/tieulinh-legacy`) | Thiết kế Core (`packages/core`) theo RFC 0002 | Lý do chọn |
|---|---|---|---|
| **Chuỗi giao diện** | Hardcode tiếng Việt trực tiếp trong `pipeline.ts` và `ticket-reply-router.ts`. | 100% chuỗi đi qua `CopyCatalog` tra theo `CopyKey`. | **Chọn Core**: `@vuihoc/bot-core` là thư viện dùng chung cho nhiều bot (Tiểu Linh, IRIS, CM), không hardcode tiếng Việt trong logic. |
| **Cổng Tracker & Mention** | Phụ thuộc trực tiếp vào `ItsaplanClient` cụ thể và các phương thức API Itsaplan. | Tách qua các hàm thuần domain (`applyEditOps`, `descriptionBody`, `stripSupplementCommandWrapper`) và cổng trừu tượng `TrackerPort`. | **Chọn Core**: Đảm bảo tính kiểm thử độc lập (testable), test không gọi mạng và mock được bằng fakes. |
| **Tra cứu không nêu mã (D9)** | Dùng tool MCP riêng (`identity.ts`, `latestTicket`, tool `get_issue`). | Đưa trực tiếp vào luồng xử lý của `IntakeEngine` với cửa sổ 30 phút. | **Chọn Core**: Giữ trải nghiệm một luồng chat tự nhiên, người báo hỏi tiến độ là bot tra ngay mà không cần gọi tool ngoài. |
| **Bảo toàn ảnh đính kèm (TECH-1218)** | Chắp vá biến tạm và xử lý phân tán trong `pipeline.ts`. | Tách hàm thuần `stripSupplementCommandWrapper` trong `text.ts` và chuẩn hoá ma trận trạng thái trong `resolvePendingAction`. | **Chọn Core**: Rõ ràng, tất định, dễ bảo trì và không lo rơi rớt tệp đính kèm. |
| **Nút từ chối thao tác** | Dùng nhãn `"Huỷ"` (`CANCEL_ACTION_LABEL`). | Thống nhất `button.cancel_action` ("Huỷ") cho append/edit/move, phân biệt rõ với `button.keep_ticket` ("Giữ lại") của PR 12 để tránh nhầm lẫn giữa huỷ thao tác và huỷ ticket (`TECH-951`). | **Chọn Core**: An toàn tuyệt đối, loại bỏ nguy cơ người dùng bấm nhầm. |

---

## Non-goals (Không thuộc phạm vi PR 11)

Để đảm bảo ranh giới rõ ràng giữa các PR trong chuỗi RFC 0002:

1. **Huỷ và đóng ticket theo yêu cầu người báo (D8, ADR-0006 bản 10/10)**:
   - Toàn bộ luồng thực thi quyết định `Canceled` vs `Done` dựa trên số bình luận chuyên viên `MIN_SPECIALIST_COMMENTS_FOR_DONE = 3` hoặc cột `Resolved`.
   - Các nút `[✅ Hủy TECH-X]` / `[✅ Đóng TECH-X]` và `[Giữ lại]`.
   - Escape markdown comment lý do hủy/đóng.
   - Thuộc **PR 12**. (PR 11 chỉ giữ contract phân loại hoặc trả về clarify/hướng dẫn, không thực thi chuyển cột D8).
2. **Soát thông tin kỹ thuật (F1-F4)**:
   - `checklistReview` thuần dữ liệu, `llmReview` trên core `llm`, cổng `learned`, công tắc chính sách thuộc **PR 13**.
3. **Định dạng ticket chi tiết và media nâng cao (J1)**:
   - Dữ liệu domain, chữ và định dạng ticket của app Tiểu Linh thuộc **PR 14**.
4. **Adapter OpenClaw và Pack MCP**:
   - Khai báo bot và tích hợp harness thuộc **PR 15** và **PR 16**.

---

## Constraints / Forbidden (Ràng buộc và điều cấm)

- Tuân thủ nghiêm ngặt `orchestration/WORKER-CONTRACT.md`.
- `apps/tieulinh-legacy/**` là bản tham chiếu **đóng băng**: chỉ đọc, tuyệt đối không sửa, không import code legacy vào `packages/core` hay app mới.
- Không commit, không push, không mở PR hay merge.
- Không dùng `any`, không dùng toán tử non-null (`!`) trong code mới viết.
- Không sửa `.github/workflows/**`, `scripts/**`, `biome.lint-baseline.json`, `package.json` gốc, `bun.lock`.
- **Core không hardcode tên sản phẩm, tên công ty hay tên hệ thống của một app**. Dữ liệu miền đi qua catalog và tham số.
- **Bất biến an toàn**:
  - Không ghi vào ticket đã có nếu chưa có một cú bấm khớp nhãn nút chính xác (ADR-0008).
  - Không tự động xác nhận thay người báo.
  - Không tự ý đóng hay huỷ ticket nếu người báo chưa xác nhận (ADR-0006).
  - Không bao giờ ghi đè khi phát hiện xung đột nền (optimistic concurrency check).
  - Một lượt, một khoá chat (`withChatLock`).

---

## Ownership

Các file và thư mục worker PR 11 được phép tạo mới hoặc sửa đổi:

1. **`packages/core/src/intake/engine/text.ts`**:
   - Thêm `stripSupplementCommandWrapper(text: string)`.
2. **`packages/core/src/intake/engine/text.test.ts`**:
   - Thêm test cho `stripSupplementCommandWrapper` và `mentionedIdentifiers`.
3. **`packages/core/src/intake/engine/edit.ts` (mới)**:
   - Khai báo `EditOp`, `applyEditOps`, `descriptionBody`, `planEdit`.
4. **`packages/core/src/intake/engine/edit.test.ts` (mới)**:
   - Test cho các hàm sửa ticket và trích body/ảnh.
5. **`packages/core/src/intake/ports.ts`**:
   - Mở rộng `ReplyCandidate`, `TicketCommand`, `OwnershipPort`, `TrackerPort`, `MessageRouteStore`, `CopyKey`.
6. **`packages/core/src/intake/engine/engine.ts`**:
   - Cập nhật `buildCandidates`, `routeExistingTicket`, `lookup`, `previewAction`, `resolvePendingAction`, `executeConfirmedTicketAction`.
7. **`packages/core/src/intake/engine/pr11-ticket-commands.test.ts` (mới)**:
   - Bộ test luồng tích hợp cho các lệnh nhắm vào ticket đã có (D1-D7, D9).
8. **`packages/core/src/intake/engine/ownership-confirm.test.ts` (mới)**:
   - Bộ test port từ `own-tickets-confirm.test.ts`.
9. **`packages/core/src/intake/engine/test-copy.fixture.ts` & `packages/core/examples/tieulinh/copy.ts`**:
   - Khai báo và định nghĩa chuỗi hiển thị cho các `CopyKey` mới.
10. **`apps/tieulinh/receptionist-gap-register.test.ts`**:
    - Chuyển 28 dòng legacy sang `ported`.
11. **Tài liệu & Parity**:
    - `packages/core/CHANGELOG.md`
    - `packages/core/docs/parity/ENGINE.md`
    - `docs/rfc/0002-receptionist.md` (mục 1.4 các dòng D1-D7, D9 và mục 5 hàng PR 11).

---

## Danh sách test legacy phải port kèm tên file

Tổng cộng **28 ca test legacy** (được đánh dấu `Chờ port ở PR 11` trong `apps/tieulinh/receptionist-gap-register.test.ts`) cần được port đầy đủ:

### 1. Từ `apps/tieulinh-legacy/lib/intake-step/ticket-reply-router.test.ts` (9 ca test):

| # | Tên ca test legacy nguyên văn | File đích trong `packages/core` |
|---|---|---|
| 1 | `nhận các cách viết mã ticket` | `packages/core/src/intake/engine/text.test.ts` |
| 2 | `append / edit / lookup chỉ nhận mã trong ứng viên; câu kỹ thuật hỏi vào prompt` | `packages/core/src/intake/engine/pr11-ticket-commands.test.ts` |
| 3 | `move_created cần ticket vừa tạo làm nguồn` | `packages/core/src/intake/engine/pr11-ticket-commands.test.ts` |
| 4 | `planEdit lọc thao tác hợp lệ` | `packages/core/src/intake/engine/edit.test.ts` |
| 5 | `applyEditOps: sửa dòng có sẵn, thêm dòng mới vào cuối Thông tin sự cố, thay câu mô tả duy nhất` | `packages/core/src/intake/engine/edit.test.ts` |
| 6 | `descriptionBody lấy phần Mô tả và ảnh` | `packages/core/src/intake/engine/edit.test.ts` |
| 7 | `mentionedIdentifiers nhận các kiểu người báo hay gõ (TECH-1001, 30/09)` | `packages/core/src/intake/engine/text.test.ts` |
| 8 | `mentionedIdentifiers hỗ trợ khoá dự án có chữ số mà không khớp nhầm SĐT hay mã khác` | `packages/core/src/intake/engine/text.test.ts` |
| 9 | `bóc vỏ câu lệnh bổ sung / đính kèm trần (TECH-1218: 'update vào tick TECH-1218') để không ghi câu lệnh thành comment` | `packages/core/src/intake/engine/text.test.ts` |

*(Lưu ý: 5 ca test còn lại trong file về `cancel_or_close` và `countSpecialistTimelineComments` thuộc phạm vi PR 12).*

### 2. Từ `apps/tieulinh-legacy/lib/intake-step/pipeline.flow.test.ts` (11 ca test):

| # | Tên ca test legacy nguyên văn | File đích trong `packages/core` |
|---|---|---|
| 10 | `kỹ thuật vừa hỏi → GỢI Ý bổ sung, chưa ghi gì; bấm xác nhận mới ghi` | `packages/core/src/intake/engine/pr11-ticket-commands.test.ts` |
| 11 | `giục gấp có lý do vào ticket có sẵn → chỉ khi bấm xác nhận mới nâng mức + ghi lý do (thay escalate_issue cũ)` | `packages/core/src/intake/engine/pr11-ticket-commands.test.ts` |
| 12 | `gợi ý → 'Sự cố mới' thì tin vào tờ khai, không ghi ticket cũ` | `packages/core/src/intake/engine/pr11-ticket-commands.test.ts` |
| 13 | `'bổ sung TECHTEST-795 …' khi đang soạn dở → xem trước + Huỷ; Huỷ thì không ghi, tờ khai giữ nguyên` | `packages/core/src/intake/engine/pr11-ticket-commands.test.ts` |
| 14 | `đang chờ xác nhận mà nhắn việc khác → bỏ bản xem trước, xử lý tin mới như thường` | `packages/core/src/intake/engine/pr11-ticket-commands.test.ts` |
| 15 | `ticket có Telegram ID người báo trong mô tả cũng là của mình (ticket bot cũ)` | `packages/core/src/intake/engine/pr11-ticket-commands.test.ts` |
| 16 | `sửa: xem trước cũ → mới, xác nhận thì sửa thẳng + comment dấu vết` | `packages/core/src/intake/engine/pr11-ticket-commands.test.ts` |
| 17 | `bot vừa tạo nhầm → 'cái này bổ sung cho TECHTEST-795' → xác nhận: chép sang 795, nối trùng, huỷ bản vừa tạo` | `packages/core/src/intake/engine/pr11-ticket-commands.test.ts` |
| 18 | `tin báo trạng thái, ticket đã huỷ, hay lời 'huỷ'/'cảm ơn' → không gợi ý ghi vào ticket` | `packages/core/src/intake/engine/pr11-ticket-commands.test.ts` |
| 19 | `không có câu hỏi kỹ thuật, không nhắc mã → không gọi bộ đọc lệnh` | `packages/core/src/intake/engine/pr11-ticket-commands.test.ts` |
| 20 | `đang soạn dở tờ khai → câu trả lời cho tờ khai không bị kéo sang ticket kỹ thuật vừa hỏi` | `packages/core/src/intake/engine/pr11-ticket-commands.test.ts` |
| 21 | `TECH-1218: người báo gửi ảnh trước rồi gõ 'update vào tick TECHTEST-X' (hoặc ngược lại) → bảo toàn ảnh đính kèm và không ghi câu lệnh trần thành comment` | `packages/core/src/intake/engine/pr11-ticket-commands.test.ts` |

*(Lưu ý: 2 ca test khác trong nhóm flow ADR-0008 là `ticket của người khác: không cho bổ sung...` và `'/new'...` đã được port từ các PR trước).*

### 3. Từ `apps/tieulinh-legacy/mcp/shared/tools/own-tickets-confirm.test.ts` (6 ca test):

| # | Tên ca test legacy nguyên văn | File đích trong `packages/core` |
|---|---|---|
| 22 | `tra yêu cầu của người khác → không kể gì (kể cả tiêu đề)` | `packages/core/src/intake/engine/ownership-confirm.test.ts` |
| 23 | `tra yêu cầu của mình → đủ tin, trạng thái PO kèm lời giải thích` | `packages/core/src/intake/engine/ownership-confirm.test.ts` |
| 24 | `không truyền chatId thì không chứng minh được là của mình → từ chối` | `packages/core/src/intake/engine/ownership-confirm.test.ts` |
| 25 | `bổ sung vào yêu cầu người khác → từ chối, không xem trước, không ghi` | `packages/core/src/intake/engine/ownership-confirm.test.ts` |
| 26 | `bổ sung: lần đầu chỉ xem trước (chưa ghi); bấm xác nhận mới ghi đúng bản đã xem` | `packages/core/src/intake/engine/ownership-confirm.test.ts` |
| 27 | `bấm Huỷ → không ghi, bản chờ bị xoá` | `packages/core/src/intake/engine/ownership-confirm.test.ts` |

### 4. Từ `apps/tieulinh-legacy/mcp/shared/tools/confirmation-and-binding.test.ts` (1 ca)

| # | Tên ca test legacy nguyên văn | File đích trong `packages/core` |
|---|---|---|
| 28 | `update_issue: báo updated=false khi cả ghi mô tả lẫn comment đều lỗi, không được báo thành công giả` | `packages/core/src/intake/engine/pr11-ticket-commands.test.ts` |

---

## Observable Acceptance (Tiêu chí chấp nhận và bằng chứng)

Worker triển khai PR 11 phải cung cấp bằng chứng chạy thực tế với kết quả pass 100%:

```bash
# 1. Chạy các test suite mới của PR 11
bun test packages/core/src/intake/engine/text.test.ts
bun test packages/core/src/intake/engine/edit.test.ts
bun test packages/core/src/intake/engine/pr11-ticket-commands.test.ts
bun test packages/core/src/intake/engine/ownership-confirm.test.ts

# 2. Chạy sổ đối chiếu khoảng trống (phải chuyển đủ 28 dòng legacy sang ported)
bun test apps/tieulinh/receptionist-gap-register.test.ts

# 3. Toàn bộ test suite core
bun run --cwd packages/core test

# 4. Kiểm tra toàn diện repo (lint, typecheck, test, scan)
bun run verify

# 5. Kiểm tra tài liệu TypeDoc và mẫu code
bun run docs:check
```

Tiêu chí nghiệm thu:
1. Mọi lệnh bổ sung/sửa/chuyển vào ticket đã có đều hiển thị bản xem trước và CHỈ thực thi khi bấm nút khớp nhãn chính xác (ADR-0008).
2. Người ở chat khác không thể bấm hộ nút xác nhận.
3. Sửa ticket có kiểm nền (`optimistic concurrency check`), từ chối khi ticket bị đổi trong lúc chờ.
4. Chuyển ticket nhầm (`move_created`) nối link trùng `duplicates`, huỷ bản trùng `Canceled` và đóng tờ khai nguồn.
5. Tra cứu ticket người khác chỉ thấy trạng thái, không lộ tiêu đề và trao đổi kỹ thuật.
6. Tra cứu không nêu mã trong 30 phút tự động nhận diện ticket gần nhất của chat.
7. `bun run verify` và `bun run docs:check` chạy sạch, không lỗi type, không tăng số lỗi linter baseline, không lộ secret.

---

## Rủi ro và câu hỏi mở

1. **Tra cứu MessageRoute cho chat (D1)**:
   - *Rủi ro*: Bảng `message_routes` trong SQLite có thể có các dòng cũ không có `chat_id`.
   - *Giải pháp*: Tái sử dụng logic của `SqliteMessageRouteStore` (đã có ở `packages/core/src/intake/notify/stores.ts`), ưu tiên dòng có `chat_id` khớp, dự phòng qua binding của ticket đó.
2. **Kiểm nền sửa ticket khi mô tả có định dạng phức tạp (D5)**:
   - *Rủi ro*: Whitespace hoặc newline giữa Itsaplan API và local có thể lệch nhẹ gây xung đột giả.
   - *Giải pháp*: So sánh `baseTitle` và `baseDescription` sau khi chuẩn hoá khoảng trắng cuối dòng (`trimEnd()`), đảm bảo chỉ từ chối khi nội dung thật sự thay đổi.
3. **Phân biệt lệnh huỷ ticket (D8) và huỷ thao tác xem trước (D4)**:
   - *Rủi ro*: Người dùng nói "Huỷ" có thể bị nhầm giữa huỷ ticket và huỷ bản xem trước.
   - *Giải pháp*: Khi đang có bản xem trước, nút từ chối mang nhãn `[Huỷ]` (`button.cancel_action`) và câu trả lời luôn khẳng định rõ `Dạ vâng, em không ghi gì vào {identifier} ạ` (không đổi trạng thái ticket). Còn ở PR 12, nút từ chối huỷ ticket sẽ mang nhãn `[Giữ lại]` (`button.keep_ticket`).
