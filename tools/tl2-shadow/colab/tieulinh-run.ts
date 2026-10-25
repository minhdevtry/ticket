#!/usr/bin/env bun
/**
 * Chạy TRÊN Colab (do deploy/colab/cup-tieulinh.sh gọi qua ssh): chạy `apps/tieulinh` (agent
 * `tieulinh2`, dự án TECH2) làm tiến trình nền. Idempotent:
 *  1. dựng env KHÔNG có secret: itsaplan và LLM trỏ vào hai cổng loopback của proxy trên dev
 *     (`ssh -R`), khoá thật do proxy gắn; chỉ kênh nhật ký (không có `TELEGRAM_BOT_TOKEN`);
 *     server webhook chỉ nghe loopback (relay trên dev kiểm chữ ký rồi chuyển tiếp qua `ssh -L`)
 *  2. khởi động lại nếu bản phát hành hoặc env đổi, hoặc tiến trình không sống
 *  3. thăm dò `/healthz` tới khi `ok`
 *
 *   bun run tieulinh-run.ts --release <dir> [--home <dir>] [--model <id>] [--port 3120]
 *                           [--health-port 3121] [--project TECH2] [--agent tieulinh2]
 *                           [--no-start] | stop | status
 *
 * Dữ liệu (`BOT_DATA_DIR`, nhật ký kênh, kho SQLite) nằm ở `<home>/data`: tạm thời theo VM Colab
 * (mất khi Colab bị thu hồi), đủ cho môi trường thử.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Giá trị giả điền vào biến bắt buộc của bot; proxy trên dev gỡ nó và gắn khoá thật. */
export const PROXY_INJECTS_KEY = "proxy-injects-the-real-key";

export interface RunOpts {
  home: string;
  model: string;
  /** Cổng server webhook của app (loopback). */
  port: number;
  healthPort: number;
  minimaxPort: number;
  itsaplanPort: number;
  project: string;
  agent: string;
  team: string;
}

/** Env của app: tuyệt đối không có secret thật và không có token Telegram. */
export function buildEnv(o: RunOpts): Record<string, string> {
  return {
    ITSAPLAN_BASE_URL: `http://127.0.0.1:${o.itsaplanPort}`,
    ITSAPLAN_AGENT_KEY: PROXY_INJECTS_KEY,
    LLM_BASE_URL: `http://127.0.0.1:${o.minimaxPort}`,
    LLM_API_KEY: PROXY_INJECTS_KEY,
    LLM_MODEL: o.model,
    LLM_API: "anthropic-messages",
    BOT_DATA_DIR: join(o.home, "data"),
    BOT_WEBHOOK_PORT: String(o.port),
    BOT_WEBHOOK_HOST: "127.0.0.1",
    BOT_HEALTH_PORT: String(o.healthPort),
    BOT_HEALTH_HOST: "127.0.0.1",
    TIEULINH_TEAM: o.team,
    TIEULINH_PROJECT: o.project,
    TIEULINH_AGENT: o.agent,
  };
}

function argValue(args: string[], name: string, def: string): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : def;
}

export function readPid(pidFile: string): number | null {
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (!pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function health(port: number): Promise<{ ok: boolean; body: any }> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    return { ok: r.ok, body: await r.json().catch(() => null) };
  } catch {
    return { ok: false, body: null };
  }
}

async function stopApp(pidFile: string): Promise<boolean> {
  const pid = readPid(pidFile);
  if (!pid) return false;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(500);
    if (readPid(pidFile) === null) {
      rmSync(pidFile, { force: true });
      return true;
    }
  }
  process.kill(pid, "SIGKILL");
  rmSync(pidFile, { force: true });
  return true;
}

function opts(args: string[]): RunOpts {
  return {
    home: resolve(argValue(args, "--home", join(process.env.HOME ?? "/root", "tl2", "tieulinh"))),
    model: argValue(args, "--model", "MiniMax-M3.1-Flash"),
    port: Number(argValue(args, "--port", "3120")),
    healthPort: Number(argValue(args, "--health-port", "3121")),
    minimaxPort: Number(argValue(args, "--minimax-port", "18999")),
    itsaplanPort: Number(argValue(args, "--itsaplan-port", "18998")),
    project: argValue(args, "--project", "TECH2"),
    agent: argValue(args, "--agent", "tieulinh2"),
    team: argValue(args, "--team", "tech"),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const o = opts(args);
  mkdirSync(o.home, { recursive: true, mode: 0o700 });
  chmodSync(o.home, 0o700);
  const pidFile = join(o.home, "tieulinh.pid");

  if (args[0] === "stop") {
    console.log((await stopApp(pidFile)) ? "tieulinh: đã dừng" : "tieulinh: không chạy");
    return;
  }
  if (args[0] === "status") {
    const h = await health(o.healthPort);
    console.log(
      `tieulinh: ${readPid(pidFile) ? "chạy" : "dừng"}; health ${h.ok ? "ok" : "không ổn"} ${JSON.stringify(h.body)}`,
    );
    process.exit(h.ok ? 0 : 1);
  }

  const releaseDir = resolve(argValue(args, "--release", ""));
  if (!args.includes("--release") || !existsSync(join(releaseDir, "apps/tieulinh/main.ts"))) {
    throw new Error("Cần --release <thư mục bản phát hành> chứa apps/tieulinh/main.ts");
  }
  mkdirSync(join(o.home, "data"), { recursive: true, mode: 0o700 });
  chmodSync(join(o.home, "data"), 0o700);

  const env = buildEnv(o);
  const stamp = createHash("sha256")
    .update(`${releaseDir}\n${JSON.stringify(env)}`)
    .digest("hex");
  const stampPath = join(o.home, ".applied");
  const previous = existsSync(stampPath) ? readFileSync(stampPath, "utf8").trim() : "";
  if (args.includes("--no-start")) {
    console.log("env đã dựng, --no-start nên không động tới tiến trình");
    return;
  }

  const running = readPid(pidFile) !== null && (await health(o.healthPort)).ok;
  if (running && previous === stamp) {
    console.log(`tieulinh: không đổi, đang chạy tốt (webhook :${o.port}, health :${o.healthPort})`);
    return;
  }

  await stopApp(pidFile);
  const out = join(o.home, "tieulinh.out");
  const cmd = `echo $$ > '${pidFile}'; cd '${releaseDir}' && exec bun run apps/tieulinh/main.ts >> '${out}' 2>&1`;
  Bun.spawn(["setsid", "-f", "bash", "-c", cmd], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    // Env sạch: không kế thừa biến nào khác của phiên ssh.
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/root",
      ...env,
    },
  });
  console.log("tieulinh: đã khởi động, chờ sẵn sàng...");
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(1500);
    const h = await health(o.healthPort);
    if (h.ok && h.body?.status === "ok") {
      writeFileSync(stampPath, `${stamp}\n`, { mode: 0o600 });
      console.log(
        `tieulinh: sẵn sàng sau ~${Math.round((i + 1) * 1.5)}s (webhook :${o.port}, health :${o.healthPort})`,
      );
      return;
    }
  }
  throw new Error(`tieulinh không sẵn sàng sau 60s; xem ${out}`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`tieulinh-run lỗi: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
