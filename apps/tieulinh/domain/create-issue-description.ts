import { defineTool, type AnyMcpTool, markBotComment } from "@vuihoc/bot-core/core";
import { z } from "zod";
import type { IssueDomain } from "./domain";
import { buildAdviceComment } from "./ticket-formatter";

export interface TrackerConfig {
  baseUrl: string;
  apiKey: string;
  projectKey: string;
  webUrl?: string;
}

/**
 * Bọc trích dẫn cho khối xem trước lời người báo.
 */
export function quoteForPreview(text: string, maxChars = 600): string {
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
  return clipped
    .replace(/([\\`*_{}[\]()#+|>-])/g, "\\$1")
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
}

export function createIssue<TShape extends z.ZodRawShape>(
  config: TrackerConfig,
  domain: IssueDomain<TShape>,
): AnyMcpTool {
  const inputSchema = {
    ...domain.inputShape,
    labels: z.array(z.string()).optional(),
    userConfirmed: z.boolean().default(false),
  };

  return defineTool({
    name: "create_issue",
    description: domain.description,
    inputSchema,
    handler: async (rawInput: Record<string, unknown>) => {
      const input = { ...rawInput } as Record<string, unknown> & {
        title?: string;
        rawText?: string;
        description?: string;
        studentId?: string;
        customerId?: string;
        reportingDept?: string;
        userConfirmed?: boolean;
      };
      const built = domain.build(input as z.infer<z.ZodObject<TShape>>);

      if (!input.userConfirmed) {
        const details: string[] = [];
        details.push(`- Tiêu đề: ${built.title}`);
        if (built.product) details.push(`- Sản phẩm: ${built.product}`);
        if (built.system) details.push(`- Hệ thống: ${built.system}`);

        const isPhone = (val?: string) =>
          Boolean(val && /^(?:\+84|0)[35789]\d{8}$/.test(val.replace(/[\s.-]+/g, "")));
        const phoneOrAcc =
          input.studentId ?? (isPhone(input.customerId) ? input.customerId : undefined);
        const validCustId =
          input.customerId && !isPhone(input.customerId) && input.customerId !== input.studentId
            ? input.customerId
            : undefined;

        if (validCustId) details.push(`- Mã khách hàng: ${validCustId}`);
        if (phoneOrAcc) details.push(`- Tài khoản HS / SĐT: ${phoneOrAcc}`);
        if (input.reportingDept) details.push(`- Bộ phận: ${input.reportingDept}`);
        if (built.errorCategory) details.push(`- Phân loại lỗi: ${built.errorCategory}`);
        details.push(`- Mức ưu tiên: ${built.priority.toUpperCase()}`);

        const previewText = String(input.rawText || input.description || "").trim();
        const isParaphrase = !input.rawText;

        return {
          created: false,
          needsConfirmation: true,
          draft: {
            title: built.title,
            product: built.product,
            system: built.system,
            errorCategory: built.errorCategory,
            priority: built.priority,
          },
          message:
            built.confirmationMessage ??
            `**Em tóm tắt lại sự cố của anh/chị nhé ạ:**\n\n` +
              details.join("\n") +
              (previewText
                ? `\n\n**Nội dung sẽ ghi vào ticket:**\n${quoteForPreview(previewText)}\n` +
                  (isParaphrase
                    ? `_Em tự tóm lại phần này. Nếu anh/chị muốn giữ đúng lời mình nói, anh/chị nhắn lại giúp em nhé ạ._`
                    : "")
                : "") +
              `\n\nAnh/chị vui lòng kiểm tra kỹ thông tin trước khi xác nhận. Nếu thông tin không chính xác, Tiểu Linh sẽ không thể phân loại đúng và đội Kỹ thuật sẽ gặp khó khăn trong việc xử lý.`,
        };
      }

      // Ghi lên tracker
      const base = config.baseUrl.replace(/\/+$/, "");
      const res = await fetch(`${base}/projects/${config.projectKey}/issues`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          title: built.title,
          description: built.description,
          priority: built.priority,
          product: built.product,
          system: built.system,
          errorCategory: built.errorCategory,
          mediaPaths: built.mediaPaths,
        }),
      });

      if (!res.ok) {
        throw new Error(`Tracker POST failed: ${res.status}`);
      }

      const issue = (await res.json()) as { id: number; identifier?: string };

      // Ghi comment gợi ý của bot nếu có diagnosis (best-effort, không làm hỏng ticket)
      if (built.diagnosis) {
        const advice = buildAdviceComment(built.diagnosis);
        if (advice) {
          try {
            await fetch(`${base}/issues/${issue.id}/comments`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${config.apiKey}`,
              },
              body: JSON.stringify({
                body: markBotComment(advice),
              }),
            });
          } catch {
            // Best effort
          }
        }
      }

      return {
        created: true,
        issue,
      };
    },
  });
}
