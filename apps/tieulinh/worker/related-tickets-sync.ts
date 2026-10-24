import type { ItsaplanClient } from "../lib/itsaplan/client";
import { findIssueByIdentifier, parseIdentifier } from "../lib/itsaplan/project";
import { getLogger } from "../lib/logger";
import { isSystemActor } from "../lib/kg/human-signals";

const TICKET_KEY_REGEX = /\b([A-Z0-9_]+-\d+)\b/gi;

/**
 * Bóc tách tất cả các mã ticket dạng `TECH-123` từ văn bản tự do
 * (ngăn cách bằng dấu phẩy, khoảng trắng, xuống dòng, chấm phẩy, v.v.).
 */
export function extractTicketKeys(text: string): string[] {
  if (!text || typeof text !== "string") return [];
  const matches = text.match(TICKET_KEY_REGEX);
  if (!matches) return [];

  const unique = new Set<string>();
  for (const m of matches) {
    const key = m.trim().toUpperCase();
    if (key) unique.add(key);
  }
  return [...unique];
}

// Cache fieldId theo projectKey để tránh gọi listCustomFields nhiều lần
const relatedTicketsFieldIdCache = new Map<string, number>();

export async function resolveRelatedTicketsFieldId(
  client: ItsaplanClient,
  projectKey: string,
): Promise<number | null> {
  if (relatedTicketsFieldIdCache.has(projectKey)) {
    return relatedTicketsFieldIdCache.get(projectKey)!;
  }

  try {
    const customFields = await client.listCustomFields(projectKey);
    const target = customFields.find((f) => /related.*ticket/i.test(f.name));
    if (target) {
      relatedTicketsFieldIdCache.set(projectKey, target.id);
      return target.id;
    }
  } catch (err: any) {
    getLogger().warn(
      `[RelatedTicketsSync] Không thể lấy danh sách custom fields cho dự án ${projectKey}: ${err.message}`,
    );
  }
  return null;
}

export function clearRelatedTicketsFieldCache() {
  relatedTicketsFieldIdCache.clear();
}

/**
 * Đồng bộ các ticket được liệt kê trong trường "Related Tickets" thành liên kết Links native.
 * Trả về danh sách mã ticket vừa được liên kết mới thành công.
 */
export async function syncRelatedTickets(
  client: ItsaplanClient,
  issueId: number,
): Promise<string[]> {
  try {
    const issue = await client.getIssue(issueId);
    if (!issue || !issue.identifier) return [];

    const parsedSelf = parseIdentifier(issue.identifier);
    const projectKey = parsedSelf?.projectKey || "TECH";

    const fieldId = await resolveRelatedTicketsFieldId(client, projectKey);
    if (!fieldId) return [];

    const fieldEntry = issue.fields?.find((f) => f.fieldId === fieldId);
    const rawVal = fieldEntry?.value;
    if (!rawVal || typeof rawVal !== "string") return [];

    const candidateKeys = extractTicketKeys(rawVal);
    if (candidateKeys.length === 0) return [];

    // Tập hợp các mã ticket đã được liên kết hiện tại
    const existingLinkedKeys = new Set<string>();
    if (Array.isArray(issue.links)) {
      for (const link of issue.links) {
        if (link.issue?.identifier) {
          existingLinkedKeys.add(link.issue.identifier.toUpperCase());
        }
      }
    }

    const selfKey = issue.identifier.toUpperCase();
    const newlyLinked: string[] = [];

    // Bài học tech lead (audit 25/09 — 158/158 lượt link_remove là người gỡ):
    // nếu người đã gỡ một liên kết native khỏi ticket này, syncRelatedTickets
    // KHÔNG được tự động liên kết lại từ trường text — nếu không, hành động
    // sửa tay của con người sẽ bị bot đạp đổ ở lần sync sau (vòng phản hồi).
    // Đọc timeline một lần: kiểm tra sự kiện link_remove do người thực hiện.
    const removedByHumanKeys = new Set<string>();
    try {
      const timeline = await client.getIssueTimeline(issueId).catch(() => []);
      for (const ev of timeline) {
        if (ev?.action === "link_remove") {
          if (!isSystemActor(ev.actorName || ev.actor)) {
            const target = ev.payload?.to?.value;
            if (typeof target === "string" && target.trim()) {
              removedByHumanKeys.add(target.trim().toUpperCase());
            }
          }
        }
      }
    } catch {
      // Timeline lỗi không chặn luồng liên kết
    }

    for (const key of candidateKeys) {
      if (key === selfKey) continue;
      if (existingLinkedKeys.has(key)) continue;
      if (removedByHumanKeys.has(key)) {
        getLogger().info(
          `[RelatedTicketsSync] Bỏ qua ${key} cho #${issue.id}: người đã từng gỡ liên kết này khỏi ticket.`,
        );
        continue;
      }

      try {
        const targetIssue = await findIssueByIdentifier(client, key);
        if (targetIssue && targetIssue.id !== issue.id) {
          await client.addLink(issue.id, targetIssue.id, "relates");
          existingLinkedKeys.add(key);
          newlyLinked.push(key);
          getLogger().info(
            `[RelatedTicketsSync] Đã tự động liên kết ${key} với #${issue.id} (${issue.identifier}) qua Links (relates)`,
          );
        }
      } catch (err: any) {
        getLogger().warn(
          `[RelatedTicketsSync] Lỗi khi liên kết ticket ${key} với #${issue.id}: ${err.message}`,
        );
      }
    }

    return newlyLinked;
  } catch (err: any) {
    getLogger().error(
      `[RelatedTicketsSync] Lỗi khi đồng bộ Related Tickets cho #${issueId}: ${err.message}`,
    );
    return [];
  }
}
