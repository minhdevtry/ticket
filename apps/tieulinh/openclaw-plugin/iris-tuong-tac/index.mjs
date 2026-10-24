/**
 * OpenClaw Plugin: Tương Tác Nút Bấm & Khóa Nút Sau Khi Chọn — dùng chung cho mọi agent.
 *
 * 1. Tự động gắn các nút bấm Telegram (inline keyboard buttons) vào câu trả lời của agent.
 * 2. Dọn dẹp văn bản: loại bỏ gạch đầu dòng và đoạn nhắc (chọn một: ...) khi đã có nút ("có nút thì thôi chữ").
 * 3. Khóa nút (Button Lock): Khi người dùng bấm 1 nút, tin nhắn cũ tự động thu gọn chỉ giữ lại đúng 1 nút đã chọn kèm dấu tích (VD: "🛠️ Góp ý cải tiến ✓") và vô hiệu hóa không cho bấm lại nữa.
 *
 * Ban đầu viết riêng cho IRIS (khoá cứng `agentId === "iris-agent"`). Tổng quát hoá
 * 15/09/2026 để phục vụ luôn Tiểu Linh (`agentId: "ticket-intake-agent"`): bỏ khoá
 * agent, và hai hàng rào an toàn (nhận diện "tin đã tạo xong" và "đây có phải tin
 * tóm tắt xác nhận") chuyển sang xét theo HỢP ĐỒNG NÚT dùng chung của
 * `lib/telegram/buttons.ts` — `callback_data` xác nhận luôn là "đúng rồi" cho mọi
 * bot — thay vì các heuristic gắn cứng riêng của IRIS (mã `PO-`, `dong_gop:chot:`).
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const GOC_PLUGIN = dirname(fileURLToPath(import.meta.url));
/** `<mcp>/openclaw-plugin/iris-tuong-tac` — lên hai cấp mới tới gốc `iris-mcp`. */
const GOC_MCP = dirname(dirname(GOC_PLUGIN));
const FILE_ENV = join(GOC_MCP, ".env");
const THU_MUC_NUT = join(homedir(), ".vhbot", "iris-nut-bam");
const NHAT_KY = join(homedir(), ".openclaw", "iris-tuong-tac.log");

try {
  mkdirSync(THU_MUC_NUT, { recursive: true });
} catch {}

/**
 * Ghi thẳng ra file, không qua `api.logger`.
 *
 * Cùng lý do đã đo ở plugin `duyet-nhanh`: log của plugin không ra tới
 * `journalctl`. Khoá nút hỏng là hỏng câm — không file này thì không có dấu vết.
 */
function ghi(dong) {
  try {
    appendFileSync(NHAT_KY, `${new Date().toISOString()} ${dong}\n`);
  } catch {
    /* log hỏng thì kệ, đừng làm hỏng đường tin */
  }
}

/** Đường tới `.env` của MCP. Tách ra để test giữ được đúng số cấp thư mục. */
export function duongEnvMcp() {
  return FILE_ENV;
}

/** Đường tới `openclaw.json` mà gateway đang thực sự dùng. */
export function duongCauHinh(env = process.env) {
  if (env.OPENCLAW_CONFIG_PATH) return env.OPENCLAW_CONFIG_PATH;
  return join(env.OPENCLAW_CONFIG_DIR || join(homedir(), ".openclaw"), "openclaw.json");
}

/**
 * Bot token, theo thứ tự: biến môi trường → cấu hình OpenClaw → `.env` của MCP.
 *
 * Bản trước kết thúc bằng một token viết cứng, và **cả hai nhánh trên nó đều
 * không bao giờ trúng**: `TELEGRAM_BOT_TOKEN` chỉ được nạp vào tiến trình MCP chứ
 * không vào gateway — nơi plugin thật sự chạy; còn `FILE_ENV` trỏ hụt một cấp
 * (`openclaw-plugin/.env`) nên `existsSync` luôn false. Token cứng vì thế là
 * nhánh duy nhất từng chạy: bí mật nằm trong git, và hễ đổi bot hoặc xoay token
 * là nút thôi khoá mà không báo một tiếng nào.
 *
 * `channels.telegram.accounts.<acct>.botToken` mới là nguồn gateway đang dùng:
 * ngoài git, và tự đúng trên mọi máy.
 *
 * Không còn mặc định "iris": plugin giờ chạy cho nhiều bot (Tiểu Linh tài khoản
 * "ticket", IRIS tài khoản "iris"), mặc định sai bot thì khoá nhầm nút của bot
 * khác — thà không khoá còn hơn khoá lộn.
 */
