/**
 * Plugin OpenClaw MẪU — chứng minh `@vuihoc/bot-core/openclaw` dùng được từ một
 * plugin `.mjs` do gateway nạp. Hình dạng (manifest + default export có
 * `register(api)`) chép từ `teacheragent/cm/openclaw-plugin/cm-support`.
 *
 * Plugin ký `_identity` cho mỗi tool call thuộc đúng agent của nó, dùng helper
 * của kit. KHÔNG phải plugin production — chỉ đủ để tải và bundle thật.
 *
 * Import kit qua subpath export `@vuihoc/bot-core/openclaw`. ADR
 * `docs/adr/0002-*` ghi vì sao bản .mjs chạy trên gateway phải là BUNDLE vendored
 * (gateway nạp .mjs bằng đường dẫn, không chạy qua resolver của bot).
 */
import {
  isAgentInScope,
  issueIdentityToken,
  parseAllowedAgentIds,
} from "@vuihoc/bot-core/openclaw";

const IDENTITY_PARAM = "_identity";

export default {
  id: "openclaw-plugin-demo",
  name: "Demo — bot-core openclaw kit",
  description: "Ký _identity bằng helper của @vuihoc/bot-core/openclaw. Plugin mẫu, không phải production.",
  register(api) {
    const allowedAgentIds = parseAllowedAgentIds(process.env.DEMO_AGENT_IDS, ["demo-agent"]);
    const secret = (process.env.DEMO_IDENTITY_SECRET ?? "").trim();
    const runIdToIdentity = new Map();

    api.on("before_agent_run", async (event, ctx) => {
      if (!isAgentInScope(ctx ?? {}, { allowedAgentIds })) return;
      const runId = ctx?.runId ?? event?.runId;
      const senderId = ctx?.senderId ?? event?.senderId;
      if (!runId || senderId === undefined || senderId === null) return;
      runIdToIdentity.set(String(runId), { telegramUserId: String(senderId) });
    });

    api.on("before_tool_call", async (event, ctx) => {
      if (!isAgentInScope(ctx ?? {}, { allowedAgentIds })) return;
      const toolName = event?.toolName;
      if (typeof toolName !== "string" || !toolName.startsWith("demo__")) return;

      const params = { ...(event?.params ?? {}) };
      params[IDENTITY_PARAM] = undefined; // ghi đè mọi giá trị model tự điền

      const runId = ctx?.runId ?? event?.runId;
      const identity = runId ? runIdToIdentity.get(String(runId)) : undefined;
      if (!identity || !secret) return { params };

      const signed = issueIdentityToken({
        telegramUserId: identity.telegramUserId,
        runId: String(runId),
        sessionKey: ctx?.sessionKey ?? null,
        toolName: toolName.slice("demo__".length),
        secret,
      });
      return { params: { ...params, ...signed } };
    });

    api.on("agent_end", async (_event, ctx) => {
      const runId = ctx?.runId;
      if (runId) runIdToIdentity.delete(String(runId));
    });
  },
};
