import { complete, extractJson } from "./llm";
import type { ItsaplanClient } from "../lib/itsaplan/client";
import type { OnyxConnectorManager } from "../lib/onyx/connector-manager";
import { redactIncidentPII } from "@vuihoc/bot-core/core";
import { evaluatePreLlmFilter, evaluatePostLlmFilter } from "../lib/onyx/filter";
import { buildOnyxDocumentBody, parseVuihocMeta } from "../lib/onyx/document";
import { issueWebUrl, resolveProjectTeamRef } from "../lib/itsaplan/project";
import { getLogger } from "@vuihoc/bot-core/core";
import { markBotComment, stripCommentHtml } from "@vuihoc/bot-core/core";
import type { OnyxServiceConfig } from "../lib/onyx/config";
import { identifierInProject } from "./project-lock";

export interface IngestionResult {
  success: boolean;
  status?: "indexed" | "skipped";
  reason?: string;
  docId?: string;
  error?: string;
}

export class OnyxIngestService {
  constructor(
    private readonly itsaplan: ItsaplanClient,
    private readonly connectorManager: OnyxConnectorManager,
    private readonly config: OnyxServiceConfig,
  ) {}

  /**
   * Ingest a completed/resolved ticket into the connector/cc-pair the connector manager
   * resolves — the real "tech-done-tickets" cc-pair when ONYX_CC_PAIR_ID is set (see
   * connector-manager.ts), or an isolated ad-hoc test connector otherwise.
   */
  async ingestDoneTicket(issueId: number): Promise<IngestionResult> {
    const config = this.config;
    if (!config.onyxApiKey) {
      return { success: false, error: "ONYX_API_KEY is not configured" };
    }

    try {
      // 1. Fetch issue details and timeline from Itsaplan
      const issue = await this.itsaplan.getIssue(issueId);
      if (!issue) {
        return { success: false, error: `Issue #${issueId} not found on Itsaplan` };
      }
      // Webhook Itsaplan không lọc theo dự án: đã từng nạp PO-78 thành
      // `ticket_tech-640`. Ticket không thuộc dự án worker thì không nạp.
      if (!identifierInProject(issue.identifier, config.itsaplanProjectKey)) {
        getLogger().info(
          `[OnyxIngestService] Bỏ qua #${issueId} (${issue.identifier}): không thuộc dự án ${config.itsaplanProjectKey}`,
        );
        return {
          success: true,
          status: "skipped",
          reason: `không thuộc dự án ${config.itsaplanProjectKey}`,
        };
      }

      const timeline = await this.itsaplan.getIssueTimeline(issueId);
      const comments = timeline
        .filter((item) => item.kind === "comment" && !item.body?.includes("[Onyx Second Brain]"))
        .map((item) => stripCommentHtml(item.body).trim())
        .filter(Boolean);

      // Cửa lọc trước LLM: loại bỏ ticket test hoặc không đủ thông tin tối thiểu
      const rawContent = [issue.title, issue.description, ...comments].filter(Boolean).join("\n");
      const preDecision = evaluatePreLlmFilter({ title: issue.title }, rawContent);
      if (!preDecision.pass) {
        getLogger().info(
          `[OnyxIngestService] Bỏ qua #${issueId} (${issue.identifier}): ${preDecision.reason}`,
        );
        return {
          success: true,
          status: "skipped",
          reason: preDecision.reason,
        };
      }

      // 2. Synthesize knowledge via LLM (Root Cause, Resolution, Symptoms)
      let symptom = issue.description || issue.title;
      let rootCause = "Chưa ghi nhận rõ nguyên nhân trong trao đổi";
      let resolution = comments.join("\n---\n") || "Đã xử lý và đóng ticket";
      let prevention = "Theo dõi hoạt động tiếp theo";

      try {
        const systemPrompt = `Bạn là chuyên gia phân tích hậu sự cố (Incident Post-mortem Engineer) của VuiHoc. Nhiệm vụ của bạn là đọc thông tin sự cố và các bình luận trao đổi của kỹ thuật viên để trích xuất tri thức chuẩn xác dạng JSON.
Trả về ĐÚNG cấu trúc JSON sau (không kèm markdown \`\`\`json):
{
  "symptom": "Tóm tắt ngắn gọn triệu chứng và lỗi quan sát được",
  "root_cause": "Nguyên nhân kỹ thuật cốt lõi gây ra lỗi",
  "resolution": "Giải pháp kỹ thuật cụ thể đã dùng để xử lý triệt để",
  "prevention": "Đề xuất giải pháp phòng ngừa hoặc tối ưu"
}`;

        const prompt = `Tiêu đề sự cố: ${issue.title}
Mô tả ban đầu:
${issue.description}

Các bình luận/trao đổi kỹ thuật trong quá trình xử lý:
${comments.join("\n---\n") || "(Không có bình luận bổ sung)"}`;

        const text = await complete(
          {
            baseUrl: config.openaiBaseUrl,
            apiKey: config.openaiApiKey,
            model: config.openaiModel,
            api: config.openaiApi,
          },
          systemPrompt,
          prompt,
        );
        const parsed = extractJson<Record<string, string>>(text);
        if (parsed) {
          if (parsed.symptom) symptom = parsed.symptom;
          if (parsed.root_cause) rootCause = parsed.root_cause;
          if (parsed.resolution) resolution = parsed.resolution;
          if (parsed.prevention) prevention = parsed.prevention;
        }
      } catch (llmErr: any) {
        getLogger().warn(
          "[OnyxIngestService] LLM synthesis warning, falling back to direct fields:",
          llmErr.message,
        );
      }

      // 3. Redact PII (passwords, phone numbers, tokens, emails)
      const redactedTitle = redactIncidentPII(issue.title);
      const redactedSymptom = redactIncidentPII(symptom);
      const redactedRootCause = redactIncidentPII(rootCause);
      const redactedResolution = redactIncidentPII(resolution);
      const redactedPrevention = redactIncidentPII(prevention);

      const prefix = config.docIdPrefix || "ticket_";
      const docId = `${prefix}${issue.identifier.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`;
      const teamRef = await resolveProjectTeamRef(this.itsaplan, config.itsaplanProjectKey);
      const issueUrl =
        issueWebUrl(
          config.itsaplanWebUrl,
          config.itsaplanProjectKey,
          issue.identifier,
          issue.sequenceNumber,
          teamRef,
        ) ?? "";

      // Hệ thống/phân loại lỗi không phải trường native trên ItsaplanIssue — đọc lại từ khối
      // <!-- vuihoc-meta: {...} --> mà formatTicketDescription() đã ghi vào mô tả lúc tạo ticket.
      const meta = parseVuihocMeta(issue.description || "");
      const system = typeof meta?.system === "string" ? meta.system : undefined;
      const errorCategory = typeof meta?.category === "string" ? meta.category : undefined;
      const closedDate = (issue.updatedAt ? new Date(issue.updatedAt) : new Date())
        .toISOString()
        .slice(0, 10);

      const textDocument = buildOnyxDocumentBody({
        identifier: issue.identifier,
        system,
        errorCategory,
        closedDate,
        symptom: redactedSymptom,
        rootCause: redactedRootCause,
        resolution: redactedResolution,
        prevention: redactedPrevention,
      });

      // Cửa lọc sau LLM: loại bỏ nếu không trích xuất được tri thức hoặc lọt PII
      const postDecision = evaluatePostLlmFilter({ rootCause, resolution }, textDocument);
      if (!postDecision.pass) {
        getLogger().info(
          `[OnyxIngestService] Bỏ qua #${issueId} (${issue.identifier}) sau LLM: ${postDecision.reason}`,
        );
        return {
          success: true,
          status: "skipped",
          reason: postDecision.reason,
          docId,
        };
      }

      // 4. Ensure isolated test connector exists
      const testConn = await this.connectorManager.ensureTestConnector();

      // 5. Ingest into Onyx
      const title = `${issue.identifier}: ${redactedTitle}`;
      const payload = {
        cc_pair_id: testConn.ccPairId,
        document: {
          id: docId,
          sections: [
            {
              type: "text",
              text: textDocument,
              link: issueUrl,
            },
          ],
          source: "file",
          semantic_identifier: title,
          title,
          metadata: {
            ticket_id: issue.identifier,
            status: "Resolved",
            ...(system ? { system } : {}),
            ...(errorCategory ? { error_category: errorCategory } : {}),
            root_cause: redactedRootCause,
            resolution: redactedResolution,
          },
        },
      };

      const endpoints = ["/api/onyx-api/ingestion", "/api/danswer-api/ingestion"];
      let ingested = false;
      let lastErr = "";

      for (const ep of endpoints) {
        try {
          const res = await fetch(`${config.onyxBaseUrl}${ep}`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.onyxApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          });

          if (res.ok) {
            ingested = true;
            break;
          }

          if (res.status === 404) continue;
          lastErr = `HTTP ${res.status}: ${await res.text()}`;
        } catch (e: any) {
          lastErr = e.message;
        }
      }

      if (!ingested) {
        return { success: false, error: `Failed to push to Onyx: ${lastErr}` };
      }

      // 6. Post confirmation comment to Itsaplan timeline
      try {
        await this.itsaplan.addComment(
          issueId,
          markBotComment(
            `✅ **[Onyx Second Brain]** Đã nạp bài học kinh nghiệm của sự cố này vào kho tri thức thử nghiệm (\`${testConn.documentSetName}\`, Doc ID: \`${docId}\`, CC-Pair: \`${testConn.ccPairId}\`).`,
          ),
        );
      } catch (cmtErr: any) {
        getLogger().warn(
          "[OnyxIngestService] Failed posting confirmation comment:",
          cmtErr.message,
        );
      }

      return {
        success: true,
        status: "indexed",
        docId,
      };
    } catch (err: any) {
      getLogger().error("[OnyxIngestService] Ingestion failed:", err);
      return { success: false, error: err.message };
    }
  }
}
