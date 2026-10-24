import { describe, expect, it, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvContent, loadEnvFile, parseEnvFile, loadEnvDefaults } from "./env";

// ── Bot-Sales API: parseEnvContent / loadEnvFile ─────────────────────────────
describe("parseEnvContent (Bot-Sales)", () => {
  test("parse dòng KEY=VALUE cơ bản", () => {
    const input = "CRM_BASE_URL=https://devcrm.example.com/crmapi\nCRM_USERNAME=tai_khoan_bot";
    expect(parseEnvContent(input)).toEqual({
      CRM_BASE_URL: "https://devcrm.example.com/crmapi",
      CRM_USERNAME: "tai_khoan_bot",
    });
  });

  test("bỏ qua dòng trống và dòng chú thích (#)", () => {
    const input = `
# Đây là comment
CRM_BASE_URL=https://devcrm.example.com/crmapi

   # Comment có thụt lề
CRM_TIMEOUT_MS=20000
`;
    expect(parseEnvContent(input)).toEqual({
      CRM_BASE_URL: "https://devcrm.example.com/crmapi",
      CRM_TIMEOUT_MS: "20000",
    });
  });

  test("loại bỏ khoảng trắng quanh key và value", () => {
    expect(parseEnvContent("  CRM_NGUON   =   Bitu   ")).toEqual({ CRM_NGUON: "Bitu" });
  });

  test("loại bỏ nháy kép và nháy đơn bao quanh giá trị", () => {
    const input = `
CRM_PASSWORD="mat-khau-gia-123"
CRM_CHATBOT_KEY='secret_key_123'
CRM_EMPTY=""
CRM_SINGLE=''
`;
    expect(parseEnvContent(input)).toEqual({
      CRM_PASSWORD: "mat-khau-gia-123",
      CRM_CHATBOT_KEY: "secret_key_123",
      CRM_EMPTY: "",
      CRM_SINGLE: "",
    });
  });

  test("giữ nguyên giá trị có chứa dấu bằng (=)", () => {
    const input = "CRM_URL=https://devcrm.example.com/crmapi?a=1&b=2=3";
    expect(parseEnvContent(input).CRM_URL).toBe("https://devcrm.example.com/crmapi?a=1&b=2=3");
  });

  test("bỏ qua dòng không có dấu =", () => {
    expect(parseEnvContent("INVALID_LINE_WITHOUT_EQUALS\nVALID=1")).toEqual({ VALID: "1" });
  });
});

describe("loadEnvFile (Bot-Sales)", () => {
  const tmpFile = join(tmpdir(), `test-core-env-${Date.now()}.env`);

  afterEach(() => {
    try {
      unlinkSync(tmpFile);
    } catch {
      // ignore
    }
  });

  test("nạp biến vào targetEnv mà không ghi đè biến đã có", () => {
    writeFileSync(tmpFile, "CRM_BASE_URL=https://devcrm.example.com/crmapi\nCRM_USERNAME=from_file\nCRM_NEW=123");
    const mockEnv: Record<string, string | undefined> = { CRM_USERNAME: "already_present" };

    const res = loadEnvFile(tmpFile, mockEnv);
    expect(res.ok).toBe(true);
    expect(res.loadedCount).toBe(2);
    expect(mockEnv.CRM_USERNAME).toBe("already_present");
    expect(mockEnv.CRM_BASE_URL).toBe("https://devcrm.example.com/crmapi");
    expect(mockEnv.CRM_NEW).toBe("123");
  });

  test("trả { ok:false, error } khi file không tồn tại mà không crash", () => {
    const mockEnv: Record<string, string | undefined> = {};
    const res = loadEnvFile("/duong/dan/khong/ton/tai/crm.env", mockEnv);
    expect(res.ok).toBe(false);
    expect(res.loadedCount).toBe(0);
    expect(typeof res.error).toBe("string");
  });
});

// ── CM API: parseEnvFile / loadEnvDefaults (process env luôn thắng) ──────────
function writeEnvFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "core-env-defaults-"));
  const path = join(dir, ".env");
  writeFileSync(path, contents, "utf-8");
  return path;
}

