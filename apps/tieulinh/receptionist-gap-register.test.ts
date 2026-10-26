/**
 * SỔ ĐỐI CHIẾU LỄ TÂN (receptionist gap register): test legacy của lễ tân (apps/tieulinh-legacy) ->
 * test của core / Tiểu Linh mới. PR 1 của RFC 0002 (docs/rfc/0002-receptionist.md, mục 5).
 *
 * File này KHÔNG tự kiểm hành vi, và PR này không port gì. Nó chỉ giữ cho sổ khỏi nói dối, giống
 * `gap-register.test.ts` của nửa hậu cần:
 *
 * - Mỗi test legacy của các file trong `ROWS` là MỘT dòng (khớp tên chính xác, không trùng). Đổi tên,
 *   xoá hoặc thêm một test legacy mà quên cập nhật sổ thì test này đỏ.
 * - Dòng `ported`/`core` phải trỏ tới test mới có thật (theo tên). Dòng `deferred`/`by-design` phải nêu
 *   lý do; `deferred` nói rõ PR nào của RFC 0002 sẽ port.
 * - File test legacy không thuộc lễ tân (hạ tầng dùng chung, KG/Onyx, hậu cần) ghi một dòng cho cả
 *   file ở `FILE_ROWS`; mọi file test của legacy phải nằm trong đúng một nơi.
 * - Số liệu ở `packages/core/docs/parity/ENGINE.md` (dòng `gap-register`) phải khớp sổ này.
 *
 * Khi PR 2..13 port một nhóm test: đổi dòng từ `deferred` sang `ported` và trỏ tới test mới.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const LEGACY = "apps/tieulinh-legacy/";
const CORE = "packages/core/src/";

type Status = "ported" | "core" | "deferred" | "by-design";
type Ref = { file: string; title: string };
type Row = {
  /** File test legacy, tương đối từ `apps/tieulinh-legacy/`. */
  file: string;
  /** Tên test legacy (khớp chính xác). */
  title: string;
  status: Status;
  /** `ported`/`core`: test mới tương ứng. */
  to?: Ref[];
  /** `deferred`/`by-design`: lý do. */
  why?: string;
};
type FileRow = {
  file: string;
  status: Exclude<Status, "ported">;
  why: string;
  /** `core`: file test tương đương ở core (tương đối từ `packages/core/src/`). */
  to?: string;
};

/** Cùng cách tách tên test với bộ kiểm: `test("…")`/`it("…")` đầu dòng, chuỗi đầu tiên. */
function legacyTitles(src: string): string[] {
  const out: string[] = [];
  const re = /^[ \t]*(?:test|it)\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/gm;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const lit = m[1] as string;
    if (lit.startsWith('"')) out.push(JSON.parse(lit) as string);
    else if (lit.startsWith("'")) out.push(lit.slice(1, -1).replace(/\\(.)/g, "$1"));
    else out.push(lit.slice(1, -1));
  }
  return out;
}

const C = (file: string, title: string): Ref => ({ file: `${CORE}${file}`, title });
const APP = (file: string, title: string): Ref => ({ file: `apps/tieulinh/${file}`, title });

const row = (file: string, title: string, status: Status, rest: Ref[] | string): Row =>
  typeof rest === "string" ? { file, title, status, why: rest } : { file, title, status, to: rest };

const fileRow = (file: string, status: FileRow["status"], why: string, to?: string): FileRow => ({
  file,
  status,
  why,
  to,
});

/** Nửa hậu cần: đã có sổ riêng (`gap-register.test.ts`). */
const HAU_CAN_FILES = [
  "worker/agent-runner.test.ts",
  "worker/lifecycle.test.ts",
  "worker/notification-dispatcher.test.ts",
  "worker/ticket-closure.test.ts",
  "worker/duplicate-merger.test.ts",
  "worker/notifier.test.ts",
];

