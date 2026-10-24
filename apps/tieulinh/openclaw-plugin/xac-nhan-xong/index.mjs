/**
 * Phản hồi đã ổn / phản hồi tự do — bắt trước khi vào agent.
 *
 * 1. Khi ticket sang đã xử lý, worker gửi nút `callback_data: reporter_ok:<issueId>`
 * (worker/notifier.ts; nút cũ trước 24/09 là `confirm_done:<issueId>`). Bot chạy
 * qua OpenClaw polling không có ai nhận callback đó: OpenClaw đưa nó vào luồng
 * tin dạng text và LLM tự chế câu trả lời. Plugin gọi thẳng worker của bot
 * (`POST /internal/reporter-ok`, chỉ nhận localhost); worker ghi comment ý kiến
 * người báo và trả lời. Bấm nút KHÔNG đóng ticket — chỉ người xử lý chuyển Done
 * (ADR-0006).
 *
 * 2. Người báo có khi không bấm nút mà nhắn tự do vào đúng tin đó (vd "chưa ổn
 * ạ, vẫn lỗi y như cũ" — spec C4). Webhook mode có `update.message.reply_to_message`
 * để bắt việc này (telegram-handler.ts), nhưng polling mode thì không — tin rơi
 * vào agent và bị hiểu nhầm thành sự cố mới, mất phản hồi (đo 28/09/2026). Phong
 * bì OpenClaw kèm theo tin polling có trường `reply_to_id` (id tin đang được
 * reply); bắt được thì gọi `POST /internal/reporter-reply` — worker tự tra tin
 * đó có phải tin route đã biết không (route không có, vd reply vào tin khác của
 * bot, thì trả `handled: false` và tin vẫn đi tiếp vào agent như thường).
 *
 * Tên plugin giữ "xac-nhan-xong" cho khỏi đổi cấu hình OpenClaw đang chạy.
 * Bảng agent → worker: mặc định Iris (worker PO nghe cổng 3103). Ghi đè bằng
 * env `XAC_NHAN_XONG_WORKERS="agentId=url,agentId=url"` của gateway.
 */
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NHAT_KY = join(homedir(), ".openclaw", "xac-nhan-xong.log");
/** Cửa sổ chống bấm lặp — nút nằm đó mãi nên bấm lại là chuyện thường. */
const GIU_MS = 15_000;
const HET_GIO_MS = 20_000;
const MAC_DINH = { "iris-agent": "http://127.0.0.1:3103" };

function ghi(dong) {
  // `bun test` đặt NODE_ENV=test — không ghi vào nhật ký thật của gateway.
  if (process.env.NODE_ENV === "test") return;
  try {
    appendFileSync(NHAT_KY, `${new Date().toISOString()} ${dong}\n`);
  } catch {}
}

/** Lấy issueId từ `callback_data: reporter_ok:<số>` (hoặc `confirm_done:` cũ); không phải thì `null`. */
export function docXacNhan(noiDung) {
  const m = String(noiDung ?? "").match(/callback_data:\s*(?:reporter_ok|confirm_done):(\d+)\b/i);
  return m ? Number(m[1]) : null;
}

/**
 * Chat id của cuộc trò chuyện vừa bấm nút — worker so với liên kết chat của ticket.
 * Nguồn chắc nhất là session key của gateway (`…:telegram:<account>:direct|group:<id>`).
 * Giữ dấu âm: group id Telegram âm (-100…), bỏ dấu là không bao giờ khớp.
 * senderId chỉ là phương án cuối: trong nhóm, người bấm khác chat.
 */
export function layChatId(ctx = {}, event = {}) {
  const tuSo = (v) => String(v ?? "").match(/-?\d{5,}/)?.[0];
  const khaiSan = tuSo(String(ctx.chatId ?? event.chatId ?? "").replace(/^telegram:/i, ""));
  if (khaiSan) return khaiSan;
  for (const key of [ctx.sessionKey, event.sessionKey]) {
    const m = String(key ?? "").match(/:(?:direct|group|supergroup|channel):(-?\d+)/);
    if (m) return m[1];
  }
  for (const v of [ctx.conversationId, ctx.to, event.to, ctx.peerId, ctx.senderId]) {
    const so = tuSo(v);
    if (so) return so;
  }
  return "";
}