describe("parseEnvFile (CM)", () => {
  it("đọc KEY=VALUE, bỏ comment/dòng trống/`export`, kiểm tra tên key hợp lệ", () => {
    const parsed = parseEnvFile(
      [
        "# comment",
        "",
        "export CM_ENV=production",
        "CM_DB_PATH=/tmp/bot.db",
        "  CM_LOG_LEVEL = warn  ",
        "not a pair",
        "9INVALID=x",
        "CM_ADMIN_IDS=1,2,3 # trailing comment",
        'CM_DASHBOARD_URL="https://example.vn"',
        "CM_EMPTY=",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      CM_ENV: "production",
      CM_DB_PATH: "/tmp/bot.db",
      CM_LOG_LEVEL: "warn",
      CM_ADMIN_IDS: "1,2,3",
      CM_DASHBOARD_URL: "https://example.vn",
      CM_EMPTY: "",
    });
  });
});

describe("loadEnvDefaults — process env luôn thắng file .env (CM)", () => {
  it("giữ giá trị của tiến trình khi .env trỏ DB production (sự cố i5b)", () => {
    const envFile = writeEnvFile("CM_DB_PATH=/home/bot/cm/data/bot.db\n");
    const env: Record<string, string | undefined> = { CM_DB_PATH: "/home/user/data/p2-test.db" };

    const result = loadEnvDefaults(envFile, env, { prefix: "CM_" });

    expect(env.CM_DB_PATH).toBe("/home/user/data/p2-test.db");
    expect(result.applied).toEqual([]);
    expect(result.kept).toEqual(["CM_DB_PATH"]);
  });

  it("coi giá trị rỗng là 'đã có' — khoá thật trong .env không lọt vào", () => {
    const envFile = writeEnvFile("CM_ITSAPLAN_API_KEY=itp_real_secret\nCM_TELEGRAM_BOT_TOKEN=123:real\n");
    const env: Record<string, string | undefined> = { CM_ITSAPLAN_API_KEY: "", CM_TELEGRAM_BOT_TOKEN: "" };

    loadEnvDefaults(envFile, env, { prefix: "CM_" });

    expect(env.CM_ITSAPLAN_API_KEY).toBe("");
    expect(env.CM_TELEGRAM_BOT_TOKEN).toBe("");
  });

  it("bổ sung key còn thiếu, bỏ qua key không có tiền tố khi prefix đặt", () => {
    const envFile = writeEnvFile("CM_LOG_LEVEL=warn\nCM_WORKER_PORT=3110\nPATH=/evil\n");
    const env: Record<string, string | undefined> = { CM_ENV: "test" };

    const result = loadEnvDefaults(envFile, env, { prefix: "CM_" });

    expect(env).toEqual({ CM_ENV: "test", CM_LOG_LEVEL: "warn", CM_WORKER_PORT: "3110" });
    expect(result.applied).toEqual(["CM_LOG_LEVEL", "CM_WORKER_PORT"]);
  });

  it("idempotent: chạy lần hai không đổi gì", () => {
    const envFile = writeEnvFile("CM_DB_PATH=/home/bot/bot.db\nCM_LOG_LEVEL=warn\n");
    const env: Record<string, string | undefined> = { CM_DB_PATH: "/tmp/t.db" };

    loadEnvDefaults(envFile, env, { prefix: "CM_" });
    const second = loadEnvDefaults(envFile, env, { prefix: "CM_" });

    expect(env.CM_DB_PATH).toBe("/tmp/t.db");
    expect(second.applied).toEqual([]);
    expect(second.kept).toEqual(["CM_DB_PATH", "CM_LOG_LEVEL"]);
  });

  it("file không tồn tại thì no-op, không ném lỗi", () => {
    const env: Record<string, string | undefined> = { CM_DB_PATH: "/tmp/t.db" };
    expect(loadEnvDefaults("/nonexistent/cm/.env", env, { prefix: "CM_" })).toEqual({
      file: "",
      fromProcess: ["CM_DB_PATH"],
      applied: [],
      kept: [],
    });
    expect(env.CM_DB_PATH).toBe("/tmp/t.db");
  });

  it("prefix mặc định rỗng → mọi key được xét (hành vi trung lập của lõi)", () => {
    const envFile = writeEnvFile("FOO=1\nBAR=2\n");
    const env: Record<string, string | undefined> = { BAR: "keep" };
    const result = loadEnvDefaults(envFile, env);
    expect(env).toEqual({ BAR: "keep", FOO: "1" });
    expect(result.applied).toEqual(["FOO"]);
    expect(result.kept).toEqual(["BAR"]);
  });
});