export function layBotToken(accountId = null, env = process.env, duongJson = null) {
  if (env.TELEGRAM_BOT_TOKEN) return env.TELEGRAM_BOT_TOKEN;

  const fileJson = duongJson || duongCauHinh(env);
  if (existsSync(fileJson)) {
    try {
      const tg = JSON.parse(readFileSync(fileJson, "utf-8"))?.channels?.telegram;
      const token = tg?.accounts?.[accountId]?.botToken || tg?.botToken;
      if (token) return token;
    } catch (e) {
      ghi(`đọc cấu hình ${fileJson} hỏng: ${e?.message || e}`);
    }
  }

  if (existsSync(FILE_ENV)) {
    try {
      const m = readFileSync(FILE_ENV, "utf-8").match(/^TELEGRAM_BOT_TOKEN=([^\r\n]+)/m);
      // Server ghi `TELEGRAM_BOT_TOKEN="…"` — giữ nguyên ngoặc thì Telegram trả "Not Found".
      if (m) return m[1].trim().replace(/^(["'])(.*)\1$/, "$2");
    } catch (e) {
      ghi(`đọc ${FILE_ENV} hỏng: ${e?.message || e}`);
    }
  }

  ghi(
    `KHÔNG tìm ra TELEGRAM_BOT_TOKEN (account=${accountId}, cấu hình=${fileJson}) — nút sẽ không khoá được`,
  );
  return null;
}

function laySenderId(ctx, event) {
  const cacNguon = [
    ctx?.to,
    event?.to,
    ctx?.chatId,
    event?.chatId,
    ctx?.senderId,
    ctx?.conversationId,
    ctx?.sessionKey,
    event?.sessionKey,
    ctx?.peerId,
  ];
  for (const n of cacNguon) {
    if (!n) continue;
    const so = String(n).match(/\d{5,}/);
    if (so) return so[0];
  }
  return null;
}

/**
 * Tài khoản Telegram của bot (`iris`, `ticket`). Hook `before_agent_reply` không có
 * `accountId` → trước đây rơi xuống token trong `.env` (bot khác) và khoá nút hỏng
 * "Unauthorized" (28/09). sessionKey có dạng `agent:<agent>:telegram:<account>:…`.
 */
export function layAccountId(ctx, event) {
  const coSan = ctx?.accountId || event?.accountId;
  if (coSan) return coSan;
  const key = String(ctx?.sessionKey || event?.sessionKey || "");
  return key.match(/^agent:[^:]+:telegram:([^:]+):/)?.[1] || null;
}

/**
 * Chuẩn hóa chuỗi để so sánh (bỏ emoji, dấu câu, khoảng trắng)
 */
function chuanHoa(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Lọc bỏ toàn bộ suy nghĩ nội tâm (chain of thought, scratchpad, drafting)
 * mà model lý luận (như MiniMax-M3, DeepSeek...) vô tình xuất ra text.
 */
export function locSuyNghiVaBanNhap(text) {
  if (!text || typeof text !== "string") return text;
  let cleaned = text;

  // 1. Thẻ XML thinking chuẩn: <think>...</think>, <thought>...</thought>, <antthinking>...</antthinking>
  cleaned = cleaned.replace(
    /<\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>[\s\S]*?<\/\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>/gi,
    "",
  );

  // 2. Chặn các đoạn "Final answer:", "Final draft:", "Câu trả lời cuối cùng:", "Câu trả lời:"
  const finalMatch = cleaned.match(
    /(?:^|\n)(?:Final\s*(?:answer|response|draft)|Câu\s*trả\s*lời(?:\s*cuối\s*cùng)?):\s*([\s\S]+)$/i,
  );
  if (finalMatch) {
    return finalMatch[1].trim();
  }

  // 3. MiniMax scratchpad mở đầu bằng tiếng Anh: "The user (...) just said...", "I already called the tools..."
  if (
    /^\s*(?:The\s+user|I\s+already\s+called|Now\s+I\s+need|Wait,\s+I\s+sent|Let\s+me\s+draft|The\s+câu\s+hỏi\s+context|According\s+to|In\s+this\s+turn)\b/i.test(
      cleaned,
    )
  ) {
    // Tìm đoạn tiếng Việt đàm thoại thật sự của IRIS (Em ghi nhận..., Dạ..., Chào..., Vâng...)
    const viMatch = cleaned.match(/(?:^|\n\n+)((?:Em|Dạ|Chào|Vâng|Cảm ơn)[\s\S]+)$/);
    if (viMatch) {
      return viMatch[1].trim();
    }
  }

  return cleaned.trim();
}

/**
 * Lọc bỏ các dòng gạch đầu dòng và đoạn (chọn một: ...) khi đã có nút bấm
 */
export function donDepVanBanKhiCoNut(text, buttons) {
  if (!text || typeof text !== "string" || !Array.isArray(buttons) || buttons.length === 0) {
    return text;
  }

  // 1. Xóa các đoạn nhắc danh mục dạng (chọn một: ...) hoặc (chọn nhiều: ...)
  const cleaned = text.replace(
    /\s*\((?:chọn một|chọn nhiều|chọn một trong|chọn một hoặc nhiều):[^)]+\)/gi,
    "",
  );

  // 2. Lọc bỏ các dòng gạch đầu dòng liệt kê lại các nút bấm
  const danhSachNhan = buttons
    .flat()
    .map((b) => chuanHoa(b.text || b.callback_data))
    .filter(Boolean);

  const cacDong = cleaned.split("\n");
  const cacDongMoi = cacDong.filter((dong) => {
    const dongClean = chuanHoa(dong);
    if (!dongClean) return true;

    const laDongLietKeNut = danhSachNhan.some(
      (nhan) =>
        nhan.length >= 3 &&
        (dongClean === nhan || dongClean.startsWith(nhan) || nhan.startsWith(dongClean)),
    );

    return !laDongLietKeNut;
  });

  return cacDongMoi
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Cập nhật Telegram Inline Keyboard của tin nhắn cũ:
 * Chỉ giữ lại nút đã chọn dạng "[ Nhãn nút ✓ ]" với callback_data="noop"
 */
async function khoaNutTinNhanCu(chatId, messageId, nutDaChon, accountId = null) {
  if (!chatId || !messageId) return;
  const token = layBotToken(accountId);
  if (!token) return;

  const replyMarkup = nutDaChon
    ? {
        inline_keyboard: [
          [
            {
              text: `${nutDaChon} ✓`,
              callback_data: "noop",
            },
          ],
        ],
      }
    : { inline_keyboard: [] };

  try {
    const url = `https://api.telegram.org/bot${token}/editMessageReplyMarkup`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup,
      }),
    });
    // Telegram trả 200 kèm `ok:false` khi token sai hoặc tin quá cũ. Không đọc
    // thân trả lời thì hỏng cũng y như chạy được.
    const kq = await res.json().catch(() => null);
    if (!kq?.ok) {
      ghi(
        `khoá nút hỏng chat=${chatId} msg=${messageId}: ${kq?.description || `HTTP ${res.status}`}`,
      );
    }
  } catch (e) {
    // Không làm gián đoạn luồng chính nếu Telegram API lỗi, nhưng phải để lại vết.
    ghi(`khoá nút lỗi mạng chat=${chatId} msg=${messageId}: ${e?.message || e}`);
  }
}

