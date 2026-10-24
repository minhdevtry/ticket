/**
 * Token danh tính KÝ SỐ (HMAC-SHA256) đi kèm mỗi lượt tool — DÙNG CHUNG cho cả
 * phía plugin (ký, trong tiến trình gateway) lẫn phía MCP server (xác minh).
 *
 * > Danh tính là dữ liệu của hệ thống, không phải đối số của lời gọi tool.
 *
 * Nguồn: `teacheragent/cm/lib/identity-token.ts` + `cm/openclaw-plugin/cm-support/index.mjs`
 * (hai bản `canonicalize`/sign vốn phải khớp từng ký tự giữa hai tiến trình — ở
 * đây gộp làm MỘT để không bao giờ lệch nữa) và `docs/research/i4b-identity-transport.md`.
 *
 * KHÁC bản CM: TTL + clock (`now`) + kho chống replay là THAM SỐ TIÊM VÀO, không
 * đọc `process.env`/`getConfig()` trực tiếp, nên kit không phụ thuộc cấu hình của
 * một bot cụ thể và test bơm được giờ/kho giả. CM không có bước chống replay chủ
 * động (chỉ dựa nonce + hạn); kit thêm một kho nonce tùy chọn để chặn dùng lại
 * token trong hạn, theo yêu cầu ticket 07.
 *
 * TÍNH CHẤT AN TOÀN (giữ nguyên lập luận i4b §4.3):
 *   • Model KHÔNG biết bí mật ⇒ không tạo được token hợp lệ.
 *   • Token gắn `tool` + `runId` + `sessionKey` + `iat` (hạn ngắn) + `nonce` ⇒
 *     token của tool A không dùng cho tool B; token cũ không tái sử dụng.
 *   • Server LUÔN ghi đè `_identity` do model tự điền: chỉ tin khi chữ ký hợp lệ.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Tên tham số mang token. Model thấy nó trong schema nhưng không tạo được token hợp lệ. */
export const IDENTITY_PARAM = "_identity";

/** Hạn mặc định: đủ cho một lượt agent, quá ngắn thì lượt dài sẽ hết hạn. */
export const DEFAULT_IDENTITY_TTL_MS = 10 * 60 * 1000;

const identityTokenSchema = z
  .object({
    /** Telegram user id dạng số — khoá chính. */
    u: z.string(),
    /** username để hiển thị/đối chiếu; có thể null. KHÔNG dùng làm khoá. */
    n: z.string().nullish(),
    /** runId của lượt — khoá nhất quán giữa gateway và MCP. */
    r: z.string().nullish(),
    /** sessionKey của lượt. */
    s: z.string().nullish(),
    /** chatId để nhật ký/đối chiếu. */
    c: z.string().nullish(),
    /** Tên tool mà token này dành cho — chống dùng nhầm sang tool khác. */
    t: z.string(),
    /** Thời điểm phát hành (ms). */
    iat: z.number(),
    /** Nonce ngẫu nhiên — mỗi lượt một giá trị. */
    n2: z.string(),
  })
  .passthrough();

export type IdentityTokenPayload = z.infer<typeof identityTokenSchema>;

/** Lỗi ký/thẩm định: luôn kết luận "không tin được", không tiết lộ lý do cho model. */
export type TokenErrorCode =
  | "E_IDENTITY_TOKEN_MISSING"
  | "E_IDENTITY_TOKEN_MALFORMED"
  | "E_IDENTITY_TOKEN_UNVERIFIED"
  | "E_IDENTITY_TOKEN_EXPIRED"
  | "E_IDENTITY_TOKEN_MISMATCH"
  | "E_IDENTITY_TOKEN_REPLAYED";

export class IdentityTokenFailure extends Error {
  readonly code: TokenErrorCode;

  constructor(code: TokenErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "IdentityTokenFailure";
    this.code = code;
  }
}

/**
 * Kho chống replay: ghi nhận nonce đã dùng tới khi hết hạn. TIÊM VÀO để test
 * dùng kho trong bộ nhớ còn production dùng kho chia sẻ (Redis/SQLite...).
 *
 * `has` phải trả true cho một nonce đã `remember` và CHƯA quá `expiresAt`.
 */
export interface ReplayStore {
  /** Nonce này đã thấy (và còn trong hạn) chưa? */
  has(nonce: string): boolean;
  /** Ghi nhận nonce đã dùng; `expiresAt` là mốc ms sau đó có thể quên. */
  remember(nonce: string, expiresAt: number): void;
}

/**
 * Kho chống replay trong bộ nhớ tiến trình — đủ cho một gateway đơn tiến trình.
 * Tự dọn mục quá hạn theo `now` mỗi lần ghi, nên không rò rỉ bộ nhớ.
 */
export class InMemoryReplayStore implements ReplayStore {
  private readonly seen = new Map<string, number>();

  constructor(private readonly clock: () => number = Date.now) {}

  has(nonce: string): boolean {
    const exp = this.seen.get(nonce);
    if (exp === undefined) return false;
    if (exp <= this.clock()) {
      this.seen.delete(nonce);
      return false;
    }
    return true;
  }

  remember(nonce: string, expiresAt: number): void {
    const now = this.clock();
    // Dọn mục đã quá hạn để Map không phình trên gateway chạy lâu.
    for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
    this.seen.set(nonce, expiresAt);
  }
}

/** Chuỗi canonical để ký — thứ tự khoá cố định, KHÔNG phụ thuộc thứ tự key object. */
function canonicalize(payload: IdentityTokenPayload): string {
  return [
    payload.t,
    payload.u,
    payload.n ?? "",
    payload.r ?? "",
    payload.s ?? "",
    payload.c ?? "",
    String(payload.iat),
    payload.n2,
  ].join("\n");
}

