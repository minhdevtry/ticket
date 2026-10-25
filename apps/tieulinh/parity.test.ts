/**
 * Bảng đối chiếu hành vi: test legacy hậu cần (apps/tieulinh-legacy) -> test của Tiểu Linh mới.
 *
 * Bảng này KIỂM ĐƯỢC: mỗi dòng phải trỏ tới một test legacy có thật (theo tên) và, nếu đã port hoặc
 * do core phủ, tới test mới có thật. Xoá/đổi tên một test mà quên cập nhật bảng thì test này đỏ.
 * Dòng `deferred`/`by-design` phải nêu lý do (và nằm trong danh sách việc sau của README).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const LEGACY = "apps/tieulinh-legacy/worker/";
const APP = "apps/tieulinh/";
const CORE = "packages/core/src/";

type Ref = { file: string; title: string };
type Row = {
  legacy: { file: string; title: string };
  status: "ported" | "core" | "deferred" | "by-design";
  /** `ported`/`core`: test mới tương ứng. */
  to?: Ref[];
  /** `deferred`/`by-design`: lý do. */
  why?: string;
};

const L = (file: string, title: string) => ({ file: `${LEGACY}${file}`, title });
const A = (file: string, title: string): Ref => ({ file: `${APP}${file}`, title });
const C = (file: string, title: string): Ref => ({ file: `${CORE}${file}`, title });

