import { describe, expect, it } from "bun:test";
import { MemgraphClient } from "./memgraph-client";
import { KnowledgeGraphQueries } from "./kg-queries";
import { isMemgraphReachable } from "./memgraph-test-support";

// Không có Memgraph (máy dev/CI) thì bỏ qua thay vì đỏ vì "Failed to connect".
const memgraphUp = await isMemgraphReachable();

async function wipeTestTicket(memgraph: MemgraphClient, identifier: string): Promise<void> {
  const session = (memgraph as any).driver.session();
  try {
    await session.run(
      `MATCH (t:Ticket {identifier: $id})
       OPTIONAL MATCH (t)-[:CAUSED_BY]->(rc:RootCause)
       OPTIONAL MATCH (rc)-[:RESOLVED_BY]->(res:Resolution)
       DETACH DELETE t, rc, res`,
      { id: identifier },
    );
  } finally {
    await session.close();
  }
}

describe.skipIf(!memgraphUp)("KnowledgeGraphQueries", () => {
  it("truy vấn được top root causes và thống kê theo label", async () => {
    const memgraph = new MemgraphClient();
    const queries = new KnowledgeGraphQueries(memgraph);
    try {
      const stats = await queries.statsByLabel();
      expect(stats.length).toBeGreaterThan(0);
      console.log("[statsByLabel]", JSON.stringify(stats));

      const topCauses = await queries.topRootCauses(undefined, 5);
      console.log("[topRootCauses]", JSON.stringify(topCauses.slice(0, 3), null, 0));
      // Có thể có hoặc không (tuỳ dữ liệu), nhưng không được throw
      expect(Array.isArray(topCauses)).toBe(true);

      const mostRelated = await queries.mostRelatedTickets(5);
      expect(Array.isArray(mostRelated)).toBe(true);
    } finally {
      await memgraph.close();
    }
  }, 15000);

  // Trước đây suggestResolutions có Cypher sai (2 mệnh đề WHERE liên tiếp + regex "(?i)"
  // Memgraph không hỗ trợ) khiến hàm LUÔN throw và bị catch nuốt, trả về [] cho MỌI tham số
  // — bài test cũ chỉ check `Array.isArray` nên không bao giờ bắt được lỗi này. Test dưới
  // đây dùng fixture thật để đảm bảo hàm THỰC SỰ tìm ra kết quả, không chỉ "không throw".
  it("suggestResolutions tìm đúng ticket khi kết hợp system + keywords (bug cũ: luôn rỗng)", async () => {
    const memgraph = new MemgraphClient();
    const queries = new KnowledgeGraphQueries(memgraph);
    const testKey = `TEST-KGQ-${Date.now()}`;
    try {
      await memgraph.upsertTicketNode({
        identifier: testKey,
        title: "CRM không tạo được đơn do trùng tài khoản",
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        system: "CRM_Vuihoc",
        errorCategory: "Lỗi dữ liệu",
        causeTaxon: "ACCOUNT_LINK_DUPLICATE",
        rootCause: "Hồ sơ học sinh bị gắn trùng tài khoản Vuihoc do mapping nhầm",
        resolution: "Gỡ liên kết trùng và gắn lại đúng tài khoản",
      });

      const bySystemAndKeyword = await queries.suggestResolutions({
        system: "CRM_Vuihoc",
        keywords: ["trùng tài khoản"],
        limit: 5,
      });
      expect(bySystemAndKeyword.some((r) => r.identifier === testKey)).toBe(true);

      const byCauseTaxon = await queries.suggestResolutions({
        causeTaxon: "ACCOUNT_LINK_DUPLICATE",
        keywords: [],
        limit: 5,
      });
      expect(byCauseTaxon.some((r) => r.identifier === testKey)).toBe(true);

      const wrongSystem = await queries.suggestResolutions({
        system: "LMS_Vuihoc",
        keywords: ["trùng tài khoản"],
        limit: 5,
      });
      expect(wrongSystem.some((r) => r.identifier === testKey)).toBe(false);
    } finally {
      await wipeTestTicket(memgraph, testKey);
      await memgraph.close();
    }
  }, 15000);

  // RootCause dùng chung theo text → 2 giải pháp treo cùng một RootCause. Gợi ý
  // không được trả "ticket A + giải pháp của B".
  it("suggestResolutions chỉ ghép ticket với giải pháp của chính nó", async () => {
    const memgraph = new MemgraphClient();
    const queries = new KnowledgeGraphQueries(memgraph);
    const stamp = Date.now();
    const a = `TEST-KGQ-PA-${stamp}`;
    const b = `TEST-KGQ-PB-${stamp}`;
    const cause = `TESTCAUSE${stamp} hàng đợi đồng bộ bị kẹt`;
    try {
      const common = { status: "Done", priority: "low", createdAt: new Date().toISOString(), rootCause: cause };
      await memgraph.upsertTicketNode({ ...common, identifier: a, title: "A", resolution: `TEST sửa A ${stamp}` });
      await memgraph.upsertTicketNode({ ...common, identifier: b, title: "B", resolution: `TEST sửa B ${stamp}` });

      const rows = (await queries.suggestResolutions({ keywords: [`TESTCAUSE${stamp}`], limit: 10 })).filter(
        (r) => r.identifier === a || r.identifier === b,
      );
      expect(rows.map((r) => `${r.identifier}=${r.resolution}`).sort()).toEqual([
        `${a}=TEST sửa A ${stamp}`,
        `${b}=TEST sửa B ${stamp}`,
      ]);
    } finally {
      await wipeTestTicket(memgraph, a);
      await wipeTestTicket(memgraph, b);
      await memgraph.close();
    }
  }, 15000);

  // Audit P1: topRootCauses(system) từng dùng Cypher
  //   MATCH (t:Ticket)-[:IN_SYSTEM]->(s:System {name: $system})-[:CAUSED_BY]->(rc:RootCause)
  // Sai hướng — System không có cạnh CAUSED_BY. Trả 0 kết quả dù đồ thị có dữ liệu
  // (broken=0, correct two-pattern=327 hàng cho CRM_Vuihoc). Bài test này fixture
  // 1 ticket + 1 rootCause vào CRM_Vuihoc rồi assert nó xuất hiện trong kết quả.
  it("topRootCauses(system) lọc đúng theo System (bug cũ: Cypher sai hướng, luôn rỗng)", async () => {
    const memgraph = new MemgraphClient();
    const queries = new KnowledgeGraphQueries(memgraph);
    const testKey = `TEST-KGQ-RC-${Date.now()}`;
    try {
      await memgraph.upsertTicketNode({
        identifier: testKey,
        title: "CRM báo lỗi khi ghi nhận thanh toán",
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        system: "CRM_Vuihoc",
        errorCategory: "Lỗi tích hợp",
        causeTaxon: "PAYMENT_GATEWAY_TIMEOUT",
        rootCause: "Cổng thanh toán timeout khi ghi nhận đơn CRM_Vuihoc (test fixture)",
        resolution: "Retry sau 30s, nếu vẫn fail thì đẩy lại qua hàng đợi",
      });

      const top = await queries.topRootCauses("CRM_Vuihoc", 200);
      expect(top.some((r) => r.rootCause.includes("CRM_Vuihoc (test fixture)"))).toBe(true);

      const wrongSystem = await queries.topRootCauses("LMS_Vuihoc", 200);
      expect(wrongSystem.some((r) => r.rootCause.includes("CRM_Vuihoc (test fixture)"))).toBe(false);
    } finally {
      await wipeTestTicket(memgraph, testKey);
      await memgraph.close();
    }
  }, 15000);

  // Audit P2: mostRelatedTickets từng trả về cả node "ghost" (Ticket có trong
  // graph nhưng t.title = null/"" — sinh ra do MERGE identifier-only từ related
  // ticket upserts trước khi Ticket chính được upsert). Bài test fixture 1
  // ticket "thật" (có title) + 1 ticket "ghost" (insert trực tiếp qua Cypher
  // bỏ qua upsertTicketNode để giả lập node mồ côi), nối RELATES_TO rồi assert
  // hàm chỉ trả về ticket thật, không trả về ghost.
  it("mostRelatedTickets loại bỏ ghost Ticket không có title", async () => {
    const memgraph = new MemgraphClient();
    const queries = new KnowledgeGraphQueries(memgraph);
    const realKey = `TEST-KGQ-REAL-${Date.now()}`;
    const ghostKey = `TEST-KGQ-GHOST-${Date.now()}`;
    try {
      // 1) Ticket thật — có title
      await memgraph.upsertTicketNode({
        identifier: realKey,
        title: "Ghost regression: ticket có title đầy đủ",
        status: "Open",
        priority: "low",
        createdAt: new Date().toISOString(),
      });

      // 2) Ticket ghost — insert trực tiếp qua driver để giả lập node mồ côi
      //    (chỉ có identifier, không có title). Nguyên nhân gốc trong thực tế:
      //    upsertTicketNode chạy với relatedTickets=[X] khi X chưa từng được
      //    upsert → MERGE tạo node X rỗng, sau đó không bao giờ được SET title.
      const session = (memgraph as any).driver.session();
      try {
        await session.run(
          `MATCH (t:Ticket {identifier: $id})
           CREATE (g:Ticket {identifier: $ghostId})`,
          { id: realKey, ghostId: ghostKey },
        );
        await session.run(
          `MATCH (a:Ticket {identifier: $a}), (b:Ticket {identifier: $b})
           MERGE (a)-[:RELATES_TO]-(b)`,
          { a: realKey, b: ghostKey },
        );
      } finally {
        await session.close();
      }

      const result = await queries.mostRelatedTickets(500);
      const ids = result.map((r) => r.identifier);
      expect(ids).toContain(realKey);
      expect(ids).not.toContain(ghostKey);
      // Mọi row trả về đều phải có title (không rỗng, không null)
      for (const row of result) {
        expect(row.title).toBeTruthy();
        expect(row.title.length).toBeGreaterThan(0);
      }
    } finally {
      await wipeTestTicket(memgraph, realKey);
      await wipeTestTicket(memgraph, ghostKey);
      await memgraph.close();
    }
  }, 15000);
});
