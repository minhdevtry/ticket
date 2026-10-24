#!/usr/bin/env bun
/**
 * Giữ các tunnel giữa máy dev và Colab trên ControlMaster ssh có sẵn (host mặc định `colab2`):
 *
 *   -L 127.0.0.1:18796  gateway OpenClaw của Tiểu Linh 2 (Colab) -> dev
 *   -R 127.0.0.1:18999  proxy MiniMax (dev) -> Colab
 *   -R 127.0.0.1:18998  proxy itsaplan (dev) -> Colab
 *
 * Mỗi vòng (mặc định 20 giây): chạy `ssh <host> <script thăm dò>` (vừa giữ master sống, vừa giữ
 * Colab không bị coi là rảnh), đọc cổng nào đã mở phía Colab và token gateway, rồi `ssh -O forward`
 * những cổng còn thiếu. Token gateway lưu 0600 vào thư mục dữ liệu để relay dùng.
 * Khi nhận SIGTERM thì gỡ các forward đã thêm (`ssh -O cancel`).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadLocalEnv, dataDir } from "./config.ts";
import { ensurePrivateDir } from "./queue.ts";

export interface TunnelConfig {
  host: string;
  gatewayPort: number;
  minimaxPort: number;
  itsaplanPort: number;
  /** Đường dẫn file token trên Colab (shell trên Colab sẽ mở rộng $HOME). */
  remoteTokenPath: string;
  intervalMs: number;
  tokenPath: string;
}

export function tunnelConfig(env: Record<string, string | undefined> = process.env): TunnelConfig {
  const dir = dataDir(env);
  return {
    host: env.TL2_COLAB_HOST || "colab2",
    gatewayPort: Number(env.TL2_GATEWAY_PORT || 18796),
    minimaxPort: Number(env.TL2_MINIMAX_PORT || 18999),
    itsaplanPort: Number(env.TL2_ITSAPLAN_PORT || 18998),
    remoteTokenPath: env.TL2_REMOTE_TOKEN_PATH || "$HOME/tl2/home/gateway.token",
    intervalMs: Number(env.TL2_TUNNEL_INTERVAL_MS || 20_000),
    tokenPath: env.TL2_GATEWAY_TOKEN_FILE || join(dir, "gateway.token"),
  };
}

export interface Probe {
  /** Cổng loopback đang lắng nghe phía Colab (các cổng -R). */
  remoteListening: Set<number>;
  token: string | null;
}

/** Script chạy trên Colab: in `OPEN <cổng>` cho mỗi cổng đang mở và `TOKEN <giá trị>`. */
export function probeScript(c: TunnelConfig): string {
  const ports = [c.minimaxPort, c.itsaplanPort].join(" ");
  return [
    `for p in ${ports}; do (echo >/dev/tcp/127.0.0.1/$p) 2>/dev/null && echo "OPEN $p"; done`,
    `[ -r "${c.remoteTokenPath}" ] && echo "TOKEN $(cat "${c.remoteTokenPath}")"`,
    "true",
  ].join("; ");
}

export function parseProbe(output: string): Probe {
  const remoteListening = new Set<number>();
  let token: string | null = null;
  for (const line of output.split("\n")) {
    const open = line.match(/^OPEN (\d+)$/);
    if (open) remoteListening.add(Number(open[1]));
    const tok = line.match(/^TOKEN (\S+)$/);
    if (tok) token = tok[1];
  }
  return { remoteListening, token };
}

export interface ForwardSpec {
  /** Tham số cho `ssh -O forward|cancel`. */
  flag: "-L" | "-R";
  spec: string;
}

export function forwardSpecs(c: TunnelConfig): ForwardSpec[] {
  const lo = (p: number) => `127.0.0.1:${p}:127.0.0.1:${p}`;
  return [
    { flag: "-L", spec: lo(c.gatewayPort) },
    { flag: "-R", spec: lo(c.minimaxPort) },
    { flag: "-R", spec: lo(c.itsaplanPort) },
  ];
}

