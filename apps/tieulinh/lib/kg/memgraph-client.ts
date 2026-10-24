import neo4j, { type Driver } from "neo4j-driver";
import type { TicketGraphNode, GraphQueryResult } from "./types";
import { getLogger } from "../logger";
import { buildCauseClusters } from "./cause-clusters";
import type { CorpusTicket } from "./similar-finder";

export interface MemgraphConfig {
  uri?: string;
  username?: string;
  password?: string;
}

/** Mặc định budget cho mỗi session.run: khớp với classifySymptomTaxon 8s
 * ở kg-sync.ts nhưng chặt hơn (5s) vì đây là đường I/O nội bộ tới Memgraph.
 * Driver-level acquisitionTimeout đã chốt ở 5s, per-query timeout chỉ là lưới
 * an toàn phòng trường hợp server nhận được query rồi treo không trả lời. */
const DEFAULT_QUERY_TIMEOUT_MS = 5000;
const DEFAULT_DRIVER_CONNECTION_TIMEOUT_MS = 5000;
const DEFAULT_DRIVER_ACQUISITION_TIMEOUT_MS = 5000;
const DEFAULT_DRIVER_MAX_CONNECTION_LIFETIME_MS = 30 * 60 * 1000;

/**
 * Ghép mỗi ticket với ĐÚNG giải pháp của nó.
 *
 * RESOLVED_BY treo ở RootCause, mà RootCause MERGE theo text nên dùng chung
 * giữa các ticket cùng nguyên nhân → đi (t)->(rc)->(res) là ghép chéo ticket A
 * với giải pháp của B. Ticket tự mang `t.resolution` nên chọn Resolution trùng
 * text đó. Dữ liệu cũ thiếu `t.resolution` chỉ được nhận khi RootCause có đúng
 * một giải pháp (không mơ hồ) — không cần migrate dữ liệu live.
 * Kết quả: các biến `t`, `rc`, `res` cho phần truy vấn phía sau.
 */
export const OWN_RESOLUTION_MATCH = `
        MATCH (t:Ticket)-[:CAUSED_BY]->(rc:RootCause)-[:RESOLVED_BY]->(r:Resolution)
        WITH t, rc, collect(r) AS resList
        UNWIND resList AS res
        WITH t, rc, res, size(resList) AS resCount
        WHERE res.text = t.resolution OR (t.resolution IS NULL AND resCount = 1)`;

export class MemgraphClient {
  private driver: Driver;