/**
 * Hàng rào (a) của hook gửi tin: tin nhắc mã ticket (TECH-xx, PO-xx…) thường là tin đã xong
 * việc ("đã tạo TECH-975") → không đính nút. Trả true nếu vẫn được đính nút:
 * - tin không nhắc mã nào, hoặc
 * - nút "Tiếp tục sự cố đang chờ" (câu nhắc tờ khai bị gác, test E2E 28/09), hoặc
 * - nút nhắc ĐÚNG mã có trong tin ("✅ Bổ sung vào TECH-795") — câu hỏi xác nhận về ticket
 *   đó (ADR-0008), không phải tin đã xong việc.
 */
export function choPhepNutTrenTinCoMa(text, buttons) {
  const coMa =
    /(?:Mã theo dõi|Mã yêu cầu|Mã ticket)\s*[:：]\s*[A-Z]{2,8}-\d+/i.test(text) ||
    /\b[A-Z]{2,8}-\d+\b/.test(text);
  if (!coMa) return true;
  const nut = (buttons || []).flat().filter(Boolean);
  // Nút của câu hỏi về ticket vừa nhắc (không phải nút cũ còn sót): "Tiếp tục sự cố đang chờ",
  // "Sự cố mới" / "Bổ sung sự cố đang chờ" ("tin này có mã khác TECH-994 vừa tạo…" — 29/09).
  const nutHoiVeTicket = ["Tiếp tục sự cố đang chờ", "Sự cố mới", "Bổ sung sự cố đang chờ"].map(
    chuanHoa,
  );
  if (nut.some((b) => nutHoiVeTicket.includes(chuanHoa(b.callback_data)))) return true;
  const maTrongTin = text.match(/\b[A-Z]{2,8}-\d+\b/g) || [];
  return nut.some((b) => maTrongTin.some((ma) => String(b.callback_data || "").includes(ma)));
}
const CALLBACK_NOI_BO = new Set(["noop", "none", "ignore", "nil"]);

