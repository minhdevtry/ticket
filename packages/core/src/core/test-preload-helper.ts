/**
 * Xoá mọi biến môi trường gọi RA NGOÀI trước khi test chạy, để `bun test` không
 * bao giờ chạm dịch vụ thật (tracker, Telegram, KG, LLM).
 *
 * NGUỒN: intake `test-preload.ts`. Bản gốc viết cứng danh sách tiền tố của
 * intake; ở đây tách thành HÀM nhận danh sách tiền tố/khoá, để bot nào cũng
 * khai bộ của mình. File preload sẵn dùng cho intake nằm ở `test-preload.ts`
 * cạnh file này.
 *
 * Vì sao bắt buộc: Bun tự nạp `.env` cả khi `bun test`. Test mô phỏng lỗi gọi
 * `alertAdmin` là nhắn THẬT cho admin; test nào lỡ dựng client từ env là gọi
 * dịch vụ thật. 25/09 một lượt `bun test` đã ghi 19 node TEST-KG vào KG TECH
 * thật — nên biến KG không bao giờ được giữ nguyên từ `.env`.
 */

export interface ScrubEnvOptions {
  /**
   * Tiền tố/khoá cần xoá. Mỗi phần tử là RegExp hoặc chuỗi; chuỗi khớp khi tên
   * biến BẮT ĐẦU bằng nó (so khớp tiền tố). Biến khớp bất kỳ phần tử nào bị xoá.
   */
  outbound: Array<string | RegExp>;
  /**
   * Khoá LLM: xoá TRỪ KHI `keepLlmWhen()` trả true (vd đặt `RUN_LIVE_LLM=1` để
   * giữ cho test LLM thật). Mặc định không có.
   */
  llm?: Array<string | RegExp>;
  keepLlmWhen?: () => boolean;
  /** Xoá hẳn các khoá này (vd `MEMGRAPH_URI`), không điều kiện. */
  deleteExact?: string[];
  /**
   * Chuyển hướng: nếu `redirect[i].from` có giá trị thì gán nó cho `to` rồi xoá
   * `from` (vd `MEMGRAPH_TEST_URI` → `MEMGRAPH_URI` để trỏ test graph riêng).
   * Chạy SAU khi xoá, nên `to` chắc chắn sạch trước khi được gán lại.
   */
  redirect?: Array<{ from: string; to: string }>;
  /** Môi trường cần dọn. Mặc định `process.env`. */
  env?: Record<string, string | undefined>;
}

function matches(name: string, patterns: Array<string | RegExp>): boolean {
  return patterns.some((p) => (typeof p === "string" ? name.startsWith(p) : p.test(name)));
}

/**
 * Dọn env theo cấu hình. Trả về danh sách TÊN biến đã xoá (để log/kiểm tra;
 * không bao giờ trả giá trị).
 */
export function scrubOutboundEnv(options: ScrubEnvOptions): string[] {
  const env = options.env ?? process.env;
  const keepLlm = options.keepLlmWhen ? options.keepLlmWhen() : false;
  const llm = options.llm ?? [];
  const removed: string[] = [];

  for (const key of Object.keys(env)) {
    if (matches(key, options.outbound)) {
      delete env[key];
      removed.push(key);
    } else if (!keepLlm && llm.length > 0 && matches(key, llm)) {
      delete env[key];
      removed.push(key);
    }
  }

  for (const key of options.deleteExact ?? []) {
    if (key in env) {
      delete env[key];
      removed.push(key);
    }
  }

  for (const { from, to } of options.redirect ?? []) {
    if (env[from]) {
      env[to] = env[from];
      delete env[from];
    }
  }

  return removed;
}
