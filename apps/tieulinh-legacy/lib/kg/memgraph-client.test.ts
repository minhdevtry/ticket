import { describe, expect, it } from "bun:test";
import type { Socket } from "node:net";
import { MemgraphClient } from "./memgraph-client";
import { isMemgraphReachable } from "./memgraph-test-support";

// Không có Memgraph (máy dev/CI) thì bỏ qua thay vì đỏ vì "Failed to connect".
const memgraphUp = await isMemgraphReachable();

// Test này chạy trên Memgraph thật (không phải DB tạm) — phải tự dọn dẹp
// Ticket + RootCause/Resolution do chính nó tạo ra, nếu không sẽ để lại
// node mồ côi lẫn vào Knowledge Graph thật (đã từng xảy ra: xem audit
// "Orphan RootCause"). KHÔNG xoá System/Product/Category/Department vì đó
// là node dùng chung với dữ liệu thật, xoá nhầm sẽ mất dữ liệu người khác.
async function wipeTestTicket(client: MemgraphClient, identifier: string): Promise<void> {
  const session = (client as any).driver.session();
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

describe.skipIf(!memgraphUp)("MemgraphClient Cypher Tests", () => {
  it("nạp node và truy vấn topo qua Cypher thành công", async () => {
    const client = new MemgraphClient();
    try {
      await client.ensureConstraints();
      const testKey = `TEST-KG-${Date.now()}`;
      await client.upsertTicketNode({
        identifier: testKey,
        title: "Lỗi kết nối database phòng học",
        status: "Done",
        priority: "urgent",
        createdAt: new Date().toISOString(),
        system: "TUTOR_Vuihoc",
        product: "Tutor",
        errorCategory: "Lỗi hệ thống",
        reportingDept: "Vận hành",
        rootCause: "Pool connection cạn kiệt",
        resolution: "Tăng max_connections lên 200",
        relatedTickets: ["TECH-776"],
      });

      const related = await client.queryRelatedTickets({
        system: "TUTOR_Vuihoc",
        limit: 5,
      });

      expect(related.length).toBeGreaterThanOrEqual(1);
      const matched = related.find((r) => r.identifier === testKey);
      expect(matched).toBeDefined();
      expect(matched?.system).toBe("TUTOR_Vuihoc");
      expect(matched?.rootCause).toBe("Pool connection cạn kiệt");
      expect(matched?.resolution).toBe("Tăng max_connections lên 200");

      const stats = await client.getGraphStats();
      expect(stats.nodes).toBeGreaterThanOrEqual(1);
      expect(stats.edges).toBeGreaterThanOrEqual(1);

      await wipeTestTicket(client, testKey);
    } finally {
      await client.close();
    }
  }, 15000);

  it("upsert lại cùng 1 ticket với RootCause đổi text không tạo cạnh CAUSED_BY trùng lặp", async () => {
    const client = new MemgraphClient();
    try {
      const testKey = `TEST-KG-IDEMPOTENT-${Date.now()}`;
      await client.upsertTicketNode({
        identifier: testKey,
        title: "Gắn sai KQ bài test",
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        rootCause: "Chưa rõ nguyên nhân - Gắn sai KQ bài test môn KHTN vào môn Toán",
        resolution: "Đã gỡ và gắn lại đúng môn",
      });

      // Đồng bộ lại lần 2: cùng ticket nhưng chuỗi rootCause lệch 1 ký tự
      // (đúng kịch bản gây ra node đôi 290/773 trong báo cáo audit)
      await client.upsertTicketNode({
        identifier: testKey,
        title: "Gắn sai KQ bài test",
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        rootCause: "Chưa rõ nguyên nhân  Gắn sai KQ bài test môn KHTN vào môn Toán",
        resolution: "Đã gỡ và gắn lại đúng môn",
      });

      const session = (client as any).driver.session();
      try {
        const res = await session.run(
          `MATCH (t:Ticket {identifier: $id})-[r:CAUSED_BY]->(rc:RootCause) RETURN rc.text AS text`,
          { id: testKey },
        );
        expect(res.records.length).toBe(1);
        expect(res.records[0].get("text")).toBe(
          "Chưa rõ nguyên nhân  Gắn sai KQ bài test môn KHTN vào môn Toán",
        );
        // RootCause của lần upsert ĐẦU bị bỏ lại mồ côi một cách có chủ đích
        // (đúng hành vi: chỉ xoá cạnh CAUSED_BY cũ, không xoá node cũ — xem
        // ghi chú "Nợ kỹ thuật còn lại" trong đánh giá KG) — dọn tay ở đây để
        // không để rác lại trên Memgraph dùng chung.
        await session.run(
          `MATCH (rc:RootCause {text: "Chưa rõ nguyên nhân - Gắn sai KQ bài test môn KHTN vào môn Toán"}) DETACH DELETE rc`,
        );
      } finally {
        await session.close();
      }

      await wipeTestTicket(client, testKey);
    } finally {
      await client.close();
    }
  }, 15000);

  it("queryRelatedTickets gom được 2 ticket cùng causeTaxon dù khác system/chữ (mục tiêu của taxonomy)", async () => {
    const client = new MemgraphClient();
    const keyA = `TEST-KG-TAXON-A-${Date.now()}`;
    const keyB = `TEST-KG-TAXON-B-${Date.now()}`;
    try {
      // 2 ticket khác hệ thống, rootCause diễn đạt hoàn toàn khác chữ, nhưng
      // cùng CƠ CHẾ lỗi (ACCOUNT_LINK_DUPLICATE) — trước khi có taxonomy,
      // không cách nào để 2 ticket này match nhau qua system/keyword literal.
      await client.upsertTicketNode({
        identifier: keyA,
        title: "CRM không tạo được đơn do trùng tài khoản",
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        system: "CRM_Vuihoc",
        causeTaxon: "ACCOUNT_LINK_DUPLICATE",
        rootCause: "Hồ sơ bị gắn trùng tài khoản Vuihoc do mapping nhầm",
        resolution: "Gỡ liên kết trùng",
      });
      await client.upsertTicketNode({
        identifier: keyB,
        title: "Gia sư báo hai bản ghi học sinh dính chung 1 SID",
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        system: "TUTOR_Vuihoc (ERP/APP/WEB_Gia sư)",
        causeTaxon: "ACCOUNT_LINK_DUPLICATE",
        rootCause: "Hai hồ sơ trùng SID do cùng tên học sinh",
        resolution: "Tách lại SID cho đúng",
      });

      // Truy vấn xuất phát từ context của ticket A (system CRM) nhưng phải tìm
      // ra ticket B — không thể qua system (khác nhau) hay keyword literal
      // (chữ khác hoàn toàn) — CHỈ có thể qua causeTaxon.
      const related = await client.queryRelatedTickets({
        causeTaxon: "ACCOUNT_LINK_DUPLICATE",
        excludeIdentifier: keyA,
        limit: 5,
      });
      expect(related.some((r) => r.identifier === keyB)).toBe(true);

      await wipeTestTicket(client, keyA);
      await wipeTestTicket(client, keyB);
    } finally {
      await client.close();
    }
  }, 15000);

  it("queryRelatedTickets KHÔNG match 2 ticket chỉ vì cùng INSUFFICIENT_INFO/OTHER_NEW_PATTERN (không phải cơ chế lỗi thật)", async () => {
    const client = new MemgraphClient();
    const keyA = `TEST-KG-NOMATCH-A-${Date.now()}`;
    const keyB = `TEST-KG-NOMATCH-B-${Date.now()}`;
    try {
      await client.upsertTicketNode({
        identifier: keyA,
        title: "Ticket A không có log",
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        causeTaxon: "INSUFFICIENT_INFO",
        rootCause: "Không có log để xác định nguyên nhân",
        resolution: "Đã đóng ticket",
      });
      await client.upsertTicketNode({
        identifier: keyB,
        title: "Ticket B hoàn toàn không liên quan, cũng thiếu log",
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        causeTaxon: "INSUFFICIENT_INFO",
        rootCause: "Thiếu thông tin môi trường để điều tra",
        resolution: "Đã đóng ticket",
      });

      const related = await client.queryRelatedTickets({
        causeTaxon: "INSUFFICIENT_INFO",
        excludeIdentifier: keyA,
        limit: 5,
      });
      // Không được match — "cùng chưa rõ nguyên nhân" không phải tín hiệu tương tự
      expect(related.some((r) => r.identifier === keyB)).toBe(false);

      await wipeTestTicket(client, keyA);
      await wipeTestTicket(client, keyB);
    } finally {
      await client.close();
    }
  }, 15000);

  it("taxon là tín hiệu ĐỦ: cùng causeTaxon mà chữ khác hoàn toàn vẫn phải qua ngưỡng minScore của pipeline (5)", async () => {
    const client = new MemgraphClient();
    const keyA = `TEST-KG-TAXONSUF-A-${Date.now()}`;
    const keyB = `TEST-KG-TAXONSUF-B-${Date.now()}`;
    // Taxon riêng cho test: nếu dùng ACCOUNT_LINK_DUPLICATE (có trong graph
    // thật) thì các ticket thật cùng taxon chiếm hết `limit` và test bị nhiễu.
    const taxon = `TEST_TAXON_SUFFICIENT_${Date.now()}`;
    try {
      // Test cũ (dòng ~125) gọi KHÔNG có keywords nên minScore rơi về 3 —
      // taxon 4 điểm lọt qua, che mất lỗi. Pipeline thật
      // (intake-step/pipeline.ts lookupKnowledgeGraph) truyền minScore: 5 +
      // requireKeywordMatch, nên ticket cùng cơ chế lỗi nhưng viết khác chữ
      // bị cắt chết → cả tính năng taxonomy thành vô dụng trên luồng thật.
      await client.upsertTicketNode({
        identifier: keyA,
        title: "CRM không tạo được đơn do trùng tài khoản",
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        system: "CRM_Vuihoc",
        causeTaxon: taxon,
        rootCause: "Hồ sơ bị gắn trùng tài khoản Vuihoc do mapping nhầm",
      });
      await client.upsertTicketNode({
        identifier: keyB,
        title: "Gia sư báo hai bản ghi học sinh dính chung 1 SID",
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        system: "TUTOR_Vuihoc (ERP/APP/WEB_Gia sư)",
        causeTaxon: taxon,
        rootCause: "Hai hồ sơ trùng SID do cùng tên học sinh",
      });

      const related = await client.queryRelatedTickets({
        system: "CRM_Vuihoc",
        causeTaxon: taxon,
        // Từ khoá không có trong bất kỳ ticket nào (kể cả A/B) để kết quả chỉ
        // còn phụ thuộc tín hiệu taxon — đúng câu hỏi của test.
        keywords: ["zzquniquekw"],
        excludeIdentifier: keyA,
        minScore: 5,
        requireKeywordMatch: true,
        limit: 5,
      });
      expect(related.some((r) => r.identifier === keyB)).toBe(true);

      await wipeTestTicket(client, keyA);
      await wipeTestTicket(client, keyB);
      const s = (client as any).driver.session();
      await s.run(`MATCH (ct:CauseTaxon {id: $t}) DETACH DELETE ct`, { t: taxon }).catch(() => {});
      await s.close();
    } finally {
      await client.close();
    }
  }, 15000);

  it("relatedTickets trỏ tới ticket CHƯA có trong graph thì KHÔNG tạo node ma, chỉ bỏ cạnh", async () => {
    const client = new MemgraphClient();
    const keySelf = `TEST-KG-GHOST-SELF-${Date.now()}`;
    // Mã ticket hợp lệ về cú pháp nhưng CHƯA từng được sync vào KG — đúng
    // nguồn gốc của 19 node ma (TECH-447, TECH-801, ...) đang nằm trong graph
    // thật: chúng chỉ có property "identifier" và không có cạnh nào ra.
    const ghostKey = `TEST-KG-GHOST-ABSENT-${Date.now()}`;
    try {
      await client.upsertTicketNode({
        identifier: keySelf,
        title: "Ticket có tham chiếu tới ticket chưa sync",
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        rootCause: "Nguyên nhân thật để node này không bị coi là ma",
        relatedTickets: [ghostKey],
      });

      const session = (client as any).driver.session();
      try {
        // 1. Không được sinh node Ticket cho mã chưa tồn tại
        const ghost = await session.run(`MATCH (t:Ticket {identifier: $id}) RETURN count(t) AS c`, {
          id: ghostKey,
        });
        expect(ghost.records[0].get("c").toNumber()).toBe(0);

        // 2. Và không được có cạnh RELATES_TO trỏ tới hư không
        const edges = await session.run(
          `MATCH (a:Ticket {identifier: $id})-[r:RELATES_TO]->() RETURN count(r) AS c`,
          { id: keySelf },
        );
        expect(edges.records[0].get("c").toNumber()).toBe(0);
      } finally {
        await session.close();
      }

      await wipeTestTicket(client, keySelf);
    } finally {
      await client.close();
    }
  }, 15000);

  it("queryRelatedTickets KHÔNG trả ticket Canceled — chúng không còn là tri thức đáng gợi ý", async () => {
    const client = new MemgraphClient();
    const keyQ = `TEST-KG-CANCEL-Q-${Date.now()}`;
    const keyC = `TEST-KG-CANCEL-C-${Date.now()}`;
    try {
      // Token gần như chắc chắn không có trong ticket thật → keyC là ứng viên
      // DUY NHẤT trong kết quả; nếu query không lọc Canceled thì nó sẽ lộ ra.
      const token = "zqxonlycancel";
      await client.upsertTicketNode({
        identifier: keyC,
        title: `Sự cố ${token} đã bị huỷ`,
        status: "Canceled",
        priority: "medium",
        createdAt: new Date().toISOString(),
        system: "TUTOR_Vuihoc",
        rootCause: "Nguyên nhân đã hết thời hiệu",
      });
      await client.upsertTicketNode({
        identifier: keyQ,
        title: `Ticket truy vấn ${token}`,
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        system: "TUTOR_Vuihoc",
        rootCause: "Nguyên nhân khác",
      });

      const related = await client.queryRelatedTickets({
        keywords: [token],
        excludeIdentifier: keyQ,
        minScore: 5,
        limit: 5,
      });
      expect(related.some((r) => r.identifier === keyC)).toBe(false);

      await wipeTestTicket(client, keyQ);
      await wipeTestTicket(client, keyC);
    } finally {
      await client.close();
    }
  }, 15000);

  it("time-decay: tín hiệu cộng điểm không thắng được ticket cũ hơn nửa tuổi thọ (14 ngày)", async () => {
    const client = new MemgraphClient();
    const keyQ = `TEST-KG-DECAY-Q-${Date.now()}`;
    const keyOld = `TEST-KG-DECAY-OLD-${Date.now()}`;
    const keyNew = `TEST-KG-DECAY-NEW-${Date.now()}`;
    try {
      // Token duy nhất để 2 ticket này là 2 ứng viên duy nhất.
      // keyOld CÓ điểm cộng system (+3), keyNew không → code không decay
      // sẽ xếp keyOld trước. Có decay (half-life 14 ngày) thì hệ số của
      // keyOld (~60 ngày tuổi ≈ 0.05) không đủ bù +3 → keyNew phải lên trước.
      const token = "zqxdecaypair";
      const now = Date.now();
      await client.upsertTicketNode({
        identifier: keyOld,
        title: `Sự cố ${token} bản cũ`,
        status: "Done",
        priority: "medium",
        createdAt: new Date(now - 60 * 24 * 3600 * 1000).toISOString(),
        system: "ERP_Vuihoc",
        rootCause: "Nguyên nhân bản cũ",
      });
      await client.upsertTicketNode({
        identifier: keyNew,
        title: `Sự cố ${token} bản mới`,
        status: "Done",
        priority: "medium",
        createdAt: new Date(now).toISOString(),
        system: "APP_Vuihoc",
        rootCause: "Nguyên nhân bản mới",
      });
      await client.upsertTicketNode({
        identifier: keyQ,
        title: `Ticket truy vấn ${token}`,
        status: "Done",
        priority: "medium",
        createdAt: new Date(now).toISOString(),
        system: "WEB_Vuihoc",
        rootCause: "Nguyên nhân truy vấn",
      });

      const related = await client.queryRelatedTickets({
        system: "ERP_Vuihoc",
        keywords: [token],
        excludeIdentifier: keyQ,
        minScore: 5,
        limit: 10,
      });
      const iOld = related.findIndex((r) => r.identifier === keyOld);
      const iNew = related.findIndex((r) => r.identifier === keyNew);
      expect(iOld).toBeGreaterThanOrEqual(0);
      expect(iNew).toBeGreaterThanOrEqual(0);
      expect(iNew).toBeLessThan(iOld);

      await wipeTestTicket(client, keyQ);
      await wipeTestTicket(client, keyOld);
      await wipeTestTicket(client, keyNew);
    } finally {
      await client.close();
    }
  }, 15000);

  it("relatedTickets trỏ tới ticket ĐÃ có trong graph thì vẫn nối RELATES_TO bình thường", async () => {
    const client = new MemgraphClient();
    const keyA = `TEST-KG-REL-A-${Date.now()}`;
    const keyB = `TEST-KG-REL-B-${Date.now()}`;
    try {
      // B phải tồn tại TRƯỚC (đã sync) — đây là điều kiện để cạnh được tạo,
      // thay cho hành vi cũ: cứ thấy mã là tạo node giữ chỗ.
      await client.upsertTicketNode({
        identifier: keyB,
        title: "Ticket đích đã có trong graph",
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        rootCause: "Nguyên nhân của ticket đích",
      });
      await client.upsertTicketNode({
        identifier: keyA,
        title: "Ticket nguồn tham chiếu ticket đích",
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        rootCause: "Nguyên nhân của ticket nguồn",
        relatedTickets: [keyB],
      });

      const session = (client as any).driver.session();
      try {
        const res = await session.run(
          `MATCH (a:Ticket {identifier: $a})-[r:RELATES_TO]-(b:Ticket {identifier: $b})
           RETURN count(r) AS c`,
          { a: keyA, b: keyB },
        );
        expect(res.records[0].get("c").toNumber()).toBeGreaterThanOrEqual(1);
      } finally {
        await session.close();
      }

      await wipeTestTicket(client, keyA);
      await wipeTestTicket(client, keyB);
    } finally {
      await client.close();
    }
  }, 15000);
});

// Các test dưới từng nằm NGOÀI describe.skipIf → luôn chạy vào Memgraph mặc định
// (localhost:7687 = KG thật). Đó là đường 19 node TEST-KG-* lọt vào KG TECH 25/09.
describe.skipIf(!memgraphUp)("MemgraphClient Cypher Tests (tiếp)", () => {
  it("re-sync với relatedTickets rỗng/xoá bớt thì cạnh RELATES_TO cũ PHẢI bị gỡ, không sống sót", async () => {
    const client = new MemgraphClient();
    const keyA = `TEST-KG-RELSYNC-A-${Date.now()}`;
    const keyB = `TEST-KG-RELSYNC-B-${Date.now()}`;
    const keyC = `TEST-KG-RELSYNC-C-${Date.now()}`;
    try {
      // B, C tồn tại trước
      for (const k of [keyB, keyC]) {
        await client.upsertTicketNode({
          identifier: k,
          title: "Ticket đích",
          status: "Done",
          priority: "medium",
          createdAt: new Date().toISOString(),
          rootCause: "Nguyên nhân đích",
        });
      }
      // Lần 1: A relates tới B và C
      await client.upsertTicketNode({
        identifier: keyA,
        title: "Ticket nguồn",
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        rootCause: "Nguyên nhân nguồn",
        relatedTickets: [keyB, keyC],
      });

      const session = (client as any).driver.session();
      const countEdges = async () => {
        const r = await session.run(
          `MATCH (a:Ticket {identifier: $a})-[r:RELATES_TO]-(b:Ticket)
           WHERE b.identifier IN [$b, $c] RETURN count(r) AS c`,
          { a: keyA, b: keyB, c: keyC },
        );
        return r.records[0].get("c").toNumber();
      };
      expect(await countEdges()).toBe(2);

      // Lần 2: người gỡ liên kết tới C trên Itsaplan → sync lại chỉ còn B.
      // Bài học tech lead: 158/158 lượt link_remove là do người; KG cũ giữ cạnh
      // vĩnh viễn nên gợi ý lại đúng cái người đã xoá.
      await client.upsertTicketNode({
        identifier: keyA,
        title: "Ticket nguồn",
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        rootCause: "Nguyên nhân nguồn",
        relatedTickets: [keyB],
      });

      const after = await session.run(
        `MATCH (a:Ticket {identifier: $a})-[r:RELATES_TO]-(b:Ticket {identifier: $c})
         RETURN count(r) AS c`,
        { a: keyA, c: keyC },
      );
      expect(after.records[0].get("c").toNumber()).toBe(0);
      expect(await countEdges()).toBe(1);

      await session.close();
      await wipeTestTicket(client, keyA);
      await wipeTestTicket(client, keyB);
      await wipeTestTicket(client, keyC);
    } finally {
      await client.close();
    }
  }, 15000);

  it("re-sync với relatedTickets rỗng thì gỡ HẾT cạnh RELATES_TO của ticket đó", async () => {
    const client = new MemgraphClient();
    const keyA = `TEST-KG-RELZERO-A-${Date.now()}`;
    const keyB = `TEST-KG-RELZERO-B-${Date.now()}`;
    try {
      await client.upsertTicketNode({
        identifier: keyB,
        title: "Ticket đích",
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        rootCause: "Nguyên nhân đích",
      });
      await client.upsertTicketNode({
        identifier: keyA,
        title: "Ticket nguồn",
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        rootCause: "Nguyên nhân nguồn",
        relatedTickets: [keyB],
      });
      await client.upsertTicketNode({
        identifier: keyA,
        title: "Ticket nguồn",
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        rootCause: "Nguyên nhân nguồn",
        relatedTickets: [],
      });

      const session = (client as any).driver.session();
      const r = await session.run(
        `MATCH (a:Ticket {identifier: $a})-[r:RELATES_TO]-() RETURN count(r) AS c`,
        { a: keyA },
      );
      expect(r.records[0].get("c").toNumber()).toBe(0);
      await session.close();

      await wipeTestTicket(client, keyA);
      await wipeTestTicket(client, keyB);
    } finally {
      await client.close();
    }
  }, 15000);

  // Re-sync một ticket với metadata khác (kỹ thuật viên sửa Hệ thống/Sản phẩm
  // rồi Done lại) phải THAY cạnh cũ, không cộng thêm — trước đây cạnh cũ sống
  // sót nên ticket vừa IN_SYSTEM A vừa IN_SYSTEM B.
  it("re-sync với system/product/category/dept khác thì chỉ còn cạnh mới", async () => {
    const client = new MemgraphClient();
    const id = `TEST-KG-RESYNC-${Date.now()}`;
    try {
      const base = {
        identifier: id,
        title: "Re-sync đổi metadata",
        status: "Done",
        priority: "low",
        createdAt: new Date().toISOString(),
      };
      await client.upsertTicketNode({
        ...base,
        system: "TEST_SYS_OLD",
        product: "TEST_PROD_OLD",
        errorCategory: "TEST_CAT_OLD",
        reportingDept: "TEST_DEPT_OLD",
      });
      await client.upsertTicketNode({
        ...base,
        system: "TEST_SYS_NEW",
        product: "TEST_PROD_NEW",
        errorCategory: "TEST_CAT_NEW",
        reportingDept: "TEST_DEPT_NEW",
      });

      const session = (client as any).driver.session();
      try {
        const res = await session.run(
          `MATCH (t:Ticket {identifier: $id})-[r:IN_SYSTEM|OF_PRODUCT|HAS_CATEGORY|REPORTED_BY]->(n)
           RETURN type(r) AS rel, n.name AS name ORDER BY rel`,
          { id },
        );
        const edges = res.records.map((r: any) => `${r.get("rel")}:${r.get("name")}`);
        expect(edges).toEqual([
          "HAS_CATEGORY:TEST_CAT_NEW",
          "IN_SYSTEM:TEST_SYS_NEW",
          "OF_PRODUCT:TEST_PROD_NEW",
          "REPORTED_BY:TEST_DEPT_NEW",
        ]);

        // Re-sync thiếu metadata (không còn Hệ thống) thì cạnh cũ cũng phải đi.
        await client.upsertTicketNode({ ...base });
        const after = await session.run(
          `MATCH (t:Ticket {identifier: $id})-[r:IN_SYSTEM|OF_PRODUCT|HAS_CATEGORY|REPORTED_BY]->() RETURN count(r) AS n`,
          { id },
        );
        expect(after.records[0].get("n").toNumber()).toBe(0);
      } finally {
        await session.close();
      }
    } finally {
      await wipeTestTicket(client, id);
      // Node System/Product/... do chính test tạo (tên TEST_*) — dọn luôn.
      const session = (client as any).driver.session();
      try {
        await session.run(
          `MATCH (n) WHERE (n:System OR n:Product OR n:Category OR n:Department) AND n.name STARTS WITH "TEST_" DETACH DELETE n`,
        );
      } finally {
        await session.close();
      }
      await client.close();
    }
  });

  // RESOLVED_BY treo ở RootCause dùng chung theo text: 2 ticket cùng nguyên nhân
  // nhưng giải pháp khác nhau → export ghép chéo (ticket A kèm giải pháp của B).
  it("listResolvedTicketsForExport chỉ ghép ticket với giải pháp của chính nó", async () => {
    const client = new MemgraphClient();
    const stamp = Date.now();
    const a = `TEST-KG-EXPA-${stamp}`;
    const b = `TEST-KG-EXPB-${stamp}`;
    const sharedCause = `TEST nguyên nhân dùng chung ${stamp}`;
    try {
      const common = {
        status: "Done",
        priority: "low",
        createdAt: new Date().toISOString(),
        rootCause: sharedCause,
      };
      await client.upsertTicketNode({
        ...common,
        identifier: a,
        title: "A",
        resolution: `TEST giải pháp A ${stamp}`,
      });
      await client.upsertTicketNode({
        ...common,
        identifier: b,
        title: "B",
        resolution: `TEST giải pháp B ${stamp}`,
      });

      const rows = (await client.listResolvedTicketsForExport()).filter(
        (r) => r.identifier === a || r.identifier === b,
      );
      expect(rows.map((r) => `${r.identifier}=${r.resolution}`).sort()).toEqual([
        `${a}=TEST giải pháp A ${stamp}`,
        `${b}=TEST giải pháp B ${stamp}`,
      ]);
    } finally {
      await wipeTestTicket(client, a);
      await wipeTestTicket(client, b);
      await client.close();
    }
  });

  // Bài học tech lead (audit 25/09 — 158/158 lượt link_remove là người gỡ):
  // khi người gỡ liên kết giữa A và B, KG phải ghi nhận cạnh REJECTED_RELATION
  // để queryRelatedTickets KHÔNG BAO GIỜ gợi ý lại B khi truy vấn cho A.
  it("negativeTickets: ticket bị người gỡ (REJECTED_RELATION) không bao giờ xuất hiện lại trong queryRelatedTickets", async () => {
    const client = new MemgraphClient();
    const keyA = `TEST-KG-NEG-A-${Date.now()}`;
    const keyB = `TEST-KG-NEG-B-${Date.now()}`;
    try {
      // B là ticket cùng system và khớp keyword rất mạnh với A
      const token = "zznegrelationtest";
      await client.upsertTicketNode({
        identifier: keyB,
        title: `Sự cố ${token} trên CRM`,
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        system: "CRM_Vuihoc",
        rootCause: "Nguyên nhân CRM",
      });
      // A có B trong negativeTickets (tech lead đã gỡ)
      await client.upsertTicketNode({
        identifier: keyA,
        title: `Ticket truy vấn ${token}`,
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        system: "CRM_Vuihoc",
        rootCause: "Nguyên nhân truy vấn",
        negativeTickets: [keyB],
      });

      const related = await client.queryRelatedTickets({
        system: "CRM_Vuihoc",
        keywords: [token],
        // Khi tra cứu cho keyA, truyền excludeIdentifier hoặc queryRelatedTickets
        // tự phát hiện qua cạnh REJECTED_RELATION từ query ticket
        forTicket: keyA,
        minScore: 5,
        limit: 5,
      });

      expect(related.some((r) => r.identifier === keyB)).toBe(false);

      await wipeTestTicket(client, keyA);
      await wipeTestTicket(client, keyB);
    } finally {
      await client.close();
    }
  }, 15000);

  // ADR-0007 (26/09): không còn mở rộng cụm theo RELATES_TO. Ticket tương tự =
  // cụm nguyên nhân người xác định, tính lại sau mỗi lần nạp.
  it("recomputeCauseClusters + loadSimilarityCorpus: gộp theo câu người viết, cấm theo link người gỡ, chỉ đúng dự án", async () => {
    const client = new MemgraphClient();
    const project = `ZZTEST${Date.now()}`;
    const id = (n: number) => `${project}-${n}`;
    const base = { status: "Done", priority: "medium", createdAt: new Date().toISOString() };
    try {
      await client.upsertTicketNode({
        ...base,
        identifier: id(1),
        title: "Trùng tài khoản con",
        humanCause: "Bị gắn trùng tk học do cùng tên",
      });
      await client.upsertTicketNode({
        ...base,
        identifier: id(2),
        title: "Không lên được đơn",
        humanCause: "Bị gắn trùng tk học cho con cùng tên",
      });
      await client.upsertTicketNode({
        ...base,
        identifier: id(3),
        title: "Trùng tk khi book test",
        humanCause: "Bị gắn trùng tk học do cùng tên",
        negativeTickets: [id(1)],
      });
      await client.upsertTicketNode({
        ...base,
        identifier: id(4),
        title: "Chưa ghim",
        relatedTickets: [id(2)],
      });
      await client.upsertTicketNode({
        ...base,
        identifier: id(5),
        title: "Đã huỷ",
        status: "Canceled",
        humanCause: "Bị gắn trùng tk học do cùng tên",
      });
      await client.upsertTicketNode({
        ...base,
        identifier: id(6),
        title: "Zalo lag",
        itSupport: true,
        humanCause: "Máy tính yếu",
      });

      await client.recomputeCauseClusters();
      const corpus = await client.loadSimilarityCorpus(project);
      const cluster = new Map(corpus.map((t) => [t.identifier, t.causeCluster]));

      expect(corpus.map((t) => t.identifier).sort()).toEqual([id(1), id(2), id(3), id(4), id(6)]); // IT Support vẫn trong kho
      expect(cluster.get(id(2))).toBe(cluster.get(id(1)));
      expect(cluster.get(id(4))).toBe(cluster.get(id(1))); // link người gắn
      expect(cluster.get(id(3))).not.toBe(cluster.get(id(1))); // người đã gỡ 3↔1
      expect(corpus.find((t) => t.identifier === id(1))?.humanCause).toBe(
        "Bị gắn trùng tk học do cùng tên",
      );
    } finally {
      for (let n = 1; n <= 6; n++) await wipeTestTicket(client, id(n));
      await client.close();
    }
  }, 20000);

  it("upsertTicketNode + loadSimilarityCorpus: description/humanNotes/system/product đi vòng đủ (27/09)", async () => {
    const client = new MemgraphClient();
    const project = `ZZCTX${Date.now()}`;
    const id = `${project}-1`;
    try {
      await client.upsertTicketNode({
        status: "Done",
        priority: "medium",
        createdAt: new Date().toISOString(),
        identifier: id,
        title: "Trùng tài khoản",
        description: "Không lên được đơn do trùng tài khoản Vuihoc.",
        humanNotes: "**Nguyên nhân:** Trùng tài khoản do cùng tên.",
        system: "Vuihoc (App/Web_Vuihoc)",
        product: "Duo",
      });
      const corpus = await client.loadSimilarityCorpus(project);
      const ticket = corpus.find((t) => t.identifier === id);
      expect(ticket?.description).toBe("Không lên được đơn do trùng tài khoản Vuihoc.");
      expect(ticket?.humanNotes).toBe("**Nguyên nhân:** Trùng tài khoản do cùng tên.");
      expect(ticket?.system).toBe("Vuihoc (App/Web_Vuihoc)");
      expect(ticket?.product).toBe("Duo");
    } finally {
      await wipeTestTicket(client, id);
      await client.close();
    }
  }, 15000);

  it("nạp lại ticket A không xoá cạnh RELATES_TO do ticket B mang tới A", async () => {
    const client = new MemgraphClient();
    const project = `ZZEDGE${Date.now()}`;
    const [a, b] = [`${project}-1`, `${project}-2`];
    const base = { status: "Done", priority: "medium", createdAt: new Date().toISOString() };
    try {
      await client.upsertTicketNode({ ...base, identifier: a, title: "A" });
      await client.upsertTicketNode({ ...base, identifier: b, title: "B", relatedTickets: [a] });
      await client.upsertTicketNode({
        ...base,
        identifier: a,
        title: "A nạp lại",
        relatedTickets: [],
      });
      const s = (client as any).driver.session();
      const res = await s.run(
        `MATCH (:Ticket {identifier: $a})-[r:RELATES_TO]-(:Ticket {identifier: $b}) RETURN count(r) AS c`,
        { a, b },
      );
      await s.close();
      expect(res.records[0].get("c").toNumber()).toBe(1);
    } finally {
      await wipeTestTicket(client, a);
      await wipeTestTicket(client, b);
      await client.close();
    }
  }, 15000);

  it("ensureIndexes() idempotent — gọi 2 lần liên tiếp không throw", async () => {
    // Audit P3: SHOW INDEX INFO ban đầu rỗng. ensureIndexes() phải đảm bảo
    // RootCause/Resolution luôn có index sau khi worker khởi động, đồng thời
    // KHÔNG phát sinh lỗi khi index đã tồn tại (idempotent cho cả lần 2 trở đi
    // — restart worker không được làm rơi luồng chính).
    const client = new MemgraphClient();
    try {
      // Lần 1: tạo index. Vì trên Memgraph dùng chung có thể đã có sẵn index
      // từ lần chạy trước, nhưng dù sao cũng phải resolve thành công.
      await client.ensureIndexes();
      // Lần 2: bắt buộc vẫn không throw. Đây là điều kiện idempotent cốt lõi
      // — nếu CREATE INDEX không có ASSERT ném lỗi khi trùng, restart worker
      // sẽ liên tục crash ở dòng này.
      await client.ensureIndexes();
    } finally {
      await client.close();
    }
  }, 15000);
});

describe("MemgraphClient connection-timeout regression (audit P1)", () => {
  // Bật SKIP_NET_HOLES=1 để skip ở CI / dev không có quyền mở TCP server.
  const skip = process.env.SKIP_NET_HOLES === "1";
  const maybeTest = skip ? it.skip : it;

  maybeTest(
    "upsertTicketNode trả lỗi trong <6s khi bolt server hứa TCP nhưng không phản hồi (black-hole)",
    async () => {
      const net = await import("net");
      // TCP server nhận kết nối nhưng KHÔNG gửi bất kỳ byte nào — đúng kịch bản
      // P1 quan sát: bolt server treo 60.1s = neo4j-driver DEFAULT_POOL_ACQUISITION_TIMEOUT.
      // Ta neo lên port 9999 để không đụng Memgraph thật.
      const hole = net.createServer((sock) => {
        // Cố tình KHÔNG sock.write(...). Không đóng socket. Không phản hồi handshake.
        // Giữ tham chiếu để socket không bị GC.
        sockets.push(sock);
      });
      const sockets: Socket[] = [];
      await new Promise<void>((resolve) => hole.listen(9999, "127.0.0.1", () => resolve()));
      try {
        const client = new MemgraphClient({
          uri: "bolt://127.0.0.1:9999",
          username: "",
          password: "",
        });
        try {
          const started = Date.now();
          let err: unknown;
          // Đo: phải lỗi (hoặc throw, hoặc rethrow từ upsertTicketNode) trong <6s.
          // Ngân sách 5s ở driver + 1s slack cho GC/scheduler.
          try {
            await client.upsertTicketNode({
              identifier: "TEST-BLACKHOLE",
              title: "Sự cố test black-hole",
              status: "Open",
              priority: "low",
              createdAt: new Date().toISOString(),
            });
          } catch (e) {
            err = e;
          }
          const elapsed = Date.now() - started;
          // In ra để debug khi timing race xảy ra trên máy chậm.
          // eslint-disable-next-line no-console
          console.log(
            `[blackhole] elapsed=${elapsed}ms err=${(err as Error)?.message ?? "<none>"}`,
          );
          expect(err).toBeDefined();
          expect(elapsed).toBeLessThan(6000);
        } finally {
          // Đóng driver best-effort — không cần assert, vì bản thân close()
          // đã được Promise-race bởi withQueryTimeout ở production path.
          await Promise.race([
            client.close(),
            new Promise<void>((resolve) => setTimeout(resolve, 6000)),
          ]).catch(() => {});
        }
      } finally {
        // Dọn socket để port 9999 được giải phóng cho test kế tiếp.
        for (const s of sockets) s.destroy();
        await new Promise<void>((resolve) => hole.close(() => resolve()));
      }
    },
    8000,
  );
});