/**
 * Nhận diện callback nội bộ của hệ thống/nút bấm (như "noop" của nút đã khoá).
 * Tuyệt đối không được cho phép lọt vào luồng xử lý của agent như một tin nhắn
 * người dùng (sự cố TECH-1148: nút khoá [ đúng rồi ✓ ] gửi callback_data="noop",
 * lọt vào intake_step tạo thành ticket có tiêu đề và mô tả "noop").
 */
export function laCallbackNoiBo(body) {
  if (!body || typeof body !== "string") return false;
  const clean = body.trim();
  const m = clean.match(/^\s*(?:callback_data\s*:\s*)?([^\n]+)$/i);
  if (!m) return false;
  const token = m[1].trim().toLowerCase();
  return CALLBACK_NOI_BO.has(token);
}

/**
 * Trả lời Telegram answerCallbackQuery để dừng vòng quay loading trên client khi
 * người dùng bấm vào nút nội bộ / nút đã khoá (TECH-1148).
 */
async function ackCallbackQuery(ctx, event, accountId, customFetch = fetch) {
  const cbId =
    ctx?.callbackQueryId ||
    event?.callbackQueryId ||
    ctx?.callback_query_id ||
    event?.callback_query_id;
  if (!cbId) return;
  const token = layBotToken(accountId);
  if (!token) return;
  try {
    const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
    await customFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: cbId }),
    });
  } catch (e) {
    ghi(`ack callback lỗi: ${e?.message || e}`);
  }
}

const DEBOUNCE_CALLBACK_MS = 10_000;
const daThayCallbacks = new Map();

function xoaCallbackCu(daThay) {
  const now = Date.now();
  for (const [k, t] of daThay) if (now - t > DEBOUNCE_CALLBACK_MS) daThay.delete(k);
  return now;
}

/**
 * Chống bão callback_data (ấn lặp nút hoặc nghẽn hàng đợi Telegram).
 * Nếu cùng một sender/session gửi cùng một callback_data trong vòng DEBOUNCE_CALLBACK_MS,
 * coi như trùng lặp và chặn trước khi dispatch vào agent.
 */
export function xuLyDebounceCallback(body, sessionKey, senderId, daThay = daThayCallbacks) {
  if (!body || typeof body !== "string" || !/^\s*callback_data:\s*/i.test(body)) {
    return false;
  }
  const cleanBody = body.trim();
  const id = sessionKey || senderId || "";
  if (!id) return false;
  const key = `${id}:${cleanBody}`;
  const now = xoaCallbackCu(daThay);
  if (daThay.has(key)) {
    return true;
  }
  daThay.set(key, now);
  return false;
}

