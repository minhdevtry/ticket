/**
 * `@vuihoc/bot-core/openclaw` — Adapter OpenClaw cho pack lễ tân.
 *
 * Cung cấp:
 * 1. `generateReceptionistOpenClawConfig`: sinh cấu hình openclaw.json chuẩn
 * 2. `syncReceptionistWorkspace`: đồng bộ skill pack vào workspace OpenClaw (idempotent qua planWorkspaceSync)
 * 3. `connectPendingButtons`: kết nối mảng nút qua file chờ Telegram
 * 4. Helper nút Telegram chuẩn: `getConfirmationButtons`, `getDepartmentButtons`, `getBranchButtons`
 * 5. `forwardSessionToIdentityTools`: chuyển tiếp session/chatId vào check_identity/register_identity
 * 6. `createForceNewTracker`: cầu nối cờ forceNew cho /new giữa webhook server và session
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BotDefinition } from "../bot/define";
import type { InlineButton } from "../intake/gate/types";
import { layoutButtons } from "../intake/gate/buttons";
import { exportSkillPack, type SkillPackOptions } from "../intake/mcp/skill-pack";
import type { ForceNewHandler } from "../itsaplan/webhook/server";
import { toTelegramButtons } from "../telegram/adapter";
import {
  planWorkspaceSync,
  summarizeSyncPlan,
  type SyncPlanEntry,
  type WorkspaceFile,
} from "./deploy";
import type { BeforeToolCallEvent, BeforeToolCallResult, PluginHookContext } from "./hook-types";
import {
  clearPendingButtons,
  normalizeTelegramId,
  readPendingButtons,
  savePendingButtons,
  type ButtonDropAlert,
  type PendingButtonsFile,
  type TelegramButton,
} from "./pending-buttons";

// ── 1. Sinh cấu hình openclaw.json ──────────────────────────────────────────

export interface ReceptionistOpenClawConfigOptions {
  agentId?: string;
  agentName?: string;
  agentRole?: string;
  model?: string;
  workspaceDir?: string;
  serverName?: string;
  mcpCommand?: {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  };
  pluginPaths?: {
    irisTuongTac?: string;
    xacNhanXong?: string;
  };
  customPlugins?: Array<{ id: string; path: string }>;
}

export function generateReceptionistOpenClawConfig(
  def: BotDefinition,
  options: ReceptionistOpenClawConfigOptions = {},
): Record<string, unknown> {
  const agentId = options.agentId ?? def.id;
  const agentName = options.agentName ?? (def.id === "tieulinh" ? "Tiểu Linh" : def.id);
  const serverName = options.serverName ?? `intake-${def.id}`;
  const workspace = options.workspaceDir ?? `workspaces/${agentId}`;
  const modelPrimary = options.model ?? "default";

  const mcpServerConfig = {
    command: options.mcpCommand?.command ?? "bun",
    args: options.mcpCommand?.args ?? ["run", "packages/core/src/intake/mcp/server.ts"],
    env: {
      ITSAPLAN_PROJECT_KEY: def.tracker.project,
      ...(options.mcpCommand?.env ?? {}),
    },
  };

  const irisPath =
    options.pluginPaths?.irisTuongTac ?? "apps/tieulinh-legacy/openclaw-plugin/iris-tuong-tac";
  const xnxPath =
    options.pluginPaths?.xacNhanXong ?? "apps/tieulinh-legacy/openclaw-plugin/xac-nhan-xong";

  const pluginPaths = [irisPath, xnxPath];
  if (options.customPlugins) {
    for (const p of options.customPlugins) {
      if (!pluginPaths.includes(p.path)) pluginPaths.push(p.path);
    }
  }

  const pluginEntries: Record<string, unknown> = {
    "iris-tuong-tac": { enabled: true, hooks: { allowConversationAccess: true } },
    "xac-nhan-xong": { enabled: true, hooks: { allowConversationAccess: true } },
  };
  if (options.customPlugins) {
    for (const p of options.customPlugins) {
      pluginEntries[p.id] = { enabled: true, hooks: { allowConversationAccess: true } };
    }
  }

  const agentEntry = {
    id: agentId,
    name: agentName,
    role:
      options.agentRole ??
      (def.id === "tieulinh" ? "Trợ lý tiếp nhận và xử lý sự cố kỹ thuật" : "Receptionist Agent"),
    workspace,
    model: { primary: modelPrimary },
    mcpServers: [serverName],
    skills: ["incident-intake", "check-status"],
  };

  return {
    mcpServers: {
      [serverName]: mcpServerConfig,
    },
    mcp: {
      servers: {
        [serverName]: mcpServerConfig,
      },
    },
    agents: {
      defaults: { model: { primary: modelPrimary } },
      entries: {
        [agentId]: agentEntry,
      },
      [agentId]: agentEntry,
    },
    plugins: {
      load: {
        paths: pluginPaths,
      },
      entries: pluginEntries,
    },
  };
}

// ── 2. Đồng bộ Workspace (exportSkillPack + planWorkspaceSync) ───────────────

export interface SyncWorkspaceOptions extends SkillPackOptions {
  dryRun?: boolean;
}
export interface SyncPlanSummary {
  create: number;
  update: number;
  unchanged: number;
}

export interface SyncWorkspaceResult {
  plan: SyncPlanEntry[];
  summary: SyncPlanSummary;
  targetDir: string;
}

export async function syncReceptionistWorkspace(
  def: BotDefinition,
  targetDir: string,
  options: SyncWorkspaceOptions = {},
): Promise<SyncWorkspaceResult> {
  const pack = exportSkillPack(def, options);
  const desired: WorkspaceFile[] = pack.files.map((f) => ({
    path: f.path,
    content: f.content,
  }));

  const current: Record<string, string | undefined> = {};
  for (const file of desired) {
    const fullPath = join(targetDir, file.path);
    if (existsSync(fullPath)) {
      current[file.path] = readFileSync(fullPath, "utf8");
    } else {
      current[file.path] = undefined;
    }
  }

  const plan = planWorkspaceSync(desired, current);
  const summary = summarizeSyncPlan(plan);

  if (!options.dryRun) {
    for (const entry of plan) {
      if (entry.action === "create" || entry.action === "update") {
        const fullPath = join(targetDir, entry.path);
        mkdirSync(dirname(fullPath), { recursive: true });
        const content = entry.content ?? desired.find((f) => f.path === entry.path)?.content ?? "";
        writeFileSync(fullPath, content, "utf8");
      }
    }
  }

  return { plan, summary, targetDir };
}

// ── 3. Cầu nối file nút chờ ──────────────────────────────────────────────────

export interface PendingButtonsAdapterOptions {
  dir: string;
  onDrop?: ButtonDropAlert;
}

export interface PendingButtonsConnector {
  readonly dir: string;
  save(
    chatId: string | number | null | undefined,
    buttons: (InlineButton | TelegramButton)[][] | null | undefined,
  ): number;
  read(chatId: string | number | null | undefined): PendingButtonsFile | null;
  clear(chatId: string | number | null | undefined): void;
  sink: {
    save(chatId: string, rows: (InlineButton | TelegramButton)[][]): void;
    clear(chatId: string): void;
  };
  handleStepResult(
    chatId: string | number | null | undefined,
    result: {
      action?: string;
      outcome?: string;
      messages?: Array<{ buttons?: (InlineButton | TelegramButton)[][] }>;
      buttons?: (InlineButton | TelegramButton)[][];
      buttonsShown?: boolean;
    },
  ): number;
}

function toTelegramButtonRows(rows: (InlineButton | TelegramButton)[][]): TelegramButton[][] {
  return rows.map((row) =>
    row.map((btn) => {
      if ("callback_data" in btn) {
        return btn as TelegramButton;
      }
      return {
        text: btn.text,
        callback_data: (btn as InlineButton).callbackData,
      };
    }),
  );
}

export function connectPendingButtons(
  options: PendingButtonsAdapterOptions,
): PendingButtonsConnector {
  const dir = options.dir;
  const onDrop = options.onDrop;

  const connector: PendingButtonsConnector = {
    dir,
    save(chatId, buttons) {
      if (!buttons || buttons.length === 0) {
        clearPendingButtons(chatId, { dir });
        return 0;
      }
      const telegramRows = toTelegramButtonRows(buttons);
      return savePendingButtons(chatId, telegramRows, { dir, onDrop });
    },
    read(chatId) {
      return readPendingButtons(chatId, { dir });
    },
    clear(chatId) {
      clearPendingButtons(chatId, { dir });
    },
    sink: {
      save(chatId, rows) {
        connector.save(chatId, rows);
      },
      clear(chatId) {
        connector.clear(chatId);
      },
    },
    handleStepResult(chatId, result) {
      if (result.action === "ticket_created" || result.outcome === "created") {
        connector.clear(chatId);
        return 0;
      }

      let buttons = result.buttons;
      if (!buttons && result.messages) {
        for (const m of result.messages) {
          if (m.buttons && m.buttons.length > 0) {
            buttons = m.buttons;
            break;
          }
        }
      }

      if (buttons && buttons.length > 0) {
        return connector.save(chatId, buttons);
      }

      connector.clear(chatId);
      return 0;
    },
  };

  return connector;
}

// ── 4. Helper nút Telegram ───────────────────────────────────────────────────

/**
 * Nút xác nhận ghi ticket. `callback_data` cố định "đúng rồi" — skill prompt
 * của cả hai bot đã coi đây là tín hiệu đồng ý, không đổi.
 */
