import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { alertAdmin, configureAlerts } from "./alert";
import { savePendingButtons, clearPendingButtons } from "./buttons";

const fileFor = (tid: string) => path.join(os.homedir(), ".vhbot", "iris-nut-bam", `${tid}.json`);

describe("alertAdmin", () => {
  const originalFetch = globalThis.fetch;
  let calls: Array<Record<string, unknown>>;

  beforeEach(() => {
    calls = [];
    configureAlerts({ botToken: "test-token", chatId: "42" });
    globalThis.fetch = (async (_url: string, init: any) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    configureAlerts(null);
  });

  test("gửi báo động tới chat quản trị", async () => {
    alertAdmin("khoa-a", "Có chuyện rồi");
    await Bun.sleep(10);
    expect(calls).toHaveLength(1);
    expect(calls[0].chat_id).toBe("42");
    expect(String(calls[0].text)).toContain("Có chuyện rồi");
  });

  /**
   * Chỗ gọi nằm trong đường đi của MỖI lượt chat. Không gom lại thì một lỗi
   * dai dẳng thành hàng trăm tin — spam tới mức bị bỏ qua thì bằng không báo.
   */
  test("cùng một loại sự cố chỉ báo một lần trong cửa sổ chống lặp", async () => {
    alertAdmin("khoa-b", "lần 1");
    alertAdmin("khoa-b", "lần 2");
    alertAdmin("khoa-b", "lần 3");
    await Bun.sleep(10);
    expect(calls).toHaveLength(1);
  });

  test("loại sự cố khác thì vẫn báo", async () => {
    alertAdmin("khoa-c", "một");
    alertAdmin("khoa-d", "hai");
    await Bun.sleep(10);
    expect(calls).toHaveLength(2);
  });

  test("chưa cấu hình kênh báo động thì im lặng, không ném lỗi", () => {
    configureAlerts({});
    expect(() => alertAdmin("khoa-e", "không có chỗ gửi")).not.toThrow();
  });
});

describe("savePendingButtons — chặn nút Telegram sẽ từ chối", () => {
  const tid = "9999999998";
  const tooLong = "Không gấp, Product team có thể đánh giá theo quy trình thông thường";

  beforeEach(() => configureAlerts({}));
  afterEach(() => {
    clearPendingButtons(tid);
    configureAlerts(null);
  });

  /**
   * Sự cố 14/09/2026: Telegram không bỏ riêng nút hỏng, nó từ chối CẢ tin
   * nhắn (400 BUTTON_DATA_INVALID) và bot im hẳn. Mất một nút tốt hơn nhiều.
   */
  test("loại nút quá 64 byte, vẫn ghi những nút còn lại", () => {
    savePendingButtons(tid, [
      [
        { text: "ok", callback_data: "Gấp" },
        { text: "xấu", callback_data: tooLong },
      ],
    ]);
    const saved = JSON.parse(fs.readFileSync(fileFor(tid), "utf-8"));
    expect(saved.buttons).toEqual([[{ text: "ok", callback_data: "Gấp" }]]);
  });

  test("mọi nút đều hỏng thì xoá file thay vì ghi hàng rỗng", () => {
    savePendingButtons(tid, [[{ text: "xấu", callback_data: tooLong }]]);
    expect(fs.existsSync(fileFor(tid))).toBe(false);
  });
});
