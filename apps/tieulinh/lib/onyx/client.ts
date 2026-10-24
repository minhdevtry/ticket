import { getLogger } from "../logger";
import { redactIncidentPII } from "./pii-redactor";

export interface OnyxCandidateTicket {
  ma: string;
  link: string;
  he_thong?: string;
  tieu_de: string;
  trieu_chung?: string;
  nguyen_nhan?: string;
  cach_khac_phuc?: string;
}

export interface OnyxSearchResult {
  answer: string;
  relatedTicketKeys: string[];
  candidateDetails?: OnyxCandidateTicket[];
  suggestions?: {
    system?: string;
    product?: string;
    error_category?: string;
  };
}

const TU_NHOE = new Set([
  "a",
  "a.c",
  "a/c",
  "ac",
  "anh",
  "anh/chi",
  "anh/chị",
  "cam",
  "check",
  "chi",
  "cho",
  "chị",
  "cảm",
  "dum",
  "dung",
  "dùm",
  "e",
  "e/c",
  "em",
  "fix",
  "gap",
  "gium",
  "giup",
  "giùm",
  "giúp",
  "gấp",
  "ho",
  "hỗ",
  "hộ",
  "kiem",
  "kiểm",
  "kt",
  "ktr",
  "ktra",
  "lai",
  "loi",
  "lại",
  "lỗi",
  "m",
  "minh",
  "mình",
  "nha",
  "nhe",
  "nho",
  "nhá",
  "nhé",
  "nhờ",
  "on",
  "sua",
  "support",
  "sửa",
  "t",
  "team",
  "tech",
  "tra",
  "tro",
  "trợ",
  "va",
  "vh",
  "voi",
  "và",
  "với",
  "xem",
  "xin",
  "đúng",
  "ơn",
  "ạ",
]);

const DONG_TU_NHO = new Set([
  "check",
  "ktra",
  "ktr",
  "kiểm",
  "kiem",
  "xem",
  "hỗ",
  "ho",
  "trợ",
  "tro",
  "support",
  "fix",
  "sửa",
  "sua",
  "giúp",
  "giup",
  "hộ",
  "cảm",
  "cam",
  "nhờ",
  "nho",
]);

/**
 * Gọt bỏ các từ xin xỏ, nhờ vả ở cuối câu để tăng độ chính xác của tìm kiếm ngữ nghĩa
 */
export function gonCauHoi(cau: string): string {
  if (!cau) return "";
  const parts = cau
    .split(/[,;.]/)
    .map((x) => x.trim())
    .filter(Boolean);
  const got = parts
    .map((doan) => {
      const tu = doan.split(/\s+/);
      let i = tu.length;
      while (
        i > 0 &&
        tu[i - 1]
          .toLowerCase()
          .replace(/[^\w/.]/g, "")
          .match(/^[a-z.]+$/) &&
        TU_NHOE.has(tu[i - 1].toLowerCase().replace(/[^\w/.]/g, ""))
      ) {
        i--;
      }
      const boc = tu
        .slice(i)
        .map((x) => x.toLowerCase().replace(/[^\w/.]/g, ""))
        .filter((x) => DONG_TU_NHO.has(x));
      if (i === tu.length || !boc.length) return doan;
      return tu
        .slice(0, i)
        .join(" ")
        .replace(/^[ ,;.]+|[ ,;.]+$/g, "");
    })
    .filter(Boolean);

  const ra = got.join(", ").replace(/^[ ,;.]+|[ ,;.]+$/g, "");
  return ra || cau.trim();
}