export default {
  id: "iris-tuong-tac",
  name: "Tương Tác Nút Bấm (Tiểu Linh + IRIS)",
  description:
    "Tự động đính kèm Telegram Inline Buttons, khóa nút và lọc bỏ suy nghĩ nội tâm — dùng chung cho mọi agent Telegram của gateway.",
  register(api) {
    // Hook 0: Trước khi dispatch tin nhắn -> Chặn callback nội bộ (noop) và loại bỏ các cú bấm callback_data trùng lặp
    api.on("before_dispatch", async (event, ctx, deps = {}) => {
      try {
        const body = event?.body ?? ctx?.body;
        const sessionKey = ctx?.sessionKey ?? event?.sessionKey;
        const senderId = laySenderId(ctx, event);
        const accountId = layAccountId(ctx, event);
        const goi = deps?.fetch || fetch;

        // TECH-1148: Nuốt sạch callback nội bộ (noop, none...) và trả Telegram ack
        if (laCallbackNoiBo(body)) {
          ghi(`nuốt callback nội bộ: ${body} (sender=${senderId}, session=${sessionKey})`);
          await ackCallbackQuery(ctx, event, accountId, goi);
          return { handled: true };
        }

        if (xuLyDebounceCallback(body, sessionKey, senderId)) {
          ghi(`bỏ qua callback trùng lặp: ${body} (sender=${senderId}, session=${sessionKey})`);
          return { handled: true };
        }
      } catch (e) {
        // ignore
      }
    });

    // Hook 1: Trước khi xử lý tin nhắn người dùng tới agent -> Khóa các nút ở tin nhắn cũ nếu người dùng vừa bấm
    api.on("before_agent_reply", async (event, ctx) => {
      try {
        const bodyRaw = event?.cleanedBody || event?.body || ctx?.body;
        // TECH-1148: Lưới an toàn thứ hai tại before_agent_reply nếu tin noop lọt qua
        if (laCallbackNoiBo(bodyRaw)) {
          ghi(`nuốt callback nội bộ tại before_agent_reply: ${bodyRaw}`);
          return { handled: true };
        }

        const senderId = laySenderId(ctx, event);
        if (!senderId) return;

        const fileTinCu = join(THU_MUC_NUT, `tin-cu-${senderId}.json`);
        if (!existsSync(fileTinCu)) return;

        let dataTinCu;
        try {
          dataTinCu = JSON.parse(readFileSync(fileTinCu, "utf-8"));
        } catch {}

        if (dataTinCu?.messageId) {
          const body = String(event?.cleanedBody || "");
          const isCallback = /^\s*callback_data:\s*/i.test(body);
          const bodyNorm = chuanHoa(body.replace(/^callback_data:\s*/i, ""));

          // Tìm xem người dùng bấm vào nút nào
          let nutDuocChon = null;
          if (Array.isArray(dataTinCu.buttons)) {
            for (const btn of dataTinCu.buttons.flat()) {
              const btnNorm = chuanHoa(btn.text || btn.callback_data);
              const valNorm = chuanHoa(btn.callback_data);
              if (
                bodyNorm &&
                (bodyNorm === btnNorm || bodyNorm === valNorm || btnNorm.includes(bodyNorm))
              ) {
                nutDuocChon = btn.text || btn.callback_data;
                break;
              }
            }
          }

          // NẾU là callback_data nhưng KHÔNG khớp bất kỳ nút nào của tin nhắn cũ này
          // (ví dụ callback từ một câu hỏi cũ bị hoãn hoặc kẹt hàng đợi)
          // THÌ tuyệt đối không xóa/khóa nút của tin nhắn hiện tại, và giữ nguyên fileTinCu!
          if (isCallback && !nutDuocChon) {
            return;
          }

          // Cập nhật lại tin nhắn cũ trên Telegram (chỉ giữ lại nút đã chọn)
          await khoaNutTinNhanCu(
            senderId,
            dataTinCu.messageId,
            nutDuocChon,
            layAccountId(ctx, event),
          );
          try {
            unlinkSync(fileTinCu);
          } catch {}
        }
      } catch (e) {
        // ignore
      }
    });

    // Hook 2: Trước khi gửi tin nhắn ra Telegram -> Đính kèm các nút bấm mới và dọn dẹp chữ
    api.on("reply_payload_sending", async (event, ctx) => {
      try {
        if (event?.channel && event.channel !== "telegram") return;

        const payload = event.payload || {};
        if (payload.text && /^(?:Model Fallback:|\[diagnostic\])/i.test(payload.text.trim())) {
          return;
        }

        // LUÔN LỌC SẠCH SUY NGHĨ NỘI TÂM (SCRATCHPAD) DÙ CÓ NÚT HAY KHÔNG
        if (payload.text) {
          payload.text = locSuyNghiVaBanNhap(payload.text);
        }

        const senderId = laySenderId(ctx, event);
        if (!senderId) {
          if (payload.text) return { payload };
          return;
        }

        const fileNut = join(THU_MUC_NUT, `${senderId}.json`);
        if (!existsSync(fileNut)) {
          if (payload.text) return { payload };
          return;
        }

        const raw = readFileSync(fileNut, "utf-8");
        const data = JSON.parse(raw);
        const buttons = data?.buttons;

        if (Array.isArray(buttons) && buttons.length > 0 && Date.now() - (data.ts || 0) < 90000) {
          // 0. Kiểm tra an toàn (tổng quát cho mọi bot, mọi tiền tố mã — trước
          // đây chỉ khớp "PO-", nên khoá này im re với ticket TECH- của Tiểu Linh):
          // a. Nếu đây là tin nhắn báo hoàn tất / xác nhận đã ghi nhận (có nhắc mã
          // TECH-xx, PO-xx...) -> Tuyệt đối không đính nút, không có gì để xác nhận nữa.
          const laTinDaXongViec = !choPhepNutTrenTinCoMa(payload.text || "", buttons);
          if (laTinDaXongViec) {
            try {
              unlinkSync(fileNut);
            } catch {}
            return { payload };
          }

          // b. Nếu nút bấm là nút xác nhận tạo bản ghi (callback_data cố định "đúng
          // rồi" — hợp đồng dùng chung ở `getConfirmationButtons`, xem buttons.ts)
          // nhưng tin nhắn KHÔNG PHẢI là tin tóm tắt xác nhận -> Không được đính
          // nhầm vào một câu hỏi làm rõ thông thường.
          const laNutXacNhan = buttons.some(
            (row) =>
              Array.isArray(row) &&
              row.some((b) => chuanHoa(b.callback_data) === chuanHoa("đúng rồi")),
          );
          if (laNutXacNhan) {
            const laTinTomTat =
              /(?:tóm tắt|kiểm tra (?:kỹ )?(?:lại )?thông tin|trước khi xác nhận|gửi Product team|thông tin đóng góp|bản ghi|Ý tưởng:|Quan sát:|Góp ý:)/i.test(
                payload.text || "",
              );
            if (!laTinTomTat) {
              return { payload };
            }
          }

          try {
            unlinkSync(fileNut);
          } catch {}

          // 1. Dọn dẹp văn bản: loại bỏ các dòng liệt kê thừa và phần (chọn một: ...)
          if (payload.text) {
            payload.text = donDepVanBanKhiCoNut(payload.text, buttons);
          }

          // 2. Gắn buttons trực tiếp vào channelData.telegram
          payload.channelData = {
            ...payload.channelData,
            telegram: {
              ...payload.channelData?.telegram,
              buttons: buttons,
            },
          };

          // 3. Xóa presentation/interactive để tránh bị nhân đôi văn bản
          delete payload.presentation;
          delete payload.interactive;

          // 4. Lưu lại danh sách nút chờ hook message_sent nhận messageId
          const filePending = join(THU_MUC_NUT, `pending-${senderId}.json`);
          try {
            writeFileSync(filePending, JSON.stringify({ buttons, ts: Date.now() }), "utf-8");
          } catch {}

          return { payload };
        }
      } catch (e) {
        // ignore
      }
    });

    // Hook 3: Khi tin nhắn đã gửi thành công ra Telegram -> Lưu lại messageId để khóa nút ở lượt sau
    api.on("message_sent", async (event, ctx) => {
      try {
        const senderId = laySenderId(ctx, event);
        const messageId = event?.messageId || ctx?.messageId;
        if (!senderId || !messageId) return;

        const filePending = join(THU_MUC_NUT, `pending-${senderId}.json`);
        if (!existsSync(filePending)) return;

        try {
          const data = JSON.parse(readFileSync(filePending, "utf-8"));
          unlinkSync(filePending);

          const fileTinCu = join(THU_MUC_NUT, `tin-cu-${senderId}.json`);
          writeFileSync(fileTinCu, JSON.stringify({ messageId, buttons: data.buttons }), "utf-8");
        } catch {}
      } catch (e) {
        // ignore
      }
    });
  },
};