const ROWS: Row[] = [
  // ── agent-runner.test.ts (@mention) ────────────────────────────────────────
  {
    legacy: L(
      "agent-runner.test.ts",
      "run của dự án khác (binding chung DB) không gửi qua bot này",
    ),
    status: "ported",
    to: [A("mention.test.ts", "ticket ngoài dự án TECH2: run bị bỏ qua")],
  },
  {
    legacy: L("agent-runner.test.ts", "run của dự án mình vẫn gửi và lưu route kèm chat"),
    status: "ported",
    to: [A("mention.test.ts", "@mention: LLM đọc ticket qua tool")],
  },
  {
    legacy: L("agent-runner.test.ts", "gỡ thẻ <mark>, <span> tô màu và <video>"),
    status: "ported",
    to: [A("lifecycle.test.ts", "gỡ thẻ <mark>/<span> tô màu của editor")],
  },
  {
    legacy: L(
      "agent-runner.test.ts",
      "ticket không thuộc dự án worker thì bỏ qua, không gọi LLM/Onyx",
    ),
    status: "ported",
    to: [A("mention.test.ts", "ticket ngoài dự án TECH2: run bị bỏ qua")],
  },
  // ── lifecycle.test.ts (SLA) ────────────────────────────────────────────────
  {
    legacy: L("lifecycle.test.ts", "runSlaCheck triggers broadcast alert on breached ticket"),
    status: "ported",
    to: [A("sla.test.ts", "cron + đồng hồ giả")],
  },
  {
    legacy: L("lifecycle.test.ts", "runSlaCheck detects when issue was already moved in-progress"),
    status: "ported",
    to: [A("sla.test.ts", "cron + đồng hồ giả")],
  },
  {
    legacy: L("lifecycle.test.ts", "runSlaCheck chỉ xử lý bản ghi của dự án worker"),
    status: "by-design",
    why: "quét qua tracker khoá dự án nên không có bản ghi của dự án khác để lọc (ADR-0001); không còn bảng sla_trackers",
  },
  {
    legacy: L("lifecycle.test.ts", "lượt quét chồng nhau bị bỏ qua"),
    status: "ported",
    to: [A("sla.test.ts", "lượt quét chồng nhau bị bỏ qua")],
  },
  {
    legacy: L("lifecycle.test.ts", "lượt quét không bao giờ đổi cột ticket trên Itsaplan"),
    status: "ported",
    to: [A("sla.test.ts", "cron + đồng hồ giả")],
  },
  // ── notification-dispatcher.test.ts ────────────────────────────────────────
  {
    legacy: L("notification-dispatcher.test.ts", "matches handle at the beginning of comment"),
    status: "core",
    to: [C("core/formatting.test.ts", "stripBotMentions")],
  },
  {
    legacy: L("notification-dispatcher.test.ts", "đẩy comment không tag ai về người báo"),
    status: "ported",
    to: [A("lifecycle.test.ts", "policy all: comment của người xử lý tới người báo")],
  },
  {
    legacy: L("notification-dispatcher.test.ts", "có tag thì vẫn gỡ tag ra khỏi câu gửi đi"),
    status: "ported",
    to: [A("lifecycle.test.ts", "policy mention: chỉ comment có gắn thẻ bot")],
  },
  {
    legacy: L("notification-dispatcher.test.ts", "comment gắn cờ nội bộ thì giữ lại trên tracker"),
    status: "ported",
    to: [A("lifecycle.test.ts", "comment gắn cờ nội bộ #noibo giữ lại trên tracker")],
  },
  {
    legacy: L("notification-dispatcher.test.ts", "không đẩy ngược comment do chính bot ghi"),
    status: "ported",
    to: [A("lifecycle.test.ts", "chống echo")],
  },
  {
    legacy: L("notification-dispatcher.test.ts", "bỏ qua sự kiện của dự án khác"),
    status: "core",
    to: [C("intake/notify/dispatcher.test.ts", "wrong-project event is skipped")],
  },
  {
    legacy: L("notification-dispatcher.test.ts", "vẫn nhận sự kiện của đúng dự án mình phụ trách"),
    status: "ported",
    to: [A("lifecycle.test.ts", "policy all: comment của người xử lý tới người báo")],
  },
  {
    legacy: L("notification-dispatcher.test.ts", "skips telegram echoes in comment"),
    status: "deferred",
    why: "echo từ chính Telegram đi qua kênh vào (lễ tân), chưa có; chống echo của bot đã có",
  },
  {
    legacy: L(
      "notification-dispatcher.test.ts",
      "state_changed: chuyển columnId (webhook thật chỉ mang columnId) cho TicketClosure",
    ),
    status: "ported",
    to: [A("lifecycle.test.ts", "Resolved: báo người báo kèm nút Đã ổn")],
  },
  {
    legacy: L(
      "notification-dispatcher.test.ts",
      "forwards extracted images to adapter.notifyComment",
    ),
    status: "ported",
    to: [A("lifecycle.test.ts", "ảnh được tách ra")],
  },
  {
    legacy: L(
      "notification-dispatcher.test.ts",
      "forwards extracted videos to adapter.notifyComment",
    ),
    status: "deferred",
    why: "dispatcher của core chưa tách video; việc của lớp render Telegram (việc sau)",
  },
  {
    legacy: L("notification-dispatcher.test.ts", "gỡ thẻ <mark> và <span> tô màu của Tiptap"),
    status: "ported",
    to: [A("lifecycle.test.ts", "gỡ thẻ <mark>/<span> tô màu của editor")],
  },
  {
    legacy: L("notification-dispatcher.test.ts", "ưu tiên envelope.actor.name của webhook mới"),
    status: "ported",
    to: [A("lifecycle.test.ts", "tên người viết kèm theo")],
  },
  {
    legacy: L("notification-dispatcher.test.ts", "IRIS (PO project)"),
    status: "by-design",
    why: "copy riêng của dự án PO; Tiểu Linh mới chỉ phục vụ một dự án (ADR-0001)",
  },
  {
    legacy: L(
      "notification-dispatcher.test.ts",
      "Deduplication: không gửi lặp lại comment vừa được chuyển tiếp",
    ),
    status: "ported",
    to: [A("lifecycle.test.ts", "cùng một comment giao hai lần")],
  },
  {
    legacy: L(
      "notification-dispatcher.test.ts",
      "issue.updated (sửa mô tả) báo closure là KHÔNG đổi cột",
    ),
    status: "ported",
    to: [A("lifecycle.test.ts", "issue.updated (sửa mô tả, không đổi cột) không báo gì")],
  },
  {
    legacy: L("notification-dispatcher.test.ts", "payload không có identifier, không binding"),
    status: "by-design",
    why: "engine lọc dự án theo projectId của tracker, không đoán theo tiền tố mã (core: rules.test.ts)",
  },
  {
    legacy: L("notification-dispatcher.test.ts", "rewrites 127.0.0.1 URLs to itsaplanWebUrl"),
    status: "deferred",
    why: "viết lại URL ảnh cho Telegram thật (việc sau cùng với render Telegram)",
  },
  {
    legacy: L(
      "notification-dispatcher.test.ts",
      "comment.updated (ghim/sửa) và comment.created của người đều báo",
    ),
    status: "core",
    to: [C("intake/notify/dispatcher.test.ts", "comment.updated (edit/pin) does not re-notify")],
  },
  // ── ticket-closure.test.ts ─────────────────────────────────────────────────
  {
    legacy: L("ticket-closure.test.ts", "sang Resolved: báo người báo"),
    status: "ported",
    to: [A("lifecycle.test.ts", "Resolved: báo người báo kèm nút Đã ổn, bot KHÔNG chuyển cột")],
  },
  {
    legacy: L("ticket-closure.test.ts", "Resolved → Done: báo hoàn tất"),
    status: "ported",
    to: [A("lifecycle.test.ts", "Done (do người xử lý): báo hoàn tất không nút")],
  },
  {
    legacy: L("ticket-closure.test.ts", "người xử lý kéo thẳng In Progress → Done"),
    status: "core",
    to: [C("backoffice/closure.test.ts", "kéo thẳng In Progress → Done vẫn báo")],
  },
  {
    legacy: L("ticket-closure.test.ts", "mở lại rồi đóng lại: mỗi lần đóng phát hoàn tất một lần"),
    status: "deferred",
    why: "'phát hoàn tất' là nạp tri thức KG/Onyx, ngoài phạm vi (ADR-0007)",
  },
  {
    legacy: L("ticket-closure.test.ts", "ticket dự án khác không đụng tới (ADR-0001)"),
    status: "core",
    to: [C("backoffice/closure.test.ts", "chat lạ, ticket lạ, ticket dự án khác")],
  },
  {
    legacy: L("ticket-closure.test.ts", "issue.updated đầu tiên của ticket chưa từng thấy"),
    status: "ported",
    to: [A("lifecycle.test.ts", "issue.updated (sửa mô tả, không đổi cột) không báo gì")],
  },
  {
    legacy: L("ticket-closure.test.ts", "ticket có từ trước deploy, sau đó thật sự đổi cột"),
    status: "by-design",
    why: "kho trạng thái mới bắt đầu trống, không chia sẻ DB với legacy nên không có ca 'có từ trước'",
  },
  {
    legacy: L("ticket-closure.test.ts", "ticket đang chờ trong resolved_tickets cũ"),
    status: "by-design",
    why: "không có bảng resolved_tickets cũ để di trú",
  },
  {
    legacy: L("ticket-closure.test.ts", "Telegram lỗi khi báo: trạng thái vẫn được ghi"),
    status: "core",
    to: [C("backoffice/closure.test.ts", "kênh lỗi khi báo")],
  },
  {
    legacy: L("ticket-closure.test.ts", "ticket không có liên kết chat vẫn phát hoàn tất"),
    status: "ported",
    to: [A("lifecycle.test.ts", "ticket chưa có liên kết: im lặng")],
  },
  {
    legacy: L("ticket-closure.test.ts", "bấm khi đang Resolved: ghi comment kèm tên"),
    status: "ported",
    to: [A("lifecycle.test.ts", "người báo bấm Đã ổn: chỉ ghi MỘT comment")],
  },
  {
    legacy: L("ticket-closure.test.ts", "bấm lần hai: không thêm comment"),
    status: "ported",
    to: [A("lifecycle.test.ts", "bấm lần hai không ghi thêm")],
  },
  {
    legacy: L("ticket-closure.test.ts", "bấm từ chat khác"),
    status: "core",
    to: [C("backoffice/closure.test.ts", "chat lạ, ticket lạ, ticket dự án khác")],
  },
  {
    legacy: L("ticket-closure.test.ts", "bấm khi ticket đã hoàn tất / bị kéo lại"),
    status: "core",
    to: [C("backoffice/closure.test.ts", "ticket đã hoàn tất, đã huỷ hoặc bị kéo lại")],
  },
  {
    legacy: L("ticket-closure.test.ts", "ticket không biết: trả lời không tìm thấy"),
    status: "core",
    to: [C("backoffice/closure.test.ts", "chat lạ, ticket lạ, ticket dự án khác")],
  },
  {
    legacy: L("ticket-closure.test.ts", "reply đúng tin route (chatId gọn, không tiền tố)"),
    status: "deferred",
    why: "người báo trả lời tự do vào tin thông báo cần kênh vào (ReplyRouter) của lễ tân",
  },
  // ── duplicate-merger.test.ts ───────────────────────────────────────────────
  {
    legacy: L("duplicate-merger.test.ts", "lấy mã cùng dự án, bỏ chính mình"),
    status: "ported",
    to: [A("duplicates.test.ts", "siblingIdentifiers")],
  },
  {
    legacy: L("duplicate-merger.test.ts", "bỏ mã dự án khác"),
    status: "ported",
    to: [A("duplicates.test.ts", "mã của dự án khác không tính là ticket anh em")],
  },
  {
    legacy: L("duplicate-merger.test.ts", "không có mã nào thì rỗng"),
    status: "ported",
    to: [A("duplicates.test.ts", "comment không nhắc ticket anh em")],
  },
  {
    legacy: L("duplicate-merger.test.ts", "ca trùng thật (944→943)"),
    status: "ported",
    to: [
      A("duplicates.test.ts", "technician nói trùng: chỉ để lại một comment gợi ý"),
      A("duplicates.test.ts", "chép mô tả gốc sang ticket đích, nối link duplicates"),
    ],
  },
  {
    legacy: L("duplicate-merger.test.ts", "ca chỉ tham khảo: LLM trả false"),
    status: "ported",
    to: [A("duplicates.test.ts", "chỉ tham chiếu (LLM nói không trùng)")],
  },
  {
    legacy: L("duplicate-merger.test.ts", "không nhắc ticket nào thì bỏ qua, không gọi LLM"),
    status: "ported",
    to: [A("duplicates.test.ts", "comment không nhắc ticket anh em")],
  },
  {
    legacy: L("duplicate-merger.test.ts", "ca idempotent: webhook gửi lại"),
    status: "ported",
    to: [
      A("duplicates.test.ts", "cùng comment giao lại (webhook retry): chỉ một gợi ý"),
      A("duplicates.test.ts", "webhook giao lại: ticket đích chỉ nhận một comment gộp"),
    ],
  },
  {
    legacy: L("duplicate-merger.test.ts", "ca X đã canceled từ trước"),
    status: "ported",
    to: [A("duplicates.test.ts", "ticket nguồn đã huỷ/hoàn tất: không xét")],
    why: "chặt hơn legacy: ticket nguồn đã đóng thì không xét nữa (legacy vẫn nối link)",
  },
  {
    legacy: L("duplicate-merger.test.ts", "ca LLM lỗi: chỉ log"),
    status: "ported",
    to: [A("duplicates.test.ts", "LLM lỗi: bỏ qua, không comment, không ném")],
  },
  {
    legacy: L("duplicate-merger.test.ts", "bỏ qua bình luận của system actor"),
    status: "ported",
    to: [A("duplicates.test.ts", "comment do agent viết bị engine bỏ qua")],
  },
  {
    legacy: L("duplicate-merger.test.ts", "thiếu cấu hình LLM thì bỏ qua"),
    status: "ported",
    to: [A("duplicates.test.ts", "chưa cấu hình LLM: bỏ qua êm")],
  },
  {
    legacy: L("duplicate-merger.test.ts", "ticket đích đã chuyển sang dự án khác"),
    status: "ported",
    to: [A("duplicates.test.ts", "ticket đích đã chuyển sang dự án khác")],
  },
  // ── notifier.test.ts (Telegram) ────────────────────────────────────────────
  {
    legacy: L("notifier.test.ts", "đã xử lý: nhắn kiểm tra + đúng một nút"),
    status: "core",
    to: [C("telegram/notify-channel.test.ts", "gắn nút 'Đã ổn' với callback đúng")],
  },
  {
    legacy: L("notifier.test.ts", "hoàn tất: báo đã hoàn tất, không kèm nút"),
    status: "ported",
    to: [A("lifecycle.test.ts", "Done (do người xử lý): báo hoàn tất không nút")],
  },
  {
    legacy: L("notifier.test.ts", "trạng thái khác: báo tên cột"),
    status: "ported",
    to: [A("lifecycle.test.ts", "mở lại sau Resolved")],
  },
  {
    legacy: L("notifier.test.ts", "gửi 1 ảnh kèm caption thành 1 tin nhắn duy nhất"),
    status: "deferred",
    why: "gửi media thật qua Telegram (hiện nối ảnh vào văn bản); việc sau cùng với render Telegram",
  },
  {
    legacy: L("notifier.test.ts", "bình luận có tên chứa dấu gạch dưới"),
    status: "deferred",
    why: "parse mode Telegram: core đang gửi văn bản thuần nên không gặp lỗi định dạng",
  },
];

