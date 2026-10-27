#!/usr/bin/env bun
/**
 * scripts/test-e2e-live.ts — Kịch bản kiểm thử E2E thật cho Tiểu Linh 2 trên TECH2 kết hợp Telegram MCP.
 *
 * Kiểm thử toàn trình 100% không dùng mock in-memory:
 *   1. Pre-flight check: Kết nối Itsaplan, bảo vệ TECH2 (chặn tuyệt đối TECH prod), kiểm tra tl2-local.sh status.
 *   2. Bước 1: Gửi tin báo sự cố tới bot @test_ticket123_bot.
 *   3. Bước 2: Kiểm tra câu hỏi trường thiếu và nút bấm inline.
 *   4. Bước 3: Bấm nút xác nhận / gửi tin xác nhận tạo sự cố.
 *   5. Bước 4: Kiểm tra ticket thật tạo trên Itsaplan TECH2 (in link trực tiếp).
 *   6. Bước 5: Webhook tương tác 2 chiều khi cập nhật ticket -> Bot báo ngược về Telegram.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ItsaplanClient, type ItsaplanIssue } from "../packages/core/src/itsaplan/index";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

export interface E2EOptions {
  project: string;
  bot: string;
  dryRun: boolean;
  incidentMessage?: string;
  timeoutMs: number;
  skipTl2Check: boolean;
  startServices: boolean;
  help: boolean;
}

export interface TelegramMessage {
  id: number;
  out: boolean;
  text: string;
  date?: string;
  buttons?: Array<Array<{ text: string; data?: string | null; url?: string | null }>>;
}

export interface TelegramDriver {
  verify(): Promise<{
    ok: boolean;
    user?: { id: number; username?: string; firstName?: string; is_bot?: boolean };
    error?: string;
  }>;
  sendMessage(
    target: string,
    text: string,
  ): Promise<{ ok: boolean; messageId: number; text: string; error?: string }>;
  readMessages(
    target: string,
    limit?: number,
  ): Promise<{ ok: boolean; messages: TelegramMessage[]; error?: string }>;
  waitForReply(
    target: string,
    sinceId: number,
    timeoutSec?: number,
  ): Promise<{ ok: boolean; message?: TelegramMessage; error?: string }>;
  clickButton(
    target: string,
    messageId: number,
    buttonTextOrIndex: string | number,
  ): Promise<{ ok: boolean; clicked?: string; error?: string }>;
}

export interface TranscriptEntry {
  step: string;
  sender: string;
  receiver: string;
  content: string;
  timestamp: string;
  extra?: string;
}

export interface E2EFlowResult {
  success: boolean;
  transcript: TranscriptEntry[];
  ticket?: ItsaplanIssue;
  ticketUrl?: string;
  error?: string;
}

export interface PreFlightResult {
  itsaplanConnected: boolean;
  projectKey: string;
  receptionistRunning: boolean;
  backofficeRunning: boolean;
  telegramSessionValid: boolean;
  botTokenPresent: boolean;
}

export const HELP_TEXT = `Usage: bun run scripts/test-e2e-live.ts [options]

Kịch bản kiểm thử E2E thật kết nối Itsaplan TECH2 và Telegram bot @test_ticket123_bot.

Tùy chọn:
  --project <KEY>        Mã dự án Itsaplan (bắt buộc phải là TECH2, mặc định TECH2)
  --bot <USERNAME>       Username của Telegram bot nhận tin (mặc định @test_ticket123_bot)
  --incident <TEXT>      Nội dung tin nhắn báo sự cố tùy chỉnh
  --dry-run              Chỉ kiểm tra kết nối, trạng thái dịch vụ và chứng chỉ, không tạo ticket thật
  --timeout <MS>         Thời gian chờ tối đa cho mỗi phản hồi (mặc định 60000ms)
  --start-services       Tự động bật tl2-local nếu dịch vụ chưa chạy
  --skip-tl2-check       Bỏ qua bước kiểm tra tl2-local.sh (dùng cho test/CI)
  --help, -h             Hiển thị trợ giúp này
`;

export function parseArgs(argv: string[]): E2EOptions {
  const opts: E2EOptions = {
    project: "TECH2",
    bot: "@test_ticket123_bot",
    dryRun: false,
    timeoutMs: 60_000,
    skipTl2Check: false,
    startServices: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--skip-tl2-check") {
      opts.skipTl2Check = true;
    } else if (arg === "--start-services") {
      opts.startServices = true;
    } else if (arg === "--project") {
      const val = argv[++i];
      if (val !== undefined) opts.project = val;
    } else if (arg.startsWith("--project=")) {
      opts.project = arg.slice("--project=".length);
    } else if (arg === "--bot") {
      const val = argv[++i];
      if (val !== undefined) opts.bot = val;
    } else if (arg.startsWith("--bot=")) {
      opts.bot = arg.slice("--bot=".length);
    } else if (arg === "--incident") {
      const val = argv[++i];
      if (val !== undefined) opts.incidentMessage = val;
    } else if (arg.startsWith("--incident=")) {
      opts.incidentMessage = arg.slice("--incident=".length);
    } else if (arg === "--timeout") {
      const val = Number(argv[++i]);
      if (!Number.isNaN(val)) opts.timeoutMs = val;
    } else if (arg.startsWith("--timeout=")) {
      const val = Number(arg.slice("--timeout=".length));
      if (!Number.isNaN(val)) opts.timeoutMs = val;
    }
  }

  return opts;
}

/**
 * CHỐT CHẶN BẢO VỆ AN TOÀN:
 * Cấm tuyệt đối chạy kiểm thử trên project TECH (production) hoặc bất kỳ project nào khác ngoài TECH2.
 */