export class OnyxClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly mcpUrl: string;

  constructor(baseUrl: string, apiKey: string = "", mcpUrl?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.mcpUrl = mcpUrl || `${this.baseUrl}/mcp`;
  }

  /**
   * Health check against Onyx
   */
  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Search knowledge base and similar tickets via Onyx MCP protocol or Persona fallback
   */
  async searchSimilarTickets(
    title: string,
    description: string,
    currentTicketKey?: string,
    personaId: number = 6,
    systemFilter?: string,
  ): Promise<OnyxSearchResult> {
    if (!this.apiKey) {
      return { answer: "", relatedTicketKeys: [] };
    }

    // Ưu tiên 1: Tra cứu trực tiếp qua Onyx MCP server (chuẩn TMS: document sets ticket-history, tech-done-tickets)
    try {
      const mcpResult = await this.searchViaMcp(title, description, currentTicketKey, systemFilter);
      if (mcpResult.relatedTicketKeys.length > 0 || mcpResult.answer) {
        return mcpResult;
      }
    } catch (err: any) {
      getLogger().warn(`[OnyxClient] MCP search failed (${err.message}), falling back to chat API`);
    }

    // Ưu tiên 2: Fallback chat session API
    return this.searchViaChat(title, description, currentTicketKey, personaId);
  }

  /**
   * Tra cứu tri thức bằng JSON-RPC MCP SSE endpoint (chuẩn TMS)
   */
  private async searchViaMcp(
    title: string,
    description: string,
    currentTicketKey?: string,
    systemFilter?: string,
  ): Promise<OnyxSearchResult> {
    const rawQuery = `${title} ${description}`.trim();
    const cleanQuery = gonCauHoi(redactIncidentPII(rawQuery));
    if (!cleanQuery) return { answer: "", relatedTicketKeys: [] };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    try {
      // 1. Initialize MCP session
      const initRes = await fetch(this.mcpUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "intake-agents", version: "0.1.0" },
          },
        }),
        signal: controller.signal,
      });

      const sessionId =
        initRes.headers.get("mcp-session-id") || initRes.headers.get("Mcp-Session-Id");
      if (!initRes.ok || !sessionId) {
        throw new Error(`MCP init failed: HTTP ${initRes.status}`);
      }

      // 2. Send initialized notification
      await fetch(this.mcpUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
        signal: controller.signal,
      });

      // 3. Call search_indexed_documents tool
      const res = await fetch(this.mcpUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${this.apiKey}`,
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "search_indexed_documents",
            arguments: {
              query: cleanQuery,
              // "intake-test-done" là nơi OnyxIngestService thực sự ghi vào — thiếu ở
              // đây khiến toàn bộ ticket tự động nạp không bao giờ được tìm lại.
              // "kg-cause-taxonomy" là dữ liệu Memgraph KG đẩy sang (nhãn CauseTaxon canonical).
              document_set_names: [
                "ticket-history",
                "tech-done-tickets",
                "intake-test-done",
                "kg-cause-taxonomy",
              ],
              skip_query_expansion: true,
            },
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const text = await res.text();
      let rawResults: any[] = [];

      for (const line of text.split("\n")) {
        if (line.startsWith("data:")) {
          try {
            const parsed = JSON.parse(line.slice(5).trim());
            const results = parsed?.result?.structuredContent?.results;
            if (Array.isArray(results)) {
              rawResults = results;
              break;
            }
            if (parsed?.result?.content?.[0]?.text) {
              const inner = JSON.parse(parsed.result.content[0].text);
              if (Array.isArray(inner)) rawResults = inner;
              else if (Array.isArray(inner?.results)) rawResults = inner.results;
              break;
            }
          } catch {}
        }
      }

      if (rawResults.length === 0 && text.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(text.trim());
          rawResults = parsed?.result?.structuredContent?.results || [];
        } catch {}
      }

      const seen = new Set<string>();
      if (currentTicketKey) seen.add(currentTicketKey.toUpperCase());

      const candidates: OnyxCandidateTicket[] = [];
      const suggestions: { system?: string; product?: string; error_category?: string } = {};

      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const curNorm = systemFilter ? norm(systemFilter) : "";

      for (const r of rawResults) {
        const fullText = `${r.document_id ?? ""} ${r.title ?? ""} ${r.content ?? ""}`;
        const matches = fullText.match(/\b(TECH-\d+)\b/gi);
        if (!matches) continue;

        for (const m of matches) {
          const code = m.toUpperCase();
          if (seen.has(code)) continue;
          seen.add(code);

          const link =
            r.url ||
            `${process.env.ITSAPLAN_WEB_URL?.replace(/\/+$/, "") || "https://itsaplan.example.com"}/workbench/vuihoc/tracker/${code}`;
          const systemMatch = fullText.match(/TECH-\d+\s*·\s*([^·\n]+)/i);
          // Chấp nhận cả 2 định dạng đã xác nhận tồn tại song song trong Onyx:
          // - Compact (319 doc cũ trong "tech-done-tickets"): "TRIỆU CHỨNG\n...", không dấu ":"
          // - Verbose (OnyxIngestService hiện tại, "intake-test-done"): "TRIỆU CHỨNG SỰ CỐ:\n..."
          // Trước đây regex chỉ khớp bản compact nên toàn bộ doc do worker tự nạp
          // không trích xuất được nguyên nhân/giải pháp có cấu trúc.
          const symptomMatch = fullText.match(
            /TRIỆU CHỨNG(?:\s*SỰ\s*CỐ)?:?\s*\n([\s\S]*?)(?=\n[A-ZÀ-Ỹ\s]+:|\n---|\nPHẠM VI|\nNGUYÊN NHÂN|$)/i,
          );
          const rootCauseMatch = fullText.match(
            /NGUYÊN NHÂN(?:\s*GỐC\s*RỄ)?:?\s*\n([\s\S]*?)(?=\n[A-ZÀ-Ỹ\s]+:|\n---|\nGIẢI\s*PHÁP|\nCÁCH\s*KHẮC\s*PHỤC|$)/i,
          );
          const fixMatch = fullText.match(
            /(?:GIẢI\s*PHÁP\s*XỬ\s*LÝ|CÁCH\s*KHẮC\s*PHỤC)[^:\n]*:?\s*\n([\s\S]*?)(?=\n[A-ZÀ-Ỹ\s]+:|\n---|\nHƯỚNG\s*DẪN|\nCÁCH\s*PHÒNG\s*TRÁNH|$)/i,
          );

          const candSys = systemMatch ? systemMatch[1].trim() : undefined;

          // Lọc hệ thống nếu có
          if (curNorm && candSys) {
            const cNorm = norm(candSys);
            if (!cNorm.includes(curNorm) && !curNorm.includes(cNorm)) {
              continue;
            }
          }

          if (!suggestions.system && candSys) {
            suggestions.system = candSys;
          }

          const catMatch = fullText.match(/·\s*([^·\n]+)\s*·\s*đóng\s*\d{4}/i);
          if (!suggestions.error_category && catMatch) {
            suggestions.error_category = catMatch[1].trim();
          }

          candidates.push({
            ma: code,
            link,
            he_thong: candSys,
            tieu_de: r.title || `Sự cố ${code}`,
            trieu_chung: symptomMatch ? symptomMatch[1].trim().slice(0, 300) : undefined,
            nguyen_nhan: rootCauseMatch ? rootCauseMatch[1].trim().slice(0, 300) : undefined,
            cach_khac_phuc: fixMatch ? fixMatch[1].trim().slice(0, 300) : undefined,
          });
        }
      }

      // Xây dựng câu trả lời chẩn đoán tóm tắt từ ứng viên đầu tiên (nếu có)
      const topCand = candidates[0];
      let answer = "";
      if (topCand) {
        const parts: string[] = [];
        if (topCand.trieu_chung)
          parts.push(`- Triệu chứng tương tự (${topCand.ma}): ${topCand.trieu_chung}`);
        if (topCand.nguyen_nhan)
          parts.push(`- Nguyên nhân tham khảo (${topCand.ma}): ${topCand.nguyen_nhan}`);
        if (topCand.cach_khac_phuc)
          parts.push(`- Hướng khắc phục đề xuất (${topCand.ma}): ${topCand.cach_khac_phuc}`);
        answer = parts.join("\n");
      }

      return {
        answer,
        relatedTicketKeys: candidates.map((c) => c.ma),
        candidateDetails: candidates.slice(0, 5),
        suggestions,
      };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  /**
   * Tra cứu tri thức qua Chat Session API (fallback)
   */
  private async searchViaChat(
    title: string,
    description: string,
    currentTicketKey?: string,
    personaId: number = 6,
  ): Promise<OnyxSearchResult> {
    try {
      const sessionResponse = await fetch(`${this.baseUrl}/api/chat/create-chat-session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          persona_id: personaId,
          description: `Intake Match: ${title.slice(0, 50)}`,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!sessionResponse.ok) {
        getLogger().warn(`[OnyxClient] Failed to create session: HTTP ${sessionResponse.status}`);
        return { answer: "", relatedTicketKeys: [] };
      }

      const { chat_session_id } = (await sessionResponse.json()) as { chat_session_id: string };

      const prompt = `Incident Title: ${title}
${currentTicketKey ? `Current Ticket: ${currentTicketKey}` : ""}
Description:
${description.slice(0, 1000)}

Please review our runbook knowledge base and completed tickets to:
1. Identify if this is a known issue and its potential root cause.
2. List any directly related or duplicate tickets (format: TECH-xxx).
${currentTicketKey ? `Exclude ${currentTicketKey} from results.` : ""}`;

      const messageResponse = await fetch(`${this.baseUrl}/api/chat/send-chat-message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          chat_session_id,
          message: prompt,
          parent_message_id: null,
          retrieval_options: {
            run_search: "always",
            real_time: true,
          },
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!messageResponse.ok) {
        return { answer: "", relatedTicketKeys: [] };
      }

      const rawText = await messageResponse.text();
      let fullAnswer = "";

      for (const line of rawText.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj.obj?.type === "message_delta" && typeof obj.obj?.content === "string") {
            fullAnswer += obj.obj.content;
          }
        } catch {}
      }

      const answer = fullAnswer.trim();
      const ticketKeyMatches = answer.match(/TECH-\d+/g) || [];
      const relatedTicketKeys = Array.from(
        new Set(ticketKeyMatches.filter((key) => key !== currentTicketKey)),
      );

      return {
        answer,
        relatedTicketKeys,
      };
    } catch (error) {
      getLogger().warn("[OnyxClient] Fallback chat search failed:", error);
      return { answer: "", relatedTicketKeys: [] };
    }
  }
}