/** Chữ ký HMAC-SHA256 (hex) cho payload. */
export function signIdentityToken(payload: IdentityTokenPayload, secret: string): string {
  return createHmac("sha256", secret).update(canonicalize(payload), "utf8").digest("hex");
}

/**
 * Ký một danh tính và trả về giá trị ghi vào tham số tool `_identity`.
 * Chạy trong tiến trình gateway (plugin), KHÔNG chạy trong tiến trình MCP.
 */
export function issueIdentityToken(input: {
  telegramUserId: string;
  telegramUsername?: string | null;
  runId?: string | null;
  sessionKey?: string | null;
  chatId?: string | null;
  toolName: string;
  secret: string;
  now?: number;
  nonce?: string;
}): { [IDENTITY_PARAM]: string } {
  const payload: IdentityTokenPayload = {
    u: input.telegramUserId,
    n: input.telegramUsername ?? null,
    r: input.runId ?? null,
    s: input.sessionKey ?? null,
    c: input.chatId ?? null,
    t: input.toolName,
    iat: input.now ?? Date.now(),
    n2: input.nonce ?? randomBytes(9).toString("hex"),
  };
  return { [IDENTITY_PARAM]: `${signIdentityToken(payload, input.secret)}.${base64url(payload)}` };
}

function base64url(payload: IdentityTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** So sánh chữ ký theo thời gian hằng số — không rò nhánh qua thời gian. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Thẩm định token do plugin ghi vào tham số tool.
 *
 * Thứ tự kiểm tra (mọi nhánh hỏng ⇒ ném `IdentityTokenFailure`):
 *   1. có token;  2. parse + đúng cấu trúc;  3. chữ ký khớp (bí mật chung);
 *   4. còn trong hạn;  5. `tool` khớp;  6. `runId` khớp NẾU bên gọi biết;
 *   7. nonce chưa dùng (nếu có `replayStore`).
 *
 * VỀ `runId` (giữ nguyên lập luận i4b): tiến trình MCP không biết `runId` của
 * lượt, nên chỉ so khi `expected.runId` được truyền (đường test/mô phỏng). Ở
 * production bỏ qua; chống tái dùng đến từ chữ ký + tool + hạn + nonce (+replay).
 */
export function verifyIdentityToken(
  raw: unknown,
  expected: {
    toolName: string;
    runId?: string | null;
    secret: string;
    now?: number;
    ttlMs?: number;
    replayStore?: ReplayStore;
  },
): IdentityTokenPayload {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new IdentityTokenFailure(
      "E_IDENTITY_TOKEN_MISSING",
      "Tham số _identity không có giá trị.",
    );
  }

  const dot = raw.indexOf(".");
  if (dot <= 0) {
    throw new IdentityTokenFailure("E_IDENTITY_TOKEN_MALFORMED", "Token không đúng định dạng.");
  }
  const signature = raw.slice(0, dot);
  const body = raw.slice(dot + 1);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new IdentityTokenFailure("E_IDENTITY_TOKEN_MALFORMED", "Token không giải mã được.");
  }
  const parsed = identityTokenSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new IdentityTokenFailure("E_IDENTITY_TOKEN_MALFORMED", "Token không đúng cấu trúc.");
  }
  const payload = parsed.data;

  // Chữ ký trước mọi so khớp khác: token sai cấu trúc cũng phải hỏng ở đây.
  if (!safeEqualHex(signature, signIdentityToken(payload, expected.secret))) {
    throw new IdentityTokenFailure(
      "E_IDENTITY_TOKEN_UNVERIFIED",
      "Chữ ký không khớp bí mật chung. Token do mô hình tự tạo hoặc từ phiên khác.",
    );
  }

  const now = expected.now ?? Date.now();
  const ttlMs = expected.ttlMs ?? DEFAULT_IDENTITY_TTL_MS;
  const age = now - payload.iat;
  // Lệch phía tương lai cũng là bất thường: token chưa tới hạn mà đã "hết hạn" ở máy khác.
  if (!Number.isFinite(age) || age > ttlMs || age < -ttlMs) {
    throw new IdentityTokenFailure(
      "E_IDENTITY_TOKEN_EXPIRED",
      `Token đã quá hạn (${ttlMs}ms) hoặc máy lệch giờ.`,
    );
  }

  if (payload.t !== expected.toolName) {
    throw new IdentityTokenFailure(
      "E_IDENTITY_TOKEN_MISMATCH",
      "Token được phát cho tool khác, không dùng được ở đây.",
    );
  }

  // Chỉ so `runId` khi bên gọi thực sự biết nó (test/mô phỏng có runId cố định).
  if (expected.runId && (payload.r ?? null) !== expected.runId) {
    throw new IdentityTokenFailure(
      "E_IDENTITY_TOKEN_MISMATCH",
      "Token thuộc lượt khác (runId không khớp).",
    );
  }

  // Chống replay chủ động: nonce + iat nhận diện một token DUY NHẤT. Thấy lại
  // trong hạn ⇒ ai đó phát lại token cũ. Chỉ ghi nhận SAU khi mọi bước trên qua,
  // để token sai chữ ký không làm bẩn kho.
  if (expected.replayStore) {
    const key = `${payload.n2}.${payload.iat}`;
    if (expected.replayStore.has(key)) {
      throw new IdentityTokenFailure(
        "E_IDENTITY_TOKEN_REPLAYED",
        "Token này đã được dùng — không chấp nhận lần hai.",
      );
    }
    expected.replayStore.remember(key, payload.iat + ttlMs);
  }

  return payload;
}
