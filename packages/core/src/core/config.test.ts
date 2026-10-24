import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ConfigError, REDACTED, defineEnv, loadConfig, mergeEnv, secret } from "./config";

const schema = defineEnv({
  BASE_URL: z.url(),
  AGENT_KEY: z.string().min(8),
  PORT: z.coerce.number().int().default(3000),
  MODE: z.enum(["a", "b"]).default("a"),
  NOTE: z.string().optional(),
  ODD: secret(z.string().optional()),
});

describe("loadConfig", () => {
  it("parse đủ kiểu, áp default, đóng băng kết quả", () => {
    const cfg = loadConfig(schema, {
      env: { BASE_URL: "http://itsaplan.example.com", AGENT_KEY: "abcdefgh", PORT: "8080" },
    });
    expect(cfg.values.PORT).toBe(8080);
    expect(cfg.values.MODE).toBe("a");
    expect(cfg.values.NOTE).toBeUndefined();
    expect(Object.isFrozen(cfg.values)).toBe(true);
  });

  it("gom MỌI lỗi vào một ConfigError, không lộ giá trị", () => {
    let error: unknown;
    try {
      loadConfig(schema, {
        env: { BASE_URL: "không phải url", AGENT_KEY: "ngan", PORT: "abc", MODE: "z" },
        context: "bot-x",
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const err = error as ConfigError;
    expect(err.issues.map((i) => i.name).sort()).toEqual(["AGENT_KEY", "BASE_URL", "MODE", "PORT"]);
    expect(err.message).toContain("bot-x: cấu hình không hợp lệ (4 lỗi)");
    expect(err.message).toContain("BASE_URL");
    // giá trị secret không bao giờ nằm trong thông báo
    expect(err.message).not.toContain("ngan");
  });

  it("thiếu biến bắt buộc = missing; chuỗi rỗng coi như chưa đặt", () => {
    try {
      loadConfig(schema, { env: { BASE_URL: "", AGENT_KEY: "   " } });
      throw new Error("phải ném");
    } catch (e) {
      const err = e as ConfigError;
      expect(err.issues.every((i) => i.kind === "missing")).toBe(true);
      expect(err.message).toContain("chưa đặt");
    }
  });

  it("redacted ẩn secret theo secret() và theo tên biến", () => {
    const cfg = loadConfig(schema, {
      env: { BASE_URL: "http://itsaplan.example.com", AGENT_KEY: "abcdefgh", ODD: "x" },
    });
    expect(cfg.redacted.AGENT_KEY).toBe(REDACTED);
    expect(cfg.redacted.ODD).toBe(REDACTED);
    expect(cfg.redacted.BASE_URL).toBe("http://itsaplan.example.com");
    expect(JSON.stringify(cfg.redacted)).not.toContain("abcdefgh");
    // secret không đặt thì không bịa [REDACTED]
    const none = loadConfig(schema, {
      env: { BASE_URL: "http://itsaplan.example.com", AGENT_KEY: "abcdefgh" },
    });
    expect(none.redacted.ODD).toBeUndefined();
  });

  it("chỉ nạp .env khi truyền envFile; biến trong env thắng file; không ghi ngược env", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const file = join(dir, ".env");
    writeFileSync(file, "BASE_URL=http://from-file.example.com\nAGENT_KEY=filekey12\nPORT=1\n");
    const env: Record<string, string | undefined> = { PORT: "9" };

    const without = () => loadConfig(schema, { env });
    expect(without).toThrow(ConfigError); // không envFile → không đọc file

    const cfg = loadConfig(schema, { env, envFile: file });
    expect(cfg.values.BASE_URL).toBe("http://from-file.example.com");
    expect(cfg.values.PORT).toBe(9);
    expect(cfg.envFile.path).toBe(file);
    expect(cfg.envFile.applied.sort()).toEqual(["AGENT_KEY", "BASE_URL"]);
    expect(env.BASE_URL).toBeUndefined();
  });

  it("envFile không tồn tại thì bỏ qua", () => {
    const cfg = loadConfig(defineEnv({ A: z.string().default("x") }), {
      env: {},
      envFile: "/không/có/file/.env",
    });
    expect(cfg.values.A).toBe("x");
    expect(cfg.envFile.path).toBeNull();
  });

  it("mergeEnv gộp shape và secret", () => {
    const merged = mergeEnv(defineEnv({ A: z.string() }), defineEnv({ B_TOKEN: z.string() }));
    expect(Object.keys(merged.shape)).toEqual(["A", "B_TOKEN"]);
    expect(merged.secrets.has("B_TOKEN")).toBe(true);
  });
});