/**
 * Id tin (message_id) mà tin vừa tới đang reply vào — nếu có. Nguồn chắc nhất
 * là trường có cấu trúc trên `ctx`/`event` nếu OpenClaw cấp (chưa có tài liệu
 * xác nhận tên trường, nên thử cả hai tên hay gặp); không có thì rơi về đọc
 * `"reply_to_id"` trong phong bì JSON kèm theo tin (đã thấy trong tin polling
 * thật 28/09/2026, cùng lớp với `chat_id`/`message_id` mà `docXacNhan` đọc).
 */
export function layReplyToId(noiDung, ctx = {}, event = {}) {
  const tuTruong = ctx?.replyToId ?? ctx?.reply_to_id ?? event?.replyToId ?? event?.reply_to_id;
  if (tuTruong !== undefined && tuTruong !== null && String(tuTruong).trim() !== "") {
    return String(tuTruong).trim();
  }
  const m = String(noiDung ?? "").match(/"reply_to_id"\s*:\s*"?(\d+)"?/i);
  return m ? m[1] : null;
}

// ─── Bỏ phong bì OpenClaw khỏi thân tin ──────────────────────────────────
// Bản rút gọn của apps/tieulinh/lib/channel-envelope.ts (`stripChannelEnvelope`).
// Plugin này thuần .mjs, không import chéo được sang lib TypeScript của
// worker (rủi ro làm gateway chết nếu runtime không hiểu .ts) — sao lại đúng
// logic ở đây; đổi bên kia thì nhớ đổi theo.
const TEN_HEADER =
  "(conversation info|sender|conversation context|replied message|reply context|forwarded message|chat history|message context)";
const HEADER_DONG = new RegExp(`^\\s*(?:\\[[^\\]]*\\]\\s*)?${TEN_HEADER}\\b[^\\n]*\\(untrusted[^)]*\\)\\s*:?\\s*$`, "i");
const PHONG_BI_MOT_DONG = new RegExp(`${TEN_HEADER}\\b[^\\n]*\\(untrusted[^)]*\\)[^\\n]*$`, "i");
const DONG_CALLBACK = /^\s*callback_data\s*:\s*[^\n]*$/i;
const KHOA_PHONG_BI = /"(chat_id|sender_id|message_id|inbound_event_kind|username)"\s*:/i;
const DONG_SENDER = /^\s*sender\s*:[^\n]*\busername\s*:/i;
const DONG_LICH_SU = /^\s*#(\d+|session:[0-9a-f]+)\s+\w{3}\s+\d{4}-/i;
const HEADER_CUT = /^\s*(conversation context|chat history[^:\n]*)\s*:\s*$/i;

