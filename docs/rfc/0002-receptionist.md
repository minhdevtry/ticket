# RFC 0002: Lễ tân (receptionist) của bot kit

- Trạng thái: đề xuất, chưa cài đặt; đã ghi nhận quyết định của chủ (mục 8). Đây là bản thiết kế để góp ý trước khi viết code; mọi tên API trong trang này đánh dấu "đề xuất" là để thảo luận, chưa tồn tại
- Ngày: 2026-10-25
- Phạm vi: `packages/core` (`@vuihoc/bot-core`), `apps/tieulinh` (app mới), `apps/tieulinh-legacy` (bản tham chiếu đóng băng), `tools/tl2-shadow`
- Liên quan: [RFC 0001](/rfc/0001-bot-kit) (bot kit; mục "Lễ tân" ở milestone 2b), [Bản legacy và bản mới](/explanation/tieulinh-legacy), [Tiểu Linh mới: hậu cần](/explanation/tieulinh-hau-can), [ADR-0005](/adr/0005-tl2-shadow)

## Tóm tắt

Nửa **hậu cần** của Tiểu Linh 2 đã chạy trên bot kit. Nửa **lễ tân** (nhận sự cố qua chat, hỏi cho đủ, xác nhận, tạo ticket, ghi thêm vào ticket đã có) vẫn chỉ tồn tại ở bản legacy, trong một file 3.348 dòng (`pipeline.ts`) với 77 kịch bản test, mỗi kịch bản là một sự cố thật đã vá. RFC này đề xuất:

1. **Kiểm kê** toàn bộ hành vi lễ tân của legacy (mục 1), kèm mức core đã phủ và độ lớn khoảng trống, để "không mất hành vi" là một danh sách kiểm được chứ không phải cảm giác.
2. **Kiến trúc đích** (mục 2 và 3): máy trạng thái tất định nằm ở core; LLM chỉ ở các cổng trích xuất, soát thông tin, đọc lệnh; phần riêng của từng bot là **dữ liệu** (catalog, luật ưu tiên, chữ, danh sách soát) cộng vài hàm nhỏ. Bot **không** là tiến trình hay agent riêng: nó là một **pack** (MCP server, tool, skill, mảnh harness) cắm vào một harness agent có sẵn. OpenClaw là harness tiện nhất hôm nay (adapter: plugin, hook, đồng bộ workspace, mảnh cấu hình); phần MCP và skill xuất ra theo chuẩn nên harness khác có MCP cũng nạp được.
3. **So sánh bóng** (mục 4): đánh giá **từng lượt** với bản ghi Tiểu Linh 1 làm ngữ cảnh, để lệch ở lượt này không làm hỏng mọi lượt sau; kèm các chỉ số sẵn sàng làm **thông tin cho chủ** (chuyển production chỉ khi chủ nói rõ).
4. **Chuỗi 17 PR nhỏ** và kế hoạch chuyển (mục 5 và 6), có tiêu chí chấp nhận, test legacy được port, canary và hoàn nguyên.

## Bối cảnh: hiện trạng đã đo

- Lễ tân legacy: `IntakeStepPipeline` (một lượt hội thoại = một lời gọi `step`), tool MCP `intake_step` bọc nó, agent OpenClaw chỉ chuyển nguyên văn `voiceText`. Quyết định nghiệp vụ nằm ở code, không ở prompt (nguyên tắc của repo, xem AGENTS.md).
- Core đã có `IntakeEngine` (`packages/core/src/intake/engine/engine.ts`, 858 dòng, 23 test). Báo cáo `packages/core/docs/parity/ENGINE.md` ghi engine tái hiện **13 trên 77** kịch bản của `pipeline.flow.test.ts`, và nêu 3 mục cố ý không tái hiện (độ chính xác trích xuất, ticket tương tự KG/Onyx, ping cổng thời gian thực). Engine là bản rút gọn: chưa có tách báo cáo, huỷ/đóng ticket, soát danh sách, hỏi lý do xin gấp, chốt tiêu đề, và còn nhiều nhánh khác (bảng ở mục 1).
- `defineBot({ receptionist })` hiện **chỉ kiểm hình dạng**; `createBot` ghi cảnh báo "declared-not-running" (`packages/core/src/bot/create.ts`). Các trường `catalog`, `priorityRules`, `extractor` còn kiểu `unknown` (`packages/core/src/bot/define.ts`).
- Telegram hôm nay vào bot qua OpenClaw, và theo quyết định của chủ sẽ tiếp tục như vậy: **kênh thuộc harness, không thuộc bot**. Core chỉ có gửi tin, tải media và một đường webhook `/telegram-webhook` cho nút "Đã ổn" và trả lời tự do (`packages/core/src/telegram/reporter-inbound.ts`); lễ tân không cần và sẽ không có vòng nhận tin riêng.
- Hệ thống chạy bóng (ADR-0005) hôm nay **chưa kiểm được engine mới**: gateway trên Colab chạy chính MCP legacy (`apps/tieulinh-legacy/mcp/tieulinh/index.ts`, xem `tools/tl2-shadow/colab/render-config.ts`) với model khác và dự án TECH2. Nó so "Tiểu Linh 1 với chính code đó trên model khác", không phải "Tiểu Linh 1 với lễ tân mới". Cặp `pairs.jsonl` chỉ có chữ: không có nút, không có kết quả tool (hook `after_tool_call` chỉ lấy tên tool và tham số).

## Mục tiêu và không phải mục tiêu

Mục tiêu:

1. `apps/tieulinh` thay legacy ở nửa lễ tân mà **không mất hành vi nhìn thấy được** (chữ, nút, thứ tự hỏi, quyết định hỏi hay ghi, nội dung ticket).
2. Bot mới (OP, PO, CM) khai báo lễ tân **chủ yếu bằng dữ liệu**; thứ gì dùng lại được nằm ở core.
3. Mọi lần so sánh với legacy **đo được và lặp lại được** (offline trước, bóng sau, canary cuối).
4. Mỗi bước nhỏ, tự kiểm được, có đường lui.
5. Bot là **pack cắm vào harness có sẵn** (MCP server, tool, skill, mảnh harness); thư viện làm cho việc dựng pack dễ và chuẩn, và lễ tân là phép thử đầu tiên của hướng này.
6. Chuyển production **chỉ khi chủ nói rõ**; số liệu so sánh là thông tin cho chủ, không phải cổng tự động.

