#!/usr/bin/env bun
/**
 * Chạy TRÊN Colab (do deploy/colab/cup-openclaw.sh gọi qua ssh). Idempotent:
 *  1. đồng bộ workspace của agent từ skills trong bản phát hành (tieulinh + _shared/skills)
 *  2. giữ/sinh token gateway ngẫu nhiên (0600, chỉ nằm trên Colab)
 *  3. dựng openclaw.json không có secret
 *  4. khởi động lại gateway nếu cấu hình hoặc bản phát hành đổi (hoặc gateway không sống)
 *  5. thăm dò sức khoẻ
 *
 *   bun run bootstrap.ts --release <dir> [--home <dir>] [--api anthropic-messages|openai-completions]
 *                        [--model <id>] [--project <key>] [--no-start]
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { type ApiStyle, renderConfig } from "./render-config.ts";

/** Chỉ những thứ repo là nguồn sự thật (giống apps/tieulinh/openclaw/sync-workspace.ts). */
const OWNED = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "TOOLS.md",
  "USER.md",
  "bot.json",
  "skills",
  "references",
];

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  if (!statSync(root).isDirectory()) return [""];
  const out: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...filesUnder(join(root, e.name)).map((f) => join(e.name, f)));
    else out.push(e.name);
  }
  return out;
}

function copyTree(src: string, dst: string): number {
  let n = 0;
  for (const rel of filesUnder(src)) {
    const from = rel ? join(src, rel) : src;
    const to = rel ? join(dst, rel) : dst;
    if (existsSync(to) && readFileSync(from).equals(readFileSync(to))) continue;
    mkdirSync(join(to, ".."), { recursive: true });
    copyFileSync(from, to);
    n++;
  }
  return n;
}

/**
 * Chép skill vào workspace. Thư mục `skills` và `references` được thay hẳn (xoá file đã bỏ khỏi
 * repo) nhưng file chạy của workspace (media/, messages/, state) không đụng tới.
 * `_shared/skills/*` được gộp vào `skills/`; skill riêng của bot thắng nếu trùng tên.
 */
export function syncWorkspace(skillsRoot: string, workspace: string): number {
  mkdirSync(workspace, { recursive: true });
  const bot = join(skillsRoot, "tieulinh");
  for (const dir of ["skills", "references"])
    rmSync(join(workspace, dir), { recursive: true, force: true });
  let copied = 0;
  const sharedSkills = join(skillsRoot, "_shared", "skills");
  if (existsSync(sharedSkills)) {
    for (const name of readdirSync(sharedSkills)) {
      copied += copyTree(join(sharedSkills, name), join(workspace, "skills", name));
    }
  }
  for (const owned of OWNED) {
    const src = join(bot, owned);
    if (existsSync(src)) copied += copyTree(src, join(workspace, owned));
  }
  return copied;
}

export function ensureToken(path: string): string {
  if (existsSync(path)) {
    const t = readFileSync(path, "utf8").trim();
    if (t) {
      chmodSync(path, 0o600);
      return t;
    }
  }
  const token = randomBytes(24).toString("hex");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

function argValue(args: string[], name: string, def: string): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : def;
}

async function healthy(port: number, token: string): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function readPid(pidFile: string): number | null {
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (!pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function stopGateway(pidFile: string): Promise<void> {
  const pid = readPid(pidFile);
  if (!pid) return;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(500);
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
  }
  process.kill(pid, "SIGKILL");
}

async function main() {
  const args = process.argv.slice(2);
  const releaseDir = resolve(argValue(args, "--release", ""));
  if (
    !args.includes("--release") ||
    !existsSync(join(releaseDir, "apps/tieulinh/skills/tieulinh"))
  ) {
    throw new Error("Cần --release <thư mục bản phát hành> chứa apps/tieulinh/skills/tieulinh");
  }
  const home = resolve(argValue(args, "--home", join(process.env.HOME ?? "/root", "tl2", "home")));
  const api = argValue(args, "--api", "anthropic-messages") as ApiStyle;
  const gatewayPort = Number(argValue(args, "--gateway-port", "18796"));
  const nodeDir = process.env.TL2_NODE_DIR ?? "/opt/node24/bin";
  const ocBin = process.env.TL2_OPENCLAW_BIN ?? "/opt/oc/bin/openclaw";
  for (const [label, p] of [
    ["node 24", join(nodeDir, "node")],
    ["openclaw", ocBin],
  ] as const) {
    if (!existsSync(p)) throw new Error(`Không thấy ${label} tại ${p}`);
  }

  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const workspace = join(home, "workspace-ticket-intake-2");
  const copied = syncWorkspace(join(releaseDir, "apps/tieulinh/skills"), workspace);
  console.log(`workspace: chép ${copied} file`);

  const token = ensureToken(join(home, "gateway.token"));
  const config = renderConfig({
    home,
    workspace,
    releaseDir,
    gatewayPort,
    gatewayToken: token,
    minimaxPort: Number(argValue(args, "--minimax-port", "18999")),
    itsaplanPort: Number(argValue(args, "--itsaplan-port", "18998")),
    model: argValue(args, "--model", "MiniMax-M3.1-Flash"),
    api,
    projectKey: argValue(args, "--project", "TECH2"),
  });
  const configText = `${JSON.stringify(config, null, 2)}\n`;
  const configPath = join(home, "openclaw.json");
  const stamp = createHash("sha256").update(configText).digest("hex");
  const stampPath = join(home, ".applied");
  const previous = existsSync(stampPath) ? readFileSync(stampPath, "utf8").trim() : "";
  writeFileSync(configPath, configText, { mode: 0o600 });
  chmodSync(configPath, 0o600);

  if (args.includes("--no-start")) {
    console.log("config đã ghi, --no-start nên không động tới gateway");
    return;
  }

  const pidFile = join(home, "gateway.pid");
  const alive = readPid(pidFile) !== null && (await healthy(gatewayPort, token));
  if (alive && previous === stamp) {
    console.log(`gateway: không đổi, đang chạy tốt (cổng ${gatewayPort})`);
    return;
  }

  await stopGateway(pidFile);
  const out = join(home, "gateway.out");
  const cmd =
    `echo $$ > '${pidFile}'; exec '${ocBin}' gateway run --port ${gatewayPort} --bind loopback ` +
    `>> '${out}' 2>&1`;
  Bun.spawn(["setsid", "-f", "bash", "-c", cmd], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      PATH: `${nodeDir}:${process.env.PATH ?? ""}`,
      OPENCLAW_STATE_DIR: home,
      OPENCLAW_CONFIG_PATH: configPath,
    },
  });
  console.log("gateway: đã khởi động, chờ sẵn sàng...");
  for (let i = 0; i < 90; i++) {
    await Bun.sleep(2000);
    if (await healthy(gatewayPort, token)) {
      writeFileSync(stampPath, `${stamp}\n`);
      console.log(
        `gateway: sẵn sàng sau ~${(i + 1) * 2}s (cổng ${gatewayPort}, token ở ${home}/gateway.token)`,
      );
      return;
    }
  }
  throw new Error(`gateway không sẵn sàng sau 180s; xem ${out}`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`bootstrap lỗi: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
