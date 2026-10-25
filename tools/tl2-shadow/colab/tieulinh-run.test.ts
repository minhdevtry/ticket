import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanTmp, tmpDir } from "../fixtures.ts";
import { PROXY_INJECTS_KEY, buildEnv, readPid } from "./tieulinh-run.ts";

afterEach(cleanTmp);

const base = {
  home: "/var/lib/tl2/tieulinh",
  model: "MiniMax-M3.1-Flash",
  port: 3120,
  healthPort: 3121,
  minimaxPort: 18999,
  itsaplanPort: 18998,
  project: "TECH2",
  agent: "tieulinh2",
  team: "tech",
  sandboxChat: "-1000000000001",
};

describe("buildEnv", () => {
  it("trỏ vào proxy loopback, chỉ nghe loopback, kho nằm dưới home", () => {
    const e = buildEnv(base);
    expect(e.ITSAPLAN_BASE_URL).toBe("http://127.0.0.1:18998");
    expect(e.LLM_BASE_URL).toBe("http://127.0.0.1:18999");
    expect(e.BOT_WEBHOOK_HOST).toBe("127.0.0.1");
    expect(e.BOT_HEALTH_HOST).toBe("127.0.0.1");
    expect(e.BOT_DATA_DIR).toBe("/var/lib/tl2/tieulinh/data");
    expect(e.BOT_WEBHOOK_PORT).toBe("3120");
    expect(e.TIEULINH_PROJECT).toBe("TECH2");
    expect(e.TIEULINH_SANDBOX_CHAT).toBe("-1000000000001");
    expect(buildEnv({ ...base, sandboxChat: "" }).TIEULINH_SANDBOX_CHAT).toBeUndefined();
  });

  it("không có secret thật và không có token Telegram hay secret webhook", () => {
    const e = buildEnv(base);
    expect(e.ITSAPLAN_AGENT_KEY).toBe(PROXY_INJECTS_KEY);
    expect(e.LLM_API_KEY).toBe(PROXY_INJECTS_KEY);
    for (const k of Object.keys(e))
      expect(k).not.toMatch(/TELEGRAM|WEBHOOK_SECRET|WEBHOOK_KEY|AUTO_REGISTER/);
  });
});

describe("readPid", () => {
  it("null khi không có file, file rác hoặc tiến trình đã chết; số khi còn sống", () => {
    const d = tmpDir();
    expect(readPid(join(d, "khong-co.pid"))).toBeNull();
    writeFileSync(join(d, "rac.pid"), "abc");
    expect(readPid(join(d, "rac.pid"))).toBeNull();
    writeFileSync(join(d, "chet.pid"), "999999999");
    expect(readPid(join(d, "chet.pid"))).toBeNull();
    writeFileSync(join(d, "song.pid"), String(process.pid));
    expect(readPid(join(d, "song.pid"))).toBe(process.pid);
  });
});
