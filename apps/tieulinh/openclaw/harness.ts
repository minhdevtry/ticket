/**
 * Bộ khung dùng chung cho các script kiểm thử trong thư mục này.
 *
 * Sáu script ở đây mỗi cái tự chép lại một hàm `assert` cộng hai biến đếm, và
 * ba cái chép lại cùng một parser `.env` viết tay — trong đó các bản chép còn
 * lệch nhau: một bản đảo thứ tự tham số `assert`, một bản ghi đè biến môi
 * trường sẵn có còn bản kia thì không.
 *
 * Lưu ý các script này KHÔNG chạy dưới `bun test`, và cũng không nên: tên
 * `test-*.ts` không khớp glob `*.test.ts` của runner, mà bên trong chúng gọi
 * thẳng Itsaplan/Onyx thật. Chúng là công cụ chạy tay, `bun run <file>`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Harness {
  /** Ghi nhận một khẳng định. `extra` in kèm khi trượt, để biết giá trị thật là gì. */
  assert(description: string, condition: boolean, extra?: string): void;
  readonly passed: number;
  readonly failed: number;
}

export interface HarnessOptions {
  /** Một số script in `[PASS]` trần, số khác có emoji. Giữ đúng lối in cũ. */
  emoji?: boolean;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const emoji = options.emoji ?? true;
  let passed = 0;
  let failed = 0;

  return {
    assert(description: string, condition: boolean, extra?: string): void {
      if (condition) {
        console.log(`  ${emoji ? "✅ " : ""}[PASS] ${description}`);
        passed++;
      } else {
        console.error(
          `  ${emoji ? "❌ " : ""}[FAIL] ${description}${extra ? ` (${extra})` : ""}`,
        );
        failed++;
      }
    },
    get passed() {
      return passed;
    },
    get failed() {
      return failed;
    },
  };
}

/**
 * Nạp biến môi trường từ một file dạng `KEY=value`.
 *
 * Trả về `false` khi file không tồn tại, để nơi gọi tự quyết có dùng nguồn dự
 * phòng hay không. Mặc định KHÔNG ghi đè biến đã có sẵn trong môi trường.
 */
export function loadEnvFile(
  filePath: string,
  options: { override?: boolean } = {},
): boolean {
  if (!fs.existsSync(filePath)) return false;
  const override = options.override ?? false;

  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (override || !process.env[key]) process.env[key] = value;
  }
  return true;
}

/**
 * Nạp env của một unit systemd người dùng; không có thì lùi về `.env`.
 *
 * Env của unit được ghi đè lên biến sẵn có (đó là nguồn sự thật cho worker
 * đang chạy), còn `.env` chỉ lấp chỗ trống — đúng như các script vẫn làm.
 */
export function loadWorkerEnv(unitName: string): void {
  const unitPath = path.join(os.homedir(), ".config/systemd/user", `${unitName}.env`);
  if (loadEnvFile(unitPath, { override: true })) return;
  loadEnvFile(".env");
}
