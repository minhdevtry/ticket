/**
 * Đọc Telegram bot token của một account từ cấu hình `openclaw.json`.
 *
 * Nguồn: `Bot-Sales`/`intake` plugin `layBotToken` (`iris-tuong-tac/index.mjs`) —
 * đường `channels.telegram.accounts.<acct>.botToken` là nguồn GATEWAY đang thực
 * sự dùng (ngoài git, tự đúng trên mọi máy), fallback `channels.telegram.botToken`
 * cho cấu hình một tài khoản.
 *
 * Ticket 07 tách rõ: `readTelegramBotToken` là HÀM THUẦN trên JSON đã parse (test
 * không đụng đĩa), `loadTelegramBotToken` là bộ nạp nhận ĐƯỜNG DẪN TƯỜNG MINH
 * (không đoán `~/.openclaw/openclaw.json` — đó là việc của bot gọi).
 */
import { readFileSync } from "node:fs";

/** Khuôn tối thiểu của `openclaw.json` mà hàm này quan tâm. */
export interface OpenClawConfigShape {
  channels?: {
    telegram?: {
      /** Token cho cấu hình một tài khoản (không có `accounts`). */
      botToken?: unknown;
      /** Nhiều tài khoản theo id. */
      accounts?: Record<string, { botToken?: unknown } | undefined>;
    };
  };
}

/**
 * Rút bot token của `accountId` từ object `openclaw.json` ĐÃ PARSE.
 *
 * Thứ tự: `accounts[accountId].botToken` → `channels.telegram.botToken`. Không có
 * ⇒ null (KHÔNG đoán token của account khác: khoá nhầm bot còn tệ hơn không khoá —
 * xem ghi chú `layBotToken`). `accountId` null/rỗng ⇒ chỉ xét token một-tài-khoản.
 */
export function readTelegramBotToken(
  config: unknown,
  accountId?: string | null,
): string | null {
  if (!config || typeof config !== "object") return null;
  const tg = (config as OpenClawConfigShape).channels?.telegram;
  if (!tg) return null;

  const acct = (accountId ?? "").trim();
  if (acct) {
    const token = tg.accounts?.[acct]?.botToken;
    if (typeof token === "string" && token.trim()) return token.trim();
  }

  const single = tg.botToken;
  if (typeof single === "string" && single.trim()) return single.trim();

  return null;
}

/**
 * Nạp `openclaw.json` từ ĐƯỜNG DẪN TƯỜNG MINH rồi rút token. File không đọc được
 * hoặc JSON hỏng ⇒ null (không ném: thiếu token là "không khoá được nút", một
 * cảnh báo, không phải sự cố chặn luồng — nguồn `layBotToken` nuốt lỗi parse).
 *
 * `readFile` tiêm vào để test không đụng đĩa thật.
 */
export function loadTelegramBotToken(
  configPath: string,
  accountId?: string | null,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(configPath));
  } catch {
    return null;
  }
  return readTelegramBotToken(parsed, accountId);
}
