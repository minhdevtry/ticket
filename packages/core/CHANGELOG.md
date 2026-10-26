# Changelog

All notable changes to `@vuihoc/bot-core`. 0.x allows breaking changes, recorded here.

## Unreleased
- **Xử lý tin sau khi tạo ticket** (RFC 0002 PR 10, issue #24). Additive; hoàn thiện cơ chế xử lý tin sau khi tạo ticket (C1-C4, G2, B8):
  - `@vuihoc/bot-core/intake`:
    - `C1`: Tờ khai đã tạo là tờ khai ĐÓNG (`draft.status === "created"` và có `issueId`); phân loại ý định người báo trong ngữ cảnh `createdTicket` (`chitchat` cảm ơn không đụng ticket, `cancel` hướng dẫn cú pháp huỷ/đóng, `confirm` nhắc đã tạo mang tính idempotent, `report_issue` mở tờ khai mới độc lập).
    - `C2` (ADR-0008, TECH-1013): Không bao giờ tự ghi vào ticket đã tạo kể cả khi tin mang thông tin bổ sung hoặc ảnh — luôn qua bản xem trước `pendingTicketAction` kiểu `suggest` và nút xác nhận; nhận diện rõ tuyên bố "ticket mới ạ", "phụ huynh khác" (`saysNewIncident`) để mở tờ khai mới (trả về `clarify` nếu câu quá ngắn, hoặc gọi `collect` nếu câu có nội dung chi tiết); gộp chi tiết gõ tay và bảo toàn toàn bộ ảnh (`withTypedDetail`).
    - `C3` (W29-NOTIFY): Kiểm tra định danh xung đột (`identifiersConflict`) so với ticket đã tạo để cảnh báo trước khi đề xuất bổ sung; kiểm tra trạng thái đóng (`Done` / `Canceled`) qua cổng tracker để từ chối lịch sự bằng `closed_refusal` (`closedTicketRefusalMessage`) và hướng dẫn tạo ticket mới; tin báo sự cố mới (`report_issue`) vẫn mở tờ khai mới bình thường.
    - `C4` (ADR-0010): Ghi bổ sung vào ticket bằng bình luận (`addComment`), giữ nguyên văn mô tả ban đầu; bảo toàn các trường định danh của ticket đã tạo; tải ảnh đính kèm qua `TrackerPort.attach`; phân giải người nhận `@mention` 3 bước (`resolveSupplementMentionTarget`: ưu tiên assignee, fallback kỹ thuật viên bình luận gần nhất trên timeline, bỏ qua bot và người báo); định dạng comment chuẩn (`formatSupplementComment`); gửi cảnh báo kênh trực ca (`notifyOnCallSupplement`) khi bật `NOTIFY_ON_CALL_SUPPLEMENT=1`.
    - `G2`: Nâng mức ưu tiên (`requestedPriority` "high" hoặc "urgent") khi người báo xin gấp kèm lý do chính đáng (`requestedPriorityReason`) và mức xin cao hơn mức hiện tại của ticket; cập nhật priority trên tracker và tờ khai, chèn thông báo nâng mức vào comment bổ sung.
    - `B8` (TECH-989, TECH-1001): Người báo có nhiều ticket đang mở cùng chat: tra cứu qua `ChannelBindingStore.listBindingsForChat`, lọc các ticket chưa đóng; hiển thị danh sách các ticket khác và tạo nút bấm riêng cho từng ticket đang mở; hỗ trợ chọn ticket chính qua thông dịch lệnh hoặc gợi ý ticket vừa tạo; bấm nút ticket nào ghi chính xác vào ticket đó.
    - `SqliteChannelBindingStore`: bổ sung phương thức `listBindingsForChat(chatId, limit?, identifierPrefix?)`.
    - `TrackerPort` & `adapter`: bổ sung `isIssueClosed`, `getIssueState`, `updateIssue`, `getProjectAssignees`, `getIssueTimeline`.
    - `CopyKey`: bổ sung các khoá `ticket.closed_refusal`, `ticket.chitchat_after_create`, `ticket.cancel_hint_after_create`, `ticket.already_created_hint`, `action.suggest_append_lead`, `action.suggest_conflict_lead`, `action.suggest_unclear_prompt`, `action.suggest_unclear_prompt_with_media`, `clarify.new_incident_prompt`, `action.suggest_append_preview`, `action.suggest_append_media_note`, `action.suggest_append_other_tickets`, `action.priority_uplift`, `status.closed_done`, `status.closed_canceled`, `comment.supplement_default_content`, `reporter.default_name`, `notify.on_call_supplement`; toàn bộ câu chữ gửi người dùng chuyển qua `CopyCatalog`, core không còn literal tiếng Việt gửi người dùng.
    - Mention resolver: tách các định danh bot riêng (`tiểu linh`, `iris`, `onyx`, ...) khỏi regex cốt lõi của core, chuyển sang tuỳ chọn `ignoredActors` do app truyền vào qua `ResolveMentionOptions` / `IntakeEngineDeps`; core giữ pattern actor hệ thống tổng quát.
    - Gộp luồng từ chối ticket đã đóng qua private helper `buildClosedRefusal` trên `IntakeEngine`.
  - Port 37 bài kiểm thử từ legacy:
    - 12 ca flow từ `lib/intake-step/pipeline.flow.test.ts` (port sang `packages/core/src/intake/engine/pr10-post-create.test.ts`).
    - 6 ca notify từ `lib/intake-step/pipeline.notify-supplement.test.ts` (port sang `packages/core/src/intake/engine/pr10-post-create.test.ts`).
    - 19 ca hàm thuần từ `lib/itsaplan/supplement-notifier.test.ts` (port sang `packages/core/src/intake/notify/supplement-notifier.test.ts`).
  - Cập nhật sổ đối chiếu (`apps/tieulinh/receptionist-gap-register.test.ts`) và bảng parity `ENGINE.md`: 37 dòng `deferred` chuyển sang `ported` (tổng `ported` tăng từ 109 lên 146; `deferred` giảm từ 269 xuống 232; PR 10 còn 0 dòng).
  - Cập nhật các dòng C1-C4, G2, B8 bảng khoảng trống RFC 0002 mục 1.5 (`docs/rfc/0002-receptionist.md`).

- **Tách báo cáo nhiều sự cố** (RFC 0002 PR 9, issue #23). Additive; hoàn thiện kịch bản tách báo cáo nhiều học sinh/sự cố trong một tin (B7):
  - `@vuihoc/bot-core/intake`:
    - `B7`: nhận diện báo cáo có ≥ 2 sự cố/học sinh độc lập (`splitMultiIncidentReport` trong `src/intake/split/`): tin < 30 ký tự hoặc có dấu hiệu danh sách ví dụ (`EXAMPLE_LIST_MARKER`) hoặc không có từ chỉ lỗi (`EXPANDED_PROBLEM_WORDS`) thì không tách; bóc khối theo 2 dòng trống hoặc mẫu mở đầu khối mới; mỗi khối phải có định danh có nhãn và câu chữ riêng (không chỉ là tên người); chỉ tách khi có ≥ 2 giá trị cùng lớp khác nhau.
    - `resolvePendingSplit`: hỏi người báo "Tách N ticket / Gộp 1 ticket" (`outcome: "split_question"`); hiểu phủ định ("không tách", "ko tách") và "thôi/khỏi" trần là gộp; trả lời không rõ ý (kể cả tin chỉ có ảnh hoặc token nội bộ như `noop`) thì giữ nguyên báo cáo + mọi ảnh, hỏi lại ĐÚNG MỘT lần (`clarifyCount: 1`), nếu vẫn không rõ thì mặc định gộp 1 ticket (`mergeParkedSplit`) không mất chữ hay ảnh; huỷ tường minh ở câu hỏi tách xoá sạch hàng đợi tách và câu hỏi tách đang treo.
    - Hàng đợi tạo ticket lần lượt (`finishCreate`): khi người báo chọn tách, ticket đầu tiên được gom và xử lý trước; các sự cố còn lại xếp vào `pendingSplitQueue`; khi ticket trước tạo thành công (`status: "created"`), engine tự động mở tờ khai kế tiếp (`openFresh`), kế thừa bộ phận người báo (`reportingDept`), nạp nội dung khối tiếp theo và trả về gói tin hỗn hợp `StepOutput` gồm `createdIssue` (ticket vừa tạo) + `nextDraft` (tờ khai sự cố kế tiếp đang mở), cho phép người báo xác nhận tiếp lượt kế tiếp.
    - `mediaAmbiguous`: ảnh không chia mù — gắn toàn bộ ảnh cho mọi ticket khi tách, bật cờ `mediaAmbiguous` trên tờ khai và tự động chèn ghi chú đính kèm chung (`media.ambiguous_notice`) vào mô tả ticket.
    - `classifySplitReply` (`src/intake/split/replies.ts`): hàm thuần phân loại phản hồi tách/gộp (`"split"` | `"merge"` | `"unknown"`), nhận thêm `SplitReplyOptions` (`splitLabel`, `mergeLabel`) so khớp chính xác sau `foldButton` giúp nút bấm hoạt động bất kể ngôn ngữ copy, regex tiếng Việt giữ làm đường dự phòng khi người báo gõ tay.
    - `splitMultiIncidentReport` (`src/intake/split/split.ts`): nhận `SplitOptions` (`fallbackTitle`) để lấy tiêu đề dự phòng từ `CopyCatalog` (`ticket.fallback_title`), khớp legacy ca dự phòng mà không hardcode chuỗi trong core.
    - `CopyKey`: thêm các khoá `split.question`, `split.question_no_names`, `split.unnamed_item`, `split.unclear_prefix`, `split.next_ticket_notice`, `split.next_ticket_notice_student`, `button.split_n`, `button.merge_one`, `media.attachments_heading`, `media.ambiguous_notice`; core không còn chứa cụm từ diễn đạt cứng bằng tiếng Việt.
    - `StepOutput`: thêm các trường `createdIssue`, `nextDraft`, `docId`.
  - Port 22 bài kiểm thử từ legacy:
    - 5 ca đơn vị từ `lib/intake-step/multi-incident.test.ts` (port sang `packages/core/src/intake/split/split.test.ts`).
    - 7 ca tích hợp/flow từ `lib/intake-step/multi-incident.test.ts` (TECH-1146 tách/gộp, TECH-1248+1249 hai lượt gác, ảnh đính kèm chung, BUG 5 phủ định, BUG 6/7 huỷ hàng đợi, BUG 6 P1 hỏi lại 1 lần rồi gộp; port sang `packages/core/src/intake/engine/pr9-split.test.ts`).
    - 10 ca kiểm chứng đối kháng từ `lib/intake-step/split-adversarial.test.ts` (trạng thái chuẩn A, phủ định/huỷ/gộp B, trả lời không rõ C, dán lại D, báo cáo mới thứ 3 E, các dạng không tách F, gói tin P3 G, tin chỉ có ảnh/noop H, TTL quá hạn I, nhãn trần không làm tiêu đề J; port sang `packages/core/src/intake/engine/split-adversarial.test.ts`).
  - Cập nhật sổ đối chiếu (`apps/tieulinh/receptionist-gap-register.test.ts`) và bảng parity `ENGINE.md`: 22 dòng `deferred` chuyển sang `ported` (tổng `ported` tăng từ 87 lên 109; `deferred` giảm từ 291 xuống 269; PR 9 còn 0 dòng).
  - Cập nhật dòng B7 bảng khoảng trống RFC 0002 mục 1.2 (`docs/rfc/0002-receptionist.md`).

- **Gác tờ khai khi có sự cố mới** (RFC 0002 PR 8, issue #22). Additive; hoàn thiện các kịch bản gác B5, B6, A12:
  - `@vuihoc/bot-core/intake`:
    - `B5`: nhận diện định danh có nhãn cùng lớp (`extractLabelledIdentifiers`, `identityConflict`): chỉ Code, Mã KH, Mã HS, UID/SID/CID, mã CRM 7-10 chữ số trọn dòng, SĐT có nhãn hoặc có sẵn trong lời kể; tên người, SĐT trần mới, tài khoản, URL, mã phiếu không bao giờ tạo xung đột. So khớp theo lớp độc lập (`customer`, `student`, `phone`).
    - `resolvePark`: trả lời không rõ thì hỏi lại bằng nút, không đoán, không mất dữ liệu bên nào; tin "thôi huỷ" (`isExplicitCancel`) bỏ tin vừa gác và giữ nguyên tờ khai hiện hành; chọn "Sự cố mới" mở tờ khai mới độc lập và gác tờ khai cũ; chọn "Bổ sung sự cố đang chờ" gộp tin mới vào tờ khai đang mở (`skipConflictCheck: true`).
    - `B6`: ngoại lệ đang trả lời câu hỏi cho full-report park: nếu tờ khai đang hỏi câu hỏi dữ kiện kỹ thuật (`__tech`) hoặc mô tả (`short_description`), tin mới được xử lý như câu trả lời bổ sung thay vì gác nhầm.
    - `A12`: nút nhắc và resume tờ khai bị gác (`button.resume_parked`, `park.reminder`): khi tờ khai mới hoàn tất tạo ticket (`ticket.created`) hoặc bị huỷ (`draft.canceled`), tự động gắn lời nhắc tờ khai cũ đang chờ kèm nút "Tiếp tục sự cố đang chờ"; bấm nút phục hồi đúng tờ khai cũ (`resumeParkedDraft`), re-emit tóm tắt nếu đã đủ trường, không tự tạo thêm ticket.
    - `CopyKey`: thêm các khoá `park.unclear`, `park.canceled`, `park.reminder`.
    - Pure helpers: `isGroundedInDigits`, `recoverAccountFromText`, `PHONE_OR_ACCOUNT_PATTERN`, `saysNewIncident`, `withTypedDetail`.
  - Port 18 bài kiểm thử từ legacy:
    - 11 ca từ `lib/identifier-grounding.test.ts` (chuẩn hoá chữ số, grounded in digits, recoverAccount, xung đột định danh).
    - 2 ca từ `lib/intake-step/multi-incident.test.ts` (`extractBlockInfo`, `identityConflict`).
    - 8 ca flow từ `lib/intake-step/pipeline.flow.test.ts` (nhóm TECH-928, gác tờ khai, customerId không bị reground, huỷ rồi mở mới) cùng 3 bài kiểm "không mất dữ liệu bên nào".
  - Cập nhật sổ đối chiếu (`apps/tieulinh/receptionist-gap-register.test.ts`) và bảng parity `ENGINE.md`: 18 dòng `deferred` chuyển sang `ported` (tổng `ported` tăng từ 69 lên 87; `deferred` giảm từ 309 xuống 291; PR 8 còn 0 dòng).

- **Hỏi bổ sung theo luật** (RFC 0002 PR 7, issue #21). Additive; hoàn thiện các kịch bản hỏi thiếu A1-A5, chốt tiêu đề B3 và gộp trường B4.
  - `@vuihoc/bot-core/intake`:
    - `IntakeEngineDeps.variant`: hỗ trợ hàm suy ra `(draft, record) => string` bên cạnh hằng số `string`, cho phép chuyển nhánh động theo nội dung hội thoại (A1).
    - `IntakeEngineDeps`: thêm `systemField` và `departmentField` để app tiêm tên trường hệ thống/bộ phận độc lập với schema miền.
    - `FieldRole` (`FieldSpec.role`, `RawField.role`/`RawField.vai_tro`): gắn cờ vai trò trung tính `"system"` | `"department"` trong catalog, core không hardcode tên trường miền tiếng Việt (theo góp ý coordinator).
    - `FieldSpec.maxRetries`: cấu hình ngân sách hỏi lại từng trường; `readRecordFromInput` nhận diện `askedCount` từ working memory.
    - `A2`: kiểm tra mô tả sự cố qua `hasDescription`: gửi chỉ ảnh hỏi `short_description`; chào đơn thuần trả về `clarify`.
    - `A3`: luật hỏi hệ thống một lần ngoài gate kèm nút qua `ask.system`; nếu người báo không rõ thì tóm tắt ghi "Chưa xác định".
    - `A4`: người báo xin gấp (`requestedPriority`) mà chưa có lý do thì hỏi lý do một lần (`ask.priority_reason`); trả lời lý do thì nâng mức ưu tiên tương ứng; trả lời từ chối thì giữ mức theo bằng chứng.
    - `A5`: nhận diện bộ phận ngoài danh mục (`unrecognizedDept`) và hỏi lại bằng thông điệp riêng `ask.unrecognized_dept` kèm nút enum thay vì lặp lại câu hỏi cũ.
    - `B3`: chốt tiêu đề không bao giờ là tên người, mã trần hay lời chào (dùng `isInvalidTitle` và `deriveFallbackTitle`); tiêu đề dự phòng đi qua `CopyCatalog` (`ticket.fallback_title`).
    - `B4`: gộp trường an toàn: `structuredOnly` khi tin xác nhận/huỷ/chitchat/từ chối; `removeSymptoms` gỡ triệu chứng; bằng chứng ưu tiên chỉ nới (cờ boolean không bị hạ từ true về false, scope đơn điệu tăng theo `SCOPE_RANK`).
    - `CopyKey`: thêm các khoá `ask.system`, `ask.priority_reason`, `ask.unrecognized_dept`, `clarify.greeting`, `ask.describe_incident`, `ask.describe_incident_item`, `field.unknown_value`, `summary.priority_line`, `ticket.fallback_title`, `priority.level.{low,medium,high,urgent}`.
    - `StepOutput`: thêm trường `missingFields?: string[]` để caller và bài kiểm tra theo dõi trường đang hỏi.
  - Port 10 bài kiểm thử từ legacy (`pipeline.flow.test.ts`, `multi-incident.test.ts`, `extractor-dept-system-title.test.ts`), cập nhật sổ đối chiếu và bảng parity `ENGINE.md`.

- **Replay lễ tân từng lượt và chỉ số sẵn sàng** (RFC 0002 PR 6 / ADR-0005). Additive; không đổi hành vi production hay API hiện có của engine.
  - `@vuihoc/bot-core/intake`:
    - `IntakeEngineDeps.oracle` (`ReplayOraclePort`): oracle tuỳ chọn cho engine tiếp nhận, phục vụ chế độ replay bóng từng lượt. Khi bật, oracle ghi đè trạng thái điều khiển của tờ khai (`status`, `lastAskedFields`, `summaryShownAt`, `pendingSplit`, `pendingNewIncident`, `issueIdentifier`) theo quyết định của TL1 ở các lượt quá khứ, giữ nguyên toàn bộ logic trích xuất và luật nghiệp vụ của TL2. Mặc định tắt (`undefined`), engine chạy tự nhiên không đổi gì.
    - `applyReplayControlOverride`: hàm thuần cập nhật trạng thái điều khiển của tờ khai mà không làm mất nội dung hay định danh của người báo.
    - `ScriptedReplayOracle`: helper cho kịch bản replay nhiều lượt theo chuỗi quyết định.
    - `engineTestCatalog`, `TEST_COPY`: xuất khẩu fixture thử nghiệm ra subpath công khai cho shadow replay và người dùng thư viện kiểm thử.
    - Bỏ nhánh hành động `action: "custom"` chưa dùng khỏi `ReplayOracleAction` để bảo toàn bất biến an toàn của tờ khai.
  - `@vuihoc/bot-core/testing`:
    - `CachedFieldExtractor` (+ `ExtractionCacheMissError`, `CachedFieldExtractorOptions`, `computeExtractKey`): bộ bọc đệm trích xuất trường determinism hoá các lần chạy lại, lưu file 0600 trong thư mục 0700 theo ADR-0005. Hỗ trợ chế độ `offlineOnly` (không gọi mạng/LLM, ném lỗi khi trượt cache), bảo đảm chạy lại nhiều lần cho kết quả giống hệt 100%.
  - `tools/tl2-shadow`:
    - Phân loại câu trả lời TL1 (`classifyTl1Reply`): đúng 100% trên cả 6 kịch bản vàng (22 lượt) của PR 2.
    - Đọc tóm tắt TL1 (`readTl1Summary`): đọc ngược tiêu đề, sản phẩm, hệ thống, bộ phận, mã, mức ưu tiên, số tệp.
    - Cặp so sánh `v: 2` (`PairV2`, `PairDiff`, `DiffClass` S0/S1/S2), giữ tương thích ngược hoàn toàn với cặp `v: 1`.
    - Bộ chạy bóng 3 tầng (`receptionist-replay.ts`): Tầng 1 (đánh giá từng lượt độc lập), Tầng 2 (`runFreeConversation` đo điểm lệch và hội tụ), Tầng 3 (`evaluateRelaxedConfirm` nới lỏng xác nhận, ghi `tl2_stricter` nếu gate chưa đủ).
    - `compare.ts --metrics`: tính các chỉ số M0-M4 theo RFC 4.5. Chặn (exit code 1) khi M0 > 0.

- **Bộ trích xuất trường và heuristic tiếng Việt cho lễ tân** (RFC 0002, PR 5). Additive; không đổi API hiện có.
  - **Ranh giới miền (theo RFC 0002 mục 2.x)**: heuristic tiếng Việt tổng quát (E3, A14) ở core; TỪ ĐỒNG NGHĨA THEO MIỀN (E2) là DỮ LIỆU của app. Ở PR 5, `extractor/taxonomy.ts` giữ bộ từ đồng nghĩa của legacy làm **parity** để port test đúng ý, và mọi lần dùng đều nạp được qua `ExtractorDomainConfig`; PR 14 đưa danh mục của app vào và thay giá trị mặc định. Câu mở đầu prompt cũng không còn hardcode tên sản phẩm: app truyền qua `FieldExtractorOptions.systemPrompt` (mặc định trung tính).
  - **Còn dở (có ghi rõ để PR sau làm)**: bộ gộp `mergeExtractedFields` thao tác trên hình dạng tờ khai của LEGACY (`LegacyDraftDocument`); nối nó với tờ khai chuẩn `IntakeDraft` của core là việc của PR sau. Câu hỏi "hỏi lại bộ phận ngoài danh mục đúng một lần" thuộc PR 7 (hành vi của engine), PR 5 chỉ port phần bộ trích xuất.
  - `@vuihoc/bot-core/intake`:
    - `FieldExtractor` (+ `FieldExtractorPort`, `FieldExtractorOptions`, `ExtractorDomainConfig`): hiện thực bộ trích xuất trường từ tin nhắn tự do dựa trên LLM và chuỗi model dự phòng (E5). Khi hết cả chuỗi model dự phòng, rơi về heuristic mà KHÔNG bịa tiêu đề từ dòng đầu (E5 / TECH-1146).
    - Heuristic tiếng Việt tổng quát (E3, A14): `isShortConfirmation`, `isExplicitCancel`, `isDeclineAnswer`, `isChitchat`, `parseEditCommand` ("sửa tiêu đề thành ...", "bỏ ý ..."), `stripGreeting`.
    - Chuẩn hoá sau LLM (E2): `normalizeWithSynonyms`, `detectSystem`, `detectUnrecognizedDept` (bộ phận ngoài danh mục), `deptMentioned` (bộ phận CHỈ nhận khi tin nhắn có nhắc tới), luật số điện thoại di động Việt Nam 10 số (03/05/07/08/09) tự động chuyển sang `studentAccount` và không gán vào `customerId`.
    - Bù bằng chứng ưu tiên (E4): `inferEvidence` (`blocksLearning`, `blocksPayment`, `scope`), cụm từ rõ ràng trong tin nhắn thắng cờ `false` mặc định của model.
    - Chốt chặn tiêu đề (E2 / TECH-1146): `isInvalidTitle` (từ chối tên người, mã định danh, lời chào trần), `deriveFallbackTitle` (rút dòng mô tả lỗi đầu tiên).
    - Gộp trường (`mergeExtractedFields`): bảo toàn tiêu đề do người dùng tự đặt (`titleExplicit`), chỉ tóm tắt lại tiêu đề khi có mô tả mới, bảo toàn bằng chứng ưu tiên (không bị false hạ xuống), cắt trần độ dài triệu chứng và văn bản nguyên văn (`rawText`).
    - Lược đồ trích xuất Zod (`buildExtractorSchema`, `describeExtractedKeys`): sinh từ taxonomy và cấu hình miền, danh mục đóng tách biệt giữa core và app.
    - `ExtractInput`: thêm trường tuỳ chọn `context` và `createdTicket` để truyền ngữ cảnh hội thoại vào LLM.
    - `ExtractedFields`: thêm các trường tiện ích định danh, danh mục và bằng chứng phẳng cho domain parity.
  - Port 44 ca kiểm thử từ legacy (`extractor.test.ts`, `extractor-rules.test.ts`, `extractor-dept-system-title.test.ts`, `extractor-evidence.test.ts`), giữ nguyên tên ca và kiểm thử tích hợp với `FakeLlm`.
  - Sửa sau review (issue #19): mã CRM lấy mã đầu tiên; gộp triệu chứng giữ 30 triệu chứng cuối, dedup không gộp phân biệt hoa thường, lọc token nội bộ `noop`; chuỗi model dự phòng phân loại theo HTTP status và gọi đúng endpoint theo `api`; danh mục mặc định đồng bộ legacy; bộ gộp ghi `unrecognizedDept`; ngữ cảnh LLM ghép lại câu báo vừa hỏi; bổ sung tài liệu `docs/reference/intake-extractor.md`.
  - Hoãn: Kịch bản flow `lib/intake-step/pipeline.flow.test.ts` (1 ca) và phát sinh câu hỏi cho bộ phận ngoài danh mục trong luồng engine tiếp tục hoãn sang PR 7 (hỏi bổ sung theo luật).

- **Draft v2 và chuẩn hoá đầu vào (RFC 0002 PR 4)**: tờ khai có phiên bản, đọc được tờ khai cũ; đầu vào được chuẩn hoá bằng luật; bảng ánh xạ `action` của hợp đồng cũ.
  - `@vuihoc/bot-core/intake`: `IntakeDraft` có `version` (hiện hành là 2) và các trường hội thoại mà bản cũ thiếu — `lastAskedFields`, `requestedPriority`, `techReviewDone`, `techQuestion`, `unrecognizedDept`, `pendingSplit` (kèm `extraText`, `clarifyCount`), `pendingSplitQueue`, `mediaAmbiguous`, `pendingNewIncident`, `backgroundWork`. Mới: `DRAFT_VERSION`, `migrateDraft` (nâng tờ khai cũ **lúc đọc**, không viết lại kho; tờ khai mới hơn thì không hạ cấp), `isCurrentDraft`, các kiểu `SplitBlock`, `PendingSplit`, `PendingNewIncident`.
  - `@vuihoc/bot-core/intake`: **chuẩn hoá đầu vào** (tiền xử lý tất định, không LLM) — mới `isMeaninglessInput` (tin rỗng hoặc token nội bộ `noop` không kèm ảnh thì bỏ qua, chỉ trả lời theo trạng thái tờ khai), `isDeclineAnswer` ("không biết", "em không rõ ạ", "chưa có"), `TECH_INFO_FIELD`. Câu trả lời cho câu hỏi dữ kiện kỹ thuật luôn vào mô tả; câu từ chối thì không vào.
  - `@vuihoc/bot-core/intake`: `ExtractInput.context` (+ kiểu `ExtractContext`): `draftTitle`, `draftDescription` (cắt 1.500 ký tự), `techQuestion`, `lastAskedFields`, `createdTicket` (cắt 4.000 ký tự) — để bộ trích xuất phân biệt "câu trả lời cho câu hỏi vừa hỏi" với "lời báo sự cố mới".
  - `@vuihoc/bot-core/intake`: `StepOutcome` thêm `clarify`, `split_question`, `closed_refusal`, `canceled`; **bảng ánh xạ `action`** (RFC 0002 mục 2.3) — mới `LEGACY_INTAKE_ACTIONS`, `ACTION_OUTCOMES`, `outcomesForLegacyAction`, `legacyActionForOutcome`, `LEGACY_ACTION_BY_OUTCOME`. `@vuihoc/bot-core/testing` dùng bảng này thay cho bảng tạm `LEGACY_ACTION_OF_OUTCOME` (đã bỏ).
  - **Hành vi mới đáng chú ý**: tin vô nghĩa không tạo tờ khai nữa; huỷ tờ khai trả kết quả `canceled` kèm câu chữ (trước là `chitchat` không kèm tin); câu hỏi cho trường enum đi kèm nút chọn; xác nhận tới quá sớm thì gửi lại nút xác nhận (A7); trần mô tả đổi theo bản cũ (một tin 4.000 ký tự, cả cuộc 8.000 — trước là 6.000): `MAX_RAW_TEXT_CHARS`, `MAX_RAW_TEXT_TOTAL_CHARS` thay cho `MAX_DESCRIPTION_CHARS`. Đường ghi ticket từ chối tạo ticket khi tiêu đề hoặc mô tả rỗng hoặc chỉ là token nội bộ (TECH-1148).
  - `@vuihoc/bot-core/intake`: khoá `CopyKey` mới — `draft.canceled`, `draft.awaiting_confirmation`, `ask.missing_info` (chữ nằm ở `CopyCatalog` của bot, ví dụ `packages/core/examples/tieulinh/copy.ts`).
  - **Phần mới chỉ KHAI BÁO, chưa có đường ghi**: các trường draft v2 `unrecognizedDept`, `requestedPriority`, `pendingSplit`, `pendingSplitQueue`, `mediaAmbiguous`, `pendingNewIncident`, `backgroundWork` — engine PR 4 chưa ghi trường nào trong số đó. Đường ghi đến ở các PR sau của RFC 0002: PR 7 (hỏi bổ sung theo luật — `unrecognizedDept`, `requestedPriority`) và PR 9 (tách báo cáo nhiều sự cố — `pendingSplit`, `pendingSplitQueue`, `mediaAmbiguous`); `pendingNewIncident` theo PR 8 (gác tờ khai), dấu việc nền `backgroundWork` theo PR 13.
  - **Phần hoãn của RFC 0002 mục 2.3**: `StepOutcome.next` (gói hỗn hợp tách: `createdIssue` + `nextDraft`) thuộc PR 9. Outcome `chitchat` không còn engine nào trả (huỷ tờ khai đã trả `canceled`) nên đã thành vô dùng — vẫn còn trong kiểu `StepOutcome` và trong bảng ánh xạ `action` để giữ nguyên tên của hợp đồng cũ.
  - **Test**: 23 ca test cũ của engine (`intake/engine/engine.test.ts`) giữ nguyên tên và vẫn xanh, không xoá, không nới lỏng; trong đó **một ca đổi dữ liệu đầu vào** — "tech review asks once, any answer proceeds to summary" trả lời bằng `"không có"` thay vì `"none"` (vì `"none"` là token nội bộ của nút, bị A11 bỏ qua đúng như legacy). Ý của ca test không đổi.
  - Tài liệu: [engine lễ tân](/reference/intake-engine).

- **Binding tương thích kho legacy (RFC 0002 PR 3)**: `SqliteChannelBindingStore` ghi/đọc được cả bảng `ticket_bindings` dạng core và dạng legacy của Tiểu Linh 1 (`channel_type` và `message_id` NOT NULL). Additive; dạng core không đổi hành vi.
  - `@vuihoc/bot-core/intake`: `SqliteChannelBindingStore(db, { schema?: "auto" | "core" | "legacy" })` dò dạng bảng bằng `PRAGMA table_info` (cờ khẳng định lệch thì ném `BindingSchemaError`); dạng legacy ghi `channel_type = 'telegram'`, `message_id = '0'` (`LEGACY_CHANNEL_TYPE`, `LEGACY_MESSAGE_ID_PLACEHOLDER`) như `bindIssueToChat`. Thêm `schema`/`supportsReporterUserId`: file legacy không có `reporter_user_id`, nên `reporterUserId` bị bỏ khi ghi, `getLatestBindingByUserId` trả null, `rebindReporterUserId` trả 0.
  - Mới: `detectBindingSchema`, `resolveBindingSchema`, `isLegacyFile`, `assertNotLegacyFile`, `legacyBindingApplySchema` (chỉ tạo bảng thiếu, không ALTER), `openLegacyBindingDb(path)` (không chmod/PRAGMA file đã có), `BindingSchemaError`, `LEGACY_BINDING_TABLES`, `tableColumns`, kiểu `BindingSchemaKind`/`BindingSchemaOption`/`SqliteChannelBindingStoreOptions`.
  - `SqliteNotifyBindingReader` đọc được bảng không có `reporter_user_id` (file legacy). `SqliteMessageRouteStore` dùng được trên `message_routes` của TL1 không đổi.
  - **Hành vi mới đáng chú ý**: `intakeApplySchema` và `notifyApplySchema` giờ **ném `BindingSchemaError` khi gặp file legacy** (thay vì ALTER bảng của TL1 và trộn `intake_documents` hai hình dạng). Tờ khai TL2 phải ở file riêng. DB core cũ không bị ảnh hưởng. Xem `docs/how-to/share-bindings-with-tl1.md`.
- **Backoff của client LLM có nguồn ngẫu nhiên để chọn (tiêu chí chấp nhận: test tất định)**. Additive; không đổi hành vi mặc định.
  - `@vuihoc/bot-core/llm`: `CreateLlmOptions.random` (mặc định `Math.random`) thay nguồn ngẫu nhiên của backoff full jitter. Test truyền hàm cố định thì thời gian chờ giữa các lần thử lại tất định.
  - `calculateBackoff(attempt, baseDelayMs, maxDelayMs, random?)` ở `@vuihoc/bot-core/itsaplan` nhận nguồn ngẫu nhiên tuỳ chọn; mặc định không đổi.
  - Sửa test trôi: `llm/hardening.test.ts` ("backoff không vừa trong hạn tổng") trước đây đỏ ngẫu nhiên vì jitter có thể rơi dưới hạn tổng.

- **Khung kịch bản hội thoại và bản ghi vàng cho engine tiếp nhận** (RFC 0002, PR 2). Additive; không đổi API hiện có.
  - `@vuihoc/bot-core/testing`: `ScriptedChat` (+ `ChatEngine`, `Script`, `ScriptTurn`, `TurnExpectation`, `ScriptRun`,
    `TurnRecord`, `Mismatch`): chạy kịch bản "tin vào, kỳ vọng ra" qua `engine.step`, ghi từng lượt và liệt kê chỗ lệch;
    `ManualClock` (đồng hồ tay, mốc mặc định cố định).
  - `@vuihoc/bot-core/testing`, bản ghi vàng: `GoldenFixture`/`GoldenTurn`, `parseFixture`, `serializeFixture`,
    `goldenScript`, `normalizeVoiceText`, `compareGolden`, `applyAllowlist` (`GoldenAllow`), `formatGoldenReport`,
    `LEGACY_ACTION_OF_OUTCOME` (bảng tạm `StepOutcome` sang `action` legacy; PR 4 thay bằng hàm ánh xạ chính thức).
  - Fixture đầu tiên ở `packages/core/golden/intake/` (sáu kịch bản: xác nhận quá sớm, "ok" đầu tiên, tạo ticket,
    bấm đôi, huỷ rồi tin mới, hết hạn 24 giờ), ghi từ pipeline legacy bằng `bun run --cwd apps/tieulinh-legacy golden:record`
    (đồng hồ giả, itsaplan giả, dữ liệu tổng hợp; hai lần ghi giống từng byte). Test phát lại
    `src/intake/engine/golden-intake.test.ts` chạy cả sáu qua `IntakeEngine` hiện tại; chỗ lệch được phép nằm trong
    `golden-intake.allowlist.ts` (lệch ngoài danh sách hoặc dòng thừa đều làm test đỏ, nên danh sách chỉ co lại).

- **Nền cho bot hậu cần có người báo qua chat** (từ Tiểu Linh 2 hậu cần, `apps/tieulinh`). Additive; không đổi API hiện có.
  - `@vuihoc/bot-core/intake`: `ChannelPort.sendAlert?(text)` (báo kênh trực ca, tuỳ chọn); `TicketStateRecord` +
    `TicketStateStore` và `SqliteTicketStateStore` (bảng `ticket_states` trong `notifyApplySchema`: nhóm trạng thái
    cuối đã thấy, tin đang mang nút "Đã ổn", thời điểm người báo bấm); `LogChannel` (kênh JSONL: file 0600,
    thư mục 0700, id tin giả, ghi cả `sendAlert`) và `readChannelLog`: kênh "bóng" cho bot chưa được gửi tin thật.
  - `@vuihoc/bot-core/backoffice`: `TicketClosure` (+ `TicketClosureOptions`, `ReporterOkCopy`, `ReporterOkResult`):
    hành động luật `onStateChanged` báo người báo mỗi khi NHÓM trạng thái đổi (Resolved kèm nút, Done/Canceled/mở lại
    gỡ nút cũ, chống báo lặp, chữ nghĩa do `copy` tiêm vào) và `recordReporterOk` (nút "Đã ổn" chỉ ghi MỘT comment,
    không bao giờ đổi cột; ADR-0006 của Tiểu Linh). `RuleContext.llm`: luật dùng được `ctx.llm` (không có trace/signal).
  - `@vuihoc/bot-core/telegram`: `TelegramNotifyChannel` nhận `alertChatId` và hiện thực `sendAlert`.
  - `@vuihoc/bot-core/core`: `openPrivateDb(path, applySchema?)`: mở file SQLite của bot với thư mục 0700, file và
    `-wal`/`-shm` 0600, WAL, `busy_timeout`; khác `openLazyDb` ở chỗ lỗi mở được NÉM ra thay vì hạ xuống `:memory:`.
  - `@vuihoc/bot-core/testing`: `FakeItsaplan` thêm `POST /issues/:id/links` (`fake.links`), tìm kiếm
    `GET /projects/:ref/issues/search?q=`, và `addIssue` nhận `priority`, `assigneeUserId`, `createdAt`.

- **Sửa sau rà soát PR #11 (Tiểu Linh 2 hậu cần)**. Additive trừ ghi chú bên dưới.
  - `intake` dispatcher (`NotificationDispatcher`) ngang bản legacy: chuyển cả comment CHỈ có video
    (`sendComment` nhận `videos`, `images` chỉ có khi không rỗng), nhận `data.attachments` (chuỗi hoặc `{ url }`) như ảnh
    và khử trùng với ảnh markdown, viết lại link `localhost`/`127.0.0.1` và link tương đối về `webUrl` (option mới),
    giải mã HTML entities ở văn bản và tên người viết. `TelegramNotifyChannel` nối ảnh dạng `![](url)` và video dạng link trần.
  - `core`: `decodeHtmlEntities`, `escapeItsaplanMarkdown`.
  - `backoffice`: **`ctx.keys(ten, { ttlMs? })`** (`KeysProvider`, `createKeysProvider`) trong `RunContext`, `RuleContext`,
    `ScheduleContext`: tập khoá chống trùng, bền qua restart khi có `BOT_DATA_DIR`, tách khỏi khoá nội bộ của kit.
    `ScopedTracker.link(nguon, dich, loai)` (cả hai issue phải thuộc dự án, không thì `OutOfProjectError`; thay cho việc
    chạm `unscopedClient`). `TicketClosure.recordReporterReply` (+ `ReporterReplyCopy`, `ReporterReplyResult`): người báo
    trả lời tự do vào tin thông báo thì thành MỘT comment (escape, chống ghi đôi, từ chối khi ticket đã hoàn tất/huỷ);
    `TicketClosureOptions.replyCopy`, `channelType`.
  - `bot`: **`backoffice.inbound`** (`InboundDefinition`: `reporterOk`, `reporterReply`, `telegramUpdate`) gắn handler vào
    server webhook của kit (`/internal/reporter-ok`, `/internal/reporter-reply` chỉ loopback; `/telegram-webhook`).
    Env kit mới `TELEGRAM_WEBHOOK_SECRET` (secret, tuỳ chọn); nhận `telegramUpdate` mà nghe ngoài loopback không có secret
    thì từ chối khởi động.
  - `telegram`: `createReporterInbound` (nút "Đã ổn" `callback_query` và `reply_to_message` -> `recordReporterOk`/
    `recordReporterReply`, bot nói lại với người báo, lỗi vẫn được trả lời).
  - `itsaplan`: `ItsaplanClient.listProjectIssues` và `ScopedTracker.listIssues` nhận bộ lọc `columnId`, `createdFrom`,
    `createdTo`, `assigneeUserId`, `priority`, `includeArchived` (`ListIssuesOptions`). Đối chiếu itsaplan fork: danh sách
    sắp `updatedAt` giảm dần, chỉ có `limit` (1-500) và KHÔNG có `page`, nên muốn quét đủ phải lọc theo cột/ngày tạo.
    `testing`: `FakeItsaplan` giờ lọc, sắp xếp, giới hạn đúng như vậy (trước đó bỏ qua mọi tham số).
  - **Thay đổi hành vi (0.x)**: `ChannelPort.sendAlert` được phép trả `false` ("chưa giao được mà không ném"); `TelegramNotifyChannel.sendAlert`
    trả `false` khi chưa đặt `alertChatId` và `true` khi đã gửi. Nơi gọi cũ bỏ qua giá trị trả về vẫn chạy như trước.

- **`llm` (subpath mới)**: cách chuẩn để bot gọi LLM (mặc định MiniMax). Additive; không đổi API hiện có.
  - `createLlm({ baseUrl, apiKey, model, api, timeoutMs, deadlineMs, maxRetries, fetch })` → `{ complete }` cho
    `anthropic-messages` và `openai-chat`, request/response trung lập (system, vai user/assistant/tool,
    tool JSON Schema, tool call, token, `stopReason`). Thử lại CHỈ với 429/5xx/mạng/hết giờ (backoff + jitter,
    `Retry-After` vượt `maxRetryAfterMs` thì thất bại ngay; hạn tổng `deadlineMs`); lỗi có kiểu (`LlmApiError` có `status`, `retryable`; `LlmNetworkError`, `LlmTimeoutError`,
    `LlmAbortError`, `LlmResponseError`, `LlmConfigError`); key không bao giờ vào thông điệp lỗi. Không có
    `stream` (để sau).
  - `runToolLoop` + `defineLlmTool` (tham số kiểm bằng zod, lỗi nói cho model biết trường sai, trần
    `maxSteps`/`maxTotalTokens`, huỷ bằng `signal`), `extract` (sửa JSON, hỏi lại đúng một lần),
    `createLlmTracer` (bước của vòng lặp tool → sự kiện AG-UI qua `RunTrace`/`appendEvents`),
    `UsageMeter`/`estimateCost`/hook `onUsage`.
  - `llmEnv`, `llmFromConfig`; `createBot` tự đọc `LLM_BASE_URL`, `LLM_API_KEY` (secret), `LLM_MODEL`,
    `LLM_API`, `LLM_TIMEOUT_MS`, `LLM_MAX_RETRIES`, `LLM_DEADLINE_MS` và đưa client tới handler qua `ctx.llm` (gắn `signal`
    của run); `Bot.llm`; `createBot(def, { llm })` để tắt/ghi đè (test). `runAgentLoop(ctx, ...)`,
    `requireLlm(ctx)`, `toRunUsage`.
  - Hành vi đã chốt sau rà soát: `toolChoice` ép chỉ áp ở bước 1; bước cuối gửi `none` và không chạy tool;
    khối tool_use bị `max_tokens` cắt không chạy; `finishReason: "refused"`; `deadlineMs` (client và vòng
    lặp) và `toolTimeoutMs`/`LlmTool.timeoutMs`; `LlmTimeoutError` không `transient` ở cấp run (thử lại ở
    cấp run chạy lại cả handler và tool); `usage` có `cacheReadTokens`/`cacheCreationTokens` (`inputTokens`
    gồm cả cache), `LlmPricing` có giá cache, `onUsage`/`UsageMeter` tính cả lần gọi hỏng đã có token
    (`LlmUsageEvent.outcome`); `temperature` chỉ gửi khi đặt; `extract` sửa JSON không đụng nội dung chuỗi
    và trả `repairs`, input không tự đóng được `</input>`, từ chối thì dừng ngay; nội dung rỗng trong hội
    thoại thành chỗ giữ chỗ (Anthropic từ chối rỗng); tham số tool hỏng được phát lại nguyên văn
    (`LlmToolCall.rawArgs`); trace bị kẹp ở 12 000 ký tự, `ctx.trace` che secret của bot, `runAgentLoop`
    ghi dòng tổng kết cả khi lỗi; `LlmNetworkError.cause` đã che key; `LLM_*` không vào `ctx.config`.
  - `RunContext.llm` (mới, `Llm | undefined`; handler dựng `RunContext` bằng tay phải thêm trường này).
  - `isTransientError` nhận lỗi có `transient: true` (để `LlmError` tạm thời thành `retry` thay vì `failed`).
  - `testing`: thêm `FakeLlm` (LLM giả trên HTTP thật, hai kiểu API). Ví dụ: `examples/llm-bot`.

- Docs site: `OutboxKind`, `CommentPayload`, `StatePayload` (`intake`) giờ được export;
  `identityTokenSchema` (`openclaw`) được export từ entry point; `ParseMode` của
  `render` được xuất lại dưới tên `RenderParseMode` (`telegram`) vì `ParseMode` của
  `send` che nó. Chỉ thêm export, không đổi hành vi. Lý do: TypeDoc (cảnh báo = lỗi)
  đòi mọi kiểu được tham chiếu phải có trong tài liệu.

- **Bot kit, milestone 2a: độ bền và thời gian** (RFC `docs/rfc/0001-bot-kit.md`). Additive; mặc định
  (không đặt `BOT_DATA_DIR`) giữ nguyên hành vi in-memory của milestone 1.
  - `backoffice`: `BotStore` (kho SQLite bền, `bun:sqlite`, WAL, schema có phiên bản qua
    `PRAGMA user_version`, từ chối file do bản code mới hơn tạo: `BotStoreVersionError`) gồm
    `RunLedger` bền (`store.ledger()`), tập khoá chống trùng (`KeySet`, `MemoryKeySet`), lease, mốc
    cron và hẹn giờ. `bun:sqlite` nạp lười (barrel import được dưới Node; mở kho cần Bun);
    `busy_timeout` đặt trước WAL kèm thử lại khi mở đồng thời nhiều process; thư mục 0700, file 0600;
    schema v2 (định danh hành động, cờ yêu cầu huỷ, hẹn xếp hàng); ledger/khoá cũ dọn định kỳ. `createScopedTracker({ keys })`: khoá `idempotencyKey` của comment sống qua
    restart. `RuleEngine({ seen, store, reporter })`: dedupe sự kiện luật bền.
  - `backoffice.schedule: { "<cron>": handler | { run, missed, timezone } }` (trước đây bị
    `defineBot` từ chối) và `scheduleOptions` (`timezone`, `missed`, `graceMs`): lịch do bot giữ.
    `parseCron` (5 trường, tên tháng/thứ, bí danh `@daily`…, múi giờ IANA qua `Intl`, mặc định
    `Asia/Ho_Chi_Minh`), `BotScheduler`, `ScheduleContext` (có `llm` như `RunContext`, ràng với
    `signal`). Mốc được chiếm nguyên tử trong kho trước khi chạy (at-most-once, hai process cùng kho
    chỉ một bên chạy); lease chống chạy chồng; mốc lỡ theo `skip` (mặc định) hoặc `catch-up-once`.
    `CronSchedule.prev`, đếm mốc theo ngày (không duyệt từng phút, độ lệch múi giờ nhớ theo ngày):
    bot tắt bao lâu cũng không chặn event loop. Id lịch trong kho là `<biểu thức>@<múi giờ>`; lịch bị
    gỡ khỏi khai báo bị dọn. Health: `firingTimers`, `failedTimers`, `tickLagMs`, lỗi tự hết sau 15
    phút, và lịch/hẹn giờ lỗi làm bot `degraded`.
  - Hẹn giờ cho luật: `actions.after(duration, fn, { key, cancelOn, guard, replace })`,
    `actions.closeAfter("48h", { to, comment })`, `actions.cancelTimer(key)`, `parseDuration`.
    Token huỷ `comment`, `reporter-comment`, `state-change`, `reopened`, `assigned` (và mọi hẹn của
    issue bị xoá); `closeAfter` kiểm lại itsaplan lúc tới hạn (mốc `statusSince` của server, đọc lại
    issue ngay trước khi ghi và trước `moveTo`); yêu cầu huỷ tới lúc hẹn đang chạy được đánh dấu và
    mọi lệnh ghi của `ctx.tracker` dừng (`TimerCancelled`, `ctx.assertActive()`, `ctx.freshIssue()`);
    hẹn lại lúc đang chạy được xếp hàng. Hẹn ghi định danh hành động (`id` tường minh hoặc loại +
    thời hạn): lệch thì hẹn bị bỏ; `after` từ chối `key` thiếu `{issue}`. `backoffice.reporter` là
    BẮT BUỘC cho `closeAfter`/`reporter-comment` (itsaplan không trả người báo; `anyHumanIsReporter`
    để chọn "mọi người comment là người báo"). `TimerContext.llm`. `RuleContext` thêm `step`, `timers`; `Rule.watches`; `RuleEngine.fireTimer`,
    `hasTimers()`; `requiredEvents()` gồm cả sự kiện chỉ để huỷ hẹn. Hẹn at-least-once, thử lại
    5 lần với backoff.
  - `ensureRuleWebhook` + `WebhookPermissionError`: đăng ký webhook theo `rules`, chỉ trên dự án
    của bot, không sửa webhook URL khác, không bật lại webhook bị tắt (báo `disabled`, health
    `degraded`), liệt kê lại sau khi tạo và xoá bản vừa tạo của mình nếu trùng (khởi động đồng
    thời), gửi `ITSAPLAN_WEBHOOK_SECRET` khi tạo nếu API nhận và cảnh báo khi secret lệch.
  - `bot`: `createBot` nhận `dataDir`, `store`, `scheduler`, `webhook.url`, `webhook.autoRegister`;
    biến `BOT_DATA_DIR`, `BOT_TIMEZONE`, `BOT_WEBHOOK_AUTO_REGISTER`, `BOT_WEBHOOK_URL`,
    `ITSAPLAN_WEBHOOK_KEY`; `Bot.store`; `health().components.scheduler|store`.
    Tự đăng ký webhook mặc định TẮT; thiếu quyền thì `start()` ném lỗi rõ ràng.
  - `testing`: `FakeItsaplan` có endpoint webhook (`agentCanManageWebhooks`, `webhookKey`,
    `webhookSecretMode`) và `statusSince` của issue.
  - Docs: how-to "Lịch chạy và hẹn giờ"; cập nhật RFC (trạng thái các mục M2), config-env, bot-kit.
  - Chưa có: runtime lễ tân (2b), `X-Itsaplan-Event-Id` xuống handler, thử lại riêng từng luật.
- **Bot kit, milestone 1** (RFC `docs/rfc/0001-bot-kit.md`). Additive; không đổi API hiện có.
  - `core`: `defineEnv`, `secret`, `mergeEnv`, `loadConfig`, `ConfigError`, `REDACTED`, `createScrubber`,
    `redactUrlCredentials` — env có
    kiểu (zod), kiểm tra một lần, lỗi gom đủ, secret che trong `redacted`/log, `.env` chỉ nạp khi
    truyền `envFile` và không ghi ngược `process.env`.
  - `itsaplan` (`agent-runs`): `AgentRunsClient` (`claim`, `heartbeat`, `report`, `appendEvents`; tham
    số dạng object), `isTransientError`, `findIssueByIdentifier(…, { strict })`,
    `AgentRunWorker`/`createAgentRunWorker` (polling, heartbeat, backoff, concurrency, dừng êm,
    `RunLedger` chống chạy lại khi báo kết quả lỗi), `RunTrace` (trace AG-UI), kiểu giao thức. Giao
    thức: `docs/reference/agent-runs.md`.
  - `backoffice` (subpath mới): handler theo trigger (`mention`, `delegation`, `field`, `schedule`,
    `manual`, `status`, `event`), `RunContext`, tracker khoá theo dự án (`createScopedTracker`),
    `parseMentionPrompt`, luật `event → điều kiện → hành động` (`whenColumn`, `whenResolved`,
    `whenDone`, `whenCommentCreated`, `actions.{comment,moveTo,assign,setPriority}`, `RuleEngine`).
    Export tường minh, không `export *`.
  - `bot` (subpath mới): `defineBot`, `createBot` (`start`/`stop`/`health`/`handleEvent`),
    `runBot`, `startHealthServer` (`/healthz`).
  - `testing` (subpath mới): `FakeItsaplan`, itsaplan giả trên HTTP thật cho test bot.
  - `tracker: { team, project }` bắt buộc: `team` là slug, `project` là `KEY` in hoa; mọi lời gọi
    itsaplan dùng ref đủ `<team>.<KEY>` (`ctx.tracker.ref`), `defineBot` kiểm định dạng; `FakeItsaplan`
    từ chối khoá trần (`allowBareKeys` để bật lại).
  - Độ bền (sau review độc lập): lỗi tạm thời của itsaplan (5xx/429/mạng) trong handler thành
    `retry`, lượt cuối thành `failed` kèm lý do; lệnh ĐỌC của tracker thử lại, lệnh GHI không;
    chỉ 404 nghĩa là "không thuộc dự án"; ranh giới dự án theo `projectId`; `ctx.attempt`,
    `ctx.maxAttempts`, `ctx.prompt`; `ctx.comment` chỉ cho `mention`; `reply` khoá theo số lần gọi;
    tracker của run từ chối ghi sau khi huỷ; worker: vỏ ngoài chặn lỗi bất ngờ (kể cả ledger),
    `stop()` có hạn trên, run bị giao lại được nhận lượt mới, 401/403 chỉ chết sau 3 lần liên
    tiếp; `runBot` thoát mã 1 khi lỗi chết, hạn thoát = `bot.stopBudgetMs`, drain mặc định 5 s
    (đổi từ 30 s); luật chỉ đánh dấu đã thấy sau thành công, bỏ `issue.column_changed`; che secret
    theo giá trị và mật khẩu trong URL; webhook ngoài loopback bắt buộc có secret; biến env rỗng
    không che `.env`; kiểm tuỳ chọn chu kỳ; team có thể là id số.
  - ví dụ `examples/minimal-bot`; `bun test` của core chạy thêm ví dụ này.
  - chưa có (milestone 2): runtime lễ tân, lịch cron do bot giữ, `closeAfter`, ledger bền,
    đăng ký webhook theo `rules`.
- Moved into the `ticket` monorepo (`packages/core`, consumed via `workspace:*`);
  scrubbed internal fixtures (hosts, IPs, phone numbers, chat/user IDs, staff names
  and handles, personal paths) and removed the old standalone-repo docs.
- **Tiểu Linh adoption — behaviour lifted from the app into the library** (the app
  now consumes `@vuihoc/bot-core`; see `docs/adoption/tieulinh-iris.md`). All
  additive, defaults unchanged for other bots:
  - `core`: `isInternalCallbackToken` / `INTERNAL_CALLBACK_TOKENS` (TECH-1148);
    `stripChannelEnvelope` now drops `callback_data: noop|none|ignore|nil` instead of
    keeping it as the user's words.
  - `core`: `makeOpenLazyDb({ onOpenError: "throw" })` for callers that have their
    own fallback; default stays the ADR-0003 `:memory:` degrade.
  - `itsaplan`: `listProjectIssues({ page })`; typed `listComments` (`author`,
    `createdAt`, `id` coerced to number, bad-typed fields become `undefined`);
    `ensureItsaplanWebhook(client, key, url, { events })` so a bot registers only the
    events it handles (default stays `REQUIRED_WEBHOOK_EVENTS`).
  - `itsaplan`: fix `resolveFriendlyStatusName("", …)` returning `""` — falls back to
    "Chờ xử lý" again (intake used `||`).
  - Options so a frozen legacy bot can keep exact old behaviour while the library
    keeps its better defaults (all default to the previous library behaviour):
    `ItsaplanClient` `timeoutMs <= 0` = no timeout and `strictResponses: false`
    (empty 2xx body -> `{}`, non-JSON -> text); `ensureItsaplanWebhook`
    `reactivateDisabled` / `repointSameHost`; `uploadAttachments` `maxBytes`
    (`Infinity` allowed); `formatAttachmentMarkdown` / `spliceAttachmentsIntoDescription`
    `{ escape }`; `stripChannelEnvelope` `keepSoleEnvelopeBlock` /
    `keepTextAfterEnvelopeBlock` / `stripPastedEnvelopeFences`; `stripBotMentions`
    `knownHandles` / `stripBotSuffixHandles`; `setToolFailureOptions({ useDeclaredErrorCode })`.
  - `identity`: `saveUserIdentity` now treats an empty string as "absent" (`||`, as
    intake did) so it no longer overwrites stored values with `""`. Library-wide.
  - tests: `isLoopback`, MCP server error-as-`loi` result, Telegram transport
    error policies / multipart / file download.

## 0.8.0 — 2026-10-19

Hai hạng mục nền tảng (từng ở Out of Scope, nay trừu tượng được phần CHUNG).
Additive — không module nào đang shim bị đụng; shadow-parity 862/27/0, hash
intake-agents không đổi.

- **A2 — Deploy / sync workspace / build binary (`@vuihoc/bot-core/openclaw`).**
  Ba thao tác CHUNG, THUẦN (không chạy lệnh host, không I/O ở lõi — bot thực hiện
  I/O từ kế hoạch lib trả):
  - `planWorkspaceSync(desired, current)` + `summarizeSyncPlan` — tính kế hoạch
    create/update/unchanged idempotent cho bộ file workspace (IDENTITY/SOUL/
    AGENTS/bot.json…); chạy lại khi đã khớp → toàn `unchanged`, không ghi gì.
  - `spliceConfigBlock` / `removeConfigBlock` — chèn/thay/gỡ một khối config giữa
    marker, idempotent, KHÔNG nhân đôi khi deploy nhiều lần (lỗi codex-home splice
    của Sales). `mergeJsonConfig` cho openclaw.json (JSON không có comment).
  - `buildBinaryCommand` dựng argv `bun build --compile`; `checkCompileReadiness`/
    `isCompileReady` kiểm hai luật chống phình nhị phân (readFileSync lookup →
    block; import runtime nặng trong entrypoint MCP → warn). Không chạy build —
    script deploy của bot (host-specific) tự spawn.
- **A3 — Eval harness TS (`@vuihoc/bot-core/eval`).** Thống nhất MỘT ngôn ngữ = TS
  (bỏ nhánh Python của Sales/CM). `runConversation(runner, scenario)` chạy một kịch
  bản nhiều lượt qua `ConversationRunner` do bot tiêm, thu transcript; `scoreRun`/
  `scoreRuns` chấm theo `Check` do bot tiêm (tiêu chí là nội dung bot). Kèm check
  dựng sẵn thuần: `replyContains`, `createdTicketWithPrefix`, `noTicketCreated`,
  `turnHasButton`. Khung chạy–bắt–chấm chung; bộ chấm riêng từng bot.

## 0.7.0 — 2026-10-19

Hai hạng mục nền tảng tiếp theo, additive, opt-in/nullable — OP không đổi hành vi;
shadow-parity giữ 862/27/0, hash intake-agents không đổi.

- **B1 — Outbox opt-in đảm-bảo-gửi (`@vuihoc/bot-core/intake` notify).** Decorator
  `OutboxChannelPort` bọc quanh một `ChannelPort`: gửi THẲNG trước (đường thành công
  không chậm thêm), chỉ khi lỗi mới xếp vào hàng đợi SQLite `notify_outbox`;
  `SqliteOutboxStore.drain(channel)` gửi lại có GIỚI HẠN số lần (`maxAttempts`, mặc
  định 5) + backoff mũ có trần. Hết lượt → `failed` (log), không kẹt vô hạn.
  **Mặc định TẮT** — không bọc thì gửi thẳng như cũ. Dành cho bot cần không mất tin;
  bot realtime (OP) để thẳng cho nhanh. ADR-0003: outbox là cache cục bộ, mất chỉ
  mất một tin thông báo, không mất ticket. `outboxApplySchema` áp qua lazy-db hook.
- **A1 — Vòng đời đổi tài khoản Telegram, nhất quán lưu-theo-user-id
  (`@vuihoc/bot-core/identity`).** `relinkIdentityAndBindings(repo, bindings, input,
  options)` nối `relinkIdentity` (đổi name_code → user id mới, giữ guard chống chiếm
  danh) với `ChannelBindingStore.rebindReporterUserId(old, new)` — chuyển MỌI binding
  ticket đang gắn user id cũ sang id mới, nên `getLatestBindingByUserId` vẫn đúng và
  lịch sử ticket giữ theo NGƯỜI (name_code + id mới), không phụ thuộc tài khoản cũ.
  `bindings` tùy chọn: không truyền thì chỉ relink định danh (`reboundBindings = 0`).
  Không đụng `chat_id` (tin mới tự cập nhật chat).

## 0.6.0 — 2026-10-19

Platform-hardening: bốn bổ sung để `@vuihoc/bot-core` làm NỀN cho mọi bot, rút từ
bài học dựng OP. Tất cả **additive** — bot cũ (OP) không đổi hành vi; shadow-parity
giữ 862/27/0, hash intake-agents không đổi. Trường DB mới nullable, DB cũ được
ALTER bù cột tự động, không cần migration tay.

- **`TelegramNotifyChannel` (`@vuihoc/bot-core/telegram`)** — hiện thực `ChannelPort`
  của notify cho Telegram (`sendComment` / `sendStateChange` + nút "Đã ổn" ADR-0006 /
  `clearInteractiveButtons`). Trước đây mỗi bot tự ghép lớp nối notify ↔ Telegram
  (đúng chỗ OP phải tự chế). Nhãn nút + payload callback do bot tiêm, không literal
  tiếng Việt trong lib. Khác `TelegramChannelSender` (dành cho engine/hội thoại).
- **Lưu người báo theo USER ID** — `ChannelBindingStore` + `ticket_bindings` thêm
  `reporterUserId` (= user id kênh, Telegram `from.id`), khóa định danh bền hơn
  username/tên hiển thị. `getLatestBindingByUserId(userId, prefix?)` tra ticket theo
  người, độc lập chat. `CreateTicketRequest.reporter.userId` truyền xuống binding.
  Cột `reporter_user_id` nullable + index; `intakeApplySchema`/`notifyApplySchema`
  ALTER bù cột cho DB cũ. `normalizeUserId` bóc tiền tố `telegram:`.
- **`inspectBindingDb` + `startIntakeWorker({ dbPath })` (`@vuihoc/bot-core/core`)** —
  chốt chặn lỗi OP 16/10 (worker đọc nhầm `data/op.db` rỗng do path tương đối + CWD
  khác → nuốt mọi comment lặng lẽ). Lúc khởi động, lib resolve path tuyệt đối, đếm
  `ticket_bindings`, cảnh báo khi rỗng/thiếu bảng. Chỉ-đọc, không ném.
- **`auditBootstrapReadiness` / `isBootstrapSafe` (`@vuihoc/bot-core/openclaw`)** —
  guard thuần chống bot OpenClaw mới chạy onboarding với người thật (lộ cơ chế nội
  bộ — sự cố `@vhops_bot` 18/10). Phát hiện `BOOTSTRAP.md` còn, persona rỗng/template,
  AGENTS.md kiểu "home/first run"; `block` vs `warn`. Bot gọi lúc khởi động để từ
  chối phục vụ khi chưa seed.
- **Doc tốc độ realtime** (`docs/WORKER.md` §Nền tảng dùng chung): các knob tốc độ
  (ack-trước-handler, `TelegramTransport.timeoutMs`/`maxRetries`, `confirm.minConfirmDelayMs`)
  đã có và inject được — không hardcode. Không thêm code knob, chỉ chỉ ra cách cấu hình.

## 0.5.2 — 2026-10-17

One additive option, distilled from the OP bot (`operationbot`), which had to put a hand-written
TCP proxy in front of the webhook server because the server was hard-wired to `127.0.0.1` while
Itsaplan runs on another LAN machine.

- **`ItsaplanWebhookServerOptions.listenHost`** (default `"127.0.0.1"` — behaviour unchanged for every
  existing caller). A bot whose Itsaplan is on another host sets `"0.0.0.0"` (or the LAN IP) and the
  server receives webhooks directly; no proxy needed. `startIntakeWorker` forwards it through
  `config.server`. Binding off loopback WARNS when no `itsaplanSecrets` are set (anyone on the
  network could post a forged webhook); the loopback-only `/internal/*` endpoints still check the
  caller's address, so they stay loopback-only whatever the bind address. New `server.host()`
  reports the bound address.
- No other behaviour changed; shadow-parity unchanged.

## 0.5.1 — 2026-10-16

Three hardening fixes distilled from running the OP pilot's reverse channel
(comment → Telegram) end to end. All three are failure modes that stayed SILENT
in production — the webhook returned 200, the chat stayed quiet, and nothing in
the logs said why. Parity holds at 862/27/0; the existing layers' behaviour is
unchanged, only new log lines and one idempotency branch were added.

- **`ensureItsaplanWebhook` is now idempotent against a same-host, wrong-port webhook.**
  Previously, if a stale webhook pointed at the same host but a dead port and prune did not
  run, ensure would CREATE a brand-new webhook every start — leaking a growing pile of
  dead-port hooks. Now ensure detects a same-host hook whose URL only differs by port/path,
  rewrites it to the correct URL and reuses its id (keeping id/secret stable) instead of
  creating another. A hook on a *different* host is still left alone (another machine may
  serve the same project).
- **New `resolveDbPath(dbPath, base?)` in core.** A relative SQLite path (`data/op.db`)
  resolves against the process CWD — and the ticket-creation path and the worker ran under
  *different* CWDs, so each read/wrote a *different* `op.db`: the worker opened an empty DB
  with no bindings and silently dropped every comment. `resolveDbPath` returns an absolute
  path and WARNS on a relative input; `:memory:` and `file:` URIs pass through untouched.
- **The dispatcher no longer swallows a comment with no binding in silence.** `handleComment`
  and `handleStateChange` now log a WARN naming the issue id and pointing at the likely cause
  ("is the worker pointed at the DB that holds ticket_bindings?") before skipping, instead of
  a bare `return` that left no trace. This is what turned the OP reverse-channel diagnosis
  from guesswork into a one-line read.



New subpath `@vuihoc/bot-core/worker`: `startIntakeWorker(config)` assembles the
reverse-notification worker (webhook server + ensure/prune webhook + dispatcher +
reply-router) that every intake bot needs, distilled from standing up the OP pilot
end to end. A bot wires it with one call; see `docs/WORKER.md`.

- **Webhook URL can no longer drift from the listen port.** New `deriveWebhookUrl({host,
  port,...})` builds the registered URL from the port the server actually listens on, and
  `startIntakeWorker` uses it — removing the two-variable mismatch that sent OP's webhook to
  a dead port (`WEBHOOK_URL` said :3102 while the listener was :3104). The `ensureItsaplanWebhook`
  function itself was correct; the fix removes the operator's chance to pass a mismatched URL.
- New `pruneForeignWebhooks(client, projectKey, canonicalUrl)` removes a project's active
  webhooks that point at the same host but a different (dead) port, so a leftover from an
  earlier run cannot double-fire. `startIntakeWorker` prunes before registering (opt-out via
  `pruneStaleWebhooks: false`).
- Pure/injected: `startIntakeWorker` reads no `process.env`, binds the server on port 0 in
  tests, and takes the Itsaplan client, `ChannelPort`, stores and copy as arguments. Parity
  holds at 862/27/0; nothing in the existing layers changed behaviour.

### Verified live on the OP pilot
Project `OP` on Itsaplan (isolated from TECH), agent `op-agent` on
`op-deepseek/deepseek-v4.1-flash` (endpoint probed, 200 Anthropic), bot `@vhops_bot`. A chat
created ticket OP-1 with the correct verbatim description (inspected in the Itsaplan UI); a
staff comment fired the webhook and reached the worker's Telegram send — the only stop was
"chat not found" because the ticket was bound to a CLI session, not a real Telegram chat.
Comment/image two-way still needs a real Telegram message to bind a chat.

## 0.4.2 — 2026-10-16

Pays the 0.1.0 debt (CM's technical-detail leak hardening). `describeToolFailure` can now
hide the raw technical detail from the user-facing message via opt-in
`setToolFailureOptions({ hideDetailFromUser: true })`. **Default is `false`**, so the message
still carries the detail exactly as before (intake behaviour and its asserted strings
unchanged — parity stays 862/27/0). When enabled, the user sees only the error code and the
screenshot instruction; `chi_tiet` and the log line keep the full detail, and the injected
admin alert still receives it. A bot that does not want to show "Itsaplan 503", table names
or stack fragments to end users flips this on at startup.

## 0.4.1 — 2026-10-16

`core/lazy-db` now obeys ADR-0003 (SQLite is an ephemeral local cache; Itsaplan is the
source of truth): opening a corrupt/locked/undersized DB file no longer throws out of the
bot. It logs via the core logger and falls back to an empty in-memory SQLite with the
schema applied, so the bot runs on as "nothing known yet, ask again". New `isDegradedDb(db)`
tells a caller that a connection is the fallback. The path cache is kept, so a corrupt file
is not re-opened on every call. Read paths already return not-found/null for an empty table,
so the ask-again branch is reached with no further change. Parity still 862/27/0.

## 0.4.0 — 2026-10-16

New layer `identity` (gap-analysis A1): the register / approve / reject / relink
lifecycle, merged from intake `lib/storage/identity*` + `mcp/shared/tools/identity.ts`
and CM's hardened relink.
Shadow parity holds at **862/27/0** with 32 modules replaced; intake-agents hash unchanged.

- `IdentityService`: `checkUserApproval` (admin + `requireApproval` + prefix auto-approve +
  rejected handling), `registerIdentity` (name-code validation, anti-spoof when a code is
  bound to another user, auto-approve rules), `approveUser`/`rejectUser`, name-code
  normalize/extract/validateFormat/extractFromText. **Copy-free:** returns structured results
  with reason codes; the caller renders user-facing text. `nameCodePattern` is configurable
  (intake default). No Vietnamese strings in `src/identity`.
- `relinkIdentity`: rebind a name-code to a new `userId` preserving history, carrying CM's
  anti-account-takeover guard — the approver must pass an injected `isAuthorizedApprover`
  predicate (not a free string), never relink onto a protected admin id, and only a numeric
  id may take the primary key.
- `SqliteIdentityRepository` + `IdentityRepository` port, library-owned schema via the core
  lazy-db `applySchema` hook. **Channel-neutral:** the TS field is `userId` (for Telegram
  bots = telegram user id); the SQLite column stays `telegram_user_id`, so intake's schema is
  byte-identical and no bot migration is needed.
- `identityTools` factory (check/register/approve/reject/relink) on the core MCP scaffold,
  with the service and a copy renderer injected. Tiểu Linh's Vietnamese copy lives in
  `examples/tieulinh/identity-copy.ts`.
- Not shimmed (documented in A1): intake's `identity.service.ts` (reached only via its
  binding-fused MCP tool) and `mcp/shared/tools/identity.ts` (fuses binding+draft lookups and
  a telegram-specific input the library tool omits). The load-bearing `identity-repository.ts`
  is shimmed and holds parity.

## 0.3.0 — 2026-10-16

The user-facing half of Tiểu Linh: what Telegram actually shows and how replies flow
back. Mined from intake-agents history (83 of 249 commits touch Telegram, markdown,
media or buttons); every captured rule has a test named after its commit. Audit tables
(commit → rule → source → library location, or why left out) are in tickets 12–14.

**Parity:** shadow copy of Tiểu Linh with **31** modules replaced (26 earlier + Telegram
transport/buttons/alert, `lib/media.ts`, webhook pure helpers) → **862 pass / 27 skip /
0 fail**, identical to the live bot; intake-agents status hash unchanged.

### New layer `telegram` (tickets 12, 13)
- `TelegramTransport`: injected token/base URL/fetch (resolved lazily so test fetch swaps
  work); Telegram rejecting entities ("can't parse entities") → resend once as plain text,
  never lose the message (`40f7062`); 429 `retry_after` with floor + cap (CM); typed errors;
  `tryCall` never throws.
- `sendMessage` with safe inline buttons (invalid/oversized callback data dropped, message
  still sent — reuses `openclaw` pending-buttons); `ackReaction` 👀 (`4595d00`);
  `splitForTelegram` 4096 limit, UTF-16/surrogate safe (CM R7E-B1).
- `Alerter`: admin alerts via injected transport + admin ids, deduped.
- Inbound media finder (intake `9ea827b` ∪ CM) with path-traversal hardening, image type
  sniffing, size cap; adapters for the intake engine (`TelegramChannelSender`,
  `inboundMediaResolver`).
- `render`: tracker → Telegram (Itsaplan highlight HTML `<mark>/<span>/<video>` from
  `5bf501e`, escaping `_ * [ ]` so names like `PO_UserC` don't break Markdown, link/image
  handling, plain fallback) and Telegram → tracker (verbatim text with line breaks
  `7323bc7`, envelope by content `d0d1ed9`, machine button payloads dropped `4aabc54`,
  bot mentions stripped). 300 random names never leave unbalanced entity markers.

### `itsaplan/webhook` + `intake/notify` (ticket 14)
- Webhook front door: 1 MB body cap, HMAC `t=,v1=` over `${t}.${body}` with 5-minute
  tolerance and multiple secrets, Telegram `secret_token`, dedupe by event+issue+comment+ts
  (`a6275e7`), durable SQLite dedupe with conditional upsert (CM), project-lock before any
  side effect (`837fb08`).
- Dispatcher: human comments go to the bound chat, bot comments skipped (`isBotComment`),
  optional mention-only mode (`4cea3c9`), per-project state copy injected.
- Reply router: a reply to a notification becomes a comment on that ticket and never
  reaches the agent (`25c68db`); "OK" is a comment, never a state change; the bot never
  closes (ADR-0006); message routes scoped by chat id (`fd48c6e`).
- No Telegram/OpenClaw import in these modules — all through ports.

### Left in the bots (with reason, see tickets)
- Live `getFile` download (needs token + network), per-bot button catalogs,
  `getLastActiveChatId`, hardcoded pending dir, env-based `alertAdmin` facade.
- Intake's stateful `ItsaplanWebhookServer`, `notification-dispatcher`, `ticket-closure`
  (bound to intake schema, Notifier and KG side effects) — rules carried by the library,
  wiring stays in the bot. CM `outbox-dispatcher` (bound to CM schema).

## 0.2.0 — 2026-10-16

All five layers. Per-function provenance (intake / CM / Bot-Sales) and drift
decisions were recorded in the original standalone repo's tickets.

**Parity:** a shadow copy of Tiểu Linh with 26 modules replaced by this library
runs its own suite at **862 pass / 27 skip / 0 fail**, identical to the live bot
(`docs/parity/REPORT.md`, `bun run scripts/shadow-parity.ts`). The conversation
engine reproduces 13 `pipeline.flow` scenarios (`docs/parity/ENGINE.md`).

### `core` (ticket 03)
- MCP server scaffold: stdio + streamable HTTP that refuses non-loopback bind and
  unauthenticated requests (`createMcpServer`, intake's `createIntakeMcpServer` kept).
- PII redactor, env loader (Bot-Sales + CM), channel-envelope (CM superset of intake),
  generic formatting, lazy SQLite with injected schema, `memoByKey`, test-preload
  credential scrubber.
- **Bot-comment marker:** the written marker stays `<!-- intake-bot -->` by default;
  other bots call `setBotCommentMarker` (CM: `<!-- cm-bot -->`). `isBotComment`
  recognises every marker ever written. Changing the written marker would make live
  workers treat bot comments as human (KG learning, echo loops).

### `itsaplan` (ticket 04)
- One client: CM typed errors (`ItsaplanApiError`, `ItsaplanMalformedResponseError`,
  `isRetryableItsaplanError`), bounded retry on 429/5xx, plus intake metadata and the
  whole Itsaplan upgrade of intake `5bf501e` (teamRef URL, identifier match, digit keys).
- Project/status/attachments (media via injected resolver)/ticket-state/sync-labels/
  ensure-webhook/project-lock. Constructor-only config, no baked URLs.

### `intake` (tickets 05, 08, 09)
- Pure gate (catalog, budgets, one question per turn) and priority floor/ceiling engine,
  plus `resolveRequestedPriority`.
- Write path: ports (tracker, copy catalog, clock, bindings, media), revisioned SQLite
  draft store with atomic claim, per-chat lock, confirmation protocol
  (`minConfirmDelayMs` 5000, `confirmStaleMs` 120000), idempotent `createTicket`
  (verbatim description, marked bot comment), Itsaplan tracker adapter.
- `IntakeEngine.step()`: identifier-conflict park (TECH-928), full-report park, preview +
  button for every write to an existing ticket (ADR-0008), identifiers never overwritten
  (TECH-956), own-ticket edits only, envelope never in tickets (TECH-924), caps, `/new`,
  draft expiry. KG/similar is an optional post-create hook. Tiểu Linh copy/config in
  `examples/tieulinh/`.

### `openclaw` (ticket 07)
- Per-turn identity token (HMAC, expiry, replay store), agent gating, both
  context-injection strategies, Telegram token from `openclaw.json`, typed pending-button
  file contract (directory injected). Plugins vendor a bundle (ADR-0002).

### `prose` (ticket 06)
- `AGENTS.shared.md`, `LAYERS.md`, `skills/confirm-before-create`. Four cross-bot
  conflicts (address form, mirroring, greeting, multi-message) are left as bot overrides.

### Docs
- `docs/adoption/` guides for Tiểu Linh/Iris, CM, Bot-Sales (no bot was modified).
- Known risk recorded for the Bot-Sales owner: raw parent phone numbers in a plugin's
  JSONL log (`docs/adoption/bot-sales.md` §3).

## 0.1.0 — 2026-10-16

First slice: the `core` layer with `logger` and `tool-error`, merged from the
two reference bots. Where intake and CM diverged, the library takes the **union
of fixes**; on a behavioural conflict intake (the reference) wins unless CM is a
strict superset. Provenance per function:

### `core/logger`

| Export | Origin | Notes |
|---|---|---|
| `LogLevel` | both | identical in both sources |
| `IntakeLogger` interface | **intake** | primary API; kept so Tiểu Linh switches with no call-site change |
| `getLogger` / `setLogger` | **intake** | signatures are intake's; `setLogger` accepts any `IntakeLogger` |
| default console shim | **intake** | dependency-free default (keeps `bun build --compile` small) |
| `redactSecrets` | **CM** | added verbatim — Telegram/Bearer/`sk-`/GitHub tokens, kv password pairs, legacy password; recurses objects/arrays |
| `LogEntry` | **CM** | added |
| `Logger` class (level filtering, trace id, JSON emit, auto-redaction) | **CM** | added; now `implements IntakeLogger`, so `setLogger(new Logger(...))` works |

**Conflict resolved:** both sources exported `getLogger`/`setLogger` with
different types. CM's `setLogger(logger: Logger)` was narrowed into intake's
`setLogger(next: IntakeLogger)` (the primary API); the CM `Logger` class
satisfies that interface, so no behaviour is lost.

### `core/tool-error`

| Export | Origin | Notes |
|---|---|---|
| `ToolFailure` | **intake** | shape is intake's; `chi_tiet` doc note carried from CM |
| `newErrorCode` | both | identical |
| `describeToolFailure` | **intake** | intake's signature + its message body (raw `detail` echoed into `thong_bao_cho_nguoi_dung`, which intake's test asserts) |
| `CodedError` | **CM** | added |
| `errorCodeFor` | **CM** | added — a declared `code` like `E_TICKET_RATE_LIMITED` is kept as `ma_loi` |
| `ToolFailureAlert` + `setToolFailureAlert` | **new (replaces intake's import)** | intake imported `alertAdmin` from `./telegram/alert`; the library imports no Telegram. The admin alert is now an **injected hook** the host wires at startup |

**Conflicts resolved:**
- Admin alert: intake hard-imported Telegram; CM dropped the alert entirely. The
  library keeps the alert **behaviour** (intake) but via an injected hook, so
  `core` imports no Telegram — satisfying the "MCP imports pure code only" rule.
- Error code: intake used only random codes; CM added stable declared codes. The
  library keeps **both** via `errorCodeFor` (CM's superset).
- User-facing message: intake echoes the raw detail into
  `thong_bao_cho_nguoi_dung`; CM's later fix removed it to avoid leaking
  technical strings. intake is the reference and its suite asserts the echo, so
  **intake's message body is kept** for 0.1.0. The CM leak-hardening is a
  behaviour change deferred to a later version (noted here so it is not lost).
  **Resolved in 0.4.2** via opt-in `setToolFailureOptions({ hideDetailFromUser: true })`.
