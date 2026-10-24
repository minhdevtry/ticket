import neo4j from "neo4j-driver";
import { MemgraphClient, OWN_RESOLUTION_MATCH } from "./memgraph-client";
import type { GraphQueryResult } from "./types";
import { getLogger } from "../logger";

/**
 * Bộ truy vấn khai thác Knowledge Graph — dùng cho chat bot / dashboard.
 * Mỗi hàm trả về kết quả đã map sang kiểu dữ liệu gọn, an toàn JSON.
 */
export class KnowledgeGraphQueries {
  constructor(private readonly memgraph: MemgraphClient) {}

  /**
   * Top N nguyên nhân gốc rễ hay gặp nhất theo hệ thống.
   * Dùng khi cần tổng quan "vấn đề lặp lại" của một hệ thống.
   */
  async topRootCauses(system?: string, limit = 5): Promise<Array<{ rootCause: string; count: number; sampleTicket: string }>> {
    const session = this.memgraph["driver"].session();
    try {
      const cypher = system
        ? `MATCH (t:Ticket)-[:IN_SYSTEM]->(s:System {name: $system})
           MATCH (t)-[:CAUSED_BY]->(rc:RootCause)
           RETURN rc.text AS rootCause, count(t) AS count, collect(t.identifier)[0] AS sampleTicket
           ORDER BY count DESC LIMIT $limit`
        : `MATCH (t:Ticket)-[:CAUSED_BY]->(rc:RootCause)
           RETURN rc.text AS rootCause, count(t) AS count, collect(t.identifier)[0] AS sampleTicket
           ORDER BY count DESC LIMIT $limit`;
      const res = await session.run(cypher, { system: system || null, limit: neo4j.int(limit) });
      return res.records.map((r) => ({
        rootCause: r.get("rootCause"),
        count: r.get("count").toNumber?.() ?? Number(r.get("count")),
        sampleTicket: r.get("sampleTicket"),
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Đề xuất giải pháp cho sự cố mới: tìm các ticket cùng System/Category đã Done
   * có RootCause tương tự (theo từ khoá) và lấy Resolution.
   * Đây là truy vấn chính khi bot gợi ý cách xử lý cho KTV.
   */
  async suggestResolutions(params: {
    system?: string;
    errorCategory?: string;
    causeTaxon?: string;
    keywords: string[];
    limit?: number;
  }): Promise<GraphQueryResult[]> {
    const session = this.memgraph["driver"].session();
    const limit = params.limit ?? 3;
    try {
      // Tìm ticket Done có RootCause chứa ít nhất 1 từ khoá, ưu tiên cùng System/Category/CauseTaxon.
      // Dùng OPTIONAL MATCH + WITH + CASE (không phải pattern-predicate trực tiếp trong WHERE, và
      // không dùng regex =~) vì Memgraph không hỗ trợ đầy đủ 2 cú pháp đó — xem ghi chú lịch sử bug
      // (2 mệnh đề WHERE liên tiếp + flag "(?i)" trong regex khiến hàm này luôn throw và trả về [] âm thầm).
      const cypher = `
        ${OWN_RESOLUTION_MATCH}
        OPTIONAL MATCH (t)-[:IN_SYSTEM]->(sys:System)
        OPTIONAL MATCH (t)-[:HAS_CATEGORY]->(cat:Category)
        OPTIONAL MATCH (t)-[:CLASSIFIED_AS]->(ct:CauseTaxon)
        WITH t, rc, res, sys, cat, ct,
             ($system IS NULL OR $system = "" OR sys.name = $system) AS sysOk,
             ($errorCategory IS NULL OR $errorCategory = "" OR cat.name = $errorCategory) AS catOk,
             ($causeTaxon IS NULL OR $causeTaxon = "" OR ct.id = $causeTaxon) AS taxonOk,
             reduce(hit = false, kw IN $keywords |
               hit OR toLower(coalesce(rc.text, "")) CONTAINS toLower(kw)
                   OR toLower(coalesce(t.title, "")) CONTAINS toLower(kw)
             ) AS kwHit
        WHERE sysOk AND catOk AND taxonOk AND (size($keywords) = 0 OR kwHit)
        RETURN t.identifier AS identifier, t.title AS title, t.status AS status,
               sys.name AS system, ct.id AS causeTaxon, rc.text AS rootCause, res.text AS resolution
        ORDER BY t.resolvedAt DESC
        LIMIT $limit
      `;
      const res = await session.run(cypher, {
        system: params.system || null,
        errorCategory: params.errorCategory || null,
        causeTaxon: params.causeTaxon || null,
        keywords: params.keywords || [],
        limit: neo4j.int(limit),
      });
      return res.records.map((r) => ({
        identifier: r.get("identifier"),
        title: r.get("title") || "",
        status: r.get("status") || "Done",
        system: r.get("system") || undefined,
        causeTaxon: r.get("causeTaxon") || undefined,
        rootCause: r.get("rootCause") || undefined,
        resolution: r.get("resolution") || undefined,
      }));
    } catch (err: any) {
      getLogger().error(`[KnowledgeGraphQueries] Lỗi suggestResolutions: ${err.message}`);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * Thống kê tổng quan đồ thị theo từng loại node — dùng cho dashboard.
   */
  async statsByLabel(): Promise<Array<{ label: string; count: number }>> {
    const session = this.memgraph["driver"].session();
    try {
      const res = await session.run(`MATCH (n) RETURN labels(n)[0] AS label, count(*) AS count ORDER BY count DESC`);
      return res.records.map((r) => ({
        label: r.get("label") || "Unknown",
        count: r.get("count").toNumber?.() ?? Number(r.get("count")),
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Ticket có nhiều liên kết RELATES_TO nhất — "tâm chấn" sự cố.
   */
  async mostRelatedTickets(limit = 5): Promise<Array<{ identifier: string; title: string; related: number }>> {
    const session = this.memgraph["driver"].session();
    try {
      const res = await session.run(
        `MATCH (t:Ticket)
         WHERE t.title IS NOT NULL AND t.title <> ""
         MATCH (t)-[:RELATES_TO]-(other:Ticket)
         RETURN t.identifier AS identifier, t.title AS title, count(other) AS related
         ORDER BY related DESC LIMIT $limit`,
        { limit: neo4j.int(limit) },
      );
      return res.records.map((r) => ({
        identifier: r.get("identifier"),
        title: r.get("title") || "",
        related: r.get("related").toNumber?.() ?? Number(r.get("related")),
      }));
    } finally {
      await session.close();
    }
  }
}
