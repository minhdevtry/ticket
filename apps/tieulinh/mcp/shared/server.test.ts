import { describe, expect, it, afterAll } from "bun:test";
import { z } from "zod";
import { defineTool } from "./tool";
import { createIntakeMcpServer, runOnHttp } from "./server";

// Test 1 tool echo đơn giản, không đụng Memgraph/Itsaplan — chỉ kiểm chứng
// tầng transport HTTP tự viết (Bun.serve + WebStandardStreamableHTTPServerTransport).
const echoTool = defineTool({
  name: "echo",
  description: "Trả lại đúng input",
  inputSchema: { message: z.string() },
  handler: ({ message }) => ({ echoed: message }),
});

const API_KEY = "test-secret";

// Server chạy 1 lần cho cả file, đóng ở afterAll.
const httpServer = runOnHttp(() => createIntakeMcpServer({ name: "test-http-mcp", version: "1.0.0", tools: [echoTool] }), {
  port: 0, // cổng ngẫu nhiên — không đụng test khác chạy song song
  apiKey: API_KEY,
});

const base = `http://127.0.0.1:${httpServer.port}`;
const mcpHeaders = (withAuth: boolean) => ({
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  ...(withAuth ? { Authorization: `Bearer ${API_KEY}` } : {}),
});

const callTool = async (name: string, args: unknown, id: number) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: mcpHeaders(true),
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  });

describe("runOnHttp — MCP qua HTTP (Bug đã gặp thật: thiếu auth lọt qua, và 'Already connected to a transport')", () => {
  afterAll(() => {
    httpServer.stop(true);
  });

  it("mặc định chỉ nghe 127.0.0.1 — không lộ ra LAN khi quên cấu hình host", () => {
    expect(httpServer.hostname).toBe("127.0.0.1");
  });

  it("GET /health không cần auth, trả 200", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).status).toBe("ok");
  });

  it("POST /mcp thiếu Authorization bị từ chối 401", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: mcpHeaders(false),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /mcp với Authorization sai key bị từ chối 401", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-key" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("initialize + tools/call với đúng key thành công", async () => {
    const initRes = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: mcpHeaders(true),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      }),
    });
    expect(initRes.status).toBe(200);

    const callRes = await callTool("echo", { message: "xin chào" }, 2);
    expect(callRes.status).toBe(200);
    const body = (await callRes.json()) as any;
    const parsed = JSON.parse(body.result.content[0].text);
    expect(parsed.echoed).toBe("xin chào");
  });

  it("2 lần gọi tools/call LIÊN TIẾP không ném lỗi 'Already connected to a transport' (bug đã gặp thật khi dùng lại 1 McpServer instance cho nhiều request)", async () => {
    const res1 = await callTool("echo", { message: "lần 1" }, 10);
    const res2 = await callTool("echo", { message: "lần 2" }, 11);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const body1 = (await res1.json()) as any;
    const body2 = (await res2.json()) as any;
    expect(body1.error).toBeUndefined();
    expect(body2.error).toBeUndefined();
    expect(JSON.parse(body1.result.content[0].text).echoed).toBe("lần 1");
    expect(JSON.parse(body2.result.content[0].text).echoed).toBe("lần 2");
  });
});
