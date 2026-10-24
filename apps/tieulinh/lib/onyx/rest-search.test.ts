import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { OnyxRestSearchClient } from "./rest-search";
import { getLogger, setLogger } from "../logger";
import type { ItsaplanClient, ItsaplanIssue } from "../itsaplan/client";
import type { IntakeLogger } from "../logger";

describe("OnyxRestSearchClient", () => {
  // Bài học tech lead (audit 25/09): KG phải lọc ticket Canceled/Archived, Onyx
  // cũng phải vì cùng nguồn gợi ý. Vé archived/canceled vẫn tồn tại (không 404)
  // nhưng KHÔNG còn là tri thức đáng gợi ý — bài học đêm qua: ~59% cặp bot
  // gợi ý bị chị gỡ, phần lớn vì trỏ vào vé đã hết hiệu lực.
  it("ticket Canceled/Archived trên tracker phải bị bỏ khỏi kết quả (cùng nguyên tắc lọc KG)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "TECH-700: Vé còn Done",
              content: "MÃ TICKET: TECH-700\nTRIỆU CHỨNG SỰ CỐ: lỗi thanh toán",
            },
            {
              title: "TECH-701: Vé đã huỷ",
              content: "MÃ TICKET: TECH-701\nTRIỆU CHỨNG SỰ CỐ: lỗi thanh toán",
            },
            {
              title: "TECH-702: Vé đã archived",
              content: "MÃ TICKET: TECH-702\nTRIỆU CHỨNG SỰ CỐ: lỗi thanh toán",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as any;

    const mockItsaplan: Partial<ItsaplanClient> = {
      getIssueByNumber: async (pk: string, seq: number) => {
        if (pk !== "TECH") throw new Error("404");
        if (seq === 700) return { id: 700, identifier: "TECH-700", title: "v", stateType: "completed" } as any;
        // 701 + 702: stateType canceled — KHÔNG còn tri thức đáng gợi ý.
        if (seq === 701) return { id: 701, identifier: "TECH-701", title: "v", stateType: "canceled" } as any;
        if (seq === 702) return { id: 702, identifier: "TECH-702", title: "v", stateType: "canceled" } as any;
        throw new Error("404");
      },
    };

    const client = new OnyxRestSearchClient(
      { baseUrl: "https://mock.onyx", apiKey: "k" },
      mockItsaplan as ItsaplanClient,
    );
    try {
      const res = await client.searchSimilar("lỗi thanh toán");
      const ids = res.map((r) => r.identifier);
      expect(ids).toContain("TECH-700");
      expect(ids).not.toContain("TECH-701");
      expect(ids).not.toContain("TECH-702");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("bỏ qua ứng viên đã bị chuyển sang dự án khác (#493 issue_key_alias trả identifier khác)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "TECH-700: Vé giữ nguyên",
              content: "MÃ TICKET: TECH-700\nTRIỆU CHỨNG SỰ CỐ: lỗi thanh toán",
            },
            {
              title: "TECH-703: Vé đã chuyển sang PO",
              content: "MÃ TICKET: TECH-703\nTRIỆU CHỨNG SỰ CỐ: lỗi thanh toán",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const mockItsaplan: Partial<ItsaplanClient> = {
      getIssueByNumber: async (_pk: string, seq: number) => {
        if (seq === 700) {
          return { id: 700, identifier: "TECH-700", title: "v", stateType: "completed" } as unknown as ItsaplanIssue;
        }
        if (seq === 703) {
          return { id: 703, identifier: "PO-88", title: "v", stateType: "completed" } as unknown as ItsaplanIssue;
        }
        throw new Error("404");
      },
    };

    const client = new OnyxRestSearchClient(
      { baseUrl: "https://mock.onyx", apiKey: "k" },
      mockItsaplan as ItsaplanClient,
    );
    try {
      const res = await client.searchSimilar("lỗi thanh toán");
      const ids = res.map((r) => r.identifier);
      expect(ids).toEqual(["TECH-700"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Bài học tech lead (audit 25/09): Onyx dense search luôn trả đủ 5 kết quả
  // kể cả khi query hoàn toàn không liên quan (gibberish "zzz qqq" hay câu hỏi
  // chung chung). Ứng viên phải có ít nhất 1 từ khoá thực chất khớp với query,
  // nếu không bị loại bỏ thay vì ghi bừa 5 ticket vào Related Tickets.
  it("loại ứng viên có zero lexical overlap với query (chặn bot đoán mò khi Onyx trả rác)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "TECH-101: Lỗi cổng thanh toán VNPAY",
              content: "MÃ TICKET: TECH-101\nTRIỆU CHỨNG: Học sinh thanh toán báo lỗi 500",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as any;

    const mockItsaplan: Partial<ItsaplanClient> = {
      getIssueByNumber: async (pk: string, seq: number) => {
        if (pk === "TECH" && seq === 101) {
          return { id: 101, identifier: "TECH-101", title: "Lỗi cổng thanh toán VNPAY" } as any;
        }
        throw new Error("404");
      },
    };

    const client = new OnyxRestSearchClient(
      { baseUrl: "https://mock.onyx", apiKey: "k" },
      mockItsaplan as ItsaplanClient,
    );
    try {
      // Query hoàn toàn không liên quan đến thanh toán/VNPAY/500/học sinh
      const res = await client.searchSimilar("camera mic thiết bị phần cứng rè");
      // Zero overlap → phải bị lọc bỏ, không trả về TECH-101
      expect(res.length).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Gate lexical-overlap giờ dùng tỷ lệ (≥40% tổng số token của query phải có
  // mặt trong doc). Doc rất dài có thể chứa nhiều từ chung nên chỉ kiểm tra
  // "any match" (≥1 từ) là chưa đủ — phải đảm bảo tỷ lệ thực sự khớp.
  it("gate lexical-overlap dùng tỷ lệ ≥40%: query chung match, query lệch bị loại", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "TECH-200: Bài tập",
              content:
                "Học sinh làm bài tập Toán trên app Vuihoc. " +
                "Nội dung bài gồm nhiều câu hỏi về phép cộng và nhân.",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as any;

    const mockItsaplan: Partial<ItsaplanClient> = {
      getIssueByNumber: async (pk: string, seq: number) =>
        pk === "TECH" && seq === 200
          ? ({ id: 200, identifier: "TECH-200", title: "Bài tập", stateType: "completed" } as any)
          : (() => { throw new Error("404"); })(),
    };

    const client = new OnyxRestSearchClient(
      { baseUrl: "https://mock.onyx", apiKey: "k" },
      mockItsaplan as ItsaplanClient,
    );
    try {
      // Query CHUNG: 5 từ, 4 từ match với doc → ratio 4/5 = 0.8 ≥ 0.4 → match
      const r1 = await client.searchSimilar("học sinh làm bài tập toán trên app");
      expect(r1.length).toBeGreaterThanOrEqual(1);

      // Query LỆCH: 5 từ, chỉ 1 từ match (ratio 1/5 = 0.2 < 0.4) → loại
      const r2 = await client.searchSimilar("học sinh thanh toán VNPAY gói năm học");
      expect(r2.length).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("lọc vé ảo thành công qua Itsaplan existence check", async () => {
    // Mock fetch Onyx trả về 1 vé thật (TECH-101) và 1 vé ảo (TECH-999)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/api/search")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                title: "TECH-101: Lỗi cổng thanh toán VNPAY",
                content:
                  "MÃ TICKET: TECH-101\nTRIỆU CHỨNG SỰ CỐ:\nHọc sinh thanh toán báo lỗi 500\nNGUYÊN NHÂN GỐC RỄ:\nTimeout kết nối cổng VNPAY\nGIẢI PHÁP XỬ LÝ (RESOLUTION / WORKAROUND):\nRestart service thanh toán",
              },
              {
                title: "TECH-999: Vé ảo do tài liệu rác",
                content: "MÃ TICKET: TECH-999\nTRIỆU CHỨNG SỰ CỐ:\nLỗi ảo không có thật",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(url);
    }) as any;

    // Mock Itsaplan: TECH-101 tồn tại, TECH-999 ném lỗi 404
    const mockItsaplan: Partial<ItsaplanClient> = {
      getIssueByNumber: async (projectKey: string, seq: number) => {
        if (projectKey === "TECH" && seq === 101) {
          return { id: 101, identifier: "TECH-101", title: "Lỗi cổng thanh toán VNPAY" } as ItsaplanIssue;
        }
        throw new Error("HTTP 404: Not Found");
      },
    };

    try {
      const client = new OnyxRestSearchClient(
        { baseUrl: "https://mock.onyx", apiKey: "mock_key" },
        mockItsaplan as ItsaplanClient,
      );

      const res = await client.searchSimilar("lỗi thanh toán");
      expect(res.length).toBe(1);
      expect(res[0].identifier).toBe("TECH-101");
      expect(res[0].verifiedOnTracker).toBe(true);
      expect(res[0].rootCause).toBe("Timeout kết nối cổng VNPAY");
      expect(res[0].resolution).toBe("Restart service thanh toán");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it("loại vé đã huỷ (canceled) và xếp vé có rootCause/resolution lên trước", async () => {
    // Bài học tech lead: vé canceled VẪN tồn tại trên tracker nên verification cũ
    // chỉ check tồn tại là chưa đủ — vé huỷ lọt vào Related Tickets rồi bị gỡ tay.
    // Trạng thái tra theo columnId (ProjectColumnStates), không đoán theo chữ.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/api/search")) {
        return new Response(
          JSON.stringify({
            results: [
              { title: "TECH-201: Vé đã huỷ", content: "MÃ TICKET: TECH-201\nTRIỆU CHỨNG SỰ CỐ:\nLỗi A" },
              { title: "TECH-202: Vé Done thiếu tri thức", content: "MÃ TICKET: TECH-202\nTRIỆU CHỨNG SỰ CỐ:\nLỗi B" },
              {
                title: "TECH-203: Vé Done có tri thức",
                content:
                  "MÃ TICKET: TECH-203\nTRIỆU CHỨNG SỰ CỐ:\nLỗi C\nNGUYÊN NHÂN GỐC RỄ:\nDo cấu hình X\nGIẢI PHÁP XỬ LÝ (RESOLUTION):\nSửa cấu hình Y",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(url);
    }) as any;

    const mockItsaplan: Partial<ItsaplanClient> = {
      getIssueByNumber: async (projectKey: string, seq: number) =>
        ({ id: seq, identifier: `TECH-${seq}`, title: `Sự cố ${seq}`, columnId: seq === 201 ? 9 : 3 }) as ItsaplanIssue,
      listProjectColumns: async () =>
        [
          { id: 3, name: "Done", stateType: "completed" },
          { id: 9, name: "Canceled", stateType: "canceled" },
        ] as any,
    };

    try {
      const client = new OnyxRestSearchClient(
        { baseUrl: "https://mock.onyx", apiKey: "mock_key" },
        mockItsaplan as ItsaplanClient,
      );

      const res = await client.searchSimilar("lỗi");
      // TECH-201 (canceled) bị loại; vé có tri thức lên trước vé chỉ có mã.
      expect(res.map((r) => r.identifier)).toEqual(["TECH-203", "TECH-202"]);
      expect(res[0].resolution).toBe("Sửa cấu hình Y");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Bài học từ sửa thật: catch nuốt timeout/network/JSON parse im lặng → không
  // biết Onyx chết hay thật sự không có tương tự. Test đảm bảo có warn để debug.
  describe("error logging — không nuốt lỗi Onyx", () => {
    let warnCalls: string[];
    let savedLogger: IntakeLogger;

    beforeEach(() => {
      warnCalls = [];
      savedLogger = getLogger();
      setLogger({
        debug: () => {},
        info: () => {},
        warn: (msg) => warnCalls.push(String(msg)),
        error: (msg) => warnCalls.push(String(msg)),
      });
    });

    afterEach(() => {
      setLogger(savedLogger);
    });

    it("log warn khi fetch ném lỗi (timeout/network) và trả []", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      }) as any;
      try {
        const client = new OnyxRestSearchClient({
          baseUrl: "https://mock.onyx",
          apiKey: "mock_key",
        });
        const res = await client.searchSimilar("lỗi timeout test");
        expect(res).toEqual([]);
        expect(warnCalls.length).toBe(1);
        expect(warnCalls[0]).toContain("[OnyxRestSearch] search failed");
        expect(warnCalls[0]).toContain("TypeError");
        // cleanQuery đã redactPII trước khi log → an toàn PII
        expect(warnCalls[0]).toContain("query=");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("log warn khi Onyx trả non-2xx và trả []", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => new Response("upstream timeout", { status: 503 })) as any;
      try {
        const client = new OnyxRestSearchClient({
          baseUrl: "https://mock.onyx",
          apiKey: "mock_key",
        });
        const res = await client.searchSimilar("lỗi 503 test");
        expect(res).toEqual([]);
        expect(warnCalls.length).toBe(1);
        expect(warnCalls[0]).toContain("[OnyxRestSearch] /api/search non-2xx");
        expect(warnCalls[0]).toContain("status=503");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // Bài học sửa thật: tag_key="system" EQUAL trên Onyx trả 0 vì ingest không bao
  // giờ gắn tag system (worker/ingest.service.ts:178 chỉ ghi ticket_id/status/
  // root_cause/resolution). Phải hỏi theo UNION alias (chuẩn + absorbs cũ); nếu
  // cả union trả 0 thì fallback bỏ tag để candidate vẫn chảy qua soft-filter.
  describe("alias union khi filter theo hệ thống", () => {
    it("gửi nhiều truy vấn Onyx với mỗi alias của hệ thống + fallback no-tags", async () => {
      const originalFetch = globalThis.fetch;
      const seenTagValues: string[] = [];
      const seenTagsMissing: boolean[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        if (String(url).includes("/api/search")) {
          // Đọc body để xác nhận payload đã gửi đúng tag_value
          const req = url as unknown as Request;
          // Bun: có init trong mock — dùng 1 closure khác để bắt payload
          return new Response(
            JSON.stringify({
              results: [
                {
                  title: "TECH-301: ticket VH tự học",
                  content:
                    "MÃ TICKET: TECH-301 · VH_Tự học ·\nTRIỆU CHỨNG SỰ CỐ:\nLỗi A\nNGUYÊN NHÂN GỐC RỄ:\nNguyên nhân A\nGIẢI PHÁP XỬ LÝ (RESOLUTION):\nFix A",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return originalFetch(url);
      }) as any;

      // Bắt payload bằng cách wrap fetch 1 lần nữa để đọc body
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const res = await (realFetch as any)(url, init);
        if (String(url).includes("/api/search") && init?.body) {
          try {
            const body = JSON.parse(String(init.body));
            if (Array.isArray(body.tags) && body.tags[0]) {
              seenTagValues.push(body.tags[0].tag_value);
            } else {
              seenTagsMissing.push(true);
            }
          } catch {}
        }
        return res;
      }) as any;

      const mockItsaplan: Partial<ItsaplanClient> = {
        getIssueByNumber: async (projectKey: string, seq: number) =>
          ({ id: seq, identifier: `TECH-${seq}`, title: `Sự cố ${seq}`, columnId: 3 }) as ItsaplanIssue,
        listProjectColumns: async () => [{ id: 3, name: "Done", stateType: "completed" }] as any,
      };

      try {
        const client = new OnyxRestSearchClient(
          { baseUrl: "https://mock.onyx", apiKey: "mock_key" },
          mockItsaplan as ItsaplanClient,
        );

        // VH_Tự học có 3 alias: id chuẩn "VH_Tự học" + 3 absorbs
        // (Web_Vuihoc, App/Web_Vuihoc, Vuihoc (App/Web_Vuihoc + ERP_DUO) [phần non-Duo])
        await client.searchSimilar("lỗi banner", "VH_Tự học");

        // Phải thấy alias đầu tiên + fallback no-tags
        expect(seenTagValues.length + seenTagsMissing.length).toBeGreaterThanOrEqual(2);
        expect(seenTagValues[0]).toBe("VH_Tự học");
        // fallback no-tags phải có mặt
        expect(seenTagsMissing.length).toBeGreaterThanOrEqual(1);
        // Không bao giờ EQUAL trên alias cũ như "vuihoc (app/web_vuihoc + erp_duo)"
        // — chỉ là candidate union, Onyx tự trả 0 nếu không có doc nào gắn
        // tag đó, không sao cả.
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("dedupe TECH code khi nhiều alias trả cùng một ticket", async () => {
      const originalFetch = globalThis.fetch;
      let callIndex = 0;
      globalThis.fetch = (async (url: string | URL | Request) => {
        if (String(url).includes("/api/search")) {
          callIndex++;
          // Mỗi lần trả về cùng một TECH-401 — nhưng gắn tag khác nhau để giả
          // lập cùng ticket match nhiều alias
          return new Response(
            JSON.stringify({
              results: [
                {
                  title: "TECH-401: trùng vé qua 2 alias",
                  content:
                    "MÃ TICKET: TECH-401 · VH_Tự học ·\nTRIỆU CHỨNG SỰ CỐ:\nLỗi banner app\nNGUYÊN NHÂN GỐC RỄ:\nNguyên nhân X\nGIẢI PHÁP XỬ LÝ (RESOLUTION):\nFix X",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return originalFetch(url);
      }) as any;

      const mockItsaplan: Partial<ItsaplanClient> = {
        getIssueByNumber: async (projectKey: string, seq: number) =>
          ({ id: seq, identifier: `TECH-${seq}`, title: `Sự cố ${seq}`, columnId: 3 }) as ItsaplanIssue,
        listProjectColumns: async () => [{ id: 3, name: "Done", stateType: "completed" }] as any,
      };

      try {
        const client = new OnyxRestSearchClient(
          { baseUrl: "https://mock.onyx", apiKey: "mock_key" },
          mockItsaplan as ItsaplanClient,
        );
        const res = await client.searchSimilar("lỗi banner", "VH_Tự học");
        // Dù trả về 4 lần (4 alias) cùng 1 TECH code, output phải chỉ có 1.
        expect(res.length).toBe(1);
        expect(res[0].identifier).toBe("TECH-401");
        // Đã gọi nhiều hơn 1 lần (alias union chứ không phải 1 truy vấn)
        expect(callIndex).toBeGreaterThan(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