/** Forward nào còn thiếu, dựa trên kết quả thăm dò. */
export function missingForwards(
  c: TunnelConfig,
  probe: Probe,
  localGatewayListening: boolean,
): ForwardSpec[] {
  const specs = forwardSpecs(c);
  return specs.filter((f) => {
    if (f.flag === "-L") return !localGatewayListening;
    const port = Number(f.spec.split(":")[1]);
    return !probe.remoteListening.has(port);
  });
}

export interface Runner {
  run(
    args: string[],
    opts?: { timeoutMs?: number; stdin?: string },
  ): Promise<{ code: number; out: string; err: string }>;
  localListening(port: number): Promise<boolean>;
}

export const sshRunner: Runner = {
  async run(args, opts = {}) {
    const { timeoutMs = 25_000, stdin } = opts;
    const proc = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", ...args], {
      stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { code, out, err };
  },
  async localListening(port) {
    try {
      const sock = await Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          data() {},
          open(s) {
            s.end();
          },
          error() {},
        },
      });
      sock.end();
      return true;
    } catch {
      return false;
    }
  },
};

export interface TunnelState {
  up: boolean;
  added: string[];
  error: string | null;
}

/** Một vòng giữ tunnel. Trả trạng thái để ghi log khi có thay đổi. */
export async function tunnelCycle(
  c: TunnelConfig,
  r: Runner,
  saveToken: (t: string) => void,
): Promise<TunnelState> {
  const probe = await r.run([c.host, "bash", "-s"], { stdin: probeScript(c) });
  if (probe.code !== 0) {
    return {
      up: false,
      added: [],
      error: `ssh ${c.host} lỗi (${probe.code}): ${probe.err.trim().slice(0, 160)}`,
    };
  }
  const parsed = parseProbe(probe.out);
  if (parsed.token) saveToken(parsed.token);
  const localUp = await r.localListening(c.gatewayPort);
  const added: string[] = [];
  for (const f of missingForwards(c, parsed, localUp)) {
    const res = await r.run(["-O", "forward", f.flag, f.spec, c.host]);
    if (res.code === 0) added.push(`${f.flag} ${f.spec}`);
    else
      return {
        up: true,
        added,
        error: `forward ${f.flag} ${f.spec}: ${res.err.trim().slice(0, 160)}`,
      };
  }
  return { up: true, added, error: null };
}

export function saveTokenFile(path: string) {
  return (token: string) => {
    if (existsSync(path) && readFileSync(path, "utf8").trim() === token) return;
    ensurePrivateDir(join(path, ".."));
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  };
}

export async function cancelForwards(c: TunnelConfig, r: Runner = sshRunner): Promise<void> {
  for (const f of forwardSpecs(c))
    await r.run(["-O", "cancel", f.flag, f.spec, c.host], { timeoutMs: 10_000 });
}

if (import.meta.main) {
  loadLocalEnv();
  const c = tunnelConfig();
  const log = (m: string) => console.log(`${new Date().toISOString()} [tunnel] ${m}`);
  const save = saveTokenFile(c.tokenPath);
  let last = "";
  let stopping = false;

  const loop = async () => {
    while (!stopping) {
      let line: string;
      try {
        const s = await tunnelCycle(c, sshRunner, save);
        line = s.error
          ? `lỗi: ${s.error}`
          : s.added.length
            ? `đã thêm ${s.added.join(", ")}`
            : "ổn";
      } catch (e) {
        line = `lỗi: ${(e as Error).message}`;
      }
      if (line !== last) log(line);
      last = line;
      await Bun.sleep(c.intervalMs);
    }
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      stopping = true;
      await cancelForwards(c).catch(() => {});
      log("đã gỡ forward, thoát");
      process.exit(0);
    });
  }
  log(
    `host=${c.host} gateway=:${c.gatewayPort} minimax=:${c.minimaxPort} itsaplan=:${c.itsaplanPort}`,
  );
  void loop();
}
