# Báo cáo: PR 10 của RFC 0002 — tin sau khi tạo ticket (issue #24)

## 1. Đã làm gì (theo từng mục của đặc tả)

- **C1 (Tờ khai đã tạo là tờ khai ĐÓNG & Phân loại ý định theo ngữ cảnh `createdTicket`)**:
  - Tờ khai có `status === "created"` và `issueId` được coi là tờ khai đã hoàn tất vòng đời tiếp nhận ban đầu; không bao giờ tự ý ghi đè mô tả hay các trường định danh đã lưu trong ticket.
  - Truyền đầy đủ ngữ cảnh `createdTicket: { identifier, title, description }` trong `ExtractInput.context`.
  - Phân loại và xử lý ý định:
    - `chitchat` / cảm ơn: trả lời lịch sự qua `CopyCatalog` (`ticket.chitchat_after_create`), outcome `already_created`, không đụng tới ticket.
    - `cancel` chung chung: hướng dẫn cú pháp huỷ rõ ràng qua `ticket.cancel_hint_after_create`, outcome `already_created`, bot không tự ý huỷ/đóng ticket (ADR-0006).
    - `confirm` lại: trả lời `ticket.already_created_hint`, outcome `already_created` (idempotent).
    - `report_issue`: mở tờ khai mới độc lập, gọi `collect` ngay trong lượt.
- **C2 (Không tự ghi vào ticket đã tạo; Nhận diện "ticket mới ạ" & Trạng thái chờ gợi ý — ADR-0008, TECH-1013)**:
  - Khi có thông tin bổ sung hoặc ảnh: luôn tạo bản xem trước `pendingTicketAction` với `kind: "suggest"`, dẫn dắt bằng trích dẫn nội dung và thông báo tệp đính kèm (`action_preview`).
  - Hàng nút gồm `✅ Bổ sung vào {identifier}`, các nút ticket thay thế nếu có (B8), và nút `Sự cố mới` (`button.new_incident`).
  - Nhận diện tuyên bố sự cố mới `saysNewIncident`:
    - Nếu câu quá ngắn sau khi bóc cụm từ tuyên bố (`stripNewIncidentDeclaration(text).length < 12`) và không kèm ảnh: mở tờ khai mới, trả về outcome `clarify` ("Dạ vâng, anh/chị mô tả sự cố mới giúp em nhé ạ.").
    - Nếu câu có nội dung chi tiết (`>= 12` ký tự) hoặc kèm ảnh: mở tờ khai mới và `collect` ngay.
  - Khi đang chờ người báo chọn ở bản xem trước `suggest`:
    - Nếu bấm `Sự cố mới` hoặc gõ câu mang ý `saysNewIncident`: mở tờ khai mới, nối nội dung đã gác ở pending bằng `withTypedDetail`, gộp toàn bộ ảnh đính kèm, tiếp nhận ngay.
    - Nếu gửi thêm ảnh: gộp ảnh mới vào `pendingTicketAction.mediaPaths`, nhắc lại kèm số lượng ảnh đã nhận (`action.suggest_unclear_prompt_with_media`).
    - Nếu gõ tin nhắn việc khác: nhắc lại yêu cầu bấm nút để ghi đúng chỗ (`action.suggest_unclear_prompt`), giữ nguyên `pendingTicketAction`.
- **C3 (Định danh xung đột & Từ chối bổ sung vào ticket đã đóng — W29-NOTIFY)**:
  - So sánh các trường định danh (`studentAccount`, `phone`, `customerId`, `orderId`) giữa ticket đã tạo và tin mới bằng `findIdentifierConflict`. Khi có xung đột và không phải báo sự cố mới, chuyển sang câu dẫn dắt cảnh báo (`action.suggest_conflict_lead`). Khi người báo chọn "Bổ sung", giữ nguyên định danh cũ của ticket đã tạo; định danh mới chỉ nằm trong comment.
  - Kiểm tra trạng thái đóng (`Done` / `Canceled`) qua cổng tracker (`checkIssueClosed` / `isIssueClosed` / `getIssueState`):
    - Nếu tin mới là báo sự cố mới (`report_issue`): vẫn mở tờ khai mới bình thường.
    - Nếu tin mới là bổ sung (kể cả lệnh gõ tay chỉ định mã `bổ sung TECH-X`): từ chối lịch sự qua outcome `closed_refusal` (`closedTicketRefusalMessage` / `ticket.closed_refusal`), KHÔNG ghi comment, KHÔNG cập nhật ticket.
