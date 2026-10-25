import { describe, expect, it, afterEach, mock } from "bun:test";
import { OnyxClient } from "./client";

describe("OnyxClient.searchSimilarTickets — searchViaMcp regex phải đọc được cả 2 định dạng doc đang tồn tại song song trong Onyx", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const mockMcpFlow = (searchResult: any) => {
    let call = 0;
    globalThis.fetch = mock(async (_url: any, init: any) => {
      call++;
      const body = JSON.parse(init.body);
      if (body.method === "initialize") {
        return new Response("{}", {
          status: 200,
          headers: { "mcp-session-id": "sess-1", "Content-Type": "application/json" },
        });
      }
      if (body.method === "notifications/initialized") {
        return new Response("{}", { status: 200 });
      }
      if (body.method === "tools/call") {
        const payload = {
          jsonrpc: "2.0",
          id: 2,
          result: { structuredContent: { results: searchResult } },
        };
        return new Response(`data: ${JSON.stringify(payload)}\n\n`, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      throw new Error(`Unexpected MCP call #${call}: ${body.method}`);
    }) as any;
  };

  it("Định dạng compact cũ (319 doc trong tech-done-tickets, không dấu ':') vẫn đọc đúng như trước", async () => {
    mockMcpFlow([
      {
        document_id: "doc1",
        title: "TECH-354: Lỗi đường truyền",
        content:
          "TECH-354 · Vuihoc · Lỗi kỹ thuật · đóng 2026-08-27\n\nTRIỆU CHỨNG\nMất kết nối lặp lại\n\nNGUYÊN NHÂN\nMạng Wi-Fi yếu\n\nCÁCH KHẮC PHỤC\nChuyển sang mạng dây",
      },
    ]);

    const client = new OnyxClient("https://mock.onyx", "mock_key");
    const res = await client.searchSimilarTickets("Lỗi đường truyền", "Mất kết nối");

    expect(res.candidateDetails?.[0]?.nguyen_nhan).toBe("Mạng Wi-Fi yếu");
    expect(res.candidateDetails?.[0]?.cach_khac_phuc).toBe("Chuyển sang mạng dây");
  });

  it("Định dạng verbose mới (OnyxIngestService, có dấu ':' và 'GỐC RỄ'/'XỬ LÝ') — trước đây đọc rỗng, giờ phải đọc đúng", async () => {
    mockMcpFlow([
      {
        document_id: "ticket_tech_101",
        title: "[TECH-101] Lỗi cổng thanh toán VNPAY",
        content:
          "MÃ TICKET: TECH-101\nTIÊU ĐỀ: Lỗi cổng thanh toán VNPAY\nTRẠNG THÁI: Resolved\n\n" +
          "TRIỆU CHỨNG SỰ CỐ:\nHọc sinh thanh toán báo lỗi 500\n\n" +
          "NGUYÊN NHÂN GỐC RỄ:\nTimeout kết nối cổng VNPAY\n\n" +
          "GIẢI PHÁP XỬ LÝ (RESOLUTION / WORKAROUND):\nRestart service thanh toán\n\n" +
          "HƯỚNG DẪN PHÒNG NGỪA:\nGiám sát timeout cổng thanh toán",
      },
    ]);

    const client = new OnyxClient("https://mock.onyx", "mock_key");
    const res = await client.searchSimilarTickets("Lỗi thanh toán", "Báo lỗi 500");

    expect(res.relatedTicketKeys).toContain("TECH-101");
    expect(res.candidateDetails?.[0]?.trieu_chung).toBe("Học sinh thanh toán báo lỗi 500");
    expect(res.candidateDetails?.[0]?.nguyen_nhan).toBe("Timeout kết nối cổng VNPAY");
    expect(res.candidateDetails?.[0]?.cach_khac_phuc).toBe("Restart service thanh toán");
  });

  it("document_set_names gửi lên Onyx phải bao gồm intake-test-done (nơi worker thực sự ghi)", async () => {
    let sentDocumentSets: string[] = [];
    globalThis.fetch = mock(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      if (body.method === "initialize") {
        return new Response("{}", { status: 200, headers: { "mcp-session-id": "sess-1" } });
      }
      if (body.method === "notifications/initialized") {
        return new Response("{}", { status: 200 });
      }
      if (body.method === "tools/call") {
        sentDocumentSets = body.params.arguments.document_set_names;
        return new Response(
          `data: ${JSON.stringify({ result: { structuredContent: { results: [] } } })}\n\n`,
          {
            status: 200,
          },
        );
      }
      throw new Error("unexpected");
    }) as any;

    const client = new OnyxClient("https://mock.onyx", "mock_key");
    await client.searchSimilarTickets("Lỗi X", "Mô tả Y");

    expect(sentDocumentSets).toContain("intake-test-done");
    expect(sentDocumentSets).toContain("ticket-history");
    expect(sentDocumentSets).toContain("tech-done-tickets");
  });
});
