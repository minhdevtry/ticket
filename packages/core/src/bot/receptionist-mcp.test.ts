import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defineBot } from "./define";
import { createReceptionistMcpServer } from "./receptionist-mcp";
import { runOnHttp, runOnStdio } from "../core/mcp-server";
import { fixtureCatalog } from "../intake/gate/catalog.fixture";
import { FieldExtractor } from "../intake/extractor/llm-extractor";
import { makeCopyCatalog } from "../intake/copy-catalog";
import { TEST_COPY } from "../intake/engine/test-copy.fixture";
import { SqliteDraftRepository, intakeApplySchema } from "../intake/draft";
import fixtureUrgency from "../intake/priority/urgency-rules.fixture.json" with { type: "json" };
import type { UrgencyRules } from "../intake/priority/priority";
import type { TrackerIssue, TrackerPort } from "../intake/ports";

describe("createReceptionistMcpServer", () => {
  const db = new Database(":memory:");
  intakeApplySchema(db);
  const drafts = new SqliteDraftRepository(db);

  const fakeTracker: TrackerPort = {
    createIssue: async (input) =>
      ({
        id: 101,
        identifier: "TECH-101",
        title: input.title,
        url: "https://tracker.example.com/TECH-101",
      }) as TrackerIssue,
    getIssue: async () => null,
    addComment: async () => {},
    attach: async () => 0,
    findByIdentifier: async () => null,
  };

  const botDef = defineBot({
    id: "tieulinh-test",
    tracker: { team: "tech", project: "TECH" },
    persona: makeCopyCatalog(TEST_COPY),
    receptionist: {
      catalog: fixtureCatalog,
      priorityRules: fixtureUrgency as unknown as UrgencyRules,
      extractor: new FieldExtractor(),
    },
    backoffice: { on: { mention: async () => "ok" } },
  });

  it("liệt kê đúng các tool tiếp nhận và gọi qua InMemoryTransport", async () => {
    const server = createReceptionistMcpServer(botDef, {
      tracker: fakeTracker,
      drafts,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    const toolList = await client.listTools();
    const toolNames = toolList.tools.map((t) => t.name);

    expect(toolNames).toContain("intake_step");
    expect(toolNames).toContain("get_intake_doc");
    expect(toolNames).toContain("get_similar_tickets");

    // Gọi intake_step qua MCP client
    const res = await client.callTool({
      name: "intake_step",
      arguments: {
        chatId: "mcp_chat_1",
        message: "Không vào được LiveClass",
      },
    });

    const contents = res.content;
    expect(Array.isArray(contents)).toBe(true);
    if (Array.isArray(contents)) {
      expect(contents.length).toBeGreaterThan(0);
      const textContent = contents[0];
      expect(textContent.type).toBe("text");
      if (textContent.type === "text") {
        const parsed = JSON.parse(textContent.text);
        expect(parsed.action).toBeDefined();
        expect(parsed.status).toBe("collecting");
        expect(parsed.voiceText).toBeDefined();
        expect(parsed.buttonsShown).toBeDefined();
        expect(parsed.agentInstruction).toBeDefined();
        expect(parsed.buttons).toBeUndefined();
        expect(textContent.text).not.toContain("callbackData");
      }
    }

    // Tra cứu qua get_intake_doc
    const docRes = await client.callTool({
      name: "get_intake_doc",
      arguments: {
        chatId: "mcp_chat_1",
      },
    });
    const docContents = docRes.content;
    expect(Array.isArray(docContents)).toBe(true);
    if (Array.isArray(docContents)) {
      const docContent = docContents[0];
      expect(docContent.type).toBe("text");
      if (docContent.type === "text") {
        const parsed = JSON.parse(docContent.text);
        expect(parsed.found).toBe(true);
        expect(parsed.document.chatId).toBe("mcp_chat_1");
      }
    }

    // Tra cứu qua get_similar_tickets
    const simRes = await client.callTool({
      name: "get_similar_tickets",
      arguments: {
        chatId: "mcp_chat_1",
      },
    });
    const simContents = simRes.content;
    expect(Array.isArray(simContents)).toBe(true);
    if (Array.isArray(simContents)) {
      const simContent = simContents[0];
      expect(simContent.type).toBe("text");
      if (simContent.type === "text") {
        const parsed = JSON.parse(simContent.text);
        expect(parsed.found).toBe(true);
        expect(parsed.similarTickets).toBeDefined();
      }
    }
  });

  it("chạy được trên Streamable HTTP và gọi tool với JSON-RPC", async () => {
    const API_KEY = "mcp-test-key";
    const httpServer = runOnHttp(
      () =>
        createReceptionistMcpServer(botDef, {
          tracker: fakeTracker,
          drafts,
        }),
      {
        port: 0,
        apiKey: API_KEY,
      },
    );

    try {
      const base = `http://127.0.0.1:${httpServer.port}`;
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${API_KEY}`,
      };

      // 1. Initialize
      const initResp = await fetch(`${base}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test-http", version: "1.0.0" },
          },
        }),
      });
      expect(initResp.status).toBe(200);

      // 2. Call tools/list
      const listResp = await fetch(`${base}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      });
      expect(listResp.status).toBe(200);
      const listData = (await listResp.json()) as {
        result: { tools: Array<{ name: string }> };
      };
      const names = listData.result.tools.map((t) => t.name);
      expect(names).toContain("intake_step");

      // 3. Call tools/call for intake_step
      const callResp = await fetch(`${base}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "intake_step",
            arguments: {
              chatId: "http_chat_1",
              message: "Lỗi thanh toán",
            },
          },
        }),
      });
      expect(callResp.status).toBe(200);
      const callData = (await callResp.json()) as {
        result: { content: Array<{ type: string; text: string }> };
      };
      expect(callData.result.content[0].type).toBe("text");
      const parsedResult = JSON.parse(callData.result.content[0].text);
      expect(parsedResult.action).toBeDefined();
    } finally {
      httpServer.stop(true);
    }
  });

  it("runOnStdio bọc được StdioServerTransport", () => {
    const server = createReceptionistMcpServer(botDef, {
      tracker: fakeTracker,
      drafts,
    });
    expect(typeof runOnStdio).toBe("function");
    expect(server).toBeDefined();
  });
});
