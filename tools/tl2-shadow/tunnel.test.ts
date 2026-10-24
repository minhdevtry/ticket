import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanTmp, tmpDir } from "./fixtures.ts";
import {
  type Runner,
  forwardSpecs,
  missingForwards,
  parseProbe,
  probeScript,
  saveTokenFile,
  tunnelConfig,
  tunnelCycle,
} from "./tunnel.ts";

afterEach(cleanTmp);
const cfg = tunnelConfig({ TL2_SHADOW_DIR: "/tmp/x" });

describe("tunnel", () => {
  it("script thăm dò nhắc đúng các cổng -R và đường dẫn token", () => {
    const s = probeScript(cfg);
    expect(s).toContain("18999 18998");
    expect(s).toContain(cfg.remoteTokenPath);
  });

  it("parseProbe đọc cổng mở và token", () => {
    const p = parseProbe("OPEN 18999\nTOKEN abc123\nrác\n");
    expect([...p.remoteListening]).toEqual([18999]);
    expect(p.token).toBe("abc123");
    expect(parseProbe("").token).toBeNull();
  });

  it("missingForwards chỉ trả forward còn thiếu", () => {
    expect(forwardSpecs(cfg)).toHaveLength(3);
    const all = missingForwards(cfg, { remoteListening: new Set(), token: null }, false);
    expect(all.map((f) => f.flag)).toEqual(["-L", "-R", "-R"]);
    const some = missingForwards(cfg, { remoteListening: new Set([18999]), token: null }, true);
    expect(some).toEqual([{ flag: "-R", spec: "127.0.0.1:18998:127.0.0.1:18998" }]);
    expect(
      missingForwards(cfg, { remoteListening: new Set([18999, 18998]), token: null }, true),
    ).toEqual([]);
  });

  it("tunnelCycle: thêm forward thiếu, lưu token; ssh hỏng thì báo lỗi, không thêm gì", async () => {
    const ran: string[][] = [];
    const saved: string[] = [];
    const ok: Runner = {
      async run(args) {
        ran.push(args);
        return args.includes("bash")
          ? { code: 0, out: "OPEN 18999\nTOKEN tok\n", err: "" }
          : { code: 0, out: "", err: "" };
      },
      localListening: async () => false,
    };
    const s = await tunnelCycle(cfg, ok, (t) => saved.push(t));
    expect(s.error).toBeNull();
    expect(s.added).toHaveLength(2); // -L gateway và -R itsaplan
    expect(saved).toEqual(["tok"]);
    expect(ran.filter((a) => a.includes("-O")).map((a) => a[3])).toEqual([
      "127.0.0.1:18796:127.0.0.1:18796",
      "127.0.0.1:18998:127.0.0.1:18998",
    ]);

    const down: Runner = {
      run: async () => ({ code: 255, out: "", err: "connection closed" }),
      localListening: async () => false,
    };
    const d = await tunnelCycle(cfg, down, () => {});
    expect(d.up).toBe(false);
    expect(d.error).toContain("lỗi");
  });

  it("saveTokenFile ghi 0600 và không ghi lại khi không đổi", () => {
    const p = join(tmpDir(), "d", "gateway.token");
    const save = saveTokenFile(p);
    save("abc");
    expect(readFileSync(p, "utf8").trim()).toBe("abc");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    save("def");
    expect(readFileSync(p, "utf8").trim()).toBe("def");
  });
});