/** Bỏ "Conversation info / Sender / Conversation context ... (untrusted metadata)" khỏi thân tin. */
export function boPhongBiKenh(text) {
  const src = String(text ?? "");
  if (!/\(untrusted/i.test(src) && !KHOA_PHONG_BI.test(src) && !DONG_SENDER.test(src) && !/^\s*>?\s*#(\d+|session:)/m.test(src)) {
    return src;
  }
  const lines = src.split("\n").map((line) => line.replace(/^\s*>\s?/, ""));
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (HEADER_DONG.test(line)) {
      i++;
      while (i < lines.length && !lines[i].trim()) i++;
      const next = lines[i] ?? "";
      if (/^\s*```/.test(next)) {
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) i++;
        i++;
      } else if (/^\s*\{\s*$/.test(next)) {
        let depth = 0;
        do {
          depth += (lines[i].match(/\{/g) ?? []).length - (lines[i].match(/\}/g) ?? []).length;
          i++;
        } while (i < lines.length && depth > 0);
      } else {
        while (i < lines.length && /^\s*#/.test(lines[i])) i++;
      }
      continue;
    }
    if (/^\s*\{/.test(line)) {
      let j = i;
      let depth = 0;
      const block = [];
      do {
        const l = lines[j].replace(/\\\s*$/, "");
        block.push(l);
        depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
        j++;
      } while (j < lines.length && depth > 0);
      if (KHOA_PHONG_BI.test(block.join("\n"))) {
        i = j;
        continue;
      }
    }
    if (DONG_SENDER.test(line) || DONG_CALLBACK.test(line) || DONG_LICH_SU.test(line) || HEADER_CUT.test(line)) {
      i++;
      continue;
    }
    const inlineMatch = line.match(PHONG_BI_MOT_DONG);
    if (inlineMatch && inlineMatch.index !== undefined) {
      const prefix = line.slice(0, inlineMatch.index).trim();
      if (prefix) out.push(prefix);
      i++;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function docBangWorker(env = process.env) {
  const raw = String(env.XAC_NHAN_XONG_WORKERS ?? "").trim();
  if (!raw) return { ...MAC_DINH };
  const bang = {};
  for (const cap of raw.split(",")) {
    const i = cap.indexOf("=");
    if (i <= 0) continue;
    const agent = cap.slice(0, i).trim();
    const url = cap.slice(i + 1).trim().replace(/\/+$/, "");
    if (agent && url) bang[agent] = url;
  }
  return bang;
}

const CHUA_GHI_NHAN = "Dạ em chưa ghi nhận được, anh/chị bấm lại giúp em sau ít phút nhé.";

/** "/new ..." (không phân biệt hoa thường, có thể kèm "@tenbot") — cú pháp ép sự cố mới (ADR-0008). */
const LENH_SU_CO_MOI = /^\/new(?:@[\w-]+)?(?:\s|$)/i;

/** Tin (đã bỏ phong bì kênh) có phải lệnh "/new" không. */
export function laLenhSuCoMoi(body) {
  return LENH_SU_CO_MOI.test(boPhongBiKenh(body ?? "").trim());
}

function xoaCuHong(daThay) {
  const now = Date.now();
  for (const [k, t] of daThay) if (now - t > GIU_MS) daThay.delete(k);
  return now;
}

/** Bấm nút "👍 Đã ổn" (hoặc nút cũ `confirm_done:`) → `POST /internal/reporter-ok`. */
async function xuLyDaOn(issueId, event, ctx, { fetch: goi, workers, daThay }) {
  // Nhịp tim / cron cũng đi qua hook này — bỏ qua. KHÔNG lọc chặt `trigger === "user"`:
  // 24/09 tin gửi qua `openclaw agent` mang trigger khác, lọt xuống LLM Iris và nó
  // tạo PO-88 trắng. Chỉ nút của bot mang được chuỗi này, nên bắt rộng là an toàn.
  if (ctx?.trigger === "heartbeat" || ctx?.trigger === "cron") return;
  ghi(`nhận đã-ổn:${issueId} agent=${ctx?.agentId} trigger=${ctx?.trigger}`);
  const worker = workers[ctx?.agentId ?? ""];
  if (!worker) {
    ghi(`bỏ qua: agent=${ctx?.agentId} chưa có worker (issue ${issueId})`);
    return;
  }

  const nguoiGui = String(ctx?.senderId ?? "");
  const khoa = `${ctx.agentId}:${nguoiGui}:${issueId}`;
  const now = xoaCuHong(daThay);
  if (daThay.has(khoa)) {
    ghi(`bỏ qua (trùng trong ${GIU_MS / 1000}s): ${khoa}`);
    return { handled: true, reason: "xac-nhan-xong:trung" };
  }
  daThay.set(khoa, now);

  const tenNguoiBam = ctx?.channelContext?.sender?.name || ctx?.senderName || "Người báo";
  // Worker so chat này với liên kết chat của ticket — bấm từ chat lạ thì bỏ qua.
  const chatId = layChatId(ctx ?? {}, event ?? {});
  let replyText = CHUA_GHI_NHAN;
  let ok = false;
  try {
    const res = await goi(`${worker}/internal/reporter-ok`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId, chatId, userName: tenNguoiBam }),
      signal: AbortSignal.timeout(HET_GIO_MS),
    });
    const body = res.ok ? await res.json() : null;
    if (body?.replyText) {
      replyText = body.replyText;
      ok = body.outcome !== "error";
    }
    ghi(`đã-ổn ${khoa} → HTTP ${res.status} outcome=${body?.outcome}`);
  } catch (e) {
    ghi(`HỎNG gọi worker ${worker} cho ${khoa}: ${e?.message || e}`);
  }
  // Hỏng thì cho bấm lại ngay, không bắt chờ hết cửa sổ chống lặp.
  if (!ok) daThay.delete(khoa);
  return { handled: true, reason: "xac-nhan-xong", reply: { text: replyText } };
}

/**
 * Reply tự do (không bấm nút) vào tin thông báo → `POST /internal/reporter-reply`.
 * Worker tự tra `reply_to_id` có phải tin route đã biết không; không phải (vd
 * reply vào tin khác của bot) thì trả `handled: false` — để tin đi tiếp vào
 * agent, không giả vờ đã xử lý.
 */
async function xuLyPhanHoi(replyToId, event, ctx, { fetch: goi, workers, daThay }) {
  if (ctx?.trigger === "heartbeat" || ctx?.trigger === "cron") return;
  const worker = workers[ctx?.agentId ?? ""];
  if (!worker) {
    ghi(`bỏ qua: agent=${ctx?.agentId} chưa có worker (reply→${replyToId})`);
    return;
  }

  const text = boPhongBiKenh(event?.cleanedBody);
  if (!text) return; // không còn gì để chuyển sau khi bỏ phong bì

  const nguoiGui = String(ctx?.senderId ?? "");
  const khoa = `phan-hoi:${ctx.agentId}:${nguoiGui}:${replyToId}`;
  const now = xoaCuHong(daThay);
  if (daThay.has(khoa)) {
    ghi(`bỏ qua (trùng trong ${GIU_MS / 1000}s): ${khoa}`);
    return { handled: true, reason: "xac-nhan-xong:trung" };
  }
  daThay.set(khoa, now);

  const tenNguoiGui = ctx?.channelContext?.sender?.name || ctx?.senderName || "Người báo";
  const chatId = layChatId(ctx ?? {}, event ?? {});
  let ket = null;
  try {
    const res = await goi(`${worker}/internal/reporter-reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, replyToMessageId: replyToId, text, senderName: tenNguoiGui }),
      signal: AbortSignal.timeout(HET_GIO_MS),
    });
    ket = res.ok ? await res.json() : null;
    ghi(`phản hồi reply→${replyToId} ${khoa} → HTTP ${res.status} handled=${ket?.handled}`);
  } catch (e) {
    ghi(`HỎNG gọi worker ${worker} cho ${khoa}: ${e?.message || e}`);
  }

  if (!ket?.handled) {
    // Không phải reply vào tin route đã biết (hoặc worker hỏng) — cho thử lại
    // ngay, không bắt chờ hết cửa sổ chống lặp; để tin đi tiếp vào agent.
    daThay.delete(khoa);
    return;
  }
  return { handled: true, reason: "xac-nhan-xong:phan-hoi", reply: { text: ket.replyText } };
}

