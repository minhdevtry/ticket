# Đặc tả: PR 12 của RFC 0002 — huỷ và đóng ticket theo yêu cầu người báo (issue #26)

## Context

Repo: `minhdevtry/ticket`. Đây là PR 12 của chuỗi di trú lễ tân (`docs/rfc/0002-receptionist.md` mục 5), issue #26.

PR 1-10 đã merge vào `main`; PR 9 còn một vòng sửa review (PR #57, issue #59). PR 11 (issue #25, lệnh nhắm vào ticket đã có) đang được làm song song.

Mục tiêu của PR 12 là port **D8** — cơ chế người báo yêu cầu **huỷ** (Canceled) hoặc **đóng** (Done) ticket của chính mình, theo ADR-0006 bản 10/10.

**Bất biến cốt lõi (không được phá):**
- **ADR-0008**: Không đường ghi nào vào ticket đã có mà không qua bản xem trước và cú bấm nút khớp nhãn chính xác từ người báo.
- **ADR-0006**: Bot **không bao giờ tự đóng** ticket. Chỉ người báo yêu cầu và tự xác nhận thì mới chuyển cột.
- Chỉ người **báo** ticket đó mới được huỷ/đóng nó.

**Tài liệu đọc trước (bắt buộc):**
- `orchestration/WORKER-CONTRACT.md` — hợp đồng chung cho mọi worker Orca.
- `AGENTS.md` và `CODING_STANDARDS.md`.
- `packages/core/GLOSSARY.md` — thuật ngữ chuẩn.
- `docs/rfc/0002-receptionist.md` mục 1.3 (dòng D8), mục 2.1-2.4, mục 5 (hàng PR 12).
- `apps/tieulinh-legacy/docs/adr/0006-chi-nguoi-xu-ly-dong-ticket.md` và `0008-mot-luong-chat-ghi-vao-ticket-phai-xac-nhan.md`.

---

## Nguồn legacy (bản tham chiếu đóng băng — CHỈ ĐỌC)

| Hàm | Vị trí | Vai trò |
|---|---|---|
| `classifyCancelOrCloseIntent` | `apps/tieulinh-legacy/lib/intake-step/ticket-reply-router.ts:237` | Phân loại ý định `cancel` / `close` từ câu của người báo |
| `countSpecialistTimelineComments` | cùng file | Đếm bình luận của chuyên viên (loại trừ người báo, bot, admin) |
| `MIN_SPECIALIST_COMMENTS_FOR_DONE` | cùng file:23 | Ngưỡng = 3 |
| `proposeCancelOrClose` | `apps/tieulinh-legacy/lib/intake-step/pipeline.ts:2444` | Lập bản xem trước + quyết định `cancel_ticket` vs `close_ticket` |
| `countSpecialistComments` | `pipeline.ts:2409` | Bọc `countSpecialistTimelineComments` với ngữ cảnh reporter + assignee |
| `executeTicketAction` (nhánh `cancel_ticket`/`close_ticket`) | `pipeline.ts:2727-2800` | Thực thi chuyển cột + ghi comment lý do |
| `proposeTicketAction` | `pipeline.ts:2178` | Khung bản xem trước dùng chung (nút xác nhận / giữ lại) |

---

## Bảng quyết định (bắt buộc có test theo từng ô)

Trạng thái hiện tại của ticket: `open` | `resolved` | `done` | `canceled`.
Số bình luận chuyên viên: `n` (ngưỡng đóng = 3).

| # | Trạng thái | Ý định người báo | Kết quả |
|---|---|---|---|
| 1 | `done` hoặc `canceled` | bất kỳ | **Từ chối**, báo "ticket đã đóng ở trạng thái X, không chuyển lại" — không đề xuất, không ghi |
| 2 | khác | nói rõ "hủy/huỷ/bỏ/không cần nữa" | `cancel_ticket` → chuyển **Canceled** |
| 3 | `resolved` | nói "đóng" | `close_ticket` → chuyển **Done** |
| 4 | khác, `n >= 3` | nói "đóng" | `close_ticket` → chuyển **Done** |
| 5 | khác, `n < 3` | nói "đóng" | `cancel_ticket` → chuyển **Canceled** (chưa đủ điều kiện chuyên viên xử lý) |
| 6 | bất kỳ (chưa đóng) | người **không phải** chủ ticket | **Từ chối**, báo "không phải ticket anh/chị báo nên em không ghi vào được" |
| 7 | `done`/`canceled` | — | bấm nút xác nhận cũng phải từ chối (kiểm lại lúc thực thi, không chỉ lúc đề xuất) |
| 8 | bất kỳ | bấm "Giữ lại" | **không đổi gì** — ticket giữ nguyên trạng thái, không ghi comment |
| 9 | bất kỳ | bấm nút xác nhận | chuyển cột đúng theo ô đã chốt, **ghi comment** lý do (đã escape) + tải ảnh kèm |

**Chốt chặn an toàn tuyệt đối** (giữ nguyên từ legacy `pipeline.ts:2748-2752`): chỉ chuyển **Done** khi
`pending.kind === "close_ticket"` **VÀ** thỏa điều kiện chuyên viên xử lý — kiểm lại **lúc thực thi**
(không chỉ lúc đề xuất), vì ticket có thể đã đổi trạng thái giữa lúc đề xuất và lúc bấm nút.

---

## Target

1. **`packages/core/src/intake/engine/` — module mới cho D8:**
   - Port `classifyCancelOrCloseIntent` + các regex liên quan từ legacy `ticket-reply-router.ts` sang một module thuần (ví dụ `packages/core/src/intake/engine/cancel-close.ts` hoặc `packages/core/src/intake/commands/` — chọn chỗ đã có sẵn để không tạo thêm module trùng lặp; grep trước).
   - Port `countSpecialistTimelineComments` + `MIN_SPECIALIST_COMMENTS_FOR_DONE` (ngưỡng đưa vào **tham số cấu hình**, không hardcode trong logic).
   - `engine.ts`: mở rộng `pendingTicketAction.kind` với `"cancel_ticket" | "close_ticket"`.
   - `engine.ts`: nhánh đề xuất — đọc trạng thái ticket qua cổng đọc trạng thái (đã có ở PR 10: `isIssueClosed` / `resolveSupplementMentionTarget` trong `src/intake/notify/supplement-notifier.ts`), đếm bình luận chuyên viên, chốt `kind` theo bảng quyết định, rồi đề xuất kèm nút xác nhận + nút "Giữ lại".
   - `engine.ts`: nhánh thực thi — kiểm lại trạng thái và điều kiện chuyên viên **tại lúc bấm nút**, chuyển cột qua `TrackerPort.updateIssue`, ghi comment lý do (đã escape) và tải ảnh kèm.
   - `packages/core/src/intake/ports.ts` & `adapter.ts`: bổ sung cổng đọc timeline bình luận (`getIssueTimeline`) nếu chưa có; bổ sung `CopyKey` cho mọi câu trả lời và nút của D8.
   - **Core không hardcode tiếng Việt trong logic** — mọi câu gửi người báo lấy từ `CopyCatalog`; regex phân loại ý định là luật tất định và **được phép** ở core (giống `replies.ts` của PR 9), nhưng phải tách rõ chỗ nào là luật và chỗ nào là diễn đạt.

2. **Kiểm thử và sổ đối chiếu:**
   - **7 ca flow** từ `apps/tieulinh-legacy/lib/intake-step/pipeline.flow.test.ts` (giữ nguyên tên ca, chỉ đổi mã ticket về mã trung tính):
     - `hủy rõ (chưa xử lý / đang xử lý dở kể cả có ≥3 comment chuyên viên / đã xử lý Resolved) → luôn chuyển Canceled (cột 5) + escapeItsaplanMarkdown`
     - `nói 'đóng' khi chưa xử lý (0, 1 hoặc 2 bình luận chuyên viên, chưa ở Resolved) → chuyển Canceled (cột 5), nút [✅ Hủy ... / Giữ lại]`
     - `nói 'đóng' khi đã có chuyên viên xử lý (≥ 3 bình luận chuyên viên HOẶC đang ở cột Resolved) → chuyển Done (cột 4), nút [✅ Đóng ... / Giữ lại]`
     - `ticket đã ở Done (cột 4) hoặc Canceled (cột 5) → không chuyển lại, không ghi comment, trả lời lịch sự`
     - `không phải chủ ticket (ownTicket = false) → từ chối hủy/đóng, không đổi cột, không ghi comment`
     - `bấm nút 'Giữ lại' hoặc fallback trong proposeEdit khi ops=[] hoạt động chuẩn, và chốt chặn không bao giờ chuyển Done khi chưa đủ điều kiện` — ca này gộp **hai** ý: (a) bấm "Giữ lại" thì không đổi gì; (b) **chốt chặn lúc thực thi**: lúc hiện nút ticket ở Resolved, nhưng trước khi bấm xác nhận bị kéo lại In Progress với 1 bình luận chuyên viên → phải chuyển **Canceled**, không phải Done.
     - `người khác (chat khác) không bấm hộ nút xác nhận hủy được; câu mô tả sự cố có chữ đóng/hủy khi unclear hỏi lại Bổ sung/Sự cố mới chứ không hủy vé`
     - `TECH-1218: người báo gửi ảnh trước rồi gõ 'update vào tick TECHTEST-X' (hoặc ngược lại) → bảo toàn ảnh đính kèm và không ghi câu lệnh trần thành comment` — ca này thuộc **PR 11** (bổ sung), không thuộc D8; nếu PR 11 đã port thì **không port lại**, chỉ ghi vào báo cáo là đã phủ ở PR 11.
   - **5 ca phân loại** từ `apps/tieulinh-legacy/lib/intake-step/ticket-reply-router.test.ts` (giữ nguyên tên ca):
     - `phân loại tất định các câu thật yêu cầu HỦY rõ → intent = 'cancel'`
     - `phân loại tất định các câu yêu cầu ĐÓNG / báo đã dùng được (không kèm từ hủy) → intent = 'close'`
     - `không bắt nhầm câu sửa thật, chuyển ticket trùng, câu thiếu mã ticket hay mô tả sự cố có chữ hủy/đóng (≥20 câu thực tế)`
     - `LlmTicketCommandInterpreter định tuyến tất định sang cancel_or_close kể cả khi LLM trả edit / unclear`
     - `countSpecialistTimelineComments chỉ đếm bình luận của chuyên viên TECH, loại bỏ bot và người báo`
   - Bảng quyết định ở trên: **mỗi ô một ca test**, tên ca đặt theo tên ca legacy nếu có.
   - Cập nhật `apps/tieulinh/receptionist-gap-register.test.ts`: chỉ chuyển dòng D8 sang `ported` khi port thật.
   - Cập nhật `docs/rfc/0002-receptionist.md`: dòng D8 sang trạng thái đúng, và cột "PR" của dòng đó.
   - `packages/core/CHANGELOG.md`: ghi thay đổi.

---

## Ranh giới

- **Chỉ sửa trong `packages/core/`, `apps/tieulinh/` (sổ đối chiếu) và `docs/`.**
- **`apps/tieulinh-legacy/**` chỉ đọc** — không sửa, không import code legacy vào app mới.
- Không đụng `.github/workflows/**`, `scripts/**`, `biome.lint-baseline.json`, `bun.lock`.
- Không tự tạo/sửa/đóng issue. Không commit, không push (coordinator làm).

## Cần chủ quyết (ghi vào báo cáo, không tự quyết)

- **Chuyển cột Canceled/Done cần cổng cập nhật cột nào?** Legacy tra cột theo `classifyColumn(c)` trong
  `listProjectColumns(projectKey)`. Core cần cùng cách — nhưng nếu ứng dụng khác dùng tên cột khác
  thì phải qua cấu hình, không hardcode.
- **Ngưỡng 3 bình luận chuyên viên** có để cấu hình được không (legacy có `minSpecialistCommentsForDone`)?
  Nếu có thì đưa vào `IntakeEngineDeps` với mặc định 3.