- **C4 (Ghi bổ sung vào ticket qua comment — Mention Resolver, Comment Formatting, On-call Alert)**:
  - Khi xác nhận bổ sung, chỉ ghi bằng bình luận (`addComment`), giữ nguyên văn mô tả ban đầu (ADR-0010), trần `MAX_FOLLOW_UP_CHARS = 4000`.
  - Tải tệp đính kèm lên ticket qua `TrackerPort.attach`, gắn markdown link vào comment.
  - Phân giải người nhận `@mention` qua `resolveSupplementMentionTarget` (3 bước: ưu tiên assignee, fallback kỹ thuật viên bình luận gần nhất trên timeline bỏ qua bot/người báo, fallback không cc ai nếu không có KTV).
  - Định dạng comment bổ sung qua `formatSupplementComment` (chuẩn hoá mention `(cc @username)`, bọc marker bot comment `markBotComment`).
  - Gửi cảnh báo kênh trực ca qua `notifyOnCallSupplement` khi bật env `NOTIFY_ON_CALL_SUPPLEMENT=1`.
- **G2 (Nâng mức ưu tiên khi xin gấp có lý do — Quy tắc 29/09)**:
  - Khi tin bổ sung có `requestedPriority` ("high" hoặc "urgent") và `requestedPriorityReason`, đồng thời mức xin cao hơn mức hiện tại: gọi `updateIssue` nâng mức trên tracker, cập nhật priority tờ khai, chèn dòng thông báo nâng mức vào comment bổ sung.
  - Nếu xin gấp không có lý do: giữ nguyên mức ưu tiên hiện tại.
- **B8 (Nhiều ticket đang mở cùng chat — TECH-989, TECH-1001)**:
  - Bổ sung `ChannelBindingStore.listBindingsForChat(chatId, limit?, identifierPrefix?)` và implement trong `SqliteChannelBindingStore`.
  - Tra cứu các binding của chat, loại trừ ticket vừa tạo, lọc các ticket chưa đóng, lấy tối đa 3 ticket đang mở khác (`alternatives`).
  - Cho phép thông dịch lệnh để chọn ticket chính (`primary`) hoặc mặc định là ticket vừa tạo; tạo hàng nút riêng cho từng ticket đang mở; bấm nút nào ghi chính xác vào ticket đó.

## 2. File nào đổi

- `packages/core/src/intake/notify/supplement-notifier.ts` (mới): Port các hàm thuần miền `isIssueClosed`, `closedTicketRefusalMessage`, `resolveSupplementMentionTarget`, `formatSupplementComment`, `notifyOnCallSupplement`, `isSystemActor`.
- `packages/core/src/intake/notify/index.ts`: Re-export `supplement-notifier`.
- `packages/core/src/intake/notify/supplement-notifier.test.ts` (mới): Bộ 19 ca test hàm thuần ported từ legacy.
- `packages/core/src/intake/ports.ts`:
  - Mở rộng `TrackerIssue` (`columnId`, `stateType`, `priority`, `assigneeUserId`).
  - Mở rộng `TrackerPort` (`updateIssue`, `isIssueClosed`, `getIssueState`, `getProjectAssignees`, `getIssueTimeline`).
  - Mở rộng `ChannelBindingStore` (`listBindingsForChat`).
  - Bổ sung các `CopyKey`: `ticket.closed_refusal`, `ticket.chitchat_after_create`, `ticket.cancel_hint_after_create`, `ticket.already_created_hint`, `action.suggest_append_lead`, `action.suggest_conflict_lead`, `action.suggest_unclear_prompt`, `action.suggest_unclear_prompt_with_media`.
- `packages/core/src/intake/adapter.ts`: Triển khai các phương thức mới của `TrackerPort` trên `itsaplanTrackerPort`.
- `packages/core/src/intake/draft/types.ts`: Mở rộng `pendingTicketAction` trong `IntakeDraft` (thêm `issueId`, `message`, `mediaPaths`, `lead`, `alternatives`, `askedAt`).
- `packages/core/src/intake/create/binding-store.ts`: Triển khai `listBindingsForChat(chatId, limit?, identifierPrefix?)` trên `SqliteChannelBindingStore`.
- `packages/core/src/intake/create/binding-store.test.ts`: Thêm ca test cho `listBindingsForChat`.
- `packages/core/src/intake/engine/engine.ts`:
  - Thêm luồng `handlePostCreate` khi tờ khai ở `status === "created"` và có `issueId`.
  - Thêm `startNewIncidentFromPostCreate`, `proposeSuggestAction`, `resolvePendingAction` cho suggest/bổ sung, `executeConfirmedTicketAction`, `otherOpenTickets`, `checkIssueClosed`, `resolveClosedStatusLabel`, `findConflictingField`, `buildTicketActionButtons`.
  - Nâng cấp `routeExistingTicket` kiểm tra ticket đóng trả về `closed_refusal`.