/**
 * Lõi xử lý, tách khỏi `register` để test được với fetch giả. Trả `undefined`
 * khi không phải việc của plugin (để tin đi tiếp vào agent như thường).
 */
export async function xuLyXacNhan(event, ctx, { fetch: goi = fetch, workers = docBangWorker(), daThay }) {
  const noiDung = event?.cleanedBody;
  const issueId = docXacNhan(noiDung);
  if (issueId !== null) {
    return xuLyDaOn(issueId, event, ctx, { fetch: goi, workers, daThay });
  }
  const replyToId = layReplyToId(noiDung, ctx, event);
  if (replyToId !== null) {
    return xuLyPhanHoi(replyToId, event, ctx, { fetch: goi, workers, daThay });
  }
  return;
}

/**
 * "/new ..." bị OpenClaw nuốt trước khi tới agent (coi là lệnh reset phiên,
 * xem docs/adr/0008): plugin bắt ở đây, báo worker đặt cờ "ép sự cố mới" cho
 * chat (`chat_flags`, `TicketBindingRepository.setChatFlag`) rồi để tin đi
 * tiếp NHƯ THƯỜNG — KHÔNG trả `handled`, vì OpenClaw còn tự lo phần reset
 * phiên của nó, plugin chỉ cần worker biết ý người báo. Worker hỏng thì chỉ
 * log, không chặn tin.
 */