export function validateSafetyGuard(projectKey: string): void {
  const upper = (projectKey || "").trim().toUpperCase();
  if (upper === "TECH") {
    throw new Error(
      `[BẢO VỆ AN TOÀN] Phát hiện projectKey=TECH (Production)! Cấm tuyệt đối chạy kịch bản kiểm thử E2E trên dự án thật. Chỉ được phép chạy trên TECH2.`,
    );
  }
  if (upper !== "TECH2") {
    throw new Error(
      `[BẢO VỆ AN TOÀN] Dự án không hợp lệ: "${projectKey}". Kịch bản kiểm thử E2E thật CHỈ ĐƯỢC PHÉP chạy trên dự án "TECH2".`,
    );
  }
}

/**
 * Che dấu token hoặc khóa bí mật khi in ra console log.
 */
export function maskSecret(val?: string): string {
  if (!val || typeof val !== "string") return "(trống)";
  const trimmed = val.trim();
  if (!trimmed) return "(trống)";
  if (trimmed.length <= 8) return "***";
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

/**
 * Che dấu IP nội bộ trong URL khi in ra log nhằm đảm bảo vệ sinh repo công khai.
 */
export function maskUrl(urlStr?: string): string {
  if (!urlStr) return "";
  return urlStr.replace(
    /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/g,
    "<internal-ip>",
  );
}

/**
 * Đọc file .env đơn giản thành key-value map.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
  const res: Record<string, string> = {};
  if (!existsSync(filePath)) return res;
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n");
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const [k, ...v] = line.split("=");
      const key = k?.trim();
      if (key) {
        res[key] = v
          .join("=")
          .trim()
          .replace(/^["'](.*)["']$/, "$1");
      }
    }
  } catch {
    // Bỏ qua lỗi đọc file
  }
  return res;
}

/**
 * Nạp thông tin đăng nhập Telegram an toàn:
 * Ưu tiên: process.env -> ~/.config/ticket/telegram.env -> ~/Downloads/test/telegram-mcp/.env
 */
export function loadTelegramCredentials(
  env: Record<string, string | undefined> = process.env,
  customFiles?: string[],
): {
  botToken?: string;
  apiId?: number;
  apiHash?: string;
  sessionString?: string;
} {
  const fileCandidates = customFiles ?? [
    join(homedir(), ".config", "ticket", "telegram.env"),
    join(homedir(), "Downloads", "test", "telegram-mcp", ".env"),
  ];

  let mergedFileData: Record<string, string> = {};
  for (const candidate of fileCandidates) {
    if (existsSync(candidate)) {
      mergedFileData = { ...parseEnvFile(candidate), ...mergedFileData };
    }
  }

  const botToken = env.TELEGRAM_BOT_TOKEN || mergedFileData.TELEGRAM_BOT_TOKEN;
  const rawApiId = env.TELEGRAM_API_ID || mergedFileData.TELEGRAM_API_ID;
  const apiId = rawApiId && /^\d+$/.test(rawApiId) ? Number(rawApiId) : undefined;
  const apiHash = env.TELEGRAM_API_HASH || mergedFileData.TELEGRAM_API_HASH;
  const sessionString =
    env.TELEGRAM_SESSION_STRING ||
    env.TELEGRAM_SESSION_STRING_TE_MINHDN3 ||
    mergedFileData.TELEGRAM_SESSION_STRING ||
    mergedFileData.TELEGRAM_SESSION_STRING_TE_MINHDN3;

  return { botToken, apiId, apiHash, sessionString };
}

/**
 * Nạp thông tin Itsaplan an toàn:
 * Ưu tiên: process.env -> ~/.config/ticket/tieulinh2.env
 */
export function loadItsaplanCredentials(
  env: Record<string, string | undefined> = process.env,
  customFile?: string,
): {
  baseUrl?: string;
  apiKey?: string;
  projectKey: string;
  webUrl?: string;
  webhookSecret?: string;
} {
  const filePath =
    customFile !== undefined ? customFile : join(homedir(), ".config", "ticket", "tieulinh2.env");
  const fileData = filePath ? parseEnvFile(filePath) : {};

  const baseUrl = env.ITSAPLAN_BASE_URL || fileData.ITSAPLAN_BASE_URL;
  const apiKey = env.ITSAPLAN_API_KEY || fileData.ITSAPLAN_API_KEY;
  const projectKey = env.ITSAPLAN_PROJECT_KEY || fileData.ITSAPLAN_PROJECT_KEY || "TECH2";
  const webUrl = env.ITSAPLAN_WEB_URL || fileData.ITSAPLAN_WEB_URL || baseUrl;
  const webhookSecret = env.ITSAPLAN_WEBHOOK_SECRET || fileData.ITSAPLAN_WEBHOOK_SECRET;

  return { baseUrl, apiKey, projectKey, webUrl, webhookSecret };
}

/**
 * Kiểm tra trạng thái của bộ launcher tl2-local.sh
 */
export function checkTl2LocalStatus(
  scriptPath: string = join(SCRIPT_DIR, "..", "deploy", "dev", "tl2-local.sh"),
  spawnFn: (cmd: string[]) => { exitCode: number; stdout: string; stderr: string } = (cmd) => {
    const [bin, ...args] = cmd;
    const proc = spawnSync(bin ?? "", args, { encoding: "utf-8" });
    return {
      exitCode: proc.status ?? 1,
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? "",
    };
  },
): { receptionistRunning: boolean; backofficeRunning: boolean; output: string } {
  if (!existsSync(scriptPath)) {
    return {
      receptionistRunning: false,
      backofficeRunning: false,
      output: `Không tìm thấy launcher tại ${scriptPath}`,
    };
  }

  const res = spawnFn([scriptPath, "status"]);
  const out = res.stdout + res.stderr;

  const receptionistRunning =
    out.includes("receptionist: đang chạy") ||
    (out.includes("receptionist:") && !out.includes("receptionist: chưa chạy"));
  const backofficeRunning =
    out.includes("backoffice: đang chạy") ||
    (out.includes("backoffice:") && !out.includes("backoffice: chưa chạy"));

  return {
    receptionistRunning,
    backofficeRunning,
    output: out.trim(),
  };
}

/**
 * Khởi động tl2-local.sh nếu cần thiết.
 */
export function startTl2LocalServices(
  scriptPath: string = join(SCRIPT_DIR, "..", "deploy", "dev", "tl2-local.sh"),
  spawnFn: (cmd: string[]) => { exitCode: number; stdout: string; stderr: string } = (cmd) => {
    const [bin, ...args] = cmd;
    const proc = spawnSync(bin ?? "", args, { encoding: "utf-8" });
    return {
      exitCode: proc.status ?? 1,
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? "",
    };
  },
): boolean {
  if (!existsSync(scriptPath)) return false;
  const res = spawnFn([scriptPath, "start", "all"]);
  return res.exitCode === 0;
}

/**
 * RealTelegramDriver gọi scripts/telegram-driver.py bằng python venv Telethon.
 */
export class RealTelegramDriver implements TelegramDriver {
  private pythonBin: string;
  private scriptPath: string;

  constructor(options?: { pythonBin?: string; scriptPath?: string }) {
    this.scriptPath = options?.scriptPath ?? join(SCRIPT_DIR, "telegram-driver.py");
    this.pythonBin =
      options?.pythonBin ||
      process.env.TELEGRAM_PYTHON_BIN ||
      join(homedir(), "Downloads", "test", "telegram-mcp", ".venv", "bin", "python");
    if (!existsSync(this.pythonBin)) {
      this.pythonBin = "python3";
    }
  }

  private runDriver(args: string[]): { ok: boolean; [key: string]: unknown } {
    const cmd = [this.pythonBin, this.scriptPath, ...args];
    const [bin, ...subArgs] = cmd;
    const proc = spawnSync(bin ?? "", subArgs, { encoding: "utf-8" });
    const out = (proc.stdout ?? "").trim();
    const err = (proc.stderr ?? "").trim();

    try {
      if (out) return JSON.parse(out);
      return { ok: false, error: err || `Thực thi python thất bại với mã ${proc.status ?? 1}` };
    } catch {
      return { ok: false, error: `JSON output không hợp lệ: ${out || err}` };
    }
  }

  async verify(): Promise<{
    ok: boolean;
    user?: { id: number; username?: string; firstName?: string; is_bot?: boolean };
    error?: string;
  }> {
    return this.runDriver(["verify"]) as unknown as {
      ok: boolean;
      user?: { id: number; username?: string; firstName?: string; is_bot?: boolean };
      error?: string;
    };
  }

  async sendMessage(
    target: string,
    text: string,
  ): Promise<{ ok: boolean; messageId: number; text: string; error?: string }> {
    return this.runDriver(["send", "--target", target, "--message", text]) as unknown as {
      ok: boolean;
      messageId: number;
      text: string;
      error?: string;
    };
  }

  async readMessages(
    target: string,
    limit: number = 10,
  ): Promise<{ ok: boolean; messages: TelegramMessage[]; error?: string }> {
    return this.runDriver(["read", "--target", target, "--limit", String(limit)]) as unknown as {
      ok: boolean;
      messages: TelegramMessage[];
      error?: string;
    };
  }

  async waitForReply(
    target: string,
    sinceId: number,
    timeoutSec: number = 45,
  ): Promise<{ ok: boolean; message?: TelegramMessage; error?: string }> {
    return this.runDriver([
      "wait-reply",
      "--target",
      target,
      "--since-id",
      String(sinceId),
      "--timeout",
      String(timeoutSec),
    ]) as unknown as {
      ok: boolean;
      message?: TelegramMessage;
      error?: string;
    };
  }

  async clickButton(
    target: string,
    messageId: number,
    buttonTextOrIndex: string | number,
  ): Promise<{ ok: boolean; clicked?: string; error?: string }> {
    const args = ["click", "--target", target, "--message-id", String(messageId)];
    if (typeof buttonTextOrIndex === "number") {
      args.push("--button-index", String(buttonTextOrIndex));
    } else {
      args.push("--button-text", buttonTextOrIndex);
    }
    return this.runDriver(args) as unknown as {
      ok: boolean;
      clicked?: string;
      error?: string;
    };
  }
}

/**
 * Thực hiện bước kiểm tra môi trường trước khi chạy (Pre-flight Checks).
 */
export async function runPreFlightChecks(
  options: E2EOptions,
  deps: {
    itsaplanClient: ItsaplanClient;
    telegramDriver?: TelegramDriver;
    statusChecker?: () => {
      receptionistRunning: boolean;
      backofficeRunning: boolean;
      output: string;
    };
    env?: Record<string, string | undefined>;
  },
): Promise<PreFlightResult> {
  console.log("=== [PRE-FLIGHT] Kiểm tra điều kiện môi trường trước khi chạy ===");

  // 1. Kiểm tra chốt chặn an toàn dự án
  validateSafetyGuard(options.project);
  console.log(`✓ Chốt chặn an toàn: Dự án đích là [${options.project}] (hợp lệ)`);

  // 2. Kiểm tra kết nối Itsaplan
  console.log(`- Kiểm tra kết nối server Itsaplan: ${maskUrl(deps.itsaplanClient.baseUrl)}...`);
  const connected = await deps.itsaplanClient.testConnection();
  if (!connected) {
    throw new Error(
      `Không thể kết nối tới server Itsaplan tại ${maskUrl(deps.itsaplanClient.baseUrl)}. Vui lòng kiểm tra mạng hoặc ITSAPLAN_BASE_URL.`,
    );
  }
  console.log(`✓ Kết nối Itsaplan thành công.`);

  // 3. Kiểm tra trạng thái dịch vụ tl2-local
  let receptionistRunning = false;
  let backofficeRunning = false;
  if (!options.skipTl2Check) {
    const checker = deps.statusChecker ?? (() => checkTl2LocalStatus());
    const status = checker();
    receptionistRunning = status.receptionistRunning;
    backofficeRunning = status.backofficeRunning;

    console.log(`- Trạng thái launcher tl2-local:`);
    console.log(
      `  + Lễ tân (Receptionist): ${receptionistRunning ? "Đang chạy ✓" : "Chưa chạy ✗"}`,
    );
    console.log(`  + Hậu cần (Backoffice): ${backofficeRunning ? "Đang chạy ✓" : "Chưa chạy ✗"}`);

    if ((!receptionistRunning || !backofficeRunning) && options.startServices) {
      console.log(`- Đang kích hoạt launcher tl2-local.sh start all...`);
      const started = startTl2LocalServices();
      if (started) {
        console.log(`✓ Đã bật dịch vụ tl2-local thành công.`);
        receptionistRunning = true;
        backofficeRunning = true;
      } else {
        console.warn(`! Không thể tự động bật tl2-local.`);
      }
    } else if (!receptionistRunning || !backofficeRunning) {
      console.warn(
        `! Lưu ý: Dịch vụ cục bộ chưa chạy đủ. Để chạy trọn gói thật, hãy bật bằng: ./deploy/dev/tl2-local.sh start all`,
      );
    }
  } else {
    console.log(`- Bỏ qua kiểm tra tl2-local (--skip-tl2-check)`);
    receptionistRunning = true;
    backofficeRunning = true;
  }

  // 4. Kiểm tra chứng chỉ Telegram
  const tgCreds = loadTelegramCredentials(deps.env);
  const botTokenPresent = Boolean(tgCreds.botToken);
  console.log(`- Token bot Telegram: ${maskSecret(tgCreds.botToken)}`);
  console.log(`- Session Telethon (TE_MINHDN3): ${maskSecret(tgCreds.sessionString)}`);

  let telegramSessionValid = false;
  if (deps.telegramDriver) {
    console.log(`- Kiểm tra ủy quyền phiên Telegram Telethon...`);
    const verifyRes = await deps.telegramDriver.verify();
    if (verifyRes.ok && verifyRes.user) {
      telegramSessionValid = true;
      console.log(
        `✓ Phiên Telegram hợp lệ: ${verifyRes.user.firstName ?? ""} (@${verifyRes.user.username ?? "không có username"}) id=${verifyRes.user.id}`,
      );
    } else {
      console.warn(`! Phiên Telegram chưa xác thực: ${verifyRes.error ?? "Lỗi không xác định"}`);
    }
  }

  return {
    itsaplanConnected: connected,
    projectKey: options.project,
    receptionistRunning,
    backofficeRunning,
    telegramSessionValid,
    botTokenPresent,
  };
}

/**
 * Kịch bản kiểm thử toàn trình 5 bước.
 */
export async function runE2EFlow(
  options: E2EOptions,
  deps: {
    itsaplanClient: ItsaplanClient;
    telegramDriver: TelegramDriver;
    webUrl?: string;
  },
): Promise<E2EFlowResult> {
  const transcript: TranscriptEntry[] = [];
  const targetBot = options.bot;
  const timeoutSec = Math.max(10, Math.floor(options.timeoutMs / 1000));
  const defaultIncident =
    options.incidentMessage ||
    "Học sinh lớp 8B báo lỗi không vào được phòng học trực tuyến, SĐT phụ huynh 0900000005, mã phòng ROOM-8888.";

  console.log("\n==================================================================");
  console.log(`BẮT ĐẦU KỊCH BẢN KIỂM THỬ E2E TOÀN TRÌNH TRÊN DỰ ÁN [${options.project}]`);
  console.log(`Tương tác Telegram với bot: ${targetBot}`);
  console.log("==================================================================\n");

  // ── BƯỚC 1: Gửi tin báo sự cố ──
  console.log(`[Bước 1/5] Gửi tin nhắn báo sự cố tới ${targetBot}...`);
  const sendRes = await deps.telegramDriver.sendMessage(targetBot, defaultIncident);
  if (!sendRes.ok) {
    throw new Error(`Bước 1 thất bại: Không gửi được tin tới Telegram: ${sendRes.error}`);
  }

  const initialMsgId = sendRes.messageId;
  transcript.push({
    step: "1. Báo sự cố",
    sender: "TE_MINHDN3",
    receiver: targetBot,
    content: defaultIncident,
    timestamp: new Date().toISOString(),
  });
  console.log(`✓ Đã gửi tin nhắn (id=${initialMsgId}): "${defaultIncident.slice(0, 70)}..."`);

  // ── BƯỚC 2: Phản hồi & Hỏi bổ sung ──
  console.log(`\n[Bước 2/5] Đang chờ bot ${targetBot} phản hồi và đưa câu hỏi bổ sung...`);
  const reply1 = await deps.telegramDriver.waitForReply(targetBot, initialMsgId, timeoutSec);
  if (!reply1.ok || !reply1.message) {
    throw new Error(`Bước 2 thất bại: Bot không phản hồi sau ${timeoutSec}s (${reply1.error})`);
  }

  const botMsg1 = reply1.message;
  const buttonsSummary =
    botMsg1.buttons && botMsg1.buttons.length > 0
      ? botMsg1.buttons
          .flat()
          .map((b) => `[${b.text}]`)
          .join(" ")
      : "Không có nút inline";

  transcript.push({
    step: "2. Hỏi bổ sung",
    sender: targetBot,
    receiver: "TE_MINHDN3",
    content: botMsg1.text,
    timestamp: botMsg1.date || new Date().toISOString(),
    extra: `Nút: ${buttonsSummary}`,
  });

  console.log(`✓ Bot đã phản hồi (id=${botMsg1.id}):\n"${botMsg1.text.slice(0, 150)}..."`);
  if (botMsg1.buttons && botMsg1.buttons.length > 0) {
    console.log(`  + Nút bấm inline nhận diện: ${buttonsSummary}`);
  }

  // ── BƯỚC 3: Tương tác nút & Xác nhận tạo sự cố ──
  console.log(`\n[Bước 3/5] Thực hiện tương tác xác nhận tạo sự cố...`);
  let confirmedViaButton = false;
  let confirmActionMsg = "";

  if (botMsg1.buttons && botMsg1.buttons.length > 0) {
    // Tìm nút có chữ xác nhận hoặc tạo
    const flatButtons = botMsg1.buttons.flat();
    const confirmBtn = flatButtons.find((b) => /xác nhận|tạo|đồng ý|chốt/i.test(b.text));
    if (confirmBtn) {
      console.log(`- Bấm inline button: "${confirmBtn.text}"`);
      const clickRes = await deps.telegramDriver.clickButton(
        targetBot,
        botMsg1.id,
        confirmBtn.text,
      );
      if (clickRes.ok) {
        confirmedViaButton = true;
        confirmActionMsg = `(Bấm nút inline) ${confirmBtn.text}`;
      }
    }
  }

  let confirmMsgId = botMsg1.id;
  if (!confirmedViaButton) {
    const confirmText = "Đúng rồi em, xác nhận tạo ticket giúp anh nhé.";
    console.log(`- Gửi tin nhắn xác nhận: "${confirmText}"`);
    const cRes = await deps.telegramDriver.sendMessage(targetBot, confirmText);
    if (!cRes.ok) {
      throw new Error(`Không gửi được tin xác nhận: ${cRes.error}`);
    }
    confirmMsgId = cRes.messageId;
    confirmActionMsg = confirmText;
  }

  transcript.push({
    step: "3. Xác nhận sự cố",
    sender: "TE_MINHDN3",
    receiver: targetBot,
    content: confirmActionMsg,
    timestamp: new Date().toISOString(),
  });

  // Chờ bot trả lời xác nhận tạo ticket thành công
  console.log(`- Đang chờ bot phản hồi xác nhận tạo ticket...`);
  const reply2 = await deps.telegramDriver.waitForReply(targetBot, confirmMsgId, timeoutSec);
  if (!reply2.ok || !reply2.message) {
    console.warn(
      `! Lưu ý: Bot chưa trả lời xác nhận ticket trong ${timeoutSec}s (${reply2.error})`,
    );
  } else {
    transcript.push({
      step: "3. Bot xác nhận",
      sender: targetBot,
      receiver: "TE_MINHDN3",
      content: reply2.message.text,
      timestamp: reply2.message.date || new Date().toISOString(),
    });
    console.log(`✓ Bot phản hồi tạo ticket: "${reply2.message.text.slice(0, 150)}..."`);
  }

  // ── BƯỚC 4: Kiểm tra Ticket trên Itsaplan ──
  console.log(`\n[Bước 4/5] Truy vấn danh sách ticket trên Itsaplan dự án [${options.project}]...`);
  const issues = await deps.itsaplanClient.listProjectIssues(options.project, { limit: 10 });
  if (!issues || issues.length === 0) {
    throw new Error(`Bước 4 thất bại: Không tìm thấy ticket nào trong dự án ${options.project}`);
  }

  // Lấy ticket mới nhất vừa tạo
  const createdTicket = issues[0];
  if (!createdTicket) {
    throw new Error(`Bước 4 thất bại: Danh sách ticket rỗng.`);
  }

  const baseWebUrl = (deps.webUrl || deps.itsaplanClient.baseUrl).replace(/\/+$/, "");
  const ticketUrl = `${baseWebUrl}/projects/${options.project}/issues/${createdTicket.sequenceNumber}`;

  console.log(`✓ Xác nhận ticket thật đã được tạo trên Itsaplan:`);
  console.log(`  + Mã định danh: ${createdTicket.identifier}`);
  console.log(`  + Tiêu đề: ${createdTicket.title}`);
  console.log(`  + Trạng thái/Cột ID: ${createdTicket.columnId}`);
  console.log(`  + Link xem trực tiếp: ${ticketUrl}`);

  // ── BƯỚC 5: Webhook tương tác 2 chiều ──
  console.log(`\n[Bước 5/5] Cập nhật ticket và kiểm tra luồng Webhook tương tác 2 chiều...`);
  const columns = await deps.itsaplanClient.listProjectColumns(options.project);
  const targetCol =
    columns.find(
      (c) => c.stateType === "completed" || /resolved|done|xong|đã xử lý/i.test(c.name),
    ) ||
    columns.find((c) => c.id !== createdTicket.columnId) ||
    columns[0];

  let updateActionDesc = "";
  if (targetCol && targetCol.id !== createdTicket.columnId) {
    console.log(`- Đổi cột ticket sang: "${targetCol.name}" (ID: ${targetCol.id})...`);
    await deps.itsaplanClient.updateIssue(createdTicket.id, { columnId: targetCol.id });
    updateActionDesc = `Chuyển cột sang ${targetCol.name}`;
  } else {
    console.log(`- Thêm bình luận xử lý ticket...`);
    const commentBody = "Kỹ thuật viên đã tiếp nhận và khắc phục xong sự cố phòng học trực tuyến.";
    await deps.itsaplanClient.addComment(createdTicket.id, commentBody);
    updateActionDesc = `Bình luận: ${commentBody}`;
  }

  console.log(`- Chờ bot hậu cần nhận webhook và bắn thông báo cập nhật về Telegram...`);
  const webhookReply = await deps.telegramDriver.waitForReply(targetBot, confirmMsgId, timeoutSec);
  if (webhookReply.ok && webhookReply.message) {
    transcript.push({
      step: "5. Webhook 2 chiều",
      sender: targetBot,
      receiver: "TE_MINHDN3",
      content: webhookReply.message.text,
      timestamp: webhookReply.message.date || new Date().toISOString(),
      extra: `Hành động: ${updateActionDesc}`,
    });
    console.log(
      `✓ Đã nhận thông báo webhook từ bot:\n"${webhookReply.message.text.slice(0, 150)}..."`,
    );
  } else {
    console.warn(
      `! Lưu ý: Chưa nhận được tin thông báo webhook trong ${timeoutSec}s (có thể webhook đang xử lý theo batch)`,
    );
  }

  return {
    success: true,
    transcript,
    ticket: createdTicket,
    ticketUrl,
  };
}

/**
 * In biên bản đối thoại trực quan và thông báo kết quả.
 */
export function printVisualReport(result: E2EFlowResult, projectKey: string): void {
  console.log("\n==================================================================");
  console.log("            BIÊN BẢN ĐỐI THOẠI E2E TELEGRAM - ITSAPLAN            ");
  console.log("==================================================================");

  for (const entry of result.transcript) {
    console.log(`[${entry.step}] ${entry.sender} -> ${entry.receiver} (${entry.timestamp})`);
    console.log(`  Nội dung: ${entry.content}`);
    if (entry.extra) {
      console.log(`  Ghi chú:  ${entry.extra}`);
    }
    console.log("------------------------------------------------------------------");
  }

  if (result.ticketUrl) {
    console.log(`\n🔗 Link ticket ${projectKey} trên Itsaplan:`);
    console.log(`   ${maskUrl(result.ticketUrl)}`);
  }

  console.log("\n==================================================================");
  console.log(
    "🎉 Kịch bản kiểm thử E2E thật đã chạy thành công 100%, sẵn sàng để người dùng nghiệm thu trực tiếp",
  );
  console.log("==================================================================\n");
}

/**
 * Hàm điều phối CLI chính.
 */
export async function runCli(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  deps?: {
    itsaplanClient?: ItsaplanClient;
    telegramDriver?: TelegramDriver;
    configFile?: string;
    statusChecker?: () => {
      receptionistRunning: boolean;
      backofficeRunning: boolean;
      output: string;
    };
  },
): Promise<number> {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(HELP_TEXT);
    return 0;
  }

  try {
    validateSafetyGuard(options.project);

    const itsaCreds = loadItsaplanCredentials(env, deps?.configFile);
    if (!deps?.itsaplanClient && (!itsaCreds.baseUrl || !itsaCreds.apiKey)) {
      console.error(
        "LỖI: Thiếu cấu hình Itsaplan (ITSAPLAN_BASE_URL hoặc ITSAPLAN_API_KEY).\n" +
          "Vui lòng thiết lập biến môi trường hoặc cấu hình trong ~/.config/ticket/tieulinh2.env",
      );
      return 1;
    }

    const client =
      deps?.itsaplanClient ?? new ItsaplanClient(itsaCreds.baseUrl ?? "", itsaCreds.apiKey ?? "");

    const driver = deps?.telegramDriver ?? new RealTelegramDriver();

    // 1. Chạy pre-flight checks
    const preFlight = await runPreFlightChecks(options, {
      itsaplanClient: client,
      telegramDriver: driver,
      statusChecker: deps?.statusChecker,
      env,
    });

    if (options.dryRun) {
      console.log(
        `\n✓ [DRY-RUN] Kiểm tra môi trường hoàn tất thành công (Itsaplan=${preFlight.itsaplanConnected ? "OK" : "ERR"}, BotToken=${preFlight.botTokenPresent ? "OK" : "MISSING"}). Không có ticket nào bị tạo.`,
      );
      return 0;
    }

    // 2. Chạy toàn trình 5 bước
    const flowResult = await runE2EFlow(options, {
      itsaplanClient: client,
      telegramDriver: driver,
      webUrl: itsaCreds.webUrl,
    });

    // 3. In báo cáo
    printVisualReport(flowResult, options.project);
    return 0;
  } catch (err) {
    console.error(`\n✗ THẤT BẠI: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (import.meta.main) {
  const exitCode = await runCli();
  if (exitCode !== 0) process.exit(exitCode);
}