const ROWS: Row[] = [
  // ── lib/intake-step/pipeline.flow.test.ts (77) ──
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "xác nhận tới ngay sau tóm tắt (model tự gọi) KHÔNG tạo ticket; người thật xác nhận sau đó thì tạo",
    "core",
    [
      C(
        "intake/engine/engine.test.ts",
        "MIN_CONFIRM_DELAY_MS: a confirm <5s after the summary is rejected (gemini 1.1s self-click)",
      ),
      C(
        "intake/create/create-ticket.test.ts",
        "REAL INCIDENT: model self-click 1.1s after summary is rejected",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "tóm tắt hiện mức ưu tiên bằng tiếng Việt, không in 'MEDIUM'",
    "ported",
    [
      C(
        "intake/engine/legacy-flows.test.ts",
        "tóm tắt hiện mức ưu tiên bằng tiếng Việt, không in 'MEDIUM'",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "tin đầu 'Yêu cầu hỗ trợ: …' / 'ok app Duo lỗi…' không bao giờ tạo ticket",
    "deferred",
    "Chờ port ở PR 5 (llmExtractor và heuristic tiếng Việt): heuristic nhận 'Yêu cầu' là báo sự cố",
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "'ok' khi tài liệu chưa từng được tóm tắt không tạo ticket",
    "ported",
    [
      C(
        "intake/engine/legacy-flows.test.ts",
        "'ok' khi tài liệu chưa từng được tóm tắt không tạo ticket",
      ),
      C("intake/create/create-ticket.test.ts", "confirm before a summary was shown cannot create"),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "'không vào được lớp' không huỷ tài liệu (không LLM)",
    "ported",
    [
      C(
        "intake/engine/legacy-flows.test.ts",
        "'không vào được lớp' không huỷ tài liệu (không LLM)",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "câu hỏi dùng nhãn tiếng Việt, không lộ tên trường nội bộ, và nút được đẩy ra Telegram",
    "ported",
    [
      C(
        "intake/engine/legacy-flows.test.ts",
        "câu hỏi dùng nhãn tiếng Việt, không lộ tên trường nội bộ, và nút được đẩy ra Telegram",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "'không biết' được ghi vào explicitlyMissing và bot thôi hỏi trường đó",
    "ported",
    [
      C(
        "intake/engine/legacy-flows.test.ts",
        "'không biết' được ghi vào explicitlyMissing và bot thôi hỏi trường đó",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "mặc định Medium (không còn rơi về Low) và gửi Itsaplan chữ thường",
    "ported",
    [
      C(
        "intake/engine/legacy-flows.test.ts",
        "mặc định Medium (không còn rơi về Low) và gửi Itsaplan chữ thường",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "bằng chứng chặn thanh toán nâng lên urgent",
    "core",
    [C("intake/engine/engine.test.ts", "blocksPayment floor raises the created ticket to Urgent")],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "xin khẩn cấp kèm lý do → Urgent, lý do vào ticket",
    "core",
    [
      C(
        "intake/engine/engine.test.ts",
        "requested priority honoured only with a reason (29/09 decision)",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "xin gấp chưa có lý do → hỏi một lần; trả lời lý do → High",
    "ported",
    [
      C(
        "intake/engine/legacy-flows.test.ts",
        "xin gấp chưa có lý do → hỏi một lần; trả lời lý do → High",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "ticket đã tạo, xin khẩn cấp kèm lý do → nâng mức trên ticket + comment lý do",
    "ported",
    [
      C(
        "intake/engine/pr10-post-create.test.ts",
        "ticket đã tạo, xin khẩn cấp kèm lý do → nâng mức trên ticket + comment lý do",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "xin gấp mà 'không có' lý do → giữ mức theo bằng chứng",
    "core",
    [C("intake/engine/engine.test.ts", "requested priority with NO reason is ignored")],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "tạo ticket: có binding, dọn bản nháp, nút xác nhận hiện lúc tóm tắt và bị xoá sau khi tạo",
    "deferred",
    "Chờ port ở PR 16 (adapter OpenClaw cho pack lễ tân): nút xác nhận do plugin OpenClaw vẽ và xoá; binding thuộc PR 3",
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "tin chỉ có ảnh không làm sập, ảnh được gắn vào tài liệu rồi tải lên ticket",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket): gắn ảnh vào ticket (J1)",
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "tạo ticket lỗi: không báo thành công, không lộ lỗi nội bộ, giữ tóm tắt để thử lại",
    "core",
    [
      C(
        "intake/create/create-ticket.test.ts",
        "tracker failure keeps the draft recoverable and reports failure",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "xác nhận lần hai: không tạo thêm, không comment rác",
    "ported",
    [
      C(
        "intake/engine/legacy-flows.test.ts",
        "xác nhận lần hai: không tạo thêm, không comment rác",
      ),
      C(
        "intake/engine/engine.test.ts",
        "idempotent create: a second confirm returns the same ticket, never a duplicate",
      ),
      C(
        "intake/create/create-ticket.test.ts",
        "REAL INCIDENT: double-confirm returns the SAME ticket (no duplicate)",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "hai cú xác nhận đồng thời chỉ tạo MỘT ticket",
    "core",
    [
      C(
        "intake/engine/engine.test.ts",
        "idempotent create: a second confirm returns the same ticket, never a duplicate",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "'cảm ơn em' sau khi tạo không đụng tới ticket",
    "ported",
    [C("intake/engine/pr10-post-create.test.ts", "'cảm ơn em' sau khi tạo không đụng tới ticket")],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "thông tin bổ sung sau khi tạo → comment, KHÔNG ghi đè mô tả",
    "ported",
    [
      C(
        "intake/engine/pr10-post-create.test.ts",
        "thông tin bổ sung sau khi tạo → comment, KHÔNG ghi đè mô tả",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "tin có ảnh, không xung đột định danh → hỏi, chưa ghi gì",
    "ported",
    [
      C(
        "intake/engine/pr10-post-create.test.ts",
        "tin có ảnh, không xung đột định danh → hỏi, chưa ghi gì",
      ),
    ],
  ),
  row("lib/intake-step/pipeline.flow.test.ts", "chỉ gửi ảnh → cũng hỏi, không ghi", "ported", [
    C("intake/engine/pr10-post-create.test.ts", "chỉ gửi ảnh → cũng hỏi, không ghi"),
  ]),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    'hỏi rồi người báo GÕ "ticket mới ạ" → sự cố mới từ tin đang chờ, ticket cũ không bị đụng',
    "ported",
    [
      C(
        "intake/engine/pr10-post-create.test.ts",
        'hỏi rồi người báo GÕ "ticket mới ạ" → sự cố mới từ tin đang chờ, ticket cũ không bị đụng',
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    'vừa tạo xong, người báo chỉ nhắn "ticket mới ạ" → mở tài liệu mới xin mô tả, không ghi gì',
    "ported",
    [
      C(
        "intake/engine/pr10-post-create.test.ts",
        'vừa tạo xong, người báo chỉ nhắn "ticket mới ạ" → mở tài liệu mới xin mô tả, không ghi gì',
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "hiểu ý chọn ticket cũ, mỗi ticket đang mở có nút riêng; bấm nút ticket cũ mới ghi vào ticket cũ",
    "ported",
    [
      C(
        "intake/engine/pr10-post-create.test.ts",
        "hiểu ý chọn ticket cũ, mỗi ticket đang mở có nút riêng; bấm nút ticket cũ mới ghi vào ticket cũ",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "không rõ ticket nào → gợi ý ticket vừa tạo, nhưng ticket cũ vẫn có nút để chọn đúng",
    "ported",
    [
      C(
        "intake/engine/pr10-post-create.test.ts",
        "không rõ ticket nào → gợi ý ticket vừa tạo, nhưng ticket cũ vẫn có nút để chọn đúng",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "chỉ khi bấm nút xác nhận mới ghi comment vào ticket",
    "core",
    [
      C(
        "intake/engine/engine.test.ts",
        "append executes only on an exact button match (ADR-0008, TECH-975/1013)",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "sự cố mới sau khi tạo → tài liệu mới, không ghi vào ticket cũ",
    "ported",
    [
      C(
        "intake/engine/pr10-post-create.test.ts",
        "sự cố mới sau khi tạo → tài liệu mới, không ghi vào ticket cũ",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "sau khi huỷ, lượt tiếp theo mở tài liệu mới và KHÔNG quên thông tin các lượt sau",
    "ported",
    [
      C(
        "intake/engine/pr8-park.test.ts",
        "sau khi huỷ, lượt tiếp theo mở tài liệu mới và KHÔNG quên thông tin các lượt sau",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "bản nháp im lặng quá 24h hết hạn, tin mới mở tài liệu mới",
    "core",
    [C("intake/engine/engine.test.ts", "an expired draft closes and a later message starts fresh")],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "thiếu hệ thống: hỏi MỘT lần kèm nút, không biết thì tóm tắt ghi rõ 'Chưa xác định'",
    "ported",
    [
      C(
        "intake/engine/legacy-flows.test.ts",
        "thiếu hệ thống: hỏi MỘT lần kèm nút, không biết thì tóm tắt ghi rõ 'Chưa xác định'",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "chọn hệ thống qua nút thì điền đúng giá trị",
    "ported",
    [C("intake/engine/legacy-flows.test.ts", "chọn hệ thống qua nút thì điền đúng giá trị")],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "Knowledge Graph chỉ được tra một lần mỗi tài liệu, chạy nền SAU khi tạo ticket",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "KG không có gì CHẮC CHẮN nhưng có cụm 'có thể liên quan' → gợi ý ở comment riêng, KHÔNG ghi Related Tickets/link (TECH-956)",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "KG không tìm được ứng viên nào chắc chắn hay có thể liên quan → im lặng như trước (không kgAdvice)",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "phong bì kênh (Conversation info / Sender / context) không lọt vào mô tả ticket",
    "ported",
    [
      C(
        "intake/engine/legacy-flows.test.ts",
        "phong bì kênh (Conversation info / Sender / context) không lọt vào mô tả ticket",
      ),
      C(
        "intake/engine/engine.test.ts",
        "channel envelope never enters the ticket description (TECH-924)",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "tin nhắn rất dài không thổi phồng mô tả ticket",
    "ported",
    [
      C("intake/engine/legacy-flows.test.ts", "tin nhắn rất dài không thổi phồng mô tả ticket"),
      C(
        "intake/engine/engine.test.ts",
        "rawText cap: a huge paste is truncated to MAX_RAW_TEXT_CHARS (4.000, trần của legacy)",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "tin có SĐT khác với tờ khai đang chờ KHÔNG bị gộp lặng lẽ — hỏi sự cố mới hay bổ sung",
    "core",
    [
      C(
        "intake/engine/engine.test.ts",
        "identifier-conflict parks and asks new-incident-or-append (TECH-928)",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    'chọn "Sự cố mới" → tờ khai A giữ nguyên không đổi, tin B mở một tài liệu độc lập với đúng dữ liệu của B',
    "core",
    [
      C(
        "intake/engine/engine.test.ts",
        "pressing New incident starts a fresh draft from the held message (TECH-928)",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    'chọn "Bổ sung sự cố đang chờ" → gộp tin B vào CHÍNH tờ khai A (người dùng đã xác nhận là cùng sự cố)',
    "ported",
    [
      C(
        "intake/engine/pr8-park.test.ts",
        'chọn "Bổ sung sự cố đang chờ" → gộp tin B vào CHÍNH tờ khai A (người dùng đã xác nhận là cùng sự cố)',
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "trả lời không rõ (không bấm 1 trong 2 nút) → hỏi lại, không đoán, không mất dữ liệu bên nào",
    "ported",
    [
      C(
        "intake/engine/pr8-park.test.ts",
        "trả lời không rõ (không bấm 1 trong 2 nút) → hỏi lại, không đoán, không mất dữ liệu bên nào",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "ticket đã tạo + tin có mã khác → hỏi sự cố mới hay bổ sung, không tự ghi bổ sung",
    "ported",
    [
      C(
        "intake/engine/pr10-post-create.test.ts",
        "ticket đã tạo + tin có mã khác → hỏi sự cố mới hay bổ sung, không tự ghi bổ sung",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    'ticket đã tạo + tin có mã khác + chọn "Bổ sung" → ghi bổ sung vào ticket đó',
    "ported",
    [
      C(
        "intake/engine/pr10-post-create.test.ts",
        'ticket đã tạo + tin có mã khác + chọn "Bổ sung" → ghi bổ sung vào ticket đó',
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    'đang hỏi sự cố mới hay bổ sung, người dùng gõ "thôi huỷ" → bỏ tin vừa rồi, tờ khai A giữ nguyên',
    "ported",
    [
      C(
        "intake/engine/pr8-park.test.ts",
        'đang hỏi sự cố mới hay bổ sung, người dùng gõ "thôi huỷ" → bỏ tin vừa rồi, tờ khai A giữ nguyên',
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "nhắc lại ĐÚNG SĐT đã cho (cùng sự cố, không phải số khác) — không hỏi lại, không chặn nhầm",
    "core",
    [
      C(
        "intake/engine/engine.test.ts",
        "same number shortened/with area code is NOT a conflict (TECH-928 digit-subset)",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    'B tạo ticket xong → ticket_created nhắc tên A kèm nút "Tiếp tục sự cố đang chờ"; bấm nút → quay lại đúng A (docId, SĐT, tiêu đề của A) chờ xác nhận',
    "ported",
    [
      C(
        "intake/engine/pr8-park.test.ts",
        'B tạo ticket xong → ticket_created nhắc tên A kèm nút "Tiếp tục sự cố đang chờ"; bấm nút → quay lại đúng A (docId, SĐT, tiêu đề của A) chờ xác nhận',
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "không có tờ khai nào bị gác lại → ticket_created bình thường, không có câu nhắc/nút phụ",
    "ported",
    [
      C(
        "intake/engine/pr8-park.test.ts",
        "không có tờ khai nào bị gác lại → ticket_created bình thường, không có câu nhắc/nút phụ",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    'B bị HUỶ (không tạo ticket) → packet "canceled" cũng nhắc về A còn đang chờ',
    "ported",
    [
      C(
        "intake/engine/pr8-park.test.ts",
        'B bị HUỶ (không tạo ticket) → packet "canceled" cũng nhắc về A còn đang chờ',
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "tờ khai đang hỏi trường thiếu + tin mới là lời báo sự cố trọn vẹn → hỏi sự cố mới hay bổ sung",
    "core",
    [
      C(
        "intake/engine/engine.test.ts",
        "full report while another draft is mid-collection parks (E2E 28/09)",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "customerId thật không bị reground/xoá dù symptoms LLM paraphrase không còn chữ số (TECH-956)",
    "ported",
    [
      C(
        "intake/engine/pr8-park.test.ts",
        "customerId thật không bị reground/xoá dù symptoms LLM paraphrase không còn chữ số (TECH-956)",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "thiếu dữ kiện → hỏi MỘT lượt, câu trả lời vào mô tả rồi mới tóm tắt",
    "ported",
    [
      C(
        "intake/engine/pr13-review-checklist.test.ts",
        "thiếu dữ kiện → hỏi MỘT lượt, câu trả lời vào mô tả rồi mới tóm tắt",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "câu trả lời chỉ gồm một mã vẫn vào mô tả",
    "ported",
    [C("intake/engine/pr13-review-checklist.test.ts", "câu trả lời chỉ gồm một mã vẫn vào mô tả")],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "mã đơn / link có trong lời báo được đưa vào 'Trường đã có'",
    "ported",
    [
      C(
        "intake/engine/pr13-review-checklist.test.ts",
        "mã đơn / link có trong lời báo được đưa vào 'Trường đã có'",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "người báo bấm 'Không có' → tóm tắt luôn, không hỏi lại",
    "ported",
    [
      C(
        "intake/engine/pr13-review-checklist.test.ts",
        "người báo bấm 'Không có' → tóm tắt luôn, không hỏi lại",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "hỏi hết (checklist): một tin có ảnh màn hình, trả lời/'Không có' đều đi tiếp tới tóm tắt",
    "ported",
    [
      C(
        "intake/engine/pr13-review-checklist.test.ts",
        "hỏi hết (checklist): một tin có ảnh màn hình, trả lời/'Không có' đều đi tiếp tới tóm tắt",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "đủ dữ kiện hoặc soát lỗi → tóm tắt như cũ",
    "ported",
    [C("intake/engine/pr13-review-checklist.test.ts", "đủ dữ kiện hoặc soát lỗi → tóm tắt như cũ")],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "kỹ thuật vừa hỏi → GỢI Ý bổ sung, chưa ghi gì; bấm xác nhận mới ghi",
    "ported",
    [
      C(
        "intake/engine/pr11-ticket-commands.test.ts",
        "kỹ thuật vừa hỏi → GỢI Ý bổ sung, chưa ghi gì; bấm xác nhận mới ghi",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "giục gấp có lý do vào ticket có sẵn → chỉ khi bấm xác nhận mới nâng mức + ghi lý do (thay escalate_issue cũ)",
    "ported",
    [
      C(
        "intake/engine/pr11-ticket-commands.test.ts",
        "giục gấp có lý do vào ticket có sẵn → chỉ khi bấm xác nhận mới nâng mức + ghi lý do (thay escalate_issue cũ)",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "gợi ý → 'Sự cố mới' thì tin vào tờ khai, không ghi ticket cũ",
    "ported",
    [
      C(
        "intake/engine/pr11-ticket-commands.test.ts",
        "gợi ý → 'Sự cố mới' thì tin vào tờ khai, không ghi ticket cũ",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "'bổ sung TECHTEST-795 …' khi đang soạn dở → xem trước + Huỷ; Huỷ thì không ghi, tờ khai giữ nguyên",
    "ported",
    [
      C(
        "intake/engine/pr11-ticket-commands.test.ts",
        "'bổ sung TECHTEST-795 …' khi đang soạn dở → xem trước + Huỷ; Huỷ thì không ghi, tờ khai giữ nguyên",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "đang chờ xác nhận mà nhắn việc khác → bỏ bản xem trước, xử lý tin mới như thường",
    "ported",
    [
      C(
        "intake/engine/pr11-ticket-commands.test.ts",
        "đang chờ xác nhận mà nhắn việc khác → bỏ bản xem trước, xử lý tin mới như thường",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "ticket của người khác: không cho bổ sung, tra cứu chỉ thấy trạng thái",
    "core",
    [
      C(
        "intake/engine/engine.test.ts",
        "own-ticket-only edits; someone else's ticket gets status only (ADR-0008 §6)",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "ticket có Telegram ID người báo trong mô tả cũng là của mình (ticket bot cũ)",
    "ported",
    [
      C(
        "intake/engine/pr11-ticket-commands.test.ts",
        "ticket có Telegram ID người báo trong mô tả cũng là của mình (ticket bot cũ)",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "sửa: xem trước cũ → mới, xác nhận thì sửa thẳng + comment dấu vết",
    "ported",
    [
      C(
        "intake/engine/pr11-ticket-commands.test.ts",
        "sửa: xem trước cũ → mới, xác nhận thì sửa thẳng + comment dấu vết",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "bot vừa tạo nhầm → 'cái này bổ sung cho TECHTEST-795' → xác nhận: chép sang 795, nối trùng, huỷ bản vừa tạo",
    "ported",
    [
      C(
        "intake/engine/pr11-ticket-commands.test.ts",
        "bot vừa tạo nhầm → 'cái này bổ sung cho TECHTEST-795' → xác nhận: chép sang 795, nối trùng, huỷ bản vừa tạo",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "tin báo trạng thái, ticket đã huỷ, hay lời 'huỷ'/'cảm ơn' → không gợi ý ghi vào ticket",
    "ported",
    [
      C(
        "intake/engine/pr11-ticket-commands.test.ts",
        "tin báo trạng thái, ticket đã huỷ, hay lời 'huỷ'/'cảm ơn' → không gợi ý ghi vào ticket",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "không có câu hỏi kỹ thuật, không nhắc mã → không gọi bộ đọc lệnh",
    "ported",
    [
      C(
        "intake/engine/pr11-ticket-commands.test.ts",
        "không có câu hỏi kỹ thuật, không nhắc mã → không gọi bộ đọc lệnh",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "đang soạn dở tờ khai → câu trả lời cho tờ khai không bị kéo sang ticket kỹ thuật vừa hỏi",
    "ported",
    [
      C(
        "intake/engine/pr11-ticket-commands.test.ts",
        "đang soạn dở tờ khai → câu trả lời cho tờ khai không bị kéo sang ticket kỹ thuật vừa hỏi",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "'/new' (cờ plugin) → mở sự cố mới, gác tờ khai đang dở",
    "core",
    [C("intake/engine/engine.test.ts", "forceNew parks the open draft and opens a new one")],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "hủy rõ (chưa xử lý / đang xử lý dở kể cả có ≥3 comment chuyên viên / đã xử lý Resolved) → luôn chuyển Canceled (cột 5) + escapeItsaplanMarkdown",
    "ported",
    [
      C(
        "intake/engine/pr12-cancel-close.test.ts",
        "hủy rõ (chưa xử lý / đang xử lý dở kể cả có ≥3 comment chuyên viên / đã xử lý Resolved) → luôn chuyển Canceled (cột 5) + escapeItsaplanMarkdown",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "nói 'đóng' khi chưa xử lý (0, 1 hoặc 2 bình luận chuyên viên, chưa ở Resolved) → chuyển Canceled (cột 5), nút [✅ Hủy ... / Giữ lại]",
    "ported",
    [
      C(
        "intake/engine/pr12-cancel-close.test.ts",
        "nói 'đóng' khi chưa xử lý (0, 1 hoặc 2 bình luận chuyên viên, chưa ở Resolved) → chuyển Canceled (cột 5), nút [✅ Hủy ... / Giữ lại]",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "nói 'đóng' khi đã có chuyên viên xử lý (≥ 3 bình luận chuyên viên HOẶC đang ở cột Resolved) → chuyển Done (cột 4), nút [✅ Đóng ... / Giữ lại]",
    "ported",
    [
      C(
        "intake/engine/pr12-cancel-close.test.ts",
        "nói 'đóng' khi đã có chuyên viên xử lý (≥ 3 bình luận chuyên viên HOẶC đang ở cột Resolved) → chuyển Done (cột 4), nút [✅ Đóng ... / Giữ lại]",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "ticket đã ở Done (cột 4) hoặc Canceled (cột 5) → không chuyển lại, không ghi comment, trả lời lịch sự",
    "ported",
    [
      C(
        "intake/engine/pr12-cancel-close.test.ts",
        "ticket đã ở Done (cột 4) hoặc Canceled (cột 5) → không chuyển lại, không ghi comment, trả lời lịch sự",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "không phải chủ ticket (ownTicket = false) → từ chối hủy/đóng, không đổi cột, không ghi comment",
    "ported",
    [
      C(
        "intake/engine/pr12-cancel-close.test.ts",
        "không phải chủ ticket (ownTicket = false) → từ chối hủy/đóng, không đổi cột, không ghi comment",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "bấm nút 'Giữ lại' hoặc fallback trong proposeEdit khi ops=[] hoạt động chuẩn, và chốt chặn không bao giờ chuyển Done khi chưa đủ điều kiện",
    "ported",
    [
      C(
        "intake/engine/pr12-cancel-close.test.ts",
        "bấm nút 'Giữ lại' hoặc fallback trong proposeEdit khi ops=[] hoạt động chuẩn, và chốt chặn không bao giờ chuyển Done khi chưa đủ điều kiện",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "người khác (chat khác) không bấm hộ nút xác nhận hủy được; câu mô tả sự cố có chữ đóng/hủy khi unclear hỏi lại Bổ sung/Sự cố mới chứ không hủy vé",
    "ported",
    [
      C(
        "intake/engine/pr12-cancel-close.test.ts",
        "người khác (chat khác) không bấm hộ nút xác nhận hủy được; câu mô tả sự cố có chữ đóng/hủy khi unclear hỏi lại Bổ sung/Sự cố mới chứ không hủy vé",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.flow.test.ts",
    "TECH-1218: người báo gửi ảnh trước rồi gõ 'update vào tick TECHTEST-X' (hoặc ngược lại) → bảo toàn ảnh đính kèm và không ghi câu lệnh trần thành comment",
    "ported",
    [
      C(
        "intake/engine/pr11-ticket-commands.test.ts",
        "TECH-1218: người báo gửi ảnh trước rồi gõ 'update vào tick TECHTEST-X' (hoặc ngược lại) → bảo toàn ảnh đính kèm và không ghi câu lệnh trần thành comment",
      ),
    ],
  ),
  // ── lib/intake-step/multi-incident.test.ts (17) ──
  row(
    "lib/intake-step/multi-incident.test.ts",
    "chỉ coi là tên người khi từ ĐẦU là họ Việt và mọi từ viết hoa Unicode thật",
    "ported",
    [
      C(
        "intake/extractor/heuristics.test.ts",
        "chỉ coi là tên người khi từ ĐẦU là họ Việt và mọi từ viết hoa Unicode thật",
      ),
    ],
  ),
  row(
    "lib/intake-step/multi-incident.test.ts",
    "chốt tiêu đề: nhận 8 tiêu đề Title-Case, từ chối tên người / mã trần / lời chào",
    "ported",
    [
      C(
        "intake/extractor/heuristics.test.ts",
        "chốt tiêu đề: nhận 8 tiêu đề Title-Case, từ chối tên người / mã trần / lời chào",
      ),
    ],
  ),
  row(
    "lib/intake-step/multi-incident.test.ts",
    "deriveFallbackTitle lấy dòng mô tả lỗi, không lấy tên học sinh (TECH-1146)",
    "ported",
    [
      C(
        "intake/extractor/heuristics.test.ts",
        "deriveFallbackTitle lấy dòng mô tả lỗi, không lấy tên học sinh (TECH-1146)",
      ),
    ],
  ),
  row(
    "lib/intake-step/multi-incident.test.ts",
    "extractBlockInfo bỏ qua tham số URL, SĐT, TK/MK, mã phiếu thu; chỉ lấy định danh có nhãn",
    "ported",
    [
      C(
        "intake/engine/identifiers.test.ts",
        "extractBlockInfo bỏ qua tham số URL, SĐT, TK/MK, mã phiếu thu; chỉ lấy định danh có nhãn",
      ),
    ],
  ),
  row(
    "lib/intake-step/multi-incident.test.ts",
    "identityConflict chỉ so CÙNG LỚP định danh, và chỉ khi cả hai bên đều có",
    "ported",
    [
      C(
        "intake/engine/identifiers.test.ts",
        "identityConflict chỉ so CÙNG LỚP định danh, và chỉ khi cả hai bên đều có",
      ),
    ],
  ),
  row(
    "lib/intake-step/multi-incident.test.ts",
    "splitMultiIncidentReport tách đúng 2 học sinh từ văn bản thật TECH-1146",
    "ported",
    [
      C(
        "intake/split/split.test.ts",
        "splitMultiIncidentReport tách đúng 2 học sinh từ văn bản thật TECH-1146",
      ),
    ],
  ),
  row(
    "lib/intake-step/multi-incident.test.ts",
    "splitMultiIncidentReport tách đúng 2 ca độc lập từ mã CRM (TECH-1248/1249)",
    "ported",
    [
      C(
        "intake/split/split.test.ts",
        "splitMultiIncidentReport tách đúng 2 ca độc lập từ mã CRM (TECH-1248/1249)",
      ),
    ],
  ),
  row(
    "lib/intake-step/multi-incident.test.ts",
    "splitMultiIncidentReport vẫn bắt được ca thật có 2 UID khác nhau (TECH-938)",
    "ported",
    [
      C(
        "intake/split/split.test.ts",
        "splitMultiIncidentReport vẫn bắt được ca thật có 2 UID khác nhau (TECH-938)",
      ),
    ],
  ),
  row(
    "lib/intake-step/multi-incident.test.ts",
    "danh sách học sinh VÍ DỤ dưới một sự cố hệ thống KHÔNG bị tách (TECH-462, TECH-603)",
    "ported",
    [
      C(
        "intake/split/split.test.ts",
        "danh sách học sinh VÍ DỤ dưới một sự cố hệ thống KHÔNG bị tách (TECH-462, TECH-603)",
      ),
    ],
  ),
  row(
    "lib/intake-step/multi-incident.test.ts",
    "cùng một học sinh nhắc lại ở 2 đoạn (mã KH ở đoạn này, thiếu ở đoạn kia) KHÔNG bị tách (TECH-560)",
    "ported",
    [
      C(
        "intake/split/split.test.ts",
        "cùng một học sinh nhắc lại ở 2 đoạn (mã KH ở đoạn này, thiếu ở đoạn kia) KHÔNG bị tách (TECH-560)",
      ),
    ],
  ),
  row(
    "lib/intake-step/multi-incident.test.ts",
    "TECH-1248 + TECH-1249: gửi 2 sự cố ở 2 lượt khác nhau — tách thành 2 ticket riêng, nội dung và ảnh không bị lẫn",
    "ported",
    [
      C(
        "intake/engine/pr9-split.test.ts",
        "TECH-1248 + TECH-1249: gửi 2 sự cố ở 2 lượt khác nhau — tách thành 2 ticket riêng, nội dung và ảnh không bị lẫn",
      ),
    ],
  ),
  row(
    "lib/intake-step/multi-incident.test.ts",
    "TECH-1146: một tin nhắn chứa 2 học sinh — hỏi tách ticket, khi tách mỗi ticket chỉ có đúng học sinh của mình",
    "ported",
    [
      C(
        "intake/engine/pr9-split.test.ts",
        "TECH-1146: một tin nhắn chứa 2 học sinh — hỏi tách ticket, khi tách mỗi ticket chỉ có đúng học sinh của mình",
      ),
    ],
  ),
  row(
    "lib/intake-step/multi-incident.test.ts",
    "TECH-1146 (chọn gộp 1 ticket): tiêu đề tóm tắt cả 2 học sinh, KHÔNG BAO GIỜ lấy tên người làm tiêu đề",
    "ported",
    [
      C(
        "intake/engine/pr9-split.test.ts",
        "TECH-1146 (chọn gộp 1 ticket): tiêu đề tóm tắt cả 2 học sinh, KHÔNG BAO GIỜ lấy tên người làm tiêu đề",
      ),
    ],
  ),
  row(
    "lib/intake-step/multi-incident.test.ts",
    "ảnh đính kèm không phân biệt được thuộc học sinh nào: đính kèm cả hai và có ghi chú rõ ràng",
    "ported",
    [
      C(
        "intake/engine/pr9-split.test.ts",
        "ảnh đính kèm không phân biệt được thuộc học sinh nào: đính kèm cả hai và có ghi chú rõ ràng",
      ),
    ],
  ),
  row(
    "lib/intake-step/multi-incident.test.ts",
    'BUG 5 — người báo gõ "không tách" thì GỘP, tuyệt đối không tách',
    "ported",
    [
      C(
        "intake/engine/pr9-split.test.ts",
        'BUG 5 — người báo gõ "không tách" thì GỘP, tuyệt đối không tách',
      ),
    ],
  ),
  row(
    "lib/intake-step/multi-incident.test.ts",
    "BUG 6/7 — đang hỏi tách mà người báo huỷ: thoát câu hỏi, xoá luôn hàng đợi tách",
    "ported",
    [
      C(
        "intake/engine/pr9-split.test.ts",
        "BUG 6/7 — đang hỏi tách mà người báo huỷ: thoát câu hỏi, xoá luôn hàng đợi tách",
      ),
    ],
  ),
  row(
    "lib/intake-step/multi-incident.test.ts",
    "BUG 6 (Vòng 3 — P1): đang hỏi tách mà người báo nhắn câu khác: hỏi lại 1 lần, vẫn không rõ thì gộp 1 ticket không mất nội dung",
    "ported",
    [
      C(
        "intake/engine/pr9-split.test.ts",
        "BUG 6 (Vòng 3 — P1): đang hỏi tách mà người báo nhắn câu khác: hỏi lại 1 lần, vẫn không rõ thì gộp 1 ticket không mất nội dung",
      ),
    ],
  ),
  // ── lib/intake-step/split-adversarial.test.ts (10) ──
  row(
    "lib/intake-step/split-adversarial.test.ts",
    "A. trạng thái chuẩn: hỏi tách → 'Tách 2 ticket' → 2 ticket, nội dung/ảnh không lẫn",
    "ported",
    [
      C(
        "intake/engine/split-adversarial.test.ts",
        "A. trạng thái chuẩn: hỏi tách → 'Tách 2 ticket' → 2 ticket, nội dung/ảnh không lẫn",
      ),
    ],
  ),
  row(
    "lib/intake-step/split-adversarial.test.ts",
    "B. phủ định/hủy/gộp tại câu hỏi tách (Bug 5/6, P2: thôi/khỏi = merge)",
    "ported",
    [
      C(
        "intake/engine/split-adversarial.test.ts",
        "B. phủ định/hủy/gộp tại câu hỏi tách (Bug 5/6, P2: thôi/khỏi = merge)",
      ),
    ],
  ),
  row(
    "lib/intake-step/split-adversarial.test.ts",
    "C. P1 (Blocker): câu trả lời KHÔNG rõ ý giữ nguyên báo cáo + ảnh, hỏi lại 1 lần, vẫn không rõ thì gộp 1 ticket",
    "ported",
    [
      C(
        "intake/engine/split-adversarial.test.ts",
        "C. P1 (Blocker): câu trả lời KHÔNG rõ ý giữ nguyên báo cáo + ảnh, hỏi lại 1 lần, vẫn không rõ thì gộp 1 ticket",
      ),
    ],
  ),
  row(
    "lib/intake-step/split-adversarial.test.ts",
    "D. dán lại y nguyên báo cáo 2 HS khi đang ở câu hỏi tách",
    "ported",
    [
      C(
        "intake/engine/split-adversarial.test.ts",
        "D. dán lại y nguyên báo cáo 2 HS khi đang ở câu hỏi tách",
      ),
    ],
  ),
  row(
    "lib/intake-step/split-adversarial.test.ts",
    "E. trả lời bằng MỘT báo cáo mới có định danh KHÁC (HS thứ 3) khi đang hỏi tách",
    "ported",
    [
      C(
        "intake/engine/split-adversarial.test.ts",
        "E. trả lời bằng MỘT báo cáo mới có định danh KHÁC (HS thứ 3) khi đang hỏi tách",
      ),
    ],
  ),
  row(
    "lib/intake-step/split-adversarial.test.ts",
    "F. không tách được — các dạng KHÔNG phải 2 sự cố độc lập",
    "ported",
    [
      C(
        "intake/engine/split-adversarial.test.ts",
        "F. không tách được — các dạng KHÔNG phải 2 sự cố độc lập",
      ),
    ],
  ),
  row(
    "lib/intake-step/split-adversarial.test.ts",
    "G. P3: gói tin sau khi tạo ticket 1 khi còn hàng đợi rõ ràng contract (createdIssue + nextDraft)",
    "ported",
    [
      C(
        "intake/engine/split-adversarial.test.ts",
        "G. P3: gói tin sau khi tạo ticket 1 khi còn hàng đợi rõ ràng contract (createdIssue + nextDraft)",
      ),
    ],
  ),
  row(
    "lib/intake-step/split-adversarial.test.ts",
    "H. P1 (tin chỉ có ảnh / noop): ảnh được gộp vào báo cáo đã park và hỏi lại; noop không mất dữ liệu",
    "ported",
    [
      C(
        "intake/engine/split-adversarial.test.ts",
        "H. P1 (tin chỉ có ảnh / noop): ảnh được gộp vào báo cáo đã park và hỏi lại; noop không mất dữ liệu",
      ),
    ],
  ),
  row(
    "lib/intake-step/split-adversarial.test.ts",
    "I. TTL: im lặng quá lâu ở câu hỏi tách",
    "ported",
    [C("intake/engine/split-adversarial.test.ts", "I. TTL: im lặng quá lâu ở câu hỏi tách")],
  ),
  row(
    "lib/intake-step/split-adversarial.test.ts",
    "J. P4: cụm mức ưu tiên và nhãn phòng ban/hệ thống trần KHÔNG BAO GIỜ là tiêu đề",
    "ported",
    [
      C(
        "intake/engine/split-adversarial.test.ts",
        "J. P4: cụm mức ưu tiên và nhãn phòng ban/hệ thống trần KHÔNG BAO GIỜ là tiêu đề",
      ),
    ],
  ),
  // ── lib/intake-step/ticket-reply-router.test.ts (14) ──
  row("lib/intake-step/ticket-reply-router.test.ts", "nhận các cách viết mã ticket", "ported", [
    C("intake/engine/text.test.ts", "nhận các cách viết mã ticket"),
  ]),
  row(
    "lib/intake-step/ticket-reply-router.test.ts",
    "append / edit / lookup chỉ nhận mã trong ứng viên; câu kỹ thuật hỏi vào prompt",
    "ported",
    [
      C(
        "intake/engine/pr11-ticket-commands.test.ts",
        "append / edit / lookup chỉ nhận mã trong ứng viên; câu kỹ thuật hỏi vào prompt",
      ),
    ],
  ),
  row(
    "lib/intake-step/ticket-reply-router.test.ts",
    "move_created cần ticket vừa tạo làm nguồn",
    "ported",
    [C("intake/engine/pr11-ticket-commands.test.ts", "move_created cần ticket vừa tạo làm nguồn")],
  ),
  row("lib/intake-step/ticket-reply-router.test.ts", "planEdit lọc thao tác hợp lệ", "ported", [
    C("intake/engine/edit.test.ts", "planEdit lọc thao tác hợp lệ"),
  ]),
  row(
    "lib/intake-step/ticket-reply-router.test.ts",
    "applyEditOps: sửa dòng có sẵn, thêm dòng mới vào cuối Thông tin sự cố, thay câu mô tả duy nhất",
    "ported",
    [
      C(
        "intake/engine/edit.test.ts",
        "applyEditOps: sửa dòng có sẵn, thêm dòng mới vào cuối Thông tin sự cố, thay câu mô tả duy nhất",
      ),
    ],
  ),
  row(
    "lib/intake-step/ticket-reply-router.test.ts",
    "descriptionBody lấy phần Mô tả và ảnh",
    "ported",
    [C("intake/engine/edit.test.ts", "descriptionBody lấy phần Mô tả và ảnh")],
  ),
  row(
    "lib/intake-step/ticket-reply-router.test.ts",
    "mentionedIdentifiers nhận các kiểu người báo hay gõ (TECH-1001, 30/09)",
    "ported",
    [
      C(
        "intake/engine/text.test.ts",
        "mentionedIdentifiers nhận các kiểu người báo hay gõ (TECH-1001, 30/09)",
      ),
    ],
  ),
  row(
    "lib/intake-step/ticket-reply-router.test.ts",
    "mentionedIdentifiers hỗ trợ khoá dự án có chữ số mà không khớp nhầm SĐT hay mã khác",
    "ported",
    [
      C(
        "intake/engine/text.test.ts",
        "mentionedIdentifiers hỗ trợ khoá dự án có chữ số mà không khớp nhầm SĐT hay mã khác",
      ),
    ],
  ),
  row(
    "lib/intake-step/ticket-reply-router.test.ts",
    "phân loại tất định các câu thật yêu cầu HỦY rõ → intent = 'cancel'",
    "ported",
    [
      C(
        "intake/engine/pr12-cancel-close.test.ts",
        "phân loại tất định các câu thật yêu cầu HỦY rõ → intent = 'cancel'",
      ),
    ],
  ),
  row(
    "lib/intake-step/ticket-reply-router.test.ts",
    "phân loại tất định các câu yêu cầu ĐÓNG / báo đã dùng được (không kèm từ hủy) → intent = 'close'",
    "ported",
    [
      C(
        "intake/engine/pr12-cancel-close.test.ts",
        "phân loại tất định các câu yêu cầu ĐÓNG / báo đã dùng được (không kèm từ hủy) → intent = 'close'",
      ),
    ],
  ),
  row(
    "lib/intake-step/ticket-reply-router.test.ts",
    "không bắt nhầm câu sửa thật, chuyển ticket trùng, câu thiếu mã ticket hay mô tả sự cố có chữ hủy/đóng (≥20 câu thực tế)",
    "ported",
    [
      C(
        "intake/engine/pr12-cancel-close.test.ts",
        "không bắt nhầm câu sửa thật, chuyển ticket trùng, câu thiếu mã ticket hay mô tả sự cố có chữ hủy/đóng (≥20 câu thực tế)",
      ),
    ],
  ),
  row(
    "lib/intake-step/ticket-reply-router.test.ts",
    "LlmTicketCommandInterpreter định tuyến tất định sang cancel_or_close kể cả khi LLM trả edit / unclear",
    "ported",
    [
      C(
        "intake/engine/pr12-cancel-close.test.ts",
        "LlmTicketCommandInterpreter định tuyến tất định sang cancel_or_close kể cả khi LLM trả edit / unclear",
      ),
    ],
  ),
  row(
    "lib/intake-step/ticket-reply-router.test.ts",
    "countSpecialistTimelineComments chỉ đếm bình luận của chuyên viên TECH, loại bỏ bot và người báo",
    "ported",
    [
      C(
        "intake/engine/pr12-cancel-close.test.ts",
        "countSpecialistTimelineComments chỉ đếm bình luận của chuyên viên TECH, loại bỏ bot và người báo",
      ),
    ],
  ),
  row(
    "lib/intake-step/ticket-reply-router.test.ts",
    "bóc vỏ câu lệnh bổ sung / đính kèm trần (TECH-1218: 'update vào tick TECH-1218') để không ghi câu lệnh thành comment",
    "ported",
    [
      C(
        "intake/engine/text.test.ts",
        "bóc vỏ câu lệnh bổ sung / đính kèm trần (TECH-1218: 'update vào tick TECH-1218') để không ghi câu lệnh thành comment",
      ),
    ],
  ),
  // ── lib/intake-step/noop-guard.test.ts (6) ──
  row(
    "lib/intake-step/noop-guard.test.ts",
    "1. Tin noop độc lập: bị bỏ qua, KHÔNG tạo tờ khai trong DB, KHÔNG tạo ticket",
    "ported",
    [
      C(
        "intake/engine/noop-guard.test.ts",
        "1. Tin noop độc lập: bị bỏ qua, KHÔNG tạo tờ khai, KHÔNG tạo ticket",
      ),
    ],
  ),
  row(
    "lib/intake-step/noop-guard.test.ts",
    "2. Tin callback_data: noop khi chưa có tờ khai: bị bỏ qua, không tạo tờ khai trong DB",
    "ported",
    [
      C(
        "intake/engine/noop-guard.test.ts",
        "2. Tin callback_data: noop khi chưa có tờ khai: bị bỏ qua, không tạo tờ khai",
      ),
    ],
  ),
  row(
    "lib/intake-step/noop-guard.test.ts",
    "3. Mô phỏng đúng chuỗi sự cố TECH-1148: sau khi tạo ticket, bấm nhầm nút noop không làm mở ticket noop mới",
    "ported",
    [
      C(
        "intake/engine/noop-guard.test.ts",
        "3. Sau khi tạo ticket, bấm nhầm nút noop không mở ticket noop mới",
      ),
    ],
  ),
  row(
    "lib/intake-step/noop-guard.test.ts",
    "4. Tin noop trong khi đang thu thập thông tin (collecting): không làm ô nhiễm title hay rawText",
    "ported",
    [
      C(
        "intake/engine/noop-guard.test.ts",
        "4. Tin noop trong khi đang thu thập: không làm ô nhiễm title hay rawText",
      ),
    ],
  ),
  row(
    "lib/intake-step/noop-guard.test.ts",
    "5. Hàng rào tạo ticket: từ chối tạo ticket khi title hoặc description rỗng hoặc chỉ là noop",
    "ported",
    [
      C(
        "intake/engine/noop-guard.test.ts",
        "5. Hàng rào tạo ticket: từ chối khi tiêu đề hoặc mô tả chỉ là token nội bộ (noop)",
      ),
      C(
        "intake/engine/noop-guard.test.ts",
        "6. Hàng rào tạo ticket: tờ khai trống (tiêu đề và mô tả rỗng) cũng không tạo ticket",
      ),
    ],
  ),
  row(
    "lib/intake-step/noop-guard.test.ts",
    "6. create_issue tool: từ chối tạo ticket khi title hoặc description chỉ là noop",
    "deferred",
    "Chưa port: legacy gọi tool MCP `create_issue` (một cửa vào riêng); core chưa có tool MCP của lễ tân — chờ PR 15 (pack MCP) và PR 16 (adapter OpenClaw). Hàng rào tương đương đã có ở đường tạo ticket của core (`intake/create/create-ticket.ts`), xem ca 5",
  ),
  // ── lib/intake-step/extractor.test.ts (2) ──
  row(
    "lib/intake-step/extractor.test.ts",
    "trích xuất tĩnh và chuẩn hóa OOV thành công",
    "ported",
    [C("intake/extractor/extractor.test.ts", "trích xuất tĩnh và chuẩn hóa OOV thành công")],
  ),
  row(
    "lib/intake-step/extractor.test.ts",
    "gộp trường bảo toàn dữ liệu cũ và tăng revision",
    "ported",
    [C("intake/extractor/extractor.test.ts", "gộp trường bảo toàn dữ liệu cũ và tăng revision")],
  ),
  // ── lib/intake-step/extractor-rules.test.ts (21) ──
  row(
    "lib/intake-step/extractor-rules.test.ts",
    "chỉ coi là xác nhận khi CẢ tin nhắn là câu đồng ý ngắn",
    "ported",
    [
      C(
        "intake/extractor/extractor-rules.test.ts",
        "chỉ coi là xác nhận khi CẢ tin nhắn là câu đồng ý ngắn",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-rules.test.ts",
    "chỉ huỷ khi có cụm huỷ tường minh — 'không vào được lớp' KHÔNG phải huỷ",
    "ported",
    [
      C(
        "intake/extractor/extractor-rules.test.ts",
        "chỉ huỷ khi có cụm huỷ tường minh — 'không vào được lớp' KHÔNG phải huỷ",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-rules.test.ts",
    "heuristic: tin nhắn báo lỗi bắt đầu bằng 'Yêu cầu' / 'không' vẫn là report_issue",
    "ported",
    [
      C(
        "intake/extractor/extractor-rules.test.ts",
        "heuristic: tin nhắn báo lỗi bắt đầu bằng 'Yêu cầu' / 'không' vẫn là report_issue",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-rules.test.ts",
    "heuristic: lời cảm ơn là chitchat, không sinh triệu chứng",
    "ported",
    [
      C(
        "intake/extractor/extractor-rules.test.ts",
        "heuristic: lời cảm ơn là chitchat, không sinh triệu chứng",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-rules.test.ts",
    "heuristic: tin bổ sung ngắn kèm định danh là provide_info",
    "ported",
    [
      C(
        "intake/extractor/extractor-rules.test.ts",
        "heuristic: tin bổ sung ngắn kèm định danh là provide_info",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-rules.test.ts",
    "heuristic: nhận ra hệ thống từ từ khoá (app Duo → DUO_Vuihoc)",
    "ported",
    [
      C(
        "intake/extractor/extractor-rules.test.ts",
        "heuristic: nhận ra hệ thống từ từ khoá (app Duo → DUO_Vuihoc)",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-rules.test.ts",
    "nhận diện 'không biết' là câu từ chối trả lời, không nhầm với triệu chứng",
    "ported",
    [
      C(
        "intake/extractor/extractor-rules.test.ts",
        "nhận diện 'không biết' là câu từ chối trả lời, không nhầm với triệu chứng",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-rules.test.ts",
    "SĐT nằm trong customerId được chuyển sang studentAccount",
    "ported",
    [
      C(
        "intake/extractor/extractor-rules.test.ts",
        "SĐT nằm trong customerId được chuyển sang studentAccount",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-rules.test.ts",
    "giá trị ngoài danh mục từ LLM bị bỏ, không làm sập extractor",
    "ported",
    [
      C(
        "intake/extractor/extractor-rules.test.ts",
        "giá trị ngoài danh mục từ LLM bị bỏ, không làm sập extractor",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-rules.test.ts",
    "tin nhắn rất dài bị cắt trước khi gửi LLM",
    "ported",
    [C("intake/extractor/extractor-rules.test.ts", "tin nhắn rất dài bị cắt trước khi gửi LLM")],
  ),
  row("lib/intake-step/extractor-rules.test.ts", "LLM lỗi thì rơi về heuristic", "ported", [
    C("intake/extractor/extractor-rules.test.ts", "LLM lỗi thì rơi về heuristic"),
  ]),
  row(
    "lib/intake-step/extractor-rules.test.ts",
    "hết cả chuỗi model thì KHÔNG bịa tiêu đề từ dòng đầi",
    "ported",
    [
      C(
        "intake/extractor/extractor-rules.test.ts",
        "hết cả chuỗi model thì KHÔNG bịa tiêu đề từ dòng đầi",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-rules.test.ts",
    "'sửa tiêu đề thành …' đổi được tiêu đề đã có",
    "ported",
    [C("intake/extractor/extractor-rules.test.ts", "'sửa tiêu đề thành …' đổi được tiêu đề đã có")],
  ),
  row(
    "lib/intake-step/extractor-rules.test.ts",
    "bằng chứng ưu tiên đã ghi nhận không bị false mặc định ở lượt sau hạ xuống",
    "ported",
    [
      C(
        "intake/extractor/extractor-rules.test.ts",
        "bằng chứng ưu tiên đã ghi nhận không bị false mặc định ở lượt sau hạ xuống",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-rules.test.ts",
    "tiêu đề suy ra ở lượt sau KHÔNG đè tiêu đề cũ khi người dùng không yêu cầu",
    "ported",
    [
      C(
        "intake/extractor/extractor-rules.test.ts",
        "tiêu đề suy ra ở lượt sau KHÔNG đè tiêu đề cũ khi người dùng không yêu cầu",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-rules.test.ts",
    "lượt sau có mô tả mới thì tiêu đề được tóm tắt lại (lời mở đầu không thành tiêu đề mãi)",
    "ported",
    [
      C(
        "intake/extractor/extractor-rules.test.ts",
        "lượt sau có mô tả mới thì tiêu đề được tóm tắt lại (lời mở đầu không thành tiêu đề mãi)",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-rules.test.ts",
    "tiêu đề người dùng tự đặt thì LLM tóm tắt lại không đè được",
    "ported",
    [
      C(
        "intake/extractor/extractor-rules.test.ts",
        "tiêu đề người dùng tự đặt thì LLM tóm tắt lại không đè được",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-rules.test.ts",
    "không có LLM: tiêu đề lấy dòng tả lỗi, không lấy dòng tên học sinh",
    "ported",
    [
      C(
        "intake/extractor/extractor-rules.test.ts",
        "không có LLM: tiêu đề lấy dòng tả lỗi, không lấy dòng tên học sinh",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-rules.test.ts",
    "'bỏ ý …' gỡ triệu chứng khỏi danh sách",
    "ported",
    [C("intake/extractor/extractor-rules.test.ts", "'bỏ ý …' gỡ triệu chứng khỏi danh sách")],
  ),
  row(
    "lib/intake-step/extractor-rules.test.ts",
    "structuredOnly: tin xác nhận không bị ghi thành triệu chứng",
    "ported",
    [
      C(
        "intake/extractor/extractor-rules.test.ts",
        "structuredOnly: tin xác nhận không bị ghi thành triệu chứng",
      ),
    ],
  ),
  row("lib/intake-step/extractor-rules.test.ts", "triệu chứng quá dài bị cắt", "ported", [
    C("intake/extractor/extractor-rules.test.ts", "triệu chứng quá dài bị cắt"),
  ]),
  // ── lib/intake-step/extractor-dept-system-title.test.ts (12) ──
  row(
    "lib/intake-step/extractor-dept-system-title.test.ts",
    "nhận ra 'Kế toán' là bộ phận ngoài danh mục",
    "ported",
    [
      C(
        "intake/extractor/extractor-dept-system-title.test.ts",
        "nhận ra 'Kế toán' là bộ phận ngoài danh mục",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-dept-system-title.test.ts",
    "bỏ qua khi bộ phận đã khớp danh mục",
    "ported",
    [
      C(
        "intake/extractor/extractor-dept-system-title.test.ts",
        "bỏ qua khi bộ phận đã khớp danh mục",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-dept-system-title.test.ts",
    "không bịa khi tin không nhắc bộ phận",
    "ported",
    [
      C(
        "intake/extractor/extractor-dept-system-title.test.ts",
        "không bịa khi tin không nhắc bộ phận",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-dept-system-title.test.ts",
    "bỏ qua cụm viết tắt đã có trong DEPT_SYNONYMS",
    "ported",
    [
      C(
        "intake/extractor/extractor-dept-system-title.test.ts",
        "bỏ qua cụm viết tắt đã có trong DEPT_SYNONYMS",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-dept-system-title.test.ts",
    "extractor trả reportingDeptUnrecognized khi LLM không đoán ra bộ phận",
    "ported",
    [
      C(
        "intake/extractor/extractor-dept-system-title.test.ts",
        "extractor trả reportingDeptUnrecognized khi LLM không đoán ra bộ phận",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-dept-system-title.test.ts",
    "nhận Zalo/Viber/Messenger vào Khác_Hạ tầng_IT",
    "ported",
    [
      C(
        "intake/extractor/extractor-dept-system-title.test.ts",
        "nhận Zalo/Viber/Messenger vào Khác_Hạ tầng_IT",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-dept-system-title.test.ts",
    "hệ thống danh mục vẫn thắng từ đồng nghĩa",
    "ported",
    [
      C(
        "intake/extractor/extractor-dept-system-title.test.ts",
        "hệ thống danh mục vẫn thắng từ đồng nghĩa",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-dept-system-title.test.ts",
    "cắt 'Em chào anh, em là …' khỏi tiêu đề heuristic",
    "ported",
    [
      C(
        "intake/extractor/extractor-dept-system-title.test.ts",
        "cắt 'Em chào anh, em là …' khỏi tiêu đề heuristic",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-dept-system-title.test.ts",
    "giữ nguyên câu không có lời chào",
    "ported",
    [C("intake/extractor/extractor-dept-system-title.test.ts", "giữ nguyên câu không có lời chào")],
  ),
  row(
    "lib/intake-step/extractor-dept-system-title.test.ts",
    "chỉ chào trơn thì giữ câu gốc",
    "ported",
    [C("intake/extractor/extractor-dept-system-title.test.ts", "chỉ chào trơn thì giữ câu gốc")],
  ),
  row(
    "lib/intake-step/extractor-dept-system-title.test.ts",
    "extractor không LLM cho tiêu đề không còn lời chào",
    "ported",
    [
      C(
        "intake/extractor/extractor-dept-system-title.test.ts",
        "extractor không LLM cho tiêu đề không còn lời chào",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-dept-system-title.test.ts",
    "câu hỏi nói rõ bộ phận không có trong danh mục thay vì lặp lại câu cũ",
    "ported",
    [
      C(
        "intake/extractor/extractor-dept-system-title.test.ts",
        "câu hỏi nói rõ bộ phận không có trong danh mục thay vì lặp lại câu cũ",
      ),
    ],
  ),
  // ── lib/intake-step/extractor-evidence.test.ts (10) ──
  row(
    "lib/intake-step/extractor-evidence.test.ts",
    "prompt gửi LLM liệt kê đủ khoá JSON, gồm các trường bằng chứng",
    "ported",
    [
      C(
        "intake/extractor/extractor-evidence.test.ts",
        "prompt gửi LLM liệt kê đủ khoá JSON, gồm các trường bằng chứng",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-evidence.test.ts",
    "LLM không trả bằng chứng thì luật nhận diện bù: cả lớp không vào học được → group + blocksLearning",
    "ported",
    [
      C(
        "intake/extractor/extractor-evidence.test.ts",
        "LLM không trả bằng chứng thì luật nhận diện bù: cả lớp không vào học được → group + blocksLearning",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-evidence.test.ts",
    "giá trị LLM trả về thắng luật nhận diện",
    "ported",
    [C("intake/extractor/extractor-evidence.test.ts", "giá trị LLM trả về thắng luật nhận diện")],
  ),
  row(
    "lib/intake-step/extractor-evidence.test.ts",
    "không LLM: một học sinh không vào được lớp → blocksLearning, scope single_user",
    "ported",
    [
      C(
        "intake/extractor/extractor-evidence.test.ts",
        "không LLM: một học sinh không vào được lớp → blocksLearning, scope single_user",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-evidence.test.ts",
    "không LLM: không thanh toán được → blocksPayment",
    "ported",
    [
      C(
        "intake/extractor/extractor-evidence.test.ts",
        "không LLM: không thanh toán được → blocksPayment",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-evidence.test.ts",
    "không tạo/lên được đơn → blocksPayment (đúng câu hỏi trong urgency-rules)",
    "ported",
    [
      C(
        "intake/extractor/extractor-evidence.test.ts",
        "không tạo/lên được đơn → blocksPayment (đúng câu hỏi trong urgency-rules)",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-evidence.test.ts",
    "luật nhận diện thấy cụm rõ ràng thì thắng false mặc định của LLM",
    "ported",
    [
      C(
        "intake/extractor/extractor-evidence.test.ts",
        "luật nhận diện thấy cụm rõ ràng thì thắng false mặc định của LLM",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-evidence.test.ts",
    "tin bổ sung không mô tả lỗi (chỉ SĐT) không bịa bằng chứng",
    "ported",
    [
      C(
        "intake/extractor/extractor-evidence.test.ts",
        "tin bổ sung không mô tả lỗi (chỉ SĐT) không bịa bằng chứng",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-evidence.test.ts",
    "tin không nhắc bộ phận thì bỏ giá trị LLM đoán",
    "ported",
    [
      C(
        "intake/extractor/extractor-evidence.test.ts",
        "tin không nhắc bộ phận thì bỏ giá trị LLM đoán",
      ),
    ],
  ),
  row(
    "lib/intake-step/extractor-evidence.test.ts",
    "nhận khi tin nhắc đúng tên, không dấu, hay viết tắt",
    "ported",
    [
      C(
        "intake/extractor/extractor-evidence.test.ts",
        "nhận khi tin nhắc đúng tên, không dấu, hay viết tắt",
      ),
    ],
  ),
  // ── lib/intake-step/pipeline.test.ts (7) ──
  row(
    "lib/intake-step/pipeline.test.ts",
    "Turn 1: Thiếu reporting_dept -> Action ask_missing_field",
    "core",
    [C("intake/engine/engine.test.ts", "incomplete report asks the next question (gate ask-back)")],
  ),
  row(
    "lib/intake-step/pipeline.test.ts",
    "Turn 2: Điền đủ thông tin -> confirm_summary, Turn 3: Xác nhận -> ticket_created",
    "core",
    [
      C("intake/engine/engine.test.ts", "complete report shows a summary with a confirm button"),
      C(
        "intake/engine/engine.test.ts",
        "confirm after the delay creates exactly one ticket; description = verbatim text (ADR-0010)",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.test.ts",
    "ticket_created: gợi ý chưa xác thực (verifiedOnTracker=false) KHÔNG được ghi vào Related Tickets",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  row(
    "lib/intake-step/pipeline.test.ts",
    "ticket_created: kết quả Onyx dù đã xác thực tồn tại cũng KHÔNG được ghi (chỉ là tìm theo chữ)",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  row(
    "lib/intake-step/pipeline.test.ts",
    "ticket_created: cụm nguyên nhân từ KG được ghi đủ vào Related Tickets + link, gợi ý là chữ người viết (chạy NỀN sau khi tạo)",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  row(
    "lib/intake-step/pipeline.test.ts",
    "KG không đủ tự tin (null) → không ghi gì, kể cả khi Onyx có kết quả",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  row(
    "lib/intake-step/pipeline.test.ts",
    "cùng mã ở cả KG và Onyx → bản KG (chữ người viết) thay bản Onyx, KG xếp trước (ghi lại sau khi tạo)",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  // ── lib/intake-step/pipeline.notify-supplement.test.ts (6) ──
  row(
    "lib/intake-step/pipeline.notify-supplement.test.ts",
    "khi ticket đang xử lý có assignee (u-techlead-a) → comment bổ sung mention @techlead_a",
    "ported",
    [
      C(
        "intake/engine/pr10-post-create.test.ts",
        "khi ticket đang xử lý có assignee (u-techlead-a) → comment bổ sung mention @techlead_a",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.notify-supplement.test.ts",
    "khi ticket không có assignee nhưng timeline có trao đổi của KTV (TechUser_B) → mention @techuser_b",
    "ported",
    [
      C(
        "intake/engine/pr10-post-create.test.ts",
        "khi ticket không có assignee nhưng timeline có trao đổi của KTV (TechUser_B) → mention @techuser_b",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.notify-supplement.test.ts",
    "khi ticket không có assignee và timeline chỉ có bot/hệ thống → none (không cc ai)",
    "ported",
    [
      C(
        "intake/engine/pr10-post-create.test.ts",
        "khi ticket không có assignee và timeline chỉ có bot/hệ thống → none (không cc ai)",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.notify-supplement.test.ts",
    "ticket đã ở Done (cột 4) → từ chối bổ sung, không addComment, hướng dẫn tạo ticket mới",
    "ported",
    [
      C(
        "intake/engine/pr10-post-create.test.ts",
        "ticket đã ở Done (cột 4) → từ chối bổ sung, không addComment, hướng dẫn tạo ticket mới",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.notify-supplement.test.ts",
    "ticket đã ở Canceled (cột 5) → từ chối bổ sung, không addComment, hướng dẫn tạo ticket mới",
    "ported",
    [
      C(
        "intake/engine/pr10-post-create.test.ts",
        "ticket đã ở Canceled (cột 5) → từ chối bổ sung, không addComment, hướng dẫn tạo ticket mới",
      ),
    ],
  ),
  row(
    "lib/intake-step/pipeline.notify-supplement.test.ts",
    "người dùng gõ lệnh bổ sung chỉ định ticket đã đóng (bổ sung TECHTEST-104) → từ chối ngay lập tức",
    "ported",
    [
      C(
        "intake/engine/pr10-post-create.test.ts",
        "người dùng gõ lệnh bổ sung chỉ định ticket đã đóng (bổ sung TECHTEST-104) → từ chối ngay lập tức",
      ),
    ],
  ),
  // ── lib/intake-step/tech-review.test.ts (3) ──
  row(
    "lib/intake-step/tech-review.test.ts",
    "đọc JSON LLM: tối đa 3 dữ kiện + câu hỏi; hướng dẫn và lời báo đều vào prompt",
    "ported",
    [
      C(
        "intake/review/llm-review.test.ts",
        "đọc JSON LLM: tối đa 3 dữ kiện + câu hỏi; hướng dẫn và lời báo đều vào prompt",
      ),
    ],
  ),
  row(
    "lib/intake-step/tech-review.test.ts",
    "đủ dữ kiện, thiếu câu hỏi hay JSON hỏng → coi như đủ",
    "ported",
    [C("intake/review/llm-review.test.ts", "đủ dữ kiện, thiếu câu hỏi hay JSON hỏng → coi như đủ")],
  ),
  row(
    "lib/intake-step/tech-review.test.ts",
    "LLM treo quá hạn → lỗi (pipeline bắt và bỏ qua)",
    "ported",
    [C("intake/review/llm-review.test.ts", "LLM treo quá hạn → lỗi (pipeline bắt và bỏ qua)")],
  ),
  // ── lib/intake-step/checklist-review.test.ts (21) ──
  row(
    "lib/intake-step/checklist-review.test.ts",
    "không có ảnh → luôn xin ảnh màn hình, một tin, kết bằng 'không có'",
    "ported",
    [
      C(
        "intake/review/checklist-review.test.ts",
        "không có ảnh → luôn xin ảnh màn hình, một tin, kết bằng 'không có'",
      ),
    ],
  ),
  row("lib/intake-step/checklist-review.test.ts", "có ảnh đính kèm → không xin ảnh nữa", "ported", [
    C("intake/review/checklist-review.test.ts", "có ảnh đính kèm → không xin ảnh nữa"),
  ]),
  row(
    "lib/intake-step/checklist-review.test.ts",
    "CARE → xin link student-detail; đã có link thì bỏ",
    "ported",
    [
      C(
        "intake/review/checklist-review.test.ts",
        "CARE → xin link student-detail; đã có link thì bỏ",
      ),
    ],
  ),
  row(
    "lib/intake-step/checklist-review.test.ts",
    "CRM → xin link contact, LMS/khoá → xin UID hoặc link LMS",
    "ported",
    [
      C(
        "intake/review/checklist-review.test.ts",
        "CRM → xin link contact, LMS/khoá → xin UID hoặc link LMS",
      ),
    ],
  ),
  row(
    "lib/intake-step/checklist-review.test.ts",
    "mã đơn hàng: hỏi khi nói về đơn/hạn, bỏ khi đã có DH…",
    "ported",
    [
      C(
        "intake/review/checklist-review.test.ts",
        "mã đơn hàng: hỏi khi nói về đơn/hạn, bỏ khi đã có DH…",
      ),
    ],
  ),
  row(
    "lib/intake-step/checklist-review.test.ts",
    "không hỏi nguyên nhân, không xin mật khẩu TeamViewer",
    "ported",
    [
      C(
        "intake/review/checklist-review.test.ts",
        "không hỏi nguyên nhân, không xin mật khẩu TeamViewer",
      ),
    ],
  ),
  row(
    "lib/intake-step/checklist-review.test.ts",
    "việc rõ ràng không thuộc TECH (chấm công/AMIS) → không hỏi",
    "ported",
    [
      C(
        "intake/review/checklist-review.test.ts",
        "việc rõ ràng không thuộc TECH (chấm công/AMIS) → không hỏi",
      ),
    ],
  ),
  row("lib/intake-step/checklist-review.test.ts", "báo đủ hết → missing rỗng", "ported", [
    C("intake/review/checklist-review.test.ts", "báo đủ hết → missing rỗng"),
  ]),
  row(
    "lib/intake-step/checklist-review.test.ts",
    "không có mục học được → kết quả y như buildChecklist(input)",
    "ported",
    [
      C(
        "intake/review/checklist-review.test.ts",
        "không có mục học được → kết quả y như buildChecklist(input)",
      ),
    ],
  ),
  row(
    "lib/intake-step/checklist-review.test.ts",
    "mục học được chưa có dòng cố định → thêm dòng cuối, đánh số tiếp, vẫn một tin và kết bằng 'không có'",
    "ported",
    [
      C(
        "intake/review/checklist-review.test.ts",
        "mục học được chưa có dòng cố định → thêm dòng cuối, đánh số tiếp, vẫn một tin và kết bằng 'không có'",
      ),
    ],
  ),
  row(
    "lib/intake-step/checklist-review.test.ts",
    "mục đã được hỏi hoặc đã có sẵn ở dòng cố định → không lặp lại",
    "ported",
    [
      C(
        "intake/review/checklist-review.test.ts",
        "mục đã được hỏi hoặc đã có sẵn ở dòng cố định → không lặp lại",
      ),
    ],
  ),
  row(
    "lib/intake-step/checklist-review.test.ts",
    "OTHER và mục lạ bị bỏ qua; trùng lặp chỉ một lần",
    "ported",
    [
      C(
        "intake/review/checklist-review.test.ts",
        "OTHER và mục lạ bị bỏ qua; trùng lặp chỉ một lần",
      ),
    ],
  ),
  row(
    "lib/intake-step/checklist-review.test.ts",
    "NOT_TECH vẫn không hỏi dù có mục học được",
    "ported",
    [C("intake/review/checklist-review.test.ts", "NOT_TECH vẫn không hỏi dù có mục học được")],
  ),
  row(
    "lib/intake-step/checklist-review.test.ts",
    "ChecklistTechReviewer: bộ học lỗi thì vẫn hỏi như cũ",
    "ported",
    [
      C(
        "intake/review/checklist-review.test.ts",
        "ChecklistTechReviewer: bộ học lỗi thì vẫn hỏi như cũ",
      ),
    ],
  ),
  row(
    "lib/intake-step/checklist-review.test.ts",
    "ChecklistTechReviewer: đưa đúng hệ thống cho bộ học",
    "ported",
    [
      C(
        "intake/review/checklist-review.test.ts",
        "ChecklistTechReviewer: đưa đúng hệ thống cho bộ học",
      ),
    ],
  ),
  row(
    "lib/intake-step/checklist-review.test.ts",
    "sắp xếp theo tỉ lệ (W26): CARE có CARE_STUDENT_LINK tỉ lệ cao nhất → đứng ngay sau ảnh màn hình",
    "ported",
    [
      C(
        "intake/review/checklist-review.test.ts",
        "sắp xếp theo tỉ lệ (W26): CARE có CARE_STUDENT_LINK tỉ lệ cao nhất → đứng ngay sau ảnh màn hình",
      ),
    ],
  ),
  row(
    "lib/intake-step/checklist-review.test.ts",
    "ảnh màn hình luôn được ghim đầu tiên khi được hỏi, kể cả tỉ lệ thấp hơn mục khác",
    "ported",
    [
      C(
        "intake/review/checklist-review.test.ts",
        "ảnh màn hình luôn được ghim đầu tiên khi được hỏi, kể cả tỉ lệ thấp hơn mục khác",
      ),
    ],
  ),
  row(
    "lib/intake-step/checklist-review.test.ts",
    "đã có ảnh đính kèm → không hỏi ảnh màn hình, mục có tỉ lệ cao nhất đứng đầu",
    "ported",
    [
      C(
        "intake/review/checklist-review.test.ts",
        "đã có ảnh đính kèm → không hỏi ảnh màn hình, mục có tỉ lệ cao nhất đứng đầu",
      ),
    ],
  ),
  row(
    "lib/intake-step/checklist-review.test.ts",
    "hoà tỉ lệ (stable ties): giữ thứ tự base, mục học thêm cùng tỉ lệ đứng sau mục cố định",
    "ported",
    [
      C(
        "intake/review/checklist-review.test.ts",
        "hoà tỉ lệ (stable ties): giữ thứ tự base, mục học thêm cùng tỉ lệ đứng sau mục cố định",
      ),
    ],
  ),
  row(
    "lib/intake-step/checklist-review.test.ts",
    "không có tỉ lệ (hoặc tất cả bằng 0) → đầu ra trùng khớp 100% từng byte với bản cũ",
    "ported",
    [
      C(
        "intake/review/checklist-review.test.ts",
        "không có tỉ lệ (hoặc tất cả bằng 0) → đầu ra trùng khớp 100% từng byte với bản cũ",
      ),
    ],
  ),
  row(
    "lib/intake-step/checklist-review.test.ts",
    "ChecklistTechReviewer: tra cứu lỗi → không sắp xếp, kết quả như cũ",
    "ported",
    [
      C(
        "intake/review/checklist-review.test.ts",
        "ChecklistTechReviewer: tra cứu lỗi → không sắp xếp, kết quả như cũ",
      ),
    ],
  ),
  // ── lib/identifier-grounding.test.ts (11) ──
  row(
    "lib/identifier-grounding.test.ts",
    "giữ lại đúng chữ số, bỏ khoảng trắng/dấu chấm/gạch ngang",
    "ported",
    [
      C(
        "intake/engine/identifiers.test.ts",
        "giữ lại đúng chữ số, bỏ khoảng trắng/dấu chấm/gạch ngang",
      ),
    ],
  ),
  row(
    "lib/identifier-grounding.test.ts",
    "giá trị có chữ số nằm trong nguồn thì grounded",
    "ported",
    [C("intake/engine/identifiers.test.ts", "giá trị có chữ số nằm trong nguồn thì grounded")],
  ),
  row(
    "lib/identifier-grounding.test.ts",
    "giá trị toàn chữ (không có chữ số) coi như grounded — không đối chiếu được bằng số",
    "ported",
    [
      C(
        "intake/engine/identifiers.test.ts",
        "giá trị toàn chữ (không có chữ số) coi như grounded — không đối chiếu được bằng số",
      ),
    ],
  ),
  row(
    "lib/identifier-grounding.test.ts",
    "giá trị không nằm trong nguồn thì KHÔNG grounded",
    "ported",
    [C("intake/engine/identifiers.test.ts", "giá trị không nằm trong nguồn thì KHÔNG grounded")],
  ),
  row("lib/identifier-grounding.test.ts", "moi lại đúng SĐT thật trong lời kể", "ported", [
    C("intake/engine/identifiers.test.ts", "moi lại đúng SĐT thật trong lời kể"),
  ]),
  row("lib/identifier-grounding.test.ts", "không có số nào hợp lệ thì trả về undefined", "ported", [
    C("intake/engine/identifiers.test.ts", "không có số nào hợp lệ thì trả về undefined"),
  ]),
  row(
    "lib/identifier-grounding.test.ts",
    "hai SĐT thật sự khác nhau (khác sự cố) → xung đột",
    "core",
    [
      C(
        "intake/engine/engine.test.ts",
        "identifier-conflict parks and asks new-incident-or-append (TECH-928)",
      ),
    ],
  ),
  row(
    "lib/identifier-grounding.test.ts",
    "cùng một SĐT nhưng gõ có khoảng trắng/dấu chấm khác nhau → KHÔNG xung đột",
    "core",
    [
      C(
        "intake/engine/engine.test.ts",
        "same number shortened/with area code is NOT a conflict (TECH-928 digit-subset)",
      ),
    ],
  ),
  row(
    "lib/identifier-grounding.test.ts",
    "một bên là tập con chữ số của bên kia (vd gõ thiếu số 0 đầu) → KHÔNG xung đột",
    "core",
    [
      C(
        "intake/engine/engine.test.ts",
        "same number shortened/with area code is NOT a conflict (TECH-928 digit-subset)",
      ),
    ],
  ),
  row(
    "lib/identifier-grounding.test.ts",
    "một bên không có chữ số (mã toàn chữ) → không đối chiếu được, KHÔNG coi là xung đột",
    "ported",
    [
      C(
        "intake/engine/identifiers.test.ts",
        "một bên không có chữ số (mã toàn chữ) → không đối chiếu được, KHÔNG coi là xung đột",
      ),
    ],
  ),
  row("lib/identifier-grounding.test.ts", "giá trị giống hệt nhau → không xung đột", "ported", [
    C("intake/engine/identifiers.test.ts", "giá trị giống hệt nhau → không xung đột"),
  ]),
  // ── lib/intake-document/repository.test.ts (6) ──
  row(
    "lib/intake-document/repository.test.ts",
    "lưu và đọc revision mới nhất theo chatId",
    "ported",
    [C("intake/draft/version.test.ts", "lưu và đọc revision mới nhất theo chatId")],
  ),
  row(
    "lib/intake-document/repository.test.ts",
    "migrate bản nháp từ intake_sessions thành công",
    "deferred",
    "Chưa port: legacy đọc bảng `intake_sessions` và chuẩn hoá nhãn 15→9 giá trị; core chỉ nâng phiên bản tờ khai đọc từ `intake_documents` (`intake/draft/version.test.ts`) — KHÁC legacy. Chờ port ở PR 3 (kho lưu tương thích kho legacy)",
  ),
  row(
    "lib/intake-document/repository.test.ts",
    "tài liệu mới (revision thấp) thắng tài liệu cũ đã huỷ (revision cao)",
    "ported",
    [
      C(
        "intake/draft/version.test.ts",
        "tài liệu mới (revision thấp) thắng tài liệu cũ đã huỷ (revision cao)",
      ),
    ],
  ),
  row(
    "lib/intake-document/repository.test.ts",
    "tryInsertRevision chỉ cho một bên giành được cùng một revision",
    "ported",
    [
      C(
        "intake/draft/version.test.ts",
        "tryInsertRevision chỉ cho một bên giành được cùng một revision",
      ),
    ],
  ),
  row(
    "lib/intake-document/repository.test.ts",
    "chatId dạng 'telegram:123' và '123' là cùng một phiên",
    "ported",
    [C("intake/draft/version.test.ts", "chatId dạng 'telegram:123' và '123' là cùng một phiên")],
  ),
  row(
    "lib/intake-document/repository.test.ts",
    "bỏ qua bản nháp legacy quá hạn khi migrate",
    "deferred",
    "Chưa port: legacy trả `null` (không đọc được bản nháp quá hạn); core đọc được rồi mới đo tuổi theo `INTAKE_DRAFT_TTL_MS` và đóng tờ khai ở tầng engine (`intake/engine/engine.test.ts`) — KHÁC legacy ở tầng kho. Chờ port ở PR 3 (kho lưu tương thích kho legacy)",
  ),
  // ── lib/storage/binding-repository.test.ts (7) ──
  row(
    "lib/storage/binding-repository.test.ts",
    "cùng message_id ở hai chat khác nhau không đè nhau, tra đúng ticket theo chat",
    "core",
    [C("intake/notify/reply-router.test.ts", "a route from a different chat does not match")],
  ),
  row(
    "lib/storage/binding-repository.test.ts",
    "dòng cũ không có chat_id chỉ khớp khi binding của ticket đó nằm đúng chat",
    "core",
    [
      C(
        "intake/notify/reply-router.test.ts",
        "an empty-chat route is used only as a fallback when the asking chat holds the binding",
      ),
    ],
  ),
  row(
    "lib/storage/binding-repository.test.ts",
    "dòng có chat_id đúng được ưu tiên hơn dòng cũ không rõ chat",
    "deferred",
    "Chờ port ở PR 3 (bộ lưu binding tương thích kho legacy)",
  ),
  row(
    "lib/storage/binding-repository.test.ts",
    "giữ nguyên mọi dòng, điền chat_id từ binding, dòng không suy ra được để rỗng",
    "deferred",
    "Chờ port ở PR 3 (bộ lưu binding tương thích kho legacy)",
  ),
  row(
    "lib/storage/binding-repository.test.ts",
    "chạy lại applySchema nhiều lần không mất dữ liệu (idempotent)",
    "deferred",
    "Chờ port ở PR 3 (bộ lưu binding tương thích kho legacy)",
  ),
  row(
    "lib/storage/binding-repository.test.ts",
    "lọc theo projectKey: không lấy nhầm ticket của bot kia dù mới hơn",
    "deferred",
    "Chờ port ở PR 3 (bộ lưu binding tương thích kho legacy)",
  ),
  row(
    "lib/storage/binding-repository.test.ts",
    "tiền tố phải khớp đủ: dự án TECH không lấy TECHTEST",
    "deferred",
    "Chờ port ở PR 3 (bộ lưu binding tương thích kho legacy)",
  ),
  // ── mcp/shared/tools/confirmation-and-binding.test.ts (22) ──
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "create_issue: bước xác nhận userConfirmed = false không tạo ticket và yêu cầu xác nhận",
    "core",
    [C("intake/create/create-ticket.test.ts", "confirm before a summary was shown cannot create")],
  ),
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "create_issue: bước userConfirmed = true tạo ticket trên Itsaplan và lưu binding vào SQLite",
    "core",
    [
      C(
        "intake/create/create-ticket.test.ts",
        "binding saved before side effects (survives a comment path)",
      ),
    ],
  ),
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "create_issue: bước userConfirmed = true tự động khôi phục từ bản nháp SQLite nếu input chỉ có userConfirmed",
    "core",
    [
      C(
        "intake/create/create-ticket.test.ts",
        "REAL INCIDENT PO-79: bare re-confirm never blanks the ticket — draft wins",
      ),
    ],
  ),
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "create_issue: bấm nút xác nhận lần hai không tạo thêm ticket",
    "core",
    [
      C(
        "intake/create/create-ticket.test.ts",
        "REAL INCIDENT: double-confirm returns the SAME ticket (no duplicate)",
      ),
    ],
  ),
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "create_issue: mediaPaths ở lượt xác nhận được gộp với bản nháp, không bị đè mất ảnh",
    "core",
    [
      C(
        "intake/create/create-ticket.test.ts",
        "REAL INCIDENT TECH-637: media the draft gathered is not dropped on confirm",
      ),
    ],
  ),
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "create_issue: giá trị rỗng ở lượt xác nhận không được đè lên bản nháp",
    "core",
    [
      C(
        "intake/create/create-ticket.test.ts",
        "REAL INCIDENT PO-79: bare re-confirm never blanks the ticket — draft wins",
      ),
    ],
  ),
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "create_issue: mức ưu tiên của bản nháp không bị mặc định của lượt xác nhận đè",
    "core",
    [
      C(
        "intake/create/create-ticket.test.ts",
        "REAL INCIDENT PO-79: bare re-confirm never blanks the ticket — draft wins",
      ),
    ],
  ),
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "create_issue: xác nhận trần mà mất sạch ngữ cảnh thì xin lại, không tạo ticket trắng",
    "core",
    [
      C(
        "intake/create/create-ticket.test.ts",
        "REAL INCIDENT PO-88: bare confirm with no draft and no binding asks to resend",
      ),
    ],
  ),
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "create_issue: xác nhận trần KHÔNG có chatId cũng không được tạo ticket trắng",
    "core",
    [
      C(
        "intake/create/create-ticket.test.ts",
        "REAL INCIDENT PO-88: bare confirm with no draft and no binding asks to resend",
      ),
    ],
  ),
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "create_issue: tự động gắn typeId; mã ticket tương tự do model tự đưa KHÔNG được ghi (ADR-0007)",
    "deferred",
    "Chờ port ở PR 15 (defineBot lễ tân thành pack MCP và skill)",
  ),
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "check_identity: trả về latestTicket khi người dùng đã có ticket trong SQLite",
    "deferred",
    "Chờ port ở PR 3 (bộ lưu binding tương thích kho legacy): latestTicket đọc từ binding",
  ),
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "check_identity: không trả về latestTicket khi ticket đã cũ hơn 30 phút",
    "deferred",
    "Chờ port ở PR 3 (bộ lưu binding tương thích kho legacy): latestTicket đọc từ binding, cửa sổ 30 phút (D9)",
  ),
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "check_identity: trả về pendingDraft khi có bản nháp ticket đang gom dở",
    "deferred",
    "Chờ port ở PR 15 (pack MCP và skill lễ tân): `check_identity` trả `pendingDraft` đọc từ draft v2",
  ),
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "get_issue: tự động tra cứu ticket gần nhất khi không truyền identifier",
    "deferred",
    "Chờ port ở PR 15 (defineBot lễ tân thành pack MCP và skill): tool tra cứu (D9, ADR-0008)",
  ),
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "update_issue: bắt buộc identifier, không còn tự đoán ticket gần nhất",
    "by-design",
    "legacy ghi qua tool update_issue; TL2 chỉ ghi vào ticket đã có qua xem trước và nút (ADR-0008, PR 11), không còn tool ghi trực tiếp",
  ),
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "update_issue: báo updated=false khi cả ghi mô tả lẫn comment đều lỗi, không được báo thành công giả",
    "ported",
    [
      C(
        "intake/engine/pr11-ticket-commands.test.ts",
        "update_issue: báo updated=false khi cả ghi mô tả lẫn comment đều lỗi, không được báo thành công giả",
      ),
    ],
  ),
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "escalate_issue: bắt buộc identifier, không còn tự đoán ticket gần nhất",
    "by-design",
    "legacy nâng mức qua tool escalate_issue; TL2 nâng mức qua xem trước và nút xác nhận (PR 10 và PR 11), không còn tool ghi trực tiếp",
  ),
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "checkIdentity: lưu initialButtons vào file nút tạm khi user được duyệt và chưa có draft",
    "deferred",
    "Chờ port ở PR 16 (adapter OpenClaw cho pack lễ tân): nút đầu tiên ghi qua file chờ của OpenClaw",
  ),
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "checkRequiredFields: tự động lưu branch buttons và nhắc chọn nhánh khi thiếu variant",
    "deferred",
    "Chờ port ở PR 16 (adapter OpenClaw cho pack lễ tân): nút nhánh ghi qua file chờ của OpenClaw",
  ),
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "checkRequiredFields: đã đính nút thì thôi liệt kê lựa chọn trong câu hỏi",
    "deferred",
    "Chờ port ở PR 16 (adapter OpenClaw cho pack lễ tân): nút nhánh ghi qua file chờ của OpenClaw",
  ),
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "checkRequiredFields: nhớ phòng ban vào sqlite, phiên sau thôi hỏi lại",
    "deferred",
    "Chờ port ở PR 15 (defineBot lễ tân thành pack MCP và skill): tool MCP check_required_fields",
  ),
  row(
    "mcp/shared/tools/confirmation-and-binding.test.ts",
    "checkRequiredFields: không khai bộ nhớ thì giữ nguyên hành vi cũ — vẫn hỏi lại",
    "deferred",
    "Chờ port ở PR 15 (defineBot lễ tân thành pack MCP và skill): tool MCP check_required_fields",
  ),
  // ── mcp/shared/tools/own-tickets-confirm.test.ts (6) ──
  row(
    "mcp/shared/tools/own-tickets-confirm.test.ts",
    "tra yêu cầu của người khác → không kể gì (kể cả tiêu đề)",
    "ported",
    [
      C(
        "intake/engine/ownership-confirm.test.ts",
        "tra yêu cầu của người khác → không kể gì (kể cả tiêu đề)",
      ),
    ],
  ),
  row(
    "mcp/shared/tools/own-tickets-confirm.test.ts",
    "tra yêu cầu của mình → đủ tin, trạng thái PO kèm lời giải thích",
    "ported",
    [
      C(
        "intake/engine/ownership-confirm.test.ts",
        "tra yêu cầu của mình → đủ tin, trạng thái PO kèm lời giải thích",
      ),
    ],
  ),
  row(
    "mcp/shared/tools/own-tickets-confirm.test.ts",
    "không truyền chatId thì không chứng minh được là của mình → từ chối",
    "ported",
    [
      C(
        "intake/engine/ownership-confirm.test.ts",
        "không truyền chatId thì không chứng minh được là của mình → từ chối",
      ),
    ],
  ),
  row(
    "mcp/shared/tools/own-tickets-confirm.test.ts",
    "bổ sung vào yêu cầu người khác → từ chối, không xem trước, không ghi",
    "ported",
    [
      C(
        "intake/engine/ownership-confirm.test.ts",
        "bổ sung vào yêu cầu người khác → từ chối, không xem trước, không ghi",
      ),
    ],
  ),
  row(
    "mcp/shared/tools/own-tickets-confirm.test.ts",
    "bổ sung: lần đầu chỉ xem trước (chưa ghi); bấm xác nhận mới ghi đúng bản đã xem",
    "ported",
    [
      C(
        "intake/engine/ownership-confirm.test.ts",
        "bổ sung: lần đầu chỉ xem trước (chưa ghi); bấm xác nhận mới ghi đúng bản đã xem",
      ),
    ],
  ),
  row(
    "mcp/shared/tools/own-tickets-confirm.test.ts",
    "bấm Huỷ → không ghi, bản chờ bị xoá",
    "ported",
    [C("intake/engine/ownership-confirm.test.ts", "bấm Huỷ → không ghi, bản chờ bị xoá")],
  ),
  // ── mcp/shared/tools/create-issue.intake-dedupe.test.ts (5) ──
  row(
    "mcp/shared/tools/create-issue.intake-dedupe.test.ts",
    "intake_step vừa tạo ticket → create_issue(userConfirmed) trả lại ticket đó, không tạo mới",
    "by-design",
    "legacy có hai đường tạo ticket (tool create_issue và intake_step) nên cần chống trùng giữa hai đường; TL2 chỉ có đường engine, xác nhận idempotent ở core (create-ticket.test.ts)",
  ),
  row(
    "mcp/shared/tools/create-issue.intake-dedupe.test.ts",
    "ticket intake đã cũ (ngoài cửa sổ chống trùng) → create_issue tạo bình thường",
    "by-design",
    "legacy có hai đường tạo ticket (tool create_issue và intake_step) nên cần chống trùng giữa hai đường; TL2 chỉ có đường engine, xác nhận idempotent ở core (create-ticket.test.ts)",
  ),
  row(
    "mcp/shared/tools/create-issue.intake-dedupe.test.ts",
    "create_issue tạo ticket → chỉ đóng tài liệu intake đang MỞ, ghi issueCreatedAt",
    "by-design",
    "legacy có hai đường tạo ticket (tool create_issue và intake_step) nên cần chống trùng giữa hai đường; TL2 chỉ có đường engine, xác nhận idempotent ở core (create-ticket.test.ts)",
  ),
  row(
    "mcp/shared/tools/create-issue.intake-dedupe.test.ts",
    "create_issue KHÔNG đánh dấu tài liệu đã huỷ thành created",
    "by-design",
    "legacy có hai đường tạo ticket (tool create_issue và intake_step) nên cần chống trùng giữa hai đường; TL2 chỉ có đường engine, xác nhận idempotent ở core (create-ticket.test.ts)",
  ),
  row(
    "mcp/shared/tools/create-issue.intake-dedupe.test.ts",
    "withChatLock tuần tự hoá hai việc cùng chat (kể cả khác dạng chatId)",
    "deferred",
    "Chờ port ở PR 15 (defineBot lễ tân thành pack MCP và skill): khoá tuần tự theo chat khi MCP nhận lời gọi song song",
  ),
  // ── mcp/shared/tools/validate-fields.parity.test.ts (14) ──
  row(
    "mcp/shared/tools/validate-fields.parity.test.ts",
    "shape 1: chế độ thuần không có fieldRequirements",
    "core",
    [
      C(
        "intake/gate/gate.test.ts",
        "completes once every required field and one of the oneOf group is present",
      ),
    ],
  ),
  row(
    "mcp/shared/tools/validate-fields.parity.test.ts",
    "shape 2: thiếu reporting_dept -> chưa complete, có consolidatedQuestion",
    "core",
    [C("intake/gate/gate.test.ts", "asks one field per turn even when several are missing")],
  ),
  row(
    "mcp/shared/tools/validate-fields.parity.test.ts",
    "shape 3: đủ trường bắt buộc -> complete",
    "core",
    [
      C(
        "intake/gate/gate.test.ts",
        "completes once every required field and one of the oneOf group is present",
      ),
    ],
  ),
  row(
    "mcp/shared/tools/validate-fields.parity.test.ts",
    "sai enum: chuẩn hoá và bắt lỗi enum",
    "core",
    [
      C(
        "intake/gate/validate.test.ts",
        "enum: chuẩn hoá đúng chính tả và hỗ trợ synonyms, unit prefix, NFC",
      ),
    ],
  ),
  row("mcp/shared/tools/validate-fields.parity.test.ts", "sai regex và rác semantic", "core", [
    C("intake/gate/validate.test.ts", "regex: kiểm tra mẫu định dạng"),
    C("intake/gate/validate.test.ts", "semantic: chặn blacklist và yêu cầu whitelist pattern"),
  ]),
  row(
    "mcp/shared/tools/validate-fields.parity.test.ts",
    "whitelist semantic: không nhận diện được",
    "core",
    [C("intake/gate/validate.test.ts", "semantic: chặn blacklist và yêu cầu whitelist pattern")],
  ),
  row(
    "mcp/shared/tools/validate-fields.parity.test.ts",
    "budget: askedCount 1 tiếp tục hỏi, askedCount 2 rơi về default",
    "core",
    [
      C(
        "intake/gate/gate.test.ts",
        "substitutes the declared default once a field's retry budget is spent",
      ),
      C("intake/gate/gate.test.ts", "keeps asking while the shared budget still has room"),
    ],
  ),
  row(
    "mcp/shared/tools/validate-fields.parity.test.ts",
    "heuristic student_account: phụ huynh/học sinh không có sđt",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/shared/tools/validate-fields.parity.test.ts",
    "bẫy #5: inferProductKey xét fallback_priority TRƯỚC mapping",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/shared/tools/validate-fields.parity.test.ts",
    "SQLite persistence: đọc reporting_dept đã lưu & ghi nhận khi có reporting_dept hợp lệ",
    "deferred",
    "Chờ port ở PR 15 (defineBot lễ tân thành pack MCP và skill): tool MCP validate_fields",
  ),
  row(
    "mcp/shared/tools/validate-fields.parity.test.ts",
    "mọi VALID_SYSTEMS đều hợp lệ qua validateOne('system', v)",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/shared/tools/validate-fields.parity.test.ts",
    "mọi VALID_PRODUCTS đều hợp lệ qua validateOne('product', v)",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/shared/tools/validate-fields.parity.test.ts",
    "mọi VALID_REPORTING_DEPTS đều hợp lệ qua validateOne('reporting_dept', v)",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/shared/tools/validate-fields.parity.test.ts",
    "mọi VALID_ERROR_CATEGORIES đều hợp lệ qua validateOne('error_category', v)",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  // ── mcp/shared/tools/input-defaults.test.ts (2) ──
  row(
    "mcp/shared/tools/input-defaults.test.ts",
    "\u0024{name}: mọi trường hoặc bắt buộc, hoặc optional — không có mặc định",
    "deferred",
    "Chờ port ở PR 15 (defineBot lễ tân thành pack MCP và skill): lược đồ input của tool MCP lễ tân sinh từ khai báo",
  ),
  row(
    "mcp/shared/tools/input-defaults.test.ts",
    "userConfirmed vẫn được phép mặc định — nó là cờ điều khiển, không phải nội dung",
    "deferred",
    "Chờ port ở PR 15 (defineBot lễ tân thành pack MCP và skill): lược đồ input của tool MCP lễ tân sinh từ khai báo",
  ),
  // ── mcp/shared/tools/issues.vocabulary.test.ts (5) ──
  row(
    "mcp/shared/tools/issues.vocabulary.test.ts",
    "ví dụ mã suy từ projectKey, không hard-code TECH",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket): từ vựng và ví dụ mã theo projectKey đi vào CopyCatalog",
  ),
  row(
    "mcp/shared/tools/issues.vocabulary.test.ts",
    "Tiểu Linh giữ nguyên chữ cũ khi không truyền từ vựng",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket): từ vựng và ví dụ mã theo projectKey đi vào CopyCatalog",
  ),
  row(
    "mcp/shared/tools/issues.vocabulary.test.ts",
    "IRIS xưng 'yêu cầu', không xưng 'ticket'",
    "by-design",
    "xưng hô riêng của IRIS (bot PO); Tiểu Linh mới chỉ phục vụ nghiệp vụ của mình, từ vựng bot khác khai trong CopyCatalog của bot đó",
  ),
  row(
    "mcp/shared/tools/issues.vocabulary.test.ts",
    "ví dụ mã suy từ projectKey",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket): từ vựng và ví dụ mã theo projectKey đi vào CopyCatalog",
  ),
  row(
    "mcp/shared/tools/issues.vocabulary.test.ts",
    "mặc định vẫn là TECH cho Tiểu Linh",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket): từ vựng và ví dụ mã theo projectKey đi vào CopyCatalog",
  ),
  // ── mcp/tieulinh/priority.test.ts (7) ──
  row("mcp/tieulinh/priority.test.ts", "hạ mức khi chỉ một người và có cách làm tạm", "core", [
    C("intake/priority/priority.test.ts", "hạ mức khi chỉ một người và có cách làm tạm"),
  ]),
  row(
    "mcp/tieulinh/priority.test.ts",
    "nâng mức khi đang chặn giao dịch, dù model đề Low",
    "core",
    [C("intake/priority/priority.test.ts", "nâng mức khi đang chặn giao dịch, dù model đề Low")],
  ),
  row(
    "mcp/tieulinh/priority.test.ts",
    "sàn thắng trần: chặn giao dịch thì có cách làm tạm cũng vẫn Urgent",
    "core",
    [
      C(
        "intake/priority/priority.test.ts",
        "sàn thắng trần: chặn giao dịch thì có cách làm tạm cũng vẫn Urgent",
      ),
    ],
  ),
  row("mcp/tieulinh/priority.test.ts", "cả hệ thống thì không còn là việc của một người", "core", [
    C("intake/priority/priority.test.ts", "cả hệ thống thì không còn là việc của một người"),
  ]),
  row("mcp/tieulinh/priority.test.ts", "mức hợp lý thì giữ nguyên, không bịa lý do", "core", [
    C("intake/priority/priority.test.ts", "mức hợp lý thì giữ nguyên, không bịa lý do"),
  ]),
  row(
    "mcp/tieulinh/priority.test.ts",
    "thiếu bằng chứng thì nói rõ thiếu gì, không đoán bừa",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket): luật ưu tiên của Tiểu Linh",
  ),
  row(
    "mcp/tieulinh/priority.test.ts",
    "học sinh đơn lẻ gián đoạn học tập thì sàn là High, không ép lên Urgent",
    "core",
    [
      C(
        "intake/priority/priority.test.ts",
        "học sinh đơn lẻ gián đoạn học tập thì sàn là High, không ép lên Urgent",
      ),
    ],
  ),
  // ── mcp/tieulinh/completeness.test.ts (7) ──
  row(
    "mcp/tieulinh/completeness.test.ts",
    "thiếu reporting_dept thì chưa đủ và đính nút bộ phận",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/completeness.test.ts",
    "có đủ reporting_dept thì hoàn tất",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/completeness.test.ts",
    "hỏi reporting_dept quá 2 lần mà vẫn trống thì dùng mặc định, không hỏi mãi",
    "core",
    [
      C(
        "intake/gate/gate.test.ts",
        "substitutes the declared default once a field's retry budget is spent",
      ),
    ],
  ),
  row(
    "mcp/tieulinh/completeness.test.ts",
    "chưa hết ngân sách (mới hỏi 1 lần) thì vẫn tiếp tục hỏi, chưa dùng mặc định",
    "core",
    [C("intake/gate/gate.test.ts", "keeps asking while the shared budget still has room")],
  ),
  row(
    "mcp/tieulinh/completeness.test.ts",
    "sự cố liên quan tài khoản/phụ huynh mà không có số điện thoại hay mã thì đòi thêm student_account",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/completeness.test.ts",
    "có số điện thoại trong lời kể thì không đòi thêm student_account nữa",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/completeness.test.ts",
    "suy đúng product_key từ tên sản phẩm để chọn bộ trường nen_hoi phù hợp",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  // ── mcp/tieulinh/intake-step.test.ts (1) ──
  row(
    "mcp/tieulinh/intake-step.test.ts",
    "gọi intake_step và kiểm tra inspect_tools qua các lượt",
    "deferred",
    "Chờ port ở PR 15 (defineBot lễ tân thành pack MCP và skill)",
  ),
  // ── mcp/tieulinh/validate.test.ts (7) ──
  row(
    "mcp/tieulinh/validate.test.ts",
    "mã người liên quan để chung chung, không gán là mã KH",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/validate.test.ts",
    "mã sai định dạng thì báo, nhưng không dump ghi chú nội bộ cho model",
    "core",
    [C("intake/gate/validate.test.ts", "regex: kiểm tra mẫu định dạng")],
  ),
  row("mcp/tieulinh/validate.test.ts", "enum chuẩn hoá về đúng chính tả trong bảng", "core", [
    C(
      "intake/gate/validate.test.ts",
      "enum: chuẩn hoá đúng chính tả và hỗ trợ synonyms, unit prefix, NFC",
    ),
  ]),
  row(
    "mcp/tieulinh/validate.test.ts",
    "enum sai thì trả kèm danh sách cho phép",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row("mcp/tieulinh/validate.test.ts", "chặn giá trị rác", "core", [
    C("intake/gate/validate.test.ts", "semantic: chặn blacklist và yêu cầu whitelist pattern"),
  ]),
  row("mcp/tieulinh/validate.test.ts", "trường không có luật thì cho qua, không chặn bừa", "core", [
    C("intake/gate/validate.test.ts", "trường không có luật thì cho qua"),
  ]),
  row("mcp/tieulinh/validate.test.ts", "để trống là không hợp lệ", "core", [
    C("intake/gate/validate.test.ts", "trường có luật mà để trống thì báo lỗi"),
  ]),
  // ── mcp/tieulinh/domain.test.ts (12) ──
  row(
    "mcp/tieulinh/domain.test.ts",
    "danh tính người báo đi vào mô tả, không phải do model bịa",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain.test.ts",
    "sự cố của một người mà chưa có định danh thì hỏi thêm",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain.test.ts",
    "sự cố toàn hệ thống thì không hỏi định danh",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain.test.ts",
    "số điện thoại nằm trong câu chữ thì tự moi ra, khỏi hỏi lại",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain.test.ts",
    "chuỗi giữ chỗ để tool thay sau khi tracker cấp mã",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain.test.ts",
    'model điền "null" vào trường tuỳ chọn thì bỏ, không in ra cho người đọc',
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain.test.ts",
    "SĐT lẫn trong diagnosis thì vớt về Thông tin sự cố, không để lại trong mô tả",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain.test.ts",
    "rawText nguyên văn thắng description do model viết lại (TECH-1084)",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain.test.ts",
    "diagnosis của model không lọt vào mô tả ticket, mà được trả ra để ghi comment (TECH-1084)",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain.test.ts",
    "SĐT truyền vào customerId thì chuyển thành SĐT, không in ra Mã khách hàng",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain.test.ts",
    "moi số điện thoại, mỗi số một lần",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain.test.ts",
    "mã phòng không phải tài khoản",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  // ── mcp/tieulinh/rawtext-regression.test.ts (5) ──
  row(
    "mcp/tieulinh/rawtext-regression.test.ts",
    "SĐT người báo nói ở lượt trước không bị xoá vì tin vừa gửi không nhắc lại",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/rawtext-regression.test.ts",
    "văn bản tra cứu lấy từ lời nguyên văn, không phải từ tóm tắt của model",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/rawtext-regression.test.ts",
    "khi không có rawText thì đối chiếu vẫn dùng description làm chuẩn",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/rawtext-regression.test.ts",
    "đoán hệ thống / phân loại lỗi đọc cả rawText, không chỉ description",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/rawtext-regression.test.ts",
    "moi SĐT từ tin nguyên văn khi tóm tắt của model không có số",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  // ── mcp/tieulinh/create-issue-description.test.ts (7) ──
  row(
    "mcp/tieulinh/create-issue-description.test.ts",
    "mô tả = lời nguyên văn, suy luận của bot sang comment",
    "core",
    [
      C(
        "intake/create/create-ticket.test.ts",
        "description = reporter verbatim; diagnosis goes to a marked bot comment",
      ),
    ],
  ),
  row(
    "mcp/tieulinh/create-issue-description.test.ts",
    "comment gợi ý phải mang dấu bot, nếu không sẽ bị học thành 'lời người thật'",
    "core",
    [
      C(
        "core/formatting.test.ts",
        "gắn marker và nhận diện lại chính xác; gọi hai lần không nhân đôi marker",
      ),
    ],
  ),
  row(
    "mcp/tieulinh/create-issue-description.test.ts",
    "bản xem trước hiện đúng lời sẽ ghi vào mô tả (ADR-0008)",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/create-issue-description.test.ts",
    "khi model không đưa rawText, bản xem trước nói rõ đó là lời tóm tắt",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/create-issue-description.test.ts",
    "lời người gõ có Markdown không làm vỡ bản xem trước",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/create-issue-description.test.ts",
    "hỏng khi ghi comment thì ticket vẫn được tạo (best-effort)",
    "core",
    [
      C(
        "intake/create/create-ticket.test.ts",
        "binding saved before side effects (survives a comment path)",
      ),
    ],
  ),
  row(
    "mcp/tieulinh/create-issue-description.test.ts",
    "không tạo comment rác khi không có diagnosis",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  // ── mcp/tieulinh/domain/ticket-formatter.test.ts (37) ──
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "removes the attachment marker the channel leaves behind",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "removes the angle-bracket form too",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "survives a missing description",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "reports the hour people in the office would recognise",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "rolls the date over when UTC evening is the next Vietnamese day",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "turns a bulleted runbook answer into points",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "drops the headings a RAG answer wraps its points in",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "keeps a substantial plain sentence but not a fragment",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "caps the ticket at six points so the description stays readable",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "falls back to the raw text rather than returning nothing",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "gộp nguyên nhân đã biết + gợi ý runbook thành một comment của bot",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "giữ câu hỏi phân biệt khi sự cố mơ hồ (CONTEXT.md, ADR-0007)",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "trả null khi rỗng hoặc chỉ là câu 'không tìm thấy' — không tạo comment rác",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "never writes null or undefined into a field a human will read",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "does not repeat the username when the display name already carries it",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "shows the priority only when the bot overrode what the reporter asked for",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "never plainly restates category or priority — both already sit on the properties bar",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "never lets the bot's own reasoning reach the description (TECH-1084)",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "mô tả là NGUYÊN VĂN lời kể, không phải bản LLM viết lại",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "carries a machine-readable copy of the metadata for later updates",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "does not duplicate similar tickets in description text",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "model/extractor bịa SĐT không ai cho thì không ghi lên ticket — dùng lại SĐT thật moi từ lời kể",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "không moi lại được số nào thật thì để trống, không để lại số bịa",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "mã khách hàng model bịa cũng bị bỏ (không phải SĐT nên không moi lại được)",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "SĐT người báo thật sự cho vẫn giữ nguyên — không chặn nhầm giá trị grounded",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "so khớp bất kể người báo gõ SĐT có khoảng trắng hoặc dấu chấm",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "formatConfirmationMessage (câu xác nhận sau khi tạo ticket) cũng được chặn giống hệt",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "keeps every update in one section rather than stacking headings",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "lời kể đầy đủ sống sót qua mọi lần bổ sung ticket",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "leaves the source footer at the bottom where it belongs",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "promotes a phone number from the note into the metadata block",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "corrects the metadata in place instead of appending a second copy",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "keeps the hidden metadata in step with the visible block",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "cleans up a null line an earlier version left in the description",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "cleans up false customerId when note clarifies it is phone number",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "reads back what was recorded without the internal layout",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  row(
    "mcp/tieulinh/domain/ticket-formatter.test.ts",
    "asks for what is still missing at the end, after the ticket exists",
    "deferred",
    "Chờ port ở PR 14 (dữ liệu domain, chữ và định dạng ticket)",
  ),
  // ── lib/itsaplan/supplement-notifier.test.ts (19) ──
  row(
    "lib/itsaplan/supplement-notifier.test.ts",
    "cột In Progress / Backlog → false (đang mở)",
    "ported",
    [C("intake/notify/supplement-notifier.test.ts", "cột In Progress / Backlog → false (đang mở)")],
  ),
  row(
    "lib/itsaplan/supplement-notifier.test.ts",
    "cột Resolved ('Đã xử lý') → false (vẫn mở để người báo nghiệm thu)",
    "ported",
    [
      C(
        "intake/notify/supplement-notifier.test.ts",
        "cột Resolved ('Đã xử lý') → false (vẫn mở để người báo nghiệm thu)",
      ),
    ],
  ),
  row(
    "lib/itsaplan/supplement-notifier.test.ts",
    "cột Done / Hoàn tất → true (đã đóng)",
    "ported",
    [C("intake/notify/supplement-notifier.test.ts", "cột Done / Hoàn tất → true (đã đóng)")],
  ),
  row(
    "lib/itsaplan/supplement-notifier.test.ts",
    "cột Canceled / Đã hủy → true (đã đóng)",
    "ported",
    [C("intake/notify/supplement-notifier.test.ts", "cột Canceled / Đã hủy → true (đã đóng)")],
  ),
  row(
    "lib/itsaplan/supplement-notifier.test.ts",
    "không có danh sách cột: dựa vào stateType của issue",
    "ported",
    [
      C(
        "intake/notify/supplement-notifier.test.ts",
        "không có danh sách cột: dựa vào stateType của issue",
      ),
    ],
  ),
  row(
    "lib/itsaplan/supplement-notifier.test.ts",
    "chứa mã ticket, 'đã đóng', và hướng dẫn 'tạo ticket mới'",
    "ported",
    [
      C(
        "intake/notify/supplement-notifier.test.ts",
        "chứa mã ticket, 'đã đóng', và hướng dẫn 'tạo ticket mới'",
      ),
    ],
  ),
  row(
    "lib/itsaplan/supplement-notifier.test.ts",
    "in-progress có assignee → mention assignee",
    "ported",
    [C("intake/notify/supplement-notifier.test.ts", "in-progress có assignee → mention assignee")],
  ),
  row(
    "lib/itsaplan/supplement-notifier.test.ts",
    "assignee có tiền tố @ → tự động gỡ @ khỏi username",
    "ported",
    [
      C(
        "intake/notify/supplement-notifier.test.ts",
        "assignee có tiền tố @ → tự động gỡ @ khỏi username",
      ),
    ],
  ),
  row(
    "lib/itsaplan/supplement-notifier.test.ts",
    "no assignee → mention last technician commenter từ timeline",
    "ported",
    [
      C(
        "intake/notify/supplement-notifier.test.ts",
        "no assignee → mention last technician commenter từ timeline",
      ),
    ],
  ),
  row(
    "lib/itsaplan/supplement-notifier.test.ts",
    "no assignee + timeline có technician với actorUsername hợp lệ nhưng chưa trong assignees → dùng actorUsername",
    "ported",
    [
      C(
        "intake/notify/supplement-notifier.test.ts",
        "no assignee + timeline có technician với actorUsername hợp lệ nhưng chưa trong assignees → dùng actorUsername",
      ),
    ],
  ),
  row(
    "lib/itsaplan/supplement-notifier.test.ts",
    "no assignee + không có bình luận kỹ thuật viên nào (chỉ có bot) → none (null)",
    "ported",
    [
      C(
        "intake/notify/supplement-notifier.test.ts",
        "no assignee + không có bình luận kỹ thuật viên nào (chỉ có bot) → none (null)",
      ),
    ],
  ),
  row(
    "lib/itsaplan/supplement-notifier.test.ts",
    "no assignee + timeline rỗng → none (null)",
    "ported",
    [C("intake/notify/supplement-notifier.test.ts", "no assignee + timeline rỗng → none (null)")],
  ),
  row("lib/itsaplan/supplement-notifier.test.ts", "định dạng user_update kèm mention", "ported", [
    C("intake/notify/supplement-notifier.test.ts", "định dạng user_update kèm mention"),
  ]),
  row(
    "lib/itsaplan/supplement-notifier.test.ts",
    "định dạng user_update khi mention đã có tiền tố @ vẫn chuẩn hoá thành đúng (cc @username)",
    "ported",
    [
      C(
        "intake/notify/supplement-notifier.test.ts",
        "định dạng user_update khi mention đã có tiền tố @ vẫn chuẩn hoá thành đúng (cc @username)",
      ),
    ],
  ),
  row(
    "lib/itsaplan/supplement-notifier.test.ts",
    "định dạng user_update không kèm mention (none)",
    "ported",
    [
      C(
        "intake/notify/supplement-notifier.test.ts",
        "định dạng user_update không kèm mention (none)",
      ),
    ],
  ),
  row(
    "lib/itsaplan/supplement-notifier.test.ts",
    "định dạng who_supplement kèm mention",
    "ported",
    [C("intake/notify/supplement-notifier.test.ts", "định dạng who_supplement kèm mention")],
  ),
  row(
    "lib/itsaplan/supplement-notifier.test.ts",
    "định dạng who_supplement không kèm mention",
    "ported",
    [C("intake/notify/supplement-notifier.test.ts", "định dạng who_supplement không kèm mention")],
  ),
  row(
    "lib/itsaplan/supplement-notifier.test.ts",
    "khi NOTIFY_ON_CALL_SUPPLEMENT=1: gọi broadcastAlert tới kênh trực ca",
    "ported",
    [
      C(
        "intake/notify/supplement-notifier.test.ts",
        "khi NOTIFY_ON_CALL_SUPPLEMENT=1: gọi broadcastAlert tới kênh trực ca",
      ),
    ],
  ),
  row(
    "lib/itsaplan/supplement-notifier.test.ts",
    "khi NOTIFY_ON_CALL_SUPPLEMENT không bật: không gửi cảnh báo",
    "ported",
    [
      C(
        "intake/notify/supplement-notifier.test.ts",
        "khi NOTIFY_ON_CALL_SUPPLEMENT không bật: không gửi cảnh báo",
      ),
    ],
  ),
  // ── lib/ask-learning/lookup.test.ts (3) ──
  row(
    "lib/ask-learning/lookup.test.ts",
    "dbPath rỗng hoặc undefined → trả về undefined",
    "ported",
    [APP("ask-learning/lookup.test.ts", "dbPath rỗng hoặc undefined → trả về undefined")],
  ),
  row(
    "lib/ask-learning/lookup.test.ts",
    "đường dẫn file không mở được → trả về undefined",
    "ported",
    [APP("ask-learning/lookup.test.ts", "đường dẫn file không mở được → trả về undefined")],
  ),
  row(
    "lib/ask-learning/lookup.test.ts",
    "kho hợp lệ → trả về cả items và shares, vừa là mảng vừa có thuộc tính shares",
    "ported",
    [
      APP(
        "ask-learning/lookup.test.ts",
        "kho hợp lệ → trả về cả items và shares, vừa là mảng vừa có thuộc tính shares",
      ),
    ],
  ),
  // ── lib/ask-learning/learned.test.ts (13) ──
  row(
    "lib/ask-learning/learned.test.ts",
    "mục cần gần đây được học; mục chỉ cần từ 2 năm trước rơi ra",
    "ported",
    [
      C(
        "intake/review/learned.test.ts",
        "mục cần gần đây được học; mục chỉ cần từ 2 năm trước rơi ra",
      ),
    ],
  ),
  row(
    "lib/ask-learning/learned.test.ts",
    "dưới ngưỡng số ticket hoặc tỉ lệ thì không học",
    "ported",
    [C("intake/review/learned.test.ts", "dưới ngưỡng số ticket hoặc tỉ lệ thì không học")],
  ),
  row(
    "lib/ask-learning/learned.test.ts",
    "bình luận đã có trong báo cáo (already_in_report) không được tính",
    "ported",
    [
      C(
        "intake/review/learned.test.ts",
        "bình luận đã có trong báo cáo (already_in_report) không được tính",
      ),
    ],
  ),
  row(
    "lib/ask-learning/learned.test.ts",
    "học theo từng hệ thống, không lẫn sang hệ thống khác",
    "ported",
    [C("intake/review/learned.test.ts", "học theo từng hệ thống, không lẫn sang hệ thống khác")],
  ),
  row(
    "lib/ask-learning/learned.test.ts",
    "nhãn cũ (OMS_Vuihoc) được gộp vào hệ thống chuẩn lúc truy vấn",
    "ported",
    [
      C(
        "intake/review/learned.test.ts",
        "nhãn cũ (OMS_Vuihoc) được gộp vào hệ thống chuẩn lúc truy vấn",
      ),
    ],
  ),
  row(
    "lib/ask-learning/learned.test.ts",
    "nhãn App/Web chưa rõ được đếm cho cả DUO_Vuihoc và VH_Tự học",
    "ported",
    [
      C(
        "intake/review/learned.test.ts",
        "nhãn App/Web chưa rõ được đếm cho cả DUO_Vuihoc và VH_Tự học",
      ),
    ],
  ),
  row(
    "lib/ask-learning/learned.test.ts",
    "learnedReport: 9 hệ thống chuẩn + nhãn chưa map",
    "ported",
    [C("intake/review/learned.test.ts", "learnedReport: 9 hệ thống chuẩn + nhãn chưa map")],
  ),
  row(
    "lib/ask-learning/learned.test.ts",
    "trả về tỉ lệ cho mọi mục có trọng số, kể cả không qua ngưỡng minTickets / minShare",
    "ported",
    [
      C(
        "intake/review/learned.test.ts",
        "trả về tỉ lệ cho mọi mục có trọng số, kể cả không qua ngưỡng minTickets / minShare",
      ),
    ],
  ),
  row(
    "lib/ask-learning/learned.test.ts",
    "nhãn cũ (OMS_Vuihoc) gộp vào CRM_Vuihoc theo taxonomy absorbs",
    "ported",
    [
      C(
        "intake/review/learned.test.ts",
        "nhãn cũ (OMS_Vuihoc) gộp vào CRM_Vuihoc theo taxonomy absorbs",
      ),
    ],
  ),
  row(
    "lib/ask-learning/learned.test.ts",
    "hệ thống rỗng hoặc không có ticket → trả về object rỗng",
    "ported",
    [C("intake/review/learned.test.ts", "hệ thống rỗng hoặc không có ticket → trả về object rỗng")],
  ),
  row(
    "lib/ask-learning/learned.test.ts",
    "nhãn chuẩn và nhãn gộp theo taxonomy absorbs",
    "ported",
    [C("intake/review/learned.test.ts", "nhãn chuẩn và nhãn gộp theo taxonomy absorbs")],
  ),
  row(
    "lib/ask-learning/learned.test.ts",
    "nhãn App/Web chưa rõ → cả DUO_Vuihoc lẫn VH_Tự học",
    "ported",
    [C("intake/review/learned.test.ts", "nhãn App/Web chưa rõ → cả DUO_Vuihoc lẫn VH_Tự học")],
  ),
  row("lib/ask-learning/learned.test.ts", "nhãn lạ hoặc rỗng → không map", "ported", [
    C("intake/review/learned.test.ts", "nhãn lạ hoặc rỗng → không map"),
  ]),
  // ── lib/ask-learning/candidate.test.ts (6) ──
  row(
    "lib/ask-learning/candidate.test.ts",
    "kỹ thuật viên nhắc Tiểu Linh → ứng viên",
    "deferred",
    "Nạp tri thức ask-learning (chọn ứng viên từ bình luận kỹ thuật viên), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "lib/ask-learning/candidate.test.ts",
    "@ một tài khoản người báo (SA_/CS_/SC_/TE_) → ứng viên",
    "deferred",
    "Nạp tri thức ask-learning (chọn ứng viên từ bình luận kỹ thuật viên), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "lib/ask-learning/candidate.test.ts",
    "nhắc người báo hoặc Tiểu Linh qua thẻ HTML (@<span...>, <p>, entities) → ứng viên",
    "deferred",
    "Nạp tri thức ask-learning (chọn ứng viên từ bình luận kỹ thuật viên), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "lib/ask-learning/candidate.test.ts",
    "không phải kỹ thuật viên → không",
    "deferred",
    "Nạp tri thức ask-learning (chọn ứng viên từ bình luận kỹ thuật viên), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "lib/ask-learning/candidate.test.ts",
    "kỹ thuật viên nhưng không nhắc ai → không",
    "deferred",
    "Nạp tri thức ask-learning (chọn ứng viên từ bình luận kỹ thuật viên), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "lib/ask-learning/candidate.test.ts",
    "danh sách mặc định có 19 tài khoản TECH",
    "deferred",
    "Nạp tri thức ask-learning (chọn ứng viên từ bình luận kỹ thuật viên), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  // ── lib/ask-learning/classify.test.ts (9) ──
  row(
    "lib/ask-learning/classify.test.ts",
    "JSON tốt → needs_info, mục chuẩn",
    "deferred",
    "Nạp tri thức ask-learning (phân loại bằng LLM), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "lib/ask-learning/classify.test.ts",
    "mục lạ bị bỏ, OTHER bị bỏ, kind không cần bổ sung → không có mục",
    "deferred",
    "Nạp tri thức ask-learning (phân loại bằng LLM), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "lib/ask-learning/classify.test.ts",
    "kind lạ → other, không tính là cần bổ sung dù needs_info=true",
    "deferred",
    "Nạp tri thức ask-learning (phân loại bằng LLM), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "lib/ask-learning/classify.test.ts",
    "các kind cần bổ sung đều tính là needs_info",
    "deferred",
    "Nạp tri thức ask-learning (phân loại bằng LLM), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "lib/ask-learning/classify.test.ts",
    "đầu ra không phải JSON → ném lỗi (không ghi, thử lại lần sau)",
    "deferred",
    "Nạp tri thức ask-learning (phân loại bằng LLM), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "lib/ask-learning/classify.test.ts",
    "LLM lỗi → ném lỗi",
    "deferred",
    "Nạp tri thức ask-learning (phân loại bằng LLM), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "lib/ask-learning/classify.test.ts",
    "quá giờ → ném lỗi",
    "deferred",
    "Nạp tri thức ask-learning (phân loại bằng LLM), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "lib/ask-learning/classify.test.ts",
    "prompt dùng bộ mục chuẩn, không có mã info_need cũ",
    "deferred",
    "Nạp tri thức ask-learning (phân loại bằng LLM), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "lib/ask-learning/classify.test.ts",
    "bỏ khối chẩn đoán và Bổ sung trở đi, bỏ comment HTML",
    "deferred",
    "Nạp tri thức ask-learning (phân loại bằng LLM), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  // ── lib/ask-learning/ingest.test.ts (4) ──
  row(
    "lib/ask-learning/ingest.test.ts",
    "phân loại ứng viên, ghi kho; chạy lại không gọi LLM lần nữa",
    "deferred",
    "Nạp tri thức ask-learning (ghi kho), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "lib/ask-learning/ingest.test.ts",
    "lỗi LLM không ghi gì, lần sau thử lại",
    "deferred",
    "Nạp tri thức ask-learning (ghi kho), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "lib/ask-learning/ingest.test.ts",
    "chạy thử: không gọi LLM, không ghi",
    "deferred",
    "Nạp tri thức ask-learning (ghi kho), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "lib/ask-learning/ingest.test.ts",
    "re-ingest làm mới metadata (system, created_at) cho ticket và bình luận đã có mà KHÔNG gọi LLM",
    "deferred",
    "Nạp tri thức ask-learning (ghi kho), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  // ── lib/ask-learning/source.test.ts (4) ──
  row(
    "lib/ask-learning/source.test.ts",
    "phân trang: lấy đầy đủ issue qua nhiều trang",
    "deferred",
    "Nạp tri thức ask-learning (đọc nguồn Itsaplan), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "lib/ask-learning/source.test.ts",
    "detail fetch: gọi getIssue khi listProjectIssues không có description/system",
    "deferred",
    "Nạp tri thức ask-learning (đọc nguồn Itsaplan), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "lib/ask-learning/source.test.ts",
    "không bao giờ gọi phương thức ghi (strictly read-only)",
    "deferred",
    "Nạp tri thức ask-learning (đọc nguồn Itsaplan), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "lib/ask-learning/source.test.ts",
    "systemFromDescription trích xuất chính xác cả JSON meta lẫn Markdown block",
    "deferred",
    "Nạp tri thức ask-learning (đọc nguồn Itsaplan), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  // ── lib/ask-learning/store.test.ts (2) ──
  row(
    "lib/ask-learning/store.test.ts",
    "upsert idempotent và hasComment",
    "deferred",
    "Nạp tri thức ask-learning (kho SQLite), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "lib/ask-learning/store.test.ts",
    "ticket upsert và liệt kê theo hệ thống",
    "deferred",
    "Nạp tri thức ask-learning (kho SQLite), ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  // ── scripts/ask-learn.test.ts (4) ──
  row(
    "scripts/ask-learn.test.ts",
    "ingest từ JSONL với LLM giả, rồi report; chạy lại không gọi LLM",
    "deferred",
    "Script nạp tri thức ask-learning chạy tay, ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "scripts/ask-learn.test.ts",
    "--exclude bỏ ticket theo query_id; --dry-run không gọi LLM",
    "deferred",
    "Script nạp tri thức ask-learning chạy tay, ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "scripts/ask-learn.test.ts",
    "nguồn Itsaplan chỉ đọc: không gọi hàm ghi nào",
    "deferred",
    "Script nạp tri thức ask-learning chạy tay, ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  row(
    "scripts/ask-learn.test.ts",
    "mã nguồn script không chứa lệnh ghi lên Itsaplan",
    "deferred",
    "Script nạp tri thức ask-learning chạy tay, ngoài chuỗi di trú (RFC 0002 mục 7)",
  ),
  // ── mcp/shared/tools/query-knowledge-graph.test.ts (4) ──
  row(
    "mcp/shared/tools/query-knowledge-graph.test.ts",
    "thực hiện action graph_stats thành công",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  row(
    "mcp/shared/tools/query-knowledge-graph.test.ts",
    "thực hiện action top_root_causes thành công",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  row(
    "mcp/shared/tools/query-knowledge-graph.test.ts",
    "thực hiện action most_related thành công",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  row(
    "mcp/shared/tools/query-knowledge-graph.test.ts",
    "thực hiện action suggest_resolution không lỗi",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  // ── lib/telegram/buttons.test.ts (7) ──
  row(
    "lib/telegram/buttons.test.ts",
    "dùng đúng chữ được truyền vào, callback_data cố định 'đúng rồi'",
    "deferred",
    "Chờ port ở PR 16 (adapter OpenClaw cho pack lễ tân)",
  ),
  row(
    "lib/telegram/buttons.test.ts",
    "xếp options thành hàng đôi, giữ đúng label và callback_data truyền vào",
    "core",
    [C("intake/gate/buttons.test.ts", "puts two short choices on a row")],
  ),
  row(
    "lib/telegram/buttons.test.ts",
    "không tự bịa thêm hay bớt phòng ban nào so với danh sách truyền vào",
    "deferred",
    "Chờ port ở PR 16 (adapter OpenClaw cho pack lễ tân)",
  ),
  row(
    "lib/telegram/buttons.test.ts",
    "trả về danh sách 3 nút nhánh chuẩn cho IRIS",
    "deferred",
    "Chờ port ở PR 16 (adapter OpenClaw cho pack lễ tân)",
  ),
  row(
    "lib/telegram/buttons.test.ts",
    "đổi callbackData -> callback_data, giữ nguyên text và bố cục hàng",
    "core",
    [C("telegram/media.test.ts", "toTelegramButtons converts callbackData → callback_data")],
  ),
  row(
    "lib/telegram/buttons.test.ts",
    "savePendingButtons ghi file JSON chứa danh sách nút",
    "core",
    [C("openclaw/pending-buttons.test.ts", "ghi rồi đọc lại đúng bộ nút")],
  ),
  row("lib/telegram/buttons.test.ts", "clearPendingButtons xóa file nút tạm", "core", [
    C("openclaw/pending-buttons.test.ts", "clear xoá file"),
  ]),
  // ── lib/gate/buttons.test.ts (1) ──
  row(
    "lib/gate/buttons.test.ts",
    "mọi giá trị enum của catalog fixture đều nằm trong trần byte của callback_data",
    "core",
    [
      C(
        "intake/gate/buttons.test.ts",
        "mọi giá trị enum ngắn đều nằm trong trần byte của callback_data",
      ),
    ],
  ),
  // ── openclaw/harness.test.ts (7) ──
  row("openclaw/harness.test.ts", "đếm đúng số lượt đạt và trượt", "core", [
    C("eval/index.test.ts", "tổng hợp pass/fail qua nhiều kịch bản, mỗi kịch bản runner mới"),
  ]),
  row(
    "openclaw/harness.test.ts",
    "bắt đầu từ 0, và hai harness đếm độc lập nhau",
    "by-design",
    "bộ chạy kiểm thử live của legacy (đếm lượt, nạp .env); không phải hành vi lễ tân, phần tương đương ở core/eval và core/env",
  ),
  row("openclaw/harness.test.ts", "đọc KEY=value, bỏ dòng trống và dòng chú thích", "core", [
    C("core/env.test.ts", "parse dòng KEY=VALUE cơ bản"),
  ]),
  row(
    "openclaw/harness.test.ts",
    "giá trị chứa dấu = vẫn nguyên vẹn, chỉ tách ở dấu = đầu tiên",
    "by-design",
    "bộ chạy kiểm thử live của legacy (đếm lượt, nạp .env); không phải hành vi lễ tân, phần tương đương ở core/eval và core/env",
  ),
  row("openclaw/harness.test.ts", "mặc định không ghi đè biến đã có sẵn", "core", [
    C("core/env.test.ts", "nạp biến vào targetEnv mà không ghi đè biến đã có"),
  ]),
  row(
    "openclaw/harness.test.ts",
    "override: true thì ghi đè — đây là điểm ba bản chép tay từng lệch nhau",
    "by-design",
    "bộ chạy kiểm thử live của legacy (đếm lượt, nạp .env); không phải hành vi lễ tân, phần tương đương ở core/eval và core/env",
  ),
  row(
    "openclaw/harness.test.ts",
    "file không tồn tại thì trả false, để nơi gọi lùi về nguồn dự phòng",
    "by-design",
    "bộ chạy kiểm thử live của legacy (đếm lượt, nạp .env); không phải hành vi lễ tân, phần tương đương ở core/eval và core/env",
  ),
];

const FILE_ROWS: FileRow[] = [
  fileRow(
    "lib/channel-envelope.test.ts",
    "core",
    "bóc phong bì kênh đã chuyển nguyên vào core",
    "core/channel-envelope.test.ts",
  ),
  fileRow(
    "lib/formatting.local.test.ts",
    "core",
    "lọc handle bot và marker đã ở core",
    "core/formatting.test.ts",
  ),
  fileRow(
    "lib/html-entities.test.ts",
    "core",
    "giải mã HTML entity đã ở core",
    "core/formatting.test.ts",
  ),
  fileRow("lib/tool-error.test.ts", "core", "mã lỗi công cụ đã ở core", "core/tool-error.test.ts"),
  fileRow("lib/media.test.ts", "core", "giải đường dẫn media đã ở core", "telegram/media.test.ts"),
  fileRow(
    "lib/itsaplan/upload.test.ts",
    "core",
    "tải đính kèm đã ở core",
    "itsaplan/attachments.test.ts",
  ),
  fileRow(
    "lib/itsaplan/ensure-webhook.test.ts",
    "core",
    "đăng ký webhook đã ở core",
    "itsaplan/ensure-webhook.test.ts",
  ),
  fileRow(
    "lib/itsaplan/client-factory.test.ts",
    "core",
    "client Itsaplan đã ở core",
    "itsaplan/client.test.ts",
  ),
  fileRow(
    "lib/itsaplan/state-messages.test.ts",
    "core",
    "lời giải thích cột đã ở core",
    "itsaplan/status.test.ts",
  ),
  fileRow(
    "worker/webhook-server.test.ts",
    "core",
    "máy chủ webhook đã ở core",
    "itsaplan/webhook/server.test.ts",
  ),
  fileRow(
    "worker/telegram-handler.test.ts",
    "core",
    "nút Đã ổn và reply tự do đã ở core (phần lễ tân của lệnh sau tạo ticket thuộc PR 10 và PR 11)",
    "telegram/reporter-inbound.test.ts",
  ),
  fileRow("worker/llm.test.ts", "core", "client LLM đã ở core", "llm/client.test.ts"),
  fileRow(
    "lib/telegram/alert.test.ts",
    "deferred",
    "báo động quản trị qua Telegram và file nút chờ; chưa có tương đương, xem xét ở PR 16 cùng adapter OpenClaw",
  ),
  fileRow(
    "mcp/kg-http/config.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  fileRow(
    "lib/kg/cause-clusters.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  fileRow(
    "lib/kg/human-signals.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  fileRow(
    "lib/kg/kg-queries.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  fileRow(
    "lib/kg/memgraph-client.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  fileRow(
    "lib/kg/quote-gate.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  fileRow(
    "lib/kg/related-plan.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  fileRow(
    "lib/kg/similar-context.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  fileRow(
    "lib/kg/similar-finder.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  fileRow(
    "lib/kg/similar-judge.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  fileRow(
    "lib/kg/similar-ticket-source.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  fileRow(
    "lib/kg/system-taxonomy.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  fileRow(
    "lib/onyx/client.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  fileRow(
    "lib/onyx/connector-manager.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  fileRow(
    "lib/onyx/document.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  fileRow(
    "lib/onyx/filter.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  fileRow(
    "lib/onyx/rest-search.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  fileRow(
    "scripts/golden/record.test.ts",
    "deferred",
    "PR 2 của RFC 0002: script ghi bản ghi vàng của lễ tân (kịch bản vào/ra), không phải test hành vi để port; bản ghi vàng là chuẩn so cho PR 6",
  ),
  fileRow(
    "worker/kg-sync-runner.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  fileRow(
    "worker/kg-sync.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  fileRow(
    "worker/related-curator.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  fileRow(
    "worker/related-recheck.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
  fileRow(
    "worker/related-tickets-sync.test.ts",
    "deferred",
    "Tri thức KG/Onyx/Memgraph, ngoài chuỗi di trú (RFC 0002 mục 7, ADR-0007); RFC riêng sau",
  ),
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const count = (s: Status) => ROWS.filter((r) => r.status === s).length;

describe("sổ đối chiếu lễ tân legacy -> core / Tiểu Linh mới", () => {
  const cache = new Map<string, string>();
  const text = (file: string) => {
    let t = cache.get(file);
    if (t === undefined) {
      t = read(file);
      cache.set(file, t);
    }
    return t;
  };

  test("mỗi test legacy của file trong sổ có đúng một dòng, và mọi dòng trỏ tới test có thật", () => {
    const files = [...new Set(ROWS.map((r) => r.file))];
    for (const file of files) {
      const actual = legacyTitles(text(`${LEGACY}${file}`));
      const inRegister = ROWS.filter((r) => r.file === file).map((r) => r.title);
      const gone = inRegister.filter((t) => !actual.includes(t));
      const unlisted = actual.filter((t) => !inRegister.includes(t));
      expect(gone, `${file}: dòng trong sổ mà test legacy không còn (đổi tên hoặc xoá?)`).toEqual(
        [],
      );
      expect(unlisted, `${file}: test legacy chưa có dòng trong sổ`).toEqual([]);
    }
  });

  test("dòng ported/core trỏ tới test mới có thật; deferred/by-design nêu lý do", () => {
    for (const r of ROWS) {
      const id = `${r.file}: ${r.title}`;
      if (r.status === "ported" || r.status === "core") {
        expect(r.to?.length, id).toBeGreaterThan(0);
        for (const ref of r.to ?? []) {
          expect(text(ref.file).includes(ref.title), `${ref.file}: ${ref.title}`).toBe(true);
        }
      } else {
        expect(r.why?.length ?? 0, id).toBeGreaterThan(10);
      }
    }
  });

  test("dòng deferred nêu PR của RFC 0002 sẽ port, hoặc lý do nằm ngoài chuỗi di trú", () => {
    for (const r of ROWS.filter((x) => x.status === "deferred")) {
      expect(/PR \d+|mục 7|ADR-0007|ngoài chuỗi/.test(r.why ?? ""), `${r.file}: ${r.title}`).toBe(
        true,
      );
    }
  });

  test("không dòng nào trùng", () => {
    const keys = ROWS.map((r) => `${r.file}|${r.title}`);
    expect(new Set(keys).size).toBe(keys.length);
    const fileKeys = FILE_ROWS.map((r) => r.file);
    expect(new Set(fileKeys).size).toBe(fileKeys.length);
  });

  test("mọi file test legacy nằm trong đúng một nơi: dòng theo test, dòng theo file, hoặc sổ hậu cần", () => {
    const perTest = new Set(ROWS.map((r) => r.file));
    const perFile = new Set(FILE_ROWS.map((r) => r.file));
    const hauCan = new Set(HAU_CAN_FILES);
    const all = walk(join(ROOT, LEGACY)).map((p) => relative(join(ROOT, LEGACY), p));
    expect(all.length).toBeGreaterThan(50);
    for (const file of all) {
      const homes = [perTest.has(file), perFile.has(file), hauCan.has(file)].filter(Boolean).length;
      expect(
        homes,
        `${file}: phải nằm trong đúng một nơi của sổ (thêm hoặc xoá dòng cho khớp)`,
      ).toBe(1);
    }
    for (const file of [...perTest, ...perFile, ...hauCan]) {
      expect(all.includes(file), `${file}: không còn file test legacy này`).toBe(true);
    }
  });

  test("dòng theo file: file tương đương ở core có thật; file hậu cần có trong sổ hậu cần", () => {
    for (const r of FILE_ROWS) {
      expect(r.why.length, r.file).toBeGreaterThan(10);
      if (r.status === "core") {
        expect(r.to, r.file).toBeDefined();
        expect(existsSync(join(ROOT, `${CORE}${r.to}`)), `${CORE}${r.to}`).toBe(true);
      }
    }
    const hauCanRegister = text("apps/tieulinh/gap-register.test.ts");
    for (const file of HAU_CAN_FILES) {
      const base = file.slice(file.lastIndexOf("/") + 1);
      expect(
        hauCanRegister.includes(`"${base}"`),
        `${base}: thiếu trong gap-register.test.ts`,
      ).toBe(true);
    }
  });

  test("số liệu trong ENGINE.md khớp sổ", () => {
    const doc = text("packages/core/docs/parity/ENGINE.md");
    const total = ROWS.length;
    const marker = `<!-- gap-register: total=${total} core=${count("core")} ported=${count("ported")} deferred=${count("deferred")} by-design=${count("by-design")} -->`;
    expect(doc.includes(marker), `ENGINE.md thiếu dòng: ${marker}`).toBe(true);
  });

  test("bảng số test deferred theo PR trong ENGINE.md khớp sổ", () => {
    // Bảng này viết tay nên trôi: thêm một dòng `deferred` mà quên cập nhật thì
    // không ai biết. Test này chặn điều đó.
    const byPr = new Map<number, number>();
    for (const r of ROWS.filter((x) => x.status === "deferred")) {
      const m = /PR (\d+)/.exec(r.why ?? "");
      if (!m) continue;
      const pr = Number(m[1]);
      byPr.set(pr, (byPr.get(pr) ?? 0) + 1);
    }

    const doc = text("packages/core/docs/parity/ENGINE.md");
    const block =
      /<!-- gap-register-deferred-by-pr -->([\s\S]*?)<!-- \/gap-register-deferred-by-pr -->/.exec(
        doc,
      );
    expect(block, "ENGINE.md thiếu khối <!-- gap-register-deferred-by-pr -->").not.toBeNull();

    const table = new Map<number, number>();
    for (const m of (block?.[1] ?? "").matchAll(/^\| (\d+) \| (\d+) \|/gm)) {
      table.set(Number(m[1]), Number(m[2]));
    }

    for (const [pr, n] of byPr) {
      expect(table.get(pr), `ENGINE.md thiếu PR ${pr} trong bảng số test deferred theo PR`).toBe(n);
    }
    for (const [pr, n] of table) {
      if (!byPr.has(pr)) {
        expect(n, `ENGINE.md ghi PR ${pr} còn ${n} dòng deferred, số không có trong sổ`).toBe(0);
      }
    }
  });

  test("tóm tắt: mọi dòng có trạng thái hợp lệ", () => {
    expect(count("ported") + count("core") + count("deferred") + count("by-design")).toBe(
      ROWS.length,
    );
    expect(count("core")).toBeGreaterThan(30);
  });
});
