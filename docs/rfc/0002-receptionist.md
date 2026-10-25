# RFC 0002: Lễ tân (receptionist) của bot kit

- Trạng thái: đề xuất, chưa cài đặt. Đây là bản thiết kế để góp ý trước khi viết code; mọi tên API trong trang này đánh dấu "đề xuất" là để thảo luận, chưa tồn tại
- Ngày: 2026-10-25
- Phạm vi: `packages/core` (`@vuihoc/bot-core`), `apps/tieulinh` (app mới), `apps/tieulinh-legacy` (bản tham chiếu đóng băng), `tools/tl2-shadow`
- Liên quan: [RFC 0001](/rfc/0001-bot-kit) (bot kit; mục "Lễ tân" ở milestone 2b), [Bản legacy và bản mới](/explanation/tieulinh-legacy), [Tiểu Linh mới: hậu cần](/explanation/tieulinh-hau-can), [ADR-0005](/adr/0005-tl2-shadow)

## Tóm tắt

Nửa **hậu cần** của Tiểu Linh 2 đã chạy trên bot kit. Nửa **lễ tân** (nhận sự cố qua chat, hỏi cho đủ, xác nhận, tạo ticket, ghi thêm vào ticket đã có) vẫn chỉ tồn tại ở bản legacy, trong một file 3.348 dòng (`pipeline.ts`) với 77 kịch bản test, mỗi kịch bản là một sự cố thật đã vá. RFC này đề xuất:

1. **Kiểm kê** toàn bộ hành vi lễ tân của legacy (mục 1), kèm mức core đã phủ và độ lớn khoảng trống, để "không mất hành vi" là một danh sách kiểm được chứ không phải cảm giác.
2. **Kiến trúc đích** (mục 2 và 3): máy trạng thái tất định nằm ở core; LLM chỉ ở các cổng trích xuất, soát thông tin, đọc lệnh; phần riêng của từng bot là **dữ liệu** (catalog, luật ưu tiên, chữ, danh sách soát) cộng vài hàm nhỏ. Một khai báo chạy được ở **hai host**: standalone (Telegram trực tiếp) và OpenClaw-hosted (MCP tool, giữ nguyên plugin và persona như legacy).
3. **So sánh bóng** (mục 4): đánh giá **từng lượt** với bản ghi Tiểu Linh 1 làm ngữ cảnh, để lệch ở lượt này không làm hỏng mọi lượt sau; kèm các chỉ số quyết định sẵn sàng.
4. **Chuỗi 17 PR nhỏ** và kế hoạch chuyển (mục 5 và 6), có tiêu chí chấp nhận, test legacy được port, canary và hoàn nguyên.

## Bối cảnh: hiện trạng đã đo

- Lễ tân legacy: `IntakeStepPipeline` (một lượt hội thoại = một lời gọi `step`), tool MCP `intake_step` bọc nó, agent OpenClaw chỉ chuyển nguyên văn `voiceText`. Quyết định nghiệp vụ nằm ở code, không ở prompt (nguyên tắc của repo, xem AGENTS.md).
- Core đã có `IntakeEngine` (`packages/core/src/intake/engine/engine.ts`, 858 dòng, 23 test). Báo cáo `packages/core/docs/parity/ENGINE.md` ghi engine tái hiện **13 trên 77** kịch bản của `pipeline.flow.test.ts`, và nêu 3 mục cố ý không tái hiện (độ chính xác trích xuất, ticket tương tự KG/Onyx, ping cổng thời gian thực). Engine là bản rút gọn: chưa có tách báo cáo, huỷ/đóng ticket, soát danh sách, hỏi lý do xin gấp, chốt tiêu đề, và còn nhiều nhánh khác (bảng ở mục 1).
- `defineBot({ receptionist })` hiện **chỉ kiểm hình dạng**; `createBot` ghi cảnh báo "declared-not-running" (`packages/core/src/bot/create.ts`). Các trường `catalog`, `priorityRules`, `extractor` còn kiểu `unknown` (`packages/core/src/bot/define.ts`).
- Core **chưa có** nhận tin Telegram vào theo kiểu tự thăm dò (`getUpdates`): chỉ có gửi tin, tải media, và một đường webhook `/telegram-webhook` dành cho nút "Đã ổn" và trả lời tự do (`packages/core/src/telegram/reporter-inbound.ts`). Hôm nay Telegram vào bot qua OpenClaw.
- Hệ thống chạy bóng (ADR-0005) hôm nay **chưa kiểm được engine mới**: gateway trên Colab chạy chính MCP legacy (`apps/tieulinh-legacy/mcp/tieulinh/index.ts`, xem `tools/tl2-shadow/colab/render-config.ts`) với model khác và dự án TECH2. Nó so "Tiểu Linh 1 với chính code đó trên model khác", không phải "Tiểu Linh 1 với lễ tân mới". Cặp `pairs.jsonl` chỉ có chữ: không có nút, không có kết quả tool (hook `after_tool_call` chỉ lấy tên tool và tham số).

## Mục tiêu và không phải mục tiêu

Mục tiêu:

1. `apps/tieulinh` thay legacy ở nửa lễ tân mà **không mất hành vi nhìn thấy được** (chữ, nút, thứ tự hỏi, quyết định hỏi hay ghi, nội dung ticket).
2. Bot mới (OP, PO, CM) khai báo lễ tân **chủ yếu bằng dữ liệu**; thứ gì dùng lại được nằm ở core.
3. Mọi lần so sánh với legacy **đo được và lặp lại được** (offline trước, bóng sau, canary cuối).
4. Mỗi bước nhỏ, tự kiểm được, có đường lui.

Không phải mục tiêu: sửa hành vi legacy (đóng băng); thay OpenClaw; cho LLM quyết định nghiệp vụ; port KG/Onyx/Memgraph (ADR-0007, xem mục 7 và câu hỏi 4); đổi nội dung nghiệp vụ nào của Tiểu Linh trong RFC này (mọi thay đổi hành vi đi qua PR riêng có ADR).

## 1. Kiểm kê hành vi lễ tân của legacy

### Cách đọc

Đường dẫn rút gọn. `L/` là `apps/tieulinh-legacy/`, `C/` là `packages/core/src/`. Tên file trần là tên cuối trong bảng tra dưới đây.

| Tên rút gọn | Đường dẫn đầy đủ |
|---|---|
| `pipeline.ts` | `apps/tieulinh-legacy/lib/intake-step/pipeline.ts` (3.348 dòng; hàm là phương thức của `IntakeStepPipeline`) |
| `extractor.ts`, `extractor-schema.ts` | `apps/tieulinh-legacy/lib/intake-step/extractor.ts`, `apps/tieulinh-legacy/lib/intake-step/extractor-schema.ts` |
| `merger.ts` | `apps/tieulinh-legacy/lib/intake-step/merger.ts` |
| `multi-incident.ts` | `apps/tieulinh-legacy/lib/intake-step/multi-incident.ts` |
| `tech-review.ts`, `checklist-review.ts` | `apps/tieulinh-legacy/lib/intake-step/tech-review.ts`, `apps/tieulinh-legacy/lib/intake-step/checklist-review.ts` |
| `ticket-reply-router.ts` | `apps/tieulinh-legacy/lib/intake-step/ticket-reply-router.ts` |
| `identifier-grounding.ts` | `apps/tieulinh-legacy/lib/identifier-grounding.ts` |
| `supplement-notifier.ts` | `apps/tieulinh-legacy/lib/itsaplan/supplement-notifier.ts` |
| `intake-document/` | `apps/tieulinh-legacy/lib/intake-document` (kiểu `IntakeDocument`, `IntakePacket`, kho) |
| `ask-learning/` | `apps/tieulinh-legacy/lib/ask-learning` |
| `buttons.ts` | `apps/tieulinh-legacy/lib/telegram/buttons.ts` |
| `intake-step tool` | `apps/tieulinh-legacy/mcp/tieulinh/tools/intake-step.ts` |
| `iris-tuong-tac`, `xac-nhan-xong` | `apps/tieulinh-legacy/openclaw-plugin/iris-tuong-tac/index.mjs`, `apps/tieulinh-legacy/openclaw-plugin/xac-nhan-xong/index.mjs` |
| `domain/` | `apps/tieulinh-legacy/mcp/tieulinh/domain` (catalog, luật, formatter) |
| `engine.ts` | `packages/core/src/intake/engine/engine.ts` |
| `ports.ts` | `packages/core/src/intake/ports.ts` |

Ba cột đánh giá:

- **Core**: `Đủ` (engine hiện có tái hiện và có test), `Một phần` (có khung nhưng thiếu nhánh), `Chưa` (không có).
- **Cỡ**: `S` (một PR nhỏ cho riêng mục), `M` (trọn một PR), `L` (nhiều PR hoặc cần quyết định riêng).
- **PR**: PR sẽ lấp (mục 5). `hoãn` nghĩa là ngoài chuỗi này (mục 7).
- **ADR**: ADR của Tiểu Linh trong `apps/tieulinh-legacy/docs/adr` (`0006` là quy tắc đóng/huỷ ticket, `0008` là mọi lần ghi vào ticket đã có phải được người báo xác nhận, `0010` là mô tả ticket là nguyên văn người báo) hoặc mã sự cố đã đo.

Tình trạng "core" dựa trên đọc `engine.ts`, `ports.ts` và danh sách test của engine, không phải suy đoán.

### 1.1 Vòng đời tờ khai (collecting đến tạo ticket)