- `packages/core/src/intake/engine/engine-harness.fixture.ts`: Nâng cấp `FakeTracker` hỗ trợ các cổng mới của PR 10.
- `packages/core/src/intake/engine/test-copy.fixture.ts`: Thêm các CopyKey mới.
- `packages/core/examples/tieulinh/copy.ts`: Thêm bản dịch tiếng Việt cho các CopyKey mới.
- `packages/core/src/intake/engine/pr10-post-create.test.ts` (mới): Bộ 18 ca test luồng (12 flow + 6 notify) ported từ legacy.
- `apps/tieulinh/receptionist-gap-register.test.ts`: Chuyển 37 dòng PR 10 từ `deferred` sang `ported`.
- `packages/core/docs/parity/ENGINE.md`: Cập nhật bảng parity và hàng PR 10 (còn 0 test).
- `docs/rfc/0002-receptionist.md`: Cập nhật các dòng C1-C4, G2, B8 mục 1.5.
- `packages/core/CHANGELOG.md`: Ghi nhận thay đổi của PR 10.

## 3. Lệnh đã chạy và kết quả thật

```bash
# 1. Chạy 3 test suite mục tiêu
bun test packages/core/src/intake/notify/supplement-notifier.test.ts
# ✓ 19 pass, 0 fail, 47 expect() calls [69ms]

bun test packages/core/src/intake/engine/pr10-post-create.test.ts
# ✓ 18 pass, 0 fail, 89 expect() calls [219ms]

bun test apps/tieulinh/receptionist-gap-register.test.ts
# ✓ 9 pass, 0 fail, 1241 expect() calls [16ms]

# 2. Toàn bộ test suite core
bun run --cwd packages/core test
# ✓ 1376 pass, 0 fail, 9541 expect() calls [44.94s]

# 3. Test app tieulinh
bun test apps/tieulinh/
# ✓ 77 pass, 0 fail, 1603 expect() calls [8.93s]

# 4. Kiểm tra kiểu TypeScript
bun run check
# ✓ @vuihoc/bot-core check: Exited with code 0
# ✓ @vuihoc/tieulinh check: Exited with code 0
# ✓ @vuihoc/tl2-shadow check: Exited with code 0
# ✓ @vuihoc/tieulinh-legacy check: Exited with code 0

# 5. Kiểm tra tài liệu, snippets, TypeDoc và refs
bun run docs:check
# ✓ docs:gen: copy-keys: 63 khoá, adr-index: 16 ADR
# ✓ typedoc: 0 errors, 0 warnings
# ✓ vitepress build complete in 41.70s
# ✓ check-doc-snippets: Mẫu code 26 ts check, 14 ts run, 2 ts no-check (0 lỗi)
# ✓ check-docs-refs: Docs khớp code: 48 trang (0 lỗi)

# 6. Kiểm tra an toàn bảo mật repo công khai
bun run scan
# ✓ public-hygiene scan clean
```

## 4. Test nào thêm, test nào port

Đã port đủ **37/37 ca test legacy** (100% giữ nguyên tên và ý nghĩa):