async function baoEpSuCoMoi(event, ctx, agentId, { fetch: goi = fetch, workers = docBangWorker() } = {}) {
  const worker = workers[agentId] ?? workers[ctx?.agentId ?? ""];
  if (!worker) {
    ghi(`bỏ qua force-new: agent=${agentId || ctx?.agentId} chưa có worker`);
    return;
  }
  const chatId = layChatId(ctx ?? {}, event ?? {});
  if (!chatId) {
    ghi(`bỏ qua force-new: không xác định được chatId`);
    return;
  }
  try {
    const res = await goi(`${worker}/internal/force-new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId }),
      signal: AbortSignal.timeout(HET_GIO_MS),
    });
    ghi(`force-new chat=${chatId} → HTTP ${res.status}`);
  } catch (e) {
    ghi(`HỎNG gọi worker ${worker} cho force-new chat=${chatId}: ${e?.message || e}`);
  }
}

/**
 * Hook `before_dispatch` — chạy TRƯỚC khi tin vào agent, OpenClaw đưa sẵn `replyToId`
 * (hook `before_agent_reply` chỉ có `cleanedBody`, không biết tin đang trả lời
 * tin nào — test E2E 28/09: reply "chưa ổn" lọt vào agent thành sự cố mới).
 * agentId không có trong ctx của hook này → lấy từ sessionKey `agent:<id>:…`.
 */
export async function xuLyTruocDispatch(event, ctx, deps) {
  const sessionKey = String(ctx?.sessionKey ?? event?.sessionKey ?? "");
  const agentId = sessionKey.match(/^agent:([^:]+):/)?.[1] ?? "";

  if (laLenhSuCoMoi(event?.body)) {
    await baoEpSuCoMoi(event, ctx, agentId, deps);
    return; // tin đi tiếp vào OpenClaw/agent như thường — plugin KHÔNG xử lý tin này
  }

  const replyToId = Number(String(event?.replyToId ?? ctx?.replyToId ?? "").match(/\d+/)?.[0] ?? NaN);
  if (!Number.isFinite(replyToId)) return;
  const ctxGia = { agentId, senderId: event?.senderId ?? ctx?.senderId, sessionKey, conversationId: ctx?.conversationId, trigger: "user" };
  if (docXacNhan(event?.body) !== null) return; // cú bấm "Đã ổn" để before_agent_reply lo
  const ket = await xuLyPhanHoi(replyToId, { cleanedBody: event?.body, sessionKey }, ctxGia, deps);
  if (ket?.handled) return { handled: true, text: ket.reply?.text };
}

export default {
  id: "xac-nhan-xong",
  name: "Phản hồi đã ổn",
  description:
    "Bắt cú bấm \"👍 Đã ổn\" và phản hồi tự do (reply) vào tin thông báo trước khi vào agent, gọi worker ghi ý kiến người báo (không đóng ticket).",
  register(api) {
    const workers = docBangWorker();
    const daThay = new Map();
    ghi(`nạp xong, worker: ${JSON.stringify(workers)}`);
    api.on(
      "before_agent_reply",
      async (event, ctx) => {
        try {
          return await xuLyXacNhan(event, ctx, { workers, daThay });
        } catch (e) {
          ghi(`lỗi hook: ${e?.message || e}`);
        }
      },
      // Chạy SAU iris-tuong-tac (priority mặc định) để nút cũ vẫn được khoá.
      { priority: -10 },
    );
    api.on("before_dispatch", async (event, ctx) => {
      try {
        return await xuLyTruocDispatch(event, ctx, { fetch, workers, daThay });
      } catch (e) {
        ghi(`lỗi hook before_dispatch: ${e?.message || e}`);
      }
    });
  },
};