| # | Hành vi | Legacy | Core | Khoảng trống | Cỡ | PR | ADR / sự cố |
|---|---|---|---|---|---|---|---|
| A1 | Thiếu trường bắt buộc: hỏi theo gate, nút chọn cho trường enum, một lượt tối đa số trường theo catalog, đếm số lần đã hỏi | `pipeline.ts` `collect` (Kịch bản B), `gateValues`, `variantOf` | Một phần: `engine.ts` `collect` + `intake/gate/gate.ts` | Câu hỏi không kèm nút (chỉ tóm tắt có nút); nhánh (`variant`) là hằng, legacy suy theo sản phẩm và từ khoá tài khoản | M | 6 | |
| A2 | Chưa có mô tả sự cố: chào, hoặc "đã nhận ảnh, mô tả giúp em" khi chỉ có ảnh | `collect` (nhánh `hasDescription`) | Chưa | Thêm trạng thái hỏi `short_description` | S | 6 | |
| A3 | Hỏi hệ thống đúng MỘT lần kèm nút, không rõ thì tóm tắt ghi "Chưa xác định" | `collect` (Kịch bản B') | Chưa | Luật "hỏi một lần" ngoài gate | S | 6 | |
| A4 | Xin gấp mà chưa nói lý do: hỏi lý do một lần; có lý do thì cho đúng mức xin (không hạ mức bằng chứng); trả lời "không có" thì giữ mức bằng chứng; lý do ghi vào ticket | `collect`, `describe` (`priorityReason`) | Một phần: `engine.ts` `resolvePriority` (chỉ nhận khi đã có lý do) | Câu hỏi lý do, trạng thái `priority_reason`, cắt 300 ký tự | S | 6 | quyết định 29/09 |
| A5 | Bộ phận ngoài danh mục: nói rõ "không có trong danh mục" thay vì hỏi lại y câu cũ | `collect` (`unrecognizedDept`), `extractor.ts` `detectUnrecognizedDept` | Chưa | Trường nháp mới + câu | S | 6 | |
| A6 | Tóm tắt xin xác nhận: tiêu đề, sản phẩm, hệ thống, mã khách hàng (không trùng tài khoản), tài khoản, bộ phận, phân loại lỗi, số tệp, mức ưu tiên tiếng Việt; không in `MEDIUM` | `collect` (Kịch bản C) | Một phần: `engine.ts` `summaryOutput` + `gate/recap.ts` | Mẫu tóm tắt riêng của Tiểu Linh (thứ tự trường, nhãn) | S | 13 | |
| A7 | Chốt xác nhận: chỉ chấp nhận khi đã hiện tóm tắt; xác nhận tới trong dưới 5 giây bị từ chối; bấm lại nút cũ khi đang chờ thì nhắc bấm nút xác nhận; trạng thái `confirmed` kẹt quá 2 phút thì nhả | `step`, `collect`, `CONFIRM_STALE_MS`, `MIN_CONFIRM_DELAY_MS` | Đủ: `intake/confirm/protocol.ts`, test "MIN_CONFIRM_DELAY_MS" | Nhắc "bấm lại nút cũ" (`callback_data:`) | S | 3 | model tự bấm 1,1 giây |
| A8 | Tạo ticket: giành quyền bằng revision nguyên tử, ghi `created` trước việc phụ, binding, tải ảnh, dọn nút và bản nháp cũ, lỗi tạo không lộ lỗi nội bộ và giữ tóm tắt để thử lại, idempotent khi bấm đôi | `createTicket` | Đủ: `intake/create/create-ticket.ts`, `binding-store.ts` | Cột Backlog/Unstarted theo cột dự án, nhãn theo phân loại lỗi: adapter đã có (`intake/adapter.ts`) | S | 13 | TECH-1013 |
| A9 | Huỷ rõ ràng: phiên mới (revision 0) hay đã gom thì câu khác nhau; xoá hàng đợi tách và câu hỏi tách đang treo; nhắc tờ khai bị gác | `collect` (`intent === "cancel"`), `appendParkedReminder` | Một phần: `engine.ts` `collect` huỷ nhưng **không trả tin nào** | Chữ huỷ, dọn trạng thái tách, nhắc gác | S | 3, 7 | |
| A10 | Tờ khai im quá 24 giờ thì hết hạn, tin mới mở tờ khai mới | `step`, `isExpired`, `INTAKE_DRAFT_TTL_MS` | Đủ: `engine.ts` `closeAndReopen` | | | | |
| A11 | Chốt tin vô nghĩa (TECH-1148): tin rỗng hoặc token nội bộ như `noop` không kèm ảnh bị bỏ; hành vi phụ thuộc trạng thái tờ khai (đã tạo, đang tạo, chờ xác nhận, đang gom, đã huỷ, đang hỏi tách) | `step` (`isMeaninglessInput`), `isInternalCallbackToken` (core) | Chưa trong engine (hàm nhận diện đã có ở `packages/core/src/core/channel-envelope.ts`) | Bảng phản hồi theo trạng thái | S | 3 | TECH-1148 |
| A12 | `/new`: ép sự cố mới, gác tờ khai đang dở; nút "Tiếp tục sự cố đang chờ" đưa tờ khai gác trở lại | `step` (`consumeChatFlag`), `resumeParkedDraft`, `appendParkedReminder` | Một phần: `engine.ts` có `forceNew` và `parkedDocId`; chưa có nút nhắc và resume | Nhắc + nút resume | S | 7 | ADR-0008 |
| A13 | "Không biết" / "không có" ghi vào `explicitlyMissing`, bot thôi hỏi trường đó; câu trả lời cho câu hỏi dữ kiện luôn vào mô tả dù chỉ là một mã | `collect`, `extractor.ts` `isDeclineAnswer`, `merger.ts` (`appendRawText`) | Một phần: gate có `explicitlyMissing`, engine không điền | Nhận diện từ chối + `appendRawText` | S | 3 | |
| A14 | Lệnh sửa tờ khai tường minh ("sửa tiêu đề thành …") thắng LLM, tiêu đề do người đặt bị khoá | `extractor.ts` `parseEditCommand`, `merger.ts` (`titleExplicit`) | Một phần: `ports.ts` có `titleExplicit` | Phân tích lệnh | S | 4 | |

### 1.2 Hội tụ thông tin và chống mất dữ liệu

| # | Hành vi | Legacy | Core | Khoảng trống | Cỡ | PR | ADR / sự cố |
|---|---|---|---|---|---|---|---|
| B1 | Mô tả ticket = nguyên văn người báo, cộng dồn qua các lượt, trần 4.000 ký tự mỗi tin và 8.000 tổng; `reporterText` nội bộ cho đối chiếu định danh | `merger.ts` (`rawText`), `pipeline.ts` `describe` | Đủ cho cộng dồn và trần: `engine.ts` `mergeIntoDraft`; mô tả: bên dưới | Trần theo số của legacy | S | 3 | ADR-0010 |
| B2 | Bỏ phong bì kênh OpenClaw khỏi tin trước mọi xử lý | `channel-envelope.ts` qua `pipeline.ts` `run` | Đủ: `packages/core/src/core/channel-envelope.ts`, `engine.ts` | | | | TECH-924 |
| B3 | Chốt tiêu đề: không bao giờ là tên người hay mã trần; thay bằng tiêu đề dự phòng từ lời báo (bỏ chào hỏi, tên, mã) hoặc "Sự cố kỹ thuật" | `multi-incident.ts` `isInvalidTitle`, `deriveFallbackTitle`, `merger.ts`, `pipeline.ts` `createTicket` | Chưa | Hàm thuần ngôn ngữ tiếng Việt, đưa vào core | M | 6 | TECH-1146 |
| B4 | Gộp trường: triệu chứng không trùng, bỏ ý người bảo gỡ, bằng chứng chỉ nới (cờ đã true thì giữ, phạm vi chỉ rộng ra), tin xác nhận/huỷ/cảm ơn chỉ gộp trường cấu trúc | `merger.ts` `mergeExtractedFields` | Một phần: `engine.ts` `mergeIntoDraft` (định danh chỉ điền chỗ trống, media gộp) | `structuredOnly`, `removeSymptoms`, bằng chứng đơn điệu | M | 6 | |
| B5 | Định danh xung đột với tờ khai đang mở: chỉ tính định danh **có nhãn** (Code, Mã KH, Mã HS, UID/SID/CID, mã CRM 7-10 số trọn dòng) và chỉ khi cùng lớp; tên người, SĐT, tài khoản, URL, mã phiếu không bao giờ là định danh; hỏi "Sự cố mới" hay "Bổ sung sự cố đang chờ" | `multi-incident.ts` `extractLabelledIdentifiers`, `identityConflict`; `pipeline.ts` `parkForNewIncidentDecision`, `resolvePendingNewIncident` | Một phần: `engine.ts` `detectPark`, `intake/engine/identifiers.ts` (so khớp chữ số của trường có sẵn) | Bản "có nhãn, cùng lớp" của vòng 2; trả lời không rõ thì hỏi lại; "thôi huỷ" bỏ tin vừa park | M | 7 | TECH-928 |
| B6 | Tờ khai đang hỏi dở (có tiêu đề, đang hỏi trường hoặc chờ xác nhận) mà tin mới là lời báo trọn vẹn thì cũng hỏi; không áp dụng khi đang trả lời câu hỏi dữ kiện hay mô tả | `collect` (`draftInProgress`) | Một phần: `engine.ts` `detectPark` (full-report park) | Ngoại lệ "đang trả lời câu hỏi" | S | 7 | E2E 28/09 |
| B7 | Tách báo cáo nhiều học sinh/sự cố trong một tin: hỏi "Tách N ticket / Gộp 1 ticket"; hiểu phủ định ("không tách"), "thôi/khỏi" trần là gộp; trả lời không rõ thì hỏi lại ĐÚNG MỘT lần rồi mặc định gộp, không bao giờ rơi nội dung; chọn tách thì xếp hàng, tạo lần lượt, kế thừa bộ phận; ảnh không chia mù (gắn mọi ảnh cho mọi ticket, bật `mediaAmbiguous` để mô tả nói rõ); gói tin hỗn hợp `createdIssue` + `nextDraft` | `multi-incident.ts` `splitMultiIncidentReport`, `extractBlockInfo`; `pipeline.ts` `parkForSplitDecision`, `splitQuestionPacket`, `resolvePendingSplit`, `handleUnclearSplitReply`, `mergeParkedSplit`, `createTicket` (hàng đợi) | Chưa | Toàn bộ | L | 8 | W29-SPLIT, TECH-1146 |
| B8 | Nhiều ticket đang mở cùng chat: mỗi ticket có nút riêng, ticket vừa tạo chỉ là gợi ý đầu | `pipeline.ts` `askAboutCreatedTicket`, `otherOpenTickets` | Chưa | Xem C3 | M | 10 | TECH-989/1001 |

### 1.3 Sau khi tạo ticket

| # | Hành vi | Legacy | Core | Khoảng trống | Cỡ | PR | ADR / sự cố |
|---|---|---|---|---|---|---|---|
| C1 | Tờ khai đã tạo là tờ khai ĐÓNG. Tin sau chỉ được: bổ sung (comment, không ghi đè mô tả), mở sự cố mới, cảm ơn, bấm lại nút. Phân loại ý định theo ngữ cảnh ticket đã tạo (chitchat, hủy, bổ sung, báo mới) | `step` (khối `status === "created"`), `extractor.ts` (`createdTicket`) | Một phần: `engine.ts` `routeExistingTicket` khi `created` | Chữ trả lời cho cảm ơn/huỷ/đã tạo; ngữ cảnh `createdTicket` trong `ExtractInput` | M | 9 | TECH-956 |
| C2 | Không bao giờ tự ghi vào ticket đã tạo, kể cả khi "chắc" là bổ sung: luôn hỏi bằng "Bổ sung vào TECH-X" / "Sự cố mới"; gõ "ticket mới ạ" hay "phụ huynh khác" = sự cố mới | `step`, `askAboutCreatedTicket`, `saysNewIncident`, `withTypedDetail` | Một phần: `engine.ts` (`pendingTicketAction` kiểu `suggest`) | Nhận diện "ticket mới ạ"; gộp chi tiết gõ tay vào tin đang chờ | M | 9 | ADR-0008, TECH-1013 |
| C3 | Tin mang định danh khác ticket vừa tạo thì hỏi chứ không ghi; ticket đã Done/Canceled thì từ chối lịch sự và hướng dẫn tạo mới (tin báo sự cố mới vẫn mở tờ khai mới) | `step`, `closedTicketRefusalMessage` (`supplement-notifier.ts`), `resolveIssueState` | Chưa | Cổng đọc trạng thái ticket + chữ từ chối | M | 9 | W29-NOTIFY |
| C4 | Ghi bổ sung: comment (không dựng lại mô tả), không đè định danh của ticket đã tạo, tải ảnh, nâng mức ưu tiên nếu xin gấp có lý do, gắn `@người xử lý` đúng người, báo trực ca | `appendFollowUp`, `supplement-notifier.ts` (`resolveSupplementMentionTarget`, `formatSupplementComment`, `notifyOnCallSupplement`) | Một phần: `ports.ts` `TicketActionExecutorPort` (chỉ khung) | Chọn người nhận mention, định dạng comment, nâng mức, báo trực ca | M | 9 | TECH-956 |

### 1.4 Lệnh nhắm vào ticket đã có (ADR-0008)

| # | Hành vi | Legacy | Core | Khoảng trống | Cỡ | PR | ADR / sự cố |
|---|---|---|---|---|---|---|---|
| D1 | Tìm ứng viên: mã nêu trong tin (`TECH-795`, `TECH_795`, `ticket 795`, `#795`), số trần chỉ tính khi đúng một ticket của chính người báo, ticket vừa tạo (24 giờ), ticket kỹ thuật vừa hỏi (route tin nhắn, 72 giờ, bỏ khi đang soạn dở) | `pipeline.ts` `routeToExistingTicket`, `ticket-reply-router.ts` `mentionedIdentifiers` | Một phần: `engine.ts` `buildCandidates`, `engine/text.ts` | Số trần, route 72 giờ, câu hỏi kỹ thuật làm ngữ cảnh | M | 10 | TECH-509, TECH-1001 |
| D2 | Đọc lệnh (append, edit, lookup, move, cancel_or_close, new, unclear) bằng LLM, có đường không LLM; "huỷ", "cảm ơn", "ok" không bao giờ là nội dung ghi | `ticket-reply-router.ts` `LlmTicketCommandInterpreter`, `stripSupplementCommandWrapper` | Một phần: `ports.ts` `TicketCommandInterpreterPort` (thiếu `cancel_or_close`, đường không LLM, bóc "bổ sung/update vào tick …") | | M | 10 | |
| D3 | Tra cứu: ticket của mình thấy tiêu đề, trạng thái, người xử lý, trao đổi gần nhất; ticket người khác chỉ thấy trạng thái | `lookupTicket`, `lastTechComment` | Một phần: `engine.ts` `lookup` | "Trao đổi gần nhất" | S | 10 | ADR-0008 §6 |
| D4 | Xem trước + nút xác nhận cho append/suggest/edit/move; nút "Huỷ"; nhắn việc khác thì bỏ bản xem trước và xử lý tin mới; gửi thêm ảnh khi đang chờ thì gộp, câu lệnh trần ("update vào tick TECH-1218") chưa có nội dung thì hỏi nội dung | `proposeTicketAction`, `resolvePendingTicketAction`, `executeTicketAction` | Một phần: `engine.ts` `previewAction`, `resolvePendingAction` (khớp nhãn nút chính xác) | Ma trận phản hồi khi đang chờ, bảo toàn ảnh, nút thay thế cho ticket khác | M | 10 | TECH-975, TECH-1013, TECH-1218 |
| D5 | Sửa: LLM lập thao tác, áp thử để xem trước cũ→mới, xác nhận thì kiểm lại nền (ticket đổi trong lúc chờ thì từ chối) rồi sửa và ghi comment dấu vết | `proposeEdit`, `ticket-reply-router.ts` `planEdit`, `applyEditOps` | Một phần: `engine.ts` + `ports.ts` (executor giao hết cho cổng) | Bộ lập thao tác sửa và so nền | M | 10 | ADR-0008 §5 |
| D6 | Chuyển ticket bot vừa tạo nhầm sang ticket khác ("cái này bổ sung cho TECH-Y"): chép nội dung, nối link trùng, huỷ bản nhầm | `executeTicketAction` (kind `move`) | Một phần: `engine.ts` (`move_created`) | Link `duplicates`, huỷ nguồn, đóng tờ khai | S | 10 | ADR-0008 §7 |
| D7 | Quyền sở hữu: binding cùng chat (kể cả ticket bot cũ) hoặc mô tả chứa ID Telegram của người đó | `isOwnTicket`, `apps/tieulinh-legacy/lib/itsaplan/ownership.ts` | Một phần: `ports.ts` `bindingOwnershipPort` (chỉ binding mới nhất) | Binding nhiều ticket, quy ước mô tả | S | 10 | ADR-0008 §4, §6 |
| D8 | Huỷ/đóng theo yêu cầu người báo: nói rõ "hủy/bỏ/không cần nữa" thì Canceled; nói "đóng" thì Done nếu ticket đã Resolved hoặc có từ 3 bình luận của chuyên viên, không thì Canceled; ticket đã Done/Canceled thì không chuyển lại; luôn qua xác nhận một chạm ("Hủy TECH-X" hoặc "Đóng TECH-X" và "Giữ lại"); không phải chủ ticket thì từ chối; ghi comment lý do đã escape | `proposeCancelOrClose`, `countSpecialistComments`, `ticket-reply-router.ts` (`classifyCancelOrCloseIntent`, `countSpecialistTimelineComments`, `MIN_SPECIALIST_COMMENTS_FOR_DONE`), `executeTicketAction` | Chưa | Toàn bộ | M | 11 | ADR-0006 (cập nhật 10/10), TECH-951, TECH-999 |
| D9 | Tra cứu tiến độ không nêu mã: ticket gần nhất của chính chat, chỉ tính trong 30 phút | `apps/tieulinh-legacy/mcp/shared/tools/identity.ts` (`latestTicket`), tool `get_issue`, skill `check-status` | Một phần: `ChannelBindingStore.getLatestBinding` | Đưa vào engine thay vì tool riêng (hoặc giữ tool) | S | 10, 15 | |
| D10 | Trả lời của người báo vào tin thông báo (nút "Đã ổn", reply tự do) chỉ ghi comment | `apps/tieulinh-legacy/worker/ticket-closure.ts`, plugin `xac-nhan-xong` | Đủ: `apps/tieulinh/reporter.ts`, `packages/core/src/telegram/reporter-inbound.ts` | | | | ADR-0006 |

### 1.5 Trích xuất, soát thông tin, ưu tiên

| # | Hành vi | Legacy | Core | Khoảng trống | Cỡ | PR | ADR / sự cố |
|---|---|---|---|---|---|---|---|
| E1 | Lược đồ trường (ý định, tiêu đề, triệu chứng, danh mục đóng của sản phẩm/hệ thống/loại lỗi/bộ phận/thiết bị, định danh, xin ưu tiên, bằng chứng ưu tiên) | `extractor-schema.ts` | Một phần: `ports.ts` `ExtractedFields` (trung lập, danh mục đóng là dữ liệu catalog) | Sinh lược đồ zod từ catalog, đưa vào `extract` của core | M | 4 | |
| E2 | Chuẩn hoá: từ đồng nghĩa hệ thống/bộ phận về danh mục, bộ phận chỉ nhận khi tin nhắc tới, luật SĐT (10 số 03/05/07/08/09 là tài khoản/SĐT phụ huynh, không phải mã KH), tiêu đề không được là tên/mã | `extractor.ts` (`SYSTEM_SYNONYMS`, `DEPT_SYNONYMS`, `deptMentioned`, `normalizeWithSynonyms`) | Một phần: `intake/gate/normalize.ts` | Bộ chuẩn hoá sau LLM | M | 4 | TECH-1146 |
| E3 | Suy ý định tĩnh: xác nhận, huỷ, cảm ơn, từ chối trả lời, bổ sung, báo lỗi (không cần LLM; "ok", "không vào được lớp" không phải huỷ) | `extractor.ts` `isShortConfirmation`, `isExplicitCancel`, `isDeclineAnswer`, `isChitchat` | Chưa | Mô-đun heuristic tiếng Việt dùng chung | M | 4 | |
| E4 | Bù bằng chứng ưu tiên khi LLM im; cụm rõ ràng thắng cờ `false` mặc định của model | `extractor.ts` `inferEvidence` | Một phần: `intake/priority/priority.ts` (luật), chưa có bù | Hàm bù | S | 4 | |
| E5 | LLM chết hết chuỗi model dự phòng thì KHÔNG bịa tiêu đề; có chuỗi model dự phòng | `extractor.ts` (`FieldExtractor`), `apps/tieulinh-legacy/worker/llm.ts` | Một phần: `packages/core/src/llm/extract.ts` (sửa JSON, hỏi lại một lần); chưa có chuỗi model | Tín hiệu "LLM không dùng được" và chuỗi dự phòng | S | 4 | 07/10 |
| E6 | Ngữ cảnh gửi LLM: tiêu đề và triệu chứng tờ khai (trần 1.500 ký tự), câu hỏi kỹ thuật vừa hỏi, ticket vừa tạo (trần tin 4.000 ký tự) | `pipeline.ts` `contextOf` | Một phần: `ExtractInput.draftTitle` | `ExtractInput.context` | S | 3 | |
| F1 | Soát bằng LLM "con mắt kỹ thuật viên": tối đa 3 dữ kiện, hỏi MỘT lượt, trả lời gì (kể cả "không có") cũng đi tiếp, lỗi/quá 15 giây coi như đủ; dùng hướng dẫn `tech-info-needs.md` (209 dòng) | `tech-review.ts` `LlmTechReviewer`; `pipeline.ts` (Kịch bản B'') | Đủ về cổng: `ports.ts` `TechReviewerPort`; `engine.ts` | Cài đặt LLM + nút "Không có" + `techQuestion` làm ngữ cảnh | M | 12 | TECH-759, TECH-722 |
| F2 | Soát bằng danh sách cố định (10 mục, hỏi hết một tin, bỏ qua sự cố không thuộc TECH như chấm công, lương) | `checklist-review.ts` `buildChecklist`, `ChecklistTechReviewer` | Chưa | Mục dữ liệu + hàm thuần | M | 12 | 16/10 |
| F3 | Tự học (W25): mục người báo hay phải bổ sung theo hệ thống, học từ bình luận kỹ thuật viên, sắp theo tỉ lệ, kho riêng (`ASK_LEARN_DB`), script nạp | `ask-learning/`, `apps/tieulinh-legacy/scripts/ask-learn.ts` | Chưa | Cổng `learned(system)` (dữ liệu do script ngoài sinh) | M | 12 | W25 |
| F4 | Công tắc soát: `TECH_INFO_REVIEW` (tắt / danh sách / LLM) | `apps/tieulinh-legacy/mcp/tieulinh/index.ts` | Chưa | Chính sách khai báo | S | 12 | |
| G1 | Bảng luật ưu tiên (sàn nâng, trần chặn, sàn thắng khi bằng) | `evaluatePriorityRules` (đã ở core), `domain/` `urgency-rules.json` | Đủ: `packages/core/src/intake/priority/priority.ts` | Dữ liệu của Tiểu Linh sang app | S | 13 | |
| G2 | Xin gấp sau khi đã tạo ticket có lý do thì nâng mức trên ticket + comment lý do | `appendFollowUp`, `executeTicketAction` | Chưa | Xem C4 | S | 9 | 29/09 |

### 1.6 Người báo, ticket tương tự, media

| # | Hành vi | Legacy | Core | Khoảng trống | Cỡ | PR | ADR / sự cố |
|---|---|---|---|---|---|---|---|
| H1 | Danh tính người báo: kiểm tra, đăng ký (`requireApproval: false` cho Tiểu Linh), mã nhân sự, relink khi đổi tài khoản | `apps/tieulinh-legacy/mcp/shared/tools/identity.ts`, `apps/tieulinh-legacy/lib/storage/identity-repository.ts` | Đủ về lõi: `packages/core/src/identity` (service, relink, tools) | Nối vào lễ tân: ghi `reporter` vào tờ khai và binding (`reporterUserId`) | S | 14, 15 | |
| H2 | Binding ticket với chat, người báo, tuyến tin nhắn (cho hậu cần) | `bindIssueToChat` (`mcp/shared/tools/create-issue.ts`), `apps/tieulinh-legacy/lib/storage/binding-repository.ts` | Đủ: `intake/create/binding-store.ts`, `intake/notify/stores.ts` | **Không tương thích file chung với legacy**, xem mục 6 | M | 15 | |
| I1 | Ticket tương tự lúc gom (Onyx, khi triệu chứng đổi, lưu trong tờ khai) | `collect` (`searchSimilar`) | Chưa | Cổng, không hiển thị cho người báo | hoãn | | ADR-0007 |
| I2 | Sau khi tạo (chạy nền, không chặn câu trả lời): KG + Onyx + BM25 + LLM xác minh từng cặp, ghi Related Tickets và link chỉ với cụm KG, comment gợi ý của bot (đánh dấu `markBotComment`), ping cổng thời gian thực | `runSimilarTicketsInBackground`, `linkSimilarTickets`, `apps/tieulinh-legacy/lib/kg` | Chưa, và `ENGINE.md` cố ý để ngoài: chỉ có `PostCreateHookPort` | Toàn bộ | L | hoãn | ADR-0007, ADR-0010 |
| J1 | Media: gom đường dẫn, bỏ trùng, tin chỉ có ảnh không làm sập, tải lên ticket, nối link vào mô tả; `mediaAmbiguous` khi tách | `step`, `collect`, `createTicket`, `apps/tieulinh-legacy/lib/itsaplan/upload.ts` | Một phần: `ports.ts` `MediaResolver`, `adapter.ts` `attach`, `packages/core/src/telegram/media.ts` | Tải ảnh Telegram thật (`getFile`) ở host standalone | M | 13, 16 | TECH-637 |

### 1.7 Kênh, nút bấm, văn bản

| # | Hành vi | Legacy | Core | Khoảng trống | Cỡ | PR | ADR / sự cố |
|---|---|---|---|---|---|---|---|
| K1 | Hợp đồng nút: `{ text, callbackData }`, `callbackData` tối đa 64 byte UTF-8 (nút vượt thì cả tin không gửi được), nhãn xác nhận cố định | `buttons.ts`, `packages/core/src/intake/gate/types.ts` | Đủ: `intake/gate/buttons.ts`, `packages/core/src/openclaw/pending-buttons.ts` | | | | 14/09 |
| K2 | Nút ra Telegram qua file nút chờ; plugin gắn nút vào tin ra, dọn chữ khi đã có nút, **khoá nút sau khi bấm** (thu gọn còn đúng nút đã chọn), chỉ gắn nút xác nhận vào tin có dạng tóm tắt (kiểm bằng biểu thức chính quy trên chữ), không gắn vào tin báo đã xong | `iris-tuong-tac` | Một phần: file nút chờ ở core (`pending-buttons.ts`); plugin vẫn ở legacy | Host standalone phải tự khoá nút (`editMessageReplyMarkup`) | M | 15, 16 | |
| K3 | Token callback nội bộ (`noop`) bị nuốt và trả `answerCallbackQuery`; callback trùng trong 10 giây bị bỏ | `iris-tuong-tac` (`before_dispatch`) | Chưa | Cả hai ở host standalone; ở OpenClaw giữ plugin | S | 16 | TECH-1148 |
| K4 | `/new` bị OpenClaw nuốt: plugin bắt ở `before_dispatch` và gọi `POST /internal/force-new` để đặt cờ; `reporter_ok`, `reply_to` bắt trước LLM | `xac-nhan-xong` | Một phần: `packages/core/src/itsaplan/webhook/server.ts` có `ForceNewHandler`, nhưng `backoffice.inbound` chưa mở đường `forceNew` | `inbound.forceNew` | S | 15 | ADR-0008 |
| K5 | Lệnh và tin tĩnh: `/start` chào, `/help` hướng dẫn, `/reset` làm mới phiên; quy tắc persona (một lượt một tin, không nghĩ thành tiếng, không `NO_REPLY`, thuần Việt) | `apps/tieulinh-legacy/skills/tieulinh/messages`, `apps/tieulinh-legacy/skills/tieulinh/AGENTS.md` | Chưa | Persona là việc của OpenClaw; standalone cần lớp lệnh và khoá chữ | S | 15, 16 | |
| K6 | Chữ gửi người báo: khoảng 70 dòng chuỗi trong `pipeline.ts`, cộng `supplement-notifier.ts`, 14 dòng hỏi của `checklist-review.ts` (`ask-learning/items.ts`), hàng chục mục mẫu trong `domain/` | nhiều nơi | Một phần: `CopyKey` có 25 khoá (`ports.ts`), chữ mẫu ở `packages/core/examples/tieulinh/copy.ts` | Mở rộng `CopyKey` hoặc nhóm chữ có tham số; **kiểm bằng bản ghi vàng** (mục 5) | L | 13 | |

Tổng kết khoảng trống: các mục nặng nhất (cỡ `L` hoặc `M` mà core còn `Chưa`) là tách báo cáo B7, huỷ/đóng D8, chốt tiêu đề B3, soát danh sách F2/F3, trích xuất E1-E5, chữ K6 và KG I2; còn lại chủ yếu là bổ sung nhánh vào engine. Hầu hết nhánh của `pipeline.ts` bám vào **một sự cố có mã**, nên mỗi PR port đúng các test mang mã đó (mục 5).

## 2. Kiến trúc đích

### 2.1 Ranh giới: máy trạng thái ở core, LLM ở rìa

```text
 kênh (Telegram qua OpenClaw hoặc trực tiếp)
        |  tin, ảnh, nút                           <- host: chuẩn hoá thành StepInput
        v
 StepInput --> [ tiền xử lý tất định ]             bỏ phong bì, nuốt token nội bộ, gom media
        |
        v
 [ extractor ]        cổng LLM #1: văn bản -> ExtractedFields (lược đồ zod từ catalog), có đường không LLM
        |
        v
 [ máy trạng thái ]   TẤT ĐỊNH: gate, ưu tiên, park/split, xác nhận, ticket đã có, huỷ/đóng
        |   cổng LLM #2 TechReviewer (hỏi một lượt)      cổng LLM #3 CommandInterpreter / EditPlanner
        v
 StepOutput { outcome, messages[ { text, buttons } ], issue? }   <- chữ lấy từ CopyCatalog, không LLM
        |
        v
 [ hiệu ứng ] chỉ qua cổng: Tracker (tạo/ghi, sau xác nhận), Binding, Media, PostCreateHook
```

Quy tắc, bám nguyên tắc của repo ("logic tất định ở tool và engine; prompt chỉ lo diễn đạt"):

1. **Câu chữ gửi người báo không do LLM sinh.** Mọi chuỗi là `CopyCatalog`. Ngoại lệ duy nhất là câu hỏi dữ kiện của `LlmTechReviewer` (legacy hiện làm vậy); ở bản mới nó là cổng tuỳ chọn và có bản danh sách cố định không LLM.
2. **LLM chỉ ở ba cổng**, mỗi cổng có hợp đồng, thời hạn, và đường lùi tất định: lỗi hay hết giờ thì `extractor` rơi về heuristic, `TechReviewer` rơi về "đủ", `CommandInterpreter` rơi về luật theo mã nhắc (đúng như legacy).
3. **Không ghi vào ticket đã có nếu chưa có một cú bấm khớp nhãn nút chính xác** (ADR-0008), **không tự xác nhận thay người báo**, **mô tả ticket là nguyên văn** (ADR-0010), **không bao giờ ghi đè định danh của ticket đã tạo**. Đây là các bất biến, mỗi cái có test mang tên sự cố gốc.
4. **Một lượt, một khoá chat**: tuần tự theo chat (đã có `withChatLock` ở `packages/core/src/intake/confirm/lock.ts`).
5. **Hiệu ứng ra ngoài chỉ qua cổng** (tracker, binding, media, hook sau khi tạo). Engine không biết Telegram, OpenClaw, itsaplan.

Trạng thái bền là `IntakeDraft` (bảng `intake_documents` do `intakeApplySchema` tạo). Draft hiện tại thiếu các trường mà legacy giữ: hỏi lần cuối (`lastAskedFields`), `requestedPriority`, `techReviewDone`/`techQuestion`, `unrecognizedDept`, `pendingSplit` (kèm hàng đợi, `extraText`, `clarifyCount`), `mediaAmbiguous`, các trường `pendingNewIncident` đầy đủ, `parkedDocId` đã có, và dấu của việc nền. PR 3 thêm các trường này theo kiểu **cộng thêm, có phiên bản**, đọc được bản draft cũ.

### 2.2 Cắm vào `defineBot`

Hôm nay `receptionist` chỉ có bốn trường lỏng kiểu (xem `packages/core/src/bot/define.ts`). Đề xuất (chưa tồn tại, tên chỉ để thảo luận):

```ts no-check
// ĐỀ XUẤT. Chưa có trong code; không dùng làm tham chiếu chữ ký.
export default defineBot({
  id: "tieulinh",
  tracker: { team: "tech", project: "TECH" },
  persona: copyVi,                              // CopyCatalog đầy đủ cho lễ tân
  receptionist: {
    channels: [telegram({ account: "ticket" })], // chỉ host standalone dùng; host OpenClaw bỏ qua
    intake: {
      catalog,                                  // FieldCatalog: nhánh, trường, enum, câu hỏi (DỮ LIỆU)
      variant: variantOf,                       // hàm nhỏ: giá trị đã gom -> khoá nhánh (hoặc hằng)
      priority: urgencyRules,                   // DỮ LIỆU: sàn, trần theo bằng chứng
      extractor: llmExtractor({ vocab, synonyms, instruction }),
      review: checklistReview({ items, learned }), // hoặc llmReview({ guide }), hoặc không
      policy: {                                 // số, không phải code
        draftTtlMs: 24 * 3_600_000,
        minConfirmDelayMs: 5_000,
        followUpMaxChars: 4_000,
        closeMinSpecialistComments: 3,
      },
    },
    existingTickets: {                          // ADR-0008
      ownership,                                // hàm: binding và quy ước mô tả
      commands: llmCommands(),                  // hoặc luật theo mã nhắc
      editPlanner,                              // cổng LLM #3
    },
    identity: { requireApproval: false },
    afterCreate: [],                            // PostCreateHookPort (KG, ingest: ngoài RFC này)
  },
  backoffice: { /* như RFC 0001, không đổi */ },
});
```

Phân biệt rõ phần **dữ liệu** (mọi bot khác nhau ở đây) và phần **hàm** (rất nhỏ):

| Thành phần | Loại | Hôm nay ở đâu | Ghi chú cho bot mới (OP/PO/CM) |
|---|---|---|---|
| Catalog (nhánh, trường bắt buộc/nên hỏi, câu hỏi, enum, nhãn nút ngắn) | Dữ liệu JSON | `domain/` (`validation-rules.json`, `required_fields.json`, `product_mapping.json`) và `catalogFromValidationRules` ở legacy | PO (IRIS) đã khai kiểu "nhánh" qua `createCatalog` (`packages/core/src/intake/gate/catalog.ts`); đưa `catalogFromValidationRules` vào core để cả hai dạng nguồn đều ra một `FieldCatalog` |
| Luật ưu tiên | Dữ liệu JSON | `domain/urgency-rules.json` | Đã ở core |
| Từ vựng đóng và từ đồng nghĩa, hướng dẫn trích xuất | Dữ liệu | `extractor.ts` (`SYSTEM_SYNONYMS`, `DEPT_SYNONYMS`), `taxonomy.ts` | Bot mới chỉ cần JSON này |
| Chữ | Dữ liệu (`CopyCatalog`) | rải trong `pipeline.ts` | Mở rộng `CopyKey` có nhóm; app cung cấp chữ |
| Danh sách soát và mục tự học | Dữ liệu | `checklist-review.ts`, `ask-learning/items.ts` | Tuỳ chọn |
| `variant`, `ownership`, người nhận mention, định dạng mô tả ticket | Hàm nhỏ | `pipeline.ts` `variantOf`, `isOwnTicket`, `supplement-notifier.ts`, `ticket-formatter.ts` | Mặc định hợp lý ở core (nhánh hằng, sở hữu theo binding); chỉ ghi đè khi cần |
| Cổng LLM | Hàm do core dựng | `extractor.ts`, `tech-review.ts`, `ticket-reply-router.ts` | `llmExtractor` dùng `extract` của `@vuihoc/bot-core/llm` (có sẵn sửa JSON và hỏi lại một lần) |

Tiêu chí "chủ yếu bằng dữ liệu": một bot mới đạt khi lễ tân của nó chỉ gồm catalog, luật ưu tiên, chữ, vựng đóng, và nhiều nhất ba hàm mặc định bị ghi đè. Tiểu Linh là phép thử khó nhất (nhánh theo sản phẩm, soát danh sách, ticket đã có, huỷ/đóng); nếu Tiểu Linh khai được thì các bot đơn giản hơn khai được.

Đề xuất tách nhóm ngôn ngữ: các heuristic tiếng Việt tổng quát (E3, B3) thuộc core (mọi bot VuiHoc nói tiếng Việt), còn từ đồng nghĩa theo miền (E2) thuộc dữ liệu của app. Tên và vị trí subpath chưa chốt; không viết chữ ký ở RFC này.

### 2.3 Ánh xạ kết quả engine với hợp đồng `intake_step` của legacy

Persona và skill của OpenClaw (`apps/tieulinh-legacy/skills/tieulinh/skills/incident-intake/SKILL.md`) phụ thuộc vào tên `action` của `intake_step`. Giữ nguyên hợp đồng đó ở host OpenClaw để không đụng persona. Engine mới có `StepOutcome` riêng (15 giá trị, `packages/core/src/intake/engine/types.ts`); bảng ánh xạ:

| `action` của legacy | `StepOutcome` của core | Ghi chú |
|---|---|---|
| `ask_missing_field` | `asked` | cả hỏi bổ sung, hỏi lý do gấp, hỏi dữ kiện kỹ thuật |
| `clarify_intent` | thêm `clarify` | chưa có mô tả, câu lệnh trần chờ nội dung |
| `confirm_summary` | `summary` | |
| `awaiting_user_confirmation` | `too_soon` | cũng cho "bấm lại nút cũ" |
| `ask_new_or_continue` | `parked` | |
| `ask_split_or_merge` | thêm `split_question` | |
| `confirm_ticket_action` | `action_preview` | |
| `ticket_created` | `created` | gói hỗn hợp tách: thêm `next` |
| `post_create_update` | `action_done`, `not_owner`, thêm `closed_refusal` | |
| `lookup_result` | `lookup` | |
| `already_created` | `already_created` | |
| `canceled` | `action_canceled`, thêm `canceled` | |
| `create_failed` | `failed` | |
| `in_progress` | `in_progress` | `needs_resend` chỉ có ở core |

Hợp đồng này là phần của PR 3 (thêm kết quả, hàm ánh xạ, test bảng ánh xạ), không phải của host.

## 3. Hai host, một khai báo

Cùng một `receptionist` (mục 2.2) chạy ở hai host; khác nhau ở **ai nhận tin vào** và **ai vẽ nút**, không khác ở nghiệp vụ.

| Mối quan tâm | Host OpenClaw (như legacy) | Host standalone |
|---|---|---|
| Nhận tin Telegram | OpenClaw polling, agent LLM gọi tool | Bot tự nhận: webhook (có: `/telegram-webhook`) hoặc thăm dò `getUpdates` (**chưa có ở core**, PR 16) |
| Điểm vào engine | Tool MCP `intake_step` (đề xuất: cùng tên và lược đồ đầu vào) gọi `engine.step`; trả `voiceText`, `action`, `buttonsShown`, `agentInstruction` như hôm nay | Bộ chuyển `update` Telegram sang `StepInput`, gọi `engine.step` trực tiếp, không qua agent LLM |
| Nút bấm | Ghi file nút chờ (`packages/core/src/openclaw/pending-buttons.ts`); plugin `iris-tuong-tac` gắn, dọn chữ, khoá nút | `TelegramTransport.sendMessage` kèm bàn phím; khoá nút bằng `editMessageReplyMarkup`; `answerCallbackQuery` cho mọi nút |
| Chống bão callback, token `noop` | Plugin `iris-tuong-tac` | Lớp nhận update của host (K3) |
| `/new`, "Đã ổn", reply tự do | Plugin `xac-nhan-xong` gọi `POST /internal/force-new`, `/internal/reporter-ok`, `/internal/reporter-reply` (hai đường sau đã có ở `apps/tieulinh`); thêm `inbound.forceNew` | Lệnh `/new` xử lý trong lớp nhận; "Đã ổn" và reply đã có ở `createReporterInbound` |
| Persona, `/start`, `/help`, `/reset` | Workspace OpenClaw đồng bộ từ `apps/tieulinh-legacy/skills/tieulinh` | Khoá chữ trong `CopyCatalog` và lớp lệnh nhỏ |
| Tin tĩnh và quy tắc "một lượt một tin" | Persona buộc agent gửi nguyên văn `voiceText` | Không có agent nên không cần |
| Media | Đường dẫn do OpenClaw đặt vào phong bì; `MediaResolver` | `getFile` tải về thư mục tạm; cùng `MediaResolver` |
| Định danh người báo | Tool `check_identity`/`register_identity` của `packages/core/src/identity` (`identityTools`) | Lễ tân gọi `IdentityService` trước `step` (tên người báo, `reporterUserId`) |
| Chống chạy hai nơi | Gateway giữ một tiến trình MCP mỗi agent | **Một token Telegram chỉ có một bên nhận `getUpdates`**: bật standalone nghĩa là tắt OpenClaw polling cho tài khoản đó |
| Quan sát | Log MCP, hook shadow-forwarder | `/healthz` của bot kit, nhật ký kênh |

Quyết định đề xuất: **host OpenClaw là host production đầu tiên** (giữ plugin, persona, đường canary rẻ; chi tiết mục 6), host standalone vào sau khi có đường nhận `getUpdates` đã kiểm bằng Telegram giả rồi bằng bot thử thật. Lý do: chuyển host không đổi nghiệp vụ, nên tách hai rủi ro (nghiệp vụ mới, kênh mới) ra hai lần chuyển.

Hai tiến trình dùng chung kho: ở host OpenClaw, engine chạy trong tiến trình MCP (con của gateway) còn hậu cần chạy trong tiến trình bot; chúng chia một thư mục dữ liệu (SQLite WAL) như legacy (`INTAKE_DB_PATH`).

## 4. Tương thích bóng: so TL2 lễ tân với TL1

### 4.1 Bóng hôm nay cho gì và thiếu gì

- Plugin `shadow-forwarder` chỉ quan sát ba hook (`message_received`, `message_sent`, `after_tool_call`) và gửi tới relay (ADR-0005).
- Worker (`tools/tl2-shadow/worker.ts`) gọi gateway Colab bằng `POST /v1/chat/completions` với vài lượt trước của cùng chat (chữ người dùng và **câu trả lời của TL1**, `TL2_CONTEXT_TURNS`), rồi ghi `Pair` vào `pairs.jsonl`:
  `{ eid, ts, chatId, text, tl1: { reply, tools[] }, tl2: { reply, latencyMs, model, error } }`.
- Nút bấm của người dùng tới TL1 dưới dạng chữ `callback_data: <nhãn>`; **nút TL1 gửi ra không có** trong cặp; kết quả tool (tức `action` của `intake_step`) cũng không có.

Vì vậy bóng hôm nay chỉ so chữ trả lời, và đích của nó là code legacy. Muốn đo lễ tân mới phải thêm một **đích** (target) khác ở worker và mở rộng cặp.

### 4.2 Vấn đề lệch nhiều lượt

Lễ tân là máy trạng thái có bộ nhớ. Giả sử:

- Lượt 1: người dùng báo lỗi; TL1 hỏi **A** (bộ phận); TL2 hỏi **B** (hệ thống).
- Lượt 2: người dùng trả lời **A** ("bên Sale"). TL1 hiểu là bộ phận. TL2 đang chờ **B** nên đọc "Sale" thành hệ thống hoặc bỏ qua.

Từ đó trạng thái hai bên khác nhau và mọi lượt sau đều so táo với cam; lỗi của một lượt đầu làm hỏng cả chat. Tệ hơn: nút xác nhận mà người dùng bấm ở TL1 rơi vào TL2 khi TL2 chưa hiện tóm tắt, nên TL2 từ chối đúng theo thiết kế ("xác nhận khi chưa có tóm tắt"), và ta đọc nhầm đó là lỗi.

### 4.3 Chiến lược ba tầng

**Tầng 1 (cổng chính): đánh giá từng lượt, bản ghi TL1 làm ngữ cảnh ("ép quyết định").** Với mỗi lượt `t` của một chat:

1. Dựng trạng thái TL2 tại lượt `t-1` bằng cách chạy lại các tin người dùng trước đó qua **cùng** bộ trích xuất và bộ gộp của TL2 (để trường, định danh, rawText đúng như TL2 sẽ có), nhưng **ép nhánh điều khiển** theo cái TL1 đã làm: nếu TL1 hỏi trường A thì đặt `lastAskedFields = [A]`; nếu TL1 hiện tóm tắt thì đặt `ready_for_confirmation` và `summaryShownAt`; nếu TL1 hỏi tách/gộp, hay "sự cố mới hay bổ sung", thì đặt đúng trạng thái chờ đó; nếu TL1 tạo ticket thì đóng tờ khai.
2. Chạy `step(tin_t)` thật của TL2 trên kho **cô lập** (bản sao, không ghi ra ngoài; cổng tracker là bộ ghi nhận trong bộ nhớ) và so **đầu ra lượt `t`** với TL1.
3. Kết quả mỗi lượt độc lập với các lượt của TL2 trước đó: lệch ở `t` không lan sang `t+1`.

Cần hai thứ mà hôm nay chưa có, đều là việc của PR 5:

- **Bộ phân loại câu trả lời TL1** (`reply` → `action`): TL1 dùng chữ cố định nên nhận bằng neo chữ ("Em tóm tắt lại sự cố", "Em đã tạo thành công ticket", "em tách N ticket nhé", "SỰ CỐ MỚI hay bổ sung", "xác nhận giúp em", "đang ở trạng thái", "đang tạo ticket"...). Độ chính xác của bộ phân loại phải đo bằng **bản ghi vàng** (mục 5, PR 2): 100% trên mọi chuỗi vàng, nếu không thì bộ phân loại sai chứ không phải TL2 sai. Tuỳ chọn thêm (cần quyền sửa plugin legacy, xem câu hỏi mục 8): lấy `action` thật từ kết quả tool.
- **Bộ đọc tóm tắt TL1** (`reply` tóm tắt → trường): mẫu tóm tắt là cố định (`pipeline.ts` `collect`, Kịch bản C), nên đọc ngược được tiêu đề, sản phẩm, hệ thống, bộ phận, mã, mức ưu tiên, số tệp. Đây là chân lý TL1 tại lúc xác nhận, vì bóng không được đọc dự án TECH thật (proxy chỉ cho TECH2).

Đề xuất đường kỹ thuật (chỉ dùng cho công cụ bóng, không có trong đường chạy thật): engine nhận một `oracle` tuỳ chọn trả "hành động điều khiển bắt buộc" cho lượt quá khứ. Tên và chữ ký chưa chốt.

**Tầng 2 (thông tin, không chặn): chạy tự do.** TL2 chạy cả cuộc trò chuyện của riêng nó từ tin đầu. Ghi: điểm lệch đầu tiên, có hội tụ về cùng nội dung ticket cuối không, số câu hỏi và độ dài đường đi so với TL1. Dùng để đánh giá trải nghiệm, không dùng làm cổng, vì đã biết sẽ lệch.

**Tầng 3: xác nhận nới lỏng cho bóng ("shadow-relaxed confirm").** Khi bản ghi TL1 cho thấy người dùng đã xác nhận và TL1 đã tạo ticket:

- Đồng hồ giả của harness nhảy tới sau `minConfirmDelayMs`, và tóm tắt coi như đã hiện (không bắt TL2 phải tự hiện đúng lúc đó).
- Nếu cổng gate của TL2 **đủ** tại thời điểm này thì chạy tạo ticket trên bộ ghi nhận (hoặc dự án TECH2 qua proxy) và lấy **payload dự kiến**, so với tóm tắt TL1 (tầng 1).
- Nếu gate của TL2 **chưa đủ** thì **không ép**: ghi `tl2_stricter` với danh sách trường còn thiếu. Đó là phát hiện (TL2 hỏi thêm so với TL1), không phải xác nhận thất bại.
- Chưa bao giờ nới ba chốt an toàn: không tự xác nhận khi chưa có tin xác nhận của người dùng, không ghi vào ticket đã có khi không có bấm nút khớp, không đè định danh.

### 4.4 Phân loại lệch

| Lớp | Ví dụ | Xử lý |
|---|---|---|
| S0 (không an toàn) | TL2 ghi vào ticket đã có khi TL1 chỉ hỏi; tạo ticket khi người dùng chưa xác nhận; mất chữ người báo khỏi `rawText`; lộ phong bì kênh hoặc token `noop` vào ticket; đè định danh; huỷ/đóng ticket không phải của người báo | Chặn chuyển; sửa ngay, thêm test mang mã |
| S1 (hành vi) | Hỏi trường khác hoặc hỏi thêm; quyết định park, tách khác; mức ưu tiên, hệ thống, sản phẩm, bộ phận, định danh khác ở lúc xác nhận; số tệp khác | Đếm theo mã lý do; người soát gán nhãn "TL2 đúng", "TL1 đúng", "cả hai chấp nhận được" trên mẫu |
| S2 (bề mặt) | Câu chữ, tiêu đề khác nhưng hợp lệ, thứ tự câu hỏi | Chỉ đếm |

Cặp mở rộng (đề xuất, `v: 2`):

```json
{
  "v": 2, "eid": "…", "chatId": "…", "text": "…",
  "tl1": { "reply": "…", "action": "ask_missing_field", "summary": { "system": "…", "priority": "…" } },
  "tl2": { "target": "receptionist", "outcome": "asked", "reply": "…",
           "buttons": ["…"], "fields": { "system": "…" }, "latencyMs": 0, "error": null },
  "diff": { "class": "S1", "code": "asked_other_field", "tl1Field": "reporting_dept", "tl2Field": "system" }
}
```

### 4.5 Chỉ số quyết định sẵn sàng

Ngưỡng dưới đây là **đề xuất để chủ chốt** (câu hỏi 3); số mẫu tính trên cặp đã phân lớp.

| Chỉ số | Định nghĩa | Ngưỡng đề xuất |
|---|---|---|
| Phủ | Số lượt, số cuộc đi tới xác nhận, mỗi lớp `action` TL1 có mẫu | ít nhất 500 lượt và 120 cuộc tới xác nhận trong 7 ngày liên tiếp; lớp thiếu mẫu thì phủ bằng kịch bản vàng |
| M0, an toàn | Số lệch lớp S0 | **bằng 0** trong cả cửa sổ (cổng cứng) |
| M1, khớp hành động | Tỉ lệ lượt TL2 cho cùng lớp `action` với TL1 (tầng 1) | từ 95% tổng, không lớp nào dưới 90% |
| M2, nội dung ticket | Ở lúc xác nhận, khớp chính xác hệ thống, sản phẩm, bộ phận, mức ưu tiên, định danh, số tệp; `rawText` chứa đủ mọi tin người báo | trường tất định từ 97%; `rawText` đủ 100% |
| M3, độ thẩm vấn | Jaccard tập trường được hỏi; tỉ lệ TL2 hỏi điều TL1 không hỏi | từ 90% và không quá 5% |
| M4, quyết định rẽ | Khớp park/tách/gộp | từ 95% (số mẫu ít thì soát tay toàn bộ) |
| M5, bộ trích xuất | Tỉ lệ đầu ra hợp lệ lược đồ; khi LLM hỏng, không bịa tiêu đề | từ 99%; bịa tiêu đề 0 |
| M6, độ trễ | p90 thời gian một lượt của TL2 | không quá trung vị của TL1 (TL1 hiện 15 đến 50 giây mỗi lượt theo `docs/how-to/shadow-tl2.md`) |
| M7, vận hành | Sập, khởi động lại, `/healthz` không `ok` | 0 trong cửa sổ |

Với canary trên chat thật (mục 6) thêm chỉ số: tỉ lệ ticket do TL2 tạo bị người báo huỷ hoặc sửa hoặc chuyển trong 24 giờ không tệ hơn đường cơ sở của TL1 (đo từ lịch sử TL1, không phải từ bóng); số lần phải hoàn nguyên về TL1; số khiếu nại.

Tất cả bản ghi chat thật chỉ nằm ở máy dev (thư mục 0700) với thời hạn giữ 7 ngày của hàng đợi. Fixture đưa vào repo **bắt buộc** là dữ liệu tổng hợp, và `bun run scan` phải sạch (SECURITY.md).

## 5. Kế hoạch di trú: chuỗi PR nhỏ

Nguyên tắc: mỗi PR tự kiểm được, **không đổi gì ở production**, đi kèm test và docs (CI chặn nếu thiếu), sửa core thì ghi `packages/core/CHANGELOG.md`. Các PR 6 đến 12 cùng chạm `engine.ts` nên merge tuần tự (không song song). Tiến độ đo được bằng M1 của PR 5 sau mỗi PR.

**Hai cơ chế chống mất hành vi** dùng xuyên suốt:

1. **Sổ đối chiếu lễ tân** (giống `apps/tieulinh/gap-register.test.ts` của hậu cần): mỗi test legacy của lễ tân là một dòng, trỏ tới test mới có thật (`ported`/`core`) hoặc có lý do (`deferred`/`by-design`). Test chỉ giữ sổ khỏi nói dối.
2. **Bản ghi vàng**: một script ghi một lần (chạy trên legacy, dữ liệu tổng hợp) kịch bản vào/ra `(tin, action, voiceText, nút)` của từng kịch bản trong `pipeline.flow.test.ts` thành fixture JSON trong repo. Test của TL2 phát lại **đầu vào** và so **đầu ra** (chữ chính xác sau khi chuẩn hoá tham số). Nhờ đó "chữ, nút, thứ tự hỏi" được so máy-với-máy mà không import code legacy vào app mới.

| PR | Tiêu đề (đề xuất) | Làm gì | Tiêu chí chấp nhận | Test legacy được port |
|---|---|---|---|---|
| 1 | `docs(tieulinh): sổ đối chiếu test lễ tân legacy` | Test sổ cho mọi test lễ tân của legacy (77 flow, 17 multi-incident, 10 split-adversarial, 14 router, 21+3 soát, 11 định danh, các file test trích xuất, 6 noop, và các file còn lại trong thư mục test của lễ tân), mỗi dòng có trạng thái | Không dòng nào trùng; dòng `ported`/`core` trỏ tới test có thật; CI đỏ khi xoá/đổi tên một test mà quên cập nhật | Không port, chỉ lập sổ; cập nhật bảng `ENGINE.md` |
| 2 | `feat(core/testing): khung kịch bản hội thoại và bản ghi vàng` | `ScriptedChat` cho `engine.step` (kịch bản "tin vào, kỳ vọng ra") trong `@vuihoc/bot-core/testing`; script ghi vàng; fixture đầu tiên cho 6 kịch bản | Ghi vàng lặp lại được (bản ghi hai lần bằng nhau); `bun run scan` sạch; 6 kịch bản chạy trên engine hiện tại, báo rõ cái nào lệch | 6 kịch bản mẫu từ `pipeline.flow.test.ts` (xác nhận quá sớm, "ok" đầu tiên, tạo ticket, bấm đôi, huỷ rồi tin mới, hết hạn 24 giờ) |
| 3 | `feat(core/intake): draft v2 và chuẩn hoá đầu vào` | Thêm trường draft (mục 2.1) có phiên bản, đọc được draft cũ; chuẩn hoá đầu vào (tin vô nghĩa A11, từ chối A13, `appendRawText`); `ExtractInput.context`; `StepOutput` có nút cho câu hỏi; thêm các kết quả mới và ánh xạ `action` (mục 2.3); trần `rawText` theo legacy | Test migrate draft cũ; bảng ánh xạ có test; engine hiện có vẫn qua 23 test | `noop-guard.test.ts` (6), `repository.test.ts` của tài liệu (6), flow: "ok chưa tóm tắt", "không biết", "không vào được lớp không huỷ", "xác nhận hai lần", "phong bì", "tin dài" |
| 4 | `feat(core/intake): llmExtractor và heuristic tiếng Việt` | Bộ trích xuất dựa trên `extract` của core: lược đồ từ catalog, chuẩn hoá sau LLM (E2), suy ý định tĩnh (E3), bù bằng chứng (E4), tín hiệu LLM không dùng được không bịa tiêu đề (E5), lệnh sửa tờ khai (A14) | Với `FakeLlm`: lược đồ hợp lệ, từ đồng nghĩa, bộ phận chỉ khi nhắc, luật SĐT; "LLM chết" không ra tiêu đề; heuristic không phụ thuộc LLM | `extractor.test.ts` (2), `extractor-rules.test.ts` (21), `extractor-dept-system-title.test.ts` (12), `extractor-evidence.test.ts` (10) |
| 5 | `feat(tl2-shadow): replay lễ tân từng lượt và chỉ số sẵn sàng` | Mục tiêu `receptionist` ở worker: phân loại câu trả lời TL1, đọc tóm tắt TL1, dựng trạng thái ép quyết định (tầng 1), chạy tự do (tầng 2), tạo ticket nới lỏng (tầng 3); cặp `v: 2`; `compare.ts --metrics`; bộ nhớ đệm trích xuất để chạy lại offline | Bộ phân loại đúng 100% chuỗi vàng của PR 2; replay trên cặp tổng hợp ra đúng M0-M4; chạy lại hai lần cho cùng kết quả (nhờ bộ nhớ đệm); không đụng secret, ADR-0005 giữ nguyên | Không port; thêm kịch bản tổng hợp từ các sự cố TECH-928, TECH-1013 |
| 6 | `feat(core/intake): hỏi bổ sung theo luật` | A1-A5: nút cho trường, nhánh theo hàm `variant`, hỏi hệ thống một lần, hỏi lý do gấp một lần, bộ phận ngoài danh mục; B3 chốt tiêu đề; B4 gộp trường đầy đủ | Golden của các kịch bản liên quan khớp chữ và nút | flow: ưu tiên tiếng Việt, nhãn không lộ tên trường, mặc định Medium, bằng chứng urgent, 5 kịch bản "xin gấp", hệ thống một lần (2); `multi-incident.test.ts` phần tiêu đề (`isInvalidTitle`, `deriveFallbackTitle`) |
| 7 | `feat(core/intake): gác tờ khai khi có sự cố mới` | B5, B6, A12: định danh có nhãn cùng lớp, park, hỏi lại khi không rõ, "thôi huỷ", nút "Tiếp tục sự cố đang chờ", nhắc khi tạo hay huỷ, `/new` | Golden khớp; ba test "không mất dữ liệu bên nào" xanh | flow: nhóm TECH-928 (8), tờ khai bị gác (3), "tờ khai dở + lời báo trọn vẹn", "customerId không bị reground"; `identifier-grounding.test.ts` (11) |
| 8 | `feat(core/intake): tách báo cáo nhiều sự cố` | B7 đủ: bộ tách, câu hỏi, phủ định, hỏi lại một lần rồi gộp, hàng đợi, `mediaAmbiguous`, gói hỗn hợp `createdIssue` + `nextDraft` | Mọi test tách xanh, kể cả đối kháng; không có đường nào làm rơi chữ hay ảnh | `multi-incident.test.ts` (17), `split-adversarial.test.ts` (10), flow phần tách |
| 9 | `feat(core/intake): tin sau khi tạo ticket` | C1-C4, G2: ngữ cảnh ticket đã tạo, "ticket mới ạ", từ chối khi đã đóng, bổ sung bằng comment, nâng mức, cổng đọc trạng thái, người nhận mention, báo trực ca; nút theo từng ticket đang mở (B8) | Không có đường ghi nào không qua nút; golden khớp | flow: nhóm TECH-1013, nhóm nhiều ticket đang mở, "cảm ơn sau khi tạo", "bổ sung comment không ghi đè mô tả"; `pipeline.notify-supplement.test.ts` (6); `supplement-notifier.test.ts` (phần thuần), `pipeline.test.ts` (7) |
| 10 | `feat(core/intake): lệnh nhắm vào ticket đã có` | D1-D7, D9: ứng viên (số trần, route 72 giờ), đọc lệnh có đường không LLM, tra cứu, xem trước, ma trận khi đang chờ, sửa, chuyển ticket nhầm, sở hữu | Mọi ghi vào ticket đã có chỉ chạy khi khớp nhãn chính xác; người khác không bấm hộ | `ticket-reply-router.test.ts` (14), flow nhóm ADR-0008 (14) và TECH-1218, `own-tickets-confirm.test.ts` (6) |
| 11 | `feat(core/intake): huỷ và đóng ticket theo yêu cầu người báo` | D8 theo ADR-0006 bản 10/10 (xem câu hỏi 5) | Bảng quyết định Canceled/Done có test theo từng ô; "Giữ lại" không đổi gì | flow nhóm huỷ/đóng (8), phần phân loại của router |
| 12 | `feat(core/intake): soát thông tin (danh sách, LLM, tự học)` | F1-F4: `checklistReview` thuần dữ liệu, `llmReview` trên core `llm`, cổng `learned`, công tắc chính sách | Soát chỉ một lượt; mọi câu trả lời đi tiếp; lỗi không chặn tạo | `checklist-review.test.ts` (21), `tech-review.test.ts` (3), `ask-learning/` (`lookup`, `learned`), flow nhóm soát (6) |
| 13 | `feat(tieulinh): dữ liệu domain, chữ và định dạng ticket của lễ tân` | App `apps/tieulinh`: catalog, luật ưu tiên, vựng, chữ (`copy.ts`), mẫu tóm tắt, định dạng mô tả và comment gợi ý; `catalogFromValidationRules` vào core nếu chưa; test chống trôi dữ liệu với legacy cho đến khi xoá legacy | Chữ và tóm tắt khớp bản ghi vàng; mô tả ticket đúng ADR-0010 | `ticket-formatter.test.ts` (37), `create-issue-description.test.ts` (7), `rawtext-regression.test.ts` (5), `domain.test.ts` (12), `validate.test.ts` (7), `priority.test.ts` (7), `completeness.test.ts` (7) |
| 14 | `feat(core/bot): runtime lễ tân trong createBot` | Thay `unknown` bằng kiểu, `defineBot` kiểm catalog và chính sách (gom lỗi một chỗ), `createBot` dựng engine, `health` có thành phần lễ tân, bỏ cảnh báo "declared-not-running" | `defineBot` bắt lỗi khai báo; `createBot` không mạng; test health | Không port; `define.test.ts`, `create.test.ts` mở rộng |
| 15 | `feat(tieulinh): host OpenClaw cho lễ tân` | Tool MCP `intake_step` cùng hợp đồng; `inbound.forceNew`; nút qua file chờ; định danh qua `identityTools`; **bộ lưu binding tương thích với file legacy** (mục 6.2); kiểm hợp đồng với regex của plugin | Test hợp đồng (`action`, `buttonsShown`, `agentInstruction`); tóm tắt TL2 khớp biểu thức `iris-tuong-tac` quyết định gắn nút xác nhận; ghi/đọc binding hai chiều với bản schema legacy | `mcp/tieulinh/intake-step.test.ts` (1), `confirmation-and-binding.test.ts` (22, phần binding), `binding-repository.test.ts` (7), kiểm chéo `iris-tuong-tac` (12) và `xac-nhan-xong` (33) bằng cách gọi các hàm xuất ra của chính plugin |
| 16 | `feat(core/telegram): host standalone cho lễ tân` | Chuyển `update` thành `StepInput`; `getUpdates` có lưu offset (và đường webhook sẵn có); khoá nút sau bấm; `answerCallbackQuery`; chống bão callback 10 giây; nuốt `noop`; lệnh `/start`, `/help`, `/reset`, `/new`; tải media; khoá theo chat | Test với Telegram giả (như `transport.test.ts`); chạy thử bot thật trên nhóm thử; chưa bật production | `iris-tuong-tac` (nuốt `noop`, debounce, hàng rào gắn nút), `buttons.test.ts` (7), `alert.test.ts` (6), `media.test.ts` (5), `channel-envelope.test.ts` (5) |
| 17 | `docs(deploy): runbook shadow, canary và hoàn nguyên lễ tân` | Mở rộng `deploy/colab/cup-tieulinh.sh` cho lễ tân; hướng dẫn canary theo danh sách chat; kịch bản hoàn nguyên đã diễn tập | Diễn tập hoàn nguyên trên Colab; docs `how-to` mới | Không port |

KG, ingest, `related-curator` (mục 7) nằm ngoài chuỗi; sổ đối chiếu của PR 1 ghi chúng `deferred` có lý do.

## 6. Kế hoạch chuyển production và hoàn nguyên

### 6.1 Các giai đoạn

| Giai đoạn | Việc | Cổng để sang giai đoạn sau |
|---|---|---|
| 0 | PR 1 đến 17 đã merge; bản ghi vàng xanh | CI xanh; sổ đối chiếu không còn dòng trống ngoài `deferred` đã duyệt |
| 1a | **Replay offline** trên cặp đã có (hàng đợi giữ 7 ngày) | M0 bằng 0; M1 đủ ngưỡng trên dữ liệu thật |
| 1b | **Bóng trực tiếp**: lễ tân TL2 trên Colab ở TECH2, kênh nhật ký, không token Telegram; worker gọi đích `receptionist` song song TL1 | M0 đến M7 đạt trong 7 ngày liên tiếp |
| 2a | **Dogfood**: nhóm nội bộ nhắn thẳng TL2 (host OpenClaw, tài khoản thử, TECH2, hậu cần TL2) | Không S0; phản hồi người dùng nội bộ |
| 2b | **Canary chat thật** theo danh sách chat cho phép, host OpenClaw, **dự án thật `TECH`**; hậu cần vẫn là TL1 (mục 6.2); tăng dần danh sách | Chỉ số canary không tệ hơn đường cơ sở trong hai tuần |
| 3 | **Chuyển hết**: toàn bộ tài khoản `ticket` sang TL2 lễ tân; sau đó mới tính host standalone (một token một bên nhận `getUpdates`) và chuyển hậu cần theo RFC 0001 | Hai tuần ổn định; legacy chỉ còn là bản tham chiếu |

Mỗi giai đoạn có một **người ra quyết định** (chủ) và biên bản số liệu.

### 6.2 Hậu cần trong lúc canary: dùng chung binding với TL1

Lễ tân TL2 tạo ticket thật thì hậu cần **TL1** (webhook của `TECH`, đang chạy production) phải vẫn báo người báo khi ticket đổi trạng thái. Hậu cần biết "ticket này của chat nào" qua bảng `ticket_bindings` và `message_routes` của TL1. Hai thứ cần xử lý **trước** canary (PR 15):

- **Không dùng chung file tờ khai.** Core và legacy cùng đặt tên bảng `intake_documents` nhưng `state_json` có hình dạng khác (`IntakeDraft` và `IntakeDocument`). Tờ khai của TL2 phải ở file riêng.
- **Bảng binding không tương thích trực tiếp.** Ở legacy, `ticket_bindings` có `channel_type` và `message_id` bắt buộc (`apps/tieulinh-legacy/lib/storage/schema.ts`, ghi bởi `apps/tieulinh-legacy/lib/storage/binding-repository.ts`), còn `SqliteChannelBindingStore` của core (`packages/core/src/intake/create/binding-store.ts`) không điền hai cột này nên ghi vào file legacy sẽ vi phạm ràng buộc. Cần một bộ lưu binding tương thích (ghi `channel_type = telegram` và `message_id` giữ chỗ như `bindIssueToChat`) và test hai chiều trên cả hai dạng schema. Tuỳ chọn thay thế: TL2 ghi binding vào kho của mình và TL1 nhận qua một đường đồng bộ; không đề xuất vì thêm phần chạy.

Còn khi chuyển nốt hậu cần sang TL2 (giai đoạn 3), `apps/tieulinh` đã dùng kho riêng (`tieulinh-app.sqlite`), nên cần **nhập** các binding đang mở của TL1 một lần (script có thể chạy lại).

### 6.3 Tờ khai đang dở lúc chuyển

TL1 và TL2 giữ tờ khai ở hai kho khác nhau. Khi chuyển một chat từ TL1 sang TL2, tờ khai đang dở của TL1 không tự sang. Đề xuất: **không viết bộ nhập**; chuyển vào lúc ít tin, và với chat có tờ khai mở trong 24 giờ gần nhất thì chờ nó đóng (TTL 24 giờ) rồi mới đưa vào danh sách canary. Câu hỏi 2 cho chủ quyết nếu muốn khác.

### 6.4 Hoàn nguyên

| Tình huống | Hành động | Ghi chú |
|---|---|---|
| Canary (host OpenClaw) lỗi hoặc có S0 | Khôi phục `openclaw.json` bản sao lưu có dấu thời gian (OpenClaw nạp lại nóng, như bước cài plugin ở `docs/how-to/shadow-tl2.md`) để tool `intake_step` trỏ lại MCP legacy; bỏ chat khỏi danh sách | Ticket TL2 đã tạo vẫn hợp lệ: TL1 hậu cần xử lý nhờ binding dùng chung |
| Tờ khai TL2 đang dở khi hoàn nguyên | Người báo gửi lại; chỉ mất tờ khai chưa xác nhận | Báo trước cho nhóm canary |
| Chuyển standalone lỗi | Dừng bot TL2, bật lại polling của OpenClaw cho tài khoản `ticket`; Telegram giữ cập nhật chưa nhận khoảng một ngày | Một token chỉ một bên nhận: không bao giờ chạy cả hai |
| Hậu cần TL2 lỗi sau chuyển | Bật lại worker TL1 (đã tắt có kiểm soát, không xoá) | Theo RFC 0001 |

Không xoá, không sửa legacy cho tới khi ổn định hai tuần ở giai đoạn 3; không có migration phá dữ liệu.

## 7. Ngoài phạm vi, hoãn có chủ đích

- **KG, Onyx, Memgraph, `related-curator`, nạp tri thức, ticket tương tự lúc tạo** (I1, I2): ADR-0007 và ADR-0010 giữ nguyên; engine chỉ có cổng `afterCreate`. Chuyển lễ tân mà **không** có phần này nghĩa là mất comment gợi ý và Related Tickets lúc tạo ticket mới. Xem câu hỏi 4.
- Ping cổng thời gian thực (`127.0.0.1:8140`) của `runSimilarTicketsInBackground`: là hook phụ của một dịch vụ cạnh bên, sẽ là một `afterCreate` nếu cần.
- Host standalone ở production (giai đoạn 3 trở đi).

## 8. Rủi ro và câu hỏi cho chủ

### Rủi ro chính

| Rủi ro | Giảm thiểu |
|---|---|
| Mất hành vi ngầm: 3.348 dòng, mỗi nhánh một sự cố | Ba lớp: sổ đối chiếu (PR 1), bản ghi vàng (PR 2), replay chat thật (PR 5); mỗi PR port đúng test mang mã sự cố |
| Bóng hôm nay không đo engine mới (mục 4.1) | PR 5 thêm đích `receptionist`; không tin số liệu bóng cũ cho lễ tân |
| Va chạm schema và binding với TL1 (mục 6.2) | PR 15 có test tương thích hai chiều trước canary |
| Heuristic của plugin `iris-tuong-tac` phụ thuộc chữ của tin (nhận ra "tin tóm tắt" bằng biểu thức chính quy): đổi chữ tóm tắt là nút xác nhận biến mất | Test hợp đồng gọi hàm xuất của chính plugin (PR 15); bản ghi vàng giữ chữ |
| Bộ trích xuất bất định, khác model giữa TL1 và TL2 | Bộ nhớ đệm trích xuất để lặp lại; M2 đo trên trường tất định; M5 đo độ hợp lệ |
| Dữ liệu chat thật trong cặp bóng | Chỉ ở máy dev (0700), giữ 7 ngày; fixture trong repo luôn tổng hợp; `bun run scan` |
| Phụ thuộc sự cố `getUpdates` ở standalone (hôm nay không có ở core) | Tách khỏi lần chuyển đầu (host OpenClaw trước) |
| Phạm vi trượt sang KG | Nêu rõ ở mục 7; không có trong chuỗi PR |
| Người báo bị "ngắt" ở tờ khai dở lúc chuyển | Mục 6.3: chuyển lúc ít tin, danh sách canary, thông báo |

### Câu hỏi cần quyết

1. **Thứ tự host.** Đề xuất: host OpenClaw trước (giữ plugin và persona, canary theo chat), standalone sau. Nếu chủ muốn bỏ OpenClaw hẳn ngay từ đầu thì PR 16 đứng trước PR 15 và canary phải dùng một token Telegram riêng (nhóm thử); chi phí cao hơn.
2. **Tờ khai đang dở khi chuyển.** Đề xuất: không làm bộ nhập, chờ hết TTL 24 giờ (mục 6.3). Chấp nhận mất tờ khai chưa xác nhận trong vài chat, hay muốn bộ nhập từ kho TL1?
3. **Ngưỡng sẵn sàng.** Chốt (hoặc chỉnh) các ngưỡng ở mục 4.5, nhất là M0 bằng 0, M1 95%, cửa sổ 7 ngày và 500 lượt.
4. **KG và ticket tương tự khi chuyển.** Đề xuất: chuyển lễ tân **không** có phần này (ghi rõ phần mất đi), làm KG thành RFC riêng. Nếu chủ coi gợi ý lúc tạo ticket là bắt buộc thì phải thêm một RFC KG trước giai đoạn 2b.
5. **Huỷ/đóng ticket do người báo (ADR-0006 bản 10/10).** Legacy đang chạy đúng quy tắc này (Canceled/Done sau khi người báo xác nhận), trong khi trang [Tiểu Linh mới: hậu cần](/explanation/tieulinh-hau-can) nói bot không bao giờ chuyển cột. Mặc định của RFC là **mang nguyên quy tắc sang lễ tân** (parity), tách biệt với hậu cần. Chủ xác nhận, hay muốn bỏ hoặc đổi quy tắc ở bản mới?

Ngoài ra một việc cần phép đụng legacy (không phải câu hỏi chặn): để bóng đọc `action` thật của `intake_step` thay vì suy từ chữ, phải mở rộng hook của `shadow-forwarder` (nằm trong `apps/tieulinh-legacy`, đang đóng băng). Mặc định: **không đụng**, dùng bộ phân loại chữ được bản ghi vàng kiểm.

## Phương án đã loại

- **Viết lại lễ tân bằng prompt của agent** (để LLM tự giữ trạng thái): vi phạm nguyên tắc "logic tất định ở engine", và không so sánh được với legacy theo từng lượt.
- **Đưa `pipeline.ts` nguyên khối vào core** rồi dọn dần: kéo theo KG, Onyx, MCP, plugin; 3.348 dòng không có ranh giới cổng; khoá chặt vào các phụ thuộc riêng của Tiểu Linh.
- **So bóng bằng chạy tự do rồi so từng chữ**: lệch ở lượt đầu làm hỏng cả chat; số liệu vô nghĩa (mục 4.2).
- **Nhập tờ khai TL1 sang TL2**: thêm một bộ chuyển hai chiều cho hình dạng `IntakeDocument` đã đóng băng, giá trị thấp so với chờ TTL 24 giờ.
- **Chia sẻ một file SQLite tờ khai giữa TL1 và TL2**: trùng tên bảng khác hình dạng (mục 6.2).