Không phải mục tiêu: sửa hành vi legacy (đóng băng); bot tự chạy tiến trình, tự giữ kênh Telegram hay tự chạy vòng agent riêng (chủ đã loại); thay OpenClaw; cho LLM quyết định nghiệp vụ; port KG/Onyx/Memgraph (ADR-0007, xem mục 7); đổi nội dung nghiệp vụ nào của Tiểu Linh trong RFC này (mọi thay đổi hành vi đi qua PR riêng có ADR).

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
| A1 | Thiếu trường bắt buộc: hỏi theo gate, nút chọn cho trường enum, một lượt tối đa số trường theo catalog, đếm số lần đã hỏi | `pipeline.ts` `collect` (Kịch bản B), `gateValues`, `variantOf` | Đủ: `engine.ts` `collect` + `intake/gate/gate.ts` | Đã có nút cho câu hỏi (PR 4); nhánh (`variant`) hỗ trợ hàm suy ra, đếm số lần hỏi và ngân sách catalog (PR 7) | M | 7 | |
| A2 | Chưa có mô tả sự cố: chào, hoặc "đã nhận ảnh, mô tả giúp em" khi chỉ có ảnh | `collect` (nhánh `hasDescription`) | Đủ: `engine.ts` `collect` (`hasDescription`, `short_description`) | Đã hỗ trợ hỏi `short_description` khi chỉ có ảnh và clarify khi chào (PR 7) | S | 7 | |
| A3 | Hỏi hệ thống đúng MỘT lần kèm nút, không rõ thì tóm tắt ghi "Chưa xác định" | `collect` (Kịch bản B') | Đủ: `engine.ts` `collect` (hỏi hệ thống một lần kèm nút) | Đã hỗ trợ luật hỏi hệ thống một lần ngoài gate kèm nút, không rõ tóm tắt ghi "Chưa xác định" (PR 7) | S | 7 | |
| A4 | Xin gấp mà chưa nói lý do: hỏi lý do một lần; có lý do thì cho đúng mức xin (không hạ mức bằng chứng); trả lời "không có" thì giữ mức bằng chứng; lý do ghi vào ticket | `collect`, `describe` (`priorityReason`) | Đủ: `engine.ts` `collect` (`priority_reason`) + `resolvePriority` | Đã có câu hỏi lý do gấp một lần, trạng thái `priority_reason`, cắt 300 ký tự (PR 7) | S | 7 | quyết định 29/09 |
| A5 | Bộ phận ngoài danh mục: nói rõ "không có trong danh mục" thay vì hỏi lại y câu cũ | `collect` (`unrecognizedDept`), `extractor.ts` `detectUnrecognizedDept` | Đủ: `engine.ts` `collect` + `unrecognizedDept` | Đã nhận diện bộ phận ngoài danh mục và hỏi nói rõ không có trong danh mục (PR 5, PR 7) | S | 7 | |
| A6 | Tóm tắt xin xác nhận: tiêu đề, sản phẩm, hệ thống, mã khách hàng (không trùng tài khoản), tài khoản, bộ phận, phân loại lỗi, số tệp, mức ưu tiên tiếng Việt; không in `MEDIUM` | `collect` (Kịch bản C) | Một phần: `engine.ts` `summaryOutput` + `gate/recap.ts` | Mẫu tóm tắt riêng của Tiểu Linh (thứ tự trường, nhãn) | S | 14 | |
| A7 | Chốt xác nhận: chỉ chấp nhận khi đã hiện tóm tắt; xác nhận tới trong dưới 5 giây bị từ chối; bấm lại nút cũ khi đang chờ thì nhắc bấm nút xác nhận; trạng thái `confirmed` kẹt quá 2 phút thì nhả | `step`, `collect`, `CONFIRM_STALE_MS`, `MIN_CONFIRM_DELAY_MS` | Đủ: `intake/confirm/protocol.ts`, test "MIN_CONFIRM_DELAY_MS" | Nhắc "bấm lại nút cũ" (`callback_data:`) | S | 4 | model tự bấm 1,1 giây |
| A8 | Tạo ticket: giành quyền bằng revision nguyên tử, ghi `created` trước việc phụ, binding, tải ảnh, dọn nút và bản nháp cũ, lỗi tạo không lộ lỗi nội bộ và giữ tóm tắt để thử lại, idempotent khi bấm đôi | `createTicket` | Đủ: `intake/create/create-ticket.ts`, `binding-store.ts` | Cột Backlog/Unstarted theo cột dự án, nhãn theo phân loại lỗi: adapter đã có (`intake/adapter.ts`) | S | 14 | TECH-1013 |
| A9 | Huỷ rõ ràng: phiên mới (revision 0) hay đã gom thì câu khác nhau; xoá hàng đợi tách và câu hỏi tách đang treo; nhắc tờ khai bị gác | `collect` (`intent === "cancel"`), `appendParkedReminder` | Một phần: `engine.ts` `collect` huỷ nhưng **không trả tin nào** | Chữ huỷ, dọn trạng thái tách, nhắc gác | S | 4, 8 | |
| A10 | Tờ khai im quá 24 giờ thì hết hạn, tin mới mở tờ khai mới | `step`, `isExpired`, `INTAKE_DRAFT_TTL_MS` | Đủ: `engine.ts` `closeAndReopen` | | | | |
| A11 | Chốt tin vô nghĩa (TECH-1148): tin rỗng hoặc token nội bộ như `noop` không kèm ảnh bị bỏ; hành vi phụ thuộc trạng thái tờ khai (đã tạo, đang tạo, chờ xác nhận, đang gom, đã huỷ, đang hỏi tách) | `step` (`isMeaninglessInput`), `isInternalCallbackToken` (core) | Chưa trong engine (hàm nhận diện đã có ở `packages/core/src/core/channel-envelope.ts`) | Bảng phản hồi theo trạng thái | S | 4 | TECH-1148 |
| A12 | `/new`: ép sự cố mới, gác tờ khai đang dở; nút "Tiếp tục sự cố đang chờ" đưa tờ khai gác trở lại | `step` (`consumeChatFlag`), `resumeParkedDraft`, `appendParkedReminder` | Đủ: `engine.ts` (`forceNew`, `parkedDocId`, `resumeParkedDraft`, `appendParkedReminder`) | | S | 8 | ADR-0008 |
| A13 | "Không biết" / "không có" ghi vào `explicitlyMissing`, bot thôi hỏi trường đó; câu trả lời cho câu hỏi dữ kiện luôn vào mô tả dù chỉ là một mã | `collect`, `extractor.ts` `isDeclineAnswer`, `merger.ts` (`appendRawText`) | Một phần: gate có `explicitlyMissing`, engine không điền | Nhận diện từ chối + `appendRawText` | S | 4 | |
| A14 | Lệnh sửa tờ khai tường minh ("sửa tiêu đề thành …") thắng LLM, tiêu đề do người đặt bị khoá | `extractor.ts` `parseEditCommand`, `merger.ts` (`titleExplicit`) | Một phần: `ports.ts` có `titleExplicit` | Phân tích lệnh | S | 5 | |

### 1.2 Hội tụ thông tin và chống mất dữ liệu

| # | Hành vi | Legacy | Core | Khoảng trống | Cỡ | PR | ADR / sự cố |
|---|---|---|---|---|---|---|---|
| B1 | Mô tả ticket = nguyên văn người báo, cộng dồn qua các lượt, trần 4.000 ký tự mỗi tin và 8.000 tổng; `reporterText` nội bộ cho đối chiếu định danh | `merger.ts` (`rawText`), `pipeline.ts` `describe` | Đủ cho cộng dồn và trần: `engine.ts` `mergeIntoDraft`; mô tả: bên dưới | Trần theo số của legacy | S | 4 | ADR-0010 |
| B2 | Bỏ phong bì kênh OpenClaw khỏi tin trước mọi xử lý | `channel-envelope.ts` qua `pipeline.ts` `run` | Đủ: `packages/core/src/core/channel-envelope.ts`, `engine.ts` | | | | TECH-924 |
| B3 | Chốt tiêu đề: không bao giờ là tên người hay mã trần; thay bằng tiêu đề dự phòng từ lời báo (bỏ chào hỏi, tên, mã) hoặc "Sự cố kỹ thuật" | `multi-incident.ts` `isInvalidTitle`, `deriveFallbackTitle`, `merger.ts`, `pipeline.ts` `createTicket` | Đủ: `intake/extractor/heuristics.ts` + `create-ticket.ts` + `engine.ts` | Đã dùng `isInvalidTitle` và `deriveFallbackTitle` chốt tiêu đề trước khi tạo ticket (PR 5, PR 7) | M | 7 | TECH-1146 |
| B4 | Gộp trường: triệu chứng không trùng, bỏ ý người bảo gỡ, bằng chứng chỉ nới (cờ đã true thì giữ, phạm vi chỉ rộng ra), tin xác nhận/huỷ/cảm ơn chỉ gộp trường cấu trúc | `merger.ts` `mergeExtractedFields` | Đủ: `engine.ts` `mergeIntoDraft` + `merger.ts` | Đã có `structuredOnly`, `removeSymptoms`, bằng chứng đơn điệu (bằng chứng chỉ nới) (PR 7) | M | 7 | |
| B5 | Định danh xung đột với tờ khai đang mở: chỉ tính định danh **có nhãn** (Code, Mã KH, Mã HS, UID/SID/CID, mã CRM 7-10 số trọn dòng) và chỉ khi cùng lớp; tên người, SĐT, tài khoản, URL, mã phiếu không bao giờ là định danh; hỏi "Sự cố mới" hay "Bổ sung sự cố đang chờ" | `multi-incident.ts` `extractLabelledIdentifiers`, `identityConflict`; `pipeline.ts` `parkForNewIncidentDecision`, `resolvePendingNewIncident` | Đủ: `engine.ts` `detectPark` (có nhãn cùng lớp) + `resolvePark` (hỏi lại khi không rõ, "thôi huỷ" bỏ tin gác) | | M | 8 | TECH-928 |
| B6 | Tờ khai đang hỏi dở (có tiêu đề, đang hỏi trường hoặc chờ xác nhận) mà tin mới là lời báo trọn vẹn thì cũng hỏi; không áp dụng khi đang trả lời câu hỏi dữ kiện hay mô tả | `collect` (`draftInProgress`) | Đủ: `engine.ts` `detectPark` (ngoại lệ câu hỏi dữ kiện / mô tả) | | S | 8 | E2E 28/09 |
| B7 | Tách báo cáo nhiều học sinh/sự cố trong một tin: hỏi "Tách N ticket / Gộp 1 ticket"; hiểu phủ định ("không tách"), "thôi/khỏi" trần là gộp; trả lời không rõ thì hỏi lại ĐÚNG MỘT lần rồi mặc định gộp, không bao giờ rơi nội dung; chọn tách thì xếp hàng, tạo lần lượt, kế thừa bộ phận; ảnh không chia mù (gắn mọi ảnh cho mọi ticket, bật `mediaAmbiguous` để mô tả nói rõ); gói tin hỗn hợp `createdIssue` + `nextDraft` | `multi-incident.ts` `splitMultiIncidentReport`, `extractBlockInfo`; `pipeline.ts` `parkForSplitDecision`, `splitQuestionPacket`, `resolvePendingSplit`, `handleUnclearSplitReply`, `mergeParkedSplit`, `createTicket` (hàng đợi) | Chưa | Toàn bộ | L | 9 | W29-SPLIT, TECH-1146 |
| B8 | Nhiều ticket đang mở cùng chat: mỗi ticket có nút riêng, ticket vừa tạo chỉ là gợi ý đầu | `pipeline.ts` `askAboutCreatedTicket`, `otherOpenTickets` | Chưa | Xem C3 | M | 11 | TECH-989/1001 |

### 1.3 Sau khi tạo ticket

| # | Hành vi | Legacy | Core | Khoảng trống | Cỡ | PR | ADR / sự cố |
|---|---|---|---|---|---|---|---|
| C1 | Tờ khai đã tạo là tờ khai ĐÓNG. Tin sau chỉ được: bổ sung (comment, không ghi đè mô tả), mở sự cố mới, cảm ơn, bấm lại nút. Phân loại ý định theo ngữ cảnh ticket đã tạo (chitchat, hủy, bổ sung, báo mới) | `step` (khối `status === "created"`), `extractor.ts` (`createdTicket`) | Một phần: `engine.ts` `routeExistingTicket` khi `created` | Chữ trả lời cho cảm ơn/huỷ/đã tạo; ngữ cảnh `createdTicket` trong `ExtractInput` | M | 10 | TECH-956 |
| C2 | Không bao giờ tự ghi vào ticket đã tạo, kể cả khi "chắc" là bổ sung: luôn hỏi bằng "Bổ sung vào TECH-X" / "Sự cố mới"; gõ "ticket mới ạ" hay "phụ huynh khác" = sự cố mới | `step`, `askAboutCreatedTicket`, `saysNewIncident`, `withTypedDetail` | Một phần: `engine.ts` (`pendingTicketAction` kiểu `suggest`) | Nhận diện "ticket mới ạ"; gộp chi tiết gõ tay vào tin đang chờ | M | 10 | ADR-0008, TECH-1013 |
| C3 | Tin mang định danh khác ticket vừa tạo thì hỏi chứ không ghi; ticket đã Done/Canceled thì từ chối lịch sự và hướng dẫn tạo mới (tin báo sự cố mới vẫn mở tờ khai mới) | `step`, `closedTicketRefusalMessage` (`supplement-notifier.ts`), `resolveIssueState` | Chưa | Cổng đọc trạng thái ticket + chữ từ chối | M | 10 | W29-NOTIFY |
| C4 | Ghi bổ sung: comment (không dựng lại mô tả), không đè định danh của ticket đã tạo, tải ảnh, nâng mức ưu tiên nếu xin gấp có lý do, gắn `@người xử lý` đúng người, báo trực ca | `appendFollowUp`, `supplement-notifier.ts` (`resolveSupplementMentionTarget`, `formatSupplementComment`, `notifyOnCallSupplement`) | Một phần: `ports.ts` `TicketActionExecutorPort` (chỉ khung) | Chọn người nhận mention, định dạng comment, nâng mức, báo trực ca | M | 10 | TECH-956 |

### 1.4 Lệnh nhắm vào ticket đã có (ADR-0008)

| # | Hành vi | Legacy | Core | Khoảng trống | Cỡ | PR | ADR / sự cố |
|---|---|---|---|---|---|---|---|
| D1 | Tìm ứng viên: mã nêu trong tin (`TECH-795`, `TECH_795`, `ticket 795`, `#795`), số trần chỉ tính khi đúng một ticket của chính người báo, ticket vừa tạo (24 giờ), ticket kỹ thuật vừa hỏi (route tin nhắn, 72 giờ, bỏ khi đang soạn dở) | `pipeline.ts` `routeToExistingTicket`, `ticket-reply-router.ts` `mentionedIdentifiers` | Một phần: `engine.ts` `buildCandidates`, `engine/text.ts` | Số trần, route 72 giờ, câu hỏi kỹ thuật làm ngữ cảnh | M | 11 | TECH-509, TECH-1001 |
| D2 | Đọc lệnh (append, edit, lookup, move, cancel_or_close, new, unclear) bằng LLM, có đường không LLM; "huỷ", "cảm ơn", "ok" không bao giờ là nội dung ghi | `ticket-reply-router.ts` `LlmTicketCommandInterpreter`, `stripSupplementCommandWrapper` | Một phần: `ports.ts` `TicketCommandInterpreterPort` (thiếu `cancel_or_close`, đường không LLM, bóc "bổ sung/update vào tick …") | | M | 10 | |
| D3 | Tra cứu: ticket của mình thấy tiêu đề, trạng thái, người xử lý, trao đổi gần nhất; ticket người khác chỉ thấy trạng thái | `lookupTicket`, `lastTechComment` | Một phần: `engine.ts` `lookup` | "Trao đổi gần nhất" | S | 11 | ADR-0008 §6 |
| D4 | Xem trước + nút xác nhận cho append/suggest/edit/move; nút "Huỷ"; nhắn việc khác thì bỏ bản xem trước và xử lý tin mới; gửi thêm ảnh khi đang chờ thì gộp, câu lệnh trần ("update vào tick TECH-1218") chưa có nội dung thì hỏi nội dung | `proposeTicketAction`, `resolvePendingTicketAction`, `executeTicketAction` | Một phần: `engine.ts` `previewAction`, `resolvePendingAction` (khớp nhãn nút chính xác) | Ma trận phản hồi khi đang chờ, bảo toàn ảnh, nút thay thế cho ticket khác | M | 11 | TECH-975, TECH-1013, TECH-1218 |
| D5 | Sửa: LLM lập thao tác, áp thử để xem trước cũ→mới, xác nhận thì kiểm lại nền (ticket đổi trong lúc chờ thì từ chối) rồi sửa và ghi comment dấu vết | `proposeEdit`, `ticket-reply-router.ts` `planEdit`, `applyEditOps` | Một phần: `engine.ts` + `ports.ts` (executor giao hết cho cổng) | Bộ lập thao tác sửa và so nền | M | 11 | ADR-0008 §5 |
| D6 | Chuyển ticket bot vừa tạo nhầm sang ticket khác ("cái này bổ sung cho TECH-Y"): chép nội dung, nối link trùng, huỷ bản nhầm | `executeTicketAction` (kind `move`) | Một phần: `engine.ts` (`move_created`) | Link `duplicates`, huỷ nguồn, đóng tờ khai | S | 11 | ADR-0008 §7 |
| D7 | Quyền sở hữu: binding cùng chat (kể cả ticket bot cũ) hoặc mô tả chứa ID Telegram của người đó | `isOwnTicket`, `apps/tieulinh-legacy/lib/itsaplan/ownership.ts` | Một phần: `ports.ts` `bindingOwnershipPort` (chỉ binding mới nhất) | Binding nhiều ticket, quy ước mô tả | S | 11 | ADR-0008 §4, §6 |
| D8 | Huỷ/đóng theo yêu cầu người báo: nói rõ "hủy/bỏ/không cần nữa" thì Canceled; nói "đóng" thì Done nếu ticket đã Resolved hoặc có từ 3 bình luận của chuyên viên, không thì Canceled; ticket đã Done/Canceled thì không chuyển lại; luôn qua xác nhận một chạm ("Hủy TECH-X" hoặc "Đóng TECH-X" và "Giữ lại"); không phải chủ ticket thì từ chối; ghi comment lý do đã escape | `proposeCancelOrClose`, `countSpecialistComments`, `ticket-reply-router.ts` (`classifyCancelOrCloseIntent`, `countSpecialistTimelineComments`, `MIN_SPECIALIST_COMMENTS_FOR_DONE`), `executeTicketAction` | Chưa | Toàn bộ | M | 12 | ADR-0006 (cập nhật 10/10), TECH-951, TECH-999 |
| D9 | Tra cứu tiến độ không nêu mã: ticket gần nhất của chính chat, chỉ tính trong 30 phút | `apps/tieulinh-legacy/mcp/shared/tools/identity.ts` (`latestTicket`), tool `get_issue`, skill `check-status` | Một phần: `ChannelBindingStore.getLatestBinding` | Đưa vào engine thay vì tool riêng (hoặc giữ tool) | S | 11, 16 | |
| D10 | Trả lời của người báo vào tin thông báo (nút "Đã ổn", reply tự do) chỉ ghi comment | `apps/tieulinh-legacy/worker/ticket-closure.ts`, plugin `xac-nhan-xong` | Đủ: `apps/tieulinh/reporter.ts`, `packages/core/src/telegram/reporter-inbound.ts` | | | | ADR-0006 |

### 1.5 Trích xuất, soát thông tin, ưu tiên

| # | Hành vi | Legacy | Core | Khoảng trống | Cỡ | PR | ADR / sự cố |
|---|---|---|---|---|---|---|---|
| E1 | Lược đồ trường (ý định, tiêu đề, triệu chứng, danh mục đóng của sản phẩm/hệ thống/loại lỗi/bộ phận/thiết bị, định danh, xin ưu tiên, bằng chứng ưu tiên) | `extractor-schema.ts` | Một phần: `ports.ts` `ExtractedFields` (trung lập, danh mục đóng là dữ liệu catalog) | Sinh lược đồ zod từ catalog, đưa vào `extract` của core | M | 5 | |
| E2 | Chuẩn hoá: từ đồng nghĩa hệ thống/bộ phận về danh mục, bộ phận chỉ nhận khi tin nhắc tới, luật SĐT (10 số 03/05/07/08/09 là tài khoản/SĐT phụ huynh, không phải mã KH), tiêu đề không được là tên/mã | `extractor.ts` (`SYSTEM_SYNONYMS`, `DEPT_SYNONYMS`, `deptMentioned`, `normalizeWithSynonyms`) | Một phần: `intake/gate/normalize.ts` | Bộ chuẩn hoá sau LLM | M | 5 | TECH-1146 |
| E3 | Suy ý định tĩnh: xác nhận, huỷ, cảm ơn, từ chối trả lời, bổ sung, báo lỗi (không cần LLM; "ok", "không vào được lớp" không phải huỷ) | `extractor.ts` `isShortConfirmation`, `isExplicitCancel`, `isDeclineAnswer`, `isChitchat` | Chưa | Mô-đun heuristic tiếng Việt dùng chung | M | 5 | |
| E4 | Bù bằng chứng ưu tiên khi LLM im; cụm rõ ràng thắng cờ `false` mặc định của model | `extractor.ts` `inferEvidence` | Một phần: `intake/priority/priority.ts` (luật), chưa có bù | Hàm bù | S | 5 | |
| E5 | LLM chết hết chuỗi model dự phòng thì KHÔNG bịa tiêu đề; có chuỗi model dự phòng | `extractor.ts` (`FieldExtractor`), `apps/tieulinh-legacy/worker/llm.ts` | Một phần: `packages/core/src/llm/extract.ts` (sửa JSON, hỏi lại một lần); chưa có chuỗi model | Tín hiệu "LLM không dùng được" và chuỗi dự phòng | S | 5 | 07/10 |
| E6 | Ngữ cảnh gửi LLM: tiêu đề và triệu chứng tờ khai (trần 1.500 ký tự), câu hỏi kỹ thuật vừa hỏi, ticket vừa tạo (trần tin 4.000 ký tự) | `pipeline.ts` `contextOf` | Một phần: `ExtractInput.draftTitle` | `ExtractInput.context` | S | 4 | |
| F1 | Soát bằng LLM "con mắt kỹ thuật viên": tối đa 3 dữ kiện, hỏi MỘT lượt, trả lời gì (kể cả "không có") cũng đi tiếp, lỗi/quá 15 giây coi như đủ; dùng hướng dẫn `tech-info-needs.md` (209 dòng) | `tech-review.ts` `LlmTechReviewer`; `pipeline.ts` (Kịch bản B'') | Đủ về cổng: `ports.ts` `TechReviewerPort`; `engine.ts` | Cài đặt LLM + nút "Không có" + `techQuestion` làm ngữ cảnh | M | 13 | TECH-759, TECH-722 |
| F2 | Soát bằng danh sách cố định (10 mục, hỏi hết một tin, bỏ qua sự cố không thuộc TECH như chấm công, lương) | `checklist-review.ts` `buildChecklist`, `ChecklistTechReviewer` | Chưa | Mục dữ liệu + hàm thuần | M | 13 | 16/10 |
| F3 | Tự học (W25): mục người báo hay phải bổ sung theo hệ thống, học từ bình luận kỹ thuật viên, sắp theo tỉ lệ, kho riêng (`ASK_LEARN_DB`), script nạp | `ask-learning/`, `apps/tieulinh-legacy/scripts/ask-learn.ts` | Chưa | Cổng `learned(system)` (dữ liệu do script ngoài sinh) | M | 13 | W25 |
| F4 | Công tắc soát: `TECH_INFO_REVIEW` (tắt / danh sách / LLM) | `apps/tieulinh-legacy/mcp/tieulinh/index.ts` | Chưa | Chính sách khai báo | S | 13 | |
| G1 | Bảng luật ưu tiên (sàn nâng, trần chặn, sàn thắng khi bằng) | `evaluatePriorityRules` (đã ở core), `domain/` `urgency-rules.json` | Đủ: `packages/core/src/intake/priority/priority.ts` | Dữ liệu của Tiểu Linh sang app | S | 14 | |
| G2 | Xin gấp sau khi đã tạo ticket có lý do thì nâng mức trên ticket + comment lý do | `appendFollowUp`, `executeTicketAction` | Chưa | Xem C4 | S | 10 | 29/09 |

### 1.6 Người báo, ticket tương tự, media

| # | Hành vi | Legacy | Core | Khoảng trống | Cỡ | PR | ADR / sự cố |
|---|---|---|---|---|---|---|---|
| H1 | Danh tính người báo: kiểm tra, đăng ký (`requireApproval: false` cho Tiểu Linh), mã nhân sự, relink khi đổi tài khoản | `apps/tieulinh-legacy/mcp/shared/tools/identity.ts`, `apps/tieulinh-legacy/lib/storage/identity-repository.ts` | Đủ về lõi: `packages/core/src/identity` (service, relink, tools) | Nối vào lễ tân: ghi `reporter` vào tờ khai và binding (`reporterUserId`) | S | 15, 16 | |
| H2 | Binding ticket với chat, người báo, tuyến tin nhắn (cho hậu cần) | `bindIssueToChat` (`mcp/shared/tools/create-issue.ts`), `apps/tieulinh-legacy/lib/storage/binding-repository.ts` | Đủ: `intake/create/binding-store.ts`, `intake/notify/stores.ts` | **Không tương thích file chung với legacy**, xem mục 6 | M | 16 | |
| I1 | Ticket tương tự lúc gom (Onyx, khi triệu chứng đổi, lưu trong tờ khai) | `collect` (`searchSimilar`) | Chưa | Cổng, không hiển thị cho người báo | hoãn | | ADR-0007 |
| I2 | Sau khi tạo (chạy nền, không chặn câu trả lời): KG + Onyx + BM25 + LLM xác minh từng cặp, ghi Related Tickets và link chỉ với cụm KG, comment gợi ý của bot (đánh dấu `markBotComment`), ping cổng thời gian thực | `runSimilarTicketsInBackground`, `linkSimilarTickets`, `apps/tieulinh-legacy/lib/kg` | Chưa, và `ENGINE.md` cố ý để ngoài: chỉ có `PostCreateHookPort` | Toàn bộ | L | hoãn | ADR-0007, ADR-0010 |
| J1 | Media: gom đường dẫn, bỏ trùng, tin chỉ có ảnh không làm sập, tải lên ticket, nối link vào mô tả; `mediaAmbiguous` khi tách | `step`, `collect`, `createTicket`, `apps/tieulinh-legacy/lib/itsaplan/upload.ts` | Một phần: `ports.ts` `MediaResolver`, `adapter.ts` `attach`, `packages/core/src/telegram/media.ts` | Đường dẫn ảnh do harness đặt vào phong bì (OpenClaw hôm nay); core chỉ giải đường dẫn | M | 14 | TECH-637 |

### 1.7 Kênh, nút bấm, văn bản

| # | Hành vi | Legacy | Core | Khoảng trống | Cỡ | PR | ADR / sự cố |
|---|---|---|---|---|---|---|---|
| K1 | Hợp đồng nút: `{ text, callbackData }`, `callbackData` tối đa 64 byte UTF-8 (nút vượt thì cả tin không gửi được), nhãn xác nhận cố định | `buttons.ts`, `packages/core/src/intake/gate/types.ts` | Đủ: `intake/gate/buttons.ts`, `packages/core/src/openclaw/pending-buttons.ts` | | | | 14/09 |
| K2 | Nút ra Telegram qua file nút chờ; plugin gắn nút vào tin ra, dọn chữ khi đã có nút, **khoá nút sau khi bấm** (thu gọn còn đúng nút đã chọn), chỉ gắn nút xác nhận vào tin có dạng tóm tắt (kiểm bằng biểu thức chính quy trên chữ), không gắn vào tin báo đã xong | `iris-tuong-tac` | Một phần: file nút chờ ở core (`pending-buttons.ts`); plugin vẫn ở legacy | Plugin khoá nút thuộc lớp harness; giữ nguyên plugin legacy và kiểm hợp đồng ở PR adapter | M | 16 | |
| K3 | Token callback nội bộ (`noop`) bị nuốt và trả `answerCallbackQuery`; callback trùng trong 10 giây bị bỏ | `iris-tuong-tac` (`before_dispatch`) | Đủ ở plugin legacy `iris-tuong-tac` (lớp harness) | Giữ nguyên plugin; adapter chỉ kiểm hợp đồng (không tái viết) | S | 16 | TECH-1148 |
| K4 | `/new` bị OpenClaw nuốt: plugin bắt ở `before_dispatch` và gọi `POST /internal/force-new` để đặt cờ; `reporter_ok`, `reply_to` bắt trước LLM | `xac-nhan-xong` | Một phần: `packages/core/src/itsaplan/webhook/server.ts` có `ForceNewHandler`, nhưng `backoffice.inbound` chưa mở đường `forceNew` | `inbound.forceNew` | S | 16 | ADR-0008 |
| K5 | Lệnh và tin tĩnh: `/start` chào, `/help` hướng dẫn, `/reset` làm mới phiên; quy tắc persona (một lượt một tin, không nghĩ thành tiếng, không `NO_REPLY`, thuần Việt) | `apps/tieulinh-legacy/skills/tieulinh/messages`, `apps/tieulinh-legacy/skills/tieulinh/AGENTS.md` | Chưa | Persona và tin tĩnh là gói skill (`skills/`) do adapter đồng bộ vào workspace; khai báo thành dữ liệu của pack | S | 16 | |
| K6 | Chữ gửi người báo: khoảng 70 dòng chuỗi trong `pipeline.ts`, cộng `supplement-notifier.ts`, 14 dòng hỏi của `checklist-review.ts` (`ask-learning/items.ts`), hàng chục mục mẫu trong `domain/` | nhiều nơi | Một phần: `CopyKey` có 25 khoá (`ports.ts`), chữ mẫu ở `packages/core/examples/tieulinh/copy.ts` | Mở rộng `CopyKey` hoặc nhóm chữ có tham số; **kiểm bằng bản ghi vàng** (mục 5) | L | 14 | |

Tổng kết khoảng trống: các mục nặng nhất (cỡ `L` hoặc `M` mà core còn `Chưa`) là tách báo cáo B7, huỷ/đóng D8, chốt tiêu đề B3, soát danh sách F2/F3, trích xuất E1-E5, chữ K6 và KG I2; còn lại chủ yếu là bổ sung nhánh vào engine. Hầu hết nhánh của `pipeline.ts` bám vào **một sự cố có mã**, nên mỗi PR port đúng các test mang mã đó (mục 5).

## 2. Kiến trúc đích

### 2.1 Ranh giới: máy trạng thái ở core, LLM ở rìa

```text
 kênh (Telegram qua OpenClaw hoặc trực tiếp)
        |  tin, ảnh, nút                           <- harness gọi tool intake_step (kênh thuộc harness)
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

Trạng thái bền là `IntakeDraft` (bảng `intake_documents` do `intakeApplySchema` tạo). Draft hiện tại thiếu các trường mà legacy giữ: hỏi lần cuối (`lastAskedFields`), `requestedPriority`, `techReviewDone`/`techQuestion`, `unrecognizedDept`, `pendingSplit` (kèm hàng đợi, `extraText`, `clarifyCount`), `mediaAmbiguous`, các trường `pendingNewIncident` đầy đủ, `parkedDocId` đã có, và dấu của việc nền. PR 4 thêm các trường này theo kiểu **cộng thêm, có phiên bản**, đọc được bản draft cũ.

### 2.2 Cắm vào `defineBot`

Hôm nay `receptionist` chỉ có bốn trường lỏng kiểu (xem `packages/core/src/bot/define.ts`). Đề xuất (chưa tồn tại, tên chỉ để thảo luận):

```ts no-check
// ĐỀ XUẤT. Chưa có trong code; không dùng làm tham chiếu chữ ký.
export default defineBot({
  id: "tieulinh",
  tracker: { team: "tech", project: "TECH" },
  persona: copyVi,                              // CopyCatalog đầy đủ cho lễ tân
  receptionist: {
    pack: { skills, persona },                  // gói skill: persona, hướng dẫn, tin tĩnh (dữ liệu); kênh là việc của harness
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

Persona và skill của OpenClaw (`apps/tieulinh-legacy/skills/tieulinh/skills/incident-intake/SKILL.md`) phụ thuộc vào tên `action` của `intake_step`. Giữ nguyên hợp đồng đó ở mọi harness để không đụng persona và skill. Engine mới có `StepOutcome` riêng (15 giá trị, `packages/core/src/intake/engine/types.ts`); bảng ánh xạ:

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

Hợp đồng này là phần của PR 4 (thêm kết quả, hàm ánh xạ, test bảng ánh xạ), không phải của adapter harness.

## 3. Bot là một pack cắm vào harness agent

Nguyên tắc chủ đã chốt: **bot không bao giờ là tiến trình riêng, không giữ kênh Telegram, không tự chạy vòng agent**. Một bot là một **pack**: MCP server cộng tool, cộng skill (persona và hướng dẫn), cộng các mảnh harness (plugin, hook, đồng bộ workspace, mảnh cấu hình). Việc của thư viện là làm cho dựng pack **dễ và chuẩn**. Lễ tân đúng khuôn này: engine tất định bọc thành tool MCP, persona và quy trình nằm trong skill, agent của harness chỉ chuyển nguyên văn kết quả.

### 3.1 Pack gồm những gì

| Lớp | Nội dung | Sinh từ | Ai tải |
|---|---|---|---|
| Lõi tất định | Engine lễ tân, kho SQLite, cổng tracker, cổng LLM | `defineBot({ receptionist })` | Chạy trong tiến trình MCP (con của harness) |
| MCP server và tool | `intake_step` cùng hợp đồng như legacy (mục 2.3), tra cứu, định danh | `createIntakeMcpServer` và `defineTool` (`packages/core/src/core/mcp-server.ts`) | Mọi harness hỗ trợ MCP (stdio hoặc HTTP) |
| Skill | Persona, quy tắc một lượt một tin, quy trình nhận sự cố, tra cứu tiến độ, tin tĩnh (`/start`, `/help`, sau `/reset`) | Markdown sinh từ khai báo và `CopyCatalog`, bản gốc hôm nay ở `apps/tieulinh-legacy/skills/tieulinh` | Harness nạp theo cách của nó |
| Mảnh harness | Plugin và hook (nút, khoá nút, `/new`, nuốt token nội bộ), đồng bộ workspace, mảnh cấu hình khai MCP và agent | Adapter riêng cho từng harness | Chỉ harness tương ứng |

### 3.2 Xuất chung và adapter OpenClaw

| Mối quan tâm | Xuất chung (harness nào có MCP cũng dùng được) | Adapter OpenClaw (tiện nhất hôm nay) |
|---|---|---|
| Điểm vào | Tool MCP `intake_step`, kết quả có cấu trúc (`action`, `voiceText`, `buttonsShown`, `agentInstruction`) | Khai MCP và agent trong `openclaw.json` bằng mảnh cấu hình sinh ra |
| Persona, skill | Thư mục skill chuẩn (Markdown) | Đồng bộ vào workspace OpenClaw |
| Nút bấm | Harness vẽ nút từ `buttonsShown`; không có nút thì vẫn dùng chữ vì engine chỉ nhận nhãn khớp chính xác | File nút chờ (`packages/core/src/openclaw/pending-buttons.ts`); plugin `iris-tuong-tac` gắn nút, dọn chữ, khoá nút sau bấm |
| Token nội bộ `noop`, callback dồn dập | Engine tự nuốt token nội bộ (A11), idempotent khi bấm đôi, chặn xác nhận dưới 5 giây | Thêm plugin `iris-tuong-tac` (`before_dispatch`) chặn sớm và trả `answerCallbackQuery` |
| `/new`, "Đã ổn", reply tự do | Cờ `force_new` đặt qua một tool hoặc cổng | Plugin `xac-nhan-xong` gọi `POST /internal/force-new`, `/internal/reporter-ok`, `/internal/reporter-reply` (hai đường sau đã có ở `apps/tieulinh`); thêm `backoffice.inbound.forceNew` |
| Nhận tin Telegram, vòng agent LLM | **Không thuộc pack**: harness sở hữu kênh và vòng agent | OpenClaw polling và agent của nó |
| Media | Harness đặt đường dẫn tệp vào tin; `MediaResolver` của core giải | Phong bì OpenClaw |
| Định danh người báo | Tool `check_identity` và `register_identity` (`identityTools` của `packages/core/src/identity`) | Cùng tool, đăng ký trong cấu hình |

Ghi chú trung thực: với harness khác OpenClaw, phần nút (vẽ, khoá) và chống bão callback rơi về harness đó; engine không dựa vào chúng để đúng (nhãn khớp chính xác, idempotent, chặn xác nhận quá sớm), nên thiếu chúng chỉ làm trải nghiệm kém hơn chứ không làm sai nghiệp vụ. Adapter cho harness thứ hai là việc sau, chỉ làm khi chủ yêu cầu.

Hai tiến trình dùng chung kho: engine lễ tân chạy trong tiến trình MCP của harness, hậu cần chạy trong tiến trình worker (mục 3.3); chúng chia một thư mục dữ liệu (SQLite WAL) như legacy (`INTAKE_DB_PATH`) khi cần, theo cách ở mục 6.2.

### 3.3 Quan hệ với RFC 0001 (`createBot`)

RFC 0001 mô tả `createBot` như một "bot" có worker, webhook, health, lịch, hẹn giờ. Cách nhìn mới: phần đó là **một mảnh harness**, cụ thể là worker hậu cần phục vụ agent native của itsaplan qua agent-runs (đồng thời gửi thông báo ra ngoài). Nó vẫn giữ nguyên, nhưng không còn là "kiểu bot" mà lễ tân phải theo. Lễ tân không có worker, không có kênh; nó là pack MCP và skill. Tiểu Linh 2 = pack lễ tân (MCP và skill, qua adapter OpenClaw) cộng worker hậu cần (`createBot`).

Đề xuất việc theo sau (chỉ tài liệu hoặc việc nhỏ riêng, **RFC này không đổi code**):

| Việc theo sau | Loại |
|---|---|
| RFC 0001: viết lại mục "Lễ tân" (milestone 2b) và "3: Host OpenClaw" theo nguyên tắc pack; thêm đoạn nguyên tắc "bot là pack cắm vào harness" | docs |
| `docs/explanation/bot-kit.md`: nói rõ `createBot` là worker hậu cần (mảnh harness), thêm trang giải thích khái niệm pack | docs |
| `ReceptionistDefinition.channels` (`packages/core/src/bot/define.ts`): bỏ hoặc đánh dấu không dùng vì kênh thuộc harness | code nhỏ, kèm PR 15 |
| `/telegram-webhook` trong `packages/core/src/itsaplan/webhook/server.ts`: xác định lại vai trò khi chủ muốn (nay chỉ cho "Đã ổn" và reply) | câu hỏi mở (mục 8) |
| Mâu thuẫn "bot không đóng ticket" ở `docs/explanation/tieulinh-hau-can.md` và `apps/tieulinh/README.md`: sửa thành "hậu cần không tự đóng; chỉ chuyển cột khi chính người báo yêu cầu và xác nhận (ADR-0006 bản 10/10), việc đó thuộc lễ tân"; rà `apps/tieulinh/gap-register.test.ts` nếu có hàng ADR-0006 | docs, và code nếu sổ đối chiếu cần đổi |

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

Cần hai thứ mà hôm nay chưa có, đều là việc của PR 6:

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

### 4.5 Chỉ số sẵn sàng (thông tin cho chủ, không phải cổng tự động)

Các chỉ số và mức dưới đây là **thông tin để chủ tự đánh giá**, không phải cổng tự động: không có chỉ số nào tự làm TL2 lên production. Chủ quyết định chuyển, khi nào, và với phạm vi nào. Số mẫu tính trên cặp đã phân lớp.

| Chỉ số | Định nghĩa | Mức tham khảo |
|---|---|---|
| Phủ | Số lượt, số cuộc đi tới xác nhận, mỗi lớp `action` TL1 có mẫu | ít nhất 500 lượt và 120 cuộc tới xác nhận trong 7 ngày liên tiếp; lớp thiếu mẫu thì phủ bằng kịch bản vàng |
| M0, an toàn | Số lệch lớp S0 | **bằng 0** trong cả cửa sổ (chỉ số quan trọng nhất; một lần S0 là một lý do để chủ cân nhắc dừng) |
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

Nguyên tắc: mỗi PR tự kiểm được, **không đổi gì ở production**, đi kèm test và docs (CI chặn nếu thiếu), sửa core thì ghi `packages/core/CHANGELOG.md`. Các PR 7 đến 13 cùng chạm `engine.ts` nên merge tuần tự (không song song). Tiến độ đo được bằng M1 của PR 6 sau mỗi PR.

**Hai cơ chế chống mất hành vi** dùng xuyên suốt:

1. **Sổ đối chiếu lễ tân** (giống `apps/tieulinh/gap-register.test.ts` của hậu cần): mỗi test legacy của lễ tân là một dòng, trỏ tới test mới có thật (`ported`/`core`) hoặc có lý do (`deferred`/`by-design`). Test chỉ giữ sổ khỏi nói dối.
2. **Bản ghi vàng**: một script ghi một lần (chạy trên legacy, dữ liệu tổng hợp) kịch bản vào/ra `(tin, action, voiceText, nút)` của từng kịch bản trong `pipeline.flow.test.ts` thành fixture JSON trong repo. Test của TL2 phát lại **đầu vào** và so **đầu ra** (chữ chính xác sau khi chuẩn hoá tham số). Nhờ đó "chữ, nút, thứ tự hỏi" được so máy-với-máy mà không import code legacy vào app mới.

| PR | Tiêu đề (đề xuất) | Làm gì | Tiêu chí chấp nhận | Test legacy được port |
|---|---|---|---|---|
| 1 | `docs(tieulinh): sổ đối chiếu test lễ tân legacy` | Test sổ cho mọi test lễ tân của legacy (77 flow, 17 multi-incident, 10 split-adversarial, 14 router, 21+3 soát, 11 định danh, các file test trích xuất, 6 noop, và các file còn lại trong thư mục test của lễ tân), mỗi dòng có trạng thái | Không dòng nào trùng; dòng `ported`/`core` trỏ tới test có thật; CI đỏ khi xoá/đổi tên một test mà quên cập nhật | Không port, chỉ lập sổ; cập nhật bảng `ENGINE.md` |
| 2 | `feat(core/testing): khung kịch bản hội thoại và bản ghi vàng` | `ScriptedChat` cho `engine.step` (kịch bản "tin vào, kỳ vọng ra") trong `@vuihoc/bot-core/testing`; script ghi vàng; fixture đầu tiên cho 6 kịch bản | Ghi vàng lặp lại được (bản ghi hai lần bằng nhau); `bun run scan` sạch; 6 kịch bản chạy trên engine hiện tại, báo rõ cái nào lệch | 6 kịch bản mẫu từ `pipeline.flow.test.ts` (xác nhận quá sớm, "ok" đầu tiên, tạo ticket, bấm đôi, huỷ rồi tin mới, hết hạn 24 giờ) |
| 3 | `feat(core/intake): bộ lưu binding tương thích kho legacy` | `SqliteChannelBindingStore` ghi được vào file có schema legacy (`channel_type = telegram`, `message_id` giữ chỗ như `bindIssueToChat`) và đọc được binding do TL1 ghi; tờ khai TL2 ở file riêng (trùng tên bảng `intake_documents`, khác hình dạng); **làm sớm vì mọi canary phụ thuộc vào đây** | Test hai chiều trên cả hai dạng schema: TL1 đọc được binding TL2 ghi và ngược lại; không vi phạm ràng buộc NOT NULL nào; schema legacy dựng bằng fixture DDL sao từ `apps/tieulinh-legacy/lib/storage/schema.ts`, không import code legacy. **Không canary nào trước khi PR này merge** | `binding-repository.test.ts` (7), phần binding của `confirmation-and-binding.test.ts` (22) |
| 4 | `feat(core/intake): draft v2 và chuẩn hoá đầu vào` | Thêm trường draft (mục 2.1) có phiên bản, đọc được draft cũ; chuẩn hoá đầu vào (tin vô nghĩa A11, từ chối A13, `appendRawText`); `ExtractInput.context`; `StepOutput` có nút cho câu hỏi; thêm các kết quả mới và ánh xạ `action` (mục 2.3); trần `rawText` theo legacy | Test migrate draft cũ; bảng ánh xạ có test; engine hiện có vẫn qua 23 test | `noop-guard.test.ts` (6), `repository.test.ts` của tài liệu (6), flow: "ok chưa tóm tắt", "không biết", "không vào được lớp không huỷ", "xác nhận hai lần", "phong bì", "tin dài" |
| 5 | `feat(core/intake): llmExtractor và heuristic tiếng Việt` | Bộ trích xuất dựa trên `extract` của core: lược đồ từ catalog, chuẩn hoá sau LLM (E2), suy ý định tĩnh (E3), bù bằng chứng (E4), tín hiệu LLM không dùng được không bịa tiêu đề (E5), lệnh sửa tờ khai (A14) | Với `FakeLlm`: lược đồ hợp lệ, từ đồng nghĩa, bộ phận chỉ khi nhắc, luật SĐT; "LLM chết" không ra tiêu đề; heuristic không phụ thuộc LLM | `extractor.test.ts` (2), `extractor-rules.test.ts` (21), `extractor-dept-system-title.test.ts` (12), `extractor-evidence.test.ts` (10) |
| 6 | `feat(tl2-shadow): replay lễ tân từng lượt và chỉ số sẵn sàng` | Mục tiêu `receptionist` ở worker: phân loại câu trả lời TL1, đọc tóm tắt TL1, dựng trạng thái ép quyết định (tầng 1), chạy tự do (tầng 2), tạo ticket nới lỏng (tầng 3); cặp `v: 2`; `compare.ts --metrics`; bộ nhớ đệm trích xuất để chạy lại offline | Bộ phân loại đúng 100% chuỗi vàng của PR 2; replay trên cặp tổng hợp ra đúng M0-M4; chạy lại hai lần cho cùng kết quả (nhờ bộ nhớ đệm); không đụng secret, ADR-0005 giữ nguyên | Không port; thêm kịch bản tổng hợp từ các sự cố TECH-928, TECH-1013 |
| 7 | `feat(core/intake): hỏi bổ sung theo luật` | A1-A5: nút cho trường, nhánh theo hàm `variant`, hỏi hệ thống một lần, hỏi lý do gấp một lần, bộ phận ngoài danh mục; B3 chốt tiêu đề; B4 gộp trường đầy đủ | Golden của các kịch bản liên quan khớp chữ và nút | flow: ưu tiên tiếng Việt, nhãn không lộ tên trường, mặc định Medium, bằng chứng urgent, 5 kịch bản "xin gấp", hệ thống một lần (2); `multi-incident.test.ts` phần tiêu đề (`isInvalidTitle`, `deriveFallbackTitle`) |
| 8 | `feat(core/intake): gác tờ khai khi có sự cố mới` | B5, B6, A12: định danh có nhãn cùng lớp, park, hỏi lại khi không rõ, "thôi huỷ", nút "Tiếp tục sự cố đang chờ", nhắc khi tạo hay huỷ, `/new` | Golden khớp; ba test "không mất dữ liệu bên nào" xanh | flow: nhóm TECH-928 (8), tờ khai bị gác (3), "tờ khai dở + lời báo trọn vẹn", "customerId không bị reground"; `identifier-grounding.test.ts` (11) |
| 9 | `feat(core/intake): tách báo cáo nhiều sự cố` | B7 đủ: bộ tách, câu hỏi, phủ định, hỏi lại một lần rồi gộp, hàng đợi, `mediaAmbiguous`, gói hỗn hợp `createdIssue` + `nextDraft` | Mọi test tách xanh, kể cả đối kháng; không có đường nào làm rơi chữ hay ảnh | `multi-incident.test.ts` (17), `split-adversarial.test.ts` (10), flow phần tách |
| 10 | `feat(core/intake): tin sau khi tạo ticket` | C1-C4, G2: ngữ cảnh ticket đã tạo, "ticket mới ạ", từ chối khi đã đóng, bổ sung bằng comment, nâng mức, cổng đọc trạng thái, người nhận mention, báo trực ca; nút theo từng ticket đang mở (B8) | Không có đường ghi nào không qua nút; golden khớp | flow: nhóm TECH-1013, nhóm nhiều ticket đang mở, "cảm ơn sau khi tạo", "bổ sung comment không ghi đè mô tả"; `pipeline.notify-supplement.test.ts` (6); `supplement-notifier.test.ts` (phần thuần), `pipeline.test.ts` (7) |
| 11 | `feat(core/intake): lệnh nhắm vào ticket đã có` | D1-D7, D9: ứng viên (số trần, route 72 giờ), đọc lệnh có đường không LLM, tra cứu, xem trước, ma trận khi đang chờ, sửa, chuyển ticket nhầm, sở hữu | Mọi ghi vào ticket đã có chỉ chạy khi khớp nhãn chính xác; người khác không bấm hộ | `ticket-reply-router.test.ts` (14), flow nhóm ADR-0008 (14) và TECH-1218, `own-tickets-confirm.test.ts` (6) |
| 12 | `feat(core/intake): huỷ và đóng ticket theo yêu cầu người báo` | D8 theo ADR-0006 bản 10/10 (quyết định 3 ở mục 8) | Bảng quyết định Canceled/Done có test theo từng ô; "Giữ lại" không đổi gì | flow nhóm huỷ/đóng (8), phần phân loại của router |
| 13 | `feat(core/intake): soát thông tin (danh sách, LLM, tự học)` | F1-F4: `checklistReview` thuần dữ liệu, `llmReview` trên core `llm`, cổng `learned`, công tắc chính sách | Soát chỉ một lượt; mọi câu trả lời đi tiếp; lỗi không chặn tạo | `checklist-review.test.ts` (21), `tech-review.test.ts` (3), `ask-learning/` (`lookup`, `learned`), flow nhóm soát (6) |
| 14 | `feat(tieulinh): dữ liệu domain, chữ và định dạng ticket của lễ tân` | App `apps/tieulinh`: catalog, luật ưu tiên, vựng, chữ (`copy.ts`), mẫu tóm tắt, định dạng mô tả và comment gợi ý; `catalogFromValidationRules` vào core nếu chưa; test chống trôi dữ liệu với legacy cho đến khi xoá legacy | Chữ và tóm tắt khớp bản ghi vàng; mô tả ticket đúng ADR-0010 | `ticket-formatter.test.ts` (37), `create-issue-description.test.ts` (7), `rawtext-regression.test.ts` (5), `domain.test.ts` (12), `validate.test.ts` (7), `priority.test.ts` (7), `completeness.test.ts` (7) |
| 15 | `feat(core/bot): defineBot lễ tân thành pack MCP và skill` | Thay `unknown` bằng kiểu; `defineBot` kiểm catalog và chính sách (gom lỗi một chỗ); dựng bộ tool MCP của lễ tân (`intake_step`, tra cứu, định danh) từ khai báo bằng `createIntakeMcpServer`; xuất gói skill (persona, hướng dẫn, tin tĩnh) từ khai báo và `CopyCatalog`; bỏ cảnh báo "declared-not-running"; bỏ hoặc đánh dấu không dùng `ReceptionistDefinition.channels`; `createBot` giữ vai trò worker hậu cần | `defineBot` bắt lỗi khai báo; MCP server lễ tân liệt kê đúng tool và gọi được qua stdio và HTTP bằng client MCP trần trong test, không mạng thật; gói skill sinh ra đúng cấu trúc thư mục | `define.test.ts`, `create.test.ts` mở rộng; `intake-step.test.ts` (1) |
| 16 | `feat(core/openclaw): adapter OpenClaw cho pack lễ tân` | Phần riêng của harness OpenClaw: mảnh cấu hình `openclaw.json` (khai MCP, agent, plugin), đồng bộ workspace (skill, persona), nút qua file chờ, `backoffice.inbound.forceNew`, định danh qua `identityTools`; kiểm hợp đồng với plugin legacy (không tái viết plugin) | Test hợp đồng (`action`, `buttonsShown`, `agentInstruction`); tóm tắt TL2 khớp biểu thức của `iris-tuong-tac` quyết định gắn nút xác nhận; mảnh cấu hình áp được vào bản sao `openclaw.json` và gateway Colab nạp được | kiểm chéo `iris-tuong-tac` (12) và `xac-nhan-xong` (33) bằng cách gọi các hàm xuất ra của chính plugin |
| 17 | `docs(deploy): runbook shadow, canary và hoàn nguyên lễ tân` | Mở rộng `deploy/colab/cup-tieulinh.sh` cho lễ tân; hướng dẫn canary theo danh sách chat; kịch bản hoàn nguyên đã diễn tập | Diễn tập hoàn nguyên trên Colab; docs `how-to` mới | Không port |

KG, ingest, `related-curator` (mục 7) nằm ngoài chuỗi; sổ đối chiếu của PR 1 ghi chúng `deferred` có lý do.

## 6. Kế hoạch chuyển production và hoàn nguyên

**Chuyển TL2 lên production chỉ xảy ra khi chủ nói rõ.** Các giai đoạn dưới đây là thứ tự an toàn để chủ có số liệu; không giai đoạn nào tự động mở giai đoạn sau, và các chỉ số ở mục 4.5 là thông tin cho chủ, không phải cổng.

### 6.1 Các giai đoạn

| Giai đoạn | Việc | Chủ xem gì (thông tin) |
|---|---|---|
| 0 | Các PR đã merge; bản ghi vàng xanh | CI xanh; sổ đối chiếu không còn dòng trống ngoài `deferred` đã duyệt |
| 1a | **Replay offline** trên cặp đã có (hàng đợi giữ 7 ngày) | Các chỉ số M0 đến M4 trên dữ liệu thật |
| 1b | **Bóng trực tiếp**: pack lễ tân TL2 trên Colab ở TECH2, nhật ký thay cho Telegram; worker gọi đích `receptionist` song song TL1 | Các chỉ số M0 đến M7 theo thời gian |
| 2a | **Dogfood**: nhóm nội bộ nhắn thẳng TL2 (OpenClaw, tài khoản thử, TECH2, hậu cần TL2) | Phản hồi người dùng nội bộ, có S0 hay không |
| 2b | **Canary chat thật** theo danh sách chat cho phép, qua OpenClaw, **dự án thật `TECH`**; hậu cần vẫn là TL1 (mục 6.2). Chỉ bắt đầu khi PR 3 (binding tương thích) đã merge và chủ cho phép | Chỉ số canary so với đường cơ sở của TL1 |
| 3 | **Chuyển hết** tài khoản `ticket` sang TL2 lễ tân (đổi cấu hình agent của OpenClaw trỏ sang pack mới); sau đó hậu cần theo RFC 0001 | Ổn định theo thời gian chủ muốn |

Mỗi bước sang giai đoạn sau cần một câu của chủ ("được chuyển"); thiếu câu đó thì giữ nguyên giai đoạn hiện tại. Không giai đoạn nào có hạn chót cứng.

### 6.2 Hậu cần trong lúc canary: dùng chung binding với TL1

Lễ tân TL2 tạo ticket thật thì hậu cần **TL1** (webhook của `TECH`, đang chạy production) phải vẫn báo người báo khi ticket đổi trạng thái. Hậu cần biết "ticket này của chat nào" qua bảng `ticket_bindings` và `message_routes` của TL1. Hai thứ cần xử lý **trước** mọi canary, trong PR 3 (sớm trong chuỗi):

- **Không dùng chung file tờ khai.** Core và legacy cùng đặt tên bảng `intake_documents` nhưng `state_json` có hình dạng khác (`IntakeDraft` và `IntakeDocument`). Tờ khai của TL2 phải ở file riêng.
- **Bảng binding không tương thích trực tiếp.** Ở legacy, `ticket_bindings` có `channel_type` và `message_id` bắt buộc (`apps/tieulinh-legacy/lib/storage/schema.ts`, ghi bởi `apps/tieulinh-legacy/lib/storage/binding-repository.ts`), còn `SqliteChannelBindingStore` của core (`packages/core/src/intake/create/binding-store.ts`) không điền hai cột này nên ghi vào file legacy sẽ vi phạm ràng buộc. Cần bộ lưu binding tương thích (ghi `channel_type = telegram` và `message_id` giữ chỗ như `bindIssueToChat`) và test hai chiều trên cả hai dạng schema. Tuỳ chọn thay thế: TL2 ghi binding vào kho của mình và TL1 nhận qua đường đồng bộ; không đề xuất vì thêm phần chạy.

Còn khi chuyển nốt hậu cần sang TL2 (giai đoạn 3), `apps/tieulinh` đã dùng kho riêng (`tieulinh-app.sqlite`), nên cần **nhập** các binding đang mở của TL1 một lần (script có thể chạy lại).

### 6.3 Tờ khai đang dở lúc chuyển

TL1 và TL2 giữ tờ khai ở hai kho khác nhau, nên tờ khai đang dở của TL1 không tự sang. Quyết định của chủ: **không viết bộ nhập**; với chat có tờ khai mở trong 24 giờ gần nhất thì chờ nó đóng (TTL 24 giờ) rồi mới đưa chat vào danh sách canary hoặc chuyển.

### 6.4 Hoàn nguyên

| Tình huống | Hành động | Ghi chú |
|---|---|---|
| Canary lỗi hoặc có S0 | Khôi phục `openclaw.json` bản sao lưu có dấu thời gian (OpenClaw nạp lại nóng, như bước cài plugin ở `docs/how-to/shadow-tl2.md`) để agent trỏ lại MCP legacy; bỏ chat khỏi danh sách | Ticket TL2 đã tạo vẫn hợp lệ: TL1 hậu cần xử lý nhờ binding dùng chung |
| Tờ khai TL2 đang dở khi hoàn nguyên | Người báo gửi lại; chỉ mất tờ khai chưa xác nhận | Báo trước cho nhóm canary |
| Hậu cần TL2 lỗi sau chuyển | Bật lại worker TL1 (đã tắt có kiểm soát, không xoá) | Theo RFC 0001 |

Không xoá, không sửa legacy cho tới khi chủ cho phép; không có migration phá dữ liệu.

## 7. Ngoài phạm vi, hoãn có chủ đích

- **KG, Onyx, Memgraph, `related-curator`, nạp tri thức, ticket tương tự lúc tạo** (I1, I2): sẽ có **RFC riêng sau**; di trú lễ tân đi tiếp không chờ nó. ADR-0007 và ADR-0010 giữ nguyên; engine chỉ có cổng `afterCreate`. Chuyển lễ tân khi chưa có phần này nghĩa là mất comment gợi ý và Related Tickets lúc tạo ticket mới; sổ đối chiếu (PR 1) ghi các mục này `deferred` có lý do.
- Ping cổng thời gian thực (`127.0.0.1:8140`) của `runSimilarTicketsInBackground`: hook phụ của một dịch vụ cạnh bên, sẽ là một `afterCreate` nếu cần.
- Adapter cho harness thứ hai ngoài OpenClaw: chỉ làm khi chủ yêu cầu; phần MCP và skill xuất chung đã đủ để thử.

## 8. Rủi ro, quyết định của chủ và câu hỏi còn mở

### Rủi ro chính

| Rủi ro | Giảm thiểu |
|---|---|
| Mất hành vi ngầm: 3.348 dòng, mỗi nhánh một sự cố | Ba lớp: sổ đối chiếu (PR 1), bản ghi vàng (PR 2), replay chat thật (PR 6); mỗi PR port đúng test mang mã sự cố |
| Bóng hôm nay không đo engine mới (mục 4.1) | PR 6 thêm đích `receptionist`; không tin số liệu bóng cũ cho lễ tân |
| Va chạm schema và binding với TL1 (mục 6.2) | PR 3 làm sớm, có test tương thích hai chiều, canary chỉ sau PR này |
| Heuristic của plugin `iris-tuong-tac` phụ thuộc chữ của tin (nhận ra "tin tóm tắt" bằng biểu thức chính quy): đổi chữ tóm tắt là nút xác nhận biến mất | Test hợp đồng gọi hàm xuất của chính plugin (PR 16); bản ghi vàng giữ chữ |
| Phụ thuộc OpenClaw cho nút và chống bão callback; harness khác kém hơn | Engine đúng nghiệp vụ không nhờ plugin (mục 3.2); adapter harness thứ hai là việc sau |
| Bộ trích xuất bất định, khác model giữa TL1 và TL2 | Bộ nhớ đệm trích xuất để lặp lại; M2 đo trên trường tất định; M5 đo độ hợp lệ |
| Dữ liệu chat thật trong cặp bóng | Chỉ ở máy dev (0700), giữ 7 ngày; fixture trong repo luôn tổng hợp; `bun run scan` |
| Phạm vi trượt sang KG | Nêu rõ ở mục 7; không có trong chuỗi PR |
| Người báo bị "ngắt" ở tờ khai dở lúc chuyển | Mục 6.3: chờ hết TTL, danh sách canary, thông báo |

### Quyết định của chủ đã ghi nhận

1. **Bot là pack cắm vào harness, không là tiến trình hay agent riêng.** Không có host standalone; lễ tân là engine tất định lộ qua MCP tool và skill, harness (OpenClaw trước) giữ kênh và vòng agent; MCP và skill xuất theo chuẩn để harness khác nạp được (mục 3).
2. **Chuyển TL2 lên production chỉ khi chủ nói rõ**; chỉ số là thông tin, không phải cổng tự động (mục 4.5 và 6).
3. **Giữ quy tắc ADR-0006 bản 10/10**: người báo yêu cầu huỷ hoặc đóng và tự xác nhận thì bot mới chuyển cột; bot không bao giờ tự đóng. Mâu thuẫn với trang hậu cần được ghi thành việc theo sau (mục 3.3).
4. **KG và ticket tương tự**: RFC riêng sau; di trú lễ tân không chờ (mục 7).
5. **Tờ khai đang dở lúc chuyển**: chờ hết TTL 24 giờ, không viết bộ nhập (mục 6.3).
6. **Binding tương thích** (`channel_type`, `message_id`) là PR sớm (PR 3), trước mọi canary.

### Câu hỏi còn mở

1. **Hook của `shadow-forwarder`.** Để bóng đọc `action` thật của `intake_step` thay vì suy từ chữ, phải mở rộng hook nằm trong `apps/tieulinh-legacy` (đang đóng băng). Mặc định: không đụng, dùng bộ phân loại chữ được bản ghi vàng kiểm. Chủ xác nhận?
2. **Số phận `/telegram-webhook` và `ChannelSpec`** của core: vì kênh thuộc harness, giữ như hôm nay (chỉ cho "Đã ổn" và reply) hay thu hẹp thêm trong một RFC nhỏ (mục 3.3)?
3. **Harness thứ hai**: có harness cụ thể nào chủ muốn nhắm để kiểm tính "host-agnostic" ở bước đầu không, hay chỉ cần kiểm bằng client MCP trần trong test (đề xuất)?

## Phương án đã loại

- **Viết lại lễ tân bằng prompt của agent** (để LLM tự giữ trạng thái): vi phạm nguyên tắc "logic tất định ở engine", và không so sánh được với legacy theo từng lượt.
- **Đưa `pipeline.ts` nguyên khối vào core** rồi dọn dần: kéo theo KG, Onyx, MCP, plugin; 3.348 dòng không có ranh giới cổng; khoá chặt vào các phụ thuộc riêng của Tiểu Linh.
- **So bóng bằng chạy tự do rồi so từng chữ**: lệch ở lượt đầu làm hỏng cả chat; số liệu vô nghĩa (mục 4.2).
- **Nhập tờ khai TL1 sang TL2**: thêm một bộ chuyển hai chiều cho hình dạng `IntakeDocument` đã đóng băng, giá trị thấp so với chờ TTL 24 giờ.
- **Host standalone** (bot tự nhận Telegram bằng `getUpdates`, tự khoá nút, tự chạy tiến trình): chủ đã loại; trái nguyên tắc bot là pack cắm vào harness (mục 3).
- **Chia sẻ một file SQLite tờ khai giữa TL1 và TL2**: trùng tên bảng khác hình dạng (mục 6.2).
