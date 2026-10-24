/** Dữ liệu giả và tiện ích dùng chung cho test. Không dữ liệu thật. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RelayConfig, relayConfig } from "./config.ts";
import type { InboundEvent, OutboundEvent, ToolEvent } from "./queue.ts";

export const CHAT = "1000000001";
export const SESSION = `agent:ticket-intake-agent:telegram:ticket:direct:${CHAT}`;

const dirs: string[] = [];
export function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "tl2-shadow-"));
  dirs.push(d);
  return d;
}
export function cleanTmp(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function testConfig(dir: string, extra: Record<string, string> = {}): RelayConfig {
  return relayConfig({
    SHADOW_ALLOW_FROM: "10.0.0.5",
    TL2_SHADOW_DIR: dir,
    TL2_TL1_SETTLE_MS: "1000",
    TL2_TL1_WAIT_MAX_MS: "30000",
    ...extra,
  });
}

export function inbound(n: number, ts: number, text = `sự cố số ${n}`, chat = CHAT): InboundEvent {
  return {
    v: 1,
    kind: "inbound",
    eid: `in:ticket:${chat}:${n}`,
    ts,
    chatId: chat,
    sessionKey: `agent:ticket-intake-agent:telegram:ticket:direct:${chat}`,
    accountId: "ticket",
    messageId: String(n),
    isGroup: false,
    senderId: chat,
    senderName: "An Test",
    senderUsername: "an_test",
    text,
    replyTo: null,
    media: [],
  };
}

export function outbound(n: number, ts: number, text: string, chat = CHAT): OutboundEvent {
  return {
    v: 1,
    kind: "outbound",
    eid: `out:ticket:${chat}:${n}`,
    ts,
    chatId: chat,
    sessionKey: `agent:ticket-intake-agent:telegram:ticket:direct:${chat}`,
    success: true,
    text,
  };
}

export function tool(n: number, ts: number, name: string, chat = CHAT): ToolEvent {
  return {
    v: 1,
    kind: "tool",
    eid: `tool:${n}`,
    ts,
    sessionKey: `agent:ticket-intake-agent:telegram:ticket:direct:${chat}`,
    tool: name,
    params: { chatId: chat },
    ok: true,
    error: null,
  };
}

/** Phản hồi OpenAI-compatible giả. */
export function completion(reply: string, model = "openclaw/ticket-intake-agent-2"): Response {
  return Response.json({
    id: "c1",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
  });
}
