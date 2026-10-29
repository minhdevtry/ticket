/**
 * Phân giải cấu hình LLM (model, baseUrl, apiKey, api) của một agent từ `openclaw.json`.
 *
 * Nguyên tắc: Bot không cấu hình nguồn LLM riêng lẻ. Mọi nhu cầu gọi LLM (trích xuất,
 * phân loại, tóm tắt) đều đọc từ khai báo model của agent đó trong OpenClaw
 * (`agents.list[id].model` hoặc `agents.entries[id].model`).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

export interface ResolvedAgentLlm {
  agentId: string;
  /** Tên model đã tách provider (vd: "deepseek-v4.1-flash", "MiniMax-M3.1-Flash", "gpt-4o-mini"). */
  model: string;
  /** Tên model nguyên bản có tiền tố provider (vd: "2tocom/MiniMax-M3.1-Flash"). */
  rawModel: string;
  provider: string;
  baseUrl: string | null;
  apiKey: string | null;
  api: "openai" | "anthropic-messages" | "openclaw";
  fallbacks: string[];
}

export interface OpenClawConfigWithModels {
  agents?: {
    defaults?: {
      model?: {
        primary?: string;
        fallbacks?: string[];
      };
    };
    list?: Array<{
      id?: string;
      model?: {
        primary?: string;
        fallbacks?: string[];
      };
    }>;
    entries?: Record<string, { model?: { primary?: string; fallbacks?: string[] } } | undefined>;
    [key: string]: unknown;
  };
  models?: {
    providers?: Record<
      string,
      {
        baseUrl?: string;
        apiKey?: string | { source?: string; provider?: string; id?: string };
        api?: string;
        [key: string]: unknown;
      } | undefined
    >;
  };
  secrets?: {
    providers?: Record<
      string,
      {
        source?: string;
        path?: string;
        mode?: string;
      } | undefined
    >;
  };
}

/**
 * Phân giải giá trị secret (chuỗi trực tiếp hoặc tham chiếu tới file secret).
 */
export function resolveSecretValue(
  value: unknown,
  config: OpenClawConfigWithModels,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (value && typeof value === "object") {
    const obj = value as { source?: string; provider?: string; id?: string };
    if (obj.source === "file" && obj.provider) {
      const providerDef = config.secrets?.providers?.[obj.provider];
      if (providerDef && typeof providerDef.path === "string") {
        const expandedPath = providerDef.path.replace(/^~(?=$|\/)/, homedir());
        try {
          if (existsSync(expandedPath)) {
            const content = readFile(expandedPath).trim();
            return content ? content : null;
          }
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Rút cấu hình LLM của một agent từ object `openclaw.json` ĐÃ PARSE.
 */
export function readAgentLlm(
  config: unknown,
  agentId: string,
  readFile?: (path: string) => string,
): ResolvedAgentLlm | null {
  if (!config || typeof config !== "object") return null;
  const cfg = config as OpenClawConfigWithModels;
  const agents = cfg.agents;
  if (!agents) return null;

  // 1. Tìm agent theo id
  let agentDef: { model?: { primary?: string; fallbacks?: string[] } } | undefined;
  if (Array.isArray(agents.list)) {
    agentDef = agents.list.find((a) => a?.id === agentId);
  } else if (agents.entries && typeof agents.entries === "object") {
    agentDef = agents.entries[agentId];
  } else if (agents[agentId] && typeof agents[agentId] === "object") {
    agentDef = agents[agentId] as { model?: { primary?: string; fallbacks?: string[] } };
  }

  // 2. Rút primary model và fallbacks
  let primaryModel = agentDef?.model?.primary || agents.defaults?.model?.primary;
  if (!primaryModel || typeof primaryModel !== "string") return null;
  primaryModel = primaryModel.trim();

  const fallbacks = (
    Array.isArray(agentDef?.model?.fallbacks)
      ? agentDef.model.fallbacks
      : Array.isArray(agents.defaults?.model?.fallbacks)
        ? agents.defaults.model.fallbacks
        : []
  ).filter((f): f is string => typeof f === "string" && Boolean(f.trim()));

  // 3. Phân tách provider và tên model
  let providerName: string | null = null;
  let modelName = primaryModel;
  if (primaryModel.includes("/")) {
    const slashIdx = primaryModel.indexOf("/");
    providerName = primaryModel.slice(0, slashIdx).trim();
    modelName = primaryModel.slice(slashIdx + 1).trim();
  }

  // 4. Tìm provider tương ứng trong models.providers
  const providers = cfg.models?.providers ?? {};
  let providerConfig = providerName ? providers[providerName] : undefined;

  // Nếu không chỉ định provider trong tên model, fallback về provider duy nhất hoặc default
  if (!providerConfig) {
    if (providerName && providers[providerName]) {
      providerConfig = providers[providerName];
    } else if (Object.keys(providers).length === 1) {
      providerName = Object.keys(providers)[0];
      providerConfig = providers[providerName];
    }
  }

  const rawApiKey = providerConfig?.apiKey;
  const apiKey = resolveSecretValue(rawApiKey, cfg, readFile);

  let apiType: "openai" | "anthropic-messages" | "openclaw" = "openai";
  const rawApi = String(providerConfig?.api ?? "").toLowerCase();
  if (rawApi.includes("anthropic")) {
    apiType = "anthropic-messages";
  } else if (rawApi.includes("openclaw")) {
    apiType = "openclaw";
  }

  return {
    agentId,
    model: modelName,
    rawModel: primaryModel,
    provider: providerName ?? "default",
    baseUrl: typeof providerConfig?.baseUrl === "string" ? providerConfig.baseUrl.trim() : null,
    apiKey,
    api: apiType,
    fallbacks,
  };
}

/**
 * Nạp `openclaw.json` từ file và rút cấu hình LLM của một agent.
 */
export function loadAgentLlm(
  configPath: string,
  agentId: string,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): ResolvedAgentLlm | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(configPath));
  } catch {
    return null;
  }
  return readAgentLlm(parsed, agentId, readFile);
}
