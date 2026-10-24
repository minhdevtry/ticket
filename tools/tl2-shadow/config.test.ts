import { describe, expect, it } from "bun:test";
import { ConfigError, intEnv, parseEnvFile, relayConfig } from "./config.ts";

const TOKEN = "t".repeat(16);

describe("config", () => {
  it("parseEnvFile: bỏ comment, nháy, export", () => {
    expect(parseEnvFile("# c\nA=1\nexport B=\"hai ba\"\nC='x'\n\nbad line\nD=a=b")).toEqual({
      A: "1",
      B: "hai ba",
      C: "x",
      D: "a=b",
    });
  });

  it("H4: mặc định chỉ nghe loopback, không cần token", () => {
    const c = relayConfig({ HOME: "/home/user" });
    expect(c.host).toBe("127.0.0.1");
    expect(c.allowFrom).toEqual([]);
    expect(c.port).toBe(3106);
    expect(c.dir).toBe("/home/user/.local/share/tl2-shadow");
    expect(c.retentionMs).toBe(7 * 86_400_000);
    expect(c.backlogMaxAgeMs).toBe(24 * 3_600_000);
  });

  it("H4: không nhận 0.0.0.0, ::, hostname hay chuỗi rỗng-sai", () => {
    for (const bad of ["0.0.0.0", "::", "localhost", "relay.example.com", "10.0.0"]) {
      expect(() => relayConfig({ SHADOW_BIND: bad, SHADOW_RELAY_TOKEN: TOKEN })).toThrow(
        ConfigError,
      );
    }
  });

  it("H4: bind ngoài loopback bắt buộc token đủ dài và danh sách IP được phép", () => {
    const lan = { SHADOW_BIND: "10.0.0.2", SHADOW_ALLOW_FROM: "10.0.0.5" };
    expect(() => relayConfig(lan)).toThrow(/SHADOW_RELAY_TOKEN/);
    expect(() => relayConfig({ ...lan, SHADOW_RELAY_TOKEN: "ngan" })).toThrow(/SHADOW_RELAY_TOKEN/);
    expect(() => relayConfig({ SHADOW_BIND: "10.0.0.2", SHADOW_RELAY_TOKEN: TOKEN })).toThrow(
      /SHADOW_ALLOW_FROM/,
    );
    const c = relayConfig({
      ...lan,
      SHADOW_RELAY_TOKEN: TOKEN,
      SHADOW_ALLOW_FROM: "10.0.0.5, 10.0.0.6",
    });
    expect(c).toMatchObject({
      host: "10.0.0.2",
      allowFrom: ["10.0.0.5", "10.0.0.6"],
      token: TOKEN,
    });
  });

  it("M7: số sai dừng khởi động thay vì thành NaN", () => {
    expect(() => relayConfig({ SHADOW_PORT: "abc" })).toThrow(/SHADOW_PORT/);
    expect(() => relayConfig({ TL2_CONCURRENCY: "0" })).toThrow(/TL2_CONCURRENCY/);
    expect(() => intEnv({ X: "1.5" }, "X", 1)).toThrow(/X/);
    expect(() => intEnv({ X: "70000" }, "X", 1, 1, 65535)).toThrow(/X/);
    expect(intEnv({}, "X", 7)).toBe(7);
  });

  it("gateway chỉ được là loopback (đi qua tunnel)", () => {
    expect(() => relayConfig({ TL2_GATEWAY_URL: "http://10.0.0.9:18796" })).toThrow(
      /TL2_GATEWAY_URL/,
    );
    expect(() => relayConfig({ TL2_GATEWAY_URL: "https://127.0.0.1:18796" })).toThrow(
      /TL2_GATEWAY_URL/,
    );
    expect(relayConfig({ TL2_GATEWAY_URL: "http://127.0.0.1:1234/" }).gatewayUrl).toBe(
      "http://127.0.0.1:1234",
    );
  });
});
