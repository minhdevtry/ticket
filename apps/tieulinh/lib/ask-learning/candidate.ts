/**
 * Lọc bình luận ứng viên để gửi LLM phân loại: bình luận của kỹ thuật viên (danh sách
 * tài khoản trong tech_accounts.json) có nhắc Tiểu Linh, hoặc @ một tài khoản người
 * báo (@SA_/@CS_/@SC_/@TE_). Lọc rộng là được: LLM quyết định phần còn lại.
 */
import TECH_ACCOUNTS from "../../mcp/tieulinh/domain/tech_accounts.json";
import { decodeHtmlEntities } from "../html-entities";

export const DEFAULT_TECH_ACCOUNTS: ReadonlySet<string> = new Set<string>(TECH_ACCOUNTS);

const TIEULINH_RE = /ti[eể]u\s*linh|tieulinh|@\s*intake|bot-ticket-intake|vuihoc_ti_u_linh/i;
const REPORTER_MENTION_RE = /@\s*(?:SA|CS|SC|TE)_/;

export function stripHtml(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function isCandidateComment(
  body: string | null | undefined,
  actorName: string | null | undefined,
  techAccounts: ReadonlySet<string> = DEFAULT_TECH_ACCOUNTS,
): boolean {
  if (!actorName || !techAccounts.has(actorName)) return false;
  const raw = body ?? "";
  const stripped = stripHtml(raw);
  const tagless = decodeHtmlEntities(raw.replace(/<[^>]+>/g, "")).trim();
  return (
    TIEULINH_RE.test(raw) ||
    REPORTER_MENTION_RE.test(raw) ||
    TIEULINH_RE.test(stripped) ||
    REPORTER_MENTION_RE.test(stripped) ||
    TIEULINH_RE.test(tagless) ||
    REPORTER_MENTION_RE.test(tagless)
  );
}
