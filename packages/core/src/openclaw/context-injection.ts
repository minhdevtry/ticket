/**
 * Chèn ngữ cảnh vào lượt agent — HAI chiến lược sau MỘT API, chọn theo cờ runtime.
 *
 * Hai runtime hành xử khác nhau ở hook `before_prompt_build` (đo thật, nguồn
 * `Bot-Sales/plugins/{nap-skill,dinh-huong}/index.mjs`):
 *
 *   • CODEX giữ phần đã chèn trong lịch sử thread, nhưng KHÔNG đưa lịch sử vào
 *     hook (`event.messages` rỗng). ⇒ chèn ĐÚNG MỘT LẦN mỗi phiên; nếu chèn lại
 *     mỗi lượt thì cùng một khối (có khi 14.000 token) bị lặp. Nhớ phiên nào đã
 *     chèn trong BỘ NHỚ tiến trình gateway (Set/Map), mất khi restart thì cùng
 *     lắm chèn lại một lần. (`nap-skill` `daChen`/`nhoDaChen`.)
 *
 *   • EMBEDDED runtime KHÔNG giữ phần chèn: khối chèn lượt trước biến mất khỏi
 *     prompt lượt sau. ⇒ phải chèn LẠI MỖI LƯỢT qua system context, nếu không
 *     ngữ cảnh (vd bảng định tuyến) mất dần khi prompt bị nén. (`dinh-huong`
 *     chèn mỗi lượt qua `prependSystemContext`.)
 *
 * API `injectContext` nhận một cờ runtime và tự chọn: Codex → chèn một lần,
 * embedded → chèn mỗi lượt. Cả hai trả cùng kiểu kết quả, nên gọi ở hook
 * `before_prompt_build` là như nhau: `{ prependSystemContext }` khi có gì để chèn.
 */

/** Runtime nền của gateway. Quyết định chiến lược chèn. */
export type HostRuntime = "codex" | "embedded";

/** Kho nhớ "phiên nào đã được chèn khối nào" — TIÊM VÀO để test không đụng toàn cục. */
export interface SessionInjectionTracker {
  /** Phiên `sessionKey` đã được chèn khối định danh `tag` chưa? */
  has(sessionKey: string, tag: string): boolean;
  /** Ghi nhận đã chèn. */
  mark(sessionKey: string, tag: string): void;
}

/**
 * Tracker trong bộ nhớ tiến trình, có trần số phần tử để không rò rỉ trên gateway
 * chạy lâu (nguồn: giới hạn `MAX_ENTRIES`/`GIOI_HAN` ở các plugin CM/Sales).
 */
export class InMemorySessionInjectionTracker implements SessionInjectionTracker {
  private readonly seen = new Set<string>();

  constructor(private readonly maxEntries = 2000) {}

  private key(sessionKey: string, tag: string): string {
    return `${sessionKey}\u0000${tag}`;
  }

  has(sessionKey: string, tag: string): boolean {
    return this.seen.has(this.key(sessionKey, tag));
  }

  mark(sessionKey: string, tag: string): void {
    if (this.seen.size >= this.maxEntries) {
      // Set giữ thứ tự chèn ⇒ phần tử đầu là cũ nhất.
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.add(this.key(sessionKey, tag));
  }
}

export interface InjectContextInput {
  /** Runtime nền — quyết định một-lần hay mỗi-lượt. */
  runtime: HostRuntime;
  /** sessionKey của lượt; thiếu ⇒ Codex không nhớ được, buộc coi như mỗi lượt. */
  sessionKey: string | null | undefined;
  /** Nội dung cần chèn; rỗng/null ⇒ không chèn gì. */
  content: string | null | undefined;
  /**
   * Nhãn định danh loại khối chèn (ví dụ tên skill, "routing"). Dùng làm khoá
   * "đã chèn chưa" cho Codex — hai loại khối khác nhau trong cùng phiên vẫn chèn
   * được cả hai. Mặc định một nhãn chung.
   */
  tag?: string;
  /** Chỉ cần cho Codex. Thiếu ⇒ không khử trùng được, mỗi lượt chèn lại. */
  tracker?: SessionInjectionTracker;
}

export interface InjectContextResult {
  /** Chuỗi để trả `{ prependSystemContext }`; null = không chèn lượt này. */
  prependSystemContext: string | null;
  /** Vì sao: đã chèn mới / đã có trong phiên / không có nội dung / mỗi-lượt. */
  reason: "injected-once" | "already-in-session" | "injected-per-turn" | "empty";
}

/**
 * Quyết định có chèn ngữ cảnh cho lượt này không, theo runtime.
 *
 *   • `embedded`: luôn chèn khi có nội dung (runtime không giữ lại).
 *   • `codex`: chèn khi phiên CHƯA từng được chèn khối `tag` này; đã chèn ⇒ bỏ.
 *     Không có `sessionKey`/`tracker` ⇒ không nhớ được, chèn như mỗi-lượt (an
 *     toàn hơn: thà lặp còn hơn mất ngữ cảnh).
 */
export function injectContext(input: InjectContextInput): InjectContextResult {
  const content = (input.content ?? "").trim();
  if (!content) return { prependSystemContext: null, reason: "empty" };

  if (input.runtime === "embedded") {
    return { prependSystemContext: content, reason: "injected-per-turn" };
  }

  // Codex: một lần mỗi phiên.
  const tag = input.tag ?? "__default__";
  const sessionKey = (input.sessionKey ?? "").trim();
  if (!sessionKey || !input.tracker) {
    return { prependSystemContext: content, reason: "injected-per-turn" };
  }
  if (input.tracker.has(sessionKey, tag)) {
    return { prependSystemContext: null, reason: "already-in-session" };
  }
  input.tracker.mark(sessionKey, tag);
  return { prependSystemContext: content, reason: "injected-once" };
}