### A. 12 ca flow từ `apps/tieulinh-legacy/lib/intake-step/pipeline.flow.test.ts`
1. `ticket đã tạo, xin khẩn cấp kèm lý do → nâng mức trên ticket + comment lý do`
2. `'cảm ơn em' sau khi tạo không đụng tới ticket`
3. `thông tin bổ sung sau khi tạo → comment, KHÔNG ghi đè mô tả`
4. `tin có ảnh, không xung đột định danh → hỏi, chưa ghi gì`
5. `chỉ gửi ảnh → cũng hỏi, không ghi`
6. `hỏi rồi người báo GÕ "ticket mới ạ" → sự cố mới từ tin đang chờ, ticket cũ không bị đụng`
7. `vừa tạo xong, người báo chỉ nhắn "ticket mới ạ" → mở tài liệu mới xin mô tả, không ghi gì`
8. `hiểu ý chọn ticket cũ, mỗi ticket đang mở có nút riêng; bấm nút ticket cũ mới ghi vào ticket cũ`
9. `không rõ ticket nào → gợi ý ticket vừa tạo, nhưng ticket cũ vẫn có nút để chọn đúng`
10. `sự cố mới sau khi tạo → tài liệu mới, không ghi vào ticket cũ`
11. `ticket đã tạo + tin có mã khác → hỏi sự cố mới hay bổ sung, không tự ghi bổ sung`
12. `ticket đã tạo + tin có mã khác + chọn "Bổ sung" → ghi bổ sung vào ticket đó`

### B. 6 ca notify từ `apps/tieulinh-legacy/lib/intake-step/pipeline.notify-supplement.test.ts`
13. `khi ticket đang xử lý có assignee (u-techlead-a) → comment bổ sung mention @techlead_a`
14. `khi ticket không có assignee nhưng timeline có trao đổi của KTV (TechUser_B) → mention @techuser_b`
15. `khi ticket không có assignee và timeline chỉ có bot/hệ thống → none (không cc ai)`
16. `ticket đã ở Done (cột 4) → từ chối bổ sung, không addComment, hướng dẫn tạo ticket mới`
17. `ticket đã ở Canceled (cột 5) → từ chối bổ sung, không addComment, hướng dẫn tạo ticket mới`
18. `người dùng gõ lệnh bổ sung chỉ định ticket đã đóng (bổ sung TECHTEST-104) → từ chối ngay lập tức`

### C. 19 ca hàm thuần từ `apps/tieulinh-legacy/lib/itsaplan/supplement-notifier.test.ts`
19. `cột In Progress / Backlog → false (đang mở)`
20. `cột Resolved ('Đã xử lý') → false (vẫn mở để người báo nghiệm thu)`
21. `cột Done / Hoàn tất → true (đã đóng)`
22. `cột Canceled / Đã hủy → true (đã đóng)`
23. `không có danh sách cột: dựa vào stateType của issue`
24. `chứa mã ticket, 'đã đóng', và hướng dẫn 'tạo ticket mới'`
25. `in-progress có assignee → mention assignee`
26. `assignee có tiền tố @ → tự động gỡ @ khỏi username`
27. `no assignee → mention last technician commenter từ timeline`
28. `no assignee + timeline có technician với actorUsername hợp lệ nhưng chưa trong assignees → dùng actorUsername`
29. `no assignee + không có bình luận kỹ thuật viên nào (chỉ có bot) → none (null)`
30. `no assignee + timeline rỗng → none (null)`
31. `định dạng user_update kèm mention`
32. `định dạng user_update khi mention đã có tiền tố @ vẫn chuẩn hoá thành đúng (cc @username)`
33. `định dạng user_update không kèm mention (none)`
34. `định dạng who_supplement kèm mention`
35. `định dạng who_supplement không kèm mention`
36. `khi NOTIFY_ON_CALL_SUPPLEMENT=1: gọi broadcastAlert tới kênh trực ca`
37. `khi NOTIFY_ON_CALL_SUPPLEMENT không bật: không gửi cảnh báo`

### D. Test thêm mới
- 2 ca kiểm thử đơn vị cho `SqliteChannelBindingStore.listBindingsForChat` trong `packages/core/src/intake/create/binding-store.test.ts`.

## 5. Còn dở gì, và phần đó thuộc PR nào

Không còn việc dở trong phạm vi PR 10. Các phần tiếp theo trong chuỗi di trú RFC 0002:
- **PR 11**: Lệnh nhắm vào ticket đã có (D1-D7, D9: cú pháp lệnh chủ động `bổ sung TECH-X`, `sửa TECH-X`, chuyển ticket nhầm `move_created`, tra cứu `lookupTicket` bằng mã hoặc tự do).
- **PR 12**: Huỷ và đóng ticket theo yêu cầu người báo (D8, ADR-0006 bản 10/10).
- **PR 13**: Soát thông tin kỹ thuật (F1-F4: checklistReview, llmReview, learned).
- **PR 14**: Dữ liệu domain, chữ và định dạng ticket chi tiết (J1).
- **PR 15**: Pack MCP và skill.
- **PR 16**: Adapter OpenClaw cho pack lễ tân.
