import { describe, expect, it } from "bun:test";
import { ConfigError, parseEnvFile, relayConfig } from "./config.ts";

describe("config", () => {
  it("parseEnvFile: bỏ comment, nháy, export", () => {
    expect(parseEnvFile("# c\nA=1\nexport B=\"hai ba\"\nC='x'\n\nbad line\nD=a=b")).toEqual({
      A: "1",
      B: "hai ba",
      C: "x",
      D: "a=b",
    });
  });

  it("relayConfig dừng với thông báo rõ khi thiếu SHADOW_ALLOW_FROM", () => {
    expect(() => relayConfig({})).toThrow(ConfigError);
    expect(() => relayConfig({})).toThrow(/SHADOW_ALLOW_FROM/);
  });

  it("relayConfig: mặc định và kiểm tra số", () => {
    const c = relayConfig({ SHADOW_ALLOW_FROM: "10.0.0.5, 10.0.0.6", HOME: "/home/user" });
    expect(c.allowFrom).toEqual(["10.0.0.5", "10.0.0.6"]);
    expect(c.port).toBe(3106);
    expect(c.host).toBe("0.0.0.0");
    expect(c.dir).toBe("/home/user/.local/share/tl2-shadow");
    expect(c.retentionMs).toBe(7 * 86_400_000);
    expect(c.backlogMaxAgeMs).toBe(24 * 3_600_000);
    expect(relayConfig({ SHADOW_ALLOW_FROM: "" }).allowFrom).toEqual([]);
    expect(() => relayConfig({ SHADOW_ALLOW_FROM: "", SHADOW_PORT: "abc" })).toThrow(/SHADOW_PORT/);
  });
});