export function getConfirmationButtons(label: string): TelegramButton[][] {
  return [[{ text: label, callback_data: "đúng rồi" }]];
}

/**
 * Nút chọn nhanh phòng ban. Xếp dạng 2 nút / hàng.
 */
export function getDepartmentButtons(
  options: Array<{ label: string; callbackData: string }>,
): TelegramButton[][] {
  const inline: InlineButton[] = options.map((o) => ({
    text: o.label,
    callbackData: o.callbackData,
  }));
  return toTelegramButtons(layoutButtons(inline));
}

/**
 * Danh sách 3 nút nhánh chuẩn cho IRIS.
 */
export function getBranchButtons(): TelegramButton[][] {
  return [
    [
      { text: "📦 Order tính năng", callback_data: "Order tính năng" },
      { text: "💡 Đề xuất ý tưởng mới", callback_data: "Đề xuất ý tưởng mới" },
    ],
    [{ text: "🔍 Kiểm tra trạng thái ticket", callback_data: "Kiểm tra trạng thái ticket" }],
  ];
}

// ── 5. Chuyển tiếp session/chatId vào identityTools ──────────────────────────

export function forwardSessionToIdentityTools(
  event: BeforeToolCallEvent,
  ctx: PluginHookContext,
): BeforeToolCallResult | undefined {
  const toolName = event.toolName;
  if (toolName === "check_identity" || toolName === "register_identity") {
    const params = { ...(event.params ?? {}) };
    if (!params.userId) {
      const resolved =
        ctx.chatId ??
        ctx.senderId ??
        ctx.channelContext?.chat?.id ??
        ctx.channelContext?.sender?.id;
      if (resolved !== undefined && resolved !== null && String(resolved).trim() !== "") {
        params.userId = String(resolved).trim();
        return { params };
      }
    }
  }
  return undefined;
}

// ── 6. Quản lý cờ forceNew cho /new ──────────────────────────────────────────

export interface ForceNewTracker {
  mark(chatId: string | number): void;
  consume(chatId: string | number): boolean;
  has(chatId: string | number): boolean;
  clear(chatId?: string | number): void;
  asHandler(): ForceNewHandler;
}

export function createForceNewTracker(): ForceNewTracker {
  const pending = new Set<string>();

  const norm = (id: string | number | null | undefined): string => {
    return normalizeTelegramId(id) ?? String(id ?? "").trim();
  };

  const tracker: ForceNewTracker = {
    mark(chatId) {
      const id = norm(chatId);
      if (id) pending.add(id);
    },
    consume(chatId) {
      const id = norm(chatId);
      if (!id) return false;
      const found = pending.has(id);
      if (found) pending.delete(id);
      return found;
    },
    has(chatId) {
      const id = norm(chatId);
      return id ? pending.has(id) : false;
    },
    clear(chatId) {
      if (chatId !== undefined) {
        const id = norm(chatId);
        if (id) pending.delete(id);
      } else {
        pending.clear();
      }
    },
    asHandler() {
      return ({ chatId }: { chatId: string }) => {
        tracker.mark(chatId);
      };
    },
  };

  return tracker;
}