describe("bảng đối chiếu legacy -> Tiểu Linh mới", () => {
  const cache = new Map<string, string>();
  const text = (file: string) => {
    let t = cache.get(file);
    if (t === undefined) {
      t = read(file);
      cache.set(file, t);
    }
    return t;
  };

  test("mọi dòng trỏ tới test legacy có thật", () => {
    for (const row of ROWS) {
      expect(
        text(row.legacy.file).includes(row.legacy.title),
        `${row.legacy.file}: ${row.legacy.title}`,
      ).toBe(true);
    }
  });

  test("dòng ported/core trỏ tới test mới có thật; deferred/by-design nêu lý do", () => {
    for (const row of ROWS) {
      if (row.status === "ported" || row.status === "core") {
        expect(row.to?.length, row.legacy.title).toBeGreaterThan(0);
        for (const ref of row.to ?? []) {
          expect(text(ref.file).includes(ref.title), `${ref.file}: ${ref.title}`).toBe(true);
        }
      } else {
        expect(row.why?.length ?? 0, row.legacy.title).toBeGreaterThan(10);
      }
    }
  });

  test("không dòng nào trùng", () => {
    const keys = ROWS.map((r) => `${r.legacy.file}|${r.legacy.title}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("tóm tắt: số dòng theo trạng thái", () => {
    const count = (s: Row["status"]) => ROWS.filter((r) => r.status === s).length;
    expect(count("ported") + count("core") + count("deferred") + count("by-design")).toBe(
      ROWS.length,
    );
    expect(count("ported")).toBeGreaterThan(25);
  });
});