  constructor(config: MemgraphConfig = {}) {
    // Trong `bun test` không bao giờ tự rơi về Memgraph thật ở 7687: 25/09 một
    // lượt `bun test` trên server đã để lại 19 node TEST-KG-* trong KG TECH.
    // Test muốn chạm Memgraph phải đặt MEMGRAPH_TEST_URI (xem test-preload.ts).
    const fallback =
      process.env.NODE_ENV === "test" ? "bolt://127.0.0.1:1" : "bolt://localhost:7687";
    const uri = config.uri || process.env.MEMGRAPH_URI || fallback;
    const user = config.username || process.env.MEMGRAPH_USER || "";
    const pass = config.password || process.env.MEMGRAPH_PASS || "";
    // Đặt budget ở 3 tầng để bolt server hết hơi vẫn không kéo dài quá 5–6s:
    // 1) maxConnectionLifetime — đẩy connection cũ đi trước khi nó mục.
    // 2) connectionTimeout — TCP connect tới bolt port bị hãm (network black-hole).
    // 3) connectionAcquisitionTimeout — pool đã cạn, chờ lấy conn mới bị treo.
    // (Cảnh báo audit P1: neo4j-driver mặc định 60s acquisition → quá dài với
    // luồng Telegram real-time; mặc định 5s acquisitionTimeout đã được mirror
    // từ classifySymptomTaxon ở worker/kg-sync.ts.)
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, pass), {
      connectionTimeout: DEFAULT_DRIVER_CONNECTION_TIMEOUT_MS,
      connectionAcquisitionTimeout: DEFAULT_DRIVER_ACQUISITION_TIMEOUT_MS,
      maxConnectionLifetime: DEFAULT_DRIVER_MAX_CONNECTION_LIFETIME_MS,
    });
  }

  /** Race session.run với 1 timer — nếu Memgraph nhận query rồi treo không
   * trả lời (đã quan sát ở P1: bolt server treo đúng 60.1s = DEFAULT_POOL_ACQUISITION_TIMEOUT)
   * thì ném lỗi timeout thay vì để caller treo mãi. Lỗi được caller xử lý
   * theo cách riêng (upsertTicketNode: rethrow; queryRelatedTickets: nuốt + log).
   * Lưu ý: KHÔNG thay đổi finally của session — caller vẫn chịu trách nhiệm đóng. */
  private async withQueryTimeout<T>(
    promise: Promise<T>,
    label: string,
    timeoutMs: number = DEFAULT_QUERY_TIMEOUT_MS,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`[MemgraphClient] ${label} timeout sau ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  async ensureConstraints(): Promise<void> {
    const session = this.driver.session();
    try {
      await this.withQueryTimeout(
        session.run(`CREATE CONSTRAINT ON (t:Ticket) ASSERT t.identifier IS UNIQUE;`),
        "ensureConstraints:ticket",
      ).catch(() => {});
      await this.withQueryTimeout(
        session.run(`CREATE CONSTRAINT ON (s:System) ASSERT s.name IS UNIQUE;`),
        "ensureConstraints:system",
      ).catch(() => {});
      await this.withQueryTimeout(
        session.run(`CREATE CONSTRAINT ON (p:Product) ASSERT p.name IS UNIQUE;`),
        "ensureConstraints:product",
      ).catch(() => {});
      await this.withQueryTimeout(
        session.run(`CREATE CONSTRAINT ON (c:Category) ASSERT c.name IS UNIQUE;`),
        "ensureConstraints:category",
      ).catch(() => {});
      await this.withQueryTimeout(
        session.run(`CREATE CONSTRAINT ON (d:Department) ASSERT d.name IS UNIQUE;`),
        "ensureConstraints:department",
      ).catch(() => {});
      await this.withQueryTimeout(
        session.run(`CREATE CONSTRAINT ON (ct:CauseTaxon) ASSERT ct.id IS UNIQUE;`),
        "ensureConstraints:causetaxon",
      ).catch(() => {});
    } finally {
      await session.close();
    }
  }

  /** Tạo 2 index phụ trợ cho truy vấn theo text nguyên nhân / giải pháp:
   *  - SHOW INDEX INFO ban đầu rỗng khiến mọi MATCH theo rc.text / res.text
   *    phải scan toàn bộ node.
   *  - CREATE INDEX (không có ASSERT) idempotent: lần 2 trở đi memgraph báo
   *    "There is already an index" nhưng .catch(() => {}) nuốt lỗi.
   *  - Tách riêng khỏi ensureConstraints() để giữ blast-radius nhỏ: chỉ chạy
   *    1 lần ở worker startup; nếu sau này bổ sung index mới không phải sửa
   *    cả nhóm constraint. */
  async ensureIndexes(): Promise<void> {
    const session = this.driver.session();
    try {
      await this.withQueryTimeout(
        session.run(`CREATE INDEX ON :RootCause(text);`),
        "ensureIndexes:rootcause_idx",
      ).catch(() => {});
      await this.withQueryTimeout(
        session.run(`CREATE INDEX ON :Resolution(text);`),
        "ensureIndexes:resolution_idx",
      ).catch(() => {});
    } finally {
      await session.close();
    }
  }

  async upsertTicketNode(ticket: TicketGraphNode): Promise<void> {
    const session = this.driver.session();
    try {
      const cypher = `
        MERGE (t:Ticket {identifier: $identifier})
        SET t.title = $title,
            t.status = $status,
            t.priority = $priority,
            t.createdAt = $createdAt,
            t.resolvedAt = $resolvedAt,
            t.deviceType = $deviceType,
            t.deviceOs = $deviceOs,
            t.appVersion = $appVersion,
            t.assignmentId = $assignmentId,
            t.studentAccount = $studentAccount,
            t.customerId = $customerId,
            t.roomCode = $roomCode,
            t.rootCause = $rootCause,
            t.resolution = $resolution,
            t.symptomsText = $symptomsText,
            t.humanCause = $humanCause,
            t.humanFix = $humanFix,
            t.description = $description,
            t.humanNotes = $humanNotes,
            t.system = $system,
            t.product = $product,
            t.itSupport = $itSupport

        // Re-sync là THAY metadata, không cộng dồn: xoá mọi cạnh metadata cũ
        // của ticket rồi dựng lại từ dữ liệu hiện tại. Trước đây chỉ xoá
        // IN_SYSTEM trỏ vào nhãn rác, nên đổi Hệ thống/Sản phẩm rồi Done lại là
        // ticket dính cả cạnh cũ lẫn mới (cũng bao luôn trường hợp nhãn rác).
        WITH t
        OPTIONAL MATCH (t)-[oldMeta:IN_SYSTEM|OF_PRODUCT|HAS_CATEGORY|REPORTED_BY]->()
        DELETE oldMeta

        WITH DISTINCT t
        FOREACH (_ IN CASE WHEN $system IS NOT NULL AND $system <> '' THEN [1] ELSE [] END |
          MERGE (s:System {name: $system})
          MERGE (t)-[:IN_SYSTEM]->(s)
        )

        WITH t
        FOREACH (_ IN CASE WHEN $product IS NOT NULL AND $product <> '' THEN [1] ELSE [] END |
          MERGE (p:Product {name: $product})
          MERGE (t)-[:OF_PRODUCT]->(p)
        )

        WITH t
        FOREACH (_ IN CASE WHEN $errorCategory IS NOT NULL AND $errorCategory <> '' THEN [1] ELSE [] END |
          MERGE (c:Category {name: $errorCategory})
          MERGE (t)-[:HAS_CATEGORY]->(c)
        )

        WITH t
        FOREACH (_ IN CASE WHEN $reportingDept IS NOT NULL AND $reportingDept <> '' THEN [1] ELSE [] END |
          MERGE (d:Department {name: $reportingDept})
          MERGE (t)-[:REPORTED_BY]->(d)
        )

        WITH t
        OPTIONAL MATCH (t)-[oldCausedBy:CAUSED_BY]->(:RootCause)
        DELETE oldCausedBy

        WITH t
        FOREACH (_ IN CASE WHEN $rootCause IS NOT NULL AND $rootCause <> '' THEN [1] ELSE [] END |
          MERGE (rc:RootCause {text: $rootCause})
          MERGE (t)-[:CAUSED_BY]->(rc)
          FOREACH (__ IN CASE WHEN $resolution IS NOT NULL AND $resolution <> '' THEN [1] ELSE [] END |
            MERGE (res:Resolution {text: $resolution})
            MERGE (rc)-[:RESOLVED_BY]->(res)
          )
        )

        WITH t
        OPTIONAL MATCH (t)-[oldClassifiedAs:CLASSIFIED_AS]->(:CauseTaxon)
        DELETE oldClassifiedAs

        WITH t
        FOREACH (_ IN CASE WHEN $causeTaxon IS NOT NULL AND $causeTaxon <> '' THEN [1] ELSE [] END |
          MERGE (ct:CauseTaxon {id: $causeTaxon})
          MERGE (t)-[:CLASSIFIED_AS]->(ct)
        )

        WITH t
        // Cạnh RELATES_TO = tín hiệu dương của NGƯỜI mà CHÍNH ticket này mang
        // (ADR-0007) — thay chứ không cộng dồn. Chỉ xoá cạnh đi RA: cạnh do
        // ticket khác mang (vd người ghi mã ticket này vào trường của ticket
        // kia) không được mất khi ticket này nạp lại.
        OPTIONAL MATCH (t)-[oldRel:RELATES_TO]->()
        DELETE oldRel
        WITH t
        OPTIONAL MATCH (t)-[oldNeg:REJECTED_RELATION]->()
        DELETE oldNeg
      `;

      await this.withQueryTimeout(
        session.run(cypher, {
          identifier: ticket.identifier,
          title: ticket.title || "Sự cố",
          status: ticket.status || "Open",
          priority: ticket.priority || "Medium",
          createdAt: ticket.createdAt || new Date().toISOString(),
          resolvedAt: ticket.resolvedAt || null,
          system: ticket.system || null,
          product: ticket.product || null,
          errorCategory: ticket.errorCategory || null,
          reportingDept: ticket.reportingDept || null,
          studentAccount: ticket.studentAccount || null,
          customerId: ticket.customerId || null,
          deviceType: ticket.deviceType || null,
          deviceOs: ticket.deviceOs || null,
          appVersion: ticket.appVersion || null,
          assignmentId: ticket.assignmentId || null,
          roomCode: ticket.roomCode || null,
          rootCause: ticket.rootCause || null,
          resolution: ticket.resolution || null,
          causeTaxon: ticket.causeTaxon || null,
          symptomsText: ticket.symptomsText || null,
          humanCause: ticket.humanCause || null,
          humanFix: ticket.humanFix || null,
          description: ticket.description || null,
          humanNotes: ticket.humanNotes || null,
          itSupport: ticket.itSupport === true,
        }),
        `upsertTicketNode:${ticket.identifier}`,
      );

      // Cạnh quan hệ phải chạy TRUY VẤN RIÊNG — nếu để chung một query lớn,
      // UNWIND trên mảng rỗng ($relatedTickets = []) sẽ biến thành 0 rows
      // và giết toàn bộ các clause phía sau (bug Cypher kinh điển làm
      // negativeTickets không bao giờ được tạo).
      const rels = ticket.relatedTickets || [];
      if (rels.length > 0) {
        await this.withQueryTimeout(
          session.run(
            `MATCH (t:Ticket {identifier: $id})
             UNWIND $rels AS relKey
             OPTIONAL MATCH (t2:Ticket {identifier: relKey})
             WITH t, t2 WHERE t2 IS NOT NULL AND t2 <> t
             MERGE (t)-[:RELATES_TO]->(t2)`,
            { id: ticket.identifier, rels },
          ),
          `upsertTicketNode:rels:${ticket.identifier}`,
        );
      }

      // Cạnh âm tính REJECTED_RELATION: các ticket mà người đã gỡ khỏi ticket
      // này (bài học tech lead: 158/158 link_remove là người gỡ). queryRelatedTickets
      // tự động loại bỏ các ticket này khi tra cứu cho ticket này.
      const negs = ticket.negativeTickets || [];
      if (negs.length > 0) {
        await this.withQueryTimeout(
          session.run(
            `MATCH (t:Ticket {identifier: $id})
             UNWIND $negs AS negKey
             OPTIONAL MATCH (tNeg:Ticket {identifier: negKey})
             WITH t, tNeg WHERE tNeg IS NOT NULL
             MERGE (t)-[:REJECTED_RELATION]->(tNeg)`,
            { id: ticket.identifier, negs },
          ),
          `upsertTicketNode:negs:${ticket.identifier}`,
        );
      }
    } catch (err: any) {
      getLogger().error(
        `[MemgraphClient] Lỗi khi upsertTicketNode ${ticket.identifier}: ${err.message}`,
      );
      throw err;
    } finally {
      await session.close();
    }
  }

  /** Nạp/refresh nhãn + định nghĩa của bảng phân loại nguyên nhân canonical
   * (cause-taxonomy.json) vào Memgraph — tách riêng khỏi upsertTicketNode vì
   * đây là catalog tĩnh, không cần gửi lại full metadata mỗi lần sync 1 ticket. */
  async syncCauseTaxonomyCatalog(
    entries: Array<{ id: string; label: string; definition: string }>,
  ): Promise<void> {
    const session = this.driver.session();
    try {
      for (const entry of entries) {
        await this.withQueryTimeout(
          session.run(
            `MERGE (ct:CauseTaxon {id: $id}) SET ct.label = $label, ct.definition = $definition`,
            entry,
          ),
          `syncCauseTaxonomyCatalog:${entry.id}`,
        );
      }
    } finally {
      await session.close();
    }
  }

  /** Nạp danh mục 9 Hệ thống chuẩn (system-taxonomy.json) vào Memgraph —
   * mirror của syncCauseTaxonomyCatalog: chỉ MERGE node chuẩn, idempotent.
   * Nhãn rác cũ không được tạo ở đây (chỉ relabel script mới xoá chúng). */
  async syncSystemCatalog(systems: Array<{ id: string; definition: string }>): Promise<void> {
    const session = this.driver.session();
    try {
      for (const s of systems) {
        await this.withQueryTimeout(
          session.run(`MERGE (s:System {name: $id}) SET s.definition = $definition`, s),
          `syncSystemCatalog:${s.id}`,
        );
      }
    } finally {
      await session.close();
    }
  }

  /** Gắn/đổi nhóm nguyên nhân canonical cho 1 ticket đã có sẵn trong Graph,
   * không cần biết lại toàn bộ TicketGraphNode — dùng cho script phân loại
   * lại (reclassify) trên dữ liệu đã backfill trước đó. */
  async setCauseTaxon(identifier: string, taxonId: string): Promise<void> {
    const session = this.driver.session();
    try {
      await this.withQueryTimeout(
        session.run(
          `MATCH (t:Ticket {identifier: $identifier})
         OPTIONAL MATCH (t)-[old:CLASSIFIED_AS]->(:CauseTaxon)
         DELETE old
         WITH t
         MERGE (ct:CauseTaxon {id: $taxonId})
         MERGE (t)-[:CLASSIFIED_AS]->(ct)`,
          { identifier, taxonId },
        ),
        `setCauseTaxon:${identifier}`,
      );
    } finally {
      await session.close();
    }
  }

  async queryRelatedTickets(params: {
    system?: string;
    product?: string;
    errorCategory?: string;
    causeTaxon?: string;
    keywords?: string[];
    excludeIdentifier?: string;
    excludeIdentifiers?: string[];
    /** Mã ticket đang tra cứu — nếu có, queryRelatedTickets sẽ tự động loại bỏ
     * các ticket có quan hệ REJECTED_RELATION với ticket này (âm mẫu do con người
     * gỡ liên kết — bài học tech lead: 158/158 link_remove). */
    forTicket?: string;
    limit?: number;
    minScore?: number;
    requireKeywordMatch?: boolean;
  }): Promise<GraphQueryResult[]> {
    const session = this.driver.session();
    const limit = params.limit || 5;
    const keywords = (params.keywords || []).filter(
      (k) => typeof k === "string" && k.trim().length > 0,
    );
    const hasKeywords = keywords.length > 0;
    const minScore = params.minScore ?? (hasKeywords ? 5 : 3);
    const requireKw = params.requireKeywordMatch ?? (hasKeywords ? true : false);

    const excludes = new Set<string>();
    if (params.excludeIdentifier) excludes.add(params.excludeIdentifier.toUpperCase());
    for (const id of params.excludeIdentifiers || []) {
      if (id) excludes.add(id.toUpperCase());
    }

    // Tự động nạp danh sách âm tính từ cạnh REJECTED_RELATION (tech lead đã gỡ)
    if (params.forTicket) {
      const forId = params.forTicket.toUpperCase();
      excludes.add(forId);
      try {
        const negRes = await this.withQueryTimeout(
          session.run(
            `MATCH (:Ticket {identifier: $forId})-[:REJECTED_RELATION]->(neg:Ticket)
             RETURN neg.identifier AS negId`,
            { forId },
          ),
          `queryRelatedTickets:rejected:${forId}`,
        );
        for (const rec of negRes.records) {
          const negId = rec.get("negId");
          if (negId) excludes.add(String(negId).toUpperCase());
        }
      } catch {
        // Tra REJECTED_RELATION lỗi không chặn truy vấn chính
      }
    }

    // Bắt buộc phải có ít nhất 1 yếu tố đối sánh
    if (
      !params.system &&
      !params.product &&
      !params.errorCategory &&
      !params.causeTaxon &&
      keywords.length === 0
    ) {
      return [];
    }

    try {
      // Bài học audit 25/09 (làm theo sửa của tech lead trên Itsaplan):
      // 1) Ticket Canceled không còn tri thức đáng gợi ý — loại hẳn (trước đây
      //    trả cả ticket đã huỷ vì chỉ cộng điểm theo chữ).
      // 2) Time-decay half-life 14 ngày (đo trên gold Excel 1.771 dòng:
      //    half-life 14 ngày là cấu hình tốt nhất trong eval — d2 c4 × decay
      //    R@10 0.389 / MRR@10 0.633 so với as-live 0.290/0.506). Điểm cộng
      //    metadata (system +3...) bị nhân với hệ số tuổi nên không thể thắng
      //    ticket mới hơn nhờ literal-match cũ; thời điểm chuẩn là resolvedAt
      //    (ngày ticket thực sự xử lý xong), fallback createdAt.
      // (pow(0.5, d/14) cho d lớn vẫn hữu hạn trong float; duration.between
      // trả duration — lấy .days ra số nguyên dương rồi mới chia để tránh
      // chia duration cho số mà Memgraph không hỗ trợ.)
      const cypher = `
        MATCH (t:Ticket)
        WHERE NOT t.identifier IN $excludeList
          AND (t.status IS NULL OR NOT toUpper(t.status) IN ["CANCELED", "CANCELLED", "ARCHIVED", "REJECTED"])
        OPTIONAL MATCH (t)-[:IN_SYSTEM]->(s:System)
        OPTIONAL MATCH (t)-[:OF_PRODUCT]->(p:Product)
        OPTIONAL MATCH (t)-[:HAS_CATEGORY]->(c:Category)
        OPTIONAL MATCH (t)-[:CLASSIFIED_AS]->(ct:CauseTaxon)
        WITH t, s, p, c, ct,
             (CASE WHEN $system IS NOT NULL AND $system <> "" AND s.name = $system THEN 3 ELSE 0 END) AS sysScore,
             (CASE WHEN $product IS NOT NULL AND $product <> "" AND p.name = $product THEN 2 ELSE 0 END) AS prodScore,
             (CASE WHEN $errorCategory IS NOT NULL AND $errorCategory <> "" AND c.name = $errorCategory THEN 2 ELSE 0 END) AS catScore,
             // Cùng nhóm nguyên nhân canonical là tín hiệu mạnh nhất: chỉ ra cùng CƠ CHẾ lỗi
             // kỹ thuật dù rootCause diễn đạt khác chữ (bù cho kwScore literal-match bên dưới
             // bị bỏ lỡ khi 2 ticket cùng bệnh nhưng viết khác nhau). Loại trừ 2 nhóm mô tả
             // TRẠNG THÁI thiếu dữ kiện (OTHER_NEW_PATTERN, INSUFFICIENT_INFO) — "cùng chưa rõ
             // nguyên nhân" không phải tín hiệu tương tự thật.
             // 5 điểm (không phải 4): caller thật (pipeline.lookupKnowledgeGraph) truyền
             // minScore=5 + requireKeywordMatch, mà 4 < 5 thì taxon một mình không bao giờ
             // lọt — cả tính năng taxonomy thành chết trên luồng thật. Đồng thời cho taxon
             // qua ngưỡng riêng vì đã lọc nhiễu ở trên: cùng cơ chế lỗi là đủ tin cậy.
             (CASE WHEN $causeTaxon IS NOT NULL AND $causeTaxon <> "" AND ct.id = $causeTaxon
                        AND NOT ct.id IN ["OTHER_NEW_PATTERN", "INSUFFICIENT_INFO"]
                   THEN 5 ELSE 0 END) AS taxonScore,
             reduce(score = 0, kw IN $keywords |
               score + (CASE WHEN toLower(coalesce(t.title, "")) CONTAINS toLower(kw)
                               OR toLower(coalesce(t.rootCause, "")) CONTAINS toLower(kw) THEN 5 ELSE 0 END)
             ) AS kwScore
        // Hệ số tuổi: half-life 14 ngày → exp(-age × ln2 / 14). resolvedAt chuẩn
        // hơn createdAt (ticket lập hôm trước, xử lý xong hôm nay vẫn tri thức
        // mới). decayFactor nhân vào score cuối (eval d2: half-life 14 là cấu
        // hình tốt nhất — R@10 0.389 / MRR@10 0.633 so với as-live 0.290/0.506),
        // nên điểm cộng metadata (system +3...) không thể thắng ticket mới hơn.
        // Memgraph 2.14 không có pow()/"^"/duration.between; date() - date()
        // trả duration chỉ toString() được dạng "P55DT..." → tách số ngày bằng
        // replace+split. Biến phải qua từng WITH riêng (không dùng lại biến
        // trong cùng clause — đã quan sát "Unbound variable").
        WITH t, s, p, c, ct, sysScore, prodScore, catScore, taxonScore, kwScore,
             (sysScore + prodScore + catScore + taxonScore + kwScore) AS totalScore,
             coalesce(t.resolvedAt, t.createdAt) AS knowledgeAt
        WITH t, s, p, c, ct, sysScore, prodScore, catScore, taxonScore, kwScore,
             totalScore, knowledgeAt,
             // knowledgeAt là chuỗi ISO datetime ("2026-08-27T10:01:33.821Z") —
            // date() chỉ nhận YYYY-MM-DD nên phải left(..., 10) trước.
             CASE WHEN knowledgeAt IS NULL OR size(knowledgeAt) < 10 THEN 1.0
                  ELSE exp(-1.0 * toFloat(replace(split(toString(date() - date(left(knowledgeAt, 10))), "D")[0], "P", "")) * 0.6931471805599453 / 14.0) END AS decayFactor
        WHERE totalScore >= $minScore
          AND ($requireKw = false OR kwScore > 0 OR taxonScore > 0)
        OPTIONAL MATCH (t)-[:CAUSED_BY]->(rc:RootCause)
        OPTIONAL MATCH (rc)-[:RESOLVED_BY]->(res:Resolution)
        RETURN DISTINCT t.identifier AS identifier,
               t.title AS title,
               t.status AS status,
               s.name AS system,
               p.name AS product,
               c.name AS errorCategory,
               ct.id AS causeTaxon,
               t.rootCause AS rootCause,
               t.resolution AS resolution,
               toFloat(totalScore) * decayFactor AS score
        ORDER BY score DESC, CASE WHEN t.status IN ['Done', 'Resolved'] THEN 0 ELSE 1 END, knowledgeAt DESC
        LIMIT $limit
      `;

      const res = await this.withQueryTimeout(
        session.run(cypher, {
          system: params.system || null,
          product: params.product || null,
          errorCategory: params.errorCategory || null,
          causeTaxon: params.causeTaxon || null,
          keywords,
          excludeList: Array.from(excludes),
          minScore,
          requireKw,
          limit: neo4j.int(limit),
        }),
        "queryRelatedTickets",
      );

      const primaryResults: GraphQueryResult[] = res.records.map((record) => ({
        identifier: record.get("identifier"),
        title: record.get("title") || "",
        status: record.get("status") || "Open",
        system: record.get("system") || undefined,
        product: record.get("product") || undefined,
        errorCategory: record.get("errorCategory") || undefined,
        causeTaxon: record.get("causeTaxon") || undefined,
        rootCause: record.get("rootCause") || undefined,
        resolution: record.get("resolution") || undefined,
        score: record.get("score")?.toNumber?.() ?? Number(record.get("score") ?? 0),
      }));

      // Không mở rộng cụm theo RELATES_TO / nhóm nguyên nhân nữa (ADR-0007):
      // không trần, lại đi trên cạnh do bot tạo → trung vị 73 mã/ticket, đúng 6%.
      // Luồng tiếp nhận dùng SimilarityIndex (similar-finder.ts); hàm này chỉ
      // còn cho các script đánh giá cũ.
      return primaryResults;
    } catch (err: any) {
      getLogger().error(`[MemgraphClient] Lỗi queryRelatedTickets: ${err.message}`);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * Kho tra ticket tương tự cho luồng tiếp nhận: mọi ticket hoàn tất của một
   * dự án, kèm cụm nguyên nhân và câu người viết (ADR-0007). Chỉ đúng dự án —
   * không bao giờ lẫn mã khác tiền tố (TEST-KG-*, TECHTEST-*) vào gợi ý TECH.
   * Gồm cả ticket IT Support — cùng dự án TECH (người dùng chốt 27/09).
   */
  async loadSimilarityCorpus(projectKey: string): Promise<CorpusTicket[]> {
    const session = this.driver.session();
    try {
      const res = await this.withQueryTimeout(
        session.run(
          `MATCH (t:Ticket)
           WHERE t.identifier STARTS WITH $prefix
             AND (t.status IS NULL OR toUpper(t.status) = "DONE")
           OPTIONAL MATCH (t)-[:REJECTED_RELATION]-(n:Ticket)
           RETURN t.identifier AS identifier, t.title AS title, t.symptomsText AS symptomsText,
                  t.causeCluster AS causeCluster, t.humanCause AS humanCause, t.humanFix AS humanFix,
                  t.description AS description, t.humanNotes AS humanNotes,
                  t.system AS system, t.product AS product,
                  t.resolvedAt AS resolvedAt, collect(DISTINCT n.identifier) AS negatives`,
          { prefix: `${projectKey.toUpperCase()}-` },
        ),
        `loadSimilarityCorpus:${projectKey}`,
      );
      return res.records
        .map((r) => {
          const negs = (r.get("negatives") as string[] | undefined)?.filter(Boolean);
          return {
            identifier: String(r.get("identifier")),
            title: r.get("title") || "",
            symptomsText: r.get("symptomsText") || undefined,
            causeCluster: r.get("causeCluster") || undefined,
            humanCause: r.get("humanCause") || undefined,
            humanFix: r.get("humanFix") || undefined,
            description: r.get("description") || undefined,
            humanNotes: r.get("humanNotes") || undefined,
            system: r.get("system") || undefined,
            product: r.get("product") || undefined,
            resolvedAt: r.get("resolvedAt") || undefined,
            negatives: negs && negs.length > 0 ? negs : undefined,
          };
        })
        .filter((t) => /-\d+$/.test(t.identifier));
    } finally {
      await session.close();
    }
  }

  /**
   * Tính lại cụm nguyên nhân cho toàn KG, từng dự án riêng (ghi `t.causeCluster`).
   * Cụm là thuộc tính toàn cục — một liên kết người gắn có thể gộp hai cụm cũ —
   * nên tính lại hết sau mỗi lần nạp; vài trăm ticket chỉ mất vài chục ms.
   */
  async recomputeCauseClusters(): Promise<{ tickets: number; clusters: number }> {
    const session = this.driver.session();
    try {
      const nodes = await this.withQueryTimeout(
        session.run(
          `MATCH (t:Ticket)
           OPTIONAL MATCH (t)-[:RELATES_TO]-(p:Ticket)
           OPTIONAL MATCH (t)-[:REJECTED_RELATION]-(n:Ticket)
           RETURN t.identifier AS id, t.humanCause AS humanCause,
                  collect(DISTINCT p.identifier) AS positives, collect(DISTINCT n.identifier) AS negatives`,
        ),
        "recomputeCauseClusters:read",
      );
      const byProject = new Map<
        string,
        Array<{ id: string; humanCause?: string; positives: string[]; negatives: string[] }>
      >();
      for (const r of nodes.records) {
        const id = String(r.get("id"));
        const project = id.replace(/-\d+$/, "");
        const list = byProject.get(project) ?? [];
        list.push({
          id,
          humanCause: r.get("humanCause") || undefined,
          positives: (r.get("positives") as string[]).filter(Boolean),
          negatives: (r.get("negatives") as string[]).filter(Boolean),
        });
        byProject.set(project, list);
      }
      const rows: Array<{ id: string; c: string }> = [];
      for (const list of byProject.values()) {
        for (const [id, c] of buildCauseClusters(list)) rows.push({ id, c });
      }
      await this.withQueryTimeout(
        session.run(
          `UNWIND $rows AS r MATCH (t:Ticket {identifier: r.id}) SET t.causeCluster = r.c`,
          { rows },
        ),
        "recomputeCauseClusters:write",
      );
      return { tickets: rows.length, clusters: new Set(rows.map((r) => r.c)).size };
    } finally {
      await session.close();
    }
  }

  /** Xuất toàn bộ ticket đã có RootCause+Resolution (kèm nhãn CauseTaxon nếu có) —
   * dùng để đẩy dữ liệu KG đã chuẩn hoá làm document ingest vào Onyx. */
  async listResolvedTicketsForExport(): Promise<
    Array<{
      identifier: string;
      title: string;
      system?: string;
      product?: string;
      errorCategory?: string;
      causeTaxonId?: string;
      causeTaxonLabel?: string;
      rootCause: string;
      resolution: string;
      resolvedAt?: string;
    }>
  > {
    const session = this.driver.session();
    try {
      const res = await this.withQueryTimeout(
        session.run(`
        ${OWN_RESOLUTION_MATCH}
        OPTIONAL MATCH (t)-[:IN_SYSTEM]->(s:System)
        OPTIONAL MATCH (t)-[:OF_PRODUCT]->(p:Product)
        OPTIONAL MATCH (t)-[:HAS_CATEGORY]->(c:Category)
        OPTIONAL MATCH (t)-[:CLASSIFIED_AS]->(ct:CauseTaxon)
        RETURN t.identifier AS identifier, t.title AS title, t.resolvedAt AS resolvedAt,
               s.name AS system, p.name AS product, c.name AS errorCategory,
               ct.id AS causeTaxonId, ct.label AS causeTaxonLabel,
               rc.text AS rootCause, res.text AS resolution
        ORDER BY t.identifier
      `),
        "listResolvedTicketsForExport",
      );
      return res.records.map((r) => ({
        identifier: r.get("identifier"),
        title: r.get("title") || "",
        system: r.get("system") || undefined,
        product: r.get("product") || undefined,
        errorCategory: r.get("errorCategory") || undefined,
        causeTaxonId: r.get("causeTaxonId") || undefined,
        causeTaxonLabel: r.get("causeTaxonLabel") || undefined,
        rootCause: r.get("rootCause"),
        resolution: r.get("resolution"),
        resolvedAt: r.get("resolvedAt") || undefined,
      }));
    } finally {
      await session.close();
    }
  }

  async getGraphStats(): Promise<{ nodes: number; edges: number }> {
    const session = this.driver.session();
    try {
      const nRes = await this.withQueryTimeout(
        session.run(`MATCH (n) RETURN count(n) AS count`),
        "getGraphStats:nodes",
      );
      const eRes = await this.withQueryTimeout(
        session.run(`MATCH ()-[r]->() RETURN count(r) AS count`),
        "getGraphStats:edges",
      );
      return {
        nodes: nRes.records[0].get("count").toNumber(),
        edges: eRes.records[0].get("count").toNumber(),
      };
    } finally {
      await session.close();
    }
  }
}
